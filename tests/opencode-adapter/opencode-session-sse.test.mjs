import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { LocalDatabase } = await import(pathToFileURL(join(root, 'packages/database/dist/index.js')).href);
const { ExecutionEnvironmentRegistry, GitProbe } = await import(
  pathToFileURL(join(root, 'packages/project-manager/dist/index.js')).href
);
const { OpenCodeRuntimeAdapter } = await import(
  pathToFileURL(join(root, 'packages/adapter-opencode/dist/index.js')).href
);
const fakeCli = join(root, 'tests', 'fixtures', 'opencode', 'fake-opencode-cli.mjs');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function fixture(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'tsukiori-opencode-sse-'));
  const repository = join(directory, 'repository');
  const worktree = join(directory, 'worktree');
  mkdirSync(repository);
  git(['init', '-b', 'main'], repository);
  git(['config', 'user.name', 'Tsukiori Fixture'], repository);
  git(['config', 'user.email', 'fixture@invalid.local'], repository);
  writeFileSync(join(repository, 'README.md'), '# fixture\n');
  git(['add', 'README.md'], repository);
  git(['commit', '-m', 'fixture'], repository);
  git(['worktree', 'add', '-b', 'session-sse', worktree], repository);

  const docBody = JSON.stringify({ openapi: '3.1.0', info: { title: 'OpenCode fixture', version: '1.18.4' } });
  const configPath = join(directory, 'fake-opencode.json');
  writeFileSync(configPath, JSON.stringify({
    version: '1.18.4', credentialCount: 1, docBody, docContentType: 'application/json',
    emitPermissionFlow: true, ...overrides,
  }));
  const manifestPath = join(directory, 'openapi-manifest.json');
  writeFileSync(manifestPath, JSON.stringify({
    runtimeVersion: '1.18.4', contentType: 'application/json',
    sha256: createHash('sha256').update(docBody).digest('hex'), bytes: Buffer.byteLength(docBody),
  }));

  const database = new LocalDatabase({ filePath: join(directory, 'state.db'), blobRoot: join(directory, 'blobs') });
  let clock = 1_800_004_000_000;
  let serial = 0;
  const now = () => ++clock;
  const id = () => 'sse-id-' + ++serial;
  const environments = new ExecutionEnvironmentRegistry(database, { gitProbe: new GitProbe(), now });
  const environment = environments.registerWindowsNative({ homePath: directory });
  database.saveProject({
    id: 'project-sse', name: 'OpenCode SSE fixture', executionEnvironmentId: environment.id,
    rootPath: repository, gitRoot: repository, repositoryId: 'repository-sse',
    createdAt: now(), updatedAt: now(),
  });
  const adapter = new OpenCodeRuntimeAdapter(database, environments, {
    executionEnvironmentId: environment.id,
    openApiManifestPath: manifestPath,
    candidates: () => [{ executable: process.execPath, prefixArgs: [fakeCli, configPath], source: 'explicit' }],
    now, id, daemonBootId: 'daemon:opencode-sse',
  });
  const profile = adapter.probe();
  for (let index = 1; index <= 3; index += 1) {
    database.saveSession({
      id: 'host-session-' + index, title: 'Host Session ' + index, projectId: 'project-sse',
      runtimeType: 'opencode', runtimeProfileId: profile.id, lifecycle: 'active', activity: 'idle',
      health: 'healthy', writeMode: 'isolated-worktree', createdAt: now(), updatedAt: now(),
    });
  }
  let handle;
  t.after(async () => {
    if (handle) await handle.stop().catch(() => undefined);
    database.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  });
  return {
    directory, repository, worktree, database, adapter, profile,
    async start() { handle = await adapter.start(profile.id, worktree); return handle; },
    async stop() { if (handle) await handle.stop(); handle = undefined; },
  };
}

async function waitFor(predicate, timeoutMs = 8_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error('condition timed out');
}

function events(database) {
  return database.sqlite.prepare(
    'SELECT scope, session_id, turn_id, event_type, normalized_payload_json, connection_epoch FROM session_events ORDER BY stream_sequence',
  ).all();
}

function turn(database, sessionId) {
  return database.sqlite.prepare(
    'SELECT id, runtime_turn_id, status, user_input_json, started_at, completed_at FROM session_turns WHERE session_id=? ORDER BY rowid DESC LIMIT 1',
  ).get(sessionId);
}

test('published T3.2 fixture is sanitized and declares one reader with runtime scope recovery', () => {
  const result = JSON.parse(readFileSync(join(root, 'tests/fixtures/opencode/t3.2-result.json'), 'utf8'));
  assert.equal(result.task, 'T3.2');
  assert.equal(result.runtimeVersion, '1.18.4');
  assert.equal(result.eventReadersPerHandle, 1);
  assert.equal(result.sessionRoutes, 2);
  assert.equal(result.runtimeScopePreserved, true);
  assert.equal(result.snapshotRecovery, true);
  assert.equal(result.realAdapterProbe.globalEventStreamConnected, true);
  assert.equal(result.realAdapterProbe.providerRequestCompleted, true);
  assert.equal(result.rawPayloadsCommitted, false);
  assert.equal(result.containsCredentials, false);
  assert.doesNotMatch(JSON.stringify(result), /Bearer\s+|Basic\s+[A-Za-z0-9+/=]+|sk-[A-Za-z0-9]/);
});

