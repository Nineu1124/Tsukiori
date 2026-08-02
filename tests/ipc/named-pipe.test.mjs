import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const hostScript = join(repositoryRoot, 'apps', 'daemon', 'windows', 'named-pipe-host.ps1');
const clientModulePath = join(
  repositoryRoot,
  'apps',
  'desktop',
  'dist',
  'electron-main',
  'named-pipe-client.js',
);
const { NamedPipeClient } = await import(pathToFileURL(clientModulePath).href);
const sanitizedFixture = JSON.parse(
  readFileSync(join(repositoryRoot, 'tests', 'fixtures', 'ipc', 't1.2-result.json'), 'utf8'),
);

async function startHost() {
  const pipeName = 'tsukiori-' + randomUUID();
  const daemonInstanceId = randomUUID();
  const bootstrapToken = randomBytes(32).toString('hex');
  const child = spawn(
    'pwsh.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-File',
      hostScript,
      '-PipeName',
      pipeName,
      '-DaemonInstanceId',
      daemonInstanceId,
      '-ProtocolVersion',
      '1',
      '-DaemonPid',
      String(process.pid),
      '-MaxConnections',
      '12',
    ],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        TSUKIORI_IPC_BOOTSTRAP_TOKEN: bootstrapToken,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const ready = await new Promise((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => {
      rejectReady(new Error('Timed out waiting for pipe.ready; stderr=' + stderr));
    }, 15_000);
    const inspect = () => {
      const line = stdout.split(/\r?\n/).find((value) => value.includes('"type":"pipe.ready"'));
      if (!line) return;
      clearTimeout(timeout);
      resolveReady(JSON.parse(line.slice(line.indexOf('{'))));
    };
    child.stdout.on('data', inspect);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      rejectReady(new Error('Pipe host exited early: ' + code + '; stderr=' + stderr));
    });
    inspect();
  });

  return {
    pipeName,
    daemonInstanceId,
    bootstrapToken,
    child,
    ready,
    getAudit: () => stderr,
    stop: async () => {
      if (child.exitCode === null) child.kill('SIGTERM');
      await new Promise((resolveExit) => {
        if (child.exitCode !== null) resolveExit();
        else child.once('exit', resolveExit);
      });
    },
  };
}

async function connectRawWithRetry(path, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const socket = createConnection({ path });
    try {
      await new Promise((resolveConnect, rejectConnect) => {
        socket.once('connect', resolveConnect);
        socket.once('error', rejectConnect);
      });
      return socket;
    } catch (error) {
      socket.destroy();
      if (error.code !== 'ENOENT' || Date.now() >= deadline) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
  }
}
async function authenticateRaw(host, daemonInstanceId) {
  const socket = await connectRawWithRetry('\\\\.\\pipe\\' + host.pipeName);
  const input = createInterface({ input: socket, crlfDelay: Infinity });
  try {
    const [challengeLine] = await once(input, 'line');
    const challenge = JSON.parse(challengeLine);
    assert.equal(challenge.type, 'ipc.challenge');
    const responsePromise = once(input, 'line');
    socket.write(JSON.stringify({
      type: 'ipc.authenticate',
      daemonInstanceId,
      protocolVersion: 1,
      proof: '0'.repeat(64),
    }) + '\n');
    const [responseLine] = await responsePromise;
    return JSON.parse(responseLine);
  } finally {
    input.close();
    socket.destroy();
  }
}

function clientFor(host, overrides = {}) {
  return new NamedPipeClient({
    pipeName: host.pipeName,
    daemonInstanceId: host.daemonInstanceId,
    protocolVersion: 1,
    bootstrapToken: host.bootstrapToken,
    ...overrides,
  });
}

test('published IPC fixture is sanitized and contains no runtime identity or credential', () => {
  const serialized = JSON.stringify(sanitizedFixture);
  assert.equal(sanitizedFixture.transport.aclMode, 'current_user_only');
  assert.equal(sanitizedFixture.handshake.credentialMaterialPersisted, false);
  assert.equal(sanitizedFixture.audit.containsCredentials, false);
  assert.doesNotMatch(serialized, /S-1-\\d+-/);
  assert.doesNotMatch(serialized, /[a-f0-9]{64}/i);
});

