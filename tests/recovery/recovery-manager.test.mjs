import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { LocalDatabase } = await import(
  pathToFileURL(join(root, 'packages/database/dist/index.js')).href,
);
const { PermissionBroker } = await import(
  pathToFileURL(join(root, 'packages/permission-broker/dist/index.js')).href,
);
const { RecoveryManager } = await import(
  pathToFileURL(join(root, 'packages/recovery-manager/dist/index.js')).href,
);

const published = JSON.parse(readFileSync(
  join(root, 'tests/fixtures/recovery/t5.1-result.json'), 'utf8',
));

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'tsukiori-recovery-'));
  const database = new LocalDatabase({
    filePath: join(directory, 'state.db'),
    blobRoot: join(directory, 'blobs'),
  });
  t.after(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const at = 1_800_000_000_000;
  database.saveExecutionEnvironment({
    id: 'env-1', type: 'windows-native', displayName: 'Windows', homePath: 'C:\\fixture',
    pathStyle: 'windows', defaultShell: 'pwsh.exe', gitExecutable: 'git.exe',
    capabilities: { pty: true, processGroups: false, jobObjects: true, symlinks: true },
    createdAt: at, updatedAt: at,
  });
  database.saveProject({
    id: 'project-1', name: 'Fixture', executionEnvironmentId: 'env-1',
    rootPath: 'D:\\fixture', gitRoot: 'D:\\fixture', repositoryId: 'repo-1',
    createdAt: at, updatedAt: at,
  });
  database.saveSession({
    id: 'session-1', title: 'Session', projectId: 'project-1', runtimeType: 'fake',
    runtimeProfileId: 'profile-1', lifecycle: 'active', activity: 'running', health: 'healthy',
    writeMode: 'isolated-worktree', createdAt: at, updatedAt: at,
  });
  return { database, at };
}

function processRecord(id, at, overrides = {}) {
  return {
    id, sessionId: 'session-1', executionEnvironmentId: 'env-1', processType: 'runtime',
    pid: 4100, daemonBootId: 'boot-old', processStartTime: at, spawnNonce: 'nonce-' + id,
    executable: 'C:\\Tools\\runtime.exe', processFingerprint: 'fingerprint-' + id,
    status: 'running', startedAt: at, ...overrides,
  };
}

test('published recovery evidence is sanitized and forbids automatic replay', () => {
  assert.equal(published.task, 'T5.1');
  assert.equal(published.autoReplayCount, 0);
  assert.equal(published.containsCredentials, false);
  assert.equal(published.containsPromptOrSource, false);
  assert.deepEqual(published.daemonPolicy, ['keep', 'stop']);
  assert.match(published.killMatrix.gui, /survived/);
  assert.match(published.killMatrix.daemon, /without_replay/);
  assert.match(published.killMatrix.runtime, /peer_runtime_remained_healthy/);
  assert.doesNotMatch(JSON.stringify(published), /Bearer\s+|-----BEGIN|sk-[A-Za-z0-9]/);
});

test('full ProcessRecord identity distinguishes the original process, absence, and PID reuse', (t) => {
  const { database, at } = fixture(t);
  const exact = processRecord('exact', at);
  const reused = processRecord('reused', at, { pid: 4200 });
  const absent = processRecord('absent', at, { pid: 4300 });
  database.saveProcess(exact);
  database.saveProcess(reused);
  database.saveProcess(absent);
  const observations = new Map([
    ['exact', { state: 'running', identity: {
      pid: exact.pid, daemonBootId: exact.daemonBootId,
      processStartTime: exact.processStartTime, spawnNonce: exact.spawnNonce,
      executable: exact.executable, processFingerprint: exact.processFingerprint,
    } }],
    ['reused', { state: 'running', identity: {
      pid: reused.pid, daemonBootId: reused.daemonBootId,
      processStartTime: reused.processStartTime + 1, spawnNonce: reused.spawnNonce,
      executable: reused.executable, processFingerprint: 'different-process',
    } }],
    ['absent', { state: 'absent' }],
  ]);
  const manager = new RecoveryManager({
    database, daemonBootId: 'boot-new', now: () => at + 100,
    processObserver: { observe: (record) => observations.get(record.id) },
  });
  const report = manager.reconcile();
  assert.equal(report.autoReplayCount, 0);
  assert.equal(database.readProcess('exact').status, 'running');
  assert.equal(database.readProcess('reused').status, 'orphaned');
  assert.equal(database.readProcess('absent').status, 'exited');
  assert.equal(database.readSession('session-1').health, 'recovery_required');
  assert.deepEqual(
    report.processResults.map(({ id, status }) => [id, status]),
    [['absent', 'exited'], ['exact', 'running'], ['reused', 'orphaned']],
  );
  assert.equal(report.processResults.every((result) => result.autoReplay === false), true);
});

