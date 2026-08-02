import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type {
  BlobObjectRecord,
  ExecutionEnvironment,
  HostSession,
  HostTurn,
  JsonValue,
  OperationRecord,
  PermissionRequestRecord,
  ProcessRecord,
  Project,
  SessionActivity,
  SessionEventRecord,
  SessionHealth,
  SessionLifecycle,
  SessionStateProjection,
  WorkspaceState,
  WorkspaceStateProjection,
  WorktreeRecord,
} from '@tsukiori/domain';
import { RestrictedBlobStore } from './blob-store.js';
import { applyMigrations, LATEST_SCHEMA_VERSION, readMigrationVersions } from './migrations.js';
import { SecretGuard } from './secret-guard.js';
import * as schema from './schema.js';

export type LocalDatabaseOptions = {
  filePath: string;
  blobRoot: string;
  knownSecrets?: readonly string[];
  targetVersion?: number;
};

export class LocalDatabase {
  readonly sqlite: Database.Database;
  readonly orm: BetterSQLite3Database<typeof schema.databaseSchema>;
  readonly blobs: RestrictedBlobStore;
  readonly #guard: SecretGuard;

  constructor(options: LocalDatabaseOptions) {
    const filePath = options.filePath === ':memory:' ? ':memory:' : resolve(options.filePath);
    if (filePath !== ':memory:') mkdirSync(dirname(filePath), { recursive: true });
    this.sqlite = new Database(filePath);
    this.sqlite.pragma('foreign_keys = ON');
    this.sqlite.pragma('busy_timeout = 5000');
    if (filePath !== ':memory:') {
      this.sqlite.pragma('journal_mode = WAL');
      this.sqlite.pragma('synchronous = NORMAL');
    }
    applyMigrations(this.sqlite, options.targetVersion ?? LATEST_SCHEMA_VERSION);
    this.orm = drizzle(this.sqlite, { schema: schema.databaseSchema });
    this.#guard = new SecretGuard(
      options.knownSecrets ? { knownSecrets: options.knownSecrets } : {},
    );
    this.blobs = new RestrictedBlobStore(options.blobRoot, this.#guard);
  }

  get schemaVersions(): number[] {
    return readMigrationVersions(this.sqlite);
  }

  get journalMode(): string {
    const row = this.sqlite.pragma('journal_mode', { simple: true });
    return String(row);
  }

  close(): void {
    this.sqlite.close();
  }

  saveExecutionEnvironment(value: ExecutionEnvironment): void {
    this.#validate(value);
    this.orm.insert(schema.executionEnvironments).values({
      id: value.id, type: value.type, displayName: value.displayName, homePath: value.homePath,
      pathStyle: value.pathStyle, defaultShell: value.defaultShell, gitExecutable: value.gitExecutable,
      capabilitiesJson: this.#json(value.capabilities), gitVersion: value.gitVersion ?? null,
      gitCapabilitiesJson: value.gitCapabilities ? this.#json(value.gitCapabilities) : null,
      lastProbedAt: value.lastProbedAt ?? null, createdAt: value.createdAt, updatedAt: value.updatedAt,
    }).onConflictDoUpdate({ target: schema.executionEnvironments.id, set: {
      type: value.type, displayName: value.displayName, homePath: value.homePath,
      pathStyle: value.pathStyle, defaultShell: value.defaultShell, gitExecutable: value.gitExecutable,
      capabilitiesJson: this.#json(value.capabilities), gitVersion: value.gitVersion ?? null,
      gitCapabilitiesJson: value.gitCapabilities ? this.#json(value.gitCapabilities) : null,
      lastProbedAt: value.lastProbedAt ?? null, updatedAt: value.updatedAt,
    }}).run();
  }

