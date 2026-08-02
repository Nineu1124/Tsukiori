export const IPC_PROTOCOL_VERSION = 1 as const;
export const IPC_MAX_MESSAGE_BYTES = 65_536 as const;

export type IpcChallenge = {
  type: 'ipc.challenge';
  daemonInstanceId: string;
  protocolVersion: number;
  challenge: string;
  connectionEpoch: string;
};

export type IpcAuthenticated = {
  type: 'ipc.authenticated';
  daemonInstanceId: string;
  protocolVersion: number;
  connectionEpoch: string;
  peerIdentityVerified: boolean;
  snapshotVersion: number;
  streamId: string;
  latestStreamSequence: number;
};

export type IpcError = {
  type: 'ipc.error';
  code:
    | 'authentication_required'
    | 'incompatible_protocol'
    | 'stale_instance'
    | 'invalid_proof'
    | 'invalid_json';
};

export type StreamEvent = {
  streamSequence: number;
  type: string;
  payload: unknown;
};

export type SubscriptionResult = {
  mode: 'incremental' | 'snapshot';
  snapshot: {
    version: number;
    daemonState: string;
    openSessions: unknown[];
  } | null;
  streamId: string;
  latestStreamSequence: number;
  events: StreamEvent[];
};

export function isIpcChallenge(value: unknown): value is IpcChallenge {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    item.type === 'ipc.challenge' &&
    typeof item.daemonInstanceId === 'string' &&
    typeof item.protocolVersion === 'number' &&
    typeof item.challenge === 'string' &&
    /^[a-f0-9]{64}$/.test(item.challenge) &&
    typeof item.connectionEpoch === 'string'
  );
}

export function isIpcAuthenticated(value: unknown): value is IpcAuthenticated {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    item.type === 'ipc.authenticated' &&
    typeof item.daemonInstanceId === 'string' &&
    typeof item.protocolVersion === 'number' &&
    typeof item.connectionEpoch === 'string' &&
    item.peerIdentityVerified === true &&
    typeof item.snapshotVersion === 'number' &&
    typeof item.streamId === 'string' &&
    typeof item.latestStreamSequence === 'number'
  );
}

export function isIpcError(value: unknown): value is IpcError {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return item.type === 'ipc.error' && typeof item.code === 'string';
}
