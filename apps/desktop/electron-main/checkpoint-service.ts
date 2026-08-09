import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, normalize, resolve, sep, win32 } from 'node:path';

const DEFAULT_CHANGED_BYTES_LIMIT = 256 * 1024 * 1024;
const TRANSCRIPT_BYTES_LIMIT = 8 * 1024 * 1024;
const GIT_OUTPUT_LIMIT = 4 * 1024 * 1024;

export type CheckpointKind = 'manual' | 'recovery';

export type ConversationCheckpoint = {
  schemaVersion: 1;
  id: string;
  sessionId: string;
  kind: CheckpointKind;
  label: string;
  createdAt: number;
  headCommit: string;
  indexTree: string;
  worktreeTree: string;
  snapshotCommit: string;
  snapshotRef: string;
  conversationFile: string;
  conversationEventCount: number;
  conversationHash: string;
  runtimeSessionId?: string;
  runtimeTurnId?: string;
  runtimeMessageId?: string;
  turnCount: number;
};

export type CheckpointPreview = {
  checkpoint: ConversationCheckpoint;
  currentHead: string;
  headWillMove: false;
  changedPaths: string[];
  changedPathCount: number;
  conversationEventsRemoved: number;
};

export type CheckpointRewindResult = {
  checkpoint: ConversationCheckpoint;
  recoveryCheckpoint: ConversationCheckpoint;
  restoredPathCount: number;
  restoredConversationEventCount: number;
  headCommit: string;
};

export class CheckpointServiceError extends Error {
  readonly recoveryCheckpointId: string | undefined;

  constructor(message: string, recoveryCheckpointId?: string) {
    super(message);
    this.name = 'CheckpointServiceError';
    this.recoveryCheckpointId = recoveryCheckpointId;
  }
}

type CreateCheckpointInput = {
  sessionId: string;
  worktreePath: string;
  transcriptPath: string;
  label: string;
  kind?: CheckpointKind;
  runtimeSessionId?: string;
  runtimeTurnId?: string;
  runtimeMessageId?: string;
  turnCount: number;
};

export class CheckpointService {
  readonly #root: string;
  readonly #gitExecutable: string;
  readonly #now: () => number;
  readonly #id: () => string;
  readonly #maxChangedBytes: number;

