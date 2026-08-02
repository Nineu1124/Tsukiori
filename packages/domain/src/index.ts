export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type ExecutionEnvironmentType =
  | 'windows-native'
  | 'wsl'
  | 'macos'
  | 'linux'
  | 'container';

export type ExecutionEnvironment = {
  id: string;
  type: ExecutionEnvironmentType;
  displayName: string;
  homePath: string;
  pathStyle: 'windows' | 'posix';
  defaultShell: string;
  gitExecutable: string;
  capabilities: {
    pty: boolean;
    processGroups: boolean;
    jobObjects: boolean;
    symlinks: boolean;
  };
  createdAt: number;
  updatedAt: number;
};

export type Project = {
  id: string;
  name: string;
  executionEnvironmentId: string;
  rootPath: string;
  gitRoot: string;
  repositoryId: string;
  defaultBranch?: string;
  defaultBaseRef?: string;
  setupActions?: JsonValue[];
  cleanupActions?: JsonValue[];
  createdAt: number;
  updatedAt: number;
};

export type SessionLifecycle = 'active' | 'archiving' | 'archived';
export type SessionActivity =
  | 'preparing'
  | 'idle'
  | 'queued'
  | 'running'
  | 'waiting_permission'
  | 'waiting_user_input'
  | 'interrupting'
  | 'stopped';
export type SessionHealth =
  | 'healthy'
  | 'auth_required'
  | 'incompatible_runtime'
  | 'interrupted_runtime'
  | 'interrupted_daemon'
  | 'recovery_required'
  | 'error';
export type WorkspaceState =
  | 'creating'
  | 'clean'
  | 'dirty'
  | 'conflicted'
  | 'orphaned'
  | 'merged'
  | 'removing'
  | 'removed';

export type HostSession = {
  id: string;
  title: string;
  projectId: string;
  primaryWorkspaceBindingId?: string;
  runtimeType: string;
  runtimeProfileId: string;
  runtimeSessionId?: string;
  provider?: string;
  model?: string;
  mode?: string;
  lifecycle: SessionLifecycle;
  activity: SessionActivity;
  health: SessionHealth;
  writeMode: 'isolated-worktree' | 'shared-workdir' | 'read-only';
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
};

export type HostTurn = {
  id: string;
  sessionId: string;
  runtimeTurnId?: string;
  status:
    | 'queued'
    | 'running'
    | 'waiting_permission'
    | 'waiting_user_input'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'interrupted';
  userInput: JsonValue;
  startedAt?: number;
  completedAt?: number;
};

export type WorktreeRecord = {
  id: string;
  projectId: string;
  ownerSessionId?: string;
  executionEnvironmentId: string;
  path: string;
  branchName: string;
  baseRef: string;
  baseCommit: string;
  status: 'creating' | 'active' | 'dirty' | 'conflicted' | 'merged' | 'orphaned' | 'removing' | 'removed';
  createdAt: number;
  removedAt?: number;
};

export type ProcessRecord = {
  id: string;
  sessionId?: string;
  runtimeHandleId?: string;
  executionEnvironmentId: string;
  processType: 'daemon' | 'runtime' | 'pty' | 'mcp' | 'lsp' | 'hook' | 'command';
  pid: number;
  parentPid?: number;
  daemonBootId: string;
  processStartTime: number;
  processFingerprint?: string;
  spawnNonce: string;
  executable?: string;
  cwd?: string;
  status: 'starting' | 'running' | 'stopping' | 'exited' | 'orphaned';
  startedAt: number;
  exitedAt?: number;
  exitCode?: number;
  signal?: string;
};

export type OperationRecord = {
  id: string;
  operationId: string;
  type: 'worktree_create' | 'runtime_session_create' | 'permission_response' | 'commit' | 'merge' | 'worktree_remove';
  sessionId?: string;
  status: 'prepared' | 'running' | 'committed' | 'failed' | 'uncertain';
  requestPayload: JsonValue;
  resultPayload?: JsonValue;
  error?: JsonValue;
  createdAt: number;
  updatedAt: number;
};

export type SessionEventRecord = {
  id: string;
  schemaVersion: number;
  scope: string;
  projectId?: string;
  runtimeHandleId?: string;
  sessionId?: string;
  turnId?: string;
  streamId: string;
  streamSequence: number;
  sessionSequence?: number;
  eventType: string;
  normalizedPayload: JsonValue;
  nativeBlobRef?: string;
  runtimeType?: string;
  runtimeEventId?: string;
  connectionEpoch?: string;
  createdAt: number;
  receivedAt: number;
};

export type PermissionRequestRecord = {
  id: string;
  sessionId: string;
  turnId?: string;
  runtimeHandleId: string;
  runtimeRequestId: string;
  connectionEpoch: string;
  category: string;
  risk: string;
  enforcementLevel: string;
  requestPayload: JsonValue;
  status: 'pending' | 'resolved' | 'invalidated' | 'expired';
  decision?: string;
  decisionScope?: string;
  requestedAt: number;
  resolvedAt?: number;
};

export type PermissionCategory =
  | 'file_read' | 'file_write' | 'file_delete' | 'shell' | 'network'
  | 'external_directory' | 'credential' | 'mcp' | 'git_push' | 'process'
  | 'clipboard' | 'browser' | 'other';
export type PermissionRisk = 'low' | 'medium' | 'high' | 'critical';
export type EnforcementLevel =
  | 'runtime_sandbox' | 'os_sandbox' | 'interceptable' | 'observable_only' | 'opaque';
export type PermissionDecision =
  | 'allow_once' | 'allow_session' | 'allow_project'
  | 'deny_once' | 'deny_session' | 'cancel_turn';
export type PermissionDecisionScope = 'once' | 'session' | 'project' | 'turn';

export type PermissionRuleRecord = {
  id: string;
  projectId: string;
  sessionId?: string;
  category: PermissionCategory;
  enforcementLevel: EnforcementLevel;
  matcher: JsonValue;
  decision: 'allow' | 'deny';
  sourceRequestId: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
};

export type PermissionAuditRecord = {
  id: string;
  requestId: string;
  sessionId: string;
  projectId: string;
  connectionEpoch: string;
  category: PermissionCategory;
  risk: PermissionRisk;
  enforcementLevel: EnforcementLevel;
  decision: PermissionDecision | 'invalidated';
  decisionScope: PermissionDecisionScope | 'connection';
  ruleId?: string;
  reason?: string;
  createdAt: number;
};

export type AttentionKind =
  | 'waiting_permission' | 'waiting_input' | 'completed' | 'failed'
  | 'conflict' | 'recovery_uncertain';
export type AttentionStatus = 'open' | 'resolved';
export type AttentionItemRecord = {
  id: string;
  sessionId: string;
  projectId: string;
  kind: AttentionKind;
  status: AttentionStatus;
  title: string;
  risk?: PermissionRisk;
  sourceRef: string;
  payload: JsonValue;
  createdAt: number;
  updatedAt: number;
  resolvedAt?: number;
};
export type BlobObjectRecord = {
  id: string;
  contentHash: string;
  relativePath: string;
  byteLength: number;
  mediaType: string;
  createdAt: number;
};

export type SessionStateProjection = {
  sessionId: string;
  lifecycle: SessionLifecycle;
  activity: SessionActivity;
  health: SessionHealth;
  lifecycleEventId: string;
  activityEventId: string;
  healthEventId: string;
  updatedAt: number;
};

export type WorkspaceStateProjection = {
  worktreeId: string;
  state: WorkspaceState;
  sourceEventId: string;
  updatedAt: number;
};