import { createHash, randomUUID } from 'node:crypto';
import type { LocalDatabase } from '@tsukiori/database';
import type {
  HostSession, HostTurn, JsonValue, PermissionDecision, RuntimeHandleRecord,
} from '@tsukiori/domain';
import { PermissionBroker } from '@tsukiori/permission-broker';
import { EventNormalizer, toSessionEventRecord, type EventEnvelope, type IngestResult } from '@tsukiori/runtime-core';

export class CodexBridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexBridgeError';
  }
}

type RequestHandle = { request(method: string, params?: JsonValue): Promise<unknown> };
type PendingApproval = {
  permissionId: string;
  method: string;
  params: Record<string, unknown>;
  resolve: (value: JsonValue) => void;
  reject: (error: Error) => void;
};

export class CodexSessionBridge {
  readonly eventReaderCount = 1;
  readonly #database: LocalDatabase;
  readonly #permissions: PermissionBroker;
  readonly #handle: RuntimeHandleRecord;
  readonly #normalizer: EventNormalizer;
  readonly #now: () => number;
  readonly #id: () => string;
  readonly #threadToSession = new Map<string, string>();
  readonly #itemKinds = new Map<string, string>();
  readonly #pendingApprovals = new Map<string, PendingApproval>();
  readonly #buffered = new Map<string, Array<{ method: string; params: Record<string, unknown> }>>();
  #nativeCounter = 0;

