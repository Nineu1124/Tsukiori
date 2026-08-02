import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import type { LocalDatabase } from '@tsukiori/database';
import type { HostSession, HostTurn, JsonValue, RuntimeHandleRecord } from '@tsukiori/domain';
import { EventNormalizer, toSessionEventRecord, type EventEnvelope, type IngestResult } from '@tsukiori/runtime-core';
import type { OpenCodeProviderSelection } from './provider.js';

type Client = ReturnType<typeof createOpencodeClient>;
type EventStream = AsyncIterable<unknown> & { return?: () => Promise<unknown> };
type EventSubscription = { stream: EventStream };
type StreamState = 'stopped' | 'connecting' | 'connected' | 'disconnected';

export type OpenCodeRecoveryResult = {
  previousConnectionEpoch: string;
  connectionEpoch: string;
  recoveredSessionCount: number;
  eventReaderCount: 1;
  snapshotRecovery: true;
};

export class OpenCodeBridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenCodeBridgeError';
  }
}

export class OpenCodeSessionBridge {
  readonly eventReaderCount = 1 as const;
  readonly #database: LocalDatabase;
  readonly #client: Client;
  readonly #handleId: string;
  readonly #profileId: string;
  readonly #directory: string;
  readonly #normalizer: EventNormalizer;
  readonly #now: () => number;
  readonly #id: () => string;
  readonly #runtimeToHost = new Map<string, string>();
  readonly #activeTurns = new Map<string, string>();
  readonly #buffered = new Map<string, unknown[]>();
  #connectionEpoch: string;
  #streamState: StreamState = 'stopped';
  #subscription: EventSubscription | null = null;
  #abort: AbortController | null = null;
  #consumer: Promise<void> | null = null;
  #nativeCounter = 0;

