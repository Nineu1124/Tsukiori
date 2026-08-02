import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import {
  DAEMON_VERSION,
  HOST_PROTOCOL_VERSION,
  parseDaemonControlMessage,
  type DaemonMessage,
} from '@tsukiori/protocol';

const instanceId = randomUUID();
let stopping = false;

function send(message: DaemonMessage, callback?: () => void): void {
  process.stdout.write(JSON.stringify(message) + '\n', callback);
}

function stop(requestId: string): void {
  if (stopping) {
    return;
  }
  stopping = true;
  input.close();
  process.stdin.pause();
  send({
    type: 'daemon.stopping',
    requestId,
    daemonVersion: DAEMON_VERSION,
    instanceId,
  }, () => process.exit(0));
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
  if (!stopping) {
    process.exitCode = 0;
  }
});

process.on('SIGTERM', () => stop('signal'));
process.on('SIGINT', () => stop('signal'));

send({
  type: 'daemon.ready',
  protocolVersion: HOST_PROTOCOL_VERSION,
  daemonVersion: DAEMON_VERSION,
  instanceId,
  pid: process.pid,
});
