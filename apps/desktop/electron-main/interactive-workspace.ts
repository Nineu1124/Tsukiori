import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { WindowsCredentialBroker } from '@tsukiori/credential-broker';
import {
  CodexAppServerClient,
  discoverCodexLaunch,
  type CodexApproval,
  type CodexLaunch,
} from './codex-app-server-client.js';
import {
  ClaudeCodeClient,
  discoverClaudeLaunch,
  type ClaudeLaunch,
} from './claude-code-client.js';
import {
  ProviderRegistry,
  type ProviderConfig,
  type ProviderInput,
  type ProviderKind,
} from './provider-registry.js';

type RuntimeType = 'codex' | 'claude';
type PermissionMode = 'manual' | 'plan' | 'acceptEdits' | 'dontAsk';

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
  runtimeType: RuntimeType;
  providerId: string;
  model: string;
  environment: 'windows-native';
  permissionMode: PermissionMode;
  worktreePath: string;
  branch: string;
  threadId?: string;
  turnCount: number;
  status: 'starting' | 'ready' | 'running' | 'waiting_permission' | 'error' | 'stopped';
  lastError?: string;
  createdAt: number;
  updatedAt: number;
  pinned?: boolean;
  archivedAt?: number;
};

type TeamRunState = {
  id: string;
  projectId: string;
  name: string;
  goal: string;
  memberSessionIds: string[];
  status: 'dispatching' | 'running' | 'completed' | 'partial_failure';
  createdAt: number;
  updatedAt: number;
};

type WorkspaceSettings = {
  language: 'zh-CN' | 'en-US';
  theme: 'light' | 'system';
  density: 'comfortable' | 'compact';
  reduceMotion: boolean;
  autoUpdate: boolean;
  startMinimized: boolean;
  defaultProjectDirectory: string;
  defaultRuntime: RuntimeType;
  defaultProviderId: string;
  defaultModel: string;
  defaultPermissionMode: PermissionMode;
  persistConversation: boolean;
  confirmHighRisk: boolean;
};

type PersistedState = {
  schemaVersion: 3;
  projects: ProjectState[];
  sessions: SessionState[];
  settings: WorkspaceSettings;
  providers: ProviderConfig[];
  teams: TeamRunState[];
};

type RuntimeState = {
  id: string;
  type: RuntimeType | 'opencode' | 'acp';
  name: string;
  available: boolean;
  version: string;
  source: string;
  authenticated: boolean;
  authSource: string;
  supportLevel: 'supported' | 'degraded' | 'unknown' | 'unsupported';
  error?: string;
  capabilities: string[];
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
  discoverClaude?: () => ClaudeLaunch;
  createClient?: (options: ConstructorParameters<typeof CodexAppServerClient>[0]) => CodexAppServerClient;
  createClaudeClient?: (launch: ClaudeLaunch) => ClaudeCodeClient;
  credentials?: WindowsCredentialBroker;
};

const defaultSettings: WorkspaceSettings = {
  language: 'zh-CN', theme: 'light', density: 'comfortable', reduceMotion: false,
  autoUpdate: true, startMinimized: false, defaultProjectDirectory: '',
  defaultRuntime: 'codex', defaultProviderId: 'provider:chatgpt', defaultModel: 'auto',
  defaultPermissionMode: 'manual',
  persistConversation: true, confirmHighRisk: true,
};