test('CurrentUserOnly pipe verifies peer SID and authenticates a compatible client', async (t) => {
  const host = await startHost();
  t.after(() => host.stop());

  assert.equal(host.ready.aclMode, 'current_user_only');
  assert.equal(host.ready.expectedPeerSid, '<current-user-sid>');

  const client = clientFor(host);
  const authenticated = await client.connect();
  assert.equal(authenticated.peerIdentityVerified, true);
  assert.equal(authenticated.daemonInstanceId, host.daemonInstanceId);
  assert.equal(authenticated.protocolVersion, 1);

  const initial = await client.subscribe(0, 0);
  assert.equal(initial.mode, 'snapshot');
  assert.equal(initial.snapshot.version, 1);
  assert.deepEqual(initial.events.map(({ streamSequence }) => streamSequence), [1, 2]);
  client.close();

  await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  assert.match(host.getAudit(), /"type":"peer\.verified"/);
  assert.match(host.getAudit(), /"reason":"current_user_sid"/);
});

test('GUI reconnect receives only missing increments with a new connection epoch', async (t) => {
  const host = await startHost();
  t.after(() => host.stop());

  const first = clientFor(host);
  const firstAuth = await first.connect();
  const firstResult = await first.subscribe(0, 1);
  assert.equal(firstResult.mode, 'incremental');
  assert.deepEqual(firstResult.events.map(({ streamSequence }) => streamSequence), [1, 2]);
  first.close();

  await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  const second = clientFor(host);
  const secondAuth = await second.connect();
  assert.notEqual(secondAuth.connectionEpoch, firstAuth.connectionEpoch);
  const resumed = await second.subscribe(1, 1);
  assert.equal(resumed.mode, 'incremental');
  assert.deepEqual(resumed.events.map(({ streamSequence }) => streamSequence), [2]);

  await assert.rejects(
    first.request('daemon.ping', {}),
    /not authenticated/,
  );
  second.close();
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  assert.match(host.getAudit(), /connection\.closed/);
});

test('incompatible protocol, stale instance, and invalid proof are rejected and audited', async (t) => {
  const host = await startHost();
  t.after(() => host.stop());

  const incompatible = clientFor(host, { protocolVersion: 99 });
  await assert.rejects(incompatible.connect(), /incompatible_protocol/);
  incompatible.close();

  const stale = clientFor(host, { daemonInstanceId: randomUUID() });
  await assert.rejects(stale.connect(), /instance mismatch/);
  stale.close();

  const staleResponse = await authenticateRaw(host, randomUUID());
  assert.equal(staleResponse.code, 'stale_instance');

  const wrongProof = clientFor(host, {
    bootstrapToken: randomBytes(32).toString('hex'),
  });
  await assert.rejects(wrongProof.connect(), /invalid_proof/);
  wrongProof.close();

  await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  assert.match(host.getAudit(), /incompatible_protocol/);
  assert.match(host.getAudit(), /stale_instance/);
  assert.match(host.getAudit(), /invalid_proof/);
  assert.doesNotMatch(host.getAudit(), new RegExp(host.bootstrapToken, 'i'));
});

test('invalid params, unknown methods, and invalid JSON are rejected', async (t) => {
  const host = await startHost();
  t.after(() => host.stop());

  const client = clientFor(host);
  await client.connect();
  await assert.rejects(client.subscribe(-1, 1), /invalid_params/);
  await assert.rejects(client.request('unknown.method', {}), /method_not_found/);
  client.close();

  let raw;
  try {
    raw = await connectRawWithRetry('\\\\.\\pipe\\' + host.pipeName);
  } catch (error) {
    throw new Error(String(error) + '; exitCode=' + host.child.exitCode + '; audit=' + host.getAudit());
  }
  raw.setEncoding('utf8');
  const lines = [];
  raw.on('data', (chunk) => lines.push(...chunk.split(/\r?\n/).filter(Boolean)));


  await new Promise((resolveLine) => {
    const timer = setInterval(() => {
      if (lines.length > 0) {
        clearInterval(timer);
        resolveLine();
      }
    }, 10);
  });
  raw.write('{not-json}\n');
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  assert.equal(JSON.parse(lines.at(-1)).code, 'invalid_json');
  raw.destroy();
});
