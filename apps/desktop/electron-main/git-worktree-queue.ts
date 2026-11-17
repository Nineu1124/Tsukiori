import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { GitCommandError, type GitOperationOutcome } from './git-executor.js';

export type GitOperationSnapshot = {
  operationId: string;
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  outcome: GitOperationOutcome;
};

/** FIFO per canonical Worktree. Other Worktrees can make progress independently. */
export class GitWorktreeQueue {
  readonly #tails = new Map<string, Promise<void>>();
  readonly #counts = new Map<string, number>();
  readonly #cancel = new Set<() => void>();
  readonly #owner = new AsyncLocalStorage<string>();
  readonly #active = new Map<string, string>();
  #closing = false;

  assertIdle(path: string): void {
    const key = worktreeKey(path);
    const owner = this.#owner.getStore();
    if (this.#counts.has(key) && (!owner || owner !== this.#active.get(key))) throw new GitCommandError('busy', { outcome: 'not_started' });
  }

  run<T>(path: string, execute: (signal: AbortSignal) => T | Promise<T>, options: {
    signal?: AbortSignal;
    mutating?: boolean;
    preserveErrors?: boolean;
    onState?: (snapshot: GitOperationSnapshot) => void;
  } = {}): Promise<T> {
    let key: string;
    try { key = worktreeKey(path); } catch { return Promise.reject(new GitCommandError('unavailable', { outcome: 'not_started' })); }
    if (this.#closing || options.signal?.aborted) return Promise.reject(new GitCommandError('cancelled', { outcome: 'not_started' }));
    if ((this.#counts.get(key) ?? 0) >= 64) return Promise.reject(new GitCommandError('queue_full', { outcome: 'not_started' }));
    this.#counts.set(key, (this.#counts.get(key) ?? 0) + 1);
    const snapshot: GitOperationSnapshot = { operationId: 'git:' + randomUUID(), state: 'queued', outcome: 'not_started' };
    const controller = new AbortController();
    let settled = false;
    let delivered = false;
    let valueResult: T;
    let errorResult: unknown;
    let rejected = false;
    let resolveResult!: (value: T) => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<T>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    const notify = (): void => {
      try { options.onState?.({ ...snapshot }); } catch { /* Projection failure cannot replay or change the Git result. */ }
    };
    const cancel = (): void => {
      controller.abort();
      if (!settled && snapshot.state === 'queued') {
        snapshot.state = 'cancelled';
        settled = true;
        delivered = true;
        notify();
        rejectResult(new GitCommandError('cancelled', snapshot));
      }
    };
    this.#cancel.add(cancel);
    options.signal?.addEventListener('abort', cancel, { once: true });
    notify();
    const previous = this.#tails.get(key) ?? Promise.resolve();
    const scheduled = previous.then(async () => {
      if (settled) return;
      if (controller.signal.aborted || this.#closing) { cancel(); return; }
      snapshot.state = 'running';
      this.#active.set(key, snapshot.operationId);
      snapshot.outcome = options.mutating === false ? 'known' : 'unknown';
      notify();
      try {
        const value = await this.#owner.run(snapshot.operationId, () => execute(controller.signal));
        if (controller.signal.aborted) throw new GitCommandError('cancelled');
        snapshot.state = 'succeeded'; snapshot.outcome = 'known'; settled = true;
        valueResult = value;
      } catch (error) {
        snapshot.state = controller.signal.aborted ? 'cancelled' : 'failed'; settled = true;
        rejected = true;
        errorResult = options.preserveErrors && !controller.signal.aborted ? error
          : new GitCommandError(controller.signal.aborted ? 'cancelled' : error instanceof GitCommandError ? error.code : 'failed', snapshot);
      }
    }).finally(() => {
      this.#cancel.delete(cancel);
      if (this.#active.get(key) === snapshot.operationId) this.#active.delete(key);
      options.signal?.removeEventListener('abort', cancel);
      const remaining = (this.#counts.get(key) ?? 1) - 1;
      if (remaining) this.#counts.set(key, remaining); else this.#counts.delete(key);
      if (this.#tails.get(key) === scheduled) this.#tails.delete(key);
      if (!delivered) {
        delivered = true; notify();
        if (rejected) rejectResult(errorResult); else resolveResult(valueResult);
      }
    });
    this.#tails.set(key, scheduled);
    return result;
  }

  async shutdown(): Promise<void> {
    this.#closing = true;
    for (const cancel of this.#cancel) cancel();
    await Promise.allSettled(this.#tails.values());
  }
}

function worktreeKey(path: string): string {
  const canonical = realpathSync.native(path);
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}