export class InteractiveWorkspace {
  readonly #statePath: string;
  readonly #worktreeRoot: string;
  readonly #transcriptRoot: string;
  readonly #emitExternal: (event: WorkspaceEvent) => void;
  readonly #discoverCodex: () => CodexLaunch;
  readonly #discoverClaude: () => ClaudeLaunch;
  readonly #createClient: InteractiveWorkspaceOptions['createClient'];
  readonly #createClaudeClient: InteractiveWorkspaceOptions['createClaudeClient'];
  readonly #providers: ProviderRegistry;
  #state: PersistedState = {
    schemaVersion: 3, projects: [], sessions: [], settings: { ...defaultSettings }, providers: [], teams: [],
  };
  #runtimes: RuntimeState[] = [];
  #codexLaunch: CodexLaunch | null = null;
  #claudeLaunch: ClaudeLaunch | null = null;
  #claudeClient: ClaudeCodeClient | null = null;
  #clients = new Map<string, CodexAppServerClient>();
  #activeTurns = new Map<string, string>();
  #events = new Map<string, WorkspaceEvent[]>();
  #eventLog: WorkspaceEvent[] = [];
  #eventSequence = 0;
  #approvals = new Map<string, ApprovalResolver>();

  constructor(options: InteractiveWorkspaceOptions) {
    this.#statePath = join(options.userDataPath, 'workspace-state-v3.json');
    this.#worktreeRoot = join(options.userDataPath, 'worktrees');
    this.#transcriptRoot = join(options.userDataPath, 'transcripts');
    this.#emitExternal = options.emit;
    this.#discoverCodex = options.discoverCodex ?? discoverCodexLaunch;
    this.#discoverClaude = options.discoverClaude ?? discoverClaudeLaunch;
    this.#createClient = options.createClient;
    this.#createClaudeClient = options.createClaudeClient;
    mkdirSync(options.userDataPath, { recursive: true });
    mkdirSync(this.#worktreeRoot, { recursive: true });
    mkdirSync(this.#transcriptRoot, { recursive: true });
    this.#load(options.userDataPath);
    this.#providers = new ProviderRegistry({
      providers: this.#state.providers,
      ...(options.credentials ? { credentials: options.credentials } : {}),
      persist: (providers) => { this.#state.providers = providers; this.#save(); },
    });
    this.#state.providers = this.#providers.raw();
    this.#loadTranscripts();
    this.refreshRuntimes();
    this.#save();
  }

  snapshot(): Record<string, unknown> {
    return {
      mode: 'interactive',
      projects: this.#state.projects,
      sessions: this.#state.sessions,
      teams: this.#state.teams,
      runtimes: this.#runtimes,
      providers: this.#providers.list(),
      settings: this.#state.settings,
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
      usage: this.#usage(),
    };
  }

  pollEvents(afterSequence: number): { cursor: number; events: WorkspaceEvent[] } {
    const safe = Number.isInteger(afterSequence) && afterSequence >= 0 ? afterSequence : 0;
    return { cursor: this.#eventSequence, events: this.#eventLog.filter((event) => event.sequence > safe) };
  }

  publishLocalEvent(sessionId: string, type: string, payload: Record<string, unknown>): void {
    this.#session(sessionId);
    this.#emit({ sessionId, type, payload });
  }

  refreshRuntimes(): RuntimeState[] {
    const states: RuntimeState[] = [];
    try {
      this.#codexLaunch = this.#discoverCodex();
      states.push({
        id: 'runtime:codex', type: 'codex', name: 'Codex', available: true,
        version: this.#codexLaunch.version, source: this.#codexLaunch.source,
        authenticated: false, authSource: 'Provider / ChatGPT', supportLevel: 'supported',
        capabilities: ['app-server', 'Thread/Turn', 'Approval', 'MCP', 'Skills'],
      });
    } catch (error) {
      this.#codexLaunch = null;
      states.push(unavailableRuntime('codex', 'Codex', message(error)));
    }
    try {
      this.#claudeLaunch = this.#discoverClaude();
      this.#claudeClient = this.#createClaudeClient
        ? this.#createClaudeClient(this.#claudeLaunch)
        : new ClaudeCodeClient(this.#claudeLaunch);
      states.push({
        id: 'runtime:claude', type: 'claude', name: 'Claude Code', available: true,
        version: this.#claudeLaunch.version, source: this.#claudeLaunch.source,
        authenticated: false, authSource: 'Provider API', supportLevel: 'degraded',
        capabilities: ['stream-json', 'Session Resume', 'Tools', 'Plan/Accept Edits'],
      });
    } catch (error) {
      this.#claudeLaunch = null;
      this.#claudeClient = null;
      states.push(unavailableRuntime('claude', 'Claude Code', message(error)));
    }
    states.push({
      id: 'runtime:opencode', type: 'opencode', name: 'OpenCode', available: false,
      version: '1.18.4 verified', source: 'adapter-not-connected', authenticated: false,
      authSource: 'unknown', supportLevel: 'unknown',
      error: '协议能力已验证，但当前交互产品尚未接通', capabilities: [],
    });
    states.push({
      id: 'runtime:acp', type: 'acp', name: 'Generic ACP', available: false,
      version: '—', source: 'not-installed', authenticated: false,
      authSource: 'unknown', supportLevel: 'unknown',
      error: '等待 Generic ACP Adapter', capabilities: [],
    });
    this.#runtimes = states;
    return states;
  }

  updateSettings(input: Partial<WorkspaceSettings>): WorkspaceSettings {
    const current = this.#state.settings;
    const next: WorkspaceSettings = {
      language: input.language === 'en-US' ? 'en-US' : input.language === 'zh-CN' ? 'zh-CN' : current.language,
      theme: input.theme === 'system' ? 'system' : input.theme === 'light' ? 'light' : current.theme,
      density: input.density === 'compact' ? 'compact' : input.density === 'comfortable' ? 'comfortable' : current.density,
      reduceMotion: typeof input.reduceMotion === 'boolean' ? input.reduceMotion : current.reduceMotion,
      autoUpdate: typeof input.autoUpdate === 'boolean' ? input.autoUpdate : current.autoUpdate,
      startMinimized: typeof input.startMinimized === 'boolean' ? input.startMinimized : current.startMinimized,
      defaultProjectDirectory: safeSettingText(input.defaultProjectDirectory, current.defaultProjectDirectory, 1_024),
      defaultRuntime: input.defaultRuntime === 'claude' ? 'claude' : input.defaultRuntime === 'codex' ? 'codex' : current.defaultRuntime,
      defaultProviderId: safeSettingText(input.defaultProviderId, current.defaultProviderId, 128),
      defaultModel: safeSettingText(input.defaultModel, current.defaultModel, 128),
      defaultPermissionMode: permissionMode(input.defaultPermissionMode ?? current.defaultPermissionMode),
      persistConversation: typeof input.persistConversation === 'boolean' ? input.persistConversation : current.persistConversation,
      confirmHighRisk: typeof input.confirmHighRisk === 'boolean' ? input.confirmHighRisk : current.confirmHighRisk,
    };
    if (!this.#providers.list().some((provider) => provider.id === next.defaultProviderId)) {
      next.defaultProviderId = 'provider:chatgpt';
    }
    this.#state.settings = next;
    this.#save();
    return next;
  }

  saveProvider(input: ProviderInput): unknown {
    return this.#providers.save(input);
  }

  deleteProvider(id: string): void {
    if (this.#state.sessions.some((session) => session.providerId === id)) {
      throw new Error('Provider 已被 Session 使用，不能删除');
    }
    this.#providers.delete(id);
  }

  testProvider(id: string): Promise<{ ok: boolean; latencyMs: number; category: string }> {
    return this.#providers.test(id);
  }

  exportSanitizedSettings(): string {
    return JSON.stringify({
      schemaVersion: 1, exportedAt: new Date().toISOString(), settings: this.#state.settings,
      providers: this.#providers.list().map(({ hasSecret: _hasSecret, lastTest: _lastTest, ...provider }) => provider),
    }, null, 2);
  }

  addProject(rootPath: string): ProjectState {
    const canonical = realpathSync.native(resolve(rootPath));
    const gitRoot = this.#git(canonical, ['rev-parse', '--show-toplevel']).trim();
    const canonicalGitRoot = realpathSync.native(gitRoot);
    const duplicate = this.#state.projects.find((project) => project.gitRoot.toLowerCase() === canonicalGitRoot.toLowerCase());
    if (duplicate) return duplicate;
    const branch = this.#git(canonicalGitRoot, ['branch', '--show-current']).trim() || 'detached';
    const id = 'project:' + createHash('sha256').update(canonicalGitRoot.toLowerCase()).digest('hex').slice(0, 20);
    const project = { id, name: basename(canonicalGitRoot), rootPath: canonical, gitRoot: canonicalGitRoot, branch };
    this.#state.projects.push(project);
    this.#save();
    this.#emit({ type: 'project.added', payload: { projectId: id, name: project.name } });
    return project;
  }

  removeProject(projectId: string): void {
    const hasSessions = this.#state.sessions.some((session) => session.projectId === projectId);
    if (hasSessions) throw new Error('项目仍有 Session 历史；为避免遗失 Worktree 绑定，当前不能移除');
    const index = this.#state.projects.findIndex((project) => project.id === projectId);
    if (index < 0) throw new Error('Project 不存在');
    this.#state.projects.splice(index, 1);
    this.#save();
    this.#emit({ type: 'project.removed', payload: { projectId } });
  }

  githubStatus(projectId: string): Record<string, unknown> {
    const project = this.#project(projectId);
    let userName = '未配置';
    try { userName = this.#git(project.gitRoot, ['config', '--get', 'user.name']).trim() || '未配置'; } catch { userName = '未配置'; }
    let remote = '';
    try { remote = this.#git(project.gitRoot, ['remote', 'get-url', 'origin']).trim(); } catch { remote = ''; }
    let remoteHost = 'none'; let repository = 'none';
    if (remote) {
      const normalized = remote.replace(/^git@([^:]+):/, 'ssh://$1/');
      try {
        const url = new URL(normalized);
        remoteHost = url.hostname;
        repository = basename(url.pathname).replace(/\.git$/i, '');
      } catch { remoteHost = 'local-or-custom'; repository = basename(remote).replace(/\.git$/i, ''); }
    }
    const gh = spawnSync('gh.exe', ['auth', 'status'], {
      encoding: 'utf8', windowsHide: true, shell: false, timeout: 10_000,
      stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 128 * 1024,
    });
    return { userName, branch: project.branch, remoteHost, repository, ghAuthenticated: gh.status === 0 };
  }

  renameSession(sessionId: string, name: string): SessionState {
    const session = this.#session(sessionId);
    const clean = safeSettingText(name, session.name, 80);
    if (!clean) throw new Error('Session 名称不能为空');
    session.name = clean;
    session.updatedAt = Date.now();
    this.#save();
    this.#emit({ sessionId, type: 'session.renamed', payload: { name: clean } });
    return session;
  }

  pinSession(sessionId: string, pinned: boolean): SessionState {
    const session = this.#session(sessionId);
    session.pinned = pinned;
    session.updatedAt = Date.now();
    this.#save();
    this.#emit({ sessionId, type: 'session.pinned', payload: { pinned } });
    return session;
  }

  archiveSession(sessionId: string): SessionState {
    const session = this.#session(sessionId);
    if (session.status === 'running' || session.status === 'waiting_permission') throw new Error('运行中的 Session 不能归档');
    session.archivedAt = Date.now();
    session.updatedAt = session.archivedAt;
    session.status = 'stopped';
    this.#save();
    this.#emit({ sessionId, type: 'session.archived', payload: { worktreeRetained: true } });
    return session;
  }

  sessionWorktree(sessionId: string): string {
    return this.#session(sessionId).worktreePath;
  }

  listFiles(sessionId: string, query = ''): Array<{ path: string; size: number; modifiedAt: number }> {
    const session = this.#session(sessionId);
    const needle = query.trim().toLowerCase();
    const files: Array<{ path: string; size: number; modifiedAt: number }> = [];
    const visit = (directory: string): void => {
      if (files.length >= 2_000) return;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.turbo') continue;
        const absolute = join(directory, entry.name);
        if (entry.isDirectory()) visit(absolute);
        else if (entry.isFile()) {
          const path = relative(session.worktreePath, absolute).replaceAll('\\', '/');
          if (needle && !path.toLowerCase().includes(needle)) continue;
          const stat = statSync(absolute);
          files.push({ path, size: stat.size, modifiedAt: stat.mtimeMs });
        }
        if (files.length >= 2_000) break;
      }
    };
    visit(session.worktreePath);
    return files.sort((a, b) => a.path.localeCompare(b.path)).slice(0, 2_000);
  }

  readTextFile(sessionId: string, path: string): { path: string; content: string; bytes: number; truncated: boolean } {
    const session = this.#session(sessionId);
    const absolute = resolveInside(session.worktreePath, path);
    const stat = statSync(absolute);
    if (!stat.isFile()) throw new Error('所选路径不是文件');
    const maximum = 512 * 1024;
    const data = readFileSync(absolute);
    if (looksBinary(data.subarray(0, Math.min(data.length, 8_192)))) throw new Error('二进制文件不能在文本预览中打开');
    return {
      path: safeRelativePath(path),
      content: data.subarray(0, maximum).toString('utf8'),
      bytes: data.length,
      truncated: data.length > maximum,
    };
  }

  attachFiles(sessionId: string, sources: readonly string[]): Array<{ path: string; bytes: number; kind: string }> {
    const session = this.#session(sessionId);
    if (sources.length < 1 || sources.length > 10) throw new Error('一次最多添加 10 个附件');
    const destination = join(session.worktreePath, '.tsukiori', 'attachments');
    mkdirSync(destination, { recursive: true });
    const attached = sources.map((source, index) => {
      const canonical = realpathSync.native(resolve(source));
      const stat = statSync(canonical);
      if (!stat.isFile() || stat.size > 10 * 1024 * 1024) throw new Error('附件必须是小于 10 MB 的文件');
      const extension = extname(canonical).slice(0, 16);
      const stem = basename(canonical, extname(canonical)).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60) || 'attachment';
      const name = `${Date.now()}-${index + 1}-${stem}${extension}`;
      const target = join(destination, name);
      copyFileSync(canonical, target);
      return { path: relative(session.worktreePath, target).replaceAll('\\', '/'), bytes: stat.size, kind: attachmentKind(extension) };
    });
    this.#emit({ sessionId, type: 'attachment.added', payload: { files: attached } });
    return attached;
  }

  async codexNativeCapabilities(sessionId: string): Promise<Record<string, unknown>> {
    const session = this.#session(sessionId);
    if (session.runtimeType !== 'codex') throw new Error('原生 Skills/MCP 仅适用于 Codex Session');
    const client = await this.#ensureCodexClient(sessionId);
    const [skillsRaw, mcpRaw] = await Promise.all([
      client.request('skills/list', { cwds: [session.worktreePath], forceReload: false }),
      client.request('mcpServerStatus/list', { detail: 'toolsAndAuthOnly' }),
    ]);
    const skillsGroups = Array.isArray(object(skillsRaw).data) ? object(skillsRaw).data as unknown[] : [];
    const skills = skillsGroups.flatMap((group) => Array.isArray(object(group).skills) ? object(group).skills as unknown[] : [])
      .slice(0, 200).map((skill) => ({
        name: safeSettingText(object(skill).name, 'Unnamed skill', 120),
        description: safeSettingText(object(skill).description, '', 500),
        enabled: object(skill).enabled !== false,
        scope: safeSettingText(object(skill).scope, 'unknown', 40),
      }));
    const servers = (Array.isArray(object(mcpRaw).data) ? object(mcpRaw).data as unknown[] : []).slice(0, 100).map((server) => ({
      name: safeSettingText(object(server).name, 'Unnamed MCP', 120),
      authStatus: safeSettingText(object(server).authStatus, 'unknown', 80),
      toolCount: Object.keys(object(object(server).tools)).length,
      resourceCount: Array.isArray(object(server).resources) ? (object(server).resources as unknown[]).length : 0,
    }));
    return { supportLevel: 'supported', skills, servers, refreshedAt: Date.now() };
  }

  async createTeam(projectId: string, goal: string, agents: ReadonlyArray<Record<string, unknown>>): Promise<TeamRunState> {
    const cleanGoal = safeSettingText(goal, '', 8_000);
    if (!cleanGoal) throw new Error('团队目标不能为空');
    if (agents.length < 2 || agents.length > 4) throw new Error('Agent Team 需要 2–4 个成员');
    const team: TeamRunState = {
      id: 'team:' + randomUUID(), projectId, name: cleanGoal.slice(0, 48), goal: cleanGoal,
      memberSessionIds: [], status: 'dispatching', createdAt: Date.now(), updatedAt: Date.now(),
    };
    this.#state.teams.push(team);
    this.#save();
    try {
      for (const [index, agent] of agents.entries()) {
        const runtimeType = agent.runtimeType === 'claude' ? 'claude' : 'codex';
        const role = safeSettingText(agent.role, `Agent ${index + 1}`, 80);
        const session = await this.createSession(projectId, {
          runtimeType,
          ...(typeof agent.providerId === 'string' ? { providerId: agent.providerId } : {}),
          ...(typeof agent.model === 'string' ? { model: agent.model } : {}),
          permissionMode: runtimeType === 'claude' ? 'plan' : 'manual',
        });
        this.renameSession(session.id, role);
        team.memberSessionIds.push(session.id);
      }
      team.status = 'running'; team.updatedAt = Date.now(); this.#save();
      this.#emit({ type: 'team.started', payload: { teamId: team.id, projectId, memberCount: team.memberSessionIds.length } });
      await Promise.all(team.memberSessionIds.map((sessionId, index) => this.sendPrompt(
        sessionId,
        `你是本地 Agent Team 的成员“${safeSettingText(agents[index]?.role, `Agent ${index + 1}`, 80)}”。\n团队目标：${cleanGoal}\n请独立完成你负责的部分，明确输出结论、风险和可交付结果；不要假设其他成员已经完成工作。`,
      )));
      return team;
    } catch (error) {
      team.status = 'partial_failure'; team.updatedAt = Date.now(); this.#save();
      throw error;
    }
  }

  async createSession(projectId: string, selection?: Partial<Pick<SessionState, 'runtimeType' | 'providerId' | 'model' | 'permissionMode'>>): Promise<SessionState> {
    const project = this.#project(projectId);
    const runtimeType = selection?.runtimeType ?? this.#state.settings.defaultRuntime;
    const providerId = selection?.providerId ?? compatibleDefaultProvider(runtimeType, this.#state.settings.defaultProviderId);
    const provider = this.#providers.get(providerId);
    assertProviderCompatibility(runtimeType, provider.kind);
    const runtime = this.#runtimes.find((item) => item.type === runtimeType);
    if (!runtime?.available) throw new Error(runtime?.error ?? `${runtimeType} Runtime 不可用`);
    if (provider.kind !== 'chatgpt' && !provider.secretRef) throw new Error('所选 Provider 尚未保存 API Key');
    const model = safeModel(selection?.model ?? provider.models[0] ?? 'auto');
    const selectedPermission = permissionMode(selection?.permissionMode ?? defaultPermission(runtimeType));
    const token = randomUUID();
    const branch = 'tsukiori/session-' + token.slice(0, 8);
    const worktreePath = join(this.#worktreeRoot, project.id.replace(':', '-'), token.slice(0, 12));
    mkdirSync(dirname(worktreePath), { recursive: true });
    this.#git(project.gitRoot, ['worktree', 'add', '-b', branch, worktreePath, 'HEAD']);
    const runtimeCount = this.#state.sessions.filter((item) => item.runtimeType === runtimeType).length + 1;
    const session: SessionState = {
      id: 'session:' + token, projectId,
      name: (runtimeType === 'codex' ? 'Codex ' : 'Claude ') + runtimeCount,
      runtimeType, providerId, model, environment: 'windows-native', permissionMode: selectedPermission,
      worktreePath, branch, ...(runtimeType === 'claude' ? { threadId: randomUUID() } : {}),
      turnCount: 0, status: 'ready', createdAt: Date.now(), updatedAt: Date.now(),
    };
    this.#state.sessions.push(session);
    this.#save();
    this.#emit({ sessionId: session.id, type: 'session.created', payload: {
      name: session.name, projectId, worktreePath, branch, runtimeType, providerId, model,
    } });
    this.#emit({ sessionId: session.id, type: 'session.ready', payload: { branch, worktreePath } });
    return session;
  }

  async updateSessionOptions(sessionId: string, input: { providerId?: string; model?: string; permissionMode?: string }): Promise<SessionState> {
    const session = this.#session(sessionId);
    if (session.turnCount > 0 || session.status === 'running') throw new Error('Session 首次 Turn 后 Runtime 参数已锁定');
    const provider = this.#providers.get(input.providerId ?? session.providerId);
    assertProviderCompatibility(session.runtimeType, provider.kind);
    if (provider.kind !== 'chatgpt' && !provider.secretRef) throw new Error('所选 Provider 尚未保存 API Key');
    session.providerId = provider.id;
    session.model = safeModel(input.model ?? provider.models[0] ?? session.model);
    session.permissionMode = permissionMode(input.permissionMode ?? session.permissionMode);
    session.updatedAt = Date.now();
    this.#save();
    return session;
  }

  async sendPrompt(sessionId: string, text: string): Promise<{ turnId: string }> {
    const prompt = text.trim();
    if (!prompt || prompt.length > 64_000) throw new Error('Prompt 必须为 1–64000 个字符');
    const session = this.#session(sessionId);
    session.status = 'running';
    session.updatedAt = Date.now();
    delete session.lastError;
    this.#emit({ sessionId, type: 'user.message', payload: { text: prompt } });
    if (session.runtimeType === 'codex') {
      const client = await this.#ensureCodexClient(sessionId);
      if (!session.threadId) session.threadId = await client.startThread(session.worktreePath);
      const turnId = await client.startTurn(session.threadId, prompt);
      this.#activeTurns.set(sessionId, turnId);
      session.turnCount += 1;
      this.#save();
      return { turnId };
    }
    const claude = this.#claudeClient;
    if (!claude || !session.threadId) throw new Error('Claude Code Runtime 不可用');
    const provider = this.#providers.get(session.providerId);
    const turnId = this.#providers.withEnvironment(provider.id, (environment) => claude.startTurn({
      cwd: session.worktreePath, sessionId: session.threadId as string, resume: session.turnCount > 0,
      prompt, model: session.model,
      permissionMode: claudePermission(session.permissionMode), environment,
      onEvent: (type, payload) => this.#runtimeEvent(sessionId, type, payload),
      onExit: (error) => {
        if (!error) return;
        session.status = 'error'; session.lastError = error;
        this.#emit({ sessionId, type: 'runtime.error', payload: { message: error } });
        this.#save();
      },
    }));
    this.#activeTurns.set(sessionId, turnId);
    session.turnCount += 1;
    this.#save();
    return { turnId };
  }

  async interrupt(sessionId: string): Promise<void> {
    const session = this.#session(sessionId);
    const turnId = this.#activeTurns.get(sessionId);
    if (!turnId) throw new Error('当前没有可中断的 Turn');
    if (session.runtimeType === 'claude') this.#claudeClient?.interrupt(turnId);
    else {
      const client = this.#clients.get(sessionId);
      if (!client || !session.threadId) throw new Error('当前 Codex Turn 不可中断');
      await client.interrupt(session.threadId, turnId);
    }
    this.#emit({ sessionId, type: 'turn.interrupt_requested', payload: { turnId } });
  }

  decidePermission(permissionId: string, decision: 'allow_once' | 'deny_once' | 'cancel_turn'): void {
    const pending = this.#approvals.get(permissionId);
    if (!pending) throw new Error('权限请求已失效');
    this.#approvals.delete(permissionId);
    const allow = decision === 'allow_once';
    if (pending.approval.method === 'item/permissions/requestApproval') {
      const requested = object(pending.approval.params.permissions);
      pending.resolve({ permissions: allow ? (Object.keys(requested).length > 0 ? requested : { fileSystem: null, network: null }) : { fileSystem: null, network: null }, scope: 'turn' });
    } else pending.resolve({ decision: allow ? 'accept' : decision === 'cancel_turn' ? 'cancel' : 'decline' });
    const session = this.#session(pending.sessionId);
    session.status = 'running';
    this.#save();
    this.#emit({ sessionId: pending.sessionId, type: 'permission.resolved', payload: { permissionId, decision } });
  }

  gitStatus(sessionId: string): Record<string, unknown> {
    const session = this.#session(sessionId);
    const output = this.#git(session.worktreePath, ['status', '--porcelain=v1', '--untracked-files=all']);
    const files = output.split(/\r?\n/).filter(Boolean).map((line) => ({ status: line.slice(0, 2), path: line.slice(3).replace(/^"|"$/g, '') }));
    const diff = this.#git(session.worktreePath, ['diff', '--no-ext-diff', '--stat']);
    return { sessionId, branch: session.branch, worktreePath: session.worktreePath, files, diff };
  }

  gitDiff(sessionId: string, path?: string): string {
    const session = this.#session(sessionId);
    const args = ['diff', '--no-ext-diff'];
    if (path) args.push('--', safeRelativePath(path));
    return truncate(this.#git(session.worktreePath, args), 128_000);
  }

  stage(sessionId: string, paths: readonly string[]): void { this.#gitMutation(sessionId, 'add', paths); }

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
    if (!cleanSubject || cleanSubject.length > 200 || /[\r\n\0]/.test(cleanSubject)) throw new Error('Commit Subject 必须为单行且不超过 200 字符');
    this.#git(session.worktreePath, ['commit', '-m', cleanSubject]);
    const sha = this.#git(session.worktreePath, ['rev-parse', 'HEAD']).trim();
    this.#emit({ sessionId, type: 'git.committed', payload: { sha, subject: cleanSubject } });
    return sha;
  }

  async shutdown(): Promise<void> {
    for (const pending of this.#approvals.values()) pending.reject(new Error('Tsukiori 正在退出'));
    this.#approvals.clear();
    await Promise.allSettled([
      ...[...this.#clients.values()].map((client) => client.stop()),
      this.#claudeClient?.stop() ?? Promise.resolve(),
    ]);
    this.#clients.clear();
  }

  async #ensureCodexClient(sessionId: string): Promise<CodexAppServerClient> {
    const existing = this.#clients.get(sessionId);
    if (existing) return existing;
    if (!this.#codexLaunch) throw new Error('Codex Runtime 不可用');
    const session = this.#session(sessionId);
    const provider = this.#providers.get(session.providerId);
    return await this.#providers.withEnvironment(provider.id, async (environment) => {
      const options: ConstructorParameters<typeof CodexAppServerClient>[0] = {
        cwd: session.worktreePath, launch: this.#codexLaunch as CodexLaunch,
        environment, configArgs: codexConfigArgs(provider),
        ...(session.model !== 'auto' ? { model: session.model } : {}),
        onNotification: (method, params) => this.#notification(sessionId, method, params),
        onApproval: (approval) => this.#approval(sessionId, approval),
        onExit: (error) => {
          this.#clients.delete(sessionId);
          if (!error) return;
          session.status = 'error'; session.lastError = error; this.#save();
          this.#emit({ sessionId, type: 'runtime.error', payload: { message: error } });
        },
      };
      const client = this.#createClient ? this.#createClient(options) : new CodexAppServerClient(options);
      this.#clients.set(sessionId, client);
      try {
        const auth = await client.start();
        const runtime = this.#runtimes.find((item) => item.type === 'codex');
        if (runtime) { runtime.authenticated = auth.authenticated || Boolean(provider.secretRef); runtime.authSource = provider.kind === 'chatgpt' ? auth.authSource : 'api-key'; }
        return client;
      } catch (error) {
        this.#clients.delete(sessionId);
        await client.stop().catch(() => undefined);
        throw error;
      }
    });
  }

  #notification(sessionId: string, method: string, params: Record<string, unknown>): void {
    if (method === 'item/agentMessage/delta') {
      this.#emit({ sessionId, type: 'assistant.delta', payload: { text: truncate(String(params.delta ?? ''), 32_000) } });
      return;
    }
    if (method === 'turn/started') {
      const turnId = String(object(params.turn).id ?? params.turnId ?? '');
      this.#runtimeEvent(sessionId, 'turn.started', { turnId });
    } else if (method === 'turn/completed') {
      const turn = object(params.turn);
      this.#runtimeEvent(sessionId, 'turn.completed', { status: String(turn.status ?? 'completed'), error: truncate(String(object(turn.error).message ?? ''), 2_000) });
    } else if (method === 'item/started' || method === 'item/completed') {
      const item = object(params.item);
      const itemType = String(item.type ?? 'tool');
      if (!['agentMessage', 'userMessage'].includes(itemType)) this.#emit({ sessionId, type: 'tool.event', payload: {
        phase: method.endsWith('started') ? 'started' : 'completed', tool: itemType,
        summary: truncate(String(item.command ?? item.path ?? item.name ?? itemType), 2_000),
      } });
    } else if (method === 'error') this.#emit({ sessionId, type: 'runtime.error', payload: { message: truncate(String(params.message ?? 'Codex Runtime error'), 2_000) } });
    this.#save();
  }

  #runtimeEvent(sessionId: string, type: string, payload: Record<string, unknown>): void {
    const session = this.#session(sessionId);
    if (type === 'turn.started') {
      session.status = 'running';
      const turnId = String(payload.turnId ?? '');
      if (turnId) this.#activeTurns.set(sessionId, turnId);
    } else if (type === 'turn.completed') {
      session.status = payload.status === 'failed' ? 'error' : 'ready';
      session.updatedAt = Date.now();
      this.#activeTurns.delete(sessionId);
      this.#emit({ sessionId, type: 'git.changed', payload: { action: 'refresh' } });
      for (const team of this.#state.teams.filter((item) => item.memberSessionIds.includes(sessionId))) {
        const members = team.memberSessionIds.map((id) => this.#state.sessions.find((item) => item.id === id));
        if (members.every((member) => member && !['running', 'waiting_permission', 'starting'].includes(member.status))) {
          team.status = members.some((member) => member?.status === 'error') ? 'partial_failure' : 'completed';
          team.updatedAt = Date.now();
          this.#emit({ type: 'team.completed', payload: { teamId: team.id, status: team.status } });
        }
      }
    }
    this.#emit({ sessionId, type, payload });
    this.#save();
  }

  #approval(sessionId: string, approval: CodexApproval): Promise<unknown> {
    const permissionId = 'permission:' + randomUUID();
    const session = this.#session(sessionId);
    session.status = 'waiting_permission'; this.#save();
    return new Promise((resolveApproval, rejectApproval) => {
      this.#approvals.set(permissionId, { sessionId, approval, resolve: resolveApproval, reject: rejectApproval });
      this.#emit({ sessionId, type: 'permission.requested', payload: {
        permissionId, connectionEpoch: 'interactive-codex', title: approvalTitle(approval.method),
        description: approvalDescription(approval.method), category: approvalCategory(approval.method, approval.params),
        scope: approvalScope(approval.params),
      } });
    });
  }

  #emit(input: Omit<WorkspaceEvent, 'id' | 'sequence' | 'createdAt'>): void {
    this.#eventSequence += 1;
    const event: WorkspaceEvent = { id: randomUUID(), sequence: this.#eventSequence, createdAt: Date.now(), ...input };
    this.#eventLog.push(event);
    if (this.#eventLog.length > 1_000) this.#eventLog.splice(0, this.#eventLog.length - 1_000);
    if (event.sessionId) {
      const events = this.#events.get(event.sessionId) ?? [];
      events.push(event);
      if (events.length > 500) events.splice(0, events.length - 500);
      this.#events.set(event.sessionId, events);
    }
    this.#persistTranscript(event);
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

  #gitMutation(sessionId: string, action: 'add', paths: readonly string[]): void {
    const session = this.#session(sessionId);
    const safe = paths.map(safeRelativePath);
    if (safe.length === 0) throw new Error('请选择文件');
    this.#git(session.worktreePath, [action, '--', ...safe]);
    this.#emit({ sessionId, type: 'git.changed', payload: { action: 'stage' } });
  }

  #git(cwd: string, args: readonly string[]): string {
    const result = spawnSync('git.exe', ['-C', cwd, ...args], {
      encoding: 'utf8', windowsHide: true, shell: false, timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.status !== 0 || result.error) throw new Error(truncate((result.stderr ?? '').trim() || 'Git 操作失败', 2_000));
    return result.stdout ?? '';
  }

  #load(userDataPath: string): void {
    const version2Path = join(userDataPath, 'workspace-state-v2.json');
    const version1Path = join(userDataPath, 'workspace-state-v1.json');
    const source = existsSync(this.#statePath) ? this.#statePath : existsSync(version2Path) ? version2Path : version1Path;
    if (!existsSync(source)) return;
    try {
      const value = JSON.parse(readFileSync(source, 'utf8')) as Record<string, unknown>;
      const projects = Array.isArray(value.projects) ? value.projects as ProjectState[] : [];
      const sessions = Array.isArray(value.sessions) ? value.sessions.map((raw) => migrateSession(object(raw))) : [];
      const settings = Number(value.schemaVersion) >= 2 ? { ...defaultSettings, ...object(value.settings) } as WorkspaceSettings : { ...defaultSettings };
      const providers = Number(value.schemaVersion) >= 2 && Array.isArray(value.providers) ? value.providers as ProviderConfig[] : [];
      const teams = Number(value.schemaVersion) >= 3 && Array.isArray(value.teams) ? value.teams as TeamRunState[] : [];
      this.#state = { schemaVersion: 3, projects, sessions, settings, providers, teams };
    } catch {
      this.#state = { schemaVersion: 3, projects: [], sessions: [], settings: { ...defaultSettings }, providers: [], teams: [] };
    }
  }

  #save(): void {
    const safe: PersistedState = {
      schemaVersion: 3, projects: this.#state.projects,
      sessions: this.#state.sessions.map(({ lastError, ...session }) => ({ ...session, ...(lastError ? { lastError: truncate(lastError, 2_000) } : {}) })),
      settings: this.#state.settings,
      providers: this.#state.providers,
      teams: this.#state.teams,
    };
    writeFileSync(this.#statePath, JSON.stringify(safe, null, 2), { encoding: 'utf8', mode: 0o600 });
  }

  #loadTranscripts(): void {
    for (const session of this.#state.sessions) {
      const path = join(this.#transcriptRoot, safeTranscriptName(session.id));
      if (!existsSync(path) || statSync(path).size > 8 * 1024 * 1024) continue;
      const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).slice(-1_000);
      const events: WorkspaceEvent[] = [];
      for (const line of lines) {
        try {
          const raw = JSON.parse(line) as Record<string, unknown>;
          if (raw.sessionId !== session.id || typeof raw.type !== 'string' || !transcriptEvent(raw.type)) continue;
          const event: WorkspaceEvent = {
            id: typeof raw.id === 'string' ? raw.id : randomUUID(),
            sequence: ++this.#eventSequence,
            sessionId: session.id,
            type: raw.type,
            createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : session.createdAt,
            payload: object(raw.payload),
          };
          events.push(event); this.#eventLog.push(event);
        } catch { /* Invalid local transcript rows are ignored. */ }
      }
      if (events.length) this.#events.set(session.id, events);
    }
  }

  #persistTranscript(event: WorkspaceEvent): void {
    if (!this.#state.settings.persistConversation || !event.sessionId || !transcriptEvent(event.type)) return;
    const path = join(this.#transcriptRoot, safeTranscriptName(event.sessionId));
    if (existsSync(path) && statSync(path).size >= 5 * 1024 * 1024) return;
    appendFileSync(path, JSON.stringify({
      id: event.id, sessionId: event.sessionId, type: event.type,
      createdAt: event.createdAt, payload: event.payload,
    }) + '\n', { encoding: 'utf8', mode: 0o600 });
  }

  #usage(): Record<string, unknown> {
    const byRuntime: Record<string, number> = {};
    for (const session of this.#state.sessions) byRuntime[session.runtimeType] = (byRuntime[session.runtimeType] ?? 0) + session.turnCount;
    return { sessionCount: this.#state.sessions.length, turnCount: this.#state.sessions.reduce((sum, item) => sum + item.turnCount, 0), byRuntime };
  }
}

function migrateSession(value: Record<string, unknown>): SessionState {
  const runtimeType: RuntimeType = value.runtimeType === 'claude' ? 'claude' : 'codex';
  return {
    id: String(value.id), projectId: String(value.projectId), name: String(value.name), runtimeType,
    providerId: typeof value.providerId === 'string' ? value.providerId : 'provider:chatgpt',
    model: typeof value.model === 'string' ? value.model : 'auto', environment: 'windows-native',
    permissionMode: permissionMode(typeof value.permissionMode === 'string' ? value.permissionMode : defaultPermission(runtimeType)),
    worktreePath: String(value.worktreePath), branch: String(value.branch),
    ...(typeof value.threadId === 'string' ? { threadId: value.threadId } : {}),
    turnCount: typeof value.turnCount === 'number' ? value.turnCount : 0,
    status: value.status === 'running' || value.status === 'waiting_permission' ? 'ready' : String(value.status ?? 'ready') as SessionState['status'],
    ...(typeof value.lastError === 'string' ? { lastError: value.lastError } : {}),
    createdAt: typeof value.createdAt === 'number' ? value.createdAt : Date.now(),
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : typeof value.createdAt === 'number' ? value.createdAt : Date.now(),
    ...(value.pinned === true ? { pinned: true } : {}),
    ...(typeof value.archivedAt === 'number' ? { archivedAt: value.archivedAt } : {}),
  };
}

function assertProviderCompatibility(runtime: RuntimeType, kind: ProviderKind): void {
  const allowed = runtime === 'codex'
    ? ['chatgpt', 'openai', 'openai-compatible']
    : ['anthropic', 'deepseek', 'anthropic-compatible'];
  if (!allowed.includes(kind)) throw new Error(`${runtime === 'codex' ? 'Codex' : 'Claude Code'} 不支持 ${kind} Provider`);
}

function compatibleDefaultProvider(runtime: RuntimeType, preferred: string): string {
  if (runtime === 'codex') return preferred.startsWith('provider:') ? preferred : 'provider:chatgpt';
  return ['provider:anthropic', 'provider:deepseek'].includes(preferred) ? preferred : 'provider:anthropic';
}

function codexConfigArgs(provider: ProviderConfig): string[] {
  if (provider.kind !== 'openai-compatible') return [];
  const definition = `{ name = ${toml(provider.name)}, base_url = ${toml(provider.baseUrl)}, env_key = "OPENAI_API_KEY", wire_api = "responses" }`;
  return ['-c', 'model_provider="tsukiori"', '-c', `model_providers.tsukiori=${definition}`];
}

function toml(value: string): string { return JSON.stringify(value); }

function unavailableRuntime(type: RuntimeType, name: string, error: string): RuntimeState {
  return { id: 'runtime:' + type, type, name, available: false, version: '—', source: 'unknown', authenticated: false, authSource: 'unknown', supportLevel: 'unsupported', error, capabilities: [] };
}

function defaultPermission(runtime: RuntimeType): PermissionMode { return runtime === 'claude' ? 'plan' : 'manual'; }

function permissionMode(value: string): PermissionMode {
  if (['manual', 'plan', 'acceptEdits', 'dontAsk'].includes(value)) return value as PermissionMode;
  throw new Error('Permission Mode 无效');
}

function claudePermission(value: PermissionMode): 'plan' | 'acceptEdits' | 'dontAsk' {
  return value === 'acceptEdits' || value === 'dontAsk' ? value : 'plan';
}

function safeModel(value: string): string {
  const model = String(value ?? '').trim();
  if (!model || model.length > 128 || /[\r\n\0]/.test(model)) throw new Error('Model 无效');
  return model;
}

function safeSettingText(value: unknown, fallback: string, max: number): string {
  if (typeof value !== 'string') return fallback;
  const text = value.trim();
  if (text.length > max || /[\0]/.test(text)) throw new Error('设置值无效');
  return text;
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
  if (typeof command === 'string') return truncate(command, 1_000);
  if (Array.isArray(command)) return truncate(command.map(String).join(' '), 1_000);
  const cwd = typeof params.cwd === 'string' ? params.cwd : '';
  const reason = typeof params.reason === 'string' ? params.reason : '';
  return truncate([cwd, reason].filter(Boolean).join(' · ') || '当前 Turn', 1_000);
}

function safeRelativePath(value: string): string {
  const normalized = value.replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.split('/').includes('..') || normalized.includes('\0')) throw new Error('文件路径必须位于 Session Worktree 内');
  return normalized;
}

