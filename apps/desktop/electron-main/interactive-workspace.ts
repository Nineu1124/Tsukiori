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
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { WindowsCredentialBroker } from '@tsukiori/credential-broker';
import {
  ClaudeCodeClient,
  discoverClaudeLaunch,
  probeClaudeAuth as probeClaudeNativeAuth,
  type ClaudeAuthStatus,
  type ClaudeLaunch,
} from '@tsukiori/adapter-claude';
import {
  CodexAppServerClient,
  discoverCodexLaunch,
  type CodexApproval,
  type CodexLaunch,
} from './codex-app-server-client.js';
import {
  ProviderRegistry,
  type ProviderConfig,
  type ProviderInput,
  type ProviderKind,
  deepSeekClaudeModel,
} from './provider-registry.js';
import {
  WorkspaceCapabilities,
  type McpServerInput,
  type ScheduledTask,
} from './workspace-capabilities.js';
import {
  CheckpointService,
  type CheckpointPreview,
  type CheckpointRewindResult,
  type ConversationCheckpoint,
} from './checkpoint-service.js';
import {
  CcHahaImporter,
  type CcHahaImportCandidate,
  type CcHahaImportScan,
  type ImportedConversationEvent,
} from './cc-haha-importer.js';

type RuntimeType = 'codex' | 'claude';
type PermissionMode = 'manual' | 'plan' | 'acceptEdits' | 'dontAsk';

