import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { WorkspaceSqliteStore } from '../../apps/desktop/dist/electron-main/workspace-sqlite.js';

export function readStateJSON(userDataPath) {
  const store = new WorkspaceSqliteStore(join(userDataPath, 'workspace.sqlite'));
  try { return JSON.stringify(store.readState()); } finally { store.close(); }
}

export function readStorageBytes(userDataPath) {
  return ['workspace.sqlite', 'workspace.sqlite-wal', 'workspace.sqlite-shm']
    .filter((name) => existsSync(join(userDataPath, name)))
    .map((name) => readFileSync(join(userDataPath, name)).toString('utf8')).join('');
}
