import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, isAbsolute, join, resolve, win32 } from 'node:path';

const MAX_PROJECT_DIRECTORIES = 500;
const MAX_TRANSCRIPTS = 500;
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_LINES_PER_TRANSCRIPT = 50_000;
const MAX_IMPORTED_EVENTS = 2_000;
const MAX_IMPORTED_PAYLOAD_BYTES = 3 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_MANIFEST_SESSIONS = 10_000;

export type CcHahaImportCandidate = {
  candidateId: string;
  sourceSessionId: string;
  sourceFile: string;
  transcriptHash: string;
  projectRoot?: string;
  projectDirectory: string;
  title: string;
  model: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  bytes: number;
  importable: boolean;
  alreadyImported: boolean;
  warnings: string[];
};

export type CcHahaImportScan = {
  schemaVersion: 1;
  sourceRoot: string;
  projectsRoot: string;
  sourceFingerprint: string;
  scannedAt: number;
  projectDirectoryCount: number;
  transcriptCount: number;
  importableCount: number;
  alreadyImportedCount: number;
  totalBytes: number;
  sessions: CcHahaImportCandidate[];
  warnings: string[];
};

export type ImportedConversationEvent = {
  type: string;
  createdAt: number;
  payload: Record<string, unknown>;
};

export type ConvertedCcHahaTranscript = {
  events: ImportedConversationEvent[];
  turnCount: number;
  truncated: boolean;
};

type ImportManifest = {
  schemaVersion: 1;
  updatedAt: number;
  sources: Array<{ sourceFingerprint: string; importedAt: number }>;
  sessions: Record<string, {
    sourceSessionId: string;
    targetSessionId: string;
    projectId: string;
    importedAt: number;
  }>;
};

export class CcHahaImporter {
  readonly #manifestPath: string;

  constructor(userDataPath: string) {
    const root = join(resolve(userDataPath), 'imports', 'cc-haha');
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.#manifestPath = join(root, 'manifest-v1.json');
  }

  scan(sourcePath: string): CcHahaImportScan {
    const sourceRoot = canonicalSourceDirectory(sourcePath);
    const projectsRoot = locateProjectsRoot(sourceRoot);
    const manifest = this.#manifest();
    const projectEntries = readdirSync(projectsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .slice(0, MAX_PROJECT_DIRECTORIES + 1);
    if (projectEntries.length > MAX_PROJECT_DIRECTORIES) throw new Error(`cc-haha 项目目录超过 ${MAX_PROJECT_DIRECTORIES} 个安全上限`);
    const sessions: CcHahaImportCandidate[] = [];
    let totalBytes = 0;
    for (const projectEntry of projectEntries) {
      const projectDirectoryPath = join(projectsRoot, projectEntry.name);
      const projectDirectoryStat = lstatSync(projectDirectoryPath);
      if (!projectDirectoryStat.isDirectory() || projectDirectoryStat.isSymbolicLink()) continue;
      const transcriptEntries = readdirSync(projectDirectoryPath, { withFileTypes: true })
        .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i.test(entry.name));
      for (const transcriptEntry of transcriptEntries) {
        if (sessions.length >= MAX_TRANSCRIPTS) throw new Error(`cc-haha Transcript 超过 ${MAX_TRANSCRIPTS} 个安全上限`);
        const sourceFile = join(projectDirectoryPath, transcriptEntry.name);
        const stat = lstatSync(sourceFile);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        if (stat.size > MAX_TRANSCRIPT_BYTES) {
          sessions.push(oversizedCandidate(sourceFile, projectEntry.name, stat.size, manifest));
          continue;
        }
        totalBytes += stat.size;
        if (totalBytes > MAX_TOTAL_BYTES) throw new Error(`cc-haha Transcript 总量超过 ${MAX_TOTAL_BYTES} 字节安全上限`);
        const content = readFileSync(sourceFile, 'utf8');
        sessions.push(inspectTranscript(sourceFile, projectEntry.name, content, stat.birthtimeMs, stat.mtimeMs, manifest));
      }
    }
    sessions.sort((left, right) => right.updatedAt - left.updatedAt);
    const sourceFingerprint = sha256(sessions.map((session) => `${session.projectDirectory}/${session.sourceSessionId}:${session.transcriptHash}`).sort().join('\n'));
    return {
      schemaVersion: 1,
      sourceRoot,
      projectsRoot,
      sourceFingerprint,
      scannedAt: Date.now(),
      projectDirectoryCount: projectEntries.length,
      transcriptCount: sessions.length,
      importableCount: sessions.filter((session) => session.importable && !session.alreadyImported).length,
      alreadyImportedCount: sessions.filter((session) => session.alreadyImported).length,
      totalBytes,
      sessions,
      warnings: [
        '源目录只读；不会导入 OAuth、API Key、Cookie、Keychain、运行中进程或 IM 登录态。',
        '导入会话保持只读；需要从显式 Fork 创建新的可执行历史。',
      ],
    };
  }