  constructor(
    database: LocalDatabase,
    permissions: PermissionBroker,
    handle: RuntimeHandleRecord,
    options: { now?: () => number; id?: () => string; maxPayloadBytes?: number } = {},
  ) {
    this.#database = database;
    this.#permissions = permissions;
    this.#handle = handle;
    this.#now = options.now ?? Date.now;
    this.#id = options.id ?? randomUUID;
    this.#normalizer = new EventNormalizer({
      runtimeHandleId: handle.id, runtimeType: 'codex', connectionEpoch: handle.connectionEpoch,
      ...(options.maxPayloadBytes === undefined ? {} : { maxPayloadBytes: options.maxPayloadBytes }),
    });
  }

  get handleId(): string { return this.#handle.id; }
  get connectionEpoch(): string { return this.#handle.connectionEpoch; }

  bindThread(runtimeThreadId: string, sessionId: string): EventEnvelope[] {
    const session = this.#session(sessionId);
    this.#threadToSession.set(runtimeThreadId, sessionId);
    this.#database.saveSession({ ...session, runtimeSessionId: runtimeThreadId, updatedAt: this.#now() });
    const buffered = this.#buffered.get(runtimeThreadId) ?? [];
    this.#buffered.delete(runtimeThreadId);
    return buffered.flatMap((event) => this.acceptNotification(event.method, event.params).events);
  }

  async startThread(handle: RequestHandle, sessionId: string, params: JsonValue): Promise<string> {
    const response = await handle.request('thread/start', params);
    const threadId = this.#nestedId(response, 'thread');
    this.bindThread(threadId, sessionId);
    return threadId;
  }

  async startTurn(handle: RequestHandle, sessionId: string, input: JsonValue): Promise<string> {
    const session = this.#session(sessionId);
    if (!session.runtimeSessionId) throw new CodexBridgeError('Host Session is not bound to a Codex Thread');
    const response = await handle.request('turn/start', { threadId: session.runtimeSessionId, input });
    const runtimeTurnId = this.#nestedId(response, 'turn');
    this.#turn(session, runtimeTurnId, 'queued');
    return runtimeTurnId;
  }

  async interrupt(handle: RequestHandle, sessionId: string, turnId: string): Promise<void> {
    const session = this.#session(sessionId);
    const turn = this.#database.sqlite.prepare('SELECT runtime_turn_id FROM session_turns WHERE id=? AND session_id=?')
      .get(turnId, sessionId) as { runtime_turn_id: string | null } | undefined;
    if (!session.runtimeSessionId || !turn?.runtime_turn_id) throw new CodexBridgeError('Turn mapping not found');
    await handle.request('turn/interrupt', { threadId: session.runtimeSessionId, turnId: turn.runtime_turn_id });
  }

  async resume(handle: RequestHandle, sessionId: string): Promise<string> {
    const session = this.#session(sessionId);
    if (!session.runtimeSessionId) throw new CodexBridgeError('Host Session is not bound to a Codex Thread');
    const response = await handle.request('thread/resume', { threadId: session.runtimeSessionId });
    const runtimeThreadId = this.#nestedId(response, 'thread');
    this.bindThread(runtimeThreadId, sessionId);
    return runtimeThreadId;
  }

  acceptNotification(method: string, paramsValue: unknown): IngestResult {
    const params = this.#object(paramsValue);
    const runtimeThreadId = this.#threadId(params);
    if (runtimeThreadId && !this.#hostSessionId(runtimeThreadId)) {
      const queue = this.#buffered.get(runtimeThreadId) ?? [];
      if (queue.length >= 64) queue.shift();
      queue.push({ method, params });
      this.#buffered.set(runtimeThreadId, queue);
      return { status: 'buffered', events: [] };
    }
    const sessionId = runtimeThreadId ? this.#hostSessionId(runtimeThreadId) : undefined;
    const runtimeTurnId = this.#turnId(params);
    const hostTurnId = sessionId && runtimeTurnId ? this.#turn(this.#session(sessionId), runtimeTurnId, this.#turnStatus(method, params)) : undefined;
    const item = this.#objectOrNull(params.item);
    const itemId = String(params.itemId ?? item?.id ?? '');
    const itemType = String(item?.type ?? this.#itemKinds.get(itemId) ?? 'unknown');
    if (itemId && item?.type) this.#itemKinds.set(itemId, itemType);
    const nativeType = this.#nativeType(method, itemType);
    const runtimeEventId = this.#eventId(method, runtimeThreadId, runtimeTurnId, itemId, params);
    const result = this.#normalizer.ingest({
      nativeType, payload: { method, params }, connectionEpoch: this.connectionEpoch,
      runtimeEventId,
      ...(runtimeThreadId ? { runtimeSessionId: runtimeThreadId } : {}),
      ...(runtimeTurnId ? { runtimeTurnId } : {}),
      ...(sessionId ? {
        hostSessionId: sessionId,
        projectId: this.#session(sessionId).projectId,
      } : {}),
      ...(hostTurnId ? { hostTurnId } : {}),
      createdAt: this.#now(),
    });
    for (const event of result.events) this.#database.appendSessionEvent(toSessionEventRecord(event));
    if (sessionId && result.status === 'accepted') {
      this.#updateSessionFromMethod(sessionId, method, params);
    }
    return result;
  }

  handleServerRequest(runtimeRequestId: string | number, method: string, paramsValue: unknown): Promise<JsonValue> {
    if (![
      'item/commandExecution/requestApproval',
      'item/fileChange/requestApproval',
      'item/permissions/requestApproval',
    ].includes(method)) {
      return Promise.reject(new CodexBridgeError('Unsupported Codex server request'));
    }
    const params = this.#object(paramsValue);
    const runtimeThreadId = this.#threadId(params);
    const sessionId = runtimeThreadId ? this.#hostSessionId(runtimeThreadId) : undefined;
    if (!sessionId) return Promise.reject(new CodexBridgeError('Approval request Thread is not bound'));
    const runtimeTurnId = this.#turnId(params);
    const hostTurnId = runtimeTurnId ? this.#turn(this.#session(sessionId), runtimeTurnId, 'waiting_permission') : undefined;
    const kind = this.#approvalKind(method, params);
    const permissionId = 'permission:codex:' + this.#id();
    const session = this.#session(sessionId);
    this.#permissions.submit({
      id: permissionId, projectId: session.projectId, sessionId,
      ...(hostTurnId ? { turnId: hostTurnId } : {}), runtimeHandleId: this.handleId,
      runtimeRequestId: String(runtimeRequestId), connectionEpoch: this.connectionEpoch,
      category: kind.category, risk: kind.risk, enforcementLevel: 'interceptable',
      title: kind.title, description: kind.description, scope: kind.scope,
      availableDecisions: ['allow_once', 'deny_once', 'cancel_turn'], requestedAt: this.#now(),
    });
    return new Promise<JsonValue>((resolveApproval, rejectApproval) => {
      this.#pendingApprovals.set(permissionId, {
        permissionId, method, params, resolve: resolveApproval, reject: rejectApproval,
      });
    });
  }

  decide(permissionId: string, connectionEpoch: string, decision: PermissionDecision): void {
    const pending = this.#pendingApprovals.get(permissionId);
    if (!pending) throw new CodexBridgeError('Pending Codex Approval not found');
    this.#permissions.decide(permissionId, connectionEpoch, decision);
    this.#pendingApprovals.delete(permissionId);
    if (pending.method === 'item/permissions/requestApproval') {
      const requested = this.#objectOrNull(pending.params.permissions);
      pending.resolve(decision === 'allow_once'
        ? { permissions: (requested ?? { fileSystem: null, network: null }) as JsonValue, scope: 'turn' }
        : { permissions: { fileSystem: null, network: null }, scope: 'turn' });
      return;
    }
    pending.resolve({ decision: decision === 'allow_once' ? 'accept' : decision === 'cancel_turn' ? 'cancel' : 'decline' });
  }

  invalidateEpoch(reason = 'runtime_reconnected'): number {
    const count = this.#permissions.invalidateEpoch(this.handleId, this.connectionEpoch, reason);
    for (const pending of this.#pendingApprovals.values()) {
      pending.reject(new CodexBridgeError('Approval invalidated by connection epoch change'));
    }
    this.#pendingApprovals.clear();
    return count;
  }

  #nativeType(method: string, itemType: string): string {
    if (method === 'turn/started' || method === 'turn/completed') return 'turn.state';
    if (method === 'thread/started' || method === 'thread/status/changed') return 'session.state';
    if (method === 'item/agentMessage/delta') return 'text.delta';
    if (method === 'item/started') return itemType === 'agentMessage' ? 'message.started' : 'tool.started';
    if (method === 'item/completed') return itemType === 'agentMessage' ? 'message.completed' : 'tool.completed';
    return 'codex.' + method;
  }

  #eventId(
    method: string, threadId: string | undefined, turnId: string | undefined,
    itemId: string, params: Record<string, unknown>,
  ): string {
    const explicit = params.eventId ?? params.runtimeEventId;
    if (typeof explicit === 'string') return explicit;
    if (method.endsWith('/delta')) return 'codex-delta:' + ++this.#nativeCounter;
    return 'codex:' + createHash('sha256').update(
      [method, threadId ?? '', turnId ?? '', itemId, JSON.stringify(params)].join('\0'),
    ).digest('hex');
  }

  #turn(session: HostSession, runtimeTurnId: string, status: HostTurn['status']): string {
    const existing = this.#database.sqlite.prepare(
      'SELECT id, status, started_at, completed_at FROM session_turns WHERE runtime_turn_id=? AND session_id=?',
    ).get(runtimeTurnId, session.id) as {
      id: string;
      status: HostTurn['status'];
      started_at: number | null;
      completed_at: number | null;
    } | undefined;
    const terminal = ['completed', 'failed', 'cancelled', 'interrupted'] as const;
    const effectiveStatus = existing && terminal.includes(existing.status as typeof terminal[number])
      ? existing.status
      : status;
    const id = existing?.id ?? 'turn:codex:' + createHash('sha256')
      .update(session.id + '\0' + runtimeTurnId).digest('hex').slice(0, 24);
    const startedAt = existing?.started_at
      ?? (['running', 'waiting_permission', 'waiting_user_input'].includes(effectiveStatus) ? this.#now() : undefined);
    const completedAt = existing?.completed_at
      ?? (terminal.includes(effectiveStatus as typeof terminal[number]) ? this.#now() : undefined);
    this.#database.saveTurn({
      id, sessionId: session.id, runtimeTurnId, status: effectiveStatus,
      userInput: { source: 'codex', persistedText: false },
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(completedAt === undefined ? {} : { completedAt }),
    });
    return id;
  }

  #turnStatus(method: string, params: Record<string, unknown>): HostTurn['status'] {
    if (method === 'turn/started') return 'running';
    if (method === 'turn/completed') {
      const turn = this.#objectOrNull(params.turn);
      const status = String(turn?.status ?? 'completed');
      if (['completed', 'failed', 'cancelled', 'interrupted'].includes(status)) return status as HostTurn['status'];
      return 'completed';
    }
    return 'running';
  }

  #updateSessionFromMethod(sessionId: string, method: string, params: Record<string, unknown>): void {
    const session = this.#session(sessionId);
    if (method === 'turn/started') {
      this.#database.saveSession({ ...session, activity: 'running', updatedAt: this.#now() });
    } else if (method === 'turn/completed') {
      const turn = this.#objectOrNull(params.turn);
      const failed = String(turn?.status ?? '') === 'failed';
      const runtimeTurnId = String(turn?.id ?? params.turnId ?? 'unknown');
      this.#database.saveSession({
        ...session, activity: 'idle', ...(failed ? { health: 'error' as const } : {}), updatedAt: this.#now(),
      });
      this.#permissions.addAttention({
        projectId: session.projectId,
        sessionId: session.id,
        kind: failed ? 'failed' : 'completed',
        title: failed ? 'Codex Turn 执行失败' : 'Codex Turn 已完成',
        sourceRef: 'codex-turn:' + session.id + ':' + runtimeTurnId,
        payload: { runtimeTurnId },
      });
    }
  }
  #approvalKind(method: string, params: Record<string, unknown>): {
    category: 'shell' | 'file_write' | 'network'; risk: 'medium' | 'high'; title: string; description: string; scope: string;
  } {
    if (method === 'item/commandExecution/requestApproval') {
      return { category: 'shell', risk: 'high', title: 'Codex 请求执行命令', description: 'Runtime 提供的命令审批', scope: 'Codex command item' };
    }
    if (method === 'item/fileChange/requestApproval') {
      return { category: 'file_write', risk: 'medium', title: 'Codex 请求修改文件', description: 'Runtime 提供的文件变更审批', scope: 'Codex file change item' };
    }
    const permissions = this.#objectOrNull(params.permissions);
    const hasNetworkPermission = permissions?.network !== null && permissions?.network !== undefined;
    const category = hasNetworkPermission || params.networkApprovalContext ? 'network' : 'file_write';
    return {
      category, risk: 'high', title: category === 'network' ? 'Codex 请求网络权限' : 'Codex 请求扩展权限',
      description: 'Runtime 提供的结构化权限审批', scope: category === 'network' ? 'managed network request' : 'structured permission request',
    };
  }

  #nestedId(value: unknown, field: string): string {
    const object = this.#object(value);
    const nested = this.#objectOrNull(object[field]);
    if (!nested || typeof nested.id !== 'string') throw new CodexBridgeError(field + ' response ID is missing');
    return nested.id;
  }

  #threadId(params: Record<string, unknown>): string | undefined {
    if (typeof params.threadId === 'string') return params.threadId;
    const thread = this.#objectOrNull(params.thread);
    return typeof thread?.id === 'string' ? thread.id : undefined;
  }

  #turnId(params: Record<string, unknown>): string | undefined {
    if (typeof params.turnId === 'string') return params.turnId;
    const turn = this.#objectOrNull(params.turn);
    return typeof turn?.id === 'string' ? turn.id : undefined;
  }

  #hostSessionId(runtimeThreadId: string): string | undefined {
    const mapped = this.#threadToSession.get(runtimeThreadId);
    if (mapped) return mapped;
    const row = this.#database.sqlite.prepare('SELECT id FROM sessions WHERE runtime_session_id=?')
      .get(runtimeThreadId) as { id: string } | undefined;
    if (row) this.#threadToSession.set(runtimeThreadId, row.id);
    return row?.id;
  }

  #session(id: string): HostSession {
    const session = this.#database.readSession(id);
    if (!session) throw new CodexBridgeError('Host Session not found');
    return session;
  }

  #object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return value as Record<string, unknown>;
  }

  #objectOrNull(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  }
}
