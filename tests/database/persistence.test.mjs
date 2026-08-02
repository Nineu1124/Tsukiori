import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const databaseModule = await import(
  pathToFileURL(join(repositoryRoot, 'packages', 'database', 'dist', 'index.js')).href,
);
const { LocalDatabase, LATEST_SCHEMA_VERSION, PersistenceBoundaryError } = databaseModule;
const resultFixture = JSON.parse(
  readFileSync(join(repositoryRoot, 'tests', 'fixtures', 'database', 't1.3-result.json'), 'utf8'),
);

function fixture(t, name = 'state.db') {
  const root = mkdtempSync(join(tmpdir(), 'tsukiori-database-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, filePath: join(root, name), blobRoot: join(root, 'blobs') };
}

function seed(repository) {
  const now = 1_800_000_000_000;
  repository.saveExecutionEnvironment({
    id: 'env-1', type: 'windows-native', displayName: 'Windows Native',
    homePath: 'C:\\Users\\fixture', pathStyle: 'windows', defaultShell: 'pwsh.exe',
    gitExecutable: 'git.exe', capabilities: { pty: true, processGroups: false, jobObjects: true, symlinks: true },
    createdAt: now, updatedAt: now,
  });
  repository.saveProject({
    id: 'project-1', name: 'Fixture', executionEnvironmentId: 'env-1',
    rootPath: 'D:\\fixture', gitRoot: 'D:\\fixture', repositoryId: 'repo-1',
    defaultBranch: 'main', setupActions: [{ type: 'exec', executable: 'node.exe', args: ['--version'] }],
    createdAt: now, updatedAt: now,
  });
  repository.saveSession({
    id: 'session-1', title: 'Fixture session', projectId: 'project-1',
    runtimeType: 'fake', runtimeProfileId: 'profile-1', lifecycle: 'active', activity: 'idle',
    health: 'healthy', writeMode: 'isolated-worktree', createdAt: now, updatedAt: now,
  });
  repository.saveTurn({
    id: 'turn-1', sessionId: 'session-1', status: 'running',
    userInput: { kind: 'fixture', text: '<redacted-input>' }, startedAt: now,
  });
  repository.saveWorktree({
    id: 'worktree-1', projectId: 'project-1', ownerSessionId: 'session-1',
    executionEnvironmentId: 'env-1', path: 'D:\\fixture-wt', branchName: 'codex/fixture',
    baseRef: 'main', baseCommit: '0000000000000000000000000000000000000000',
    status: 'active', createdAt: now,
  });
  repository.saveProcess({
    id: 'process-1', sessionId: 'session-1', executionEnvironmentId: 'env-1',
    processType: 'runtime', pid: 4242, daemonBootId: 'boot-fixture', processStartTime: now,
    processFingerprint: 'fixture-fingerprint', spawnNonce: 'fixture-nonce',
    executable: 'runtime.exe', cwd: 'D:\\fixture-wt', status: 'running', startedAt: now,
  });
  repository.saveOperation({
    id: 'record-1', operationId: 'operation-1', type: 'runtime_session_create',
    sessionId: 'session-1', status: 'prepared', requestPayload: { runtimeType: 'fake' },
    createdAt: now, updatedAt: now,
  });
  const blob = repository.putBlob(Buffer.from('sanitized fixture payload'), 'text/plain', now);
  repository.appendSessionEvent({
    id: 'event-1', schemaVersion: 1, scope: 'session', projectId: 'project-1',
    sessionId: 'session-1', turnId: 'turn-1', streamId: 'stream-1', streamSequence: 1,
    sessionSequence: 1, eventType: 'message.completed', normalizedPayload: { text: '<redacted>' },
    nativeBlobRef: blob.id, runtimeType: 'fake', runtimeEventId: 'runtime-event-1',
    connectionEpoch: 'epoch-1', createdAt: now, receivedAt: now,
  });
  repository.savePermissionRequest({
    id: 'permission-1', sessionId: 'session-1', turnId: 'turn-1',
    runtimeHandleId: 'handle-1', runtimeRequestId: 'request-1', connectionEpoch: 'epoch-1',
    category: 'command', risk: 'low', enforcementLevel: 'interceptable',
    requestPayload: { executable: 'git.exe', args: ['status'] }, status: 'pending', requestedAt: now,
  });
}

function allFiles(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? allFiles(path) : [path];
  });
}

test('published database fixture is complete and contains no credentials', () => {
  assert.deepEqual(resultFixture.database.migrationVersions, [1, 2]);
  assert.deepEqual(resultFixture.independentProjections, ['lifecycle', 'activity', 'health', 'workspace']);
  assert.deepEqual(resultFixture.persistenceBoundary.sinks, ['sqlite', 'wal', 'blob']);
  assert.equal(resultFixture.persistenceBoundary.containsCredentials, false);
  assert.doesNotMatch(JSON.stringify(resultFixture), /Bearer\\s+|-----BEGIN|sk-[A-Za-z0-9]/);
});

