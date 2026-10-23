import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { types } from 'node:util';
import { parseWorkspaceState, type WorkspaceStateDocument } from './workspace-state-file.js';

// This schema stores the formal desktop aggregate. The domain/prototype database
// has a different session contract and is not silently adopted or populated here.
export const WORKSPACE_SQLITE_VERSION = 1;
const APPLICATION_ID = 0x54534b57;
const EVENT_BYTES = 16 * 1024 * 1024;
const ROW_BYTES = 1024 * 1024;
type Row = Record<string, unknown>;
type SynchronousResult<T> = T & (Extract<T, PromiseLike<unknown>> extends never ? unknown : never);

export type WorkspaceMigrationRun = {
  sourceHash: string;
  importedAt: number;
  counts: { projects: number; sessions: number; events: number };
  phase: 'state' | 'events' | 'complete';
  backupName?: string;
};

export class WorkspaceStorageError extends Error {
  constructor(readonly reason: 'unsupported_version' | 'invalid_schema' | 'invalid_data' | 'unavailable') {
    const detail = {
      unsupported_version: '存储版本不兼容，请使用对应版本打开',
      invalid_schema: '存储结构损坏或属于其他应用',
      invalid_data: '数据不完整、关联冲突或包含不能保存的字段',
      unavailable: '无法读取或保存，请检查磁盘和权限',
    }[reason];
    super(`工作区存储失败：${detail}。原有数据已保留，请备份后处理。`);
    this.name = 'WorkspaceStorageError';
  }
}

const schema = `
CREATE TABLE workspace_header (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  document_version INTEGER NOT NULL CHECK(document_version IN (1,2,3)),
  settings_json TEXT CHECK(settings_json IS NULL OR (json_valid(settings_json) AND json_type(settings_json) = 'object'))
) STRICT;
CREATE TABLE workspace_projects (
  id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
  position INTEGER NOT NULL DEFAULT 0 CHECK(position >= 0),
  payload TEXT NOT NULL CHECK(json_valid(payload) AND json_type(payload) = 'object'
    AND json_type(payload, '$.id') IS 'text' AND json_extract(payload, '$.id') = id)
) STRICT;
CREATE TABLE workspace_sessions (
  id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
  position INTEGER NOT NULL DEFAULT 0 CHECK(position >= 0),
  project_id TEXT NOT NULL REFERENCES workspace_projects(id) ON DELETE CASCADE,
  payload TEXT NOT NULL CHECK(json_valid(payload) AND json_type(payload) = 'object'
    AND json_type(payload, '$.id') IS 'text' AND json_extract(payload, '$.id') = id
    AND json_type(payload, '$.projectId') IS 'text' AND json_extract(payload, '$.projectId') = project_id),
  UNIQUE(id, project_id)
) STRICT;
CREATE TABLE workspace_providers (
  id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
  position INTEGER NOT NULL DEFAULT 0 CHECK(position >= 0),
  payload TEXT NOT NULL CHECK(json_valid(payload) AND json_type(payload) = 'object'
    AND json_type(payload, '$.id') IS 'text' AND json_extract(payload, '$.id') = id)
) STRICT;
CREATE TABLE workspace_teams (
  id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
  position INTEGER NOT NULL DEFAULT 0 CHECK(position >= 0),
  project_id TEXT NOT NULL REFERENCES workspace_projects(id) ON DELETE CASCADE,
  payload TEXT NOT NULL CHECK(json_valid(payload) AND json_type(payload) = 'object'
    AND json_type(payload, '$.id') IS 'text' AND json_extract(payload, '$.id') = id
    AND json_type(payload, '$.projectId') IS 'text' AND json_extract(payload, '$.projectId') = project_id),
  UNIQUE(id, project_id)
) STRICT;
CREATE TABLE workspace_team_members (
  team_id TEXT NOT NULL, project_id TEXT NOT NULL, session_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK(position >= 0),
  PRIMARY KEY(team_id, session_id), UNIQUE(team_id, position),
  FOREIGN KEY(team_id, project_id) REFERENCES workspace_teams(id, project_id) ON DELETE CASCADE,
  FOREIGN KEY(session_id, project_id) REFERENCES workspace_sessions(id, project_id) ON DELETE CASCADE
) STRICT;
CREATE TABLE workspace_events (
  session_id TEXT NOT NULL REFERENCES workspace_sessions(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL CHECK(length(trim(event_id)) > 0),
  ordinal INTEGER NOT NULL CHECK(ordinal > 0),
  payload TEXT NOT NULL CHECK(json_valid(payload) AND json_type(payload) = 'object'
    AND json_type(payload, '$.id') IS 'text' AND json_extract(payload, '$.id') = event_id
    AND json_type(payload, '$.sessionId') IS 'text' AND json_extract(payload, '$.sessionId') = session_id),
  PRIMARY KEY(session_id, event_id), UNIQUE(session_id, ordinal)
) STRICT;
CREATE TABLE workspace_migration_runs (
  source_hash TEXT PRIMARY KEY CHECK(length(source_hash) = 64 AND source_hash NOT GLOB '*[^0-9a-f]*'),
  imported_at INTEGER NOT NULL CHECK(imported_at >= 0),
  project_count INTEGER NOT NULL CHECK(project_count >= 0),
  session_count INTEGER NOT NULL CHECK(session_count >= 0),
  event_count INTEGER NOT NULL CHECK(event_count >= 0),
  phase TEXT NOT NULL CHECK(phase IN ('state','events','complete')),
  backup_name TEXT
) STRICT;
PRAGMA application_id = ${APPLICATION_ID};
PRAGMA user_version = ${WORKSPACE_SQLITE_VERSION};
`;

