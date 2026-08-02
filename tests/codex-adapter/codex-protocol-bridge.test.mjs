import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { LocalDatabase } = await import(pathToFileURL(join(root, 'packages/database/dist/index.js')).href);
const { PermissionBroker } = await import(pathToFileURL(join(root, 'packages/permission-broker/dist/index.js')).href);
const { ExecutionEnvironmentRegistry, GitProbe } = await import(
  pathToFileURL(join(root, 'packages/project-manager/dist/index.js')).href
);
const { CodexRuntimeAdapter, CodexSessionBridge, CodexBridgeError } = await import(
  pathToFileURL(join(root, 'packages/adapter-codex/dist/index.js')).href
);

const schemaRoot = join(root, 'tests', 'fixtures', 'codex', '0.146.0');
const fakeCli = join(root, 'tests', 'fixtures', 'codex', 'fake-codex-cli.mjs');

function fixture(t, bridgeOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'tsukiori-codex-bridge-'));
  const configPath = join(directory, 'fake-codex.json');
  writeFileSync(configPath, JSON.stringify({
    version: '0.146.0',
    accountType: 'chatgpt',
    requiresOpenaiAuth: true,
  }));
  const database = new LocalDatabase({
    filePath: join(directory, 'state.db'),
    blobRoot: join(directory, 'blobs'),
  });
  let clock = 1_800_001_000_000;
  let serial = 0;
  const now = () => ++clock;
  const id = () => 'bridge-id-' + ++serial;
  const environments = new ExecutionEnvironmentRegistry(database, { gitProbe: new GitProbe(), now });
  const environment = environments.registerWindowsNative({ homePath: directory });
  database.saveProject({
    id: 'project-1',
    name: 'Codex bridge fixture',
    executionEnvironmentId: environment.id,
    rootPath: directory,
    gitRoot: directory,
    repositoryId: 'repository-1',
    createdAt: now(),
    updatedAt: now(),
  });
  database.saveRuntimeProfile({
    id: 'profile-direct',
    runtimeType: 'codex',
    executionEnvironmentId: environment.id,
    executablePath: process.execPath,
    launchPrefix: [fakeCli, configPath],
    discoverySource: 'explicit',
    discoveredVersion: '0.146.0',
    minimumSupportedVersion: '0.146.0',
    maximumTestedVersion: '0.146.0',
    schemaVersion: '0.146.0',
    schemaHash: 'sha256:fixture',
    compatibility: 'supported',
    authenticated: false,
    authSource: 'none',
    requiresOpenaiAuth: true,
    probedAt: now(),
    createdAt: now(),
    updatedAt: now(),
  });
  const handle = {
    id: 'handle-direct',
    profileId: 'profile-direct',
    executionEnvironmentId: environment.id,
    connectionEpoch: 'epoch-direct',
    state: 'ready',
    startedAt: now(),
    updatedAt: now(),
  };
  database.saveRuntimeHandle(handle);
  for (let index = 1; index <= 3; index += 1) {
    database.saveSession({
      id: 'session-' + index,
      title: 'Session ' + index,
      projectId: 'project-1',
      runtimeType: 'codex',
      runtimeProfileId: 'profile-direct',
      lifecycle: 'active',
      activity: 'idle',
      health: 'healthy',
      writeMode: 'isolated-worktree',
      createdAt: now(),
      updatedAt: now(),
    });
  }
  const permissions = new PermissionBroker(database, { now, id });
  const bridge = new CodexSessionBridge(database, permissions, handle, {
    now,
    id,
    maxPayloadBytes: bridgeOptions.maxPayloadBytes ?? 512,
  });
  t.after(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, configPath, database, permissions, bridge, environments, environment, now, id };
}

async function waitFor(predicate, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error('condition timed out');
}

test('published T4.2 fixture is sanitized and preserves unknown real network support', () => {
  const result = JSON.parse(readFileSync(join(root, 'tests/fixtures/codex/t4.2-result.json'), 'utf8'));
  assert.equal(result.task, 'T4.2');
  assert.equal(result.eventReadersPerHandle, 1);
  assert.equal(result.multiThreadIsolation.threadCount, 3);
  assert.equal(result.approvals.command.enforcementLevel, 'interceptable');
  assert.equal(result.approvals.file.enforcementLevel, 'interceptable');
  assert.equal(result.approvals.network.syntheticContract, 'passed');
  assert.equal(result.approvals.network.realRuntimeSupport, 'unknown');
  assert.equal(result.containsCredentials, false);
  assert.doesNotMatch(JSON.stringify(result), /Bearer\s+|-----BEGIN|sk-[A-Za-z0-9]/);
});