test('Create Resume and Start Turn preserve Host mappings without persisting user input', async (t) => {
  const f = fixture(t);
  const handle = await f.start();
  assert.equal(handle.eventReaderCount, 1);
  assert.equal(handle.eventStreamState, 'connected');
  const runtimeSessionId = await handle.createSession(
    'host-session-1', 'dpsk', 'deepseek-v4-flash', 'SSE fixture',
  );
  assert.match(runtimeSessionId, /^session-fixture-/);
  const mapped = f.database.readSession('host-session-1');
  assert.equal(mapped.runtimeSessionId, runtimeSessionId);
  assert.equal(mapped.provider, 'dpsk');
  assert.equal(mapped.model, 'deepseek-v4-flash');

  await handle.startTurn('host-session-1', 'PRIVATE_FIXTURE_INPUT_MUST_NOT_PERSIST');
  const completed = await waitFor(() => {
    const row = turn(f.database, 'host-session-1');
    return row?.status === 'completed' ? row : null;
  });
  assert.match(completed.runtime_turn_id, /^opencode-turn:/);
  assert.deepEqual(JSON.parse(completed.user_input_json), { source: 'opencode', persistedText: false });
  assert.doesNotMatch(JSON.stringify({
    session: f.database.readSession('host-session-1'),
    turn: completed,
    events: events(f.database),
  }), /PRIVATE_FIXTURE_INPUT_MUST_NOT_PERSIST/);
  assert.equal(await handle.resumeSession('host-session-1'), runtimeSessionId);
  assert.equal(f.database.readSession('host-session-1').activity, 'idle');
  await f.stop();
});

test('one global SSE reader routes two Sessions and retains Runtime Scope events', async (t) => {
  const f = fixture(t);
  const handle = await f.start();
  await Promise.all([
    handle.createSession('host-session-1', 'dpsk', 'deepseek-v4-flash'),
    handle.createSession('host-session-2', 'dpsk', 'deepseek-v4-flash'),
  ]);
  await Promise.all([
    handle.startTurn('host-session-1', 'fixture-one'),
    handle.startTurn('host-session-2', 'fixture-two'),
  ]);
  await waitFor(() => turn(f.database, 'host-session-1')?.status === 'completed'
    && turn(f.database, 'host-session-2')?.status === 'completed');
  const rows = events(f.database);
  assert.equal(handle.eventReaderCount, 1);
  for (const sessionId of ['host-session-1', 'host-session-2']) {
    const types = new Set(rows.filter((row) => row.session_id === sessionId).map((row) => row.event_type));
    for (const type of [
      'assistant.message_started', 'assistant.text_delta', 'assistant.message_completed',
      'tool.started', 'tool.completed', 'permission.requested', 'permission.resolved',
      'turn.state_changed',
    ]) assert.equal(types.has(type), true, sessionId + ' missing ' + type);
  }
  assert.equal(rows.some((row) => row.scope === 'runtime' && row.session_id === null), true);
  assert.equal(rows.some((row) => row.session_id === 'host-session-1' && row.turn_id !== null), true);
  assert.equal(rows.some((row) => row.session_id === 'host-session-2' && row.turn_id !== null), true);
  await f.stop();
});

test('Session error SSE produces failed Turn and error Session health', async (t) => {
  const f = fixture(t, { emitSessionError: true });
  const handle = await f.start();
  await handle.createSession('host-session-1', 'dpsk', 'deepseek-v4-flash');
  await handle.startTurn('host-session-1', 'sanitized-error-fixture');
  await waitFor(() => turn(f.database, 'host-session-1')?.status === 'failed');
  assert.equal(f.database.readSession('host-session-1').health, 'error');
  const failedEvents = events(f.database).filter((row) => row.session_id === 'host-session-1');
  assert.equal(failedEvents.some((row) => row.event_type === 'turn.state_changed'), true);
  assert.equal(failedEvents.some((row) => row.normalized_payload_json.includes('FixtureError')), false);
  await f.stop();
});

test('disconnected SSE re-Probes snapshots Sessions and establishes a new Epoch', async (t) => {
  const f = fixture(t, { disconnectFirstEventStream: true });
  const handle = await f.start();
  await waitFor(() => handle.eventStreamState === 'disconnected');
  await handle.createSession('host-session-1', 'dpsk', 'deepseek-v4-flash');
  await handle.startTurn('host-session-1', 'offline-stream-fixture');
  const previousEpoch = f.database.readRuntimeHandle(handle.id).connectionEpoch;
  const recovery = await handle.recoverEventStream();
  assert.equal(recovery.previousConnectionEpoch, previousEpoch);
  assert.notEqual(recovery.connectionEpoch, previousEpoch);
  assert.equal(recovery.recoveredSessionCount, 1);
  assert.equal(recovery.eventReaderCount, 1);
  assert.equal(recovery.snapshotRecovery, true);
  assert.equal(handle.eventStreamState, 'connected');
  assert.equal(f.database.readRuntimeHandle(handle.id).connectionEpoch, recovery.connectionEpoch);
  assert.equal(f.database.readSession('host-session-1').activity, 'idle');
  const rows = events(f.database);
  assert.equal(rows.some((row) => row.event_type === 'runtime.state_changed'
    && row.connection_epoch === recovery.connectionEpoch), true);
  assert.equal(rows.some((row) => row.event_type === 'runtime.warning'
    && row.connection_epoch === recovery.connectionEpoch), true);
  assert.equal(rows.some((row) => row.event_type === 'session.state_changed'
    && row.session_id === 'host-session-1'
    && row.connection_epoch === recovery.connectionEpoch), true);
  assert.equal(f.database.listRuntimeAudits('opencode').some((row) => row.action === 'reprobe'), true);
  await f.stop();
});