  constructor(
    database: LocalDatabase,
    client: Client,
    handle: RuntimeHandleRecord,
    directory: string,
    options: { now?: () => number; id?: () => string; maxPayloadBytes?: number } = {},
  ) {
    this.#database = database;
    this.#client = client;
    this.#handleId = handle.id;
    this.#profileId = handle.profileId;
    this.#directory = resolve(directory);
    this.#connectionEpoch = handle.connectionEpoch;
    this.#now = options.now ?? Date.now;
    this.#id = options.id ?? randomUUID;
    this.#normalizer = new EventNormalizer({
      runtimeHandleId: handle.id,
      runtimeType: 'opencode',
      connectionEpoch: handle.connectionEpoch,
      ...(options.maxPayloadBytes === undefined ? {} : { maxPayloadBytes: options.maxPayloadBytes }),
    });
  }

  get handleId(): string { return this.#handleId; }
  get profileId(): string { return this.#profileId; }
  get connectionEpoch(): string { return this.#connectionEpoch; }
  get eventStreamState(): StreamState { return this.#streamState; }

  async startEventReader(): Promise<void> {
    if (this.#consumer || this.#streamState === 'connecting' || this.#streamState === 'connected') return;
    this.#streamState = 'connecting';
    const abort = new AbortController();
    try {
      const subscription = await this.#client.global.event({ signal: abort.signal }) as unknown as EventSubscription;
      this.#abort = abort;
      this.#subscription = subscription;
      this.#streamState = 'connected';
      const epoch = this.#connectionEpoch;
      this.#consumer = this.#consume(subscription.stream, epoch, abort).finally(() => {
        if (this.#abort !== abort) return;
        this.#abort = null;
        this.#subscription = null;
        this.#consumer = null;
        if (this.#streamState !== 'stopped') this.#streamState = 'disconnected';
      });
    } catch (error) {
      abort.abort();
      this.#streamState = 'disconnected';
      throw new OpenCodeBridgeError('OpenCode global event stream failed to connect');
    }
  }

  async stopEventReader(): Promise<void> {
    const abort = this.#abort;
    const subscription = this.#subscription;
    const consumer = this.#consumer;
    this.#streamState = 'stopped';
    if (abort) abort.abort();
    if (subscription?.stream.return) {
      try { await subscription.stream.return(); } catch { /* Server may already be gone. */ }
    }
    if (consumer) {
      await Promise.race([
        consumer.catch(() => undefined),
        new Promise((resolveWait) => setTimeout(resolveWait, 3_000)),
      ]);
    }
    if (this.#abort === abort) this.#abort = null;
    if (this.#subscription === subscription) this.#subscription = null;
    if (this.#consumer === consumer) this.#consumer = null;
  }

  async createSession(
    hostSessionId: string,
    selection: OpenCodeProviderSelection,
    title?: string,
  ): Promise<string> {
    const host = this.#session(hostSessionId);
    const response = unwrap(await this.#client.session.create({
      directory: this.#directory,
      title: title ?? host.title,
      model: { providerID: selection.providerId, id: selection.modelId },
      permission: [
        { permission: 'external_directory', pattern: '*', action: 'deny' },
        { permission: 'bash', pattern: '*', action: 'ask' },
        { permission: 'edit', pattern: '*', action: 'ask' },
      ],
    }), 'session.create');
    const runtime = object(response);
    if (typeof runtime.id !== 'string') throw new OpenCodeBridgeError('OpenCode Session ID is missing');
    this.#bind(runtime.id, host.id, selection);
    return runtime.id;
  }

  async resumeSession(hostSessionId: string): Promise<string> {
    const host = this.#session(hostSessionId);
    if (!host.runtimeSessionId) throw new OpenCodeBridgeError('Host Session has no OpenCode Session mapping');
    const response = object(unwrap(await this.#client.session.get({
      directory: this.#directory,
      sessionID: host.runtimeSessionId,
    }), 'session.get(resume)'));
    if (response.id !== host.runtimeSessionId) throw new OpenCodeBridgeError('OpenCode Session resume mismatch');
    this.#bind(host.runtimeSessionId, host.id);
    this.#database.saveSession({ ...host, activity: 'idle', health: 'healthy', updatedAt: this.#now() });
    return host.runtimeSessionId;
  }

  async startTurn(hostSessionId: string, text: string): Promise<HostTurn> {
    const host = this.#session(hostSessionId);
    if (!host.runtimeSessionId) throw new OpenCodeBridgeError('Host Session is not bound to OpenCode');
    if (!host.provider || !host.model) throw new OpenCodeBridgeError('Host Session has no Provider/Model selection');
    const existingTurnId = this.#activeTurns.get(host.runtimeSessionId);
    if (existingTurnId && !isTerminal(this.#readTurn(existingTurnId)?.status)) {
      throw new OpenCodeBridgeError('OpenCode Session already has an active Turn');
    }
    const id = 'turn:opencode:' + this.#id();
    const runtimeTurnId = 'opencode-turn:' + this.#id();
    const turn: HostTurn = {
      id,
      sessionId: host.id,
      runtimeTurnId,
      status: 'queued',
      userInput: { source: 'opencode', persistedText: false },
    };
    this.#database.saveTurn(turn);
    this.#activeTurns.set(host.runtimeSessionId, id);
    this.#database.saveSession({ ...host, activity: 'queued', health: 'healthy', updatedAt: this.#now() });
    try {
      const response = object(await this.#client.session.promptAsync({
        directory: this.#directory,
        sessionID: host.runtimeSessionId,
        model: { providerID: host.provider, modelID: host.model },
        parts: [{ type: 'text', text }],
      }));
      if (response.error) throw new Error('prompt_async failed');
      const observed = this.#readTurn(id);
      if (observed && isTerminal(observed.status)) return observed;
      const running: HostTurn = { ...turn, status: 'running', startedAt: this.#now() };
      this.#database.saveTurn(running);
      this.#database.saveSession({ ...this.#session(host.id), activity: 'running', updatedAt: this.#now() });
      return running;
    } catch {
      const failed: HostTurn = { ...turn, status: 'failed', completedAt: this.#now() };
      this.#database.saveTurn(failed);
      this.#activeTurns.delete(host.runtimeSessionId);
      this.#database.saveSession({ ...this.#session(host.id), activity: 'idle', health: 'error', updatedAt: this.#now() });
      throw new OpenCodeBridgeError('OpenCode Turn failed to start');
    }
  }

  async recoverConnection(newConnectionEpoch: string): Promise<OpenCodeRecoveryResult> {
    if (newConnectionEpoch === this.#connectionEpoch) {
      throw new OpenCodeBridgeError('Recovery requires a new Connection Epoch');
    }
    await this.stopEventReader();
    const previousConnectionEpoch = this.#connectionEpoch;
    this.#connectionEpoch = newConnectionEpoch;
    for (const event of this.#normalizer.changeConnectionEpoch(newConnectionEpoch)) this.#persist(event);
    const health = object(unwrap(await this.#client.global.health(), 'global.health(recovery)'));
    if (health.healthy !== true) throw new OpenCodeBridgeError('OpenCode recovery health Probe failed');
    const statuses = object(unwrap(
      await this.#client.session.status({ directory: this.#directory }),
      'session.status(recovery)',
    ));
    const recovered = [];
    for (const [runtimeSessionId, hostSessionId] of this.#runtimeToHost.entries()) {
      const host = this.#session(hostSessionId);
      let activity: HostSession['activity'] = 'idle';
      let sessionHealth: HostSession['health'] = 'healthy';
      try {
        const response = object(unwrap(await this.#client.session.get({
          directory: this.#directory,
          sessionID: runtimeSessionId,
        }), 'session.get(recovery)'));
        if (response.id !== runtimeSessionId) throw new Error('session mismatch');
        const status = object(statuses[runtimeSessionId]);
        activity = status.type === 'busy' ? 'running' : status.type === 'retry' ? 'queued' : 'idle';
      } catch {
        activity = 'stopped';
        sessionHealth = 'recovery_required';
      }
      this.#database.saveSession({ ...host, activity, health: sessionHealth, updatedAt: this.#now() });
      recovered.push({
        sessionId: runtimeSessionId,
        hostSessionId,
        projectId: host.projectId,
        activity,
        health: sessionHealth,
      });
    }
    for (const event of this.#normalizer.snapshotRecovery(recovered)) this.#persist(event);
    await this.startEventReader();
    return {
      previousConnectionEpoch,
      connectionEpoch: newConnectionEpoch,
      recoveredSessionCount: recovered.length,
      eventReaderCount: 1,
      snapshotRecovery: true,
    };
  }

  acceptGlobalEvent(value: unknown, epoch = this.#connectionEpoch): IngestResult {
    const outer = object(value);
    if (typeof outer.directory === 'string' && !samePath(outer.directory, this.#directory)) {
      return { status: 'accepted', events: [] };
    }
    const payload = object(outer.payload ?? value);
    const type = typeof payload.type === 'string' ? payload.type : 'unknown';
    const properties = object(payload.properties);
    const runtimeSessionId = sessionId(properties);
    const hostSessionId = runtimeSessionId ? this.#hostSessionId(runtimeSessionId) : undefined;
    if (runtimeSessionId && !hostSessionId) {
      const queue = this.#buffered.get(runtimeSessionId) ?? [];
      if (queue.length >= 64) queue.shift();
      queue.push(value);
      this.#buffered.set(runtimeSessionId, queue);
      return { status: 'buffered', events: [] };
    }
    const host = hostSessionId ? this.#session(hostSessionId) : undefined;
    const hostTurnId = runtimeSessionId ? this.#activeTurns.get(runtimeSessionId) : undefined;
    const runtimeTurnId = hostTurnId ? this.#readTurn(hostTurnId)?.runtimeTurnId : undefined;
    const nativeType = this.#nativeType(type, properties, Boolean(hostTurnId));
    const explicitId = typeof payload.id === 'string' ? payload.id : 'event-' + ++this.#nativeCounter;
    const runtimeEventId = type.endsWith('.delta')
      ? explicitId + ':delta:' + ++this.#nativeCounter
      : explicitId;
    const result = this.#normalizer.ingest({
      nativeType,
      payload: this.#safePayload(type, properties),
      connectionEpoch: epoch,
      runtimeEventId,
      ...(runtimeSessionId ? { runtimeSessionId } : {}),
      ...(runtimeTurnId ? { runtimeTurnId } : {}),
      ...(hostSessionId ? { hostSessionId } : {}),
      ...(hostTurnId ? { hostTurnId } : {}),
      ...(host ? { projectId: host.projectId } : {}),
      createdAt: this.#now(),
    });
    for (const event of result.events) this.#persist(event);
    if (result.status === 'accepted' && hostSessionId) {
      this.#applyState(type, properties, hostSessionId, runtimeSessionId as string, hostTurnId);
    }
    return result;
  }

  async #consume(stream: EventStream, epoch: string, abort: AbortController): Promise<void> {
    try {
      for await (const event of stream) {
        if (abort.signal.aborted) break;
        this.acceptGlobalEvent(event, epoch);
      }
    } catch {
      if (!abort.signal.aborted) this.#streamState = 'disconnected';
    }
  }

  #bind(runtimeSessionId: string, hostSessionId: string, selection?: OpenCodeProviderSelection): void {
    const host = this.#session(hostSessionId);
    this.#runtimeToHost.set(runtimeSessionId, hostSessionId);
    this.#database.saveSession({
      ...host,
      runtimeSessionId,
      ...(selection ? { provider: selection.providerId, model: selection.modelId } : {}),
      activity: 'idle',
      health: 'healthy',
      updatedAt: this.#now(),
    });
    const buffered = this.#buffered.get(runtimeSessionId) ?? [];
    this.#buffered.delete(runtimeSessionId);
    for (const event of buffered) this.acceptGlobalEvent(event);
  }

  #nativeType(type: string, properties: Record<string, unknown>, hasTurn: boolean): string {
    if (type === 'message.updated') {
      const info = object(properties.info);
      if (info.role === 'assistant') return object(info.time).completed || info.finish ? 'message.completed' : 'message.started';
    }
    if (type === 'message.part.delta') return 'text.delta';
    if (type === 'message.part.updated') {
      const part = object(properties.part);
      if (part.type === 'tool') {
        const status = String(object(part.state).status ?? 'pending');
        if (status === 'completed') return 'tool.completed';
        if (status === 'error') return 'tool.failed';
        return status === 'running' ? 'tool.progress' : 'tool.started';
      }
    }
    if (type === 'permission.asked' || type === 'permission.v2.asked') return 'permission.requested';
    if (type === 'permission.replied' || type === 'permission.v2.replied') return 'permission.resolved';
    if (type === 'question.asked' || type === 'question.v2.asked') return 'user_input.requested';
    if (type === 'question.replied' || type === 'question.rejected'
      || type === 'question.v2.replied' || type === 'question.v2.rejected') return 'user_input.resolved';
    if (type === 'session.error') return hasTurn ? 'turn.state' : 'runtime.error';
    if (type === 'session.idle') return hasTurn ? 'turn.state' : 'session.state';
    if (type === 'session.status' || type === 'session.created' || type === 'session.updated') return 'session.state';
    return 'opencode.' + type;
  }

  #safePayload(type: string, properties: Record<string, unknown>): JsonValue {
    const runtimeSessionId = sessionId(properties);
    const base: Record<string, JsonValue> = {
      nativeType: type,
      ...(runtimeSessionId ? { runtimeSessionId } : {}),
    };
    if (type === 'message.part.delta') {
      return { ...base, field: String(properties.field ?? ''), delta: String(properties.delta ?? '') };
    }
    if (type === 'message.updated') {
      const info = object(properties.info);
      return {
        ...base,
        messageId: String(info.id ?? ''),
        role: String(info.role ?? 'unknown'),
        completed: Boolean(object(info.time).completed || info.finish),
        failed: Boolean(info.error),
      };
    }
    if (type === 'message.part.updated') {
      const part = object(properties.part);
      return {
        ...base,
        partId: String(part.id ?? ''),
        messageId: String(part.messageID ?? ''),
        partType: String(part.type ?? 'unknown'),
        tool: part.type === 'tool' ? String(part.tool ?? 'unknown') : 'none',
        status: part.type === 'tool' ? String(object(part.state).status ?? 'unknown') : 'unknown',
      };
    }
    if (type.startsWith('session.')) {
      return {
        ...base,
        status: type === 'session.idle' ? 'idle' : String(object(properties.status).type ?? 'unknown'),
        failed: type === 'session.error',
      };
    }
    if (type.startsWith('permission.')) {
      return {
        ...base,
        requestId: String(properties.id ?? properties.requestID ?? ''),
        permission: String(properties.permission ?? 'unknown'),
        patternCount: Array.isArray(properties.patterns) ? properties.patterns.length : 0,
      };
    }
    if (type.startsWith('question.')) {
      return {
        ...base,
        requestId: String(properties.id ?? properties.requestID ?? ''),
        questionCount: Array.isArray(properties.questions) ? properties.questions.length : 0,
      };
    }
    return { ...base, runtimeScope: !runtimeSessionId };
  }

  #applyState(
    type: string,
    properties: Record<string, unknown>,
    hostSessionId: string,
    runtimeSessionId: string,
    hostTurnId?: string,
  ): void {
    const host = this.#session(hostSessionId);
    if (type === 'session.status') {
      const status = String(object(properties.status).type ?? 'idle');
      this.#database.saveSession({
        ...host,
        activity: status === 'busy' ? 'running' : status === 'retry' ? 'queued' : 'idle',
        updatedAt: this.#now(),
      });
      return;
    }
    if (type === 'permission.asked' || type === 'permission.v2.asked') {
      this.#database.saveSession({ ...host, activity: 'waiting_permission', updatedAt: this.#now() });
      if (hostTurnId) this.#setTurn(hostTurnId, 'waiting_permission');
      return;
    }
    if (type === 'question.asked' || type === 'question.v2.asked') {
      this.#database.saveSession({ ...host, activity: 'waiting_user_input', updatedAt: this.#now() });
      if (hostTurnId) this.#setTurn(hostTurnId, 'waiting_user_input');
      return;
    }
    if (type === 'session.error') {
      this.#database.saveSession({ ...host, activity: 'idle', health: 'error', updatedAt: this.#now() });
      if (hostTurnId) this.#setTurn(hostTurnId, 'failed', true);
      this.#activeTurns.delete(runtimeSessionId);
      return;
    }
    if (type === 'session.idle') {
      this.#database.saveSession({ ...host, activity: 'idle', health: 'healthy', updatedAt: this.#now() });
      if (hostTurnId) this.#setTurn(hostTurnId, 'completed', true);
      this.#activeTurns.delete(runtimeSessionId);
      return;
    }
    if (type === 'message.updated' || type === 'message.part.updated' || type === 'message.part.delta') {
      this.#database.saveSession({ ...host, activity: 'running', updatedAt: this.#now() });
      if (hostTurnId) this.#setTurn(hostTurnId, 'running');
    }
  }

  #setTurn(id: string, status: HostTurn['status'], terminal = false): void {
    const existing = this.#readTurn(id);
    if (!existing || isTerminal(existing.status)) return;
    this.#database.saveTurn({
      ...existing,
      status,
      startedAt: existing.startedAt ?? this.#now(),
      ...(terminal ? { completedAt: this.#now() } : {}),
    });
  }

  #readTurn(id: string): HostTurn | null {
    const row = this.#database.sqlite.prepare(
      'SELECT id, session_id, runtime_turn_id, status, user_input_json, started_at, completed_at FROM session_turns WHERE id=?',
    ).get(id) as {
      id: string; session_id: string; runtime_turn_id: string | null; status: HostTurn['status'];
      user_input_json: string; started_at: number | null; completed_at: number | null;
    } | undefined;
    if (!row) return null;
    return {
      id: row.id,
      sessionId: row.session_id,
      ...(row.runtime_turn_id ? { runtimeTurnId: row.runtime_turn_id } : {}),
      status: row.status,
      userInput: JSON.parse(row.user_input_json) as JsonValue,
      ...(row.started_at === null ? {} : { startedAt: row.started_at }),
      ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    };
  }

  #hostSessionId(runtimeSessionId: string): string | undefined {
    const mapped = this.#runtimeToHost.get(runtimeSessionId);
    if (mapped) return mapped;
    const row = this.#database.sqlite.prepare(
      'SELECT id FROM sessions WHERE runtime_type=? AND runtime_session_id=?',
    ).get('opencode', runtimeSessionId) as { id: string } | undefined;
    if (row) this.#runtimeToHost.set(runtimeSessionId, row.id);
    return row?.id;
  }

  #session(id: string): HostSession {
    const session = this.#database.readSession(id);
    if (!session || session.runtimeType !== 'opencode' || session.runtimeProfileId !== this.#profileId) {
      throw new OpenCodeBridgeError('OpenCode Host Session not found or Profile mismatch');
    }
    return session;
  }

  #persist(event: EventEnvelope): void {
    this.#database.appendSessionEvent(toSessionEventRecord(event));
  }
}

function unwrap(value: unknown, label: string): unknown {
  const response = object(value);
  if (response.error) throw new OpenCodeBridgeError(label + ' failed');
  if (!Object.hasOwn(response, 'data')) throw new OpenCodeBridgeError(label + ' returned no data');
  return response.data;
}

function sessionId(properties: Record<string, unknown>): string | undefined {
  if (typeof properties.sessionID === 'string') return properties.sessionID;
  for (const field of ['info', 'part', 'permission', 'question']) {
    const nested = object(properties[field]);
    if (typeof nested.sessionID === 'string') return nested.sessionID;
  }
  return undefined;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => resolve(value).replaceAll('/', '\\').toLowerCase();
  return normalize(left) === normalize(right);
}

function isTerminal(status: HostTurn['status'] | undefined): boolean {
  return status !== undefined && ['completed', 'failed', 'cancelled', 'interrupted'].includes(status);
}

export function openCodeEventFixtureHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}