test('Thread Turn and Item events map to Host IDs without cross-talk or duplicate apply', (t) => {
  const f = fixture(t, { maxPayloadBytes: 256 });
  const envelopes = [];
  for (let index = 1; index <= 3; index += 1) {
    const threadId = 'runtime-thread-' + index;
    const turnId = 'runtime-turn-' + index;
    f.bridge.bindThread(threadId, 'session-' + index);
    const turn = f.bridge.acceptNotification('turn/started', {
      threadId,
      turn: { id: turnId, status: 'inProgress' },
    });
    envelopes.push(...turn.events);
    const itemType = index === 1 ? 'agentMessage' : 'commandExecution';
    envelopes.push(...f.bridge.acceptNotification('item/started', {
      threadId,
      turnId,
      item: { id: 'item-' + index, type: itemType },
    }).events);
    envelopes.push(...f.bridge.acceptNotification('item/completed', {
      threadId,
      turnId,
      item: { id: 'item-' + index, type: itemType },
    }).events);
    assert.equal(f.bridge.acceptNotification('item/completed', {
      threadId,
      turnId,
      item: { id: 'item-' + index, type: itemType },
    }).status, 'duplicate');
  }

  const firstStatus = f.bridge.acceptNotification('thread/status/changed', {
    threadId: 'runtime-thread-1',
    status: { type: 'idle' },
  });
  const secondStatus = f.bridge.acceptNotification('thread/status/changed', {
    threadId: 'runtime-thread-1',
    status: { type: 'active' },
  });
  assert.equal(firstStatus.status, 'accepted');
  assert.equal(secondStatus.status, 'accepted');
  assert.equal(f.bridge.acceptNotification('thread/status/changed', {
    threadId: 'runtime-thread-1',
    status: { type: 'active' },
  }).status, 'duplicate');

  const firstDelta = f.bridge.acceptNotification('item/agentMessage/delta', {
    threadId: 'runtime-thread-1',
    turnId: 'runtime-turn-1',
    itemId: 'item-1',
    delta: 'sanitized streaming text',
  });
  assert.equal(firstDelta.events[0].type, 'assistant.text_delta');
  assert.equal(firstDelta.events[0].projectId, 'project-1');
  assert.equal(firstDelta.events[0].sessionId, 'session-1');
  assert.equal(firstDelta.events[0].runtimeSessionId, 'runtime-thread-1');
  assert.notEqual(firstDelta.events[0].turnId, 'runtime-turn-1');
  assert.equal(firstDelta.events[0].runtimeTurnId, 'runtime-turn-1');

  const unknown = f.bridge.acceptNotification('item/futurePayload', {
    threadId: 'runtime-thread-2',
    turnId: 'runtime-turn-2',
    item: { id: 'future-item', type: 'futureType' },
    api_key: 'fixture-sensitive-value-123456789',
    diagnostic: 'x'.repeat(2_000),
  });
  assert.equal(unknown.events[0].type, 'native.event');
  assert.equal(unknown.events[0].payload.truncated, true);
  assert.equal(unknown.events[0].payload.redacted, true);
  assert.doesNotMatch(JSON.stringify(unknown.events[0]), /fixture-sensitive-value|api_key/);
  const afterUnknown = f.bridge.acceptNotification('item/agentMessage/delta', {
    threadId: 'runtime-thread-2',
    turnId: 'runtime-turn-2',
    itemId: 'future-item',
    delta: 'stream continues',
  });
  assert.equal(afterUnknown.status, 'accepted');

  f.bridge.acceptNotification('turn/completed', {
    threadId: 'runtime-thread-3',
    turn: { id: 'runtime-turn-3', status: 'completed' },
  });
  const completedBeforeLateItem = f.database.sqlite.prepare(
    'SELECT status, completed_at FROM session_turns WHERE session_id=? AND runtime_turn_id=?',
  ).get('session-3', 'runtime-turn-3');
  f.bridge.acceptNotification('item/started', {
    threadId: 'runtime-thread-3',
    turnId: 'runtime-turn-3',
    item: { id: 'late-item', type: 'commandExecution' },
  });
  const completedAfterLateItem = f.database.sqlite.prepare(
    'SELECT status, completed_at FROM session_turns WHERE session_id=? AND runtime_turn_id=?',
  ).get('session-3', 'runtime-turn-3');
  assert.deepEqual(completedAfterLateItem, completedBeforeLateItem);
  assert.equal(completedAfterLateItem.status, 'completed');

  const turns = f.database.sqlite.prepare(
    'SELECT id, session_id, runtime_turn_id FROM session_turns ORDER BY session_id',
  ).all();
  assert.equal(turns.length, 3);
  assert.deepEqual(turns.map((row) => row.session_id), ['session-1', 'session-2', 'session-3']);
  assert.deepEqual(turns.map((row) => row.runtime_turn_id), [
    'runtime-turn-1',
    'runtime-turn-2',
    'runtime-turn-3',
  ]);
  const routes = f.database.sqlite.prepare(
    'SELECT session_id, COUNT(*) AS event_count FROM session_events GROUP BY session_id ORDER BY session_id',
  ).all();
  assert.deepEqual(routes.map((row) => row.session_id), ['session-1', 'session-2', 'session-3']);
  assert.equal(routes.every((row) => row.event_count >= 3), true);
  assert.equal(f.database.readSession('session-1').runtimeSessionId, 'runtime-thread-1');
  assert.equal(f.database.readSession('session-2').runtimeSessionId, 'runtime-thread-2');
  assert.equal(envelopes.filter((event) => event.type === 'assistant.message_completed').length, 1);
  assert.equal(envelopes.filter((event) => event.type === 'tool.completed').length, 2);
});

