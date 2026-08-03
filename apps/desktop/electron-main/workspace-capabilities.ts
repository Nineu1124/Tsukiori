import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';

export type McpScope = 'user' | 'project' | 'local';
export type McpTransport = 'stdio' | 'http' | 'sse';

export type McpServerRecord = {
  id: string;
  name: string;
  scope: McpScope;
  projectId?: string;
  transport: McpTransport;
  command?: string;
  args: string[];
  url?: string;
  envKeys: string[];
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  authStatus: 'not_configured' | 'configured' | 'unknown';
};

export type McpServerInput = Partial<McpServerRecord> & {
  name: string;
  scope: McpScope;
  transport: McpTransport;
};

export type SkillRecord = {
  id: string;
  name: string;
  description: string;
  scope: 'user' | 'project' | 'session';
  projectId?: string;
  path: string;
  source: 'local' | 'imported';
  installed: boolean;
  safety: 'local' | 'unverified';
  files: number;
  updatedAt: number;
};

export type SkillDetail = SkillRecord & { content: string; filesList: string[] };

export type MemoryFile = {
  path: string;
  size: number;
  updatedAt: number;
  content?: string;
};

export type ScheduledTask = {
  id: string;
  name: string;
  projectId: string;
  prompt: string;
  intervalMinutes: number;
  nextRunAt: number;
  enabled: boolean;
  runtimeType?: 'codex' | 'claude';
  providerId?: string;
  model?: string;
  permissionMode?: 'manual' | 'plan' | 'acceptEdits' | 'dontAsk';
  sessionId?: string;
  lastRunAt?: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
};

const MAX_MEMORY_BYTES = 512 * 1024;
const MAX_SKILL_FILES = 256;
const MAX_SKILL_BYTES = 8 * 1024 * 1024;
const SENSITIVE = /(?:api[_-]?key|auth[_-]?token|authorization|bearer|password|secret|credential|private[_-]?key|token)/i;

export class WorkspaceCapabilities {
  readonly #userDataPath: string;
  readonly #mcpPath: string;
  readonly #schedulePath: string;
  #mcp: McpServerRecord[] = [];
  #scheduled: ScheduledTask[] = [];

