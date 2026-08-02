import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const executionEnvironments = sqliteTable('execution_environments', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  displayName: text('display_name').notNull(),
  homePath: text('home_path').notNull(),
  pathStyle: text('path_style').notNull(),
  defaultShell: text('default_shell').notNull(),
  gitExecutable: text('git_executable').notNull(),
  capabilitiesJson: text('capabilities_json').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  executionEnvironmentId: text('execution_environment_id').notNull(),
  rootPath: text('root_path').notNull(),
  gitRoot: text('git_root').notNull(),
  repositoryId: text('repository_id').notNull(),
  defaultBranch: text('default_branch'),
  defaultBaseRef: text('default_base_ref'),
  setupActionsJson: text('setup_actions_json'),
  cleanupActionsJson: text('cleanup_actions_json'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  projectId: text('project_id').notNull(),
  primaryWorkspaceBindingId: text('primary_workspace_binding_id'),
  runtimeType: text('runtime_type').notNull(),
  runtimeProfileId: text('runtime_profile_id').notNull(),
  runtimeSessionId: text('runtime_session_id'),
  provider: text('provider'),
  model: text('model'),
  mode: text('mode'),
  lifecycle: text('lifecycle').notNull(),
  activity: text('activity').notNull(),
  health: text('health').notNull(),
  writeMode: text('write_mode').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  archivedAt: integer('archived_at'),
});

export const sessionTurns = sqliteTable('session_turns', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull(),
  runtimeTurnId: text('runtime_turn_id'),
  status: text('status').notNull(),
  userInputJson: text('user_input_json').notNull(),
  startedAt: integer('started_at'),
  completedAt: integer('completed_at'),
});

export const worktrees = sqliteTable('worktrees', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  ownerSessionId: text('owner_session_id'),
  executionEnvironmentId: text('execution_environment_id').notNull(),
  path: text('path').notNull(),
  branchName: text('branch_name').notNull(),
  baseRef: text('base_ref').notNull(),
  baseCommit: text('base_commit').notNull(),
  status: text('status').notNull(),
  createdAt: integer('created_at').notNull(),
  removedAt: integer('removed_at'),
});

export const processRecords = sqliteTable('process_records', {
  id: text('id').primaryKey(),
  sessionId: text('session_id'),
  runtimeHandleId: text('runtime_handle_id'),
  executionEnvironmentId: text('execution_environment_id').notNull(),
  processType: text('process_type').notNull(),
  pid: integer('pid').notNull(),
  parentPid: integer('parent_pid'),
  daemonBootId: text('daemon_boot_id').notNull(),
  processStartTime: integer('process_start_time').notNull(),
  processFingerprint: text('process_fingerprint'),
  spawnNonce: text('spawn_nonce').notNull(),
  executable: text('executable'),
  cwd: text('cwd'),
  status: text('status').notNull(),
  startedAt: integer('started_at').notNull(),
  exitedAt: integer('exited_at'),
  exitCode: integer('exit_code'),
  signal: text('signal'),
});

export const operations = sqliteTable('operations', {
  id: text('id').primaryKey(),
  operationId: text('operation_id').notNull().unique(),
  type: text('type').notNull(),
  sessionId: text('session_id'),
  status: text('status').notNull(),
  requestPayloadJson: text('request_payload_json').notNull(),
  resultPayloadJson: text('result_payload_json'),
  errorJson: text('error_json'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const blobObjects = sqliteTable('blob_objects', {
  id: text('id').primaryKey(),
  contentHash: text('content_hash').notNull().unique(),
  relativePath: text('relative_path').notNull().unique(),
  byteLength: integer('byte_length').notNull(),
  mediaType: text('media_type').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const sessionEvents = sqliteTable(
  'session_events',
  {
    id: text('id').primaryKey(),
    schemaVersion: integer('schema_version').notNull(),
    scope: text('scope').notNull(),
    projectId: text('project_id'),
    runtimeHandleId: text('runtime_handle_id'),
    sessionId: text('session_id'),
    turnId: text('turn_id'),
    streamId: text('stream_id').notNull(),
    streamSequence: integer('stream_sequence').notNull(),
    sessionSequence: integer('session_sequence'),
    eventType: text('event_type').notNull(),
    normalizedPayloadJson: text('normalized_payload_json').notNull(),
    nativeBlobRef: text('native_blob_ref'),
    runtimeType: text('runtime_type'),
    runtimeEventId: text('runtime_event_id'),
    connectionEpoch: text('connection_epoch'),
    createdAt: integer('created_at').notNull(),
    receivedAt: integer('received_at').notNull(),
  },
  (table) => [
    uniqueIndex('session_events_stream_sequence_uq').on(table.streamId, table.streamSequence),
    uniqueIndex('session_events_runtime_event_uq').on(
      table.runtimeHandleId,
      table.connectionEpoch,
      table.runtimeEventId,
    ),
  ],
);

export const permissionRequests = sqliteTable(
  'permission_requests',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    turnId: text('turn_id'),
    runtimeHandleId: text('runtime_handle_id').notNull(),
    runtimeRequestId: text('runtime_request_id').notNull(),
    connectionEpoch: text('connection_epoch').notNull(),
    category: text('category').notNull(),
    risk: text('risk').notNull(),
    enforcementLevel: text('enforcement_level').notNull(),
    requestPayloadJson: text('request_payload_json').notNull(),
    status: text('status').notNull(),
    decision: text('decision'),
    decisionScope: text('decision_scope'),
    requestedAt: integer('requested_at').notNull(),
    resolvedAt: integer('resolved_at'),
  },
  (table) => [
    uniqueIndex('permission_requests_runtime_request_uq').on(
      table.runtimeHandleId,
      table.connectionEpoch,
      table.runtimeRequestId,
    ),
  ],
);

export const sessionLifecycleProjections = sqliteTable('session_lifecycle_projections', {
  sessionId: text('session_id').primaryKey(),
  state: text('state').notNull(),
  sourceEventId: text('source_event_id').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const sessionActivityProjections = sqliteTable('session_activity_projections', {
  sessionId: text('session_id').primaryKey(),
  state: text('state').notNull(),
  sourceEventId: text('source_event_id').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const sessionHealthProjections = sqliteTable('session_health_projections', {
  sessionId: text('session_id').primaryKey(),
  state: text('state').notNull(),
  sourceEventId: text('source_event_id').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const workspaceStateProjections = sqliteTable('workspace_state_projections', {
  worktreeId: text('worktree_id').primaryKey(),
  state: text('state').notNull(),
  sourceEventId: text('source_event_id').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const databaseSchema = {
  executionEnvironments,
  projects,
  sessions,
  sessionTurns,
  worktrees,
  processRecords,
  operations,
  blobObjects,
  sessionEvents,
  permissionRequests,
  sessionLifecycleProjections,
  sessionActivityProjections,
  sessionHealthProjections,
  workspaceStateProjections,
};