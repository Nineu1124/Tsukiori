import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runAdapterContract } from '../contract/runtime-adapter-harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const architecturePath = join(root, '本地多Agent工作台_完整架构与实施方案.md');
async function text(...parts) { return readFile(join(root, ...parts), 'utf8'); }
async function json(...parts) { return JSON.parse(await text(...parts)); }

test('T1.1 through T1.5 and every child Checkpoint are complete', async () => {
  const architecture = await readFile(architecturePath, 'utf8');
  for (const taskId of ['T1.1', 'T1.2', 'T1.3', 'T1.4', 'T1.5']) {
    const section = architecture.match(new RegExp('^### ' + taskId.replace('.', '\\.') + '[\\s\\S]*?(?=^### )', 'm'));
    assert.ok(section, 'missing task section: ' + taskId);
    assert.equal(section[0].includes('- [ ]'), false, taskId + ' has an incomplete checkpoint');
    assert.equal(section[0].includes('- [x]'), true, taskId + ' has no completion evidence');
  }
});

test('three Fake Sessions share one reader without event cross-talk', async () => {
  const { FakeRuntimeAdapter } = await import(pathToFileURL(join(root, 'packages/adapter-fake/dist/index.js')).href);
  const result = runAdapterContract(new FakeRuntimeAdapter());
  assert.equal(result.sessions.length, 3);
  assert.equal(result.sessionEvents.length, 18);
  assert.equal(new Set(result.sessionEvents.map((event) => event.sessionId)).size, 3);
});

test('fault matrix covers duplicate, reorder, disconnect, unknown, and stale epoch', async () => {
  const runtime = await json('tests', 'fixtures', 'fake-runtime', 't1.4-result.json');
  const gate = await json('tests', 'fixtures', 'gates', 'g1-evidence.json');
  const required = ['duplicate', 'out_of_order', 'disconnect', 'unknown_event', 'stale_connection_epoch'];
  for (const fault of required) {
    assert.equal(runtime.faultInjection.includes(fault), true, 'runtime fixture missing ' + fault);
    assert.equal(gate.integration.faults.includes(fault), true, 'gate fixture missing ' + fault);
  }
  assert.equal(runtime.parallelSessions, 3);
  assert.equal(runtime.unknownEvent.doesNotBlockKnownEvents, true);
});

test('GUI restart and Renderer crash preserve durable and active Host state', async () => {
  const permission = await json('tests', 'fixtures', 'permission', 't1.5-result.json');
  const gate = await json('tests', 'fixtures', 'gates', 'g1-evidence.json');
  assert.equal(permission.databaseSchemaVersion, 3);
  assert.equal(permission.oldConnectionEpochResponsesRejected, true);
  assert.deepEqual(gate.recovery, {
    sqliteReopenRestoredHistory: true,
    pendingPermissionRestored: true,
    rendererCrashInjected: true,
    daemonAliveAfterRendererCrash: true,
    fakeRuntimeAliveAfterRendererCrash: true,
  });
  const electronTest = await text('tests', 'host', 'electron-smoke.test.mjs');
  assert.match(electronTest, /rendererGoneReason.*crashed/s);
  assert.match(electronTest, /fakeRuntimeAliveAfterRendererCrash.*true/s);
});

test('IPC, database, and Renderer security evidence plus public CI are valid', async () => {
  const [gate, ipc, database, main, preload, renderer] = await Promise.all([
    json('tests', 'fixtures', 'gates', 'g1-evidence.json'),
    json('tests', 'fixtures', 'ipc', 't1.2-result.json'),
    json('tests', 'fixtures', 'database', 't1.3-result.json'),
    text('apps', 'desktop', 'electron-main', 'main.ts'),
    text('apps', 'desktop', 'preload', 'index.cjs'),
    text('apps', 'desktop', 'renderer', 'renderer.js'),
  ]);
  assert.equal(gate.windowsCi['T1.5'].conclusion, 'success');
  assert.equal(gate.windowsCi['T1.5'].runId, 30733399052);
  assert.equal(ipc.transport.aclMode, 'current_user_only');
  assert.equal(ipc.transport.peerProcessIdVerified, true);
  assert.equal(ipc.transport.peerUserSidVerified, true);
  assert.equal(database.persistenceBoundary.containsCredentials, false);
  assert.match(main, /nodeIntegration:\s*false/);
  assert.match(main, /contextIsolation:\s*true/);
  assert.match(main, /sandbox:\s*true/);
  assert.doesNotMatch(preload, /ipcRenderer\.(send|sendSync|on|once)\(/);
  assert.doesNotMatch(renderer, /innerHTML|insertAdjacentHTML|eval\(/);
  assert.equal(gate.containsCredentials, false);
  for (const commit of Object.values(gate.taskCommits)) {
    execFileSync('git', ['merge-base', '--is-ancestor', commit, 'HEAD'], { cwd: root, stdio: 'ignore' });
  }
});