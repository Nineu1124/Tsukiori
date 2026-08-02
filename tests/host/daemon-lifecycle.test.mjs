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
