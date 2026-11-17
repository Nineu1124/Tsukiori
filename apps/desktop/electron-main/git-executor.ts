import { spawn } from 'node:child_process';

export type GitRunOptions = { signal?: AbortSignal; timeoutMs?: number; maxOutputBytes?: number };
export type GitErrorCode = 'failed' | 'timeout' | 'output_limit' | 'cancelled' | 'unavailable';

export class GitCommandError extends Error {
  constructor(readonly code: GitErrorCode) {
    super({ failed: 'Git 操作失败，请检查仓库状态。', timeout: 'Git 操作超时。',
      output_limit: 'Git 输出超过容量限制，请缩小操作范围。', cancelled: 'Git 操作已取消。',
      unavailable: '无法启动 Git，请检查安装和工作目录。' }[code]);
    this.name = 'GitCommandError';
  }
}

/** No shell, bounded output and lifetime; error text never includes raw stderr. */
export class GitExecutor {
  readonly #executable: string;
  readonly #prefixArgs: readonly string[];
  readonly #cancellations = new Set<() => void>();
  readonly #pending = new Set<Promise<string>>();
  #closing = false;

  constructor(options: { executable?: string; prefixArgs?: readonly string[] } = {}) {
    this.#executable = options.executable ?? 'git.exe';
    this.#prefixArgs = options.prefixArgs ?? [];
  }

  run(cwd: string, args: readonly string[], options: GitRunOptions = {}): Promise<string> {
    if (this.#closing || options.signal?.aborted) return Promise.reject(new GitCommandError('cancelled'));
    const timeout = options.timeoutMs ?? 30_000;
    const maxBytes = options.maxOutputBytes ?? 4 * 1024 * 1024;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30_000
      || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 4 * 1024 * 1024) {
      return Promise.reject(new GitCommandError('unavailable'));
    }
    const promise = new Promise<string>((resolve, reject) => {
      const child = (() => {
        try {
          return spawn(this.#executable, [...this.#prefixArgs, '-c', 'core.fsmonitor=false', '-C', cwd, ...args], {
            cwd, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
          });
        } catch { throw new GitCommandError('unavailable'); }
      })();
      const chunks: Buffer[] = [];
      let bytes = 0;
      let failure: GitErrorCode | undefined;
      let finished = false;
      const stop = (code: GitErrorCode): void => {
        failure ??= code;
        if (child.exitCode === null) child.kill();
      };
      const cancel = (): void => stop('cancelled');
      const timer = setTimeout(() => stop('timeout'), timeout);
      this.#cancellations.add(cancel);
      options.signal?.addEventListener('abort', cancel, { once: true });
      if (options.signal?.aborted) cancel();
      const receive = (chunk: Buffer, stdout: boolean): void => {
        if (failure) return;
        bytes += chunk.length;
        if (bytes > maxBytes) { stop('output_limit'); return; }
        if (stdout) chunks.push(chunk);
      };
      child.stdout.on('data', (chunk: Buffer) => receive(chunk, true));
      child.stderr.on('data', (chunk: Buffer) => receive(chunk, false));
      const complete = (code: number | null): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.#cancellations.delete(cancel);
        options.signal?.removeEventListener('abort', cancel);
        if (failure || code !== 0) reject(new GitCommandError(failure ?? 'failed'));
        else resolve(Buffer.concat(chunks).toString('utf8'));
      };
      child.once('error', () => { failure ??= 'unavailable'; });
      child.once('close', complete);
    });
    this.#pending.add(promise);
    void promise.then(() => this.#pending.delete(promise), () => this.#pending.delete(promise));
    return promise;
  }

  async shutdown(): Promise<void> {
    this.#closing = true;
    for (const cancel of this.#cancellations) cancel();
    await Promise.allSettled(this.#pending);
  }
}
