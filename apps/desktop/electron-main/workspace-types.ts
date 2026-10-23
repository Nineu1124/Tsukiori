import type { ClaudeThinkingEffort } from '@tsukiori/adapter-claude';
import type { ProviderConfig } from './provider-registry.js';

export type RuntimeType = 'codex' | 'claude' | 'api';
export type PermissionMode = 'manual' | 'plan' | 'acceptEdits' | 'dontAsk';

export type ProjectState = {
  id: string;
  name: string;
  rootPath: string;
  gitRoot: string;
  branch: string;
  pinned?: boolean;
  updatedAt?: number;
};

export type SessionState = {
  id: string;
  projectId: string;
  name: string;
  runtimeType: RuntimeType;
  providerId: string;
  model: string;
  environment: 'windows-native';
  permissionMode: PermissionMode;
  thinkingEffort?: ClaudeThinkingEffort;
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
  transcriptIncomplete?: true;
  createdAt: number;
  updatedAt: number;
  pinned?: boolean;
  archivedAt?: number;
};

export type TeamMemberState = {
  sessionId: string;
  role: string;
  order: number;
};

export type TeamRunState = {
  id: string;
  projectId: string;
  name: string;
  goal: string;
  memberSessionIds: string[];
  members: TeamMemberState[];
  coordinatorSessionId?: string;
  synthesisCount: number;
  lastSynthesisAt?: number;
  status: 'dispatching' | 'running' | 'synthesizing' | 'stopping' | 'stopped' | 'completed' | 'partial_failure';
  createdAt: number;
  updatedAt: number;
};

export type WorkspaceSettings = {
  language: 'zh-CN';
  theme: 'light';
  density: 'comfortable' | 'compact';
  reduceMotion: boolean;
  showThinking: boolean;
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

export type PersistedState = {
  schemaVersion: 3;
  projects: ProjectState[];
  sessions: SessionState[];
  settings: WorkspaceSettings;
  providers: ProviderConfig[];
  teams: TeamRunState[];
};

export type RuntimeState = {
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

