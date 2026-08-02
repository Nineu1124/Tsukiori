import { createHash, randomUUID } from 'node:crypto';
import type { JsonValue, SessionEventRecord } from '@tsukiori/domain';

export type EventScope = 'daemon' | 'runtime' | 'project' | 'session' | 'turn';
export type HostEventType =
  | 'runtime.state_changed' | 'runtime.warning' | 'runtime.error' | 'runtime.exited'
  | 'session.state_changed' | 'turn.state_changed' | 'assistant.message_started'
  | 'assistant.text_delta' | 'assistant.message_completed' | 'tool.started'
  | 'tool.progress' | 'tool.completed' | 'tool.failed' | 'permission.requested'
  | 'permission.resolved' | 'permission.invalidated' | 'user_input.requested'
  | 'user_input.resolved' | 'native.event';

export type RuntimeNativeEvent = {
  nativeType: string;
  payload: unknown;
  connectionEpoch: string;
  nativeSequence?: number;
  runtimeEventId?: string;
  runtimeSessionId?: string;
  runtimeTurnId?: string;
  hostSessionId?: string;
  hostTurnId?: string;
  projectId?: string;
  createdAt?: number;
};

export type EventEnvelope = {
  eventId: string;
  schemaVersion: 1;
  scope: EventScope;
  projectId?: string;
  runtimeHandleId: string;
  sessionId?: string;
  turnId?: string;
  streamId: string;
  streamSequence: number;
  sessionSequence?: number;
  type: HostEventType;
  payload: JsonValue;
  runtimeType: string;
  runtimeEventId?: string;
  runtimeSessionId?: string;
  runtimeTurnId?: string;
  connectionEpoch: string;
  createdAt: number;
  receivedAt: number;
};

export type IngestResult = {
  status: 'accepted' | 'duplicate' | 'buffered' | 'backpressure' | 'stale_epoch';
  events: EventEnvelope[];
};

const knownTypes: Record<string, HostEventType> = {
  'message.started': 'assistant.message_started',
  'text.delta': 'assistant.text_delta',
  'message.completed': 'assistant.message_completed',
  'tool.started': 'tool.started',
  'tool.progress': 'tool.progress',
  'tool.completed': 'tool.completed',
  'tool.failed': 'tool.failed',
  'permission.requested': 'permission.requested',
  'permission.resolved': 'permission.resolved',
  'user_input.requested': 'user_input.requested',
  'user_input.resolved': 'user_input.resolved',
  'session.state': 'session.state_changed',
  'turn.state': 'turn.state_changed',
  'runtime.state': 'runtime.state_changed',
  'runtime.error': 'runtime.error',
  'runtime.exited': 'runtime.exited',
};

const sensitiveKey = /(^|[_-])(api[_-]?key|secret|token|password|cookie|authorization|private[_-]?key)([_-]|$)/i;
const sensitiveValue = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+\/-]{8,}|\bsk-[A-Za-z0-9_-]{12,}/gi;

function sanitize(value: unknown, seen = new Set<object>()): JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.replace(sensitiveValue, '<redacted>');
  if (typeof value !== 'object') return '<unsupported>';
  if (seen.has(value)) return '<cycle>';
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map((item) => sanitize(item, seen));
    seen.delete(value);
    return result;
  }
  const result: Record<string, JsonValue> = {};
  let redactedField = 0;
  for (const [key, item] of Object.entries(value)) {
    if (sensitiveKey.test(key)) {
      redactedField += 1;
      result['redacted_field_' + redactedField] = '<redacted>';
    } else {
      result[key] = sanitize(item, seen);
    }
  }
  seen.delete(value);
  return result;
}

function limit(value: unknown, maxBytes: number): { value: JsonValue; hash: string; truncated: boolean; redacted: boolean } {
  const safe = sanitize(value);
  const serialized = JSON.stringify(safe);
  const hash = createHash('sha256').update(serialized).digest('hex');
  const redacted = serialized.includes('<redacted>');
  if (Buffer.byteLength(serialized, 'utf8') <= maxBytes) return { value: safe, hash, truncated: false, redacted };
  const preview = Buffer.from(serialized, 'utf8').subarray(0, Math.max(0, maxBytes - 128)).toString('utf8');
  return { value: { preview, contentHash: hash }, hash, truncated: true, redacted };
}

export class EventNormalizer {
  readonly #runtimeHandleId: string;
  readonly #runtimeType: string;
  readonly #streamId: string;
  readonly #maxBuffered: number;
  readonly #maxPayloadBytes: number;
  #epoch: string;
  #streamSequence = 0;
  #sessionSequences = new Map<string, number>();
  #expected = new Map<string, number>();
  #buffers = new Map<string, Map<number, RuntimeNativeEvent>>();
  #seen = new Set<string>();

  constructor(options: {
    runtimeHandleId: string;
    runtimeType: string;
    streamId?: string;
    connectionEpoch: string;
    maxBuffered?: number;
    maxPayloadBytes?: number;
  }) {
    this.#runtimeHandleId = options.runtimeHandleId;
    this.#runtimeType = options.runtimeType;
    this.#streamId = options.streamId ?? options.runtimeHandleId;
    this.#epoch = options.connectionEpoch;
    this.#maxBuffered = options.maxBuffered ?? 64;
    this.#maxPayloadBytes = options.maxPayloadBytes ?? 16 * 1024;
  }

