import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type {
  ActionAuditRecord,
  BlobObjectRecord,
  ExecutionEnvironment,
  HostSession,
  HostTurn,
  JsonValue,
  OperationRecord,
  PermissionRequestRecord,
  ProcessRecord,
  Project,
  RuntimeAuditRecord,
  RuntimeHandleRecord,
  RuntimeProfileRecord,
  SessionActivity,
  SessionEventRecord,
  SessionHealth,
  SessionLifecycle,
  SessionStateProjection,
  WorkspaceState,
  WorkspaceBindingRecord,
  WorkspaceStateProjection,
  WorktreeAction,
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
  backupRoot?: string;
  beforeMigration?: (version: number, name: string) => void;
};

export class LocalDatabase {
  readonly sqlite: Database.Database;
  readonly orm: BetterSQLite3Database<typeof schema.databaseSchema>;
  readonly blobs: RestrictedBlobStore;
  readonly #guard: SecretGuard;
  readonly lastMigrationBackup: string | null;

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
    const targetVersion = options.targetVersion ?? LATEST_SCHEMA_VERSION;
    const currentVersion = Number(this.sqlite.pragma('user_version', { simple: true }) ?? 0);
    this.lastMigrationBackup = filePath !== ':memory:' && currentVersion > 0 && targetVersion > currentVersion
      ? this.#backupBeforeMigration(filePath, options.backupRoot)
      : null;
    try {
      applyMigrations(this.sqlite, targetVersion, {
        ...(options.beforeMigration ? {
          beforeMigration: (migration) => options.beforeMigration?.(migration.version, migration.name),
        } : {}),
      });
    } catch (error) {
      this.sqlite.close();
      throw error;
    }
    this.orm = drizzle(this.sqlite, { schema: schema.databaseSchema });
    this.#guard = new SecretGuard(
      options.knownSecrets ? { knownSecrets: options.knownSecrets } : {},
    );
    this.blobs = new RestrictedBlobStore(options.blobRoot, this.#guard);
  }

  #backupBeforeMigration(filePath: string, backupRoot?: string): string {
    const root = resolve(backupRoot ?? join(dirname(filePath), 'backups'));
    mkdirSync(root, { recursive: true });
    const token = Date.now() + '-' + randomUUID();
    const backup = join(root, 'state-' + token + '.db');
    const escaped = backup.replaceAll("'", "''");
    this.sqlite.exec("VACUUM INTO '" + escaped + "'");
    writeFileSync(join(root, 'state-' + token + '.json'), JSON.stringify({
      schemaVersion: 1,
      source: '<local-database>',
      backupFile: 'state-' + token + '.db',
      createdAt: '<timestamp>',
    }), { encoding: 'utf8', mode: 0o600 });
    return backup;
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
  readSession(id: string): HostSession | null {
    const row = this.sqlite.prepare('SELECT * FROM sessions WHERE id=?').get(id) as Record<string, unknown> | undefined;
    return row ? this.#session(row) : null;
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

  readProcess(id: string): ProcessRecord | null {
    const row = this.sqlite.prepare('SELECT * FROM process_records WHERE id=?').get(id) as Record<string, unknown> | undefined;
    return row ? this.#process(row) : null;
  }

  listProcesses(statuses?: readonly ProcessRecord['status'][]): ProcessRecord[] {
    const rows = this.sqlite.prepare('SELECT * FROM process_records ORDER BY started_at, id').all() as Record<string, unknown>[];
    const allowed = statuses ? new Set(statuses) : null;
    return rows.map((row) => this.#process(row)).filter((record) => !allowed || allowed.has(record.status));
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

  readOperation(id: string): OperationRecord | null {
    const row = this.sqlite.prepare('SELECT * FROM operations WHERE id=? OR operation_id=?').get(id, id) as Record<string, unknown> | undefined;
    return row ? this.#operation(row) : null;
  }

  listOperations(statuses?: readonly OperationRecord['status'][]): OperationRecord[] {
    const rows = this.sqlite.prepare('SELECT * FROM operations ORDER BY created_at, id').all() as Record<string, unknown>[];
    const allowed = statuses ? new Set(statuses) : null;
    return rows.map((row) => this.#operation(row)).filter((operation) => !allowed || allowed.has(operation.status));
  }

  readWorktree(id: string): WorktreeRecord | null {
    const row = this.sqlite.prepare('SELECT * FROM worktrees WHERE id=?').get(id) as Record<string, unknown> | undefined;
    return row ? this.#worktree(row) : null;
  }

  listWorktrees(projectId?: string): WorktreeRecord[] {
    const rows = (projectId === undefined
      ? this.sqlite.prepare('SELECT * FROM worktrees ORDER BY created_at, id').all()
      : this.sqlite.prepare('SELECT * FROM worktrees WHERE project_id=? ORDER BY created_at, id').all(projectId)
    ) as Record<string, unknown>[];
    return rows.map((row) => this.#worktree(row));
  }
  saveWorkspaceBinding(value: WorkspaceBindingRecord): void {
    this.#validate(value);
    this.orm.insert(schema.workspaceBindings).values({
      id: value.id, sessionId: value.sessionId, projectId: value.projectId,
      worktreeId: value.worktreeId, executionEnvironmentId: value.executionEnvironmentId,
      bindingType: value.bindingType, status: value.status, path: value.path,
      baseCommit: value.baseCommit, lastKnownCommit: value.lastKnownCommit ?? null,
      cleanupState: value.cleanupState, createdAt: value.createdAt, updatedAt: value.updatedAt,
      archivedAt: value.archivedAt ?? null,
    }).onConflictDoUpdate({ target: schema.workspaceBindings.id, set: {
      status: value.status, path: value.path, lastKnownCommit: value.lastKnownCommit ?? null,
      cleanupState: value.cleanupState, updatedAt: value.updatedAt, archivedAt: value.archivedAt ?? null,
    }}).run();
  }

  readWorkspaceBinding(id: string): WorkspaceBindingRecord | null {
    const row = this.sqlite.prepare('SELECT * FROM workspace_bindings WHERE id=? OR session_id=?')
      .get(id, id) as Record<string, unknown> | undefined;
    return row ? this.#workspaceBinding(row) : null;
  }

  listWorkspaceBindings(projectId?: string): WorkspaceBindingRecord[] {
    const rows = (projectId === undefined
      ? this.sqlite.prepare('SELECT * FROM workspace_bindings ORDER BY created_at, id').all()
      : this.sqlite.prepare('SELECT * FROM workspace_bindings WHERE project_id=? ORDER BY created_at, id').all(projectId)
    ) as Record<string, unknown>[];
    return rows.map((row) => this.#workspaceBinding(row));
  }

  saveActionAudit(value: ActionAuditRecord): void {
    this.#validate(value);
    this.orm.insert(schema.actionAudit).values({
      id: value.id, projectId: value.projectId, sessionId: value.sessionId,
      worktreeId: value.worktreeId, phase: value.phase, actionIndex: value.actionIndex,
      actionType: value.actionType, executable: value.executable ?? null,
      shellType: value.shellType ?? null, scriptHash: value.scriptHash ?? null,
      approvalSource: value.approvalSource ?? null, status: value.status,
      exitCode: value.exitCode ?? null, timedOut: value.timedOut ?? null,
      diagnosticJson: this.#json(value.diagnostic), startedAt: value.startedAt,
      finishedAt: value.finishedAt ?? null,
    }).onConflictDoUpdate({ target: schema.actionAudit.id, set: {
      status: value.status, exitCode: value.exitCode ?? null, timedOut: value.timedOut ?? null,
      diagnosticJson: this.#json(value.diagnostic), finishedAt: value.finishedAt ?? null,
    }}).run();
  }

  listActionAudits(worktreeId: string): ActionAuditRecord[] {
    return (this.sqlite.prepare('SELECT * FROM action_audit WHERE worktree_id=? ORDER BY started_at, action_index, id')
      .all(worktreeId) as Record<string, unknown>[]).map((row) => this.#actionAudit(row));
  }
  saveRuntimeProfile(value: RuntimeProfileRecord): void {
    this.#validate(value);
    this.orm.insert(schema.runtimeProfiles).values({
      id: value.id, runtimeType: value.runtimeType, executionEnvironmentId: value.executionEnvironmentId,
      executablePath: value.executablePath, launchPrefixJson: this.#json(value.launchPrefix),
      discoverySource: value.discoverySource, discoveredVersion: value.discoveredVersion ?? null,
      minimumSupportedVersion: value.minimumSupportedVersion, maximumTestedVersion: value.maximumTestedVersion,
      schemaVersion: value.schemaVersion, schemaHash: value.schemaHash, compatibility: value.compatibility,
      authenticated: value.authenticated, authSource: value.authSource,
      requiresOpenaiAuth: value.requiresOpenaiAuth ?? null, probedAt: value.probedAt,
      createdAt: value.createdAt, updatedAt: value.updatedAt,
    }).onConflictDoUpdate({ target: schema.runtimeProfiles.id, set: {
      executablePath: value.executablePath, launchPrefixJson: this.#json(value.launchPrefix),
      discoverySource: value.discoverySource, discoveredVersion: value.discoveredVersion ?? null,
      schemaVersion: value.schemaVersion, schemaHash: value.schemaHash, compatibility: value.compatibility,
      authenticated: value.authenticated, authSource: value.authSource,
      requiresOpenaiAuth: value.requiresOpenaiAuth ?? null, probedAt: value.probedAt, updatedAt: value.updatedAt,
    }}).run();
  }

  readRuntimeProfile(id: string): RuntimeProfileRecord | null {
    const row = this.sqlite.prepare('SELECT * FROM runtime_profiles WHERE id=?').get(id) as Record<string, unknown> | undefined;
    return row ? this.#runtimeProfile(row) : null;
  }

  listRuntimeProfiles(runtimeType?: string): RuntimeProfileRecord[] {
    const rows = (runtimeType === undefined
      ? this.sqlite.prepare('SELECT * FROM runtime_profiles ORDER BY updated_at DESC, id').all()
      : this.sqlite.prepare('SELECT * FROM runtime_profiles WHERE runtime_type=? ORDER BY updated_at DESC, id').all(runtimeType)
    ) as Record<string, unknown>[];
    return rows.map((row) => this.#runtimeProfile(row));
  }

  saveRuntimeHandle(value: RuntimeHandleRecord): void {
    this.#validate(value);
    this.orm.insert(schema.runtimeHandles).values({
      id: value.id, profileId: value.profileId, executionEnvironmentId: value.executionEnvironmentId,
      connectionEpoch: value.connectionEpoch, state: value.state, pid: value.pid ?? null,
      userAgent: value.userAgent ?? null, platformFamily: value.platformFamily ?? null,
      platformOs: value.platformOs ?? null, startedAt: value.startedAt, updatedAt: value.updatedAt,
      exitedAt: value.exitedAt ?? null, exitCode: value.exitCode ?? null, expectedExit: value.expectedExit ?? null,
    }).onConflictDoUpdate({ target: schema.runtimeHandles.id, set: {
      connectionEpoch: value.connectionEpoch,
      state: value.state, pid: value.pid ?? null, userAgent: value.userAgent ?? null,
      platformFamily: value.platformFamily ?? null, platformOs: value.platformOs ?? null,
      updatedAt: value.updatedAt, exitedAt: value.exitedAt ?? null,
      exitCode: value.exitCode ?? null, expectedExit: value.expectedExit ?? null,
    }}).run();
  }

  readRuntimeHandle(id: string): RuntimeHandleRecord | null {
    const row = this.sqlite.prepare('SELECT * FROM runtime_handles WHERE id=?').get(id) as Record<string, unknown> | undefined;
    return row ? this.#runtimeHandle(row) : null;
  }

  listRuntimeHandles(profileId?: string): RuntimeHandleRecord[] {
    const rows = (profileId === undefined
      ? this.sqlite.prepare('SELECT * FROM runtime_handles ORDER BY started_at, id').all()
      : this.sqlite.prepare('SELECT * FROM runtime_handles WHERE profile_id=? ORDER BY started_at, id').all(profileId)
    ) as Record<string, unknown>[];
    return rows.map((row) => this.#runtimeHandle(row));
  }

  saveRuntimeAudit(value: RuntimeAuditRecord): void {
    this.#validate(value);
    this.orm.insert(schema.runtimeAudit).values({
      id: value.id, runtimeType: value.runtimeType, profileId: value.profileId ?? null,
      handleId: value.handleId ?? null, action: value.action, outcome: value.outcome,
      detailJson: this.#json(value.detail), createdAt: value.createdAt,
    }).run();
  }

  listRuntimeAudits(runtimeType?: string): RuntimeAuditRecord[] {
    const rows = (runtimeType === undefined
      ? this.sqlite.prepare('SELECT * FROM runtime_audit ORDER BY created_at, id').all()
      : this.sqlite.prepare('SELECT * FROM runtime_audit WHERE runtime_type=? ORDER BY created_at, id').all(runtimeType)
    ) as Record<string, unknown>[];
    return rows.map((row) => this.#runtimeAudit(row));
  }  appendSessionEvent(value: SessionEventRecord): void {
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

  #session(row: Record<string, unknown>): HostSession {
    return {
      id: String(row.id), title: String(row.title), projectId: String(row.project_id),
      ...(row.primary_workspace_binding_id === null ? {} : { primaryWorkspaceBindingId: String(row.primary_workspace_binding_id) }),
      runtimeType: String(row.runtime_type), runtimeProfileId: String(row.runtime_profile_id),
      ...(row.runtime_session_id === null ? {} : { runtimeSessionId: String(row.runtime_session_id) }),
      ...(row.provider === null ? {} : { provider: String(row.provider) }),
      ...(row.model === null ? {} : { model: String(row.model) }),
      ...(row.mode === null ? {} : { mode: String(row.mode) }),
      lifecycle: String(row.lifecycle) as HostSession['lifecycle'],
      activity: String(row.activity) as HostSession['activity'], health: String(row.health) as HostSession['health'],
      writeMode: String(row.write_mode) as HostSession['writeMode'], createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at), ...(row.archived_at === null ? {} : { archivedAt: Number(row.archived_at) }),
    };
  }

  #workspaceBinding(row: Record<string, unknown>): WorkspaceBindingRecord {
    return {
      id: String(row.id), sessionId: String(row.session_id), projectId: String(row.project_id),
      worktreeId: String(row.worktree_id), executionEnvironmentId: String(row.execution_environment_id),
      bindingType: String(row.binding_type) as WorkspaceBindingRecord['bindingType'],
      status: String(row.status) as WorkspaceBindingRecord['status'], path: String(row.path),
      baseCommit: String(row.base_commit),
      ...(row.last_known_commit === null ? {} : { lastKnownCommit: String(row.last_known_commit) }),
      cleanupState: String(row.cleanup_state) as WorkspaceBindingRecord['cleanupState'],
      createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
      ...(row.archived_at === null ? {} : { archivedAt: Number(row.archived_at) }),
    };
  }

  #actionAudit(row: Record<string, unknown>): ActionAuditRecord {
    return {
      id: String(row.id), projectId: String(row.project_id), sessionId: String(row.session_id),
      worktreeId: String(row.worktree_id), phase: String(row.phase) as ActionAuditRecord['phase'],
      actionIndex: Number(row.action_index), actionType: String(row.action_type) as ActionAuditRecord['actionType'],
      ...(row.executable === null ? {} : { executable: String(row.executable) }),
      ...(row.shell_type === null ? {} : { shellType: String(row.shell_type) }),
      ...(row.script_hash === null ? {} : { scriptHash: String(row.script_hash) }),
      ...(row.approval_source === null ? {} : { approvalSource: String(row.approval_source) }),
      status: String(row.status) as ActionAuditRecord['status'],
      ...(row.exit_code === null ? {} : { exitCode: Number(row.exit_code) }),
      ...(row.timed_out === null ? {} : { timedOut: Boolean(row.timed_out) }),
      diagnostic: JSON.parse(String(row.diagnostic_json)) as JsonValue,
      startedAt: Number(row.started_at), ...(row.finished_at === null ? {} : { finishedAt: Number(row.finished_at) }),
    };
  }
  #runtimeProfile(row: Record<string, unknown>): RuntimeProfileRecord {
    return {
      id: String(row.id), runtimeType: String(row.runtime_type),
      executionEnvironmentId: String(row.execution_environment_id), executablePath: String(row.executable_path),
      launchPrefix: JSON.parse(String(row.launch_prefix_json)) as string[], discoverySource: String(row.discovery_source),
      ...(row.discovered_version === null ? {} : { discoveredVersion: String(row.discovered_version) }),
      minimumSupportedVersion: String(row.minimum_supported_version),
      maximumTestedVersion: String(row.maximum_tested_version), schemaVersion: String(row.schema_version),
      schemaHash: String(row.schema_hash), compatibility: String(row.compatibility) as RuntimeProfileRecord['compatibility'],
      authenticated: Boolean(row.authenticated), authSource: String(row.auth_source) as RuntimeProfileRecord['authSource'],
      ...(row.requires_openai_auth === null ? {} : { requiresOpenaiAuth: Boolean(row.requires_openai_auth) }),
      probedAt: Number(row.probed_at), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    };
  }

  #process(row: Record<string, unknown>): ProcessRecord {
    return {
      id: String(row.id),
      ...(row.session_id === null ? {} : { sessionId: String(row.session_id) }),
      ...(row.runtime_handle_id === null ? {} : { runtimeHandleId: String(row.runtime_handle_id) }),
      executionEnvironmentId: String(row.execution_environment_id),
      processType: String(row.process_type) as ProcessRecord['processType'],
      pid: Number(row.pid),
      ...(row.parent_pid === null ? {} : { parentPid: Number(row.parent_pid) }),
      daemonBootId: String(row.daemon_boot_id),
      processStartTime: Number(row.process_start_time),
      ...(row.process_fingerprint === null ? {} : { processFingerprint: String(row.process_fingerprint) }),
      spawnNonce: String(row.spawn_nonce),
      ...(row.executable === null ? {} : { executable: String(row.executable) }),
      ...(row.cwd === null ? {} : { cwd: String(row.cwd) }),
      status: String(row.status) as ProcessRecord['status'],
      startedAt: Number(row.started_at),
      ...(row.exited_at === null ? {} : { exitedAt: Number(row.exited_at) }),
      ...(row.exit_code === null ? {} : { exitCode: Number(row.exit_code) }),
      ...(row.signal === null ? {} : { signal: String(row.signal) }),
    };
  }
  #runtimeHandle(row: Record<string, unknown>): RuntimeHandleRecord {
    return {
      id: String(row.id), profileId: String(row.profile_id),
      executionEnvironmentId: String(row.execution_environment_id), connectionEpoch: String(row.connection_epoch),
      state: String(row.state) as RuntimeHandleRecord['state'],
      ...(row.pid === null ? {} : { pid: Number(row.pid) }),
      ...(row.user_agent === null ? {} : { userAgent: String(row.user_agent) }),
      ...(row.platform_family === null ? {} : { platformFamily: String(row.platform_family) }),
      ...(row.platform_os === null ? {} : { platformOs: String(row.platform_os) }),
      startedAt: Number(row.started_at), updatedAt: Number(row.updated_at),
      ...(row.exited_at === null ? {} : { exitedAt: Number(row.exited_at) }),
      ...(row.exit_code === null ? {} : { exitCode: Number(row.exit_code) }),
      ...(row.expected_exit === null ? {} : { expectedExit: Boolean(row.expected_exit) }),
    };
  }

  #runtimeAudit(row: Record<string, unknown>): RuntimeAuditRecord {
    return {
      id: String(row.id), runtimeType: String(row.runtime_type),
      ...(row.profile_id === null ? {} : { profileId: String(row.profile_id) }),
      ...(row.handle_id === null ? {} : { handleId: String(row.handle_id) }),
      action: String(row.action) as RuntimeAuditRecord['action'],
      outcome: String(row.outcome) as RuntimeAuditRecord['outcome'],
      detail: JSON.parse(String(row.detail_json)) as JsonValue, createdAt: Number(row.created_at),
    };
  }
  #operation(row: Record<string, unknown>): OperationRecord {
    return {
      id: String(row.id), operationId: String(row.operation_id),
      type: String(row.type) as OperationRecord['type'],
      ...(row.session_id === null ? {} : { sessionId: String(row.session_id) }),
      status: String(row.status) as OperationRecord['status'],
      requestPayload: JSON.parse(String(row.request_payload_json)) as JsonValue,
      ...(row.result_payload_json === null ? {} : { resultPayload: JSON.parse(String(row.result_payload_json)) as JsonValue }),
      ...(row.error_json === null ? {} : { error: JSON.parse(String(row.error_json)) as JsonValue }),
      createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    };
  }

  #worktree(row: Record<string, unknown>): WorktreeRecord {
    return {
      id: String(row.id), projectId: String(row.project_id),
      ...(row.owner_session_id === null ? {} : { ownerSessionId: String(row.owner_session_id) }),
      executionEnvironmentId: String(row.execution_environment_id), path: String(row.path),
      branchName: String(row.branch_name), baseRef: String(row.base_ref), baseCommit: String(row.base_commit),
      status: String(row.status) as WorktreeRecord['status'], createdAt: Number(row.created_at),
      ...(row.removed_at === null ? {} : { removedAt: Number(row.removed_at) }),
    };
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
      ...(row.setup_actions_json === null ? {} : { setupActions: JSON.parse(String(row.setup_actions_json)) as WorktreeAction[] }),
      ...(row.cleanup_actions_json === null ? {} : { cleanupActions: JSON.parse(String(row.cleanup_actions_json)) as WorktreeAction[] }),
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