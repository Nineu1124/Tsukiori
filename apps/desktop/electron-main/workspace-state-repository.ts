import { join } from 'node:path';
import { loadWorkspaceStateFile, saveWorkspaceStateFile, type WorkspaceStateDocument, type WorkspaceStateRecovery } from './workspace-state-file.js';
import type { PersistedState } from './workspace-types.js';

export type WorkspaceStateRead = { value?: WorkspaceStateDocument; recovery?: WorkspaceStateRecovery };
export interface WorkspaceStateRepository {
  read(): WorkspaceStateRead;
  save(state: PersistedState): void;
  close?(): void;
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
