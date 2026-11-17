import { existsSync, lstatSync, mkdirSync, openSync, readSync, closeSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const WORKSPACE_OWNER_FILE = 'workspace-owner.sqlite';

export class WorkspaceOwnershipError extends Error {
  constructor(readonly reason: 'in_use' | 'invalid_lock' | 'unavailable') {
    super({ in_use: '工作区正在被另一个实例使用，请先退出该实例后重试。',
      invalid_lock: '工作区所有权文件不兼容或损坏，请先备份完整目录。',
      unavailable: '无法取得工作区写入权，请检查数据目录权限。' }[reason]);
    this.name = 'WorkspaceOwnershipError';
  }
}

/** Dedicated SQLite transaction holds OS file locks for the writer lifetime.
 * No PID, timestamp, lease expiry or unlink-based takeover is used. */
export class WorkspaceInstanceLock {
  readonly #database: DatabaseSync;
  #closed = false;

  constructor(userDataPath: string) {
    let database: DatabaseSync | undefined;
    try {
      mkdirSync(userDataPath, { recursive: true });
      const root = realpathSync.native(userDataPath);
      const path = join(root, WORKSPACE_OWNER_FILE);
      if (existsSync(path)) {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new WorkspaceOwnershipError('invalid_lock');
        if (stat.size > 0) {
          const descriptor = openSync(path, 'r');
          const magic = Buffer.alloc(16);
          try { readSync(descriptor, magic); } finally { closeSync(descriptor); }
          if (magic.toString('utf8') !== 'SQLite format 3\0') throw new WorkspaceOwnershipError('invalid_lock');
        }
      }
      database = new DatabaseSync(path);
      database.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE');
      // This file is a mutex only. Never adopt an arbitrary application DB or
      // write business records into the long-lived ownership transaction.
      if (Number(database.prepare('PRAGMA application_id').get()?.application_id) !== 0
        || Number(database.prepare('PRAGMA user_version').get()?.user_version) !== 0
        || database.prepare('SELECT name FROM sqlite_master').all().length) {
        throw new WorkspaceOwnershipError('invalid_lock');
      }
      this.#database = database;
    } catch (error) {
      try { database?.close(); } catch { /* Do not expose or replace the acquisition failure. */ }
      if (error instanceof WorkspaceOwnershipError) throw error;
      const code = Number((error as { errcode?: unknown } | null)?.errcode);
      throw new WorkspaceOwnershipError(code === 5 || code === 6 ? 'in_use' : 'unavailable');
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try { this.#database.exec('ROLLBACK'); } finally { this.#database.close(); }
  }
}
