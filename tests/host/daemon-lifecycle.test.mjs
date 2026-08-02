import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

test('keep policy survives GUI release, reauthenticates the same Daemon, and stop removes its lease', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tsukiori-daemon-lease-'));
  const leaseFile = join(directory, 'daemon-lease.json');
  t.after(() => {
    if (existsSync(leaseFile)) {
      try {
        const lease = JSON.parse(readFileSync(leaseFile, 'utf8'));
        process.kill(lease.pid, 'SIGTERM');
      } catch {}
    }
    rmSync(directory, { recursive: true, force: true });
  });
  const first = new DaemonSupervisor({
    daemonEntry, executable: process.execPath, expectedVersion: DAEMON_VERSION,
    leaseFile, exitPolicy: 'keep',
  });
  const started = await first.start();
  assert.equal(existsSync(leaseFile), true);
  const lease = JSON.parse(readFileSync(leaseFile, 'utf8'));
  assert.match(lease.bootstrapSecretRef, /^secretref:[a-f0-9-]{36}$/);
  assert.equal('bootstrapToken' in lease, false);
  await first.release();
  assert.equal(first.snapshot().state, 'stopped');

  const second = new DaemonSupervisor({
    daemonEntry, executable: process.execPath, expectedVersion: DAEMON_VERSION,
    leaseFile, exitPolicy: 'stop',
  });
  const attached = await second.start();
  assert.equal(attached.instanceId, started.instanceId);
  assert.equal(attached.pid, started.pid);
  const probe = await second.probe();
  assert.equal(probe.instanceId, started.instanceId);
  assert.equal(probe.pid, started.pid);
  await second.release();
  assert.equal(second.snapshot().state, 'stopped');
  assert.equal(existsSync(leaseFile), false);
});
