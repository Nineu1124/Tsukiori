import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { loadWorkspaceStateFile, saveWorkspaceStateFile, type WorkspaceStateDocument, type WorkspaceStateRecovery } from './workspace-state-file.js';
import type { PersistedState } from './workspace-types.js';
import { WorkspaceSqliteStore } from './workspace-sqlite.js';
import { applyWorkspaceMigration, planWorkspaceMigration } from './workspace-state-migration.js';

export const WORKSPACE_DATABASE_NAME = 'workspace.sqlite';

export type WorkspaceStateRead = { value?: WorkspaceStateDocument; recovery?: WorkspaceStateRecovery };
export interface WorkspaceStateRepository {
  read(): WorkspaceStateRead;
  save(state: PersistedState): void;
  close?(): void;
}

/** 正式入口只写 SQLite；旧文件经备份导入后保留，不再作为活动数据源。 */
export class SqliteWorkspaceRepository implements WorkspaceStateRepository {
  readonly store: WorkspaceSqliteStore;
  readonly path: string;
  #recovery: WorkspaceStateRecovery | undefined;

  constructor(readonly userDataPath: string) {
    this.path = join(userDataPath, WORKSPACE_DATABASE_NAME);
    // Read/validate legacy input before creating a new database. Invalid input
    // cannot become a newly initialized empty workspace.
    const plan = existsSync(this.path) ? undefined : planWorkspaceMigration(userDataPath);
    this.store = new WorkspaceSqliteStore(this.path);
    try {
      if (!this.store.readState()) {
        const migration = plan ?? planWorkspaceMigration(userDataPath);
        applyWorkspaceMigration(migration, this.store);
        if (migration.recoveredFromBackup && migration.selectedSource) {
          this.#recovery = { backupFile: migration.selectedSource };
        }
      }
    } catch (error) { this.store.close(); throw error; }
  }

  read(): WorkspaceStateRead {
    const value = this.store.readState();
    return { ...(value ? { value } : {}), ...(this.#recovery ? { recovery: this.#recovery } : {}) };
  }

  save(state: PersistedState): void { this.store.saveState(state); }
  close(): void { this.store.close(); }
}

/** 旧文件适配器保留版本选择和原子备份行为，业务只依赖读写合同。 */
export class JsonWorkspaceRepository implements WorkspaceStateRepository {
  readonly path: string;
  constructor(readonly userDataPath: string) {
    this.path = join(userDataPath, 'workspace-state-v3.json');
  }
  read(): WorkspaceStateRead {
    for (const version of [3, 2, 1]) {
      const result = loadWorkspaceStateFile(join(this.userDataPath, `workspace-state-v${version}.json`));
      if (result.value) return result;
    }
    return {};
  }
  save(state: PersistedState): void {
    saveWorkspaceStateFile(this.path, JSON.stringify(state, null, 2));
  }
}