  constructor(userDataPath: string, options: {
    gitExecutable?: string;
    now?: () => number;
    id?: () => string;
    maxChangedBytes?: number;
  } = {}) {
    this.#root = join(userDataPath, 'checkpoints');
    this.#gitExecutable = options.gitExecutable ?? 'git.exe';
    this.#now = options.now ?? Date.now;
    this.#id = options.id ?? randomUUID;
    this.#maxChangedBytes = options.maxChangedBytes ?? DEFAULT_CHANGED_BYTES_LIMIT;
    if (!Number.isSafeInteger(this.#maxChangedBytes) || this.#maxChangedBytes < 1) {
      throw new CheckpointServiceError('Checkpoint changed-byte limit is invalid');
    }
    mkdirSync(this.#root, { recursive: true, mode: 0o700 });
  }

  list(sessionId: string): ConversationCheckpoint[] {
    const directory = this.#sessionDirectory(sessionId);
    if (!existsSync(directory)) return [];
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => {
        try { return this.#readManifest(sessionId, entry.name.slice(0, -5)); }
        catch { return null; }
      })
      .filter((checkpoint): checkpoint is ConversationCheckpoint => checkpoint !== null)
      .sort((left, right) => right.createdAt - left.createdAt);
  }

  create(input: CreateCheckpointInput): ConversationCheckpoint {
    const sessionId = safeSessionId(input.sessionId);
    const worktreePath = canonicalDirectory(input.worktreePath);
    const label = safeLabel(input.label);
    const kind = input.kind ?? 'manual';
    const id = safeCheckpointId(this.#id());
    const directory = this.#sessionDirectory(sessionId);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const conversation = readConversation(input.transcriptPath, sessionId);
    this.#assertChangedBytes(worktreePath);
    const snapshot = this.#snapshot(worktreePath, sessionId, id);
    const conversationFile = `${id}.conversation.jsonl`;
    const conversationPath = join(directory, conversationFile);
    const manifestPath = join(directory, `${id}.json`);
    const checkpoint: ConversationCheckpoint = {
      schemaVersion: 1,
      id,
      sessionId,
      kind,
      label,
      createdAt: this.#now(),
      headCommit: snapshot.headCommit,
      indexTree: snapshot.indexTree,
      worktreeTree: snapshot.worktreeTree,
      snapshotCommit: snapshot.snapshotCommit,
      snapshotRef: snapshot.snapshotRef,
      conversationFile,
      conversationEventCount: conversation.eventCount,
      conversationHash: sha256(conversation.content),
      ...(input.runtimeSessionId ? { runtimeSessionId: safeRuntimeSessionId(input.runtimeSessionId) } : {}),
      ...(input.runtimeTurnId ? { runtimeTurnId: safeRuntimeSessionId(input.runtimeTurnId) } : {}),
      ...(input.runtimeMessageId ? { runtimeMessageId: safeRuntimeSessionId(input.runtimeMessageId) } : {}),
      turnCount: Math.max(0, Math.trunc(input.turnCount)),
    };
    try {
      atomicWrite(conversationPath, conversation.content);
      atomicWrite(manifestPath, JSON.stringify(checkpoint, null, 2));
      return checkpoint;
    } catch (error) {
      try { this.#git(worktreePath, ['update-ref', '-d', snapshot.snapshotRef]); } catch { /* Best effort ref cleanup. */ }
      rmSync(conversationPath, { force: true });
      rmSync(manifestPath, { force: true });
      throw error;
    }
  }

  preview(sessionId: string, checkpointId: string, worktreePathValue: string, transcriptPath: string): CheckpointPreview {
    const checkpoint = this.#readManifest(sessionId, checkpointId);
    const worktreePath = canonicalDirectory(worktreePathValue);
    this.#verifySnapshot(worktreePath, checkpoint);
    const changedPaths = this.#changedPathsAgainst(worktreePath, checkpoint.snapshotCommit);
    const currentConversation = readConversation(transcriptPath, checkpoint.sessionId);
    return {
      checkpoint,
      currentHead: this.#commit(this.#git(worktreePath, ['rev-parse', '--verify', 'HEAD^{commit}']).trim()),
      headWillMove: false,
      changedPaths: changedPaths.slice(0, 100),
      changedPathCount: changedPaths.length,
      conversationEventsRemoved: Math.max(0, currentConversation.eventCount - checkpoint.conversationEventCount),
    };
  }

  rewind(input: CreateCheckpointInput & { checkpointId: string }): CheckpointRewindResult {
    const sessionId = safeSessionId(input.sessionId);
    const checkpoint = this.#readManifest(sessionId, input.checkpointId);
    const worktreePath = canonicalDirectory(input.worktreePath);
    this.#verifySnapshot(worktreePath, checkpoint);
    const preview = this.preview(sessionId, checkpoint.id, worktreePath, input.transcriptPath);
    const recoveryCheckpoint = this.create({
      ...input,
      label: `回退前恢复点 · ${checkpoint.label}`,
      kind: 'recovery',
    });
    try {
      this.#git(worktreePath, ['clean', '-fd', '--', '.']);
      this.#git(worktreePath, ['read-tree', '--reset', '-u', checkpoint.worktreeTree]);
      this.#git(worktreePath, ['read-tree', checkpoint.indexTree]);
      const conversationPath = this.#conversationPath(checkpoint);
      const conversation = readConversation(conversationPath, sessionId);
      if (sha256(conversation.content) !== checkpoint.conversationHash) {
        throw new CheckpointServiceError('Checkpoint conversation hash does not match its manifest');
      }
      atomicWrite(input.transcriptPath, conversation.content);
      const restoredIndex = this.#tree(this.#git(worktreePath, ['write-tree']).trim());
      const restoredWorktree = this.#worktreeTree(worktreePath, `verify-${checkpoint.id}`);
      if (restoredIndex !== checkpoint.indexTree || restoredWorktree !== checkpoint.worktreeTree) {
        throw new CheckpointServiceError('Checkpoint restore verification failed');
      }
      return {
        checkpoint,
        recoveryCheckpoint,
        restoredPathCount: preview.changedPathCount,
        restoredConversationEventCount: checkpoint.conversationEventCount,
        headCommit: this.#commit(this.#git(worktreePath, ['rev-parse', '--verify', 'HEAD^{commit}']).trim()),
      };
    } catch (error) {
      throw new CheckpointServiceError(
        `Checkpoint 回退未完成；恢复检查点 ${recoveryCheckpoint.id} 已保留，请人工复核 Worktree`,
        recoveryCheckpoint.id,
      );
    }
  }

  #snapshot(worktreePath: string, sessionId: string, checkpointId: string): {
    headCommit: string;
    indexTree: string;
    worktreeTree: string;
    snapshotCommit: string;
    snapshotRef: string;
  } {
    const unresolved = this.#git(worktreePath, ['diff', '--name-only', '--diff-filter=U', '-z']);
    if (unresolved) throw new CheckpointServiceError('存在未解决 Git 冲突，不能创建 Checkpoint');
    const headCommit = this.#commit(this.#git(worktreePath, ['rev-parse', '--verify', 'HEAD^{commit}']).trim());
    const indexTree = this.#tree(this.#git(worktreePath, ['write-tree']).trim());
    const worktreeTree = this.#worktreeTree(worktreePath, checkpointId);
    const snapshotCommit = this.#commit(this.#git(worktreePath, [
      '-c', 'commit.gpgSign=false', 'commit-tree', worktreeTree, '-p', headCommit,
      '-m', `Tsukiori checkpoint ${checkpointId}`,
    ]).trim());
    const sessionToken = createHash('sha256').update(sessionId).digest('hex').slice(0, 24);
    const snapshotRef = `refs/tsukiori/checkpoints/${sessionToken}/${checkpointId}`;
    this.#git(worktreePath, ['update-ref', snapshotRef, snapshotCommit]);
    return { headCommit, indexTree, worktreeTree, snapshotCommit, snapshotRef };
  }

