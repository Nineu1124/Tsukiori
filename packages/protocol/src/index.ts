import { IPC_PROTOCOL_VERSION } from './ipc.js';

export * from './ipc.js';
export const HOST_PROTOCOL_VERSION = 1 as const;
export const DAEMON_VERSION = '1.0.0-rc.8' as const;

export type DaemonReadyMessage = {
  type: 'daemon.ready';
  protocolVersion: typeof HOST_PROTOCOL_VERSION;
  daemonVersion: typeof DAEMON_VERSION;
  instanceId: string;
  pid: number;
  pipeHostPid: number;
  pipeName: string;
  ipcProtocolVersion: typeof IPC_PROTOCOL_VERSION;
};

export type DaemonStatusMessage = {
  type: 'daemon.status';
  requestId: string;
  protocolVersion: typeof HOST_PROTOCOL_VERSION;
  daemonVersion: typeof DAEMON_VERSION;
  instanceId: string;
  pid: number;
};

export type DaemonStoppingMessage = {
  type: 'daemon.stopping';
  requestId: string;
  daemonVersion: typeof DAEMON_VERSION;
  instanceId: string;
};

export type DaemonErrorMessage = {
  type: 'daemon.error';
  requestId: string | null;
  code: 'invalid_message' | 'version_mismatch';
};

export type DaemonMessage =
  | DaemonReadyMessage
  | DaemonStatusMessage
  | DaemonStoppingMessage
  | DaemonErrorMessage;

export type DaemonControlMessage =
  | {
      type: 'daemon.probe';
      requestId: string;
    }
  | {
      type: 'daemon.shutdown';
      requestId: string;
      expectedVersion: string;
    };

export function parseDaemonControlMessage(value: unknown): DaemonControlMessage | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.type === 'daemon.probe' &&
    typeof candidate.requestId === 'string' &&
    candidate.requestId.length > 0
  ) {
    return {
      type: 'daemon.probe',
      requestId: candidate.requestId,
    };
  }
  if (
    candidate.type === 'daemon.shutdown' &&
    typeof candidate.requestId === 'string' &&
    candidate.requestId.length > 0 &&
    typeof candidate.expectedVersion === 'string'
  ) {
    return {
      type: 'daemon.shutdown',
      requestId: candidate.requestId,
      expectedVersion: candidate.expectedVersion,
    };
  }
  return null;
}

export function isDaemonMessage(value: unknown): value is DaemonMessage {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.type !== 'string') {
    return false;
  }
  if (candidate.type === 'daemon.ready') {
    return (
      candidate.protocolVersion === HOST_PROTOCOL_VERSION &&
      candidate.daemonVersion === DAEMON_VERSION &&
      typeof candidate.instanceId === 'string' &&
      typeof candidate.pid === 'number' &&
      typeof candidate.pipeHostPid === 'number' &&
      typeof candidate.pipeName === 'string' &&
      candidate.ipcProtocolVersion === IPC_PROTOCOL_VERSION
    );
  }
  if (candidate.type === 'daemon.status') {
    return (
      typeof candidate.requestId === 'string' &&
      candidate.protocolVersion === HOST_PROTOCOL_VERSION &&
      candidate.daemonVersion === DAEMON_VERSION &&
      typeof candidate.instanceId === 'string' &&
      typeof candidate.pid === 'number'
    );
  }
  if (candidate.type === 'daemon.stopping') {
    return (
      typeof candidate.requestId === 'string' &&
      candidate.daemonVersion === DAEMON_VERSION &&
      typeof candidate.instanceId === 'string'
    );
  }
  return (
    candidate.type === 'daemon.error' &&
    (typeof candidate.requestId === 'string' || candidate.requestId === null) &&
    (candidate.code === 'invalid_message' || candidate.code === 'version_mismatch')
  );
}
