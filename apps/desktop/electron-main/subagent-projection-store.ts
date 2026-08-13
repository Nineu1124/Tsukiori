import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type SubagentLifecycleStatus = 'started' | 'progress' | 'completed' | 'failed' | 'waiting';
export type SubagentAttentionReason = 'failed' | 'waiting' | 'action_needed';

export type SubagentProjectionRecord = {
  schemaVersion: 1;
  id: string;
  source: 'runtime';
  runtimeType: string;
  sessionId: string;
  runtimeId: string;
  runtimeTaskId: string;
  parentId: string;
  role: string;
  status: SubagentLifecycleStatus;
  attentionReason: SubagentAttentionReason | null;
  sourceEventId: string;
  sourceSequence: number;
  startedAt: number;
  updatedAt: number;
};

export type SubagentProjectionEvent = {
  eventId: string;
  sequence: number;
  sessionId: string;
  runtimeType: string;
  createdAt: number;
  payload: Record<string, unknown>;
};

export type SubagentAttentionItem = {
  id: string;
  kind: 'subagent_failed' | 'subagent_waiting' | 'subagent_action_needed';
  status: 'open';
  title: string;
  sourceRef: string;
  sessionId: string;
  payload: {
    runtimeType: string;
    runtimeId: string;
    parentId: string;
    role: string;
    lifecycleStatus: 'failed' | 'waiting';
    reason: SubagentAttentionReason;
    updatedAt: number;
  };
};

const MAX_RECORDS = 2_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;

export class SubagentProjectionStore {
  readonly #path: string;
  #records = new Map<string, SubagentProjectionRecord>();

  constructor(userDataPath: string) {
    mkdirSync(userDataPath, { recursive: true });
    this.#path = join(userDataPath, 'subagent-projections-v1.json');
    this.#load();
  }

  apply(event: SubagentProjectionEvent): SubagentProjectionRecord[] {
    const changed = this.#apply(event);
    if (changed.length > 0) this.#save();
    return changed;
  }