test('Runtime, Worktree, Commit, Merge, permission, and cleanup operations get durable non-replay recovery results', (t) => {
  const { database, at } = fixture(t);
  let attentionSerial = 0;
  const broker = new PermissionBroker(database, {
    now: () => at + 200,
    id: () => 'attention-id-' + ++attentionSerial,
  });
  const operations = [
    ['runtime', 'runtime_session_create', 'running'],
    ['create', 'worktree_create', 'running'],
    ['cleanup', 'worktree_remove', 'running'],
    ['commit', 'commit', 'running'],
    ['merge', 'merge', 'running'],
    ['rebase', 'rebase', 'running'],
    ['permission', 'permission_response', 'running'],
    ['review', 'git_review', 'prepared'],
    ['revert', 'git_revert', 'running'],
  ];
  for (const [id, type, status] of operations) {
    database.saveOperation({
      id: 'record-' + id, operationId: 'operation-' + id, type, sessionId: 'session-1',
      status, requestPayload: { schemaVersion: 1 }, createdAt: at, updatedAt: at,
    });
  }
  const manager = new RecoveryManager({
    database, permissions: broker, daemonBootId: 'boot-recovery', now: () => at + 300,
    processObserver: { observe: () => ({ state: 'absent' }) },
    recoverWorktrees: () => {
      const create = database.readOperation('operation-create');
      const cleanup = database.readOperation('operation-cleanup');
      database.saveOperation({
        ...create, status: 'committed', resultPayload: { recovery: 'worktree_present' }, updatedAt: at + 300,
      });
      database.saveOperation({
        ...cleanup, status: 'uncertain', resultPayload: { recovery: 'dirty_bytes_retained' }, updatedAt: at + 300,
      });
      return [
        { operationId: create.operationId, action: 'create', status: 'committed', reason: 'worktree_present' },
        { operationId: cleanup.operationId, action: 'remove', status: 'uncertain', reason: 'dirty_bytes_retained' },
      ];
    },
  });
  const report = manager.reconcile();
  assert.equal(report.autoReplayCount, 0);
  assert.equal(report.operationResults.length, operations.length);
  assert.equal(report.operationResults.every((result) => result.autoReplay === false), true);
  assert.equal(database.listOperations(['prepared', 'running']).length, 0);
  assert.equal(database.readOperation('operation-create').status, 'committed');
  assert.equal(database.readOperation('operation-cleanup').status, 'uncertain');
  assert.equal(database.readOperation('operation-commit').status, 'uncertain');
  assert.equal(database.readOperation('operation-merge').status, 'uncertain');
  assert.equal(database.readOperation('operation-rebase').status, 'uncertain');
  assert.equal(database.readOperation('operation-review').status, 'failed');
  assert.equal(database.readSession('session-1').health, 'recovery_required');
  const attention = broker.snapshot().attention;
  assert.ok(attention.some((item) => item.sourceRef === 'recovery-operation:operation-commit'));
  assert.ok(attention.some((item) => item.sourceRef === 'recovery-operation:operation-cleanup'));
  assert.equal(attention.every((item) => item.payload.autoReplay === false), true);
});
