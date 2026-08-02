import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { LocalDatabase } = await import(pathToFileURL(join(root, 'packages/database/dist/index.js')).href);
const { PermissionBroker } = await import(pathToFileURL(join(root, 'packages/permission-broker/dist/index.js')).href);

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'tsukiori-permission-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { filePath: join(directory, 'state.db'), blobRoot: join(directory, 'blobs') };
}

function seed(database) {
  const at = 1_800_000_000_000;
  database.saveExecutionEnvironment({
    id: 'env-1', type: 'windows-native', displayName: 'Windows', homePath: 'C:\\fixture',
    pathStyle: 'windows', defaultShell: 'pwsh.exe', gitExecutable: 'git.exe',
    capabilities: { pty: true, processGroups: false, jobObjects: true, symlinks: true },
    createdAt: at, updatedAt: at,
  });
  database.saveProject({
    id: 'project-1', name: 'Fixture', executionEnvironmentId: 'env-1', rootPath: 'D:\\fixture',
    gitRoot: 'D:\\fixture', repositoryId: 'repo-1', createdAt: at, updatedAt: at,
  });
  database.saveSession({
    id: 'session-1', title: 'Session', projectId: 'project-1', runtimeType: 'fake',
    runtimeProfileId: 'profile-1', lifecycle: 'active', activity: 'running', health: 'healthy',
    writeMode: 'isolated-worktree', createdAt: at, updatedAt: at,
  });
}

function request(id, overrides = {}) {
  return {
    id, projectId: 'project-1', sessionId: 'session-1', runtimeHandleId: 'fake-handle',
    runtimeRequestId: 'runtime-' + id, connectionEpoch: 'epoch-1', category: 'shell',
    risk: 'high', enforcementLevel: 'interceptable', title: '运行命令',
    description: '执行结构化命令', scope: 'git status', availableDecisions: ['allow_once'],
    matcher: { executable: 'git.exe', args: ['status'] }, requestedAt: 1_800_000_000_100,
    ...overrides,
  };
}

function broker(database) {
  let serial = 0;
  return new PermissionBroker(database, {
    now: () => 1_800_000_001_000 + serial,
    id: () => 'id-' + ++serial,
  });
}

test('published T1.5 fixture is sanitized and describes enforced policy boundaries', () => {
  const fixture = JSON.parse(readFileSync(join(root, 'tests/fixtures/permission/t1.5-result.json'), 'utf8'));
  assert.equal(fixture.task, 'T1.5');
  assert.equal(fixture.databaseSchemaVersion, 3);
  assert.equal(fixture.projectAllowRequiresStructuredMatcher, true);
  assert.equal(fixture.oldConnectionEpochResponsesRejected, true);
  assert.equal(fixture.containsCredentials, false);
  assert.doesNotMatch(JSON.stringify(fixture), /Bearer\s+|-----BEGIN|sk-[A-Za-z0-9]/);
});
test('Permission Card exposes category, risk, scope, and Enforcement Level', (t) => {
  const database = new LocalDatabase(fixture(t));
  seed(database);
  const card = broker(database).submit(request('request-card', {
    category: 'network', risk: 'critical', enforcementLevel: 'runtime_sandbox',
    scope: 'api.example.invalid:443',
  }));
  assert.deepEqual({ category: card.category, risk: card.risk, scope: card.scope, enforcement: card.enforcementLevel }, {
    category: 'network', risk: 'critical', scope: 'api.example.invalid:443', enforcement: 'runtime_sandbox',
  });
  database.close();
});

test('once, session, project, and deny decisions are durable and auditable', (t) => {
  const database = new LocalDatabase(fixture(t));
  seed(database);
  const permission = broker(database);
  const cases = [
    ['once', 'allow_once', {}],
    ['session', 'allow_session', {}],
    ['project', 'allow_project', {}],
    ['deny-once', 'deny_once', {}],
    ['deny-session', 'deny_session', {}],
  ];
  for (const [id, decision, overrides] of cases) {
    permission.submit(request('request-' + id, { ...overrides, availableDecisions: [decision] }));
    permission.decide('request-' + id, 'epoch-1', decision);
  }
  const snapshot = permission.snapshot();
  assert.equal(snapshot.audits.length, 5);
  assert.deepEqual(snapshot.audits.map((item) => item.decision),
    ['allow_once', 'allow_session', 'allow_project', 'deny_once', 'deny_session']);
  assert.deepEqual(snapshot.rules.map((item) => [item.decision, item.sessionId ?? 'project']), [
    ['allow', 'session-1'], ['allow', 'project'], ['deny', 'session-1'],
  ]);
  assert.equal(snapshot.attention.filter((item) => item.kind === 'waiting_permission' && item.status === 'resolved').length, 5);
  database.close();
});

test('broad project allow is rejected for raw shell and non-enforceable requests', (t) => {
  const database = new LocalDatabase(fixture(t));
  seed(database);
  const permission = broker(database);
  permission.submit(request('request-raw', {
    matcher: { raw: 'arbitrary shell text' }, availableDecisions: ['allow_project'],
  }));
  assert.throws(() => permission.decide('request-raw', 'epoch-1', 'allow_project'), /structured matcher/);
  permission.submit(request('request-raw-session', {
    matcher: { command: 'raw shell text' }, availableDecisions: ['allow_session'],
  }));
  assert.throws(() => permission.decide('request-raw-session', 'epoch-1', 'allow_session'), /structured matcher/);
  permission.submit(request('request-opaque', {
    enforcementLevel: 'opaque', availableDecisions: ['allow_project'],
  }));
  assert.throws(() => permission.decide('request-opaque', 'epoch-1', 'allow_project'), /enforceable/);
  assert.equal(permission.snapshot().rules.length, 0);
  database.close();
});

test('Attention Center persists all observable states across a UI client restart', (t) => {
  const paths = fixture(t);
  let database = new LocalDatabase(paths);
  seed(database);
  let permission = broker(database);
  permission.submit(request('request-pending'));
  for (const kind of ['waiting_input', 'completed', 'failed', 'conflict', 'recovery_uncertain']) {
    permission.addAttention({ projectId: 'project-1', sessionId: 'session-1', kind,
      title: 'attention-' + kind, sourceRef: 'source-' + kind, payload: { sanitized: true } });
  }
  database.close();

  database = new LocalDatabase(paths);
  permission = broker(database);
  const snapshot = permission.snapshot();
  assert.equal(snapshot.permissions.length, 1);
  assert.deepEqual(new Set(snapshot.attention.map((item) => item.kind)), new Set([
    'waiting_permission', 'waiting_input', 'completed', 'failed', 'conflict', 'recovery_uncertain',
  ]));
  database.close();
});

test('old connection epochs are invalidated, audited, and cannot receive a response', (t) => {
  const database = new LocalDatabase(fixture(t));
  seed(database);
  const permission = broker(database);
  permission.submit(request('request-stale'));
  assert.equal(permission.invalidateEpoch('fake-handle', 'epoch-1'), 1);
  assert.throws(() => permission.decide('request-stale', 'epoch-2', 'allow_once'), /not pending/);
  const snapshot = permission.snapshot();
  assert.equal(snapshot.permissions.length, 0);
  assert.equal(snapshot.audits[0].decision, 'invalidated');
  assert.equal(snapshot.attention.some((item) => item.kind === 'recovery_uncertain' && item.status === 'open'), true);
  database.close();
});