  convert(candidate: CcHahaImportCandidate): ConvertedCcHahaTranscript {
    const stat = lstatSync(candidate.sourceFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_TRANSCRIPT_BYTES) throw new Error('cc-haha Transcript 在导入前已失效');
    const content = readFileSync(candidate.sourceFile, 'utf8');
    if (sha256(content) !== candidate.transcriptHash) throw new Error('cc-haha Transcript 在 Dry Run 后发生变化，请重新扫描');
    const entries = parseEntries(content);
    const deduped = dedupeConversationEntries(entries);
    const events: ImportedConversationEvent[] = [];
    const assistantTurns = new Set<string>();
    let truncated = false;
    let payloadBytes = 0;
    const push = (event: ImportedConversationEvent): void => {
      if (events.length >= MAX_IMPORTED_EVENTS) { truncated = true; return; }
      const bytes = Buffer.byteLength(JSON.stringify(event), 'utf8');
      if (payloadBytes + bytes > MAX_IMPORTED_PAYLOAD_BYTES) { truncated = true; return; }
      payloadBytes += bytes;
      events.push(event);
    };
    for (const { entry, ordinal } of deduped) {
      const type = text(entry.type);
      const message = record(entry.message);
      const timestamp = safeTimestamp(entry.timestamp, candidate.createdAt + ordinal);
      const contentValue = message.content;
      if (type === 'user') {
        const blocks = contentBlocks(contentValue);
        for (const block of blocks) {
          if (block.type === 'tool_result') {
            push({
              type: 'tool.event', createdAt: timestamp,
              payload: {
                phase: block.is_error === true ? 'failed' : 'completed',
                tool: 'Runtime Tool',
                toolUseId: bounded(block.tool_use_id, 160),
                summary: block.is_error === true ? 'Imported tool result failed' : 'Imported tool result',
                importedFrom: 'cc-haha',
              },
            });
          } else if (block.type === 'text' && typeof block.text === 'string' && !entry.isMeta) {
            const value = bounded(block.text, 32_000);
            if (value) push({ type: 'user.message', createdAt: timestamp, payload: { text: value, importedFrom: 'cc-haha' } });
          }
        }
      } else if (type === 'assistant') {
        const runtimeMessageId = bounded(message.id ?? entry.uuid, 160) || `imported:${ordinal}`;
        assistantTurns.add(runtimeMessageId);
        push({ type: 'assistant.message.started', createdAt: timestamp, payload: { messageId: runtimeMessageId, importedFrom: 'cc-haha' } });
        for (const block of contentBlocks(contentValue)) {
          if (block.type === 'text' && typeof block.text === 'string') {
            const value = bounded(block.text, 32_000);
            if (value) push({ type: 'assistant.delta', createdAt: timestamp, payload: { text: value, importedFrom: 'cc-haha' } });
          } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
            push({ type: 'assistant.thinking.started', createdAt: timestamp, payload: { importedFrom: 'cc-haha' } });
            push({ type: 'assistant.thinking.delta', createdAt: timestamp, payload: { text: bounded(block.thinking, 32_000), importedFrom: 'cc-haha' } });
            push({ type: 'assistant.thinking.completed', createdAt: timestamp, payload: { importedFrom: 'cc-haha' } });
          } else if (block.type === 'tool_use' || block.type === 'server_tool_use') {
            push({
              type: 'tool.event', createdAt: timestamp,
              payload: {
                phase: 'started', tool: bounded(block.name, 120) || 'Runtime Tool',
                toolUseId: bounded(block.id, 160), summary: `Imported ${bounded(block.name, 120) || 'tool'} invocation`,
                importedFrom: 'cc-haha',
              },
            });
          }
        }
        push({ type: 'assistant.message.completed', createdAt: timestamp, payload: { messageId: runtimeMessageId, importedFrom: 'cc-haha' } });
      }
    }
    if (assistantTurns.size > 0) {
      push({
        type: 'turn.completed', createdAt: candidate.updatedAt,
        payload: { status: 'imported_read_only', importedTurns: assistantTurns.size, importedFrom: 'cc-haha' },
      });
    }
    return { events, turnCount: assistantTurns.size, truncated };
  }

  recordImport(sourceFingerprint: string, records: Array<{
    transcriptHash: string;
    sourceSessionId: string;
    targetSessionId: string;
    projectId: string;
  }>): void {
    const manifest = this.#manifest();
    const importedAt = Date.now();
    for (const record of records) {
      manifest.sessions[record.transcriptHash] = {
        sourceSessionId: record.sourceSessionId,
        targetSessionId: record.targetSessionId,
        projectId: record.projectId,
        importedAt,
      };
    }
    manifest.sessions = Object.fromEntries(
      Object.entries(manifest.sessions)
        .sort((left, right) => left[1].importedAt - right[1].importedAt)
        .slice(-MAX_MANIFEST_SESSIONS),
    );
    if (!manifest.sources.some((source) => source.sourceFingerprint === sourceFingerprint)) {
      manifest.sources.push({ sourceFingerprint, importedAt });
    }
    manifest.sources = manifest.sources.slice(-100);
    manifest.updatedAt = importedAt;
    atomicWrite(this.#manifestPath, JSON.stringify(manifest, null, 2));
  }

  #manifest(): ImportManifest {
    if (!existsSync(this.#manifestPath)) return emptyManifest();
    if (statSync(this.#manifestPath).size > MAX_MANIFEST_BYTES) {
      throw new Error('cc-haha 导入 Manifest 超过安全上限；为避免重复导入已停止');
    }
    try {
      const value = JSON.parse(readFileSync(this.#manifestPath, 'utf8')) as unknown;
      if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.sessions) || !Array.isArray(value.sources)) {
        throw new Error('schema invalid');
      }
      const sources = value.sources.slice(-100).filter(isRecord).flatMap((source) => (
        typeof source.sourceFingerprint === 'string' && typeof source.importedAt === 'number'
          ? [{ sourceFingerprint: source.sourceFingerprint, importedAt: source.importedAt }]
          : []
      ));
      const rawSessions = Object.entries(value.sessions);
      if (rawSessions.length > MAX_MANIFEST_SESSIONS || sources.length !== Math.min(value.sources.length, 100)) {
        throw new Error('manifest bounds invalid');
      }
      const sessions = Object.fromEntries(rawSessions.flatMap(([hash, item]) => {
        if (!/^sha256:[a-f0-9]{64}$/.test(hash) || !isRecord(item)) return [];
        if (![item.sourceSessionId, item.targetSessionId, item.projectId].every((field) => typeof field === 'string') || typeof item.importedAt !== 'number') return [];
        return [[hash, {
          sourceSessionId: item.sourceSessionId as string,
          targetSessionId: item.targetSessionId as string,
          projectId: item.projectId as string,
          importedAt: item.importedAt,
        }]];
      }));
      if (Object.keys(sessions).length !== rawSessions.length) throw new Error('session record invalid');
      return {
        schemaVersion: 1,
        updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0,
        sources,
        sessions,
      };
    } catch {
      throw new Error('cc-haha 导入 Manifest 已损坏；为避免重复导入已停止');
    }
  }
}

function inspectTranscript(sourceFile: string, projectDirectory: string, content: string, birthtime: number, mtime: number, manifest: ImportManifest): CcHahaImportCandidate {
  const sourceSessionId = basename(sourceFile, '.jsonl');
  const transcriptHash = sha256(content);
  const warnings: string[] = [];
  let entries: Array<Record<string, unknown>> = [];
  try { entries = parseEntries(content); }
  catch (error) { warnings.push(error instanceof Error ? error.message : String(error)); }
  let projectRoot = '';
  let customTitle = '';
  let aiTitle = '';
  let firstPrompt = '';
  let model = 'sonnet';
  let createdAt = Number.isFinite(birthtime) ? birthtime : mtime;
  let updatedAt = Number.isFinite(mtime) ? mtime : createdAt;
  for (const entry of entries) {
    const cwd = text(entry.cwd);
    if (cwd && (isAbsolute(cwd) || win32.isAbsolute(cwd))) projectRoot = cwd;
    if (entry.type === 'custom-title') customTitle = bounded(entry.customTitle, 120);
    if (entry.type === 'ai-title') aiTitle = bounded(entry.aiTitle, 120);
    const message = record(entry.message);
    if (typeof message.model === 'string') model = bounded(message.model, 128) || model;
    const timestamp = Date.parse(text(entry.timestamp));
    if (Number.isFinite(timestamp)) {
      createdAt = Math.min(createdAt, timestamp);
      updatedAt = Math.max(updatedAt, timestamp);
    }
    if (!firstPrompt && entry.type === 'user' && entry.isMeta !== true) {
      const firstTextBlock = contentBlocks(message.content)
        .find((block) => block.type === 'text' && typeof block.text === 'string');
      firstPrompt = firstTextBlock && typeof firstTextBlock.text === 'string' ? firstTextBlock.text : '';
    }
  }
  const gitRoot = projectRoot ? canonicalGitRoot(projectRoot) : '';
  if (!gitRoot) warnings.push(projectRoot ? 'Transcript cwd 不是可用 Git 项目' : 'Transcript 缺少可验证 cwd；目录名反解有损，未自动采用');
  const title = cleanTitle(customTitle || aiTitle || firstPrompt || `Imported ${sourceSessionId.slice(0, 8)}`);
  const alreadyImported = Boolean(manifest.sessions[transcriptHash]);
  return {
    candidateId: createHash('sha256').update(`${projectDirectory}/${sourceSessionId}`).digest('hex').slice(0, 24),
    sourceSessionId,
    sourceFile,
    transcriptHash,
    ...(gitRoot ? { projectRoot: gitRoot } : {}),
    projectDirectory,
    title,
    model,
    createdAt,
    updatedAt,
    messageCount: entries.filter((entry) => entry.type === 'user' || entry.type === 'assistant').length,
    bytes: Buffer.byteLength(content, 'utf8'),
    importable: Boolean(gitRoot) && entries.length > 0,
    alreadyImported,
    warnings,
  };
}

function oversizedCandidate(sourceFile: string, projectDirectory: string, bytes: number, manifest: ImportManifest): CcHahaImportCandidate {
  const sourceSessionId = basename(sourceFile, '.jsonl');
  const transcriptHash = `oversized:${bytes}:${statSync(sourceFile).mtimeMs}`;
  return {
    candidateId: createHash('sha256').update(`${projectDirectory}/${sourceSessionId}`).digest('hex').slice(0, 24),
    sourceSessionId,
    sourceFile,
    transcriptHash,
    projectDirectory,
    title: `Imported ${sourceSessionId.slice(0, 8)}`,
    model: 'sonnet',
    createdAt: statSync(sourceFile).birthtimeMs,
    updatedAt: statSync(sourceFile).mtimeMs,
    messageCount: 0,
    bytes,
    importable: false,
    alreadyImported: Boolean(manifest.sessions[transcriptHash]),
    warnings: [`Transcript 超过 ${MAX_TRANSCRIPT_BYTES} 字节上限`],
  };
}

function parseEntries(content: string): Array<Record<string, unknown>> {
  const lines = content.split(/\r?\n/).filter(Boolean);
  if (lines.length > MAX_LINES_PER_TRANSCRIPT) throw new Error(`Transcript 超过 ${MAX_LINES_PER_TRANSCRIPT} 行安全上限`);
  const entries: Array<Record<string, unknown>> = [];
  let invalid = 0;
  for (const line of lines) {
    try {
      const value = JSON.parse(line) as unknown;
      if (isRecord(value)) entries.push(value);
      else invalid += 1;
    } catch { invalid += 1; }
  }
  if (invalid > Math.max(5, Math.floor(lines.length * 0.05))) throw new Error(`Transcript 含 ${invalid} 行无法解析的数据`);
  return entries;
}

function dedupeConversationEntries(entries: Array<Record<string, unknown>>): Array<{ entry: Record<string, unknown>; ordinal: number }> {
  const values = new Map<string, { entry: Record<string, unknown>; ordinal: number }>();
  entries.forEach((entry, ordinal) => {
    if (entry.type !== 'user' && entry.type !== 'assistant') return;
    const message = record(entry.message);
    const runtimeMessageId = bounded(message.id ?? entry.uuid, 160);
    const key = runtimeMessageId ? `${entry.type}:${runtimeMessageId}` : `${entry.type}:${ordinal}`;
    const existing = values.get(key);
    values.set(key, { entry, ordinal: existing?.ordinal ?? ordinal });
  });
  return [...values.values()].sort((left, right) => left.ordinal - right.ordinal);
}

function contentBlocks(value: unknown): Array<Record<string, unknown>> {
  if (typeof value === 'string') return [{ type: 'text', text: value }];
  return Array.isArray(value) ? value.filter(isRecord).slice(0, 512) : [];
}

function canonicalSourceDirectory(value: string): string {
  const candidate = resolve(String(value ?? '').trim());
  if (!existsSync(candidate)) throw new Error('cc-haha 源目录不存在');
  const link = lstatSync(candidate);
  if (!link.isDirectory() || link.isSymbolicLink()) throw new Error('cc-haha 源目录必须是真实目录，不能是符号链接');
  return realpathSync.native(candidate);
}

function locateProjectsRoot(sourceRoot: string): string {
  const candidate = basename(sourceRoot).toLocaleLowerCase('en-US') === 'projects' ? sourceRoot : join(sourceRoot, 'projects');
  if (!existsSync(candidate)) throw new Error('所选目录不包含 cc-haha/Claude projects 目录');
  const link = lstatSync(candidate);
  if (!link.isDirectory() || link.isSymbolicLink()) throw new Error('projects 必须是真实目录，不能是符号链接');
  return realpathSync.native(candidate);
}

function canonicalGitRoot(value: string): string {
  try {
    const candidate = realpathSync.native(resolve(value));
    if (!statSync(candidate).isDirectory()) return '';
    const result = spawnSync('git.exe', ['-C', candidate, 'rev-parse', '--show-toplevel'], {
      cwd: candidate,
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.error || result.status !== 0) return '';
    return realpathSync.native(String(result.stdout ?? '').trim());
  } catch { return ''; }
}

function cleanTitle(value: string): string {
  const title = value.replace(/[\r\n\0]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  return title || 'Imported cc-haha Session';
}

function safeTimestamp(value: unknown, fallback: number): number {
  const parsed = Date.parse(text(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bounded(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\0/g, '').slice(0, max) : '';
}

function text(value: unknown): string { return typeof value === 'string' ? value : ''; }
function record(value: unknown): Record<string, unknown> { return isRecord(value) ? value : {}; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function sha256(value: string): string { return 'sha256:' + createHash('sha256').update(value).digest('hex'); }

function emptyManifest(): ImportManifest {
  return { schemaVersion: 1, updatedAt: 0, sources: [], sessions: {} };
}

function atomicWrite(path: string, content: string): void {
  const temporary = `${path}.tmp-${randomUUID()}`;
  const previous = `${path}.previous-${randomUUID()}`;
  writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600 });
  let moved = false;
  try {
    if (existsSync(path)) { renameSync(path, previous); moved = true; }
    renameSync(temporary, path);
    if (moved) rmSync(previous, { force: true });
  } catch (error) {
    rmSync(temporary, { force: true });
    if (moved && existsSync(previous) && !existsSync(path)) renameSync(previous, path);
    throw error;
  }
}
