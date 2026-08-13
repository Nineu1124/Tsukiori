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

export type SubscriptionRecovery = {
  state: 'incremental_replay' | 'snapshot_recovery' | 'unrecoverable';
  reason: string;
  requestedAfter: number;
  retainedFrom: number;
  latestStreamSequence: number;
  snapshotVersion: number;
  autoReplay: false;
};

export type SubscriptionSnapshot = {
  version: number;
  daemonState: string;
  openSessions: unknown[];
};

export type SubscriptionResult = {
  mode: 'incremental' | 'snapshot' | 'unrecoverable';
  snapshot: SubscriptionSnapshot | null;
  streamId: string;
  latestStreamSequence: number;
  events: StreamEvent[];
  recovery: SubscriptionRecovery;
};

export function isSubscriptionResult(value: unknown): value is SubscriptionResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const recovery = item.recovery;
  if (!recovery || typeof recovery !== 'object' || Array.isArray(recovery)) return false;
  const facts = recovery as Record<string, unknown>;
  const events = Array.isArray(item.events) ? item.events : null;
  if (!events || !events.every(isStreamEvent)) return false;
  const sequences = events.map((event) => (event as StreamEvent).streamSequence);
  if (sequences.some((sequence, index) => index > 0 && sequence <= sequences[index - 1]!)) return false;
  const mode = item.mode;
  const state = facts.state;
  if (!(
    (mode === 'incremental' && state === 'incremental_replay' && item.snapshot === null)
    || (mode === 'snapshot' && state === 'snapshot_recovery' && isSnapshot(item.snapshot))
    || (mode === 'unrecoverable' && state === 'unrecoverable' && item.snapshot === null && events.length === 0)
  )) return false;
  return typeof item.streamId === 'string' && item.streamId.length > 0
    && nonNegativeInteger(item.latestStreamSequence)
    && typeof facts.reason === 'string' && /^[a-z0-9_.-]{1,80}$/.test(facts.reason)
    && nonNegativeInteger(facts.requestedAfter)
    && nonNegativeInteger(facts.retainedFrom)
    && nonNegativeInteger(facts.latestStreamSequence)
    && facts.latestStreamSequence === item.latestStreamSequence
    && nonNegativeInteger(facts.snapshotVersion)
    && sequences.every((sequence) => sequence <= Number(item.latestStreamSequence))
    && (mode !== 'snapshot'
      || (item.snapshot as SubscriptionSnapshot).version === facts.snapshotVersion)
    && facts.autoReplay === false;
}

function isStreamEvent(value: unknown): value is StreamEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return nonNegativeInteger(event.streamSequence)
    && event.streamSequence > 0
    && typeof event.type === 'string'
    && event.type.length > 0;
}

function isSnapshot(value: unknown): value is SubscriptionSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const snapshot = value as Record<string, unknown>;
  return nonNegativeInteger(snapshot.version)
    && typeof snapshot.daemonState === 'string'
    && Array.isArray(snapshot.openSessions);
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

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
