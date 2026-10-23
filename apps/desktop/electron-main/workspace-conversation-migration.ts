import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, copyFileSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, writeFileSync, type Stats } from 'node:fs';
import { join, resolve } from 'node:path';
import { readTranscriptLines, TRANSCRIPT_RECORD_BYTES } from './transcript-store.js';
import { parseWorkspaceState, type WorkspaceStateDocument } from './workspace-state-file.js';
import { WORKSPACE_MIGRATION_BACKUPS } from './workspace-state-migration.js';
import type { WorkspaceMigrationRun, WorkspaceSqliteStore } from './workspace-sqlite.js';

export type ConversationMigrationSource = { name: string; bytes: number; sha256: string };
export type ConversationMigrationSession = { sessionId: string; projectId: string; requiresHistory: boolean; events: string[]; eventHash: string };
export type ConversationMigrationPlan = {
  version: 1;
  userDataPath: string;
  sourceHash: string;
  sourceFiles: ConversationMigrationSource[];
  sessions: ConversationMigrationSession[];
  counts: { projects: number; sessions: number; events: number };
};
export type ConversationMigrationFault = 'after_backup' | 'after_session' | 'before_commit';
export type ConversationMigrationResult = { status: 'applied' | 'already_applied'; run: WorkspaceMigrationRun };
type Store = Pick<WorkspaceSqliteStore, 'transaction' | 'readState' | 'readEvents' | 'replaceEvents'
  | 'readMigrationRun' | 'listMigrationRuns' | 'writeMigrationRun'>;
type SessionIdentity = { sessionId: string; projectId: string; requiresHistory: boolean };

export class ConversationMigrationError extends Error {
  constructor(readonly reason: 'invalid_plan' | 'source_invalid' | 'source_unavailable' | 'unsupported_version'
    | 'source_changed' | 'target_not_empty' | 'target_mismatch' | 'backup_failed' | 'import_failed') {
    const detail = {
      invalid_plan: '迁移计划无效或已被修改，请重新生成',
      source_invalid: '会话记录、分段索引或关联不完整',
      source_unavailable: '会话记录无法读取，请检查权限和文件类型',
      unsupported_version: '会话记录版本不兼容，请使用对应版本打开',
      source_changed: '会话记录在计划生成后发生变化，请停止写入后重新检查',
      target_not_empty: '目标已有会话记录或其他来源的导入，不能覆盖',
      target_mismatch: '目标项目和会话与迁移计划不一致，请先完成状态迁移',
      backup_failed: '会话备份无法完成或校验失败，尚未导入数据',
      import_failed: '会话事务导入失败，原记录和备份已保留',
    }[reason];
    super(`会话迁移失败：${detail}。`);
    this.name = 'ConversationMigrationError';
  }
}

/** Read only: the existing Transcript Store decides which indexed segments are active. */
export function planConversationMigration(userDataPath: string, state: WorkspaceStateDocument): ConversationMigrationPlan {
  let document: WorkspaceStateDocument;
  try { document = parseWorkspaceState(JSON.stringify(state), 'conversation-migration'); }
  catch { throw new ConversationMigrationError('source_invalid'); }
  // A missing file is legitimate for a new session or when saving was disabled.
  // Existing incomplete-history flags require explicit recovery, even if saving
  // is currently disabled; migration cannot silently turn them into success.
  if (document.sessions.some((session) => session.transcriptIncomplete === true)) throw new ConversationMigrationError('source_invalid');
  const identities = document.sessions.map((session) => ({
    sessionId: String(session.id), projectId: String(session.projectId),
    requiresHistory: document.settings?.persistConversation !== false
      && typeof session.turnCount === 'number' && session.turnCount > 0,
  }));
  return snapshot(resolve(userDataPath), identities, document.projects.length);
}