  #worktreeTree(worktreePath: string, tokenValue: string): string {
    const commonValue = this.#git(worktreePath, ['rev-parse', '--git-common-dir']).trim();
    const commonCandidate = isAbsolute(commonValue) || win32.isAbsolute(commonValue)
      ? commonValue
      : resolve(worktreePath, commonValue);
    const common = realpathSync.native(commonCandidate);
    const indexRoot = join(common, 'tsukiori-checkpoints');
    mkdirSync(indexRoot, { recursive: true, mode: 0o700 });
    const token = tokenValue.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 96);
    const indexPath = join(indexRoot, `index-${token || randomUUID()}`);
    const environment = { GIT_INDEX_FILE: indexPath };
    try {
      this.#git(worktreePath, ['read-tree', 'HEAD'], environment);
      this.#git(worktreePath, ['add', '-A', '--', '.'], environment);
      return this.#tree(this.#git(worktreePath, ['write-tree'], environment).trim());
    } finally {
      rmSync(indexPath, { force: true });
      rmSync(`${indexPath}.lock`, { force: true });
    }
  }

  #verifySnapshot(worktreePath: string, checkpoint: ConversationCheckpoint): void {
    const resolved = this.#commit(this.#git(worktreePath, ['rev-parse', '--verify', `${checkpoint.snapshotRef}^{commit}`]).trim());
    if (resolved !== checkpoint.snapshotCommit) throw new CheckpointServiceError('Checkpoint Git ref no longer matches its manifest');
    const tree = this.#tree(this.#git(worktreePath, ['show', '-s', '--format=%T', checkpoint.snapshotCommit]).trim());
    if (tree !== checkpoint.worktreeTree) throw new CheckpointServiceError('Checkpoint Worktree tree no longer matches its commit');
    this.#tree(this.#git(worktreePath, ['rev-parse', '--verify', `${checkpoint.indexTree}^{tree}`]).trim());
    if (!existsSync(this.#conversationPath(checkpoint))) throw new CheckpointServiceError('Checkpoint conversation snapshot is missing');
  }

  #changedPathsAgainst(worktreePath: string, snapshotCommit: string): string[] {
    const tracked = splitNull(this.#git(worktreePath, ['diff', '--name-only', '-z', snapshotCommit, '--']));
    const untracked = splitNull(this.#git(worktreePath, ['ls-files', '--others', '--exclude-standard', '-z']));
    return [...new Set([...tracked, ...untracked])].sort();
  }

  #assertChangedBytes(worktreePath: string): void {
    const tracked = splitNull(this.#git(worktreePath, ['diff', '--name-only', '-z', 'HEAD', '--']));
    const untracked = splitNull(this.#git(worktreePath, ['ls-files', '--others', '--exclude-standard', '-z']));
    let total = 0;
    for (const path of new Set([...tracked, ...untracked])) {
      const absolute = safeWorktreeFile(worktreePath, path);
      if (!absolute || !existsSync(absolute)) continue;
      const stat = lstatSync(absolute);
      if (!stat.isFile()) continue;
      total += stat.size;
      if (total > this.#maxChangedBytes) {
        throw new CheckpointServiceError(`Checkpoint 变更内容超过 ${this.#maxChangedBytes} 字节安全上限`);
      }
    }
  }

  #readManifest(sessionIdValue: string, checkpointIdValue: string): ConversationCheckpoint {
    const sessionId = safeSessionId(sessionIdValue);
    const checkpointId = safeCheckpointId(checkpointIdValue);
    const path = join(this.#sessionDirectory(sessionId), `${checkpointId}.json`);
    if (!existsSync(path) || statSync(path).size > 128 * 1024) throw new CheckpointServiceError('Checkpoint 不存在或 manifest 超限');
    let value: unknown;
    try { value = JSON.parse(readFileSync(path, 'utf8')) as unknown; }
    catch { throw new CheckpointServiceError('Checkpoint manifest 无法解析'); }
    if (!isRecord(value) || value.schemaVersion !== 1 || value.id !== checkpointId || value.sessionId !== sessionId) {
      throw new CheckpointServiceError('Checkpoint manifest 身份不匹配');
    }
    const checkpoint = value as unknown as ConversationCheckpoint;
    if (typeof checkpoint.label !== 'string') throw new CheckpointServiceError('Checkpoint 名称无效');
    safeLabel(checkpoint.label);
    if (checkpoint.kind !== 'manual' && checkpoint.kind !== 'recovery') throw new CheckpointServiceError('Checkpoint kind 无效');
    for (const objectId of [checkpoint.headCommit, checkpoint.indexTree, checkpoint.worktreeTree, checkpoint.snapshotCommit]) {
      if (typeof objectId !== 'string' || !/^[a-f0-9]{40,64}$/i.test(objectId)) {
        throw new CheckpointServiceError('Checkpoint Git object 无效');
      }
    }
    if (typeof checkpoint.snapshotRef !== 'string'
      || !/^refs\/tsukiori\/checkpoints\/[a-f0-9]{24}\/[A-Za-z0-9._-]{1,96}$/.test(checkpoint.snapshotRef)
      || !checkpoint.snapshotRef.endsWith(`/${checkpoint.id}`)) {
      throw new CheckpointServiceError('Checkpoint Git ref 无效');
    }
    if (checkpoint.conversationFile !== `${checkpoint.id}.conversation.jsonl`) throw new CheckpointServiceError('Checkpoint conversation path 无效');
    if (typeof checkpoint.conversationHash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(checkpoint.conversationHash)) {
      throw new CheckpointServiceError('Checkpoint conversation hash 无效');
    }
    if (!Number.isSafeInteger(checkpoint.createdAt) || checkpoint.createdAt < 0) throw new CheckpointServiceError('Checkpoint createdAt 无效');
    if (!Number.isSafeInteger(checkpoint.conversationEventCount) || checkpoint.conversationEventCount < 0) throw new CheckpointServiceError('Checkpoint event count 无效');
    if (!Number.isSafeInteger(checkpoint.turnCount) || checkpoint.turnCount < 0) throw new CheckpointServiceError('Checkpoint turn count 无效');
    for (const runtimeId of [checkpoint.runtimeSessionId, checkpoint.runtimeTurnId, checkpoint.runtimeMessageId]) {
      if (runtimeId !== undefined) {
        if (typeof runtimeId !== 'string') throw new CheckpointServiceError('Runtime Session ID 无效');
        safeRuntimeSessionId(runtimeId);
      }
    }
    return checkpoint;
  }

  #conversationPath(checkpoint: ConversationCheckpoint): string {
    return join(this.#sessionDirectory(checkpoint.sessionId), checkpoint.conversationFile);
  }

  #sessionDirectory(sessionId: string): string {
    return join(this.#root, createHash('sha256').update(safeSessionId(sessionId)).digest('hex'));
  }

  #git(worktreePath: string, args: readonly string[], additions: Readonly<Record<string, string>> = {}): string {
    const result = spawnSync(this.#gitExecutable, ['-C', worktreePath, ...args], {
      cwd: worktreePath,
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
      timeout: 60_000,
      maxBuffer: GIT_OUTPUT_LIMIT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0', ...additions },
    });
    if (result.error || result.status !== 0) throw new CheckpointServiceError('Structured Git checkpoint command failed');
    return result.stdout ?? '';
  }

  #commit(value: string): string {
    if (!/^[a-f0-9]{40,64}$/i.test(value)) throw new CheckpointServiceError('Checkpoint commit 无效');
    return value;
  }

  #tree(value: string): string {
    if (!/^[a-f0-9]{40,64}$/i.test(value)) throw new CheckpointServiceError('Checkpoint tree 无效');
    return value;
  }
}