function resolveInside(root: string, value: string): string {
  const safe = safeRelativePath(value);
  const absolute = resolve(root, safe);
  const canonicalRoot = realpathSync.native(root);
  const canonical = realpathSync.native(absolute);
  const prefix = canonicalRoot.endsWith(sep) ? canonicalRoot : canonicalRoot + sep;
  if (canonical !== canonicalRoot && !canonical.toLowerCase().startsWith(prefix.toLowerCase())) throw new Error('文件路径越出 Session Worktree');
  return canonical;
}

function looksBinary(value: Buffer): boolean {
  if (value.includes(0)) return true;
  let controls = 0;
  for (const byte of value) if (byte < 9 || (byte > 13 && byte < 32)) controls += 1;
  return value.length > 0 && controls / value.length > 0.08;
}

function attachmentKind(extension: string): string {
  return ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(extension.toLowerCase()) ? 'image' : 'file';
}

function transcriptEvent(type: string): boolean {
  return ['user.message', 'assistant.delta', 'tool.event', 'turn.completed', 'runtime.error', 'attachment.added'].includes(type);
}

function safeTranscriptName(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex') + '.jsonl';
}

function truncate(value: string, max: number): string { return value.length <= max ? value : value.slice(0, max) + '\n…[truncated]'; }
function message(error: unknown): string { return truncate(error instanceof Error ? error.message : String(error), 2_000); }
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