type ProjectState = {
  id: string;
  name: string;
  rootPath: string;
  gitRoot: string;
  branch: string;
  pinned?: boolean;
  updatedAt?: number;
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
  forkedFromSessionId?: string;
  forkSourceRuntimeSessionId?: string;
  forkSourceRuntimeMessageId?: string;
  importSource?: 'cc-haha';
  importSourceSessionId?: string;
  importTranscriptHash?: string;
  importedReadOnly?: boolean;
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
  workPanelWidth: number;
  terminalHeight: number;
  terminalShell: 'powershell' | 'pwsh' | 'cmd';
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

type CodexApprovalResolver = {
  kind: 'codex';
  sessionId: string;
  approval: CodexApproval;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type ClaudeApprovalResolver = {
  kind: 'claude';
  sessionId: string;
  turnId: string;
  requestId: string;
  connectionEpoch: string;
  title: string;
  description: string;
  category: string;
  risk: 'medium' | 'high';
  scope: string;
};

type ApprovalResolver = CodexApprovalResolver | ClaudeApprovalResolver;

export type InteractiveWorkspaceOptions = {
  userDataPath: string;
  emit: (event: WorkspaceEvent) => void;
  discoverCodex?: () => CodexLaunch;
  discoverClaude?: () => ClaudeLaunch;
  probeClaudeAuth?: (launch: ClaudeLaunch) => ClaudeAuthStatus;
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
  workPanelWidth: 360, terminalHeight: 220,
  terminalShell: 'powershell',
};

export class InteractiveWorkspace {
  readonly #statePath: string;
  readonly #worktreeRoot: string;
  readonly #transcriptRoot: string;
  readonly #emitExternal: (event: WorkspaceEvent) => void;
  readonly #discoverCodex: () => CodexLaunch;
  readonly #discoverClaude: () => ClaudeLaunch;
  readonly #probeClaudeAuth: (launch: ClaudeLaunch) => ClaudeAuthStatus;
  readonly #createClient: InteractiveWorkspaceOptions['createClient'];
  readonly #createClaudeClient: InteractiveWorkspaceOptions['createClaudeClient'];
  readonly #checkpoints: CheckpointService;
  readonly #ccHahaImporter: CcHahaImporter;
  readonly #providers: ProviderRegistry;
  readonly #capabilities: WorkspaceCapabilities;
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
  #schedulerTimer: NodeJS.Timeout | null = null;

  constructor(options: InteractiveWorkspaceOptions) {
    this.#statePath = join(options.userDataPath, 'workspace-state-v3.json');
    this.#worktreeRoot = join(options.userDataPath, 'worktrees');
    this.#transcriptRoot = join(options.userDataPath, 'transcripts');
    this.#checkpoints = new CheckpointService(options.userDataPath);
    this.#ccHahaImporter = new CcHahaImporter(options.userDataPath);
    this.#emitExternal = options.emit;
    this.#discoverCodex = options.discoverCodex ?? discoverCodexLaunch;
    this.#discoverClaude = options.discoverClaude ?? discoverClaudeLaunch;
    this.#probeClaudeAuth = options.probeClaudeAuth ?? probeClaudeNativeAuth;
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
    this.#capabilities = new WorkspaceCapabilities(options.userDataPath);
    this.#state.providers = this.#providers.raw();
    this.#loadTranscripts();
    this.refreshRuntimes();
    this.#save();
    this.#schedulerTimer = setInterval(() => { void this.#runScheduledTasks(); }, 15_000);
  }

  snapshot(): Record<string, unknown> {
    return {
      mode: 'interactive',
      projects: this.#state.projects,
      sessions: this.#state.sessions,
      teams: this.#state.teams,
      runtimes: this.#runtimes,
      providers: this.#providers.list(),
      mcpServers: this.#capabilities.listMcp(),
      scheduledTasks: this.#capabilities.listScheduledTasks(),
      settings: this.#state.settings,
      permissions: [...this.#approvals.entries()].map(([id, pending]) => pending.kind === 'codex' ? ({
        id, sessionId: pending.sessionId, connectionEpoch: 'interactive-codex',
        title: approvalTitle(pending.approval.method),
        description: approvalDescription(pending.approval.method),
        category: approvalCategory(pending.approval.method, pending.approval.params),
        risk: 'high', enforcementLevel: 'interceptable', scope: approvalScope(pending.approval.params),
      }) : ({
        id, sessionId: pending.sessionId, connectionEpoch: pending.connectionEpoch,
        title: pending.title, description: pending.description, category: pending.category,
        risk: pending.risk, enforcementLevel: 'interceptable', scope: pending.scope,
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
      let auth: ClaudeAuthStatus = { authenticated: false, source: 'unknown', method: 'unknown', provider: 'unknown' };
      try { auth = this.#probeClaudeAuth(this.#claudeLaunch); } catch { /* Discovery remains usable with API Providers. */ }
      this.#claudeClient = this.#createClaudeClient
        ? this.#createClaudeClient(this.#claudeLaunch)
        : new ClaudeCodeClient(this.#claudeLaunch);
      const compatibility = this.#claudeLaunch.compatibility ?? 'supported';
      const available = compatibility === 'supported';
      states.push({
        id: 'runtime:claude', type: 'claude', name: 'Claude Code', available,
        version: this.#claudeLaunch.version, source: this.#claudeLaunch.source,
        authenticated: auth.authenticated, authSource: auth.authenticated ? auth.source : 'Provider API / 未登录',
        supportLevel: available ? 'degraded' : 'unknown',
        ...(!available ? { error: `Claude Code ${this.#claudeLaunch.version} 尚未通过兼容性锁定（${compatibility}）` } : {}),
        capabilities: [...new Set([...(this.#claudeLaunch.capabilities ?? ['stream-json', 'session-resume', 'tools']), 'stdio-permission-broker'])],
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
      workPanelWidth: Number.isFinite(input.workPanelWidth)
        ? Math.max(260, Math.min(720, Math.round(input.workPanelWidth as number)))
        : current.workPanelWidth,
      terminalHeight: Number.isFinite(input.terminalHeight)
        ? Math.max(120, Math.min(560, Math.round(input.terminalHeight as number)))
        : current.terminalHeight,
      terminalShell: input.terminalShell === 'pwsh' || input.terminalShell === 'cmd'
        ? input.terminalShell
        : input.terminalShell === 'powershell' ? 'powershell' : current.terminalShell,
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

  async testProvider(id: string): Promise<{ ok: boolean; latencyMs: number; category: string }> {
    const provider = this.#providers.get(id);
    if (provider.kind !== 'claude-native') return this.#providers.test(id);
    const started = Date.now();
    const auth = this.#claudeLaunch
      ? this.#probeClaudeAuth(this.#claudeLaunch)
      : { authenticated: false };
    const result = {
      ok: auth.authenticated === true,
      latencyMs: Date.now() - started,
      category: auth.authenticated === true ? 'runtime_auth' : 'authentication_required',
    };
    this.#providers.recordTest(id, result);
    this.refreshRuntimes();
    return result;
  }

  listProviderModels(id: string): Promise<{ models: string[]; source: 'remote' | 'configured' }> {
    return this.#providers.listModels(id);
  }

  listMcp(projectId?: string) { return this.#capabilities.listMcp(projectId); }

  saveMcp(input: McpServerInput) {
    const record = this.#capabilities.saveMcp(input);
    if (record.projectId) this.#capabilities.syncProjectMcp(this.#project(record.projectId).gitRoot, record.projectId);
    return record;
  }

  deleteMcp(id: string): void {
    const record = this.#capabilities.listMcp().find((item) => item.id === id);
    this.#capabilities.deleteMcp(id);
    if (record?.projectId) this.#capabilities.syncProjectMcp(this.#project(record.projectId).gitRoot, record.projectId);
  }

  listSkills(projectId: string) {
    const project = this.#project(projectId);
    return this.#capabilities.listSkills(project.gitRoot, project.id);
  }

  skillDetail(projectId: string, id: string) {
    const project = this.#project(projectId);
    return this.#capabilities.skillDetail(id, project.gitRoot, project.id);
  }

  installSkill(projectId: string, sourcePath: string, name?: string) {
    const project = this.#project(projectId);
    return this.#capabilities.installSkill(project.gitRoot, sourcePath, name);
  }

  uninstallSkill(projectId: string, name: string): void {
    const project = this.#project(projectId);
    this.#capabilities.uninstallSkill(project.gitRoot, name);
  }

  listMemory(projectId: string) {
    return this.#capabilities.listMemory(this.#project(projectId).gitRoot);
  }

  readMemory(projectId: string, path: string) {
    return this.#capabilities.readMemory(this.#project(projectId).gitRoot, path);
  }

  saveMemory(projectId: string, path: string, content: string) {
    return this.#capabilities.saveMemory(this.#project(projectId).gitRoot, path, content);
  }

  activity(sessionId?: string): Record<string, unknown> {
    const events = (sessionId ? this.#events.get(sessionId) ?? [] : this.#eventLog).slice(-500);
    const backgroundTasks = this.#state.sessions
      .filter((session) => !session.archivedAt && (!sessionId || session.id === sessionId))
      .filter((session) => ['running', 'waiting_permission', 'starting'].includes(session.status))
      .map((session) => ({ id: 'task:' + session.id, sessionId: session.id, title: session.name, status: session.status, startedAt: session.updatedAt }));
    const runtimeSubagents = projectSubagentActivity(events);
    const teamSubagents = this.#state.teams.flatMap((team) => team.memberSessionIds.map((memberSessionId) => ({
      id: `team:${team.id}:${memberSessionId}`, source: 'team', teamId: team.id,
      sessionId: memberSessionId,
      role: this.#state.sessions.find((session) => session.id === memberSessionId)?.name ?? 'Agent',
      status: team.status, startedAt: team.createdAt, updatedAt: team.updatedAt,
    })));
    return {
      sessionId: sessionId ?? null,
      events: events.map((event) => ({ id: event.id, type: event.type, sessionId: event.sessionId, createdAt: event.createdAt, payload: event.payload })),
      backgroundTasks,
      subagents: [...runtimeSubagents, ...teamSubagents],
    };
  }

  async stopBackgroundTask(taskId: string): Promise<void> {
    const sessionId = taskId.startsWith('task:') ? taskId.slice(5) : taskId;
    if (this.#activeTurns.has(sessionId)) await this.interrupt(sessionId);
    else {
      const session = this.#session(sessionId);
      session.status = 'stopped'; session.updatedAt = Date.now(); this.#save();
    }
    this.#emit({ sessionId, type: 'background.task.stopped', payload: { taskId } });
  }

  listScheduledTasks(projectId?: string): ScheduledTask[] { return this.#capabilities.listScheduledTasks(projectId); }

  saveScheduledTask(input: Partial<ScheduledTask> & Pick<ScheduledTask, 'name' | 'projectId' | 'prompt' | 'intervalMinutes'>): ScheduledTask {
    this.#project(input.projectId);
    return this.#capabilities.saveScheduledTask(input);
  }

  setScheduledTaskEnabled(id: string, enabled: boolean): ScheduledTask { return this.#capabilities.setScheduledTaskEnabled(id, enabled); }

  deleteScheduledTask(id: string): void { this.#capabilities.deleteScheduledTask(id); }

  async runScheduledTask(id: string): Promise<ScheduledTask> {
    const task = this.#capabilities.listScheduledTasks().find((item) => item.id === id);
    if (!task) throw new Error('定时任务不存在');
    const now = Date.now();
    const nextRunAt = now + task.intervalMinutes * 60_000;
    this.#capabilities.updateScheduledTask(id, { lastRunAt: now, nextRunAt, lastError: undefined });
    try {
      let session = task.sessionId ? this.#state.sessions.find((item) => item.id === task.sessionId && !item.archivedAt) : undefined;
      if (!session) {
        session = await this.createSession(task.projectId, {
          ...(task.runtimeType ? { runtimeType: task.runtimeType } : {}),
          ...(task.providerId ? { providerId: task.providerId } : {}),
          ...(task.model ? { model: task.model } : {}),
          ...(task.permissionMode ? { permissionMode: task.permissionMode } : {}),
        });
        this.#capabilities.updateScheduledTask(id, { sessionId: session.id });
      }
      await this.sendPrompt(session.id, task.prompt);
      this.#emit({ sessionId: session.id, type: 'scheduled.task.started', payload: { taskId: id, name: task.name } });
      return this.#capabilities.listScheduledTasks().find((item) => item.id === id) as ScheduledTask;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#capabilities.updateScheduledTask(id, { lastError: truncate(message, 2_000) });
      throw error;
    }
  }

  terminalShell(): WorkspaceSettings['terminalShell'] {
    return this.#state.settings.terminalShell;
  }

  diagnosticSummary(): Record<string, unknown> {
    const eventCounts: Record<string, number> = {};
    for (const event of this.#eventLog) eventCounts[event.type] = (eventCounts[event.type] ?? 0) + 1;
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      platform: 'windows-native-x64',
      projects: this.#state.projects.length,
      sessions: this.#state.sessions.length,
      activeSessions: this.#state.sessions.filter((session) => ['running', 'waiting_permission'].includes(session.status)).length,
      failedSessions: this.#state.sessions.filter((session) => session.status === 'error').length,
      providers: this.#providers.list().map((provider) => ({
        id: provider.id, kind: provider.kind,
        configured: provider.kind === 'chatgpt' || provider.kind === 'claude-native' || provider.hasSecret,
        connected: provider.lastTest?.ok === true, category: provider.lastTest?.category ?? 'not_tested',
      })),
      runtimes: this.#runtimes.map(({ id, type, name, available, version, source, supportLevel, error }) => ({
        id, type, name, available, version, source, supportLevel, ...(error ? { error: truncate(error, 500) } : {}),
      })),
      eventCounts,
      transcriptPersistence: this.#state.settings.persistConversation,
      credentialStore: 'windows_credential_manager',
      mcpServers: this.#capabilities.listMcp().length,
      containsCredentials: false,
      containsPrompts: false,
      containsUserSource: false,
    };
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
    const project = { id, name: basename(canonicalGitRoot), rootPath: canonical, gitRoot: canonicalGitRoot, branch, updatedAt: Date.now() };
    this.#state.projects.push(project);
    this.#save();
    this.#emit({ type: 'project.added', payload: { projectId: id, name: project.name } });
    return project;
  }

  scanCcHahaImport(sourcePath: string): Omit<CcHahaImportScan, 'sessions'> & {
    sessions: Array<Omit<CcHahaImportCandidate, 'sourceFile'>>;
  } {
    const scan = this.#ccHahaImporter.scan(sourcePath);
    return publicCcHahaScan(scan);
  }

  importCcHaha(sourcePath: string, sourceFingerprint: string, candidateIds?: string[]): {
    importedCount: number;
    skippedCount: number;
    sessions: SessionState[];
  } {
    if (!this.#state.settings.persistConversation) {
      throw new Error('导入需要先启用“保存本地会话记录”，否则无法保证历史可恢复');
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(sourceFingerprint)) throw new Error('cc-haha Dry Run 指纹无效');
    const requested = new Set((candidateIds ?? []).map((id) => String(id)));
    if (requested.size > 50 || [...requested].some((id) => !/^[a-f0-9]{24}$/.test(id))) {
      throw new Error('单批最多导入 50 个有效 cc-haha Session');
    }
    const scan = this.#ccHahaImporter.scan(sourcePath);
    if (scan.sourceFingerprint !== sourceFingerprint) throw new Error('cc-haha 源目录在 Dry Run 后发生变化，请重新扫描');
    const eligible = scan.sessions.filter((candidate) => (
      candidate.importable && !candidate.alreadyImported && (requested.size === 0 || requested.has(candidate.candidateId))
    ));
    if (eligible.length > 50) throw new Error('单批最多导入 50 个 cc-haha Session');
    const missing = [...requested].filter((id) => !scan.sessions.some((candidate) => candidate.candidateId === id));
    if (missing.length) throw new Error('所选 cc-haha Session 已不存在，请重新扫描');
    if (!eligible.length) return {
      importedCount: 0,
      skippedCount: scan.sessions.filter((candidate) => candidate.alreadyImported).length,
      sessions: [],
    };

    const converted = eligible.map((candidate) => ({ candidate, conversion: this.#ccHahaImporter.convert(candidate) }));
    const originalProjectIds = new Set(this.#state.projects.map((project) => project.id));
    const createdProjects = new Set<string>();
    const createdSessions: SessionState[] = [];
    try {
      for (const { candidate, conversion } of converted) {
        if (!candidate.projectRoot) throw new Error('导入候选缺少已验证 Git 根目录');
        const project = this.addProject(candidate.projectRoot);
        if (!originalProjectIds.has(project.id)) createdProjects.add(project.id);
        const token = randomUUID();
        const branch = 'tsukiori/import-' + token.slice(0, 8);
        const worktreePath = join(this.#worktreeRoot, project.id.replace(':', '-'), token.slice(0, 12));
        mkdirSync(dirname(worktreePath), { recursive: true });
        this.#git(project.gitRoot, ['worktree', 'add', '-b', branch, worktreePath, 'HEAD']);
        const session: SessionState = {
          id: 'session:' + token,
          projectId: project.id,
          name: uniqueImportedName(candidate.title, this.#state.sessions),
          runtimeType: 'claude',
          providerId: 'provider:claude-native',
          model: safeModel(candidate.model || 'sonnet'),
          environment: 'windows-native',
          permissionMode: 'manual',
          worktreePath,
          branch,
          threadId: candidate.sourceSessionId,
          importSource: 'cc-haha',
          importSourceSessionId: candidate.sourceSessionId,
          importTranscriptHash: candidate.transcriptHash,
          importedReadOnly: true,
          turnCount: conversion.turnCount,
          status: 'ready',
          createdAt: candidate.createdAt,
          updatedAt: candidate.updatedAt,
        };
        this.#state.sessions.push(session);
        createdSessions.push(session);
        this.#save();
        this.#emit({ sessionId: session.id, type: 'session.created', payload: {
          name: session.name, projectId: project.id, worktreePath, branch,
          runtimeType: session.runtimeType, providerId: session.providerId, model: session.model,
          importedFrom: 'cc-haha', importedReadOnly: true,
        } });
        for (const event of conversion.events) this.#emitImportedEvent(session.id, event);
        this.#emit({ sessionId: session.id, type: 'session.imported', payload: {
          importedFrom: 'cc-haha', importedReadOnly: true, truncated: conversion.truncated,
          sourceSessionId: candidate.sourceSessionId,
        } });
      }
      this.#ccHahaImporter.recordImport(sourceFingerprint, converted.map(({ candidate }, index) => ({
        transcriptHash: candidate.transcriptHash,
        sourceSessionId: candidate.sourceSessionId,
        targetSessionId: createdSessions[index]!.id,
        projectId: createdSessions[index]!.projectId,
      })));
      this.#save();
      return {
        importedCount: createdSessions.length,
        skippedCount: scan.sessions.filter((candidate) => candidate.alreadyImported).length,
        sessions: createdSessions,
      };
    } catch (error) {
      const createdIds = new Set(createdSessions.map((session) => session.id));
      this.#state.sessions = this.#state.sessions.filter((session) => !createdIds.has(session.id));
      this.#eventLog = this.#eventLog.filter((event) => !event.sessionId || !createdIds.has(event.sessionId));
      for (const session of [...createdSessions].reverse()) {
        this.#events.delete(session.id);
        rmSync(this.#transcriptPath(session.id), { force: true });
        try {
          if (existsSync(session.worktreePath)) this.#git(this.#project(session.projectId).gitRoot, ['worktree', 'remove', '--force', session.worktreePath]);
        } catch { /* Best-effort cleanup remains scoped to the generated Worktree. */ }
        try { this.#git(this.#project(session.projectId).gitRoot, ['branch', '-D', session.branch]); }
        catch { /* A failed worktree add may not have created the branch. */ }
      }
      this.#state.projects = this.#state.projects.filter((project) => (
        !createdProjects.has(project.id) || this.#state.sessions.some((session) => session.projectId === project.id)
      ));
      this.#save();
      throw error;
    }
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

  pinProject(projectId: string, pinned: boolean): ProjectState {
    const project = this.#project(projectId);
    project.pinned = pinned;
    project.updatedAt = Date.now();
    this.#save();
    this.#emit({ type: 'project.pinned', payload: { projectId, pinned } });
    return project;
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

  searchSessions(projectId: string, query: string): Array<{ sessionId: string; matchType: 'metadata' | 'transcript'; snippet: string }> {
    this.#project(projectId);
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return [];
    if (needle.length > 200 || /[\0]/.test(needle)) throw new Error('Session 搜索词无效');
    const results: Array<{ sessionId: string; matchType: 'metadata' | 'transcript'; snippet: string }> = [];
    for (const session of this.#state.sessions.filter((item) => item.projectId === projectId && !item.archivedAt)) {
      const metadata = `${session.name}\n${session.branch}\n${session.runtimeType}\n${session.model}`;
      if (metadata.toLocaleLowerCase().includes(needle)) {
        results.push({ sessionId: session.id, matchType: 'metadata', snippet: truncate(session.name, 180) });
        continue;
      }
      const matchingEvent = [...(this.#events.get(session.id) ?? [])].reverse().find((event) => (
        searchableEventText(event).toLocaleLowerCase().includes(needle)
      ));
      if (matchingEvent) results.push({
        sessionId: session.id,
        matchType: 'transcript',
        snippet: searchSnippet(searchableEventText(matchingEvent), needle, 180),
      });
      if (results.length >= 50) break;
    }
    return results;
  }

  async forkSession(sessionId: string): Promise<SessionState> {
    const source = this.#session(sessionId);
    if (source.runtimeType !== 'claude' || !source.threadId || source.turnCount < 1) {
      throw new Error('当前仅支持 Fork 已运行过的 Claude Session');
    }
    if (source.status === 'running' || source.status === 'waiting_permission' || source.status === 'starting') {
      throw new Error('运行中的 Session 不能 Fork');
    }
    if (this.#git(source.worktreePath, ['status', '--porcelain=v1', '--untracked-files=all']).trim()) {
      throw new Error('Fork 前请先提交或清理当前 Worktree 变更，避免会话历史与代码状态分叉');
    }
    const project = this.#project(source.projectId);
    const token = randomUUID();
    const branch = 'tsukiori/session-' + token.slice(0, 8);
    const worktreePath = join(this.#worktreeRoot, project.id.replace(':', '-'), token.slice(0, 12));
    const baseCommit = this.#git(source.worktreePath, ['rev-parse', 'HEAD']).trim();
    mkdirSync(dirname(worktreePath), { recursive: true });
    this.#git(project.gitRoot, ['worktree', 'add', '-b', branch, worktreePath, baseCommit]);
    const session: SessionState = {
      id: 'session:' + token, projectId: source.projectId,
      name: uniqueForkName(source.name, this.#state.sessions),
      runtimeType: 'claude', providerId: source.providerId, model: source.model,
      environment: 'windows-native', permissionMode: source.permissionMode,
      worktreePath, branch, threadId: randomUUID(),
      forkedFromSessionId: source.id, forkSourceRuntimeSessionId: source.threadId,
      turnCount: 0, status: 'ready', createdAt: Date.now(), updatedAt: Date.now(),
    };
    this.#state.sessions.push(session);
    this.#save();
    this.#emit({ sessionId: session.id, type: 'session.created', payload: {
      name: session.name, projectId: session.projectId, worktreePath, branch,
      runtimeType: session.runtimeType, providerId: session.providerId, model: session.model,
    } });
    for (const event of this.#events.get(source.id) ?? []) {
      if (!transcriptEvent(event.type)) continue;
      this.#emit({ sessionId: session.id, type: event.type, payload: { ...event.payload, forkedFromEventId: event.id } });
    }
    this.#emit({ sessionId: session.id, type: 'session.forked', payload: {
      sourceSessionId: source.id, sourceBranch: source.branch, baseCommit,
    } });
    return session;
  }

  sessionWorktree(sessionId: string): string {
    return this.#session(sessionId).worktreePath;
  }

  writableSessionWorktree(sessionId: string): string {
    const session = this.#session(sessionId);
    this.#assertSessionWritable(session);
    return session.worktreePath;
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
    this.#assertSessionWritable(session);
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
    return {
      supportLevel: 'supported', skills, servers,
      mcpInventoryComplete: typeof object(mcpRaw).nextCursor !== 'string',
      refreshedAt: Date.now(),
    };
  }

  async extensionHealth(sessionId: string): Promise<Record<string, unknown>> {
    const session = this.#session(sessionId);
    const project = this.#project(session.projectId);
    const configuredMcp = this.#capabilities.listMcp(project.id);
    const configuredSkills = this.#capabilities.listSkills(session.worktreePath, project.id);
    let native: Record<string, unknown> = {};
    let runtimeError = '';
    if (session.runtimeType === 'codex') {
      try { native = await this.codexNativeCapabilities(sessionId); }
      catch (error) { runtimeError = truncate(error instanceof Error ? error.message : String(error), 500); }
    }
    const nativeServers = Array.isArray(native.servers) ? native.servers.map(object) : [];
    const nativeSkills = Array.isArray(native.skills) ? native.skills.map(object) : [];
    const mcpComplete = native.mcpInventoryComplete === true;
    const serverByName = new Map(nativeServers.map((item) => [normalizedCapabilityName(item.name), item]));
    const skillByName = new Map(nativeSkills.map((item) => [normalizedCapabilityName(item.name), item]));
    const mcp: Record<string, unknown>[] = configuredMcp.map((record) => {
      const observed = serverByName.get(normalizedCapabilityName(record.name));
      if (observed) serverByName.delete(normalizedCapabilityName(record.name));
      const presence = session.runtimeType !== 'codex' || runtimeError
        ? 'unknown'
        : observed ? 'observed' : mcpComplete ? 'not_observed' : 'unknown';
      const runtimeAuthStatus = observed ? safeSettingText(observed.authStatus, 'unknown', 80) : 'unknown';
      return {
        id: record.id, name: record.name, configured: true, configuredScope: record.scope,
        transport: record.transport, enabled: record.enabled,
        runtimePresence: presence,
        runtimeScope: observed ? 'runtime_effective_scope_unknown' : 'not_reported',
        runtimeAuthStatus,
        toolCount: observed ? Number(observed.toolCount) || 0 : 0,
        resourceCount: observed ? Number(observed.resourceCount) || 0 : 0,
        health: !record.enabled ? 'disabled'
          : presence === 'observed' ? runtimeAuthStatus === 'notLoggedIn' ? 'attention' : 'healthy'
            : presence === 'not_observed' ? 'unavailable' : 'unknown',
      };
    });
    for (const observed of serverByName.values()) {
      mcp.push({
        id: '', name: safeSettingText(observed.name, 'Unnamed MCP', 120), configured: false,
        configuredScope: 'runtime_only', transport: 'runtime_native', enabled: true,
        runtimePresence: 'observed', runtimeScope: 'runtime_effective_scope_unknown',
        runtimeAuthStatus: safeSettingText(observed.authStatus, 'unknown', 80),
        toolCount: Number(observed.toolCount) || 0, resourceCount: Number(observed.resourceCount) || 0,
        health: safeSettingText(observed.authStatus, 'unknown', 80) === 'notLoggedIn' ? 'attention' : 'healthy',
      });
    }
    const skills: Record<string, unknown>[] = configuredSkills.map((record) => {
      const observed = skillByName.get(normalizedCapabilityName(record.name));
      if (observed) skillByName.delete(normalizedCapabilityName(record.name));
      const presence = session.runtimeType !== 'codex' || runtimeError ? 'unknown' : observed ? 'observed' : 'not_observed';
      return {
        id: record.id, name: record.name, description: record.description,
        configured: true, configuredScope: record.scope, source: record.source,
        safety: record.safety, files: record.files,
        runtimePresence: presence,
        runtimeScope: observed ? safeSettingText(observed.scope, 'unknown', 40) : 'not_reported',
        runtimeEnabled: observed ? observed.enabled !== false : undefined,
        health: presence === 'observed' ? observed?.enabled === false ? 'disabled' : 'healthy'
          : presence === 'not_observed' ? 'unavailable' : 'unknown',
      };
    });
    for (const observed of skillByName.values()) {
      skills.push({
        id: '', name: safeSettingText(observed.name, 'Unnamed skill', 120),
        description: safeSettingText(observed.description, '', 500), configured: false,
        configuredScope: 'runtime_only', source: 'runtime_native', safety: 'runtime_managed', files: 0,
        runtimePresence: 'observed', runtimeScope: safeSettingText(observed.scope, 'unknown', 40),
        runtimeEnabled: observed.enabled !== false, health: observed.enabled === false ? 'disabled' : 'healthy',
      });
    }
    const claudeInit = session.runtimeType === 'claude'
      ? [...(this.#events.get(session.id) ?? [])].reverse().find((event) => event.type === 'session.started')
      : undefined;
    return {
      supportLevel: session.runtimeType === 'codex' && !runtimeError ? 'supported' : 'degraded',
      runtimeType: session.runtimeType, projectId: project.id, sessionId: session.id,
      mcp, skills,
      observedMcpServerCount: session.runtimeType === 'codex'
        ? nativeServers.length
        : Number(claudeInit?.payload.mcpServerCount) || 0,
      ...(runtimeError ? { runtimeError } : {}),
      limitations: session.runtimeType === 'codex'
        ? ['Codex 只报告 Runtime 已观察到的 MCP/Skills；MCP 原生响应不提供配置 Scope。']
        : ['Claude stream-json 只报告 MCP 数量，不提供名称、健康或 Skill 清单；本地配置的 Runtime 生效状态保持 unknown。'],
      refreshedAt: Date.now(),
    };
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
    if (providerNeedsSecret(provider) && !provider.secretRef) throw new Error('所选 Provider 尚未保存 API Key');
    if (provider.kind === 'claude-native' && !runtime.authenticated) throw new Error('Claude Code 本机 Runtime 尚未登录');
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
    this.#assertSessionWritable(session);
    if (session.turnCount > 0 || session.status === 'running') throw new Error('Session 首次 Turn 后 Runtime 参数已锁定');
    const provider = this.#providers.get(input.providerId ?? session.providerId);
    assertProviderCompatibility(session.runtimeType, provider.kind);
    if (providerNeedsSecret(provider) && !provider.secretRef) throw new Error('所选 Provider 尚未保存 API Key');
    const runtime = this.#runtimes.find((item) => item.type === session.runtimeType);
    if (provider.kind === 'claude-native' && !runtime?.authenticated) throw new Error('Claude Code 本机 Runtime 尚未登录');
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
    this.#assertSessionWritable(session);
    if (session.status === 'running' || session.status === 'waiting_permission') {
      throw new Error('当前 Turn 尚未结束；请等待、处理中断或完成权限确认');
    }
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
      cwd: session.worktreePath, sessionId: session.threadId as string,
      resume: session.turnCount > 0 && !session.forkSourceRuntimeSessionId,
      ...(session.forkSourceRuntimeSessionId ? { forkFromSessionId: session.forkSourceRuntimeSessionId } : {}),
      ...(session.forkSourceRuntimeMessageId ? { resumeSessionAt: session.forkSourceRuntimeMessageId } : {}),
      prompt, model: provider.kind === 'deepseek' ? deepSeekClaudeModel(session.model) : session.model,
      permissionMode: claudePermission(session.permissionMode),
      authMode: provider.kind === 'claude-native' ? 'native' : 'provider', environment,
      onEvent: (type, payload) => this.#runtimeEvent(sessionId, type, payload),
      onExit: (error) => {
        if (!error) return;
        session.status = 'error'; session.lastError = error;
        this.#emit({ sessionId, type: 'runtime.error', payload: { message: error } });
        this.#save();
      },
    }), session.model);
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
    if (pending.kind === 'claude') {
      const claude = this.#claudeClient;
      if (!claude) {
        this.#approvals.set(permissionId, pending);
        throw new Error('Claude Code Runtime 已退出，权限请求已失效');
      }
      try {
        claude.respondToPermission(pending.turnId, pending.requestId, allow ? 'allow' : 'deny');
        if (decision === 'cancel_turn') claude.interrupt(pending.turnId);
      } catch (error) {
        this.#approvals.set(permissionId, pending);
        throw error;
      }
    } else if (pending.approval.method === 'item/permissions/requestApproval') {
      const requested = object(pending.approval.params.permissions);
      pending.resolve({ permissions: allow ? (Object.keys(requested).length > 0 ? requested : { fileSystem: null, network: null }) : { fileSystem: null, network: null }, scope: 'turn' });
    } else pending.resolve({ decision: allow ? 'accept' : decision === 'cancel_turn' ? 'cancel' : 'decline' });
    const session = this.#session(pending.sessionId);
    session.status = 'running';
    this.#save();
    this.#emit({ sessionId: pending.sessionId, type: 'permission.resolved', payload: { permissionId, decision } });
  }

  listCheckpoints(sessionId: string): ConversationCheckpoint[] {
    this.#session(sessionId);
    return this.#checkpoints.list(sessionId);
  }

  createCheckpoint(sessionId: string, label: string): ConversationCheckpoint {
    const session = this.#checkpointSession(sessionId);
    this.#assertSessionWritable(session);
    const markers = this.#checkpointRuntimeMarkers(session);
    const checkpoint = this.#checkpoints.create({
      sessionId,
      worktreePath: session.worktreePath,
      transcriptPath: this.#transcriptPath(sessionId),
      label,
      runtimeSessionId: markers.runtimeSessionId,
      ...(markers.runtimeTurnId ? { runtimeTurnId: markers.runtimeTurnId } : {}),
      ...(markers.runtimeMessageId ? { runtimeMessageId: markers.runtimeMessageId } : {}),
      turnCount: session.turnCount,
    });
    this.#emit({ sessionId, type: 'checkpoint.created', payload: {
      checkpointId: checkpoint.id,
      label: checkpoint.label,
      headCommit: checkpoint.headCommit,
      conversationEventCount: checkpoint.conversationEventCount,
    } });
    return checkpoint;
  }

  previewCheckpoint(sessionId: string, checkpointId: string): CheckpointPreview {
    const session = this.#checkpointSession(sessionId);
    return this.#checkpoints.preview(
      sessionId,
      checkpointId,
      session.worktreePath,
      this.#transcriptPath(sessionId),
    );
  }

  async rewindCheckpoint(sessionId: string, checkpointId: string): Promise<CheckpointRewindResult> {
    const session = this.#checkpointSession(sessionId);
    this.#assertSessionWritable(session);
    const preview = this.#checkpoints.preview(
      sessionId,
      checkpointId,
      session.worktreePath,
      this.#transcriptPath(sessionId),
    );
    const checkpoint = preview.checkpoint;
    let forkedCodexThreadId: string | undefined;
    if (session.runtimeType === 'codex') {
      if (!checkpoint.runtimeSessionId || !checkpoint.runtimeTurnId) {
        throw new Error('此 Checkpoint 缺少 Codex Thread/Turn 锚点，不能安全回退对话');
      }
      const client = await this.#ensureCodexClient(sessionId);
      forkedCodexThreadId = await client.forkThread(checkpoint.runtimeSessionId, checkpoint.runtimeTurnId);
    } else if (!checkpoint.runtimeSessionId || !checkpoint.runtimeMessageId) {
      throw new Error('此 Checkpoint 缺少 Claude Session/Message 锚点，不能安全回退对话');
    }
    const result = this.#checkpoints.rewind({
      sessionId,
      checkpointId,
      worktreePath: session.worktreePath,
      transcriptPath: this.#transcriptPath(sessionId),
      label: checkpoint.label,
      ...this.#checkpointRuntimeMarkers(session),
      turnCount: session.turnCount,
    });
    if (session.runtimeType === 'codex') {
      session.threadId = forkedCodexThreadId as string;
    } else {
      session.threadId = randomUUID();
      session.forkSourceRuntimeSessionId = checkpoint.runtimeSessionId as string;
      session.forkSourceRuntimeMessageId = checkpoint.runtimeMessageId as string;
    }
    session.turnCount = checkpoint.turnCount;
    session.status = 'ready';
    session.updatedAt = Date.now();
    delete session.lastError;
    this.#reloadSessionTranscript(sessionId);
    this.#save();
    this.#emit({ sessionId, type: 'checkpoint.rewound', payload: {
      checkpointId: checkpoint.id,
      recoveryCheckpointId: result.recoveryCheckpoint.id,
      restoredPathCount: result.restoredPathCount,
      restoredConversationEventCount: result.restoredConversationEventCount,
      headMoved: false,
    } });
    this.#emit({ sessionId, type: 'git.changed', payload: { action: 'checkpoint_rewind' } });
    return result;
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
    this.#assertSessionWritable(session);
    const safe = paths.map(safeRelativePath);
    if (safe.length === 0) throw new Error('请选择文件');
    this.#git(session.worktreePath, ['restore', '--staged', '--', ...safe]);
    this.#emit({ sessionId, type: 'git.changed', payload: { action: 'unstage' } });
  }

  commit(sessionId: string, subject: string): string {
    const session = this.#session(sessionId);
    this.#assertSessionWritable(session);
    const cleanSubject = subject.trim();
    if (!cleanSubject || cleanSubject.length > 200 || /[\r\n\0]/.test(cleanSubject)) throw new Error('Commit Subject 必须为单行且不超过 200 字符');
    this.#git(session.worktreePath, ['commit', '-m', cleanSubject]);
    const sha = this.#git(session.worktreePath, ['rev-parse', 'HEAD']).trim();
    this.#emit({ sessionId, type: 'git.committed', payload: { sha, subject: cleanSubject } });
    return sha;
  }

  async shutdown(): Promise<void> {
    if (this.#schedulerTimer) { clearInterval(this.#schedulerTimer); this.#schedulerTimer = null; }
    for (const pending of this.#approvals.values()) {
      if (pending.kind === 'codex') pending.reject(new Error('Tsukiori 正在退出'));
    }
    this.#approvals.clear();
    await Promise.allSettled([
      ...[...this.#clients.values()].map((client) => client.stop()),
      this.#claudeClient?.stop() ?? Promise.resolve(),
    ]);
    this.#clients.clear();
  }

  async #runScheduledTasks(): Promise<void> {
    const now = Date.now();
    for (const task of this.#capabilities.listScheduledTasks()) {
      if (!task.enabled || task.nextRunAt > now) continue;
      try { await this.runScheduledTask(task.id); }
      catch { /* Error is persisted on the task and shown in Scheduled Tasks. */ }
    }
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
      this.#runtimeEvent(sessionId, 'turn.completed', {
        turnId: String(turn.id ?? params.turnId ?? ''),
        status: String(turn.status ?? 'completed'),
        error: truncate(String(object(turn.error).message ?? ''), 2_000),
      });
    } else if (method === 'item/started' || method === 'item/completed') {
      const item = object(params.item);
      const itemType = String(item.type ?? 'tool');
      if (itemType === 'collabAgentToolCall') {
        const agents = Object.entries(object(item.agentsStates)).slice(0, 32).map(([threadId, value]) => ({
          threadId: safeSettingText(threadId, 'unknown', 160),
          status: safeSettingText(object(value).status, 'unknown', 80),
        }));
        this.#emit({ sessionId, type: 'subagent.event', payload: {
          schemaVersion: 1,
          runtimeEventType: method,
          runtimeTaskId: safeSettingText(item.id, '', 160),
          senderThreadId: safeSettingText(item.senderThreadId, '', 160),
          receiverThreadIds: Array.isArray(item.receiverThreadIds)
            ? item.receiverThreadIds.slice(0, 32).map((value) => safeSettingText(value, '', 160)).filter(Boolean)
            : [],
          tool: safeSettingText(item.tool, 'collabAgentToolCall', 80),
          status: safeSettingText(item.status, method.endsWith('started') ? 'inProgress' : 'completed', 80),
          agents,
        } });
      }
      if (!['agentMessage', 'userMessage'].includes(itemType)) this.#emit({ sessionId, type: 'tool.event', payload: {
        phase: method.endsWith('started') ? 'started' : 'completed', tool: itemType,
        toolUseId: String(item.id ?? ''),
        summary: truncate(String(item.command ?? item.path ?? item.name ?? itemType), 2_000),
      } });
    } else if (method === 'error') this.#emit({ sessionId, type: 'runtime.error', payload: { message: truncate(String(params.message ?? 'Codex Runtime error'), 2_000) } });
    this.#save();
  }

  #runtimeEvent(sessionId: string, type: string, payload: Record<string, unknown>): void {
    const session = this.#session(sessionId);
    if (session.importedReadOnly) throw new Error('导入历史为只读；请先显式 Fork，再在新 Session 中继续');
    if (type === 'permission.requested') {
      const permissionId = this.#claudeApproval(sessionId, payload);
      payload = { ...payload, permissionId };
    } else if (type === 'permission.invalidated') {
      const requestId = String(payload.requestId ?? '');
      const match = [...this.#approvals.entries()].find(([, pending]) => (
        pending.kind === 'claude' && pending.sessionId === sessionId && pending.requestId === requestId
      ));
      if (match) {
        this.#approvals.delete(match[0]);
        payload = { ...payload, permissionId: match[0] };
        if (session.status === 'waiting_permission') session.status = 'running';
      }
    }
    if (type === 'turn.started') {
      session.status = 'running';
      const turnId = String(payload.turnId ?? '');
      if (turnId) this.#activeTurns.set(sessionId, turnId);
    } else if (type === 'session.started' && session.runtimeType === 'claude') {
      const runtimeSessionId = typeof payload.runtimeSessionId === 'string' ? payload.runtimeSessionId : '';
      if (isUuid(runtimeSessionId)) {
        session.threadId = runtimeSessionId;
        delete session.forkSourceRuntimeSessionId;
        delete session.forkSourceRuntimeMessageId;
        session.updatedAt = Date.now();
      }
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

  #checkpointSession(sessionId: string): SessionState {
    const session = this.#session(sessionId);
    if (!this.#state.settings.persistConversation) {
      throw new Error('创建或回退 Checkpoint 前必须启用本地对话持久化');
    }
    if (['running', 'waiting_permission', 'starting'].includes(session.status)) {
      throw new Error('运行中的 Session 不能创建或回退 Checkpoint');
    }
    if (!session.threadId || session.turnCount < 1) throw new Error('Session 至少完成一个 Turn 后才能创建 Checkpoint');
    return session;
  }

  #checkpointRuntimeMarkers(session: SessionState): {
    runtimeSessionId: string;
    runtimeTurnId?: string;
    runtimeMessageId?: string;
  } {
    const events = this.#events.get(session.id) ?? [];
    if (session.runtimeType === 'codex') {
      const completed = [...events].reverse().find((event) => event.type === 'turn.completed');
      const runtimeTurnId = typeof completed?.payload.turnId === 'string' ? completed.payload.turnId : '';
      if (!runtimeTurnId) throw new Error('当前 Codex Transcript 缺少最后完成 Turn ID，不能创建一致性 Checkpoint');
      return { runtimeSessionId: session.threadId as string, runtimeTurnId };
    }
    const message = [...events].reverse().find((event) => event.type === 'assistant.message.started');
    const runtimeMessageId = typeof message?.payload.messageId === 'string' ? message.payload.messageId : '';
    if (!runtimeMessageId) throw new Error('当前 Claude Transcript 缺少最后 Assistant Message ID，不能创建一致性 Checkpoint');
    return { runtimeSessionId: session.threadId as string, runtimeMessageId };
  }

  #transcriptPath(sessionId: string): string {
    return join(this.#transcriptRoot, safeTranscriptName(sessionId));
  }

  #reloadSessionTranscript(sessionId: string): void {
    const session = this.#session(sessionId);
    const path = this.#transcriptPath(sessionId);
    if (!existsSync(path) || statSync(path).size > 8 * 1024 * 1024) {
      this.#events.set(sessionId, []);
      return;
    }
    const events: WorkspaceEvent[] = [];
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).slice(-1_000)) {
      try {
        const raw = JSON.parse(line) as Record<string, unknown>;
        if (raw.sessionId !== sessionId || typeof raw.type !== 'string' || !transcriptEvent(raw.type)) continue;
        events.push({
          id: typeof raw.id === 'string' ? raw.id : randomUUID(),
          sequence: ++this.#eventSequence,
          sessionId,
          type: raw.type,
          createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : session.createdAt,
          payload: object(raw.payload),
        });
      } catch { /* Invalid rows were already rejected by CheckpointService. */ }
    }
    this.#events.set(sessionId, events);
  }

  #approval(sessionId: string, approval: CodexApproval): Promise<unknown> {
    const permissionId = 'permission:' + randomUUID();
    const session = this.#session(sessionId);
    session.status = 'waiting_permission'; this.#save();
    return new Promise((resolveApproval, rejectApproval) => {
      this.#approvals.set(permissionId, { kind: 'codex', sessionId, approval, resolve: resolveApproval, reject: rejectApproval });
      this.#emit({ sessionId, type: 'permission.requested', payload: {
        permissionId, connectionEpoch: 'interactive-codex', title: approvalTitle(approval.method),
        description: approvalDescription(approval.method), category: approvalCategory(approval.method, approval.params),
        scope: approvalScope(approval.params),
      } });
    });
  }

  #claudeApproval(sessionId: string, payload: Record<string, unknown>): string {
    const session = this.#session(sessionId);
    if (session.runtimeType !== 'claude') throw new Error('非 Claude Session 不能提交 Claude 权限请求');
    const turnId = safeRuntimeIdentifier(payload.runtimeTurnId, 'Claude Turn ID');
    const requestId = safeRuntimeIdentifier(payload.requestId, 'Claude Permission Request ID');
    const connectionEpoch = safeRuntimeIdentifier(payload.connectionEpoch, 'Claude Connection Epoch');
    const activeTurn = this.#activeTurns.get(sessionId);
    if (activeTurn && activeTurn !== turnId) throw new Error('Claude 权限请求不属于当前 Turn');
    if ([...this.#approvals.values()].some((pending) => (
      pending.kind === 'claude' && pending.turnId === turnId && pending.requestId === requestId
    ))) throw new Error('Claude 权限请求重复');
    const toolName = safeRuntimeText(payload.tool, 'tool', 128);
    const input = object(payload.input);
    const permissionId = 'permission:' + randomUUID();
    const pending: ClaudeApprovalResolver = {
      kind: 'claude', sessionId, turnId, requestId, connectionEpoch,
      title: safeRuntimeText(payload.title, `${toolName} 请求权限`, 256),
      description: safeRuntimeText(payload.description, 'Claude Code 请求执行工具', 1_000),
      category: claudeApprovalCategory(toolName, input),
      risk: claudeApprovalRisk(toolName, input),
      scope: claudeApprovalScope(toolName, input, payload.blockedPath),
    };
    this.#approvals.set(permissionId, pending);
    session.status = 'waiting_permission';
    this.#save();
    return permissionId;
  }

  #emit(input: Omit<WorkspaceEvent, 'id' | 'sequence' | 'createdAt'> & { createdAt?: number }): void {
    this.#eventSequence += 1;
    const event: WorkspaceEvent = {
      id: randomUUID(), sequence: this.#eventSequence,
      createdAt: input.createdAt ?? Date.now(), ...input,
    };
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

  #emitImportedEvent(sessionId: string, event: ImportedConversationEvent): void {
    this.#emit({ sessionId, type: event.type, createdAt: event.createdAt, payload: event.payload });
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

  #assertSessionWritable(session: SessionState): void {
    if (session.importedReadOnly) throw new Error('导入历史为只读；请先显式 Fork，再修改代码或启动 Runtime');
  }

  #gitMutation(sessionId: string, action: 'add', paths: readonly string[]): void {
    const session = this.#session(sessionId);
    this.#assertSessionWritable(session);
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
      const projects = Array.isArray(value.projects) ? value.projects.map((raw) => migrateProject(object(raw))) : [];
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
    ...(typeof value.forkedFromSessionId === 'string' ? { forkedFromSessionId: value.forkedFromSessionId } : {}),
    ...(typeof value.forkSourceRuntimeSessionId === 'string' ? { forkSourceRuntimeSessionId: value.forkSourceRuntimeSessionId } : {}),
    ...(typeof value.forkSourceRuntimeMessageId === 'string' ? { forkSourceRuntimeMessageId: value.forkSourceRuntimeMessageId } : {}),
    ...(value.importSource === 'cc-haha' ? { importSource: 'cc-haha' as const } : {}),
    ...(typeof value.importSourceSessionId === 'string' ? { importSourceSessionId: value.importSourceSessionId } : {}),
    ...(typeof value.importTranscriptHash === 'string' ? { importTranscriptHash: value.importTranscriptHash } : {}),
    ...(value.importedReadOnly === true ? { importedReadOnly: true } : {}),
    turnCount: typeof value.turnCount === 'number' ? value.turnCount : 0,
    status: value.status === 'running' || value.status === 'waiting_permission' ? 'ready' : String(value.status ?? 'ready') as SessionState['status'],
    ...(typeof value.lastError === 'string' ? { lastError: value.lastError } : {}),
    createdAt: typeof value.createdAt === 'number' ? value.createdAt : Date.now(),
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : typeof value.createdAt === 'number' ? value.createdAt : Date.now(),
    ...(value.pinned === true ? { pinned: true } : {}),
    ...(typeof value.archivedAt === 'number' ? { archivedAt: value.archivedAt } : {}),
  };
}