  saveProject(value: Project): void {
    this.#validate(value);
    this.orm.insert(schema.projects).values({
      id: value.id, name: value.name, executionEnvironmentId: value.executionEnvironmentId,
      rootPath: value.rootPath, gitRoot: value.gitRoot, repositoryId: value.repositoryId,
      defaultBranch: value.defaultBranch ?? null, defaultBaseRef: value.defaultBaseRef ?? null,
      setupActionsJson: value.setupActions ? this.#json(value.setupActions) : null,
      cleanupActionsJson: value.cleanupActions ? this.#json(value.cleanupActions) : null,
      canonicalGitDir: value.canonicalGitDir ?? null, currentBranch: value.currentBranch ?? null,
      remoteCount: value.remoteCount ?? null, isDirty: value.isDirty ?? null,
      lastProbedAt: value.lastProbedAt ?? null, createdAt: value.createdAt, updatedAt: value.updatedAt,
    }).onConflictDoUpdate({ target: schema.projects.id, set: {
      name: value.name, rootPath: value.rootPath, gitRoot: value.gitRoot,
      defaultBranch: value.defaultBranch ?? null, defaultBaseRef: value.defaultBaseRef ?? null,
      setupActionsJson: value.setupActions ? this.#json(value.setupActions) : null,
      cleanupActionsJson: value.cleanupActions ? this.#json(value.cleanupActions) : null,
      canonicalGitDir: value.canonicalGitDir ?? null, currentBranch: value.currentBranch ?? null,
      remoteCount: value.remoteCount ?? null, isDirty: value.isDirty ?? null,
      lastProbedAt: value.lastProbedAt ?? null, updatedAt: value.updatedAt,
    }}).run();
  }

  readExecutionEnvironment(id: string): ExecutionEnvironment | null {
    const row = this.sqlite.prepare('SELECT * FROM execution_environments WHERE id=?').get(id) as Record<string, unknown> | undefined;
    return row ? this.#executionEnvironment(row) : null;
  }

