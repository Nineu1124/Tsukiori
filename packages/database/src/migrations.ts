import type Database from 'better-sqlite3';

export type Migration = {
  version: number;
  name: string;
  sql: string;
};

const migration1 = `
CREATE TABLE execution_environments (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, display_name TEXT NOT NULL,
  home_path TEXT NOT NULL, path_style TEXT NOT NULL, default_shell TEXT NOT NULL,
  git_executable TEXT NOT NULL, capabilities_json TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, execution_environment_id TEXT NOT NULL,
  root_path TEXT NOT NULL, git_root TEXT NOT NULL, repository_id TEXT NOT NULL,
  default_branch TEXT, default_base_ref TEXT, setup_actions_json TEXT, cleanup_actions_json TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  FOREIGN KEY (execution_environment_id) REFERENCES execution_environments(id)
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, project_id TEXT NOT NULL,
  primary_workspace_binding_id TEXT, runtime_type TEXT NOT NULL, runtime_profile_id TEXT NOT NULL,
  runtime_session_id TEXT, provider TEXT, model TEXT, mode TEXT,
  lifecycle TEXT NOT NULL, activity TEXT NOT NULL, health TEXT NOT NULL, write_mode TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER,
  FOREIGN KEY (project_id) REFERENCES projects(id)
);
CREATE TABLE session_turns (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, runtime_turn_id TEXT, status TEXT NOT NULL,
  user_input_json TEXT NOT NULL, started_at INTEGER, completed_at INTEGER,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);
CREATE TABLE worktrees (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, owner_session_id TEXT,
  execution_environment_id TEXT NOT NULL, path TEXT NOT NULL, branch_name TEXT NOT NULL,
  base_ref TEXT NOT NULL, base_commit TEXT NOT NULL, status TEXT NOT NULL,
  created_at INTEGER NOT NULL, removed_at INTEGER,
  FOREIGN KEY (project_id) REFERENCES projects(id),
  FOREIGN KEY (owner_session_id) REFERENCES sessions(id),
  FOREIGN KEY (execution_environment_id) REFERENCES execution_environments(id)
);
CREATE TABLE process_records (
  id TEXT PRIMARY KEY, session_id TEXT, runtime_handle_id TEXT, execution_environment_id TEXT NOT NULL,
  process_type TEXT NOT NULL, pid INTEGER NOT NULL, parent_pid INTEGER,
  daemon_boot_id TEXT NOT NULL, process_start_time INTEGER NOT NULL,
  process_fingerprint TEXT, spawn_nonce TEXT NOT NULL, executable TEXT, cwd TEXT,
  status TEXT NOT NULL, started_at INTEGER NOT NULL, exited_at INTEGER, exit_code INTEGER, signal TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id),
  FOREIGN KEY (execution_environment_id) REFERENCES execution_environments(id)
);
CREATE TABLE operations (
  id TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE, type TEXT NOT NULL, session_id TEXT,
  status TEXT NOT NULL, request_payload_json TEXT NOT NULL, result_payload_json TEXT,
  error_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);
CREATE TABLE blob_objects (
  id TEXT PRIMARY KEY, content_hash TEXT NOT NULL UNIQUE, relative_path TEXT NOT NULL UNIQUE,
  byte_length INTEGER NOT NULL, media_type TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE session_events (
  id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, scope TEXT NOT NULL,
  project_id TEXT, runtime_handle_id TEXT, session_id TEXT, turn_id TEXT,
  stream_id TEXT NOT NULL, stream_sequence INTEGER NOT NULL, session_sequence INTEGER,
  event_type TEXT NOT NULL, normalized_payload_json TEXT NOT NULL, native_blob_ref TEXT,
  runtime_type TEXT, runtime_event_id TEXT, connection_epoch TEXT,
  created_at INTEGER NOT NULL, received_at INTEGER NOT NULL,
  UNIQUE(stream_id, stream_sequence),
  FOREIGN KEY (project_id) REFERENCES projects(id),
  FOREIGN KEY (session_id) REFERENCES sessions(id),
  FOREIGN KEY (turn_id) REFERENCES session_turns(id),
  FOREIGN KEY (native_blob_ref) REFERENCES blob_objects(id)
);
CREATE UNIQUE INDEX session_events_runtime_event_uq
  ON session_events(runtime_handle_id, connection_epoch, runtime_event_id);
CREATE TABLE permission_requests (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_id TEXT,
  runtime_handle_id TEXT NOT NULL, runtime_request_id TEXT NOT NULL, connection_epoch TEXT NOT NULL,
  category TEXT NOT NULL, risk TEXT NOT NULL, enforcement_level TEXT NOT NULL,
  request_payload_json TEXT NOT NULL, status TEXT NOT NULL, decision TEXT, decision_scope TEXT,
  requested_at INTEGER NOT NULL, resolved_at INTEGER,
  UNIQUE(runtime_handle_id, connection_epoch, runtime_request_id),
  FOREIGN KEY (session_id) REFERENCES sessions(id),
  FOREIGN KEY (turn_id) REFERENCES session_turns(id)
);
`;

const migration2 = `
CREATE TABLE session_lifecycle_projections (
  session_id TEXT PRIMARY KEY, state TEXT NOT NULL, source_event_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL, FOREIGN KEY (session_id) REFERENCES sessions(id)
);
CREATE TABLE session_activity_projections (
  session_id TEXT PRIMARY KEY, state TEXT NOT NULL, source_event_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL, FOREIGN KEY (session_id) REFERENCES sessions(id)
);
CREATE TABLE session_health_projections (
  session_id TEXT PRIMARY KEY, state TEXT NOT NULL, source_event_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL, FOREIGN KEY (session_id) REFERENCES sessions(id)
);
CREATE TABLE workspace_state_projections (
  worktree_id TEXT PRIMARY KEY, state TEXT NOT NULL, source_event_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL, FOREIGN KEY (worktree_id) REFERENCES worktrees(id)
);
`;

