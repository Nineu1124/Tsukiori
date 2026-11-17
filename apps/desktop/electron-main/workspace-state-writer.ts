import { WorkspaceStorageError } from './workspace-sqlite.js';

/** Coalesce derived metadata only. Explicit commands still commit synchronously. */
export class WorkspaceStateWriter<T> {
  #timer: NodeJS.Timeout | undefined;
  #dirty = false;
  #failed = false;
  #closed = false;
  #draining = false;

  constructor(readonly options: {
    snapshot: () => T;
    write: (state: T) => void;
    onFailure?: () => void;
    onSaved?: () => void;
    delayMs?: number;
  }) {
    const delay = options.delayMs ?? 25;
    if (!Number.isSafeInteger(delay) || delay < 1 || delay > 1000) throw new WorkspaceStorageError('invalid_data');
  }

  get pending(): boolean { return this.#dirty; }
  get failed(): boolean { return this.#failed; }

  schedule(): void {
    if (this.#closed) throw new WorkspaceStorageError('unavailable');
    this.#dirty = true;
    // A fixed first-event deadline prevents starvation under a continuous stream.
    if (this.#timer || this.#failed || this.#draining) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      try { this.flush(); } catch { /* Failure is retained and projected once. */ }
    }, this.options.delayMs ?? 25);
  }

  write(state: T): void {
    if (this.#closed) throw new WorkspaceStorageError('unavailable');
    const wasDirty = this.#dirty;
    this.#cancelTimer();
    try {
      this.options.write(state);
    } catch (error) {
      this.#dirty = wasDirty;
      const notify = !this.#failed;
      this.#failed = true;
      if (notify) { try { this.options.onFailure?.(); } catch { /* Keep the original failure. */ } }
      throw error;
    }
    this.#dirty = false;
    this.#failed = false;
    try { this.options.onSaved?.(); } catch { /* A projection cannot undo a committed write. */ }
  }

  flush(): void {
    if (!this.#dirty) return;
    try { this.write(this.options.snapshot()); }
    catch (error) {
      if (!this.#failed) {
        this.#failed = true;
        try { this.options.onFailure?.(); } catch { /* Keep the snapshot failure. */ }
      }
      throw error;
    }
  }

  /** Retain updates during Runtime cleanup for the final synchronous flush. */
  beginShutdown(): void {
    this.#draining = true;
    this.#cancelTimer();
  }

  close(): void {
    if (this.#closed) return;
    this.#cancelTimer();
    try { this.flush(); } finally { this.#closed = true; }
  }

  #cancelTimer(): void {
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = undefined; }
  }
}