export function applyConversationMigration(
  plan: ConversationMigrationPlan,
  store: Store,
  options: { now?: () => number; fault?: (point: ConversationMigrationFault, sessionId?: string) => void } = {},
): ConversationMigrationResult {
  assertPlan(plan);
  assertUnchanged(plan);
  const previous = matchingRun(plan, store);
  if (previous) return { status: 'already_applied', run: previous };
  const backupName = backup(plan);
  try {
    options.fault?.('after_backup');
    return store.transaction(() => {
      const existing = matchingRun(plan, store);
      if (existing) return { status: 'already_applied', run: existing };
      assertUnchanged(plan);
      for (const session of plan.sessions) {
        store.replaceEvents(session.sessionId, session.events);
        options.fault?.('after_session', session.sessionId);
      }
      const run: WorkspaceMigrationRun = {
        sourceHash: plan.sourceHash, importedAt: (options.now ?? Date.now)(),
        counts: { ...plan.counts }, phase: 'events', backupName,
      };
      store.writeMigrationRun(run);
      options.fault?.('before_commit');
      assertUnchanged(plan);
      return { status: 'applied', run };
    });
  } catch (error) {
    if (error instanceof ConversationMigrationError) throw error;
    throw new ConversationMigrationError('import_failed');
  }
}

function snapshot(directory: string, identities: SessionIdentity[], projectCount: number): ConversationMigrationPlan {
  const sourceFiles: ConversationMigrationSource[] = [];
  const sessions: ConversationMigrationSession[] = [];
  const transcriptRoot = join(directory, 'transcripts');
  assertDirectory(directory, transcriptRoot);
  for (const identity of [...identities].sort((a, b) => a.sessionId.localeCompare(b.sessionId))) {
    const base = `${hash(identity.sessionId)}.jsonl`;
    const before = activeFiles(directory, base);
    if (identity.requiresHistory && before.length === 0) throw new ConversationMigrationError('source_invalid');
    const events: string[] = [];
    const ids = new Set<string>();
    try {
      for (const line of readTranscriptLines(join(transcriptRoot, base))) {
        const event = normalizeEvent(line, identity.sessionId, events.length);
        const id = String(JSON.parse(event).id);
        if (ids.has(id)) throw new ConversationMigrationError('source_invalid');
        ids.add(id);
        events.push(event);
      }
    } catch (error) {
      if (error instanceof ConversationMigrationError) throw error;
      throw new ConversationMigrationError('source_invalid');
    }
    const after = activeFiles(directory, base);
    if (jsonHash(before) !== jsonHash(after)) throw new ConversationMigrationError('source_changed');
    if (identity.requiresHistory && events.length === 0) throw new ConversationMigrationError('source_invalid');
    sourceFiles.push(...before);
    sessions.push({ ...identity, events, eventHash: jsonHash(events) });
  }
  sourceFiles.sort((a, b) => a.name.localeCompare(b.name));
  const plan: ConversationMigrationPlan = {
    version: 1, userDataPath: directory, sourceHash: '', sourceFiles, sessions,
    counts: { projects: projectCount, sessions: sessions.length, events: sessions.reduce((total, session) => total + session.events.length, 0) },
  };
  plan.sourceHash = planHash(plan);
  return plan;
}

function activeFiles(directory: string, base: string): ConversationMigrationSource[] {
  const root = join(directory, 'transcripts');
  assertDirectory(directory, root);
  const indexName = `${base}.index.json`;
  const indexPath = join(root, indexName);
  const indexStat = regular(indexPath);
  let names: string[];
  if (indexStat) {
    if (indexStat.size > 1024 * 1024) throw new ConversationMigrationError('source_invalid');
    let value: unknown;
    try { value = JSON.parse(readFileSync(indexPath, 'utf8')); }
    catch { throw new ConversationMigrationError('source_invalid'); }
    if (!object(value) || value.version !== 1 || !Array.isArray(value.segments) || !value.segments.length
      || new Set(value.segments).size !== value.segments.length
      || value.segments.some((name) => typeof name !== 'string' || (name !== base
        && !(name.startsWith(`${base}.segment-`) && /^[a-f0-9-]{36}\.jsonl$/.test(name.slice(`${base}.segment-`.length)))))) {
      throw new ConversationMigrationError('source_invalid');
    }
    names = [indexName, ...value.segments as string[]];
  } else names = regular(join(root, base)) ? [base] : [];
  return names.map((name) => {
    const path = join(root, name);
    const stat = regular(path);
    if (!stat) throw new ConversationMigrationError('source_invalid');
    assertCanonicalChild(directory, path, ['transcripts', name]);
    return { name: `transcripts/${name}`, bytes: stat.size, sha256: hashFile(path) };
  });
}

