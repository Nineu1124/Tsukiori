import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  CodexAppServerClient,
  discoverCodexLaunch,
  type CodexApproval,
  type CodexLaunch,
} from './codex-app-server-client.js';

type ProjectState = {
  id: string;
  name: string;
  rootPath: string;
  gitRoot: string;
  branch: string;
};

type SessionState = {
  id: string;
  projectId: string;
  name: string;
  runtimeType: 'codex';
  worktreePath: string;
  branch: string;
  threadId?: string;
  status: 'starting' | 'ready' | 'running' | 'waiting_permission' | 'error' | 'stopped';
  lastError?: string;
  createdAt: number;
};

type PersistedState = {
  schemaVersion: 1;
  projects: ProjectState[];
  sessions: SessionState[];
};

type RuntimeState = {
  type: 'codex';
  available: boolean;
  version: string;
  source: string;
  authenticated: boolean;
  authSource: string;
  error?: string;
};

export type WorkspaceEvent = {
  id: string;
  sequence: number;
  sessionId?: string;
  type: string;
  createdAt: number;
  payload: Record<string, unknown>;
};

type ApprovalResolver = {
  sessionId: string;
  approval: CodexApproval;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export type InteractiveWorkspaceOptions = {
  userDataPath: string;
  emit: (event: WorkspaceEvent) => void;
  discoverCodex?: () => CodexLaunch;
  createClient?: (options: ConstructorParameters<typeof CodexAppServerClient>[0]) => CodexAppServerClient;
};

export class InteractiveWorkspace {
  readonly #statePath: string;
  readonly #worktreeRoot: string;
  readonly #emitExternal: (event: WorkspaceEvent) => void;
  readonly #discoverCodex: () => CodexLaunch;
  readonly #createClient: InteractiveWorkspaceOptions['createClient'];
  #state: PersistedState = { schemaVersion: 1, projects: [], sessions: [] };
  #runtime: RuntimeState = {
    type: 'codex', available: false, version: '—', source: 'unknown',
    authenticated: false, authSource: 'unknown',
  };
  #launch: CodexLaunch | null = null;
  #clients = new Map<string, CodexAppServerClient>();
  #activeTurns = new Map<string, string>();
  #events = new Map<string, WorkspaceEvent[]>();
  #eventLog: WorkspaceEvent[] = [];
  #eventSequence = 0;
  #approvals = new Map<string, ApprovalResolver>();

  constructor(options: InteractiveWorkspaceOptions) {
    this.#statePath = join(options.userDataPath, 'workspace-state-v1.json');
    this.#worktreeRoot = join(options.userDataPath, 'worktrees');
    this.#emitExternal = options.emit;
    this.#discoverCodex = options.discoverCodex ?? discoverCodexLaunch;
    this.#createClient = options.createClient;
    mkdirSync(options.userDataPath, { recursive: true });
    mkdirSync(this.#worktreeRoot, { recursive: true });
    this.#load();
    this.refreshRuntimes();
  }

  snapshot(): Record<string, unknown> {
    return {
      mode: 'interactive',
      projects: this.#state.projects,
      sessions: this.#state.sessions,
      runtimes: [this.#runtime],
      permissions: [...this.#approvals.entries()].map(([id, pending]) => ({
        id, sessionId: pending.sessionId, connectionEpoch: 'interactive-codex',
        title: approvalTitle(pending.approval.method),
        description: approvalDescription(pending.approval.method),
        category: approvalCategory(pending.approval.method, pending.approval.params),
        risk: 'high', enforcementLevel: 'interceptable',
        scope: approvalScope(pending.approval.params),
      })),
      attention: [], tools: [], workflow: null, v1Git: null, diagnostics: null,
      recentEvents: [...this.#events.values()].flat().sort((a, b) => a.createdAt - b.createdAt).slice(-300),
      eventCursor: this.#eventSequence,
    };
  }

  pollEvents(afterSequence: number): { cursor: number; events: WorkspaceEvent[] } {
    const safe = Number.isInteger(afterSequence) && afterSequence >= 0 ? afterSequence : 0;
    return {
      cursor: this.#eventSequence,
      events: this.#eventLog.filter((event) => event.sequence > safe),
    };
  }

  refreshRuntimes(): RuntimeState {
    try {
      this.#launch = this.#discoverCodex();
      this.#runtime = {
        type: 'codex', available: true, version: this.#launch.version,
        source: this.#launch.source, authenticated: this.#runtime.authenticated,
        authSource: this.#runtime.authSource,
      };
    } catch (error) {
      this.#launch = null;
      this.#runtime = {
        type: 'codex', available: false, version: '—', source: 'unknown',
        authenticated: false, authSource: 'unknown', error: message(error),
      };
    }
    return this.#runtime;
  }

  addProject(rootPath: string): ProjectState {
    const canonical = realpathSync.native(resolve(rootPath));
    const gitRoot = this.#git(canonical, ['rev-parse', '--show-toplevel']).trim();
    const canonicalGitRoot = realpathSync.native(gitRoot);
    const duplicate = this.#state.projects.find(
      (project) => project.gitRoot.toLowerCase() === canonicalGitRoot.toLowerCase(),
    );
    if (duplicate) return duplicate;
    const branch = this.#git(canonicalGitRoot, ['branch', '--show-current']).trim() || 'detached';
    const id = 'project:' + createHash('sha256')
      .update(canonicalGitRoot.toLowerCase()).digest('hex').slice(0, 20);
    const project = { id, name: basename(canonicalGitRoot), rootPath: canonical, gitRoot: canonicalGitRoot, branch };
    this.#state.projects.push(project);
    this.#save();
    this.#emit({ type: 'project.added', payload: { projectId: id, name: project.name } });
    return project;
  }

  async createSession(projectId: string): Promise<SessionState> {
    if (!this.#launch) throw new Error(this.#runtime.error ?? 'Codex Runtime 不可用');
    const project = this.#project(projectId);
    const token = randomUUID();
    const branch = 'tsukiori/session-' + token.slice(0, 8);
    const worktreePath = join(this.#worktreeRoot, project.id.replace(':', '-'), token.slice(0, 12));
    mkdirSync(dirname(worktreePath), { recursive: true });
    this.#git(project.gitRoot, ['worktree', 'add', '-b', branch, worktreePath, 'HEAD']);
    const session: SessionState = {
      id: 'session:' + token, projectId, name: 'Codex ' + (this.#state.sessions.length + 1),
      runtimeType: 'codex', worktreePath, branch, status: 'starting', createdAt: Date.now(),
    };
    this.#state.sessions.push(session);
    this.#save();
    this.#emit({ sessionId: session.id, type: 'session.created', payload: {
      name: session.name, projectId, worktreePath, branch,
    } });
    try {
      const client = await this.#ensureClient(session.id);
      session.threadId = await client.startThread(worktreePath);
      session.status = 'ready';
      delete session.lastError;
      this.#save();
      this.#emit({ sessionId: session.id, type: 'session.ready', payload: { branch, worktreePath } });
      return session;
    } catch (error) {
      session.status = 'error';
      session.lastError = message(error);
      this.#save();
      this.#emit({ sessionId: session.id, type: 'runtime.error', payload: { message: session.lastError } });
      throw error;
    }
  }

  async sendPrompt(sessionId: string, text: string): Promise<{ turnId: string }> {
    const prompt = text.trim();
    if (!prompt || prompt.length > 64_000) throw new Error('Prompt 必须为 1–64000 个字符');
    const session = this.#session(sessionId);
    const client = await this.#ensureClient(sessionId);
    if (!session.threadId) session.threadId = await client.startThread(session.worktreePath);
    session.status = 'running';
    delete session.lastError;
    this.#emit({ sessionId, type: 'user.message', payload: { text: prompt } });
    const turnId = await client.startTurn(session.threadId, prompt);
    this.#activeTurns.set(sessionId, turnId);
    this.#save();
    return { turnId };
  }

  async interrupt(sessionId: string): Promise<void> {
    const session = this.#session(sessionId);
    const turnId = this.#activeTurns.get(sessionId);
    const client = this.#clients.get(sessionId);
    if (!client || !session.threadId || !turnId) throw new Error('当前没有可中断的 Turn');
    await client.interrupt(session.threadId, turnId);
    this.#emit({ sessionId, type: 'turn.interrupt_requested', payload: { turnId } });
  }

  decidePermission(permissionId: string, decision: 'allow_once' | 'deny_once' | 'cancel_turn'): void {
    const pending = this.#approvals.get(permissionId);
    if (!pending) throw new Error('权限请求已失效');
    this.#approvals.delete(permissionId);
    const allow = decision === 'allow_once';
    if (pending.approval.method === 'item/permissions/requestApproval') {
      const requested = object(pending.approval.params.permissions);
      pending.resolve({
        permissions: allow
          ? (Object.keys(requested).length > 0 ? requested : { fileSystem: null, network: null })
          : { fileSystem: null, network: null },
        scope: 'turn',
      });
    } else {
      pending.resolve({ decision: allow ? 'accept' : decision === 'cancel_turn' ? 'cancel' : 'decline' });
    }
    const session = this.#session(pending.sessionId);
    session.status = 'running';
    this.#save();
    this.#emit({ sessionId: pending.sessionId, type: 'permission.resolved', payload: { permissionId, decision } });
  }

  gitStatus(sessionId: string): Record<string, unknown> {
    const session = this.#session(sessionId);
    const output = this.#git(session.worktreePath, ['status', '--porcelain=v1', '--untracked-files=all']);
    const files = output.split(/\r?\n/).filter(Boolean).map((line) => ({
      status: line.slice(0, 2), path: line.slice(3).replace(/^"|"$/g, ''),
    }));
    const diff = this.#git(session.worktreePath, ['diff', '--no-ext-diff', '--stat']);
    return { sessionId, branch: session.branch, worktreePath: session.worktreePath, files, diff };
  }

  gitDiff(sessionId: string, path?: string): string {
    const session = this.#session(sessionId);
    const args = ['diff', '--no-ext-diff'];
    if (path) args.push('--', safeRelativePath(path));
    return truncate(this.#git(session.worktreePath, args), 128_000);
  }

  stage(sessionId: string, paths: readonly string[]): void {
    const session = this.#session(sessionId);
    const safe = paths.map(safeRelativePath);
    if (safe.length === 0) throw new Error('请选择文件');
    this.#git(session.worktreePath, ['add', '--', ...safe]);
    this.#emit({ sessionId, type: 'git.changed', payload: { action: 'stage' } });
  }

  unstage(sessionId: string, paths: readonly string[]): void {
    const session = this.#session(sessionId);
    const safe = paths.map(safeRelativePath);
    if (safe.length === 0) throw new Error('请选择文件');
    this.#git(session.worktreePath, ['restore', '--staged', '--', ...safe]);
    this.#emit({ sessionId, type: 'git.changed', payload: { action: 'unstage' } });
  }

  commit(sessionId: string, subject: string): string {
    const session = this.#session(sessionId);
    const cleanSubject = subject.trim();
    if (!cleanSubject || cleanSubject.length > 200 || /[\r\n\0]/.test(cleanSubject)) {
      throw new Error('Commit Subject 必须为单行且不超过 200 字符');
    }
    this.#git(session.worktreePath, ['commit', '-m', cleanSubject]);
    const sha = this.#git(session.worktreePath, ['rev-parse', 'HEAD']).trim();
    this.#emit({ sessionId, type: 'git.committed', payload: { sha, subject: cleanSubject } });
    return sha;
  }

  async shutdown(): Promise<void> {
    for (const pending of this.#approvals.values()) pending.reject(new Error('Tsukiori 正在退出'));
    this.#approvals.clear();
    await Promise.allSettled([...this.#clients.values()].map((client) => client.stop()));
    this.#clients.clear();
  }

  async #ensureClient(sessionId: string): Promise<CodexAppServerClient> {
    const existing = this.#clients.get(sessionId);
    if (existing) return existing;
    if (!this.#launch) throw new Error('Codex Runtime 不可用');
    const session = this.#session(sessionId);
    const options: ConstructorParameters<typeof CodexAppServerClient>[0] = {
      cwd: session.worktreePath,
      launch: this.#launch,
      onNotification: (method, params) => this.#notification(sessionId, method, params),
      onApproval: (approval) => this.#approval(sessionId, approval),
      onExit: (error) => {
        this.#clients.delete(sessionId);
        if (!error) return;
        session.status = 'error';
        session.lastError = error;
        this.#save();
        this.#emit({ sessionId, type: 'runtime.error', payload: { message: error } });
      },
    };
    const client = this.#createClient ? this.#createClient(options) : new CodexAppServerClient(options);
    this.#clients.set(sessionId, client);
    try {
      const auth = await client.start();
      this.#runtime = { ...this.#runtime, authenticated: auth.authenticated, authSource: auth.authSource };
      if (session.threadId) session.threadId = await client.resumeThread(session.threadId);
      return client;
    } catch (error) {
      this.#clients.delete(sessionId);
      await client.stop().catch(() => undefined);
      throw error;
    }
  }

  #notification(sessionId: string, method: string, params: Record<string, unknown>): void {
    const session = this.#session(sessionId);
    if (method === 'item/agentMessage/delta') {
      this.#emit({ sessionId, type: 'assistant.delta', payload: { text: truncate(String(params.delta ?? ''), 32_000) } });
      return;
    }
    if (method === 'turn/started') {
      session.status = 'running';
      const turnId = String(object(params.turn).id ?? params.turnId ?? '');
      if (turnId) this.#activeTurns.set(sessionId, turnId);
      this.#emit({ sessionId, type: 'turn.started', payload: { turnId } });
    } else if (method === 'turn/completed') {
      session.status = 'ready';
      this.#activeTurns.delete(sessionId);
      const turn = object(params.turn);
      this.#emit({ sessionId, type: 'turn.completed', payload: {
        status: String(turn.status ?? 'completed'),
        error: truncate(String(object(turn.error).message ?? ''), 2000),
      } });
      this.#emit({ sessionId, type: 'git.changed', payload: { action: 'refresh' } });
    } else if (method === 'item/started' || method === 'item/completed') {
      const item = object(params.item);
      const itemType = String(item.type ?? 'tool');
      if (itemType !== 'agentMessage') this.#emit({ sessionId, type: 'tool.event', payload: {
        phase: method.endsWith('started') ? 'started' : 'completed',
        tool: itemType,
        summary: truncate(String(item.command ?? item.path ?? item.name ?? itemType), 2000),
      } });
    } else if (method === 'error') {
      this.#emit({ sessionId, type: 'runtime.error', payload: {
        message: truncate(String(params.message ?? 'Codex Runtime error'), 2000),
      } });
    }
    this.#save();
  }

  #approval(sessionId: string, approval: CodexApproval): Promise<unknown> {
    const permissionId = 'permission:' + randomUUID();
    const session = this.#session(sessionId);
    session.status = 'waiting_permission';
    this.#save();
    return new Promise((resolveApproval, rejectApproval) => {
      this.#approvals.set(permissionId, {
        sessionId, approval, resolve: resolveApproval, reject: rejectApproval,
      });
      this.#emit({ sessionId, type: 'permission.requested', payload: {
        permissionId, connectionEpoch: 'interactive-codex',
        title: approvalTitle(approval.method),
        description: approvalDescription(approval.method),
        category: approvalCategory(approval.method, approval.params),
        scope: approvalScope(approval.params),
      } });
    });
  }

  #emit(input: Omit<WorkspaceEvent, 'id' | 'sequence' | 'createdAt'>): void {
    this.#eventSequence += 1;
    const event: WorkspaceEvent = {
      id: randomUUID(), sequence: this.#eventSequence, createdAt: Date.now(), ...input,
    };
    this.#eventLog.push(event);
    if (this.#eventLog.length > 1000) this.#eventLog.splice(0, this.#eventLog.length - 1000);
    if (event.sessionId) {
      const events = this.#events.get(event.sessionId) ?? [];
      events.push(event);
      if (events.length > 500) events.splice(0, events.length - 500);
      this.#events.set(event.sessionId, events);
    }
    this.#emitExternal(event);
  }

  #project(id: string): ProjectState {
    const project = this.#state.projects.find((item) => item.id === id);
    if (!project) throw new Error('Project 不存在');
    return project;
  }

  #session(id: string): SessionState {
    const session = this.#state.sessions.find((item) => item.id === id);
    if (!session) throw new Error('Session 不存在');
    if (!existsSync(session.worktreePath)) throw new Error('Session Worktree 不存在');
    return session;
  }

  #git(cwd: string, args: readonly string[]): string {
    const result = spawnSync('git.exe', ['-C', cwd, ...args], {
      encoding: 'utf8', windowsHide: true, shell: false, timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.status !== 0 || result.error) {
      throw new Error(truncate((result.stderr ?? '').trim() || 'Git 操作失败', 2000));
    }
    return result.stdout ?? '';
  }

  #load(): void {
    if (!existsSync(this.#statePath)) return;
    try {
      const value = JSON.parse(readFileSync(this.#statePath, 'utf8')) as PersistedState;
      if (value.schemaVersion === 1 && Array.isArray(value.projects) && Array.isArray(value.sessions)) {
        this.#state = value;
      }
    } catch {
      this.#state = { schemaVersion: 1, projects: [], sessions: [] };
    }
  }

  #save(): void {
    const safe: PersistedState = {
      schemaVersion: 1,
      projects: this.#state.projects,
      sessions: this.#state.sessions.map(({ lastError, ...session }) => ({
        ...session,
        ...(lastError ? { lastError: truncate(lastError, 2000) } : {}),
      })),
    };
    writeFileSync(this.#statePath, JSON.stringify(safe, null, 2), { encoding: 'utf8', mode: 0o600 });
  }
}

