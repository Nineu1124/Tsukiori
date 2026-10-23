import { randomUUID } from 'node:crypto';
import type { ClaudeThinkingEffort } from '@tsukiori/adapter-claude';
import type { ProviderConfig } from './provider-registry.js';
import type { RuntimeType, SessionState, ProjectState, TeamRunState, WorkspaceSettings, PersistedState } from './workspace-types.js';
import type { WorkspaceStateDocument } from './workspace-state-file.js';
import { permissionMode, defaultPermission } from './session-policy.js';

export const defaultSettings: WorkspaceSettings = {
  language: 'zh-CN', theme: 'light', density: 'comfortable', reduceMotion: false, showThinking: true,
  autoUpdate: true, startMinimized: false, defaultProjectDirectory: '',
  defaultRuntime: 'codex', defaultProviderId: 'provider:chatgpt', defaultModel: 'auto',
  defaultPermissionMode: 'manual',
  persistConversation: true, confirmHighRisk: true,
  workPanelWidth: 360, terminalHeight: 220,
  terminalShell: 'powershell',
};

export function normalizeWorkspaceState(value?: WorkspaceStateDocument): PersistedState {
  if (!value) return { schemaVersion: 3, projects: [], sessions: [], settings: { ...defaultSettings }, providers: [], teams: [] };
  const projects = value.projects.map((raw) => migrateProject(object(raw)));
  const sessions = value.sessions.map((raw) => migrateSession(object(raw)));
  const settings = value.schemaVersion >= 2 ? { ...defaultSettings, ...object(value.settings) } as WorkspaceSettings : { ...defaultSettings };
  settings.language = 'zh-CN'; settings.theme = 'light'; settings.confirmHighRisk = true;
  const providers = value.schemaVersion >= 2 && Array.isArray(value.providers) ? value.providers as ProviderConfig[] : [];
  const teams = value.schemaVersion >= 3 && Array.isArray(value.teams) ? value.teams.map((raw) => migrateTeam(object(raw), sessions)) : [];
  return { schemaVersion: 3, projects, sessions, settings, providers, teams };
}

function migrateSession(value: Record<string, unknown>): SessionState {
  const runtimeType: RuntimeType = value.runtimeType === 'claude' || value.runtimeType === 'api'
    ? value.runtimeType : 'codex';
  return {
    id: String(value.id), projectId: String(value.projectId), name: String(value.name), runtimeType,
    providerId: typeof value.providerId === 'string' ? value.providerId : 'provider:chatgpt',
    model: typeof value.model === 'string' ? value.model : 'auto', environment: 'windows-native',
    permissionMode: permissionMode(typeof value.permissionMode === 'string' ? value.permissionMode : defaultPermission(runtimeType)),
    ...(isClaudeThinkingEffort(value.thinkingEffort) ? { thinkingEffort: value.thinkingEffort } : {}),
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
    ...(value.transcriptIncomplete === true ? { transcriptIncomplete: true } : {}),
    createdAt: typeof value.createdAt === 'number' ? value.createdAt : Date.now(),
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : typeof value.createdAt === 'number' ? value.createdAt : Date.now(),
    ...(value.pinned === true ? { pinned: true } : {}),
    ...(typeof value.archivedAt === 'number' ? { archivedAt: value.archivedAt } : {}),
  };
}

function migrateTeam(value: Record<string, unknown>, sessions: readonly SessionState[]): TeamRunState {
  const sessionIds = Array.isArray(value.memberSessionIds)
    ? [...new Set(value.memberSessionIds.filter((item): item is string => typeof item === 'string'))].slice(0, 4)
    : [];
  const rawMembers = Array.isArray(value.members) ? value.members.map(object) : [];
  const members = sessionIds.map((sessionId, order) => {
    const raw = rawMembers.find((item) => item.sessionId === sessionId);
    const session = sessions.find((item) => item.id === sessionId);
    return {
      sessionId,
      role: safeSettingText(raw?.role, session?.name ?? `Agent ${order + 1}`, 80),
      order: typeof raw?.order === 'number' ? Math.max(0, Math.min(3, Math.trunc(raw.order))) : order,
    };
  }).sort((a, b) => a.order - b.order);
  const allowedStatuses: TeamRunState['status'][] = [
    'dispatching', 'running', 'synthesizing', 'stopping', 'stopped', 'completed', 'partial_failure',
  ];
  const persistedStatus = allowedStatuses.includes(value.status as TeamRunState['status'])
    ? value.status as TeamRunState['status'] : 'completed';
  const memberSessions = sessionIds.map((sessionId) => sessions.find((item) => item.id === sessionId));
  const status: TeamRunState['status'] = ['dispatching', 'running', 'synthesizing', 'stopping'].includes(persistedStatus)
    ? memberSessions.some((session) => !session || session.status === 'error') ? 'partial_failure' : 'stopped'
    : persistedStatus;
  const coordinator = typeof value.coordinatorSessionId === 'string' && sessionIds.includes(value.coordinatorSessionId)
    ? value.coordinatorSessionId : sessionIds[0];
  return {
    id: safeSettingText(value.id, 'team:' + randomUUID(), 160),
    projectId: safeSettingText(value.projectId, '', 160),
    name: safeSettingText(value.name, 'Agent Team', 80),
    goal: safeSettingText(value.goal, '', 8_000),
    memberSessionIds: sessionIds,
    members,
    ...(coordinator ? { coordinatorSessionId: coordinator } : {}),
    synthesisCount: typeof value.synthesisCount === 'number' ? Math.max(0, Math.trunc(value.synthesisCount)) : 0,
    ...(typeof value.lastSynthesisAt === 'number' ? { lastSynthesisAt: value.lastSynthesisAt } : {}),
    status,
    createdAt: typeof value.createdAt === 'number' ? value.createdAt : Date.now(),
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : Date.now(),
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

function isClaudeThinkingEffort(value: unknown): value is ClaudeThinkingEffort {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max';
}

function safeSettingText(value: unknown, fallback: string, max: number): string {
  if (typeof value !== 'string') return fallback;
  const text = value.trim();
  if (text.length > max || /[\0]/.test(text)) throw new Error('设置值无效');
  return text;
}

function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