test('core domain records, durable operations, events, permissions, and Blob references survive reopen', (t) => {
  const paths = fixture(t);
  let repository = new LocalDatabase(paths);
  assert.equal(repository.journalMode, 'wal');
  assert.deepEqual(repository.schemaVersions, [1, 2, 3, 4, 5]);
  seed(repository);
  const duplicateBlob = repository.putBlob(Buffer.from('sanitized fixture payload'), 'text/plain');
  assert.match(duplicateBlob.id, /^blob:[a-f0-9]{64}$/);
  assert.equal(allFiles(paths.blobRoot).some((path) => path.endsWith('.tmp')), false);

  for (const table of [
    'execution_environments', 'projects', 'sessions', 'session_turns', 'worktrees',
    'process_records', 'operations', 'session_events', 'permission_requests', 'blob_objects',
  ]) {
    assert.equal(repository.count(table), 1, table);
  }
  repository.close();

  repository = new LocalDatabase(paths);
  assert.equal(repository.count('sessions'), 1);
  assert.equal(repository.count('operations'), 1);
  assert.equal(repository.count('session_events'), 1);
  assert.equal(repository.count('permission_requests'), 1);
  assert.equal(repository.count('blob_objects'), 1);
  repository.close();
});

test('Lifecycle, Activity, Health, and Workspace projections update independently and persist', (t) => {
  const paths = fixture(t);
  let repository = new LocalDatabase(paths);
  seed(repository);
  repository.setLifecycle('session-1', 'archiving', 'event-lifecycle', 10);
  repository.setActivity('session-1', 'waiting_permission', 'event-activity', 20);
  repository.setHealth('session-1', 'interrupted_runtime', 'event-health', 30);
  repository.setWorkspaceState('worktree-1', 'dirty', 'event-workspace', 40);

  assert.deepEqual(repository.readSessionProjection('session-1'), {
    sessionId: 'session-1', lifecycle: 'archiving', activity: 'waiting_permission',
    health: 'interrupted_runtime', lifecycleEventId: 'event-lifecycle',
    activityEventId: 'event-activity', healthEventId: 'event-health', updatedAt: 30,
  });
  repository.setActivity('session-1', 'idle', 'event-activity-2', 50);
  const updated = repository.readSessionProjection('session-1');
  assert.equal(updated.lifecycle, 'archiving');
  assert.equal(updated.activity, 'idle');
  assert.equal(updated.health, 'interrupted_runtime');
  assert.deepEqual(repository.readWorkspaceProjection('worktree-1'), {
    worktreeId: 'worktree-1', state: 'dirty', sourceEventId: 'event-workspace', updatedAt: 40,
  });
  repository.close();

  repository = new LocalDatabase(paths);
  assert.equal(repository.readSessionProjection('session-1').activity, 'idle');
  assert.equal(repository.readWorkspaceProjection('worktree-1').state, 'dirty');
  repository.close();
});

test('migrations are repeatable for an empty database and a previous-version fixture', (t) => {
  const previous = fixture(t, 'previous.db');
  let repository = new LocalDatabase({ ...previous, targetVersion: 1 });
  assert.deepEqual(repository.schemaVersions, [1]);
  assert.equal(repository.count('sessions'), 0);
  repository.close();

  repository = new LocalDatabase(previous);
  assert.deepEqual(repository.schemaVersions, [1, 2, 3, 4, 5]);
  assert.equal(repository.count('session_lifecycle_projections'), 0);
  repository.close();

  repository = new LocalDatabase(previous);
  assert.deepEqual(repository.schemaVersions, [1, 2, 3, 4, 5]);
  assert.equal(LATEST_SCHEMA_VERSION, 5);
  repository.close();

  const empty = fixture(t, 'empty.db');
  repository = new LocalDatabase(empty);
  assert.deepEqual(repository.schemaVersions, [1, 2, 3, 4, 5]);
  repository.close();
});

test('Secret fields and values are rejected before SQLite, WAL, or Blob writes', (t) => {
  const paths = fixture(t);
  const marker = 'fixture-secret-never-persist';
  const repository = new LocalDatabase({ ...paths, knownSecrets: [marker] });

  assert.throws(() => repository.saveOperation({
    id: 'secret-operation', operationId: 'secret-operation', type: 'commit', status: 'prepared',
    requestPayload: { message: marker }, createdAt: 1, updatedAt: 1,
  }), PersistenceBoundaryError);
  assert.throws(() => repository.saveOperation({
    id: 'secret-field', operationId: 'secret-field', type: 'commit', status: 'prepared',
    requestPayload: { api_key: '<redacted>' }, createdAt: 1, updatedAt: 1,
  }), PersistenceBoundaryError);
  assert.throws(() => repository.appendSessionEvent({
    id: 'secret-event', schemaVersion: 1, scope: 'runtime', streamId: 'secret-stream',
    streamSequence: 1, eventType: 'native', normalizedPayload: { header: 'Bearer abcdefghijklmnop' },
    createdAt: 1, receivedAt: 1,
  }), PersistenceBoundaryError);
  assert.throws(() => repository.putBlob(Buffer.from(marker), 'text/plain'), PersistenceBoundaryError);

  assert.equal(repository.count('operations'), 0);
  assert.equal(repository.count('session_events'), 0);
  assert.equal(repository.count('blob_objects'), 0);
  repository.appendSessionEvent({
    id: 'safe-event', schemaVersion: 1, scope: 'daemon', streamId: 'safe-stream',
    streamSequence: 1, eventType: 'daemon.started', normalizedPayload: { state: 'running' },
    createdAt: 2, receivedAt: 2,
  });

  for (const path of allFiles(paths.root)) {
    if (statSync(path).size === 0) continue;
    assert.equal(readFileSync(path).includes(Buffer.from(marker)), false, path);
  }
  repository.close();
});