  get connectionEpoch(): string { return this.#epoch; }

  changeConnectionEpoch(epoch: string): EventEnvelope[] {
    const previous = this.#epoch;
    this.#epoch = epoch;
    this.#expected.clear();
    this.#buffers.clear();
    this.#seen.clear();
    return [this.#envelope({
      nativeType: 'runtime.state', connectionEpoch: epoch,
      payload: { state: 'reconnected', previousConnectionEpoch: previous },
    })];
  }

  ingest(event: RuntimeNativeEvent): IngestResult {
    if (event.connectionEpoch !== this.#epoch) return { status: 'stale_epoch', events: [] };
    const route = event.runtimeSessionId ?? '$runtime';
    const dedupeKey = event.runtimeEventId
      ? event.connectionEpoch + '|' + event.runtimeEventId
      : event.nativeSequence === undefined ? null : event.connectionEpoch + '|' + route + '|' + event.nativeSequence;
    if (dedupeKey && this.#seen.has(dedupeKey)) return { status: 'duplicate', events: [] };
    if (event.nativeSequence === undefined) {
      if (dedupeKey) this.#seen.add(dedupeKey);
      return { status: 'accepted', events: [this.#envelope(event)] };
    }

    const expected = this.#expected.get(route) ?? 1;
    if (event.nativeSequence < expected) return { status: 'duplicate', events: [] };
    if (event.nativeSequence > expected) {
      const buffer = this.#buffers.get(route) ?? new Map<number, RuntimeNativeEvent>();
      if (!buffer.has(event.nativeSequence) && buffer.size >= this.#maxBuffered) {
        return { status: 'backpressure', events: [] };
      }
      buffer.set(event.nativeSequence, event);
      this.#buffers.set(route, buffer);
      if (dedupeKey) this.#seen.add(dedupeKey);
      return { status: 'buffered', events: [] };
    }

    const output: EventEnvelope[] = [];
    let current: RuntimeNativeEvent | undefined = event;
    let sequence = expected;
    while (current) {
      const key = current.runtimeEventId
        ? current.connectionEpoch + '|' + current.runtimeEventId
        : current.connectionEpoch + '|' + route + '|' + sequence;
      this.#seen.add(key);
      output.push(this.#envelope(current));
      sequence += 1;
      const buffer = this.#buffers.get(route);
      current = buffer?.get(sequence);
      if (current) buffer?.delete(sequence);
    }
    this.#expected.set(route, sequence);
    return { status: 'accepted', events: output };
  }

  snapshotRecovery(sessions: readonly { sessionId: string; activity: string; health: string }[]): EventEnvelope[] {
    const warning = this.#envelope({
      nativeType: 'runtime.unknown', connectionEpoch: this.#epoch,
      payload: { reason: 'event_replay_unavailable', mode: 'snapshot_recovery' },
    }, 'runtime.warning');
    return [warning, ...sessions.map((session) => this.#envelope({
      nativeType: 'session.state', connectionEpoch: this.#epoch,
      runtimeSessionId: session.sessionId,
      payload: { activity: session.activity, health: session.health, recoveredFromSnapshot: true },
    }))];
  }

  #envelope(event: RuntimeNativeEvent, forcedType?: HostEventType): EventEnvelope {
    const receivedAt = Date.now();
    const limited = limit(event.payload, this.#maxPayloadBytes);
    const hostType = forcedType ?? knownTypes[event.nativeType] ?? 'native.event';
    const sessionId = event.hostSessionId ?? event.runtimeSessionId;
    const turnId = event.hostTurnId ?? event.runtimeTurnId;
    const sessionSequence = sessionId
      ? (this.#sessionSequences.get(sessionId) ?? 0) + 1
      : undefined;
    if (sessionId && sessionSequence) this.#sessionSequences.set(sessionId, sessionSequence);
    const payload: JsonValue = hostType === 'native.event'
      ? {
          nativeType: event.nativeType,
          redacted: limited.redacted,
          truncated: limited.truncated,
          raw: limited.value,
          contentHash: limited.hash,
        }
      : limited.value;
    this.#streamSequence += 1;
    return {
      eventId: randomUUID(), schemaVersion: 1,
      scope: sessionId ? (turnId ? 'turn' : 'session') : 'runtime',
      ...(event.projectId ? { projectId: event.projectId } : {}),
      runtimeHandleId: this.#runtimeHandleId,
      ...(sessionId ? { sessionId } : {}),
      ...(turnId ? { turnId } : {}),
      streamId: this.#streamId, streamSequence: this.#streamSequence,
      ...(sessionSequence ? { sessionSequence } : {}),
      type: hostType, payload, runtimeType: this.#runtimeType,
      ...(event.runtimeEventId ? { runtimeEventId: event.runtimeEventId } : {}),
      ...(event.runtimeSessionId ? { runtimeSessionId: event.runtimeSessionId } : {}),
      ...(event.runtimeTurnId ? { runtimeTurnId: event.runtimeTurnId } : {}),
      connectionEpoch: event.connectionEpoch,
      createdAt: event.createdAt ?? receivedAt, receivedAt,
    };
  }
}
export function toSessionEventRecord(event: EventEnvelope): SessionEventRecord {
  return {
    id: event.eventId,
    schemaVersion: event.schemaVersion,
    scope: event.scope,
    ...(event.projectId ? { projectId: event.projectId } : {}),
    runtimeHandleId: event.runtimeHandleId,
    ...(event.sessionId ? { sessionId: event.sessionId } : {}),
    ...(event.turnId ? { turnId: event.turnId } : {}),
    streamId: event.streamId,
    streamSequence: event.streamSequence,
    ...(event.sessionSequence ? { sessionSequence: event.sessionSequence } : {}),
    eventType: event.type,
    normalizedPayload: event.payload,
    runtimeType: event.runtimeType,
    ...(event.runtimeEventId ? { runtimeEventId: event.runtimeEventId } : {}),
    connectionEpoch: event.connectionEpoch,
    createdAt: event.createdAt,
    receivedAt: event.receivedAt,
  };
}