test('Command File and synthetic Network approvals expose interceptable enforcement and safe responses', async (t) => {
  const f = fixture(t);
  f.bridge.bindThread('runtime-thread-1', 'session-1');
  f.bridge.acceptNotification('turn/started', {
    threadId: 'runtime-thread-1',
    turn: { id: 'runtime-turn-1', status: 'inProgress' },
  });

  const commandResponse = f.bridge.handleServerRequest(100, 'item/commandExecution/requestApproval', {
    threadId: 'runtime-thread-1',
    turnId: 'runtime-turn-1',
    itemId: 'command-1',
  });
  const commandCard = f.permissions.snapshot().permissions[0];
  assert.deepEqual(
    [commandCard.category, commandCard.enforcementLevel],
    ['shell', 'interceptable'],
  );
  f.bridge.decide(commandCard.id, 'epoch-direct', 'allow_once');
  assert.deepEqual(await commandResponse, { decision: 'accept' });

  const fileResponse = f.bridge.handleServerRequest(101, 'item/fileChange/requestApproval', {
    threadId: 'runtime-thread-1',
    turnId: 'runtime-turn-1',
    itemId: 'file-1',
  });
  const fileCard = f.permissions.snapshot().permissions[0];
  assert.deepEqual(
    [fileCard.category, fileCard.enforcementLevel],
    ['file_write', 'interceptable'],
  );
  f.bridge.decide(fileCard.id, 'epoch-direct', 'deny_once');
  assert.deepEqual(await fileResponse, { decision: 'decline' });

  const requestedPermissions = {
    fileSystem: null,
    network: { enabled: true, host: 'api.example.invalid' },
  };
  const networkResponse = f.bridge.handleServerRequest(102, 'item/permissions/requestApproval', {
    threadId: 'runtime-thread-1',
    turnId: 'runtime-turn-1',
    itemId: 'permission-1',
    permissions: requestedPermissions,
  });
  const networkCard = f.permissions.snapshot().permissions[0];
  assert.deepEqual(
    [networkCard.category, networkCard.enforcementLevel],
    ['network', 'interceptable'],
  );
  f.bridge.decide(networkCard.id, 'epoch-direct', 'allow_once');
  assert.deepEqual(await networkResponse, {
    permissions: requestedPermissions,
    scope: 'turn',
  });

  await assert.rejects(
    f.bridge.handleServerRequest(103, 'item/tool/requestUserInput', {
      threadId: 'runtime-thread-1',
      turnId: 'runtime-turn-1',
    }),
    /Unsupported Codex server request/,
  );
  assert.equal(f.permissions.snapshot().permissions.length, 0);
});