  constructor(userDataPath: string) {
    this.#userDataPath = resolve(userDataPath);
    this.#mcpPath = join(this.#userDataPath, 'mcp-servers-v1.json');
    this.#schedulePath = join(this.#userDataPath, 'scheduled-tasks-v1.json');
    mkdirSync(this.#userDataPath, { recursive: true });
    this.#loadMcp();
    this.#loadScheduled();
  }

  listMcp(projectId?: string): McpServerRecord[] {
    return this.#mcp
      .filter((server) => server.scope !== 'project' || !projectId || server.projectId === projectId)
      .map((server) => ({ ...server, args: [...server.args], envKeys: [...server.envKeys] }));
  }

  saveMcp(input: McpServerInput): McpServerRecord {
    const name = cleanText(input.name, 'MCP Server 名称', 80);
    const scope = input.scope;
    if (!['user', 'project', 'local'].includes(scope)) throw new Error('MCP Scope 无效');
    const transport = input.transport;
    if (!['stdio', 'http', 'sse'].includes(transport)) throw new Error('MCP Transport 无效');
    const projectId = input.projectId ? cleanText(input.projectId, 'Project ID', 160) : undefined;
    if (scope === 'project' && !projectId) throw new Error('Project Scope 必须绑定 Project');
    const args = normalizeList(input.args, 64, 512);
    const envKeys = normalizeList(input.envKeys, 64, 160).filter((key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key));
    const command = input.command ? cleanText(input.command, 'MCP command', 1_000) : undefined;
    const url = input.url ? safeRemoteUrl(input.url) : undefined;
    if (transport === 'stdio' && !command) throw new Error('stdio MCP 必须填写 command');
    if (transport !== 'stdio' && !url) throw new Error('HTTP/SSE MCP 必须填写安全 URL');
    const now = Date.now();
    const existing = input.id ? this.#mcp.find((server) => server.id === input.id) : undefined;
    const record: McpServerRecord = {
      id: existing?.id ?? 'mcp:' + createHash('sha256').update(name + now).digest('hex').slice(0, 16),
      name, scope, ...(projectId ? { projectId } : {}), transport,
      ...(command ? { command } : {}), args, ...(url ? { url } : {}), envKeys,
      enabled: input.enabled !== false,
      createdAt: existing?.createdAt ?? now, updatedAt: now,
      authStatus: envKeys.some((key) => SENSITIVE.test(key)) ? 'configured' : 'unknown',
    };
    if (existing) this.#mcp = this.#mcp.map((item) => item.id === existing.id ? record : item);
    else this.#mcp.push(record);
    this.#persistMcp();
    return { ...record, args: [...record.args], envKeys: [...record.envKeys] };
  }

  deleteMcp(id: string): void {
    const before = this.#mcp.length;
    this.#mcp = this.#mcp.filter((server) => server.id !== id);
    if (this.#mcp.length === before) throw new Error('MCP Server 不存在');
    this.#persistMcp();
  }

  listScheduledTasks(projectId?: string): ScheduledTask[] {
    return this.#scheduled.filter((task) => !projectId || task.projectId === projectId).map((task) => ({ ...task }));
  }

  saveScheduledTask(input: Partial<ScheduledTask> & Pick<ScheduledTask, 'name' | 'projectId' | 'prompt' | 'intervalMinutes'>): ScheduledTask {
    const name = cleanText(input.name, '任务名称', 120);
    const projectId = cleanText(input.projectId, 'Project ID', 160);
    const prompt = cleanText(input.prompt, '任务 Prompt', 64_000);
    const intervalMinutes = Number(input.intervalMinutes);
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < 5 || intervalMinutes > 10_080) throw new Error('定时间隔必须为 5–10080 分钟');
    const now = Date.now();
    const existing = input.id ? this.#scheduled.find((task) => task.id === input.id) : undefined;
    const task: ScheduledTask = {
      id: existing?.id ?? 'schedule:' + createHash('sha256').update(name + projectId + now).digest('hex').slice(0, 16),
      name, projectId, prompt, intervalMinutes,
      nextRunAt: typeof input.nextRunAt === 'number' && input.nextRunAt > now ? input.nextRunAt : now + intervalMinutes * 60_000,
      enabled: input.enabled === true,
      ...(input.runtimeType ? { runtimeType: input.runtimeType } : {}),
      ...(input.providerId ? { providerId: cleanText(input.providerId, 'Provider ID', 160) } : {}),
      ...(input.model ? { model: cleanText(input.model, 'Model', 128) } : {}),
      ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
      ...(existing?.sessionId ? { sessionId: existing.sessionId } : {}),
      ...(existing?.lastRunAt ? { lastRunAt: existing.lastRunAt } : {}),
      ...(existing?.lastError ? { lastError: existing.lastError } : {}),
      createdAt: existing?.createdAt ?? now, updatedAt: now,
    };
    if (existing) this.#scheduled = this.#scheduled.map((item) => item.id === existing.id ? task : item);
    else this.#scheduled.push(task);
    this.#persistScheduled();
    return { ...task };
  }

  setScheduledTaskEnabled(id: string, enabled: boolean): ScheduledTask {
    const task = this.#scheduled.find((item) => item.id === id);
    if (!task) throw new Error('定时任务不存在');
    task.enabled = enabled; task.updatedAt = Date.now();
    if (enabled && task.nextRunAt <= Date.now()) task.nextRunAt = Date.now() + task.intervalMinutes * 60_000;
    this.#persistScheduled();
    return { ...task };
  }

  deleteScheduledTask(id: string): void {
    const before = this.#scheduled.length;
    this.#scheduled = this.#scheduled.filter((task) => task.id !== id);
    if (this.#scheduled.length === before) throw new Error('定时任务不存在');
    this.#persistScheduled();
  }

  updateScheduledTask(id: string, update: Partial<Pick<ScheduledTask, 'sessionId' | 'lastRunAt' | 'nextRunAt'>> & { lastError?: string | undefined }): ScheduledTask {
    const task = this.#scheduled.find((item) => item.id === id);
    if (!task) throw new Error('定时任务不存在');
    Object.assign(task, update, { updatedAt: Date.now() });
    this.#persistScheduled();
    return { ...task };
  }

  syncProjectMcp(projectRoot: string, projectId: string): void {
    const root = resolve(projectRoot);
    const configPath = join(root, '.mcp.json');
    let existing: Record<string, unknown> = {};
    if (existsSync(configPath) && isFile(configPath)) {
      try { const parsed = JSON.parse(boundedRead(configPath, 512 * 1024)); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed as Record<string, unknown>; } catch { throw new Error('项目 .mcp.json 格式无效'); }
    }
    const servers: Record<string, unknown> = {};
    for (const server of this.#mcp.filter((item) => (item.scope === 'project' || item.scope === 'local') && item.projectId === projectId && item.enabled)) {
      servers[server.name] = server.transport === 'stdio'
        ? { type: 'stdio', command: server.command, args: server.args, ...(server.envKeys.length ? { env: Object.fromEntries(server.envKeys.map((key) => [key, '${' + key + '}'])) } : {}) }
        : { type: server.transport, url: server.url };
    }
    writeFileSync(configPath, JSON.stringify({ ...existing, mcpServers: servers }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  }

  listSkills(projectRoot?: string, projectId?: string): SkillRecord[] {
    const roots: Array<{ root: string; scope: SkillRecord['scope']; source: SkillRecord['source'] }> = [
      { root: join(this.#userDataPath, 'skills'), scope: 'user', source: 'imported' },
    ];
    if (projectRoot) {
      roots.push({ root: join(resolve(projectRoot), '.claude', 'skills'), scope: 'project', source: 'local' });
      roots.push({ root: join(resolve(projectRoot), '.codex', 'skills'), scope: 'project', source: 'local' });
    }
    const records: SkillRecord[] = [];
    for (const entry of roots) {
      if (!existsSync(entry.root) || !isDirectory(entry.root)) continue;
      for (const name of safeDirectoryEntries(entry.root)) {
        const path = join(entry.root, name);
        if (!isDirectory(path)) continue;
        const skillFile = resolveSkillFile(path);
        if (!skillFile) continue;
        const content = boundedRead(skillFile, 128 * 1024);
        const frontmatter = parseSkillFrontmatter(content);
        const files = listFiles(path);
        records.push({
          id: 'skill:' + createHash('sha256').update(path).digest('hex').slice(0, 16),
          name: frontmatter.name || name,
          description: frontmatter.description || '本地 Skill', scope: entry.scope,
          ...(projectId ? { projectId } : {}), path, source: entry.source,
          installed: true, safety: entry.source === 'local' ? 'local' : 'unverified',
          files: files.length, updatedAt: statSync(skillFile).mtimeMs,
        });
      }
    }
    return records.sort((left, right) => left.name.localeCompare(right.name));
  }

  skillDetail(id: string, projectRoot?: string, projectId?: string): SkillDetail {
    const record = this.listSkills(projectRoot, projectId).find((item) => item.id === id);
    if (!record) throw new Error('Skill 不存在');
    const skillFile = resolveSkillFile(record.path);
    if (!skillFile) throw new Error('Skill 缺少 SKILL.md 或 README.md');
    return { ...record, content: boundedRead(skillFile, 128 * 1024), filesList: listFiles(record.path) };
  }

  installSkill(projectRoot: string, sourcePath: string, requestedName?: string): SkillRecord {
    const root = resolve(projectRoot);
    const source = resolve(sourcePath);
    if (!isDirectory(source) || !resolveSkillFile(source)) throw new Error('Skill 源目录必须包含 SKILL.md 或 README.md');
    const sourceFile = resolveSkillFile(source);
    const sourceFrontmatter = sourceFile ? parseSkillFrontmatter(boundedRead(sourceFile, 128 * 1024)) : {};
    const name = cleanSkillName(requestedName || sourceFrontmatter.name || basename(source));
    const targetRoot = join(root, '.claude', 'skills');
    const target = join(targetRoot, name);
    mkdirSync(targetRoot, { recursive: true });
    if (resolve(target) !== targetRoot && !resolve(target).startsWith(targetRoot + '\\') && !resolve(target).startsWith(targetRoot + '/')) throw new Error('Skill 目标路径无效');
    const files = listFiles(source);
    const bytes = files.reduce((sum, file) => sum + statSync(join(source, file)).size, 0);
    if (files.length > MAX_SKILL_FILES || bytes > MAX_SKILL_BYTES) throw new Error('Skill 超过大小限制');
    assertNoSymlinks(source);
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    cpSync(source, target, { recursive: true, dereference: false, errorOnExist: true });
    return this.listSkills(root).find((item) => item.path === target) ?? (() => { throw new Error('Skill 安装后无法读取'); })();
  }

  uninstallSkill(projectRoot: string, name: string): void {
    const root = resolve(projectRoot);
    const targetRoot = join(root, '.claude', 'skills');
    const target = join(targetRoot, cleanSkillName(name));
    if (!resolve(target).startsWith(targetRoot + '\\') && !resolve(target).startsWith(targetRoot + '/')) throw new Error('Skill 目标路径无效');
    if (!existsSync(target)) throw new Error('Skill 不存在');
    rmSync(target, { recursive: true, force: true });
  }

  listMemory(projectRoot: string): MemoryFile[] {
    const root = resolve(projectRoot);
    const paths = ['MEMORY.md', '.claude/MEMORY.md', '.codex/MEMORY.md', ...memoryFiles(join(root, '.claude', 'memory'), '.claude/memory'), ...memoryFiles(join(root, '.codex', 'memory'), '.codex/memory')];
    return [...new Set(paths)].map((path) => join(root, path)).filter((path) => existsSync(path) && isFile(path)).map((path) => ({
      path: relative(root, path).replaceAll('\\', '/'), size: statSync(path).size, updatedAt: statSync(path).mtimeMs,
    }));
  }

  readMemory(projectRoot: string, path: string): MemoryFile {
    const target = this.#memoryPath(projectRoot, path);
    if (!existsSync(target)) throw new Error('Memory 文件不存在');
    const content = boundedRead(target, MAX_MEMORY_BYTES);
    return { path: relative(resolve(projectRoot), target).replaceAll('\\', '/'), size: Buffer.byteLength(content), updatedAt: statSync(target).mtimeMs, content };
  }

  saveMemory(projectRoot: string, path: string, content: string): MemoryFile {
    const target = this.#memoryPath(projectRoot, path);
    if (Buffer.byteLength(content, 'utf8') > MAX_MEMORY_BYTES || /\0/.test(content)) throw new Error('Memory 内容超过限制');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, { encoding: 'utf8', mode: 0o600 });
    return this.readMemory(projectRoot, path);
  }

  #memoryPath(projectRoot: string, path: string): string {
    const root = resolve(projectRoot);
    const normalized = path.replaceAll('\\', '/');
    if (!/^(?:MEMORY\.md|\.claude\/MEMORY\.md|\.codex\/MEMORY\.md|\.claude\/memory\/[^/]+\.md|\.codex\/memory\/[^/]+\.md)$/.test(normalized)) throw new Error('Memory 路径不在允许范围');
    const target = resolve(root, normalized);
    if (!target.startsWith(root + '\\') && !target.startsWith(root + '/')) throw new Error('Memory 路径无效');
    return target;
  }

  #loadMcp(): void {
    if (!existsSync(this.#mcpPath)) return;
    try {
      const value = JSON.parse(readFileSync(this.#mcpPath, 'utf8')) as unknown;
      if (Array.isArray(value)) this.#mcp = value.map((item) => normalizeMcp(item)).filter(Boolean) as McpServerRecord[];
    } catch { this.#mcp = []; }
  }

  #persistMcp(): void {
    writeFileSync(this.#mcpPath, JSON.stringify(this.#mcp, null, 2), { encoding: 'utf8', mode: 0o600 });
  }

  #loadScheduled(): void {
    if (!existsSync(this.#schedulePath)) return;
    try {
      const value = JSON.parse(readFileSync(this.#schedulePath, 'utf8')) as unknown;
      if (Array.isArray(value)) this.#scheduled = value.map((item) => normalizeScheduled(item)).filter(Boolean) as ScheduledTask[];
    } catch { this.#scheduled = []; }
  }

  #persistScheduled(): void {
    writeFileSync(this.#schedulePath, JSON.stringify(this.#scheduled, null, 2), { encoding: 'utf8', mode: 0o600 });
  }
}

function normalizeMcp(value: unknown): McpServerRecord | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  try {
    const name = cleanText(item.name, 'MCP Server 名称', 80);
    const scope = item.scope === 'project' || item.scope === 'local' ? item.scope : 'user';
    const transport = item.transport === 'http' || item.transport === 'sse' ? item.transport : 'stdio';
    return { id: cleanText(item.id, 'MCP ID', 160), name, scope, ...(typeof item.projectId === 'string' ? { projectId: item.projectId } : {}), transport,
      ...(typeof item.command === 'string' ? { command: item.command } : {}), args: normalizeList(item.args, 64, 512), ...(typeof item.url === 'string' ? { url: item.url } : {}), envKeys: normalizeList(item.envKeys, 64, 160), enabled: item.enabled !== false,
      createdAt: typeof item.createdAt === 'number' ? item.createdAt : Date.now(), updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : Date.now(), authStatus: item.authStatus === 'configured' || item.authStatus === 'not_configured' ? item.authStatus : 'unknown' };
  } catch { return null; }
}

function normalizeScheduled(value: unknown): ScheduledTask | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  try {
    const name = cleanText(item.name, '任务名称', 120);
    const projectId = cleanText(item.projectId, 'Project ID', 160);
    const prompt = cleanText(item.prompt, '任务 Prompt', 64_000);
    const intervalMinutes = Number(item.intervalMinutes);
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < 5 || intervalMinutes > 10_080) return null;
    const permissionMode = typeof item.permissionMode === 'string' && ['manual', 'plan', 'acceptEdits', 'dontAsk'].includes(item.permissionMode)
      ? item.permissionMode as ScheduledTask['permissionMode'] : undefined;
    return {
      id: cleanText(item.id, '任务 ID', 160), name, projectId, prompt, intervalMinutes,
      nextRunAt: typeof item.nextRunAt === 'number' ? item.nextRunAt : Date.now() + intervalMinutes * 60_000,
      enabled: item.enabled === true,
      ...(item.runtimeType === 'claude' ? { runtimeType: 'claude' } : item.runtimeType === 'codex' ? { runtimeType: 'codex' } : {}),
      ...(typeof item.providerId === 'string' ? { providerId: item.providerId } : {}),
      ...(typeof item.model === 'string' ? { model: item.model } : {}),
      ...(permissionMode ? { permissionMode } : {}),
      ...(typeof item.sessionId === 'string' ? { sessionId: item.sessionId } : {}),
      ...(typeof item.lastRunAt === 'number' ? { lastRunAt: item.lastRunAt } : {}),
      ...(typeof item.lastError === 'string' ? { lastError: item.lastError.slice(0, 2_000) } : {}),
      createdAt: typeof item.createdAt === 'number' ? item.createdAt : Date.now(), updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : Date.now(),
    };
  } catch { return null; }
}

function resolveSkillFile(path: string): string | null {
  for (const name of ['SKILL.md', 'README.md']) {
    const file = join(path, name);
    if (existsSync(file) && isFile(file)) return file;
  }
  return null;
}

function parseSkillFrontmatter(content: string): { name?: string; description?: string } {
  const lines = content.slice(0, 16_000).split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return {};
  const result: { name?: string; description?: string } = {};
  for (const line of lines.slice(1)) {
    if (line.trim() === '---') break;
    const match = line.match(/^\s*(name|description)\s*:\s*(.*?)\s*$/i);
    const key = match?.[1];
    if (key) result[key.toLowerCase() as 'name' | 'description'] = (match?.[2] ?? '').replace(/^['"]|['"]$/g, '').slice(0, 500);
  }
  return result;
}

function memoryFiles(root: string, prefix: string): string[] {
  if (!existsSync(root) || !isDirectory(root)) return [];
  return safeDirectoryEntries(root).filter((name) => extname(name).toLowerCase() === '.md').map((name) => prefix + '/' + name);
}

function assertNoSymlinks(root: string): void {
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('Skill 不允许包含符号链接');
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
    }
  };
  visit(root);
}

function listFiles(root: string): string[] {
  const result: string[] = [];
  const visit = (directory: string, prefix = '') => {
    if (result.length >= MAX_SKILL_FILES) return;
    for (const name of safeDirectoryEntries(directory)) {
      const path = join(directory, name);
      const relativePath = prefix ? prefix + '/' + name : name;
      if (isDirectory(path)) visit(path, relativePath);
      else if (isFile(path)) result.push(relativePath);
    }
  };
  visit(root);
  return result;
}

function safeDirectoryEntries(root: string): string[] {
  try { return readdirSync(root, { withFileTypes: true }).filter((entry) => !entry.isSymbolicLink()).map((entry) => entry.name); } catch { return []; }
}

function isDirectory(path: string): boolean { try { return lstatSync(path).isDirectory(); } catch { return false; } }
function isFile(path: string): boolean { try { return lstatSync(path).isFile(); } catch { return false; } }
function boundedRead(path: string, maxBytes: number): string { const value = readFileSync(path); if (value.byteLength > maxBytes) throw new Error('文件超过读取限制'); return value.toString('utf8'); }
function cleanText(value: unknown, label: string, max: number): string { if (typeof value !== 'string') throw new Error(label + '无效'); const text = value.trim(); if (!text || text.length > max || /[\0\r\n]/.test(text)) throw new Error(label + '无效'); return text; }
function cleanSkillName(value: string): string { const name = cleanText(value, 'Skill 名称', 80); if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name === '.' || name === '..') throw new Error('Skill 名称无效'); return name; }
function normalizeList(value: unknown, maxItems: number, maxLength: number): string[] { return Array.isArray(value) ? value.slice(0, maxItems).map((item) => cleanText(String(item), '列表项', maxLength)) : []; }
function safeRemoteUrl(value: string): string { const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('MCP URL 必须是无认证的 HTTP/HTTPS 地址'); return url.toString(); }