const migration3 = `
CREATE TABLE permission_rules (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT,
  category TEXT NOT NULL, enforcement_level TEXT NOT NULL, matcher_json TEXT NOT NULL,
  decision TEXT NOT NULL, source_request_id TEXT NOT NULL, enabled INTEGER NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);
CREATE INDEX permission_rules_lookup_idx
  ON permission_rules(project_id, session_id, category, enabled);
CREATE TABLE permission_audit (
  id TEXT PRIMARY KEY, request_id TEXT NOT NULL, session_id TEXT NOT NULL, project_id TEXT NOT NULL,
  connection_epoch TEXT NOT NULL, category TEXT NOT NULL, risk TEXT NOT NULL,
  enforcement_level TEXT NOT NULL, decision TEXT NOT NULL, decision_scope TEXT NOT NULL,
  rule_id TEXT, reason TEXT, created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id),
  FOREIGN KEY (project_id) REFERENCES projects(id),
  FOREIGN KEY (rule_id) REFERENCES permission_rules(id)
);
CREATE INDEX permission_audit_request_idx ON permission_audit(request_id, created_at);
CREATE TABLE attention_items (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, project_id TEXT NOT NULL,
  kind TEXT NOT NULL, status TEXT NOT NULL, title TEXT NOT NULL, risk TEXT,
  source_ref TEXT NOT NULL, payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, resolved_at INTEGER,
  UNIQUE(kind, source_ref),
  FOREIGN KEY (session_id) REFERENCES sessions(id),
  FOREIGN KEY (project_id) REFERENCES projects(id)
);
CREATE INDEX attention_items_inbox_idx ON attention_items(status, updated_at DESC);
`;
const migration4 = `
ALTER TABLE execution_environments ADD COLUMN git_version TEXT;
ALTER TABLE execution_environments ADD COLUMN git_capabilities_json TEXT;
ALTER TABLE execution_environments ADD COLUMN last_probed_at INTEGER;
ALTER TABLE projects ADD COLUMN canonical_git_dir TEXT;
ALTER TABLE projects ADD COLUMN current_branch TEXT;
ALTER TABLE projects ADD COLUMN remote_count INTEGER;
ALTER TABLE projects ADD COLUMN is_dirty INTEGER;
ALTER TABLE projects ADD COLUMN last_probed_at INTEGER;
CREATE UNIQUE INDEX projects_repository_id_uq ON projects(repository_id);
`;
const migration5 = `
CREATE TABLE workspace_bindings (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL,
  worktree_id TEXT NOT NULL, execution_environment_id TEXT NOT NULL,
  binding_type TEXT NOT NULL, status TEXT NOT NULL, path TEXT NOT NULL,
  base_commit TEXT NOT NULL, last_known_commit TEXT, cleanup_state TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER,
  FOREIGN KEY (session_id) REFERENCES sessions(id),
  FOREIGN KEY (project_id) REFERENCES projects(id),
  FOREIGN KEY (worktree_id) REFERENCES worktrees(id),
  FOREIGN KEY (execution_environment_id) REFERENCES execution_environments(id)
);
CREATE INDEX workspace_bindings_worktree_idx ON workspace_bindings(worktree_id, status);
CREATE TABLE action_audit (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT NOT NULL, worktree_id TEXT NOT NULL,
  phase TEXT NOT NULL, action_index INTEGER NOT NULL, action_type TEXT NOT NULL,
  executable TEXT, shell_type TEXT, script_hash TEXT, approval_source TEXT,
  status TEXT NOT NULL, exit_code INTEGER, timed_out INTEGER,
  diagnostic_json TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER,
  FOREIGN KEY (project_id) REFERENCES projects(id),
  FOREIGN KEY (session_id) REFERENCES sessions(id),
  FOREIGN KEY (worktree_id) REFERENCES worktrees(id)
);
CREATE INDEX action_audit_workspace_idx ON action_audit(worktree_id, phase, started_at);
`;
export const migrations: readonly Migration[] = [
  { version: 1, name: 'core_records', sql: migration1 },
  { version: 2, name: 'orthogonal_state_projections', sql: migration2 },
  { version: 3, name: 'permission_and_attention', sql: migration3 },
  { version: 4, name: 'project_git_probe_metadata', sql: migration4 },
  { version: 5, name: 'workspace_binding_and_action_audit', sql: migration5 },
];

export const LATEST_SCHEMA_VERSION = migrations.at(-1)?.version ?? 0;

export function applyMigrations(
  database: Database.Database,
  targetVersion = LATEST_SCHEMA_VERSION,
): number[] {
  if (!Number.isInteger(targetVersion) || targetVersion < 0 || targetVersion > LATEST_SCHEMA_VERSION) {
    throw new Error('Invalid database target version');
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);
  const applied = new Set(
    database.prepare('SELECT version FROM schema_migrations').all()
      .map((row) => (row as { version: number }).version),
  );
  const newlyApplied: number[] = [];
  for (const migration of migrations) {
    if (migration.version > targetVersion || applied.has(migration.version)) continue;
    database.transaction(() => {
      database.exec(migration.sql);
      database.prepare(
        'INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)',
      ).run(migration.version, migration.name, Date.now());
      database.pragma('user_version = ' + migration.version);
    })();
    newlyApplied.push(migration.version);
  }
  return newlyApplied;
}

export function readMigrationVersions(database: Database.Database): number[] {
  const exists = database.prepare(
    "SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
  ).get();
  if (!exists) return [];
  return database.prepare('SELECT version FROM schema_migrations ORDER BY version').all()
    .map((row) => (row as { version: number }).version);
}