  listExecutionEnvironments(): ExecutionEnvironment[] {
    return (this.sqlite.prepare('SELECT * FROM execution_environments ORDER BY display_name, id').all() as Record<string, unknown>[])
      .map((row) => this.#executionEnvironment(row));
  }

  readProject(id: string): Project | null {
    const row = this.sqlite.prepare('SELECT * FROM projects WHERE id=?').get(id) as Record<string, unknown> | undefined;
    return row ? this.#project(row) : null;
  }

  listProjects(): Project[] {
    return (this.sqlite.prepare('SELECT * FROM projects ORDER BY name, id').all() as Record<string, unknown>[])
      .map((row) => this.#project(row));
  }

  deleteProject(id: string): boolean {
    this.#guard.assertText(id);
    return this.sqlite.prepare('DELETE FROM projects WHERE id=?').run(id).changes === 1;
  }
  saveSession(value: HostSession): void {
    this.#validate(value);
    this.orm.insert(schema.sessions).values({
      id: value.id, title: value.title, projectId: value.projectId,
      primaryWorkspaceBindingId: value.primaryWorkspaceBindingId ?? null,
      runtimeType: value.runtimeType, runtimeProfileId: value.runtimeProfileId,
      runtimeSessionId: value.runtimeSessionId ?? null, provider: value.provider ?? null,
      model: value.model ?? null, mode: value.mode ?? null, lifecycle: value.lifecycle,
      activity: value.activity, health: value.health, writeMode: value.writeMode,
      createdAt: value.createdAt, updatedAt: value.updatedAt, archivedAt: value.archivedAt ?? null,
    }).onConflictDoUpdate({ target: schema.sessions.id, set: {
      title: value.title, primaryWorkspaceBindingId: value.primaryWorkspaceBindingId ?? null,
      runtimeSessionId: value.runtimeSessionId ?? null, provider: value.provider ?? null,
      model: value.model ?? null, mode: value.mode ?? null, lifecycle: value.lifecycle,
      activity: value.activity, health: value.health, writeMode: value.writeMode,
      updatedAt: value.updatedAt, archivedAt: value.archivedAt ?? null,
    }}).run();
    this.#upsertProjection(schema.sessionLifecycleProjections, value.id, value.lifecycle, 'session:' + value.id, value.updatedAt);
    this.#upsertProjection(schema.sessionActivityProjections, value.id, value.activity, 'session:' + value.id, value.updatedAt);
    this.#upsertProjection(schema.sessionHealthProjections, value.id, value.health, 'session:' + value.id, value.updatedAt);
  }

  saveTurn(value: HostTurn): void {
    this.#validate(value);
    this.orm.insert(schema.sessionTurns).values({
      id: value.id, sessionId: value.sessionId, runtimeTurnId: value.runtimeTurnId ?? null,
      status: value.status, userInputJson: this.#json(value.userInput),
      startedAt: value.startedAt ?? null, completedAt: value.completedAt ?? null,
    }).onConflictDoUpdate({ target: schema.sessionTurns.id, set: {
      runtimeTurnId: value.runtimeTurnId ?? null, status: value.status,
      userInputJson: this.#json(value.userInput), startedAt: value.startedAt ?? null,
      completedAt: value.completedAt ?? null,
    }}).run();
  }

  saveWorktree(value: WorktreeRecord): void {
    this.#validate(value);
    this.orm.insert(schema.worktrees).values({
      id: value.id, projectId: value.projectId, ownerSessionId: value.ownerSessionId ?? null,
      executionEnvironmentId: value.executionEnvironmentId, path: value.path,
      branchName: value.branchName, baseRef: value.baseRef, baseCommit: value.baseCommit,
      status: value.status, createdAt: value.createdAt, removedAt: value.removedAt ?? null,
    }).onConflictDoUpdate({ target: schema.worktrees.id, set: {
      ownerSessionId: value.ownerSessionId ?? null, path: value.path, branchName: value.branchName,
      baseRef: value.baseRef, baseCommit: value.baseCommit, status: value.status,
      removedAt: value.removedAt ?? null,
    }}).run();
    const workspaceState: WorkspaceState = value.status === 'active' ? 'clean' : value.status;
    this.setWorkspaceState(value.id, workspaceState, 'worktree:' + value.id, value.createdAt);
  }

  saveProcess(value: ProcessRecord): void {
    this.#validate(value);
    this.orm.insert(schema.processRecords).values({
      id: value.id, sessionId: value.sessionId ?? null, runtimeHandleId: value.runtimeHandleId ?? null,
      executionEnvironmentId: value.executionEnvironmentId, processType: value.processType,
      pid: value.pid, parentPid: value.parentPid ?? null, daemonBootId: value.daemonBootId,
      processStartTime: value.processStartTime, processFingerprint: value.processFingerprint ?? null,
      spawnNonce: value.spawnNonce, executable: value.executable ?? null, cwd: value.cwd ?? null,
      status: value.status, startedAt: value.startedAt, exitedAt: value.exitedAt ?? null,
      exitCode: value.exitCode ?? null, signal: value.signal ?? null,
    }).onConflictDoUpdate({ target: schema.processRecords.id, set: {
      pid: value.pid, parentPid: value.parentPid ?? null, processStartTime: value.processStartTime,
      processFingerprint: value.processFingerprint ?? null, status: value.status,
      exitedAt: value.exitedAt ?? null, exitCode: value.exitCode ?? null, signal: value.signal ?? null,
    }}).run();
  }

  saveOperation(value: OperationRecord): void {
    this.#validate(value);
    this.orm.insert(schema.operations).values({
      id: value.id, operationId: value.operationId, type: value.type, sessionId: value.sessionId ?? null,
      status: value.status, requestPayloadJson: this.#json(value.requestPayload),
      resultPayloadJson: value.resultPayload === undefined ? null : this.#json(value.resultPayload),
      errorJson: value.error === undefined ? null : this.#json(value.error),
      createdAt: value.createdAt, updatedAt: value.updatedAt,
    }).onConflictDoUpdate({ target: schema.operations.id, set: {
      status: value.status, resultPayloadJson: value.resultPayload === undefined ? null : this.#json(value.resultPayload),
      errorJson: value.error === undefined ? null : this.#json(value.error), updatedAt: value.updatedAt,
    }}).run();
  }

  appendSessionEvent(value: SessionEventRecord): void {
    this.#validate(value);
    this.orm.insert(schema.sessionEvents).values({
      id: value.id, schemaVersion: value.schemaVersion, scope: value.scope,
      projectId: value.projectId ?? null, runtimeHandleId: value.runtimeHandleId ?? null,
      sessionId: value.sessionId ?? null, turnId: value.turnId ?? null,
      streamId: value.streamId, streamSequence: value.streamSequence,
      sessionSequence: value.sessionSequence ?? null, eventType: value.eventType,
      normalizedPayloadJson: this.#json(value.normalizedPayload), nativeBlobRef: value.nativeBlobRef ?? null,
      runtimeType: value.runtimeType ?? null, runtimeEventId: value.runtimeEventId ?? null,
      connectionEpoch: value.connectionEpoch ?? null, createdAt: value.createdAt, receivedAt: value.receivedAt,
    }).run();
  }

  savePermissionRequest(value: PermissionRequestRecord): void {
    this.#validate(value);
    this.orm.insert(schema.permissionRequests).values({
      id: value.id, sessionId: value.sessionId, turnId: value.turnId ?? null,
      runtimeHandleId: value.runtimeHandleId, runtimeRequestId: value.runtimeRequestId,
      connectionEpoch: value.connectionEpoch, category: value.category, risk: value.risk,
      enforcementLevel: value.enforcementLevel, requestPayloadJson: this.#json(value.requestPayload),
      status: value.status, decision: value.decision ?? null, decisionScope: value.decisionScope ?? null,
      requestedAt: value.requestedAt, resolvedAt: value.resolvedAt ?? null,
    }).onConflictDoUpdate({ target: schema.permissionRequests.id, set: {
      status: value.status, decision: value.decision ?? null,
      decisionScope: value.decisionScope ?? null, resolvedAt: value.resolvedAt ?? null,
    }}).run();
  }

  putBlob(data: Uint8Array, mediaType: string, createdAt = Date.now()): BlobObjectRecord {
    const record = this.blobs.put(data, mediaType, createdAt);
    this.orm.insert(schema.blobObjects).values(record).onConflictDoNothing().run();
    return record;
  }

  setLifecycle(sessionId: string, state: SessionLifecycle, sourceEventId: string, updatedAt: number): void {
    this.#upsertProjection(schema.sessionLifecycleProjections, sessionId, state, sourceEventId, updatedAt);
  }

  setActivity(sessionId: string, state: SessionActivity, sourceEventId: string, updatedAt: number): void {
    this.#upsertProjection(schema.sessionActivityProjections, sessionId, state, sourceEventId, updatedAt);
  }

  setHealth(sessionId: string, state: SessionHealth, sourceEventId: string, updatedAt: number): void {
    this.#upsertProjection(schema.sessionHealthProjections, sessionId, state, sourceEventId, updatedAt);
  }

  setWorkspaceState(worktreeId: string, state: WorkspaceState, sourceEventId: string, updatedAt: number): void {
    this.#guard.assertText(sourceEventId);
    this.orm.insert(schema.workspaceStateProjections).values({
      worktreeId, state, sourceEventId, updatedAt,
    }).onConflictDoUpdate({ target: schema.workspaceStateProjections.worktreeId, set: {
      state, sourceEventId, updatedAt,
    }}).run();
  }

  readSessionProjection(sessionId: string): SessionStateProjection | null {
    const lifecycle = this.orm.select().from(schema.sessionLifecycleProjections)
      .where(eq(schema.sessionLifecycleProjections.sessionId, sessionId)).get();
    const activity = this.orm.select().from(schema.sessionActivityProjections)
      .where(eq(schema.sessionActivityProjections.sessionId, sessionId)).get();
    const health = this.orm.select().from(schema.sessionHealthProjections)
      .where(eq(schema.sessionHealthProjections.sessionId, sessionId)).get();
    if (!lifecycle || !activity || !health) return null;
    return {
      sessionId,
      lifecycle: lifecycle.state as SessionLifecycle,
      activity: activity.state as SessionActivity,
      health: health.state as SessionHealth,
      lifecycleEventId: lifecycle.sourceEventId,
      activityEventId: activity.sourceEventId,
      healthEventId: health.sourceEventId,
      updatedAt: Math.max(lifecycle.updatedAt, activity.updatedAt, health.updatedAt),
    };
  }

  readWorkspaceProjection(worktreeId: string): WorkspaceStateProjection | null {
    const row = this.orm.select().from(schema.workspaceStateProjections)
      .where(eq(schema.workspaceStateProjections.worktreeId, worktreeId)).get();
    if (!row) return null;
    return { worktreeId, state: row.state as WorkspaceState, sourceEventId: row.sourceEventId, updatedAt: row.updatedAt };
  }

  serializeForPersistence(value: unknown): string {
    return this.#guard.serializeJson(value);
  }

  assertPersistenceSafe(value: unknown): void {
    this.#validate(value);
  }
  count(tableName: string): number {
    if (!/^[a-z_]+$/.test(tableName)) throw new Error('Invalid table name');
    const row = this.sqlite.prepare('SELECT COUNT(*) AS count FROM ' + tableName).get() as { count: number };
    return row.count;
  }

  #executionEnvironment(row: Record<string, unknown>): ExecutionEnvironment {
    return {
      id: String(row.id), type: String(row.type) as ExecutionEnvironment['type'],
      displayName: String(row.display_name), homePath: String(row.home_path),
      pathStyle: String(row.path_style) as ExecutionEnvironment['pathStyle'],
      defaultShell: String(row.default_shell), gitExecutable: String(row.git_executable),
      capabilities: JSON.parse(String(row.capabilities_json)) as ExecutionEnvironment['capabilities'],
      ...(row.git_version === null ? {} : { gitVersion: String(row.git_version) }),
      ...(row.git_capabilities_json === null ? {} : {
        gitCapabilities: JSON.parse(String(row.git_capabilities_json)) as NonNullable<ExecutionEnvironment['gitCapabilities']>,
      }),
      ...(row.last_probed_at === null ? {} : { lastProbedAt: Number(row.last_probed_at) }),
      createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    };
  }

  #project(row: Record<string, unknown>): Project {
    return {
      id: String(row.id), name: String(row.name), executionEnvironmentId: String(row.execution_environment_id),
      rootPath: String(row.root_path), gitRoot: String(row.git_root), repositoryId: String(row.repository_id),
      ...(row.default_branch === null ? {} : { defaultBranch: String(row.default_branch) }),
      ...(row.default_base_ref === null ? {} : { defaultBaseRef: String(row.default_base_ref) }),
      ...(row.setup_actions_json === null ? {} : { setupActions: JSON.parse(String(row.setup_actions_json)) as JsonValue[] }),
      ...(row.cleanup_actions_json === null ? {} : { cleanupActions: JSON.parse(String(row.cleanup_actions_json)) as JsonValue[] }),
      ...(row.canonical_git_dir === null ? {} : { canonicalGitDir: String(row.canonical_git_dir) }),
      ...(row.current_branch === null ? {} : { currentBranch: String(row.current_branch) }),
      ...(row.remote_count === null ? {} : { remoteCount: Number(row.remote_count) }),
      ...(row.is_dirty === null ? {} : { isDirty: Boolean(row.is_dirty) }),
      ...(row.last_probed_at === null ? {} : { lastProbedAt: Number(row.last_probed_at) }),
      createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    };
  }
  #validate(value: unknown): void {
    this.#guard.serializeJson(value);
  }

  #json(value: unknown): string {
    return this.#guard.serializeJson(value);
  }

  #upsertProjection(
    table: typeof schema.sessionLifecycleProjections | typeof schema.sessionActivityProjections | typeof schema.sessionHealthProjections,
    sessionId: string,
    state: string,
    sourceEventId: string,
    updatedAt: number,
  ): void {
    this.#guard.assertText(sourceEventId);
    this.orm.insert(table).values({ sessionId, state, sourceEventId, updatedAt })
      .onConflictDoUpdate({ target: table.sessionId, set: { state, sourceEventId, updatedAt } }).run();
  }
}