import assert from 'node:assert/strict';
import { join, dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const daemonEntry = join(repositoryRoot, 'apps', 'daemon', 'dist', 'main.js');
const supervisorModule = await import(
  pathToFileURL(
    join(repositoryRoot, 'apps', 'desktop', 'dist', 'electron-main', 'daemon-supervisor.js'),
  ).href
);
const protocol = await import(
  pathToFileURL(join(repositoryRoot, 'packages', 'protocol', 'dist', 'index.js')).href
);
const { DaemonSupervisor } = supervisorModule;
const { DAEMON_VERSION, HOST_PROTOCOL_VERSION } = protocol;

test('Desktop supervisor starts, detects, probes, and stops the specified Daemon version', async () => {
  const supervisor = new DaemonSupervisor({
    daemonEntry,
    executable: process.execPath,
    expectedVersion: DAEMON_VERSION,
  });

  const started = await supervisor.start();
  assert.equal(started.state, 'running');
  assert.equal(started.daemonVersion, DAEMON_VERSION);
  assert.equal(started.protocolVersion, HOST_PROTOCOL_VERSION);
  assert.ok(started.pid > 0);

  const status = await supervisor.probe();
  assert.equal(status.pid, started.pid);
  assert.equal(status.instanceId, started.instanceId);

  const initial = await supervisor.reconnectIpc(0, 0);
  assert.equal(initial.mode, 'snapshot');
  assert.equal(initial.snapshot.version, 1);
  assert.deepEqual(initial.events.map(({ streamSequence }) => streamSequence), [1, 2]);

  const resumed = await supervisor.reconnectIpc(1, 1);
  assert.equal(resumed.mode, 'incremental');
  assert.equal(resumed.snapshot, null);
  assert.deepEqual(resumed.events.map(({ streamSequence }) => streamSequence), [2]);

  await supervisor.stop();
  assert.deepEqual(supervisor.snapshot(), {
    state: 'stopped',
    daemonVersion: null,
    protocolVersion: null,
    instanceId: null,
    pid: null,
  });
});

test('Desktop rejects and terminates a Daemon with an unexpected version', async () => {
  const supervisor = new DaemonSupervisor({
    daemonEntry,
    executable: process.execPath,
    expectedVersion: '99.0.0',
  });

  await assert.rejects(
    supervisor.start(),
    /Daemon version mismatch/,
  );
  assert.equal(supervisor.snapshot().state, 'stopped');
});