const tables = ['workspace_header', 'workspace_projects', 'workspace_sessions', 'workspace_providers',
  'workspace_teams', 'workspace_team_members', 'workspace_events', 'workspace_migration_runs'];

export class WorkspaceSqliteStore {
  readonly #database: DatabaseSync;
  #depth = 0;
  #serial = 0;
  #closed = false;

  constructor(path: string) {
    const file = path === ':memory:' ? path : resolve(path);
    const existed = file !== ':memory:' && existsSync(file);
    let database: DatabaseSync | undefined;
    try {
      if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
      database = new DatabaseSync(file);
      this.#database = database;
      database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
      const version = Number(database.prepare('PRAGMA user_version').get()?.user_version);
      const application = Number(database.prepare('PRAGMA application_id').get()?.application_id);
      if (existed || version || application) {
        if (application !== APPLICATION_ID) throw new WorkspaceStorageError('invalid_schema');
        if (version !== WORKSPACE_SQLITE_VERSION) throw new WorkspaceStorageError('unsupported_version');
        const actualTables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
          .map((row) => String(row.name)).sort();
        if (JSON.stringify(actualTables) !== JSON.stringify([...tables].sort())
          || database.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok'
          || database.prepare('PRAGMA foreign_key_check').all().length) throw new WorkspaceStorageError('invalid_schema');
      } else {
        this.transaction(() => database!.exec(schema));
      }
      database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
      // Validate persisted relationships before any caller can write defaults.
      this.readState();
    } catch (error) {
      database?.close();
      if (error instanceof WorkspaceStorageError) throw error;
      throw new WorkspaceStorageError('unavailable');
    }
  }

