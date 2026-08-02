import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  DAEMON_VERSION,
  HOST_PROTOCOL_VERSION,
  IPC_PROTOCOL_VERSION,
  parseDaemonControlMessage,
  type DaemonMessage,
} from '@tsukiori/protocol';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const instanceId = randomUUID();
const pipeName = 'tsukiori-' + instanceId;
const bootstrapToken = process.env.TSUKIORI_IPC_BOOTSTRAP_TOKEN;
const leaseFile = process.env.TSUKIORI_DAEMON_LEASE_FILE;
const bootstrapSecretRef = process.env.TSUKIORI_IPC_BOOTSTRAP_REF;
if (!bootstrapToken || bootstrapToken.length < 32) {
  throw new Error('Daemon requires a parent-provided IPC bootstrap token');
}
if (leaseFile && (!bootstrapSecretRef || !/^secretref:[a-f0-9-]{36}$/.test(bootstrapSecretRef))) {
  throw new Error('Persistent Daemon requires an OS Credential Manager Secret Reference');
}
let stopping = false;
let pipeHost: ChildProcess | null = null;

function removeLease(): void {
  if (!leaseFile || !existsSync(leaseFile)) return;
  try {
    const value = JSON.parse(readFileSync(leaseFile, 'utf8')) as Record<string, unknown>;
    if (value.instanceId === instanceId) unlinkSync(leaseFile);
  } catch {
    // Never remove a lease that cannot be attributed to this exact Daemon instance.
  }
}

function publishLease(): void {
  if (!leaseFile) return;
  mkdirSync(dirname(leaseFile), { recursive: true });
  const temporary = leaseFile + '.' + instanceId + '.tmp';
  writeFileSync(temporary, JSON.stringify({
    schemaVersion: 1,
    daemonVersion: DAEMON_VERSION,
    protocolVersion: HOST_PROTOCOL_VERSION,
    ipcProtocolVersion: IPC_PROTOCOL_VERSION,
    instanceId,
    pid: process.pid,
    pipeName,
    bootstrapSecretRef,
    createdAt: Date.now(),
  }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  renameSync(temporary, leaseFile);
}

function send(message: DaemonMessage, callback?: () => void): void {
  process.stdout.write(JSON.stringify(message) + '\n', callback);
}

async function startPipeHost(): Promise<void> {
  const archivedScript = resolve(currentDirectory, 'windows', 'named-pipe-host.ps1');
  const unpackedScript = archivedScript.replace(
    sep + 'app.asar' + sep,
    sep + 'app.asar.unpacked' + sep,
  );
  const script = unpackedScript !== archivedScript && existsSync(unpackedScript)
    ? unpackedScript
    : archivedScript;
  const child = spawn(
    process.env.TSUKIORI_PWSH_EXECUTABLE ?? 'pwsh.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-File',
      script,
      '-PipeName',
      pipeName,
      '-DaemonInstanceId',
      instanceId,
      '-ProtocolVersion',
      String(IPC_PROTOCOL_VERSION),
      '-DaemonPid',
      String(process.pid),
      '-MaxConnections',
      '256',
    ],
    {
      env: {
        ...process.env,
        TSUKIORI_IPC_BOOTSTRAP_TOKEN: bootstrapToken,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  if (!child.stdout || !child.stderr) {
    child.kill();
    throw new Error('Named Pipe host stdio was not created');
  }
  pipeHost = child;
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-4096);
  });
  const output = createInterface({ input: child.stdout, crlfDelay: Infinity });
  await new Promise<void>((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => {
      rejectReady(new Error('Timed out waiting for pipe.ready'));
    }, 15_000);
    output.on('line', (line) => {
      try {
        const value = JSON.parse(line) as Record<string, unknown>;
        if (
          value.type === 'pipe.ready' &&
          value.pipeName === pipeName &&
          value.daemonInstanceId === instanceId
        ) {
          clearTimeout(timeout);
          resolveReady();
        }
      } catch {
        // The child transport is untrusted until it emits the exact ready envelope.
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      rejectReady(new Error('Named Pipe host exited: ' + code + ' ' + stderr));
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      rejectReady(error);
    });
  });
  child.once('exit', (code) => {
    if (!stopping) {
      removeLease();
      process.exit(code === 0 ? 0 : 1);
    }
  });
}

function stop(requestId: string): void {
  if (stopping) return;
  stopping = true;
  input.close();
  process.stdin.pause();
  if (pipeHost?.exitCode === null) {
    pipeHost.kill('SIGTERM');
  }
  send({
    type: 'daemon.stopping',
    requestId,
    daemonVersion: DAEMON_VERSION,
    instanceId,
  }, () => {
    removeLease();
    process.exit(0);
  });
}

process.title = 'tsukiori-daemon';

const input = createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

input.on('line', (line) => {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    send({
      type: 'daemon.error',
      requestId: null,
      code: 'invalid_message',
    });
    return;
  }

  const message = parseDaemonControlMessage(value);
  if (!message) {
    send({
      type: 'daemon.error',
      requestId: null,
      code: 'invalid_message',
    });
    return;
  }

  if (message.type === 'daemon.probe') {
    send({
      type: 'daemon.status',
      requestId: message.requestId,
      protocolVersion: HOST_PROTOCOL_VERSION,
      daemonVersion: DAEMON_VERSION,
      instanceId,
      pid: process.pid,
    });
    return;
  }

  if (message.expectedVersion !== DAEMON_VERSION) {
    send({
      type: 'daemon.error',
      requestId: message.requestId,
      code: 'version_mismatch',
    });
    return;
  }
  stop(message.requestId);
});

input.on('close', () => {
  if (!stopping) process.exitCode = 0;
});
process.on('SIGTERM', () => stop('signal'));
process.on('SIGINT', () => stop('signal'));
process.on('exit', removeLease);

await startPipeHost();
publishLease();
send({
  type: 'daemon.ready',
  protocolVersion: HOST_PROTOCOL_VERSION,
  daemonVersion: DAEMON_VERSION,
  instanceId,
  pid: process.pid,
  pipeName,
  ipcProtocolVersion: IPC_PROTOCOL_VERSION,
});
