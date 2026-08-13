import { createHash } from 'node:crypto';

export type CodexCompactionMethod = 'thread/tokenUsage/updated' | 'thread/compacted';
export type CodexCompactionEventType = 'assistant.usage' | 'context.compacted' | 'context.compaction.updated';

export type CodexCompactionEvent = {
  type: CodexCompactionEventType;
  payload: Record<string, unknown>;
};

export type CodexCompactionProjectionResult = {
  status: 'accepted' | 'rejected';
  reason?: 'invalid_identity' | 'thread_mismatch' | 'turn_mismatch' | 'invalid_usage' | 'compaction_limit';
  events: CodexCompactionEvent[];
};

export type TokenUsageBreakdown = {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
};

export type CodexTokenUsage = {
  last: TokenUsageBreakdown;
  total: TokenUsageBreakdown;
  modelContextWindow: number | null;
};

export type CodexCompactionSummary = {
  compactionCount: number;
  latestTotalTokens: number;
  pendingCount: number;
};

type Association = {
  expectedThreadId?: string;
  activeTurnId?: string;
};

type PendingCompaction = {
  compactionId: string;
  threadId: string;
  turnId: string;
  observedTotalTokensBefore: number | null;
};

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;

export class CodexCompactionTracker {
  readonly #maxPending: number;
  readonly #maxCompactions: number;
  #latestByThread = new Map<string, CodexTokenUsage>();
  #pending = new Map<string, PendingCompaction>();
  #ordinals = new Map<string, number>();
  #compactionIds = new Set<string>();

  constructor(options: { maxPending?: number; maxCompactions?: number } = {}) {
    this.#maxPending = boundedInteger(options.maxPending ?? 32, 1, 256);
    this.#maxCompactions = boundedInteger(options.maxCompactions ?? 2_048, 1, 65_536);
  }

  ingest(method: CodexCompactionMethod, params: Record<string, unknown>, association: Association = {}): CodexCompactionProjectionResult {
    const identity = notificationIdentity(params);
    if (!identity) return rejected('invalid_identity');
    if (association.expectedThreadId && identity.threadId !== association.expectedThreadId) return rejected('thread_mismatch');
    if (association.activeTurnId && identity.turnId !== association.activeTurnId) return rejected('turn_mismatch');
    return method === 'thread/compacted'
      ? this.#compacted(identity.threadId, identity.turnId)
      : this.#usage(identity.threadId, identity.turnId, params.tokenUsage);
  }

  restore(type: CodexCompactionEventType, payload: Record<string, unknown>): void {
    if (type === 'assistant.usage') {
      const identity = notificationIdentity(payload);
      const usage = normalizeUsage(payload.tokenUsage);
      if (identity && usage) this.#latestByThread.set(identity.threadId, usage);
      return;
    }
    const compactionId = safeIdentifier(payload.compactionId);
    const threadId = safeIdentifier(payload.threadId);
    const turnId = safeIdentifier(payload.turnId);
    if (!compactionId || !threadId || !turnId) return;
    if (type === 'context.compacted') {
      const ordinal = safeCount(payload.ordinal);
      if (ordinal === null || this.#compactionIds.has(compactionId)) return;
      if (this.#compactionIds.size >= this.#maxCompactions) return;
      this.#compactionIds.add(compactionId);
      this.#ordinals.set(threadId, Math.max(this.#ordinals.get(threadId) ?? 0, ordinal));
      this.#pending.set(compactionId, {
        compactionId, threadId, turnId, observedTotalTokensBefore: nullableCount(payload.observedTotalTokensBefore),
      });
      this.#trimPending();
      return;
    }
    this.#pending.delete(compactionId);
  }