function approvalTitle(method: string): string {
  if (method.includes('commandExecution')) return 'Codex 请求执行命令';
  if (method.includes('fileChange')) return 'Codex 请求修改文件';
  return 'Codex 请求扩展权限';
}

function approvalDescription(method: string): string {
  if (method.includes('commandExecution')) return '命令将在当前 Session 的隔离 Worktree 中执行';
  if (method.includes('fileChange')) return '文件变更将写入当前 Session 的隔离 Worktree';
  return 'Runtime 请求文件系统或网络权限';
}

function approvalCategory(method: string, params: Record<string, unknown>): string {
  if (method.includes('commandExecution')) return params.networkApprovalContext ? 'network' : 'shell';
  if (method.includes('fileChange')) return 'file_write';
  return object(params.permissions).network ? 'network' : 'file_write';
}

function approvalScope(params: Record<string, unknown>): string {
  const command = params.command;
  if (typeof command === 'string') return truncate(command, 1000);
  if (Array.isArray(command)) return truncate(command.map(String).join(' '), 1000);
  const cwd = typeof params.cwd === 'string' ? params.cwd : '';
  const reason = typeof params.reason === 'string' ? params.reason : '';
  return truncate([cwd, reason].filter(Boolean).join(' · ') || '当前 Turn', 1000);
}

function safeRelativePath(value: string): string {
  const normalized = value.replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)
    || normalized.split('/').includes('..') || normalized.includes('\0')) {
    throw new Error('文件路径必须位于 Session Worktree 内');
  }
  return normalized;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max) + '\n…[truncated]';
}

function message(error: unknown): string {
  return truncate(error instanceof Error ? error.message : String(error), 2000);
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