function migrateProject(value: Record<string, unknown>): ProjectState {
  return {
    id: String(value.id),
    name: String(value.name),
    rootPath: String(value.rootPath),
    gitRoot: String(value.gitRoot),
    branch: typeof value.branch === 'string' ? value.branch : 'detached',
    ...(value.pinned === true ? { pinned: true } : {}),
    ...(typeof value.updatedAt === 'number' ? { updatedAt: value.updatedAt } : {}),
  };
}

function assertProviderCompatibility(runtime: RuntimeType, kind: ProviderKind): void {
  const allowed = runtime === 'codex'
    ? ['chatgpt', 'openai', 'openai-compatible']
    : ['claude-native', 'anthropic', 'deepseek', 'anthropic-compatible'];
  if (!allowed.includes(kind)) throw new Error(`${runtime === 'codex' ? 'Codex' : 'Claude Code'} 不支持 ${kind} Provider`);
}

function compatibleDefaultProvider(runtime: RuntimeType, preferred: string): string {
  if (runtime === 'codex') return preferred.startsWith('provider:') ? preferred : 'provider:chatgpt';
  return ['provider:claude-native', 'provider:anthropic', 'provider:deepseek'].includes(preferred)
    ? preferred
    : 'provider:claude-native';
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

function claudePermission(value: PermissionMode): 'manual' | 'plan' | 'acceptEdits' | 'dontAsk' {
  return value;
}

function providerNeedsSecret(provider: ProviderConfig): boolean {
  return provider.kind !== 'chatgpt' && provider.kind !== 'claude-native';
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

function normalizedCapabilityName(value: unknown): string {
  return safeSettingText(value, '', 120).normalize('NFKC').toLocaleLowerCase('en-US');
}

function claudeApprovalCategory(toolName: string, input: Record<string, unknown>): string {
  const lower = toolName.toLowerCase();
  if (lower.includes('web') || lower.includes('http') || lower.includes('fetch') || lower.includes('search')) return 'network';
  if (['bash', 'shell', 'terminal', 'exec'].some((marker) => lower.includes(marker))) {
    const command = String(input.command ?? '');
    return /\b(curl|wget|ssh|scp|git\s+(fetch|pull|push|clone)|npm\s+(install|publish))\b/i.test(command) ? 'network' : 'shell';
  }
  if (['write', 'edit', 'delete', 'move', 'rename', 'notebook'].some((marker) => lower.includes(marker))) return 'file_write';
  if (['read', 'glob', 'grep', 'list'].some((marker) => lower.includes(marker))) return 'file_read';
  return lower.startsWith('mcp') ? 'external_tool' : 'tool';
}

function claudeApprovalRisk(toolName: string, input: Record<string, unknown>): 'medium' | 'high' {
  return ['shell', 'network', 'file_write', 'external_tool'].includes(claudeApprovalCategory(toolName, input)) ? 'high' : 'medium';
}

function claudeApprovalScope(toolName: string, input: Record<string, unknown>, blockedPath: unknown): string {
  const candidates = [
    input.command, input.file_path, input.path, input.url, input.query,
    typeof blockedPath === 'string' ? blockedPath : undefined,
  ];
  const scope = candidates.find((value) => typeof value === 'string' && value.trim());
  const text = typeof scope === 'string' ? scope : `${toolName} · 当前 Turn`;
  return truncate(text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi, '[REDACTED]')
    .replace(/\bBearer\s+\S+|\bsk-[A-Za-z0-9_-]{12,}/gi, '[REDACTED]'), 1_000);
}

function safeRuntimeIdentifier(value: unknown, label: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > 256 || /[\r\n\0]/.test(text)) throw new Error(`${label} 无效`);
  return text;
}