test('Interrupt Resume and old Epoch invalidation use stable Host to Runtime mappings', async (t) => {
  const f = fixture(t);
  f.bridge.bindThread('runtime-thread-1', 'session-1');
  f.bridge.acceptNotification('turn/started', {
    threadId: 'runtime-thread-1',
    turn: { id: 'runtime-turn-1', status: 'inProgress' },
  });
  const hostTurn = f.database.sqlite.prepare(
    'SELECT id FROM session_turns WHERE session_id=? AND runtime_turn_id=?',
  ).get('session-1', 'runtime-turn-1');
  const calls = [];
  const requestHandle = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'thread/start') return { thread: { id: params.fixtureThreadId } };
      if (method === 'turn/start') return { turn: { id: 'runtime-turn-started' } };
      if (method === 'thread/resume') return { thread: { id: params.threadId } };
      return {};
    },
  };

  await f.bridge.interrupt(requestHandle, 'session-1', hostTurn.id);
  assert.deepEqual(calls.at(-1), {
    method: 'turn/interrupt',
    params: { threadId: 'runtime-thread-1', turnId: 'runtime-turn-1' },
  });
  assert.equal(await f.bridge.resume(requestHandle, 'session-1'), 'runtime-thread-1');
  assert.equal(await f.bridge.startThread(requestHandle, 'session-3', {
    fixtureThreadId: 'runtime-thread-3',
  }), 'runtime-thread-3');
  assert.equal(await f.bridge.startTurn(requestHandle, 'session-3', [{ type: 'text', text: 'fixture' }]),
    'runtime-turn-started');
  assert.equal(f.database.sqlite.prepare(
    'SELECT status FROM session_turns WHERE session_id=? AND runtime_turn_id=?',
  ).get('session-3', 'runtime-turn-started').status, 'queued');

  const stale = f.bridge.handleServerRequest(104, 'item/commandExecution/requestApproval', {
    threadId: 'runtime-thread-1',
    turnId: 'runtime-turn-1',
  });
  const staleRejected = assert.rejects(stale, /invalidated by connection epoch change/);
  const staleCard = f.permissions.snapshot().permissions[0];
  assert.throws(() => f.bridge.decide(staleCard.id, 'wrong-epoch', 'allow_once'), /Stale permission/);
  assert.equal(f.bridge.invalidateEpoch('runtime_reconnected'), 1);
  await staleRejected;
  assert.throws(
    () => f.bridge.decide(staleCard.id, 'epoch-direct', 'allow_once'),
    CodexBridgeError,
  );
  const snapshot = f.permissions.snapshot();
  assert.equal(snapshot.audits.at(-1).decision, 'invalidated');
  assert.equal(snapshot.attention.some((item) => (
    item.kind === 'recovery_uncertain' && item.status === 'open'
  )), true);
});

test('adapter routes notifications and server approvals through its single JSONL reader', async (t) => {
  const f = fixture(t);
  const adapter = new CodexRuntimeAdapter(f.database, f.environments, {
    executionEnvironmentId: f.environment.id,
    schemaManifestPath: join(schemaRoot, 'schema-manifest.json'),
    schemaBundlePath: join(schemaRoot, 'codex_app_server_protocol.schemas.json'),
    candidates: () => [{
      executable: process.execPath,
      prefixArgs: [fakeCli, f.configPath],
      source: 'explicit',
    }],
    now: f.now,
    id: f.id,
    daemonBootId: 'daemon:bridge-integration',
  });
  const profile = adapter.probe();
  const handle = await adapter.start(profile.id, f.directory);
  const handleRecord = f.database.readRuntimeHandle(handle.id);
  const bridge = new CodexSessionBridge(f.database, f.permissions, handleRecord, {
    now: f.now,
    id: f.id,
  });
  bridge.bindThread('runtime-thread-integrated', 'session-1');
  adapter.bindProtocolBridge(handle.id, bridge);
  assert.equal(bridge.eventReaderCount, 1);

  await handle.request('fixture/emit-notification', {
    notification: {
      method: 'turn/started',
      params: {
        threadId: 'runtime-thread-integrated',
        turn: { id: 'runtime-turn-integrated', status: 'inProgress' },
      },
    },
  });
  await waitFor(() => f.database.sqlite.prepare(
    'SELECT id FROM session_turns WHERE session_id=? AND runtime_turn_id=?',
  ).get('session-1', 'runtime-turn-integrated'));

  await handle.request('fixture/emit-server-request', {
    request: {
      id: 900,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'runtime-thread-integrated',
        turnId: 'runtime-turn-integrated',
        itemId: 'command-integrated',
      },
    },
  });
  const card = await waitFor(() => f.permissions.snapshot().permissions[0]);
  bridge.decide(card.id, handleRecord.connectionEpoch, 'allow_once');
  const response = await waitFor(async () => {
    const value = await handle.request('fixture/read-client-response');
    return value?.id === 900 ? value : null;
  });
  assert.deepEqual(response, { id: 900, result: { decision: 'accept' } });
  await handle.stop();
});