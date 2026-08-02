import { randomUUID } from 'node:crypto';
import {
  EventNormalizer,
  type EventEnvelope,
  type IngestResult,
  type RuntimeNativeEvent,
} from '@tsukiori/runtime-core';

export type FakeSession = {
  runtimeSessionId: string;
  activity: 'idle' | 'running' | 'waiting_permission' | 'waiting_user_input';
  health: 'healthy' | 'interrupted_runtime';
};

export type FakeScriptStep =
  | { kind: 'event'; nativeType: string; payload: unknown; nativeSequence?: number; runtimeEventId?: string; runtimeTurnId?: string }
  | { kind: 'runtime_event'; nativeType: string; payload: unknown; nativeSequence?: number; runtimeEventId?: string }
  | { kind: 'disconnect' };

export class FakeRuntimeAdapter {
  readonly runtimeHandleId = 'fake-handle-' + randomUUID();
  readonly eventReaderCount = 1;
  readonly supportsEventReplay: boolean;
  readonly events: EventEnvelope[] = [];
  readonly results: IngestResult[] = [];
  readonly #sessions = new Map<string, FakeSession>();
  readonly #nextSequence = new Map<string, number>();
  readonly #normalizer: EventNormalizer;
  #epoch = 'fake-epoch-' + randomUUID();

  constructor(options: { supportsEventReplay?: boolean; maxBuffered?: number; maxPayloadBytes?: number } = {}) {
    this.supportsEventReplay = options.supportsEventReplay ?? true;
    this.#normalizer = new EventNormalizer({
      runtimeHandleId: this.runtimeHandleId,
      runtimeType: 'fake',
      connectionEpoch: this.#epoch,
      ...(options.maxBuffered === undefined ? {} : { maxBuffered: options.maxBuffered }),
      ...(options.maxPayloadBytes === undefined ? {} : { maxPayloadBytes: options.maxPayloadBytes }),
    });
  }

  get connectionEpoch(): string { return this.#epoch; }

  createSession(): FakeSession {
    const runtimeSessionId = 'fake-session-' + randomUUID();
    const session: FakeSession = { runtimeSessionId, activity: 'idle', health: 'healthy' };
    this.#sessions.set(runtimeSessionId, session);
    this.#nextSequence.set(runtimeSessionId, 1);
    return session;
  }

  runScript(session: FakeSession, steps: readonly FakeScriptStep[]): IngestResult[] {
    if (!this.#sessions.has(session.runtimeSessionId)) throw new Error('Unknown Fake session');
    const output: IngestResult[] = [];
    for (const step of steps) {
      if (step.kind === 'disconnect') {
        this.disconnect();
        continue;
      }
      const route = step.kind === 'runtime_event' ? '$runtime' : session.runtimeSessionId;
      const nativeSequence = step.nativeSequence ?? this.#nextSequence.get(route) ?? 1;
      this.#nextSequence.set(route, Math.max(this.#nextSequence.get(route) ?? 1, nativeSequence + 1));
      const native: RuntimeNativeEvent = {
        nativeType: step.nativeType,
        payload: step.payload,
        connectionEpoch: this.#epoch,
        nativeSequence,
        runtimeEventId: step.runtimeEventId ?? route + '-event-' + nativeSequence,
        ...(step.kind === 'event' ? { runtimeSessionId: session.runtimeSessionId } : {}),
        ...(step.kind === 'event' && step.runtimeTurnId
          ? { runtimeTurnId: step.runtimeTurnId }
          : {}),
      };
      const result = this.#normalizer.ingest(native);
      output.push(result);
      this.results.push(result);
      this.events.push(...result.events);
      this.#applyState(session, step.nativeType);
    }
    return output;
  }

  ingestRaw(event: RuntimeNativeEvent): IngestResult {
    const result = this.#normalizer.ingest(event);
    this.results.push(result);
    this.events.push(...result.events);
    return result;
  }

  disconnect(): string {
    const previousEpoch = this.#epoch;
    for (const session of this.#sessions.values()) {
      session.health = 'interrupted_runtime';
    }
    this.#epoch = 'fake-epoch-' + randomUUID();
    this.events.push(...this.#normalizer.changeConnectionEpoch(this.#epoch));
    this.#nextSequence.clear();
    if (!this.supportsEventReplay) {
      this.events.push(...this.#normalizer.snapshotRecovery(
        [...this.#sessions.values()].map((session) => ({
          sessionId: session.runtimeSessionId,
          activity: session.activity,
          health: session.health,
        })),
      ));
    }
    return previousEpoch;
  }

  #applyState(session: FakeSession, nativeType: string): void {
    if (nativeType === 'message.started') session.activity = 'running';
    else if (nativeType === 'permission.requested') session.activity = 'waiting_permission';
    else if (nativeType === 'user_input.requested') session.activity = 'waiting_user_input';
    else if (nativeType === 'message.completed') session.activity = 'idle';
  }
}