function safeRuntimeText(value: unknown, fallback: string, max: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || /[\0]/.test(text)) return fallback;
  return truncate(text, max);
}

function uniqueForkName(sourceName: string, sessions: readonly SessionState[]): string {
  const base = sourceName.replace(/ \(Fork(?: \d+)?\)$/u, '').slice(0, 68);
  const used = new Set(sessions.map((session) => session.name));
  if (!used.has(`${base} (Fork)`)) return `${base} (Fork)`;
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${base} (Fork ${index})`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error('无法生成唯一的 Fork Session 名称');
}

function uniqueImportedName(sourceName: string, sessions: readonly SessionState[]): string {
  const base = `${sourceName.replace(/\s+\(Imported(?: \d+)?\)$/i, '').trim() || 'cc-haha Session'} (Imported)`;
  if (!sessions.some((session) => session.name === base)) return base;
  let suffix = 2;
  while (sessions.some((session) => session.name === `${base.slice(0, -1)} ${suffix})`)) suffix += 1;
  return `${base.slice(0, -1)} ${suffix})`;
}

function publicCcHahaScan(scan: CcHahaImportScan): Omit<CcHahaImportScan, 'sessions'> & {
  sessions: Array<Omit<CcHahaImportCandidate, 'sourceFile'>>;
} {
  return {
    ...scan,
    sessions: scan.sessions.map(({ sourceFile: _sourceFile, ...candidate }) => candidate),
  };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
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
  return [
    'user.message', 'assistant.message.started', 'assistant.thinking.started', 'assistant.thinking.delta',
    'assistant.thinking.completed', 'assistant.delta', 'assistant.message.completed', 'tool.event',
    'turn.completed', 'runtime.error', 'attachment.added', 'subagent.event', 'checkpoint.created', 'checkpoint.rewound',
  ].includes(type);
}

function projectSubagentActivity(events: readonly WorkspaceEvent[]): Record<string, unknown>[] {
  const records = new Map<string, Record<string, unknown>>();
  for (const event of events) {
    if (event.type !== 'subagent.event') continue;
    const payload = object(event.payload);
    const agents = Array.isArray(payload.agents) ? payload.agents.map(object) : [];
    const receivers = Array.isArray(payload.receiverThreadIds)
      ? payload.receiverThreadIds.map((value) => activityText(value, 160)).filter(Boolean)
      : [];
    const candidates = agents.length > 0
      ? agents.map((agent) => ({ id: activityText(agent.threadId, 160), status: activityText(agent.status, 80) }))
      : receivers.length > 0
        ? receivers.map((id) => ({ id, status: activityText(payload.status, 80) }))
        : [{
            id: activityText(payload.runtimeSubagentId ?? payload.runtimeTaskId ?? payload.parentToolUseId ?? event.id, 160),
            status: activityText(payload.status ?? payload.runtimeEventType, 80),
          }];
    for (const candidate of candidates) {
      const runtimeId = candidate.id || event.id;
      const key = `${event.sessionId ?? 'unknown'}:${runtimeId}`;
      const existing = records.get(key);
      records.set(key, {
        id: `runtime:${key}`, source: 'runtime', sessionId: event.sessionId ?? null,
        runtimeId,
        runtimeTaskId: activityText(payload.runtimeTaskId, 160),
        parentId: activityText(payload.senderThreadId ?? payload.parentToolUseId, 160),
        role: activityText(payload.name ?? payload.tool, 120) || 'Runtime Subagent',
        status: subagentStatus(candidate.status),
        startedAt: typeof existing?.startedAt === 'number' ? existing.startedAt : event.createdAt,
        updatedAt: event.createdAt,
      });
    }
  }
  return [...records.values()].sort((left, right) => Number(right.updatedAt) - Number(left.updatedAt));
}

function subagentStatus(value: string): string {
  const status = value.toLocaleLowerCase('en-US');
  if (/error|fail|notfound/.test(status)) return 'failed';
  if (/interrupt|cancel|shutdown|stop/.test(status)) return 'stopped';
  if (/complete|success|finished|done/.test(status)) return 'completed';
  if (/pending|start|spawn|progress|running|assistant|user/.test(status)) return 'running';
  return 'observed';
}

function activityText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/[\r\n\0]/g, ' ').trim().slice(0, max) : '';
}

function searchableEventText(event: WorkspaceEvent): string {
  if (event.type === 'user.message' || event.type === 'assistant.delta' || event.type === 'assistant.thinking.delta') {
    return typeof event.payload.text === 'string' ? event.payload.text : '';
  }
  if (event.type === 'tool.event') {
    return [event.payload.tool, event.payload.summary].filter((value) => typeof value === 'string').join(' ');
  }
  if (event.type === 'runtime.error') return typeof event.payload.message === 'string' ? event.payload.message : '';
  return '';
}

function searchSnippet(value: string, needle: string, max: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  const index = normalized.toLocaleLowerCase().indexOf(needle);
  if (index < 0) return truncate(normalized, max);
  const start = Math.max(0, index - Math.floor((max - needle.length) / 2));
  const slice = normalized.slice(start, start + max);
  return `${start > 0 ? '…' : ''}${slice}${start + max < normalized.length ? '…' : ''}`;
}

function safeTranscriptName(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex') + '.jsonl';
}

function truncate(value: string, max: number): string { return value.length <= max ? value : value.slice(0, max) + '\n…[truncated]'; }
function message(error: unknown): string { return truncate(error instanceof Error ? error.message : String(error), 2_000); }
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