  close(): void {
    if (!this.#closed) { this.#database.close(); this.#closed = true; }
  }

  transaction<T>(callback: () => SynchronousResult<T>): T {
    // Reject native async callbacks before they can run up to their first await.
    // Inspecting only their returned Promise would leave a live continuation.
    if (types.isAsyncFunction(callback) || Object.prototype.toString.call(callback) === '[object AsyncFunction]') invalid();
    const nested = this.#depth > 0;
    const savepoint = `workspace_tx_${++this.#serial}`;
    this.#database.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
    this.#depth++;
    try {
      const result = callback();
      if (result && typeof (result as { then?: unknown }).then === 'function') throw new WorkspaceStorageError('invalid_data');
      this.#database.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
      return result;
    } catch (error) {
      this.#database.exec(nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK');
      throw error;
    } finally { this.#depth--; }
  }

  transactions<T>(callback: () => SynchronousResult<T>): T { return this.transaction<T>(callback); }

  readState(): WorkspaceStateDocument | undefined {
    return this.#safe(() => {
      const header = this.#database.prepare('SELECT * FROM workspace_header WHERE singleton = 1').get();
      if (!header) {
        if (['workspace_projects', 'workspace_sessions', 'workspace_providers', 'workspace_teams'].some((table) =>
          Number(this.#database.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count) > 0)) invalid();
        return undefined;
      }
      const read = (table: string) => this.#database.prepare(`SELECT payload FROM ${table} ORDER BY position,id`).all()
        .map((row) => JSON.parse(String(row.payload)) as Row);
      const version = Number(header.document_version);
      const value = {
        schemaVersion: version, projects: read('workspace_projects'), sessions: read('workspace_sessions'),
        ...(version >= 2 ? { settings: JSON.parse(String(header.settings_json)), providers: read('workspace_providers') } : {}),
        ...(version >= 3 ? { teams: read('workspace_teams') } : {}),
      };
      const document = parseWorkspaceState(safeJson(value, Number.MAX_SAFE_INTEGER), 'workspace.sqlite');
      for (const team of document.teams ?? []) {
        const members = this.#database.prepare('SELECT session_id FROM workspace_team_members WHERE team_id = ? ORDER BY position').all(String(team.id));
        if (JSON.stringify(members.map((member) => member.session_id)) !== JSON.stringify(team.memberSessionIds)) invalid();
      }
      return document;
    });
  }

  saveState(value: WorkspaceStateDocument): void {
    this.#safe(() => {
      const document = parseWorkspaceState(safeJson(value, Number.MAX_SAFE_INTEGER), 'workspace.sqlite');
      const projects = document.projects.map((row, position) => [String(row.id), position, safeJson(row, ROW_BYTES)] as const);
      const sessions = document.sessions.map((row, position) => [String(row.id), position, String(row.projectId), safeJson(row, ROW_BYTES)] as const);
      const providers = (document.providers ?? []).map((row, position) => [String(row.id), position, safeJson(row, ROW_BYTES)] as const);
      const teams = (document.teams ?? []).map((row, position) => [String(row.id), position, String(row.projectId), safeJson(row, ROW_BYTES)] as const);
      const settings = document.schemaVersion >= 2 ? safeJson(document.settings, ROW_BYTES) : null;
      this.transaction(() => {
        this.#database.exec('DELETE FROM workspace_team_members');
        const project = this.#database.prepare('INSERT INTO workspace_projects(id,position,payload) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET position=excluded.position,payload=excluded.payload');
        for (const row of projects) project.run(...row);
        const session = this.#database.prepare('INSERT INTO workspace_sessions(id,position,project_id,payload) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET position=excluded.position,project_id=excluded.project_id,payload=excluded.payload');
        for (const row of sessions) session.run(...row);
        const provider = this.#database.prepare('INSERT INTO workspace_providers(id,position,payload) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET position=excluded.position,payload=excluded.payload');
        for (const row of providers) provider.run(...row);
        const team = this.#database.prepare('INSERT INTO workspace_teams(id,position,project_id,payload) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET position=excluded.position,project_id=excluded.project_id,payload=excluded.payload');
        for (const row of teams) team.run(...row);
        const member = this.#database.prepare('INSERT INTO workspace_team_members(team_id,project_id,session_id,position) VALUES (?,?,?,?)');
        for (const row of document.teams ?? []) {
          (row.memberSessionIds as string[]).forEach((id, position) => member.run(String(row.id), String(row.projectId), id, position));
        }
        this.#deleteMissing('workspace_teams', new Set(teams.map(([id]) => id)));
        this.#deleteMissing('workspace_sessions', new Set(sessions.map(([id]) => id)));
        this.#deleteMissing('workspace_projects', new Set(projects.map(([id]) => id)));
        this.#deleteMissing('workspace_providers', new Set(providers.map(([id]) => id)));
        this.#database.prepare('INSERT INTO workspace_header(singleton,document_version,settings_json) VALUES (1,?,?) ON CONFLICT(singleton) DO UPDATE SET document_version=excluded.document_version,settings_json=excluded.settings_json')
          .run(document.schemaVersion, settings);
      });
    });
  }

  readEvents(sessionId: string): string[] {
    return this.#safe(() => {
      this.#assertSession(sessionId);
      return this.#database.prepare('SELECT payload FROM workspace_events WHERE session_id = ? ORDER BY ordinal').all(sessionId)
        .map((row) => parseEvent(sessionId, String(row.payload)).json);
    });
  }

  appendEvent(sessionId: string, eventJSON: string): void {
    this.#safe(() => {
      const event = parseEvent(sessionId, eventJSON);
      this.transaction(() => {
        this.#assertSession(sessionId);
        const existing = this.#database.prepare('SELECT payload FROM workspace_events WHERE session_id = ? AND event_id = ?').get(sessionId, event.id);
        if (existing) { if (existing.payload !== event.json) invalid(); return; }
        const ordinal = Number(this.#database.prepare('SELECT coalesce(max(ordinal),0)+1 AS ordinal FROM workspace_events WHERE session_id = ?').get(sessionId)?.ordinal);
        this.#database.prepare('INSERT INTO workspace_events(session_id,event_id,ordinal,payload) VALUES (?,?,?,?)').run(sessionId, event.id, ordinal, event.json);
      });
    });
  }

  replaceEvents(sessionId: string, eventJSONs: readonly string[]): void {
    this.#safe(() => {
      const events = eventJSONs.map((json) => parseEvent(sessionId, json));
      if (new Set(events.map((event) => event.id)).size !== events.length) invalid();
      this.transaction(() => {
        this.#assertSession(sessionId);
        this.#database.prepare('DELETE FROM workspace_events WHERE session_id = ?').run(sessionId);
        const insert = this.#database.prepare('INSERT INTO workspace_events(session_id,event_id,ordinal,payload) VALUES (?,?,?,?)');
        events.forEach((event, index) => insert.run(sessionId, event.id, index + 1, event.json));
      });
    });
  }

  removeEvents(sessionId: string): void {
    this.#safe(() => { this.#database.prepare('DELETE FROM workspace_events WHERE session_id = ?').run(sessionId); });
  }

  readMigrationRun(sourceHash: string): WorkspaceMigrationRun | undefined {
    if (!/^[0-9a-f]{64}$/.test(sourceHash)) invalid();
    return this.listMigrationRuns().find((record) => record.sourceHash === sourceHash);
  }

  listMigrationRuns(): WorkspaceMigrationRun[] {
    return this.#safe(() => this.#database.prepare('SELECT * FROM workspace_migration_runs ORDER BY imported_at,source_hash').all().map((row) => ({
      sourceHash: String(row.source_hash), importedAt: Number(row.imported_at),
      counts: { projects: Number(row.project_count), sessions: Number(row.session_count), events: Number(row.event_count) },
      phase: String(row.phase) as WorkspaceMigrationRun['phase'],
      ...(row.backup_name === null ? {} : { backupName: String(row.backup_name) }),
    })));
  }

  writeMigrationRun(value: WorkspaceMigrationRun): void {
    this.#safe(() => {
      if (!value || !/^[0-9a-f]{64}$/.test(value.sourceHash) || !integer(value.importedAt)
        || !value.counts || !Object.values(value.counts).every(integer)
        || !['projects', 'sessions', 'events'].every((key) => integer((value.counts as Row)[key]))
        || !['state', 'events', 'complete'].includes(value.phase)
        || (value.backupName !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(value.backupName))) invalid();
      safeJson(value, ROW_BYTES);
      this.#database.prepare(`INSERT INTO workspace_migration_runs(source_hash,imported_at,project_count,session_count,event_count,phase,backup_name)
        VALUES (?,?,?,?,?,?,?) ON CONFLICT(source_hash) DO UPDATE SET imported_at=excluded.imported_at,project_count=excluded.project_count,
        session_count=excluded.session_count,event_count=excluded.event_count,phase=excluded.phase,backup_name=excluded.backup_name`)
        .run(value.sourceHash, value.importedAt, value.counts.projects, value.counts.sessions, value.counts.events, value.phase, value.backupName ?? null);
    });
  }

  #deleteMissing(table: string, ids: Set<string>): void {
    const remove = this.#database.prepare(`DELETE FROM ${table} WHERE id = ?`);
    for (const row of this.#database.prepare(`SELECT id FROM ${table}`).all()) if (!ids.has(String(row.id))) remove.run(String(row.id));
  }

  #assertSession(sessionId: string): void {
    if (!this.#database.prepare('SELECT 1 FROM workspace_sessions WHERE id = ?').get(sessionId)) invalid();
  }

  #safe<T>(action: () => T): T {
    try { return action(); } catch (error) {
      if (error instanceof WorkspaceStorageError) throw error;
      if (error instanceof Error && error.name === 'WorkspaceStateError') throw new WorkspaceStorageError('invalid_data');
      throw new WorkspaceStorageError('unavailable');
    }
  }
}

function integer(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0; }
function invalid(): never { throw new WorkspaceStorageError('invalid_data'); }
function object(value: unknown): value is Row { return value !== null && typeof value === 'object' && !Array.isArray(value); }

function parseEvent(sessionId: string, json: string): { id: string; json: string } {
  if (typeof json !== 'string' || Buffer.byteLength(json) > EVENT_BYTES) invalid();
  let event: unknown;
  try { event = JSON.parse(json); } catch { return invalid(); }
  if (!object(event) || event.sessionId !== sessionId || typeof event.id !== 'string' || !event.id.trim()
    || typeof event.type !== 'string' || !event.type.trim() || !integer(event.createdAt) || !object(event.payload)) invalid();
  if (event.schemaVersion !== undefined && event.schemaVersion !== 1) throw new WorkspaceStorageError('unsupported_version');
  // These are normalized conversation events, including complete model messages
  // and redacted tool fields. Their producers own message/error redaction. Do not
  // treat tutorial text or fields named "token" as provider configuration here.
  return { id: event.id, json: safeJson(event, EVENT_BYTES, 'conversation') };
}

function safeJson(value: unknown, maxBytes: number, domain: 'configuration' | 'conversation' = 'configuration'): string {
  const credential = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+\/-]{12,}={0,2}\b|\bsk-[A-Za-z0-9_-]{16,}\b|\bAKIA[0-9A-Z]{16}\b/i;
  const forbidden = /(^|[_-])(api[_-]?key|secret|token|password|passwd|cookie|authorization|private[_-]?key)([_-]|$)/i;
  const seen = new Set<object>();
  function inspect(item: unknown, depth: number): void {
    if (depth > 64) invalid();
    if (typeof item === 'string') { if (domain === 'configuration' && credential.test(item)) invalid(); return; }
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'number') { if (!Number.isFinite(item)) invalid(); return; }
    if (typeof item !== 'object' || seen.has(item)) invalid();
    seen.add(item);
    if (Array.isArray(item)) item.forEach((child) => inspect(child, depth + 1));
    else for (const [key, child] of Object.entries(item)) {
      if (domain === 'configuration') {
        if (forbidden.test(key)) invalid();
        if (key === 'secretRef' && (typeof child !== 'string' || !/^secretref:[^\s]{1,512}$/.test(child))) invalid();
      }
      inspect(child, depth + 1);
    }
    seen.delete(item);
  }
  inspect(value, 0);
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > maxBytes) invalid();
  return json;
}