function readConversation(path: string, sessionId: string): { content: string; eventCount: number } {
  if (!existsSync(path)) return { content: '', eventCount: 0 };
  const size = statSync(path).size;
  if (size > TRANSCRIPT_BYTES_LIMIT) throw new CheckpointServiceError('Transcript 超过 Checkpoint 的 8 MiB 上限');
  const content = readFileSync(path, 'utf8');
  const lines = content.split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    let value: unknown;
    try { value = JSON.parse(line) as unknown; }
    catch { throw new CheckpointServiceError('Transcript 含无法解析的事件'); }
    if (!isRecord(value) || value.sessionId !== sessionId || typeof value.type !== 'string') {
      throw new CheckpointServiceError('Transcript 事件身份无效');
    }
  }
  return { content: content && !content.endsWith('\n') ? `${content}\n` : content, eventCount: lines.length };
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const token = randomUUID();
  const temporary = `${path}.tmp-${token}`;
  const previous = `${path}.previous-${token}`;
  writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600 });
  let movedPrevious = false;
  try {
    if (existsSync(path)) {
      renameSync(path, previous);
      movedPrevious = true;
    }
    renameSync(temporary, path);
    if (movedPrevious) rmSync(previous, { force: true });
  } catch (error) {
    rmSync(temporary, { force: true });
    if (movedPrevious && existsSync(previous) && !existsSync(path)) renameSync(previous, path);
    throw error;
  }
}

