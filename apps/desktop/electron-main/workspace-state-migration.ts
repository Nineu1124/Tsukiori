import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseWorkspaceState, WorkspaceStateError, type WorkspaceStateDocument } from './workspace-state-file.js';
import { normalizeWorkspaceState } from './workspace-state-normalize.js';
import type { PersistedState } from './workspace-types.js';
import type { WorkspaceMigrationRun, WorkspaceSqliteStore } from './workspace-sqlite.js';

const sourceNames = [3, 2, 1].flatMap((version) => [`workspace-state-v${version}.json`, `workspace-state-v${version}.json.bak`]);
const retainedNames = [
  'transcripts', 'checkpoints', 'imports', 'mcp-servers-v1.json', 'mcp-ownership',
  'scheduled-tasks-v1.json', 'integration-state-v1.json', 'subagent-projections-v1.json',
  'provider-verification-audit-v1.json', 'skills', 'worktrees',
];
export const WORKSPACE_MIGRATION_BACKUPS = 'workspace-migration-backups';

export type WorkspaceMigrationSource = { name: string; bytes: number; sha256: string };
export type WorkspaceMigrationPlan = {
  version: 1;
  userDataPath: string;
  sourceHash: string;
  stateHash: string;
  state: PersistedState;
  selectedSource?: string;
  recoveredFromBackup: boolean;
  sourceFiles: WorkspaceMigrationSource[];
  counts: { projects: number; sessions: number; teams: number; providers: number };
  inventory: Array<{ name: string; present: boolean; disposition: 'retained_in_place' }>;
};
type Store = Pick<WorkspaceSqliteStore, 'transaction' | 'readState' | 'saveState' | 'readMigrationRun' | 'listMigrationRuns' | 'writeMigrationRun'>;
export type WorkspaceMigrationFault = 'after_backup' | 'after_state' | 'before_commit';
export type WorkspaceMigrationResult = { status: 'applied' | 'already_applied'; run: WorkspaceMigrationRun };

export class WorkspaceMigrationError extends Error {
  constructor(readonly reason: 'invalid_plan' | 'source_changed' | 'source_invalid' | 'source_unavailable' | 'unsupported_version'
    | 'target_not_empty' | 'backup_failed' | 'import_failed') {
    const detail = {
      invalid_plan: '迁移计划无效或已被修改，请重新生成',
      source_changed: '源文件在计划生成后发生变化，请停止写入后重新检查',
      source_invalid: '源文件损坏，且没有可用的同版本备份',
      source_unavailable: '源文件无法读取，请检查权限和文件类型',
      unsupported_version: '源文件版本不兼容，请使用对应版本打开',
      target_not_empty: '目标存储已有数据或其他来源的迁移记录，不能覆盖',
      backup_failed: '备份无法完成或校验失败，尚未导入数据',
      import_failed: '事务导入失败，原文件和已有备份已保留',
    }[reason];
    super(`工作区迁移失败：${detail}。`);
    this.name = 'WorkspaceMigrationError';
  }
}

// Dry run: reads fixed legacy JSON names and inventories adjacent stores. It
// neither opens SQLite nor repairs a corrupt main file from its backup.
export function planWorkspaceMigration(userDataPath: string): WorkspaceMigrationPlan {
  const directory = resolve(userDataPath);
  const sources = snapshotSources(directory);
  let document: WorkspaceStateDocument | undefined;
  let selectedSource: string | undefined;
  for (const version of [3, 2, 1]) {
    const main = `workspace-state-v${version}.json`;
    const backup = `${main}.bak`;
    const primary = sources.find((source) => source.name === main);
    let invalid = false;
    if (primary) {
      try { document = parseWorkspaceState(primary.content.toString('utf8'), main); selectedSource = main; }
      catch (error) {
        if (!(error instanceof WorkspaceStateError) || error.reason !== 'invalid') throw sourceError(error);
        invalid = true;
      }
      if (document) break;
    }
    const fallback = sources.find((source) => source.name === backup);
    if (fallback) {
      try { document = parseWorkspaceState(fallback.content.toString('utf8'), backup); selectedSource = backup; }
      catch (error) { throw sourceError(error); }
      break;
    }
    if (invalid) throw new WorkspaceMigrationError('source_invalid');
  }
  let state: PersistedState;
  try { state = normalizeWorkspaceState(document); }
  catch { throw new WorkspaceMigrationError('source_invalid'); }
  const sourceFiles = sources.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 }));
  return {
    version: 1, userDataPath: directory, sourceHash: manifestHash(sourceFiles), stateHash: jsonHash(state), state,
    ...(selectedSource ? { selectedSource } : {}), recoveredFromBackup: Boolean(selectedSource?.endsWith('.bak')),
    sourceFiles,
    counts: { projects: state.projects.length, sessions: state.sessions.length, teams: state.teams.length, providers: state.providers.length },
    inventory: retainedNames.map((name) => ({ name, present: present(join(directory, name)), disposition: 'retained_in_place' })),
  };
}

export function applyWorkspaceMigration(
  plan: WorkspaceMigrationPlan,
  store: Store,
  options: { now?: () => number; fault?: (point: WorkspaceMigrationFault) => void } = {},
): WorkspaceMigrationResult {
  assertPlan(plan);
  assertUnchanged(plan);
  const previous = matchingRun(plan, store);
  if (previous) return { status: 'already_applied', run: previous };
  const backupName = createBackup(plan);
  try {
    options.fault?.('after_backup');
    return store.transaction(() => {
      // Recheck the target under SQLite's write transaction. Another caller may
      // have populated it while files were being copied into the backup.
      const existing = matchingRun(plan, store);
      if (existing) return { status: 'already_applied', run: existing };
      assertUnchanged(plan);
      store.saveState(plan.state);
      options.fault?.('after_state');
      const run: WorkspaceMigrationRun = {
        sourceHash: plan.sourceHash, importedAt: (options.now ?? Date.now)(),
        counts: { projects: plan.counts.projects, sessions: plan.counts.sessions, events: 0 },
        phase: 'state', backupName,
      };
      store.writeMigrationRun(run);
      options.fault?.('before_commit');
      assertUnchanged(plan);
      return { status: 'applied', run };
    });
  } catch (error) {
    if (error instanceof WorkspaceMigrationError) throw error;
    throw new WorkspaceMigrationError('import_failed');
  }
}

function matchingRun(plan: WorkspaceMigrationPlan, store: Store): WorkspaceMigrationRun | undefined {
  const runs = store.listMigrationRuns();
  const state = store.readState();
  const previous = store.readMigrationRun(plan.sourceHash);
  if (previous?.phase === 'state' && state && runs.filter((run) => run.phase === 'state').every((run) => run.sourceHash === plan.sourceHash)) return previous;
  if (state || runs.length) throw new WorkspaceMigrationError('target_not_empty');
  return undefined;
}

function assertPlan(plan: WorkspaceMigrationPlan): void {
  try {
    if (!plan || plan.version !== 1 || typeof plan.userDataPath !== 'string' || plan.userDataPath !== resolve(plan.userDataPath)
      || !Array.isArray(plan.sourceFiles) || manifestHash(plan.sourceFiles) !== plan.sourceHash || jsonHash(plan.state) !== plan.stateHash
      || plan.counts.projects !== plan.state.projects.length || plan.counts.sessions !== plan.state.sessions.length
      || plan.counts.teams !== plan.state.teams.length || plan.counts.providers !== plan.state.providers.length) throw new Error();
    parseWorkspaceState(JSON.stringify(plan.state), 'workspace-migration-plan');
    const names = new Set<string>();
    for (const source of plan.sourceFiles) {
      if (!sourceNames.includes(source.name) || names.has(source.name) || !/^[a-f0-9]{64}$/.test(source.sha256)
        || !Number.isSafeInteger(source.bytes) || source.bytes < 0) throw new Error();
      names.add(source.name);
    }
  } catch { throw new WorkspaceMigrationError('invalid_plan'); }
}

function assertUnchanged(plan: WorkspaceMigrationPlan): void {
  const files = snapshotSources(plan.userDataPath).map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 }));
  if (manifestHash(files) !== plan.sourceHash) throw new WorkspaceMigrationError('source_changed');
}

function createBackup(plan: WorkspaceMigrationPlan): string {
  const name = `${plan.sourceHash}-${randomUUID()}`;
  const parent = join(plan.userDataPath, WORKSPACE_MIGRATION_BACKUPS);
  const destination = join(parent, name);
  try {
    if (present(parent) && lstatSync(parent).isSymbolicLink()) throw new Error();
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    if (realpathSync.native(parent) !== join(realpathSync.native(plan.userDataPath), WORKSPACE_MIGRATION_BACKUPS)) throw new Error();
    mkdirSync(destination, { mode: 0o700 });
    for (const source of plan.sourceFiles) {
      const content = readSource(join(plan.userDataPath, source.name));
      if (!content || content.length !== source.bytes || hash(content) !== source.sha256) throw new WorkspaceMigrationError('source_changed');
      const target = join(destination, source.name);
      writeFileSync(target, content, { flag: 'wx', mode: 0o600, flush: true });
      const copied = readFileSync(target);
      if (copied.length !== source.bytes || hash(copied) !== source.sha256) throw new Error();
    }
    writeFileSync(join(destination, 'manifest.json'), JSON.stringify({
      version: 1, sourceHash: plan.sourceHash, stateHash: plan.stateHash, selectedSource: plan.selectedSource,
      sourceFiles: plan.sourceFiles, counts: plan.counts,
    }, null, 2), { flag: 'wx', mode: 0o600, flush: true });
    assertUnchanged(plan);
    return name;
  } catch (error) {
    if (error instanceof WorkspaceMigrationError) throw error;
    throw new WorkspaceMigrationError('backup_failed');
  }
}

function snapshotSources(directory: string): Array<WorkspaceMigrationSource & { content: Buffer }> {
  const files: Array<WorkspaceMigrationSource & { content: Buffer }> = [];
  for (const name of sourceNames) {
    const content = readSource(join(directory, name));
    if (content) files.push({ name, bytes: content.length, sha256: hash(content), content });
  }
  return files;
}

function readSource(path: string): Buffer | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new WorkspaceMigrationError('source_unavailable');
    return readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new WorkspaceMigrationError('source_unavailable');
  }
}

function present(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new WorkspaceMigrationError('source_unavailable');
  }
}

function sourceError(error: unknown): WorkspaceMigrationError {
  return new WorkspaceMigrationError(error instanceof WorkspaceStateError && error.reason === 'unsupported_version'
    ? 'unsupported_version' : 'source_invalid');
}
function hash(content: Buffer | string): string { return createHash('sha256').update(content).digest('hex'); }
function jsonHash(value: unknown): string { return hash(JSON.stringify(value)); }
function manifestHash(files: WorkspaceMigrationSource[]): string { return jsonHash(files); }