function normalizeEvent(line: string, sessionId: string, ordinal: number): string {
  let event: unknown;
  try { event = JSON.parse(line); } catch { throw new ConversationMigrationError('source_invalid'); }
  if (!object(event)) throw new ConversationMigrationError('source_invalid');
  if (event.schemaVersion !== undefined && event.schemaVersion !== 1) throw new ConversationMigrationError('unsupported_version');
  if (event.sessionId !== sessionId || typeof event.type !== 'string' || !event.type.trim()
    || !Number.isSafeInteger(event.createdAt) || Number(event.createdAt) < 0 || !object(event.payload)
    || (event.id !== undefined && (typeof event.id !== 'string' || !event.id.trim()))) throw new ConversationMigrationError('source_invalid');
  const id = event.id ?? `legacy:${jsonHash({ sessionId, ordinal, event })}`;
  const result = JSON.stringify({ ...event, id });
  if (Buffer.byteLength(result) + 1 > TRANSCRIPT_RECORD_BYTES) throw new ConversationMigrationError('source_invalid');
  return result;
}

function matchingRun(plan: ConversationMigrationPlan, store: Store): WorkspaceMigrationRun | undefined {
  const state = store.readState();
  if (!state) throw new ConversationMigrationError('target_mismatch');
  const previous = store.readMigrationRun(plan.sourceHash);
  const eventRuns = store.listMigrationRuns().filter((run) => run.phase !== 'state');
  // Once this source was imported, later session/project creation is normal
  // activity. A repeated import must leave it intact rather than reject it.
  if (previous && previous.phase !== 'state' && eventRuns.every((run) => run.sourceHash === plan.sourceHash)) return previous;
  if (state.projects.length !== plan.counts.projects
    || jsonHash(state.sessions.map((session) => ({ sessionId: String(session.id), projectId: String(session.projectId) }))
      .sort((a, b) => a.sessionId.localeCompare(b.sessionId)))
      !== jsonHash(plan.sessions.map(({ sessionId, projectId }) => ({ sessionId, projectId })))) throw new ConversationMigrationError('target_mismatch');
  if (eventRuns.length || plan.sessions.some((session) => store.readEvents(session.sessionId).length)) throw new ConversationMigrationError('target_not_empty');
  return undefined;
}

function assertPlan(plan: ConversationMigrationPlan): void {
  try {
    if (!plan || plan.version !== 1 || typeof plan.userDataPath !== 'string' || plan.userDataPath !== resolve(plan.userDataPath)
      || !Array.isArray(plan.sessions) || !Array.isArray(plan.sourceFiles)
      || new Set(plan.sessions.map((session) => session.sessionId)).size !== plan.sessions.length
      || new Set(plan.sourceFiles.map((file) => file.name)).size !== plan.sourceFiles.length
      || !Number.isSafeInteger(plan.counts.projects) || plan.counts.projects < 0
      || plan.counts.sessions !== plan.sessions.length
      || plan.counts.events !== plan.sessions.reduce((total, session) => total + session.events.length, 0)
      || planHash(plan) !== plan.sourceHash) throw new Error();
    for (const session of plan.sessions) {
      if (typeof session.sessionId !== 'string' || !session.sessionId.trim() || typeof session.projectId !== 'string'
        || !session.projectId.trim() || typeof session.requiresHistory !== 'boolean'
        || !Array.isArray(session.events) || jsonHash(session.events) !== session.eventHash
        || (session.requiresHistory && session.events.length === 0)) throw new Error();
      session.events.forEach((line, index) => { if (normalizeEvent(line, session.sessionId, index) !== line) throw new Error(); });
    }
    for (const file of plan.sourceFiles) {
      if (!/^transcripts\/[a-f0-9]{64}\.jsonl(?:\.index\.json|\.segment-[a-f0-9-]{36}\.jsonl)?$/.test(file.name)
        || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error();
    }
  } catch { throw new ConversationMigrationError('invalid_plan'); }
}

function assertUnchanged(plan: ConversationMigrationPlan): void {
  try {
    const fresh = snapshot(plan.userDataPath, plan.sessions.map(({ sessionId, projectId, requiresHistory }) => ({ sessionId, projectId, requiresHistory })), plan.counts.projects);
    if (fresh.sourceHash !== plan.sourceHash) throw new Error();
  } catch { throw new ConversationMigrationError('source_changed'); }
}

function backup(plan: ConversationMigrationPlan): string {
  const name = `events-${plan.sourceHash}-${randomUUID()}`;
  const root = join(plan.userDataPath, WORKSPACE_MIGRATION_BACKUPS);
  const destination = join(root, name);
  try {
    if (present(root) && (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink())) throw new Error();
    mkdirSync(root, { recursive: true, mode: 0o700 });
    assertCanonicalChild(plan.userDataPath, root, [WORKSPACE_MIGRATION_BACKUPS]);
    mkdirSync(destination, { mode: 0o700 });
    for (const file of plan.sourceFiles) {
      const source = join(plan.userDataPath, ...file.name.split('/'));
      const stat = regular(source);
      if (!stat || stat.size !== file.bytes || hashFile(source) !== file.sha256) throw new ConversationMigrationError('source_changed');
      const target = join(destination, ...file.name.split('/'));
      mkdirSync(join(destination, 'transcripts'), { recursive: true, mode: 0o700 });
      copyFileSync(source, target, constants.COPYFILE_EXCL);
      if (lstatSync(target).size !== file.bytes || hashFile(target) !== file.sha256) throw new Error();
    }
    writeFileSync(join(destination, 'manifest.json'), JSON.stringify({
      version: 1, kind: 'conversation', sourceHash: plan.sourceHash, sourceFiles: plan.sourceFiles,
      sessions: plan.sessions.map(({ sessionId, projectId, requiresHistory, eventHash, events }) => ({ sessionId, projectId, requiresHistory, eventHash, eventCount: events.length })),
      counts: plan.counts,
      retainedInPlace: ['retired transcript segments', 'checkpoints', 'imports', 'mcp-ownership', 'scheduled-tasks-v1.json',
        'integration-state-v1.json', 'subagent-projections-v1.json', 'provider-verification-audit-v1.json'],
    }, null, 2), { flag: 'wx', mode: 0o600, flush: true });
    assertUnchanged(plan);
    return name;
  } catch (error) {
    if (error instanceof ConversationMigrationError) throw error;
    throw new ConversationMigrationError('backup_failed');
  }
}

function assertDirectory(directory: string, child: string): void {
  if (!present(child)) return;
  try {
    const stat = lstatSync(child);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
    assertCanonicalChild(directory, child, ['transcripts']);
  } catch { throw new ConversationMigrationError('source_unavailable'); }
}

function assertCanonicalChild(directory: string, target: string, parts: string[]): void {
  const canonical = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
  if (canonical(realpathSync.native(target)) !== canonical(join(realpathSync.native(directory), ...parts))) {
    throw new ConversationMigrationError('source_unavailable');
  }
}

function regular(path: string): Stats | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error();
    return stat;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new ConversationMigrationError('source_unavailable');
  }
}

function present(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new ConversationMigrationError('source_unavailable');
  }
}

function hashFile(path: string): string {
  const digest = createHash('sha256');
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buffer = Buffer.alloc(64 * 1024);
    let bytes: number;
    while ((bytes = readSync(fd, buffer)) > 0) digest.update(buffer.subarray(0, bytes));
    return digest.digest('hex');
  } catch { throw new ConversationMigrationError('source_unavailable'); }
  finally { if (fd !== undefined) closeSync(fd); }
}

function planHash(plan: ConversationMigrationPlan): string {
  return jsonHash({ kind: 'workspace-conversation-v1', sourceFiles: plan.sourceFiles,
    sessions: plan.sessions.map(({ sessionId, projectId, requiresHistory, eventHash }) => ({ sessionId, projectId, requiresHistory, eventHash })), counts: plan.counts });
}
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function jsonHash(value: unknown): string { return hash(JSON.stringify(value)); }