function safeWorktreeFile(rootValue: string, pathValue: string): string | null {
  const path = pathValue.replaceAll('\\', '/');
  if (!path || path.includes('\0') || path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.split('/').includes('..')) {
    throw new CheckpointServiceError('Checkpoint path 越出 Worktree');
  }
  const root = canonicalDirectory(rootValue);
  const absolute = resolve(root, ...path.split('/'));
  const rootPrefix = normalize(root).toLowerCase() + sep;
  if (!normalize(absolute).toLowerCase().startsWith(rootPrefix)) throw new CheckpointServiceError('Checkpoint path 越出 Worktree');
  if (!existsSync(absolute)) return null;
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink()) return absolute;
  const canonical = realpathSync.native(absolute);
  if (!normalize(canonical).toLowerCase().startsWith(rootPrefix)) throw new CheckpointServiceError('Checkpoint path 通过链接越出 Worktree');
  return canonical;
}

function canonicalDirectory(value: string): string {
  const path = realpathSync.native(resolve(value));
  if (!statSync(path).isDirectory()) throw new CheckpointServiceError('Checkpoint Worktree 不是目录');
  return path;
}

function safeSessionId(value: string): string {
  const id = String(value ?? '').trim();
  if (!/^[A-Za-z0-9:_-]{1,256}$/.test(id)) throw new CheckpointServiceError('Checkpoint Session ID 无效');
  return id;
}

function safeRuntimeSessionId(value: string): string {
  const id = String(value ?? '').trim();
  if (!/^[A-Za-z0-9:._-]{1,256}$/.test(id)) throw new CheckpointServiceError('Runtime Session ID 无效');
  return id;
}

function safeCheckpointId(value: string): string {
  const id = String(value ?? '').trim();
  if (!/^[A-Za-z0-9._-]{1,96}$/.test(id) || id === '.' || id === '..') {
    throw new CheckpointServiceError('Checkpoint ID 无效');
  }
  return id;
}

function safeLabel(value: string): string {
  const label = String(value ?? '').trim();
  if (!label || label.length > 80 || /[\r\n\0]/.test(label)) throw new CheckpointServiceError('Checkpoint 名称必须为 1–80 个单行字符');
  return label;
}

function splitNull(value: string): string[] {
  return value.split('\0').map((item) => item.trim()).filter(Boolean);
}

function sha256(value: string): string {
  return 'sha256:' + createHash('sha256').update(value).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
