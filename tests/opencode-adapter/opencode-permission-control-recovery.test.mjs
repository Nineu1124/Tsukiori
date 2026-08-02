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
const { PermissionBroker } = await import(pathToFileURL(join(root, 'packages/permission-broker/dist/index.js')).href);
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
  const directory = mkdtempSync(join(tmpdir(), 'tsukiori-opencode-control-'));
  const repository = join(directory, 'repository');
  const worktree = join(directory, 'worktree');
  mkdirSync(repository);
  git(['init', '-b', 'main'], repository);
  git(['config', 'user.name', 'Tsukiori Fixture'], repository);
  git(['config', 'user.email', 'fixture@invalid.local'], repository);
  writeFileSync(join(repository, 'README.md'), '# fixture\n');
  git(['add', 'README.md'], repository);
  git(['commit', '-m', 'fixture'], repository);
  git(['worktree', 'add', '-b', 'permission-control', worktree], repository);

  const docBody = JSON.stringify({ openapi: '3.1.0', info: { title: 'OpenCode fixture', version: '1.18.4' } });
  const configPath = join(directory, 'fake-opencode.json');
  writeFileSync(configPath, JSON.stringify({
    version: '1.18.4', credentialCount: 1, docBody, docContentType: 'application/json',
    emitPermissionFlow: false, ...overrides,
  }));
  const manifestPath = join(directory, 'openapi-manifest.json');
  writeFileSync(manifestPath, JSON.stringify({
    runtimeVersion: '1.18.4', contentType: 'application/json',
    sha256: createHash('sha256').update(docBody).digest('hex'), bytes: Buffer.byteLength(docBody),
  }));

  const database = new LocalDatabase({ filePath: join(directory, 'state.db'), blobRoot: join(directory, 'blobs') });
  let clock = 1_800_005_000_000;
  let serial = 0;
  const now = () => ++clock;
  const id = () => 'control-id-' + ++serial;
  const environments = new ExecutionEnvironmentRegistry(database, { gitProbe: new GitProbe(), now });
  const environment = environments.registerWindowsNative({ homePath: directory });
  database.saveProject({
    id: 'project-control', name: 'OpenCode control fixture', executionEnvironmentId: environment.id,
    rootPath: repository, gitRoot: repository, repositoryId: 'repository-control',
    createdAt: now(), updatedAt: now(),
  });
  const permissions = new PermissionBroker(database, { now, id });
  const adapter = new OpenCodeRuntimeAdapter(database, environments, {
    executionEnvironmentId: environment.id,
    openApiManifestPath: manifestPath,
    candidates: () => [{ executable: process.execPath, prefixArgs: [fakeCli, configPath], source: 'explicit' }],
    permissionBroker: permissions,
    now, id, daemonBootId: 'daemon:opencode-control',
  });
  const profile = adapter.probe();
  for (let index = 1; index <= 5; index += 1) {
    database.saveSession({
      id: 'host-session-' + index, title: 'Host Session ' + index, projectId: 'project-control',
      runtimeType: 'opencode', runtimeProfileId: profile.id, lifecycle: 'active', activity: 'idle',
      health: 'healthy', writeMode: 'isolated-worktree', createdAt: now(), updatedAt: now(),
    });
  }
  const handles = [];
  t.after(async () => {
    await Promise.all(handles.map((handle) => handle.stop().catch(() => undefined)));
    database.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  });
  return {
    directory, worktree, database, permissions, adapter, profile,
    async start() { const handle = await adapter.start(profile.id, worktree); handles.push(handle); return handle; },
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

function latestTurn(database, sessionId) {
  return database.sqlite.prepare(
    'SELECT id, status, user_input_json, completed_at FROM session_turns WHERE session_id=? ORDER BY rowid DESC LIMIT 1',
  ).get(sessionId);
}

function permission(database) {
  return database.sqlite.prepare(
    'SELECT id, runtime_handle_id, runtime_request_id, connection_epoch, category, risk, enforcement_level, status, decision FROM permission_requests ORDER BY requested_at DESC LIMIT 1',
  ).get();
}

test('published T3.3 fixture is sanitized and declares explicit recovery states', () => {
  const result = JSON.parse(readFileSync(join(root, 'tests/fixtures/opencode/t3.3-result.json'), 'utf8'));
  assert.equal(result.task, 'T3.3');
  assert.equal(result.permissionEnforcementLevel, 'interceptable');
  assert.equal(result.cancelWithoutPromptReplay, true);
  assert.equal(result.resumeWithoutPromptReplay, true);
  assert.equal(result.oldEpochPermissionRejected, true);
  assert.equal(result.isolatedRuntimeHandles, 2);
  assert.equal(result.unavailableSessionShownAsRunning, false);
  assert.equal(result.rawPromptsCommitted, false);
  assert.equal(result.containsCredentials, false);
  assert.doesNotMatch(JSON.stringify(result), /Bearer\s+|Basic\s+[A-Za-z0-9+/=]+|sk-[A-Za-z0-9]/);
});

test('Permission request exposes actual interceptable Enforcement Level and replies through Runtime', async (t) => {
  const f = fixture(t, { holdPermission: true });
  const handle = await f.start();
  await handle.createSession('host-session-1', 'dpsk', 'deepseek-v4-flash');
  await handle.startTurn('host-session-1', 'permission-fixture-input');
  const pending = await waitFor(() => {
    const row = permission(f.database);
    return row?.status === 'pending' ? row : null;
  });
  const epoch = f.database.readRuntimeHandle(handle.id).connectionEpoch;
  assert.deepEqual({
    handleId: pending.runtime_handle_id,
    epoch: pending.connection_epoch,
    category: pending.category,
    risk: pending.risk,
    enforcement: pending.enforcement_level,
  }, {
    handleId: handle.id,
    epoch,
    category: 'shell',
    risk: 'high',
    enforcement: 'interceptable',
  });
  const card = f.permissions.snapshot().permissions.find((item) => item.id === pending.id);
  assert.equal(card.enforcementLevel, 'interceptable');
  assert.deepEqual(card.availableDecisions, ['allow_once', 'deny_once']);
  const audit = await handle.decidePermission(pending.id, epoch, 'allow_once');
  assert.equal(audit.decision, 'allow_once');
  await waitFor(() => latestTurn(f.database, 'host-session-1')?.status === 'completed');
  assert.equal(permission(f.database).status, 'resolved');
  assert.equal(permission(f.database).decision, 'allow_once');
});

test('Cancel and Resume use Runtime IDs and never replay stored raw prompts', async (t) => {
  const f = fixture(t, { holdFirstTurn: true });
  const handle = await f.start();
  const runtimeSessionId = await handle.createSession('host-session-1', 'dpsk', 'deepseek-v4-flash');
  await handle.startTurn('host-session-1', 'PRIVATE_CANCEL_INPUT_MUST_NOT_PERSIST');
  await waitFor(() => latestTurn(f.database, 'host-session-1')?.status === 'running');
  await handle.cancelTurn('host-session-1');
  assert.equal(latestTurn(f.database, 'host-session-1').status, 'interrupted');
  assert.equal(f.database.readSession('host-session-1').activity, 'idle');
  assert.equal(await handle.resumeSession('host-session-1'), runtimeSessionId);
  await handle.startTurn('host-session-1', 'PRIVATE_RESUME_INPUT_MUST_NOT_PERSIST');
  await waitFor(() => latestTurn(f.database, 'host-session-1')?.status === 'completed');
  const persisted = JSON.stringify({
    session: f.database.readSession('host-session-1'),
    turns: f.database.sqlite.prepare(
      'SELECT status, user_input_json FROM session_turns WHERE session_id=? ORDER BY rowid',
    ).all('host-session-1'),
  });
  assert.doesNotMatch(persisted, /PRIVATE_CANCEL_INPUT_MUST_NOT_PERSIST|PRIVATE_RESUME_INPUT_MUST_NOT_PERSIST/);
  assert.equal(persisted.includes('persistedText'), true);
});

test('Recovery invalidates old Epoch Permission and rejects any later response', async (t) => {
  const f = fixture(t, { holdPermission: true });
  const handle = await f.start();
  await handle.createSession('host-session-1', 'dpsk', 'deepseek-v4-flash');
  await handle.startTurn('host-session-1', 'stale-permission-fixture');
  const pending = await waitFor(() => permission(f.database)?.status === 'pending' ? permission(f.database) : null);
  const oldEpoch = pending.connection_epoch;
  const recovery = await handle.recoverEventStream();
  assert.equal(recovery.previousConnectionEpoch, oldEpoch);
  assert.equal(recovery.invalidatedPermissionCount, 1);
  assert.notEqual(recovery.connectionEpoch, oldEpoch);
  await assert.rejects(
    handle.decidePermission(pending.id, oldEpoch, 'allow_once'),
    /Pending OpenCode Permission|Stale OpenCode Permission/,
  );
  assert.equal(permission(f.database).status, 'invalidated');
  const snapshot = f.permissions.snapshot();
  assert.equal(snapshot.permissions.length, 0);
  assert.equal(snapshot.audits.some((item) => item.requestId === pending.id
    && item.decision === 'invalidated'), true);
  assert.equal(snapshot.attention.some((item) => item.kind === 'recovery_uncertain'
    && item.status === 'open'), true);
});

test('one Runtime Server crash leaves another Handle healthy and never leaves failed Session running', async (t) => {
  const f = fixture(t, { crashOnMarkedSession: true });
  const crashed = await f.start();
  const healthy = await f.start();
  await crashed.createSession('host-session-1', 'dpsk', 'deepseek-v4-flash', 'CRASH fixture');
  await healthy.createSession('host-session-2', 'dpsk', 'deepseek-v4-flash', 'SAFE fixture');
  await assert.rejects(
    crashed.startTurn('host-session-1', 'crash-fixture'),
    /OpenCode Turn failed to start/,
  );
  await waitFor(() => f.database.readRuntimeHandle(crashed.id)?.state === 'exited');
  assert.equal(f.database.readRuntimeHandle(healthy.id).state, 'ready');
  assert.equal(healthy.eventStreamState, 'connected');
  const failedSession = f.database.readSession('host-session-1');
  assert.notEqual(failedSession.activity, 'running');
  assert.equal(failedSession.activity, 'stopped');
  assert.equal(failedSession.health, 'interrupted_runtime');
  assert.equal(['failed', 'interrupted'].includes(latestTurn(f.database, 'host-session-1').status), true);

  await healthy.startTurn('host-session-2', 'healthy-fixture');
  await waitFor(() => latestTurn(f.database, 'host-session-2')?.status === 'completed');
  assert.equal(f.database.readSession('host-session-2').health, 'healthy');
  const processes = f.database.sqlite.prepare(
    'SELECT runtime_handle_id, pid, status FROM process_records WHERE runtime_handle_id IN (?,?) ORDER BY runtime_handle_id',
  ).all(crashed.id, healthy.id);
  assert.equal(new Set(processes.map((item) => item.pid)).size, 2);
  assert.equal(processes.some((item) => item.runtime_handle_id === crashed.id && item.status === 'exited'), true);
  assert.equal(processes.some((item) => item.runtime_handle_id === healthy.id && item.status === 'running'), true);
});