  reconcile(events: readonly SubagentProjectionEvent[]): void {
    let changed = false;
    for (const event of events) if (this.#apply(event).length > 0) changed = true;
    if (changed) this.#save();
  }

  list(sessionId?: string): SubagentProjectionRecord[] {
    return [...this.#records.values()]
      .filter((record) => sessionId === undefined || record.sessionId === sessionId)
      .sort((left, right) => right.updatedAt - left.updatedAt || right.sourceSequence - left.sourceSequence)
      .map((record) => ({ ...record }));
  }

  attention(activeSessionIds?: ReadonlySet<string>): SubagentAttentionItem[] {
    return this.list()
      .filter((record) => record.attentionReason !== null
        && (activeSessionIds === undefined || activeSessionIds.has(record.sessionId)))
      .map((record) => ({
        id: 'attention:' + record.id,
        kind: record.attentionReason === 'failed'
          ? 'subagent_failed'
          : record.attentionReason === 'action_needed'
            ? 'subagent_action_needed'
            : 'subagent_waiting',
        status: 'open',
        title: record.attentionReason === 'failed'
          ? `${record.role} 执行失败`
          : record.attentionReason === 'action_needed'
            ? `${record.role} 需要操作`
            : `${record.role} 正在等待`,
        sourceRef: record.id,
        sessionId: record.sessionId,
        payload: {
          runtimeType: record.runtimeType,
          runtimeId: record.runtimeId,
          parentId: record.parentId,
          role: record.role,
          lifecycleStatus: record.status as 'failed' | 'waiting',
          reason: record.attentionReason as SubagentAttentionReason,
          updatedAt: record.updatedAt,
        },
      }));
  }

  #apply(event: SubagentProjectionEvent): SubagentProjectionRecord[] {
    const runtimeType = safeRuntimeType(event.runtimeType);
    const sessionId = safeIdentifier(event.sessionId);
    const eventId = safeIdentifier(event.eventId);
    const sequence = safeSequence(event.sequence);
    const createdAt = safeTime(event.createdAt);
    if (!runtimeType || !sessionId || !eventId || sequence === null || createdAt === null) return [];

    const payload = event.payload;
    const candidates = projectionCandidates(payload, eventId);
    const changed: SubagentProjectionRecord[] = [];
    for (const candidate of candidates) {
      const runtimeId = safeIdentifier(candidate.runtimeId);
      if (!runtimeId) continue;
      const lifecycle = normalizeStatus(candidate.status, stringValue(payload.runtimeEventType));
      if (!lifecycle) continue;
      const key = `${runtimeType}\0${sessionId}\0${runtimeId}`;
      const existing = this.#records.get(key);
      if (existing && (createdAt < existing.updatedAt
        || (createdAt === existing.updatedAt && sequence <= existing.sourceSequence))) continue;
      const id = 'subagent:' + createHash('sha256').update(key).digest('hex').slice(0, 32);
      const record: SubagentProjectionRecord = {
        schemaVersion: 1,
        id,
        source: 'runtime',
        runtimeType,
        sessionId,
        runtimeId,
        runtimeTaskId: safeIdentifier(payload.runtimeTaskId) ?? '',
        parentId: safeIdentifier(payload.senderThreadId ?? payload.parentToolUseId) ?? '',
        role: safeRole(payload.name ?? payload.tool),
        status: lifecycle.status,
        attentionReason: lifecycle.attentionReason,
        sourceEventId: eventId,
        sourceSequence: sequence,
        startedAt: existing?.startedAt ?? createdAt,
        updatedAt: createdAt,
      };
      this.#records.set(key, record);
      changed.push({ ...record });
    }
    this.#trim();
    return changed;
  }

  #trim(): void {
    if (this.#records.size <= MAX_RECORDS) return;
    const retained = [...this.#records.entries()]
      .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
      .slice(0, MAX_RECORDS);
    this.#records = new Map(retained);
  }

  #load(): void {
    if (!existsSync(this.#path) || statSync(this.#path).size > MAX_FILE_BYTES) return;
    try {
      const value = JSON.parse(readFileSync(this.#path, 'utf8')) as Record<string, unknown>;
      if (value.schemaVersion !== 1 || !Array.isArray(value.records)) return;
      for (const raw of value.records.slice(0, MAX_RECORDS)) {
        const record = validateRecord(raw);
        if (record) this.#records.set(`${record.runtimeType}\0${record.sessionId}\0${record.runtimeId}`, record);
      }
    } catch {
      this.#records.clear();
    }
  }

  #save(): void {
    const temporary = this.#path + '.tmp-' + process.pid + '-' + randomUUID();
    const body = JSON.stringify({ schemaVersion: 1, records: this.list() }, null, 2);
    if (Buffer.byteLength(body, 'utf8') > MAX_FILE_BYTES) throw new Error('Subagent projection store exceeds its size limit');
    try {
      writeFileSync(temporary, body, { encoding: 'utf8', mode: 0o600 });
      renameSync(temporary, this.#path);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}

function projectionCandidates(payload: Record<string, unknown>, fallbackId: string): Array<{ runtimeId: unknown; status: unknown }> {
  const agents = Array.isArray(payload.agents) ? payload.agents.map(asObject) : [];
  if (agents.length > 0) return agents.slice(0, 32).map((agent) => ({ runtimeId: agent.threadId, status: agent.status }));
  const receivers = Array.isArray(payload.receiverThreadIds) ? payload.receiverThreadIds.slice(0, 32) : [];
  if (receivers.length > 0) return receivers.map((runtimeId) => ({ runtimeId, status: payload.status }));
  return [{
    runtimeId: payload.runtimeSubagentId ?? payload.runtimeTaskId ?? payload.parentToolUseId ?? fallbackId,
    status: payload.status ?? payload.runtimeEventType,
  }];
}

function normalizeStatus(value: unknown, eventType: string): {
  status: SubagentLifecycleStatus;
  attentionReason: SubagentAttentionReason | null;
} | null {
  const status = stringValue(value).toLocaleLowerCase('en-US');
  const type = eventType.toLocaleLowerCase('en-US');
  if (/error|fail|notfound/.test(status + ' ' + type)) return { status: 'failed', attentionReason: 'failed' };
  if (/action.?needed|approval.?required|requires.?action/.test(status + ' ' + type)) {
    return { status: 'waiting', attentionReason: 'action_needed' };
  }
  if (/wait|blocked|pending/.test(status + ' ' + type)) return { status: 'waiting', attentionReason: 'waiting' };
  if (/complete|success|finished|done/.test(status + ' ' + type)) return { status: 'completed', attentionReason: null };
  if (/started|start|spawn|created/.test(type)) return { status: 'started', attentionReason: null };
  if (/progress|running|inprogress|assistant|user/.test(status + ' ' + type)) return { status: 'progress', attentionReason: null };
  return null;
}

function validateRecord(value: unknown): SubagentProjectionRecord | null {
  const raw = asObject(value);
  const statuses: SubagentLifecycleStatus[] = ['started', 'progress', 'completed', 'failed', 'waiting'];
  const reasons: Array<SubagentAttentionReason | null> = ['failed', 'waiting', 'action_needed', null];
  const runtimeType = safeRuntimeType(raw.runtimeType);
  const sessionId = safeIdentifier(raw.sessionId);
  const runtimeId = safeIdentifier(raw.runtimeId);
  const expectedId = runtimeType && sessionId && runtimeId
    ? 'subagent:' + createHash('sha256').update(`${runtimeType}\0${sessionId}\0${runtimeId}`).digest('hex').slice(0, 32)
    : null;
  if (raw.schemaVersion !== 1 || raw.source !== 'runtime'
    || typeof raw.id !== 'string' || raw.id !== expectedId
    || !runtimeType || !sessionId || !runtimeId || !safeIdentifier(raw.sourceEventId)
    || !statuses.includes(raw.status as SubagentLifecycleStatus)
    || !reasons.includes(raw.attentionReason as SubagentAttentionReason | null)
    || safeSequence(raw.sourceSequence) === null || safeTime(raw.startedAt) === null || safeTime(raw.updatedAt) === null
    || Number(raw.startedAt) > Number(raw.updatedAt)
    || typeof raw.runtimeTaskId !== 'string' || typeof raw.parentId !== 'string' || typeof raw.role !== 'string') return null;
  if ((raw.status === 'failed' && raw.attentionReason !== 'failed')
    || (raw.status === 'waiting' && !['waiting', 'action_needed'].includes(String(raw.attentionReason)))
    || (!['failed', 'waiting'].includes(String(raw.status)) && raw.attentionReason !== null)) return null;
  return {
    schemaVersion: 1,
    id: raw.id,
    source: 'runtime',
    runtimeType,
    sessionId,
    runtimeId,
    runtimeTaskId: safeIdentifier(raw.runtimeTaskId) ?? '',
    parentId: safeIdentifier(raw.parentId) ?? '',
    role: safeRole(raw.role),
    status: raw.status as SubagentLifecycleStatus,
    attentionReason: raw.attentionReason as SubagentAttentionReason | null,
    sourceEventId: safeIdentifier(raw.sourceEventId) as string,
    sourceSequence: raw.sourceSequence as number,
    startedAt: raw.startedAt as number,
    updatedAt: raw.updatedAt as number,
  };
}

function safeRuntimeType(value: unknown): string | null {
  const runtimeType = stringValue(value).trim().toLowerCase();
  return /^[a-z][a-z0-9._-]{0,31}$/.test(runtimeType) ? runtimeType : null;
}

function safeIdentifier(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const clean = value.trim();
  return identifierPattern.test(clean) ? clean : null;
}

function safeRole(value: unknown): string {
  if (typeof value !== 'string') return 'Runtime Subagent';
  const clean = value.replace(/[\r\n\0]/g, ' ').trim();
  return /^[\p{L}\p{N} ._:/-]{1,80}$/u.test(clean) ? clean : 'Runtime Subagent';
}

function safeSequence(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function safeTime(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function stringValue(value: unknown): string { return typeof value === 'string' ? value : ''; }
function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