  summary(threadId?: string): CodexCompactionSummary {
    const latest = threadId ? this.#latestByThread.get(threadId) : [...this.#latestByThread.values()].at(-1);
    return {
      compactionCount: this.#compactionIds.size,
      latestTotalTokens: latest?.total.totalTokens ?? 0,
      pendingCount: [...this.#pending.values()].filter((item) => !threadId || item.threadId === threadId).length,
    };
  }

  #usage(threadId: string, turnId: string, raw: unknown): CodexCompactionProjectionResult {
    const usage = normalizeUsage(raw);
    if (!usage) return rejected('invalid_usage');
    this.#latestByThread.set(threadId, usage);
    const events: CodexCompactionEvent[] = [{
      type: 'assistant.usage',
      payload: { schemaVersion: 1, runtimeType: 'codex', threadId, turnId, tokenUsage: usage },
    }];
    const pending = [...this.#pending.values()].filter((item) => item.threadId === threadId);
    for (const item of pending) {
      const before = item.observedTotalTokensBefore;
      const after = usage.total.totalTokens;
      events.push({
        type: 'context.compaction.updated',
        payload: {
          schemaVersion: 1,
          runtimeType: 'codex',
          compactionId: item.compactionId,
          threadId,
          turnId: item.turnId,
          usageTurnId: turnId,
          association: item.turnId === turnId ? 'same_turn' : 'later_turn',
          status: 'usage_observed',
          observedTotalTokensBefore: before,
          observedTotalTokensAfter: after,
          usageDelta: before === null ? null : after - before,
          modelContextWindow: usage.modelContextWindow,
        },
      });
      this.#pending.delete(item.compactionId);
    }
    return { status: 'accepted', events };
  }

  #compacted(threadId: string, turnId: string): CodexCompactionProjectionResult {
    if (this.#compactionIds.size >= this.#maxCompactions) return rejected('compaction_limit');
    const ordinal = (this.#ordinals.get(threadId) ?? 0) + 1;
    this.#ordinals.set(threadId, ordinal);
    const compactionId = 'compaction:' + createHash('sha256')
      .update(`${threadId}\0${turnId}\0${ordinal}`)
      .digest('hex')
      .slice(0, 32);
    const observedTotalTokensBefore = this.#latestByThread.get(threadId)?.total.totalTokens ?? null;
    this.#compactionIds.add(compactionId);
    this.#pending.set(compactionId, { compactionId, threadId, turnId, observedTotalTokensBefore });
    this.#trimPending();
    return {
      status: 'accepted',
      events: [{
        type: 'context.compacted',
        payload: {
          schemaVersion: 1,
          runtimeType: 'codex',
          supportLevel: 'supported',
          evidence: 'codex-app-server-0.146.0-locked-schema',
          compactionId,
          threadId,
          turnId,
          ordinal,
          status: 'awaiting_usage',
          observedTotalTokensBefore,
        },
      }],
    };
  }

  #trimPending(): void {
    while (this.#pending.size > this.#maxPending) {
      const oldest = this.#pending.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#pending.delete(oldest);
    }
  }
}

function notificationIdentity(value: Record<string, unknown>): { threadId: string; turnId: string } | null {
  const threadId = safeIdentifier(value.threadId);
  const turnId = safeIdentifier(value.turnId);
  return threadId && turnId ? { threadId, turnId } : null;
}

function normalizeUsage(value: unknown): CodexTokenUsage | null {
  const raw = object(value);
  const last = normalizeBreakdown(raw.last);
  const total = normalizeBreakdown(raw.total);
  const modelContextWindow = raw.modelContextWindow === null || raw.modelContextWindow === undefined
    ? null : safeCount(raw.modelContextWindow);
  if (!last || !total || (raw.modelContextWindow !== null && raw.modelContextWindow !== undefined && modelContextWindow === null)) return null;
  return { last, total, modelContextWindow };
}

function normalizeBreakdown(value: unknown): TokenUsageBreakdown | null {
  const raw = object(value);
  const inputTokens = safeCount(raw.inputTokens);
  const cachedInputTokens = safeCount(raw.cachedInputTokens);
  const outputTokens = safeCount(raw.outputTokens);
  const reasoningOutputTokens = safeCount(raw.reasoningOutputTokens);
  const totalTokens = safeCount(raw.totalTokens);
  const cacheWriteInputTokens = raw.cacheWriteInputTokens === undefined ? 0 : safeCount(raw.cacheWriteInputTokens);
  if ([inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, totalTokens, cacheWriteInputTokens].some((item) => item === null)) return null;
  return {
    inputTokens: inputTokens as number,
    cachedInputTokens: cachedInputTokens as number,
    cacheWriteInputTokens: cacheWriteInputTokens as number,
    outputTokens: outputTokens as number,
    reasoningOutputTokens: reasoningOutputTokens as number,
    totalTokens: totalTokens as number,
  };
}

function rejected(reason: NonNullable<CodexCompactionProjectionResult['reason']>): CodexCompactionProjectionResult {
  return { status: 'rejected', reason, events: [] };
}

function safeIdentifier(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const clean = value.trim();
  return identifierPattern.test(clean) ? clean : null;
}

function safeCount(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function nullableCount(value: unknown): number | null {
  return value === null ? null : safeCount(value);
}

function boundedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error('Invalid Codex Compaction bound');
  return value;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
