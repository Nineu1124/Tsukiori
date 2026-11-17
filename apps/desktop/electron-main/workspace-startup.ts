import { WorkspaceStateError } from './workspace-state-file.js';
import { WorkspaceMigrationError } from './workspace-state-migration.js';
import { ConversationMigrationError } from './workspace-conversation-migration.js';
import { WorkspaceStorageError } from './workspace-sqlite.js';
import { WorkspaceOwnershipError } from './workspace-instance-lock.js';

export type WorkspaceStartupFailure = {
  stage: 'legacy_state' | 'state_migration' | 'conversation_migration' | 'storage' | 'ownership' | 'initialization';
  code: string;
  message: string;
  dataRetained: true;
  openDataFailed?: true;
};

/** Startup diagnostics never expose exception bodies, SQL or conversation data. */
export function workspaceStartupFailure(error: unknown): WorkspaceStartupFailure {
  const stage = error instanceof WorkspaceStateError ? 'legacy_state'
    : error instanceof WorkspaceMigrationError ? 'state_migration'
    : error instanceof ConversationMigrationError ? 'conversation_migration'
    : error instanceof WorkspaceStorageError ? 'storage'
    : error instanceof WorkspaceOwnershipError ? 'ownership' : 'initialization';
  const code = error instanceof WorkspaceStateError || error instanceof WorkspaceMigrationError
    || error instanceof ConversationMigrationError || error instanceof WorkspaceStorageError || error instanceof WorkspaceOwnershipError
    ? error.reason : 'initialization_failed';
  const message = stage === 'ownership' ? (code === 'in_use'
    ? '工作区正在被另一个实例使用，请先退出该实例，再重试。'
    : '无法取得工作区写入权，请保留完整数据目录并检查权限及所有权文件。')
    : code === 'unsupported_version' ? '工作区数据版本不兼容，请使用对应版本打开。'
    : code === 'backup_failed' ? '迁移备份未能完成，请检查磁盘空间和目录权限。'
    : code === 'source_invalid' || code === 'invalid' || code === 'invalid_schema' || code === 'invalid_data'
      ? '工作区数据或会话记录不完整，请先备份，再恢复有效数据。'
      : '工作区未能初始化，请保留数据并检查磁盘、权限和迁移记录。';
  return { stage, code, message, dataRetained: true };
}

export async function openWorkspaceWithRecovery<T>(options: {
  create: () => T;
  showRecovery: (failure: WorkspaceStartupFailure) => Promise<'retry' | 'open_data' | 'exit'>;
  openData: () => Promise<void>;
}): Promise<T | null> {
  for (;;) {
    try { return options.create(); }
    catch (error) {
      let failure = workspaceStartupFailure(error);
      for (;;) {
        const action = await options.showRecovery(failure);
        if (action === 'exit') return null;
        if (action === 'retry') break;
        try { await options.openData(); }
        catch { failure = { ...failure, openDataFailed: true }; }
      }
    }
  }
}
