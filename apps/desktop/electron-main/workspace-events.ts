import { createHash, randomUUID } from 'node:crypto';
import { runtimeFailure, type CodexCompactionTracker } from '@tsukiori/runtime-core';

export const WORKSPACE_EVENT_SCHEMA_VERSION = 1 as const;

export type WorkspaceEvent = {
  schemaVersion: typeof WORKSPACE_EVENT_SCHEMA_VERSION;
  id: string;
  sequence: number;
  sessionId?: string;
  type: string;
  createdAt: number;
  payload: Record<string, unknown>;
};

export type WorkspaceEventInput = Pick<WorkspaceEvent, 'sessionId' | 'type' | 'payload'> & { createdAt?: number };

export function createWorkspaceEvent(
  input: WorkspaceEventInput,
  sequence: number,
  identity: { id?: string; now?: number } = {},
): WorkspaceEvent {
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error('工作区事件序号无效');
  return {
    schemaVersion: WORKSPACE_EVENT_SCHEMA_VERSION,
    id: identity.id ?? randomUUID(),
    sequence,
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    type: input.type,
    createdAt: input.createdAt ?? identity.now ?? Date.now(),
    payload: input.payload,
  };
}

/** 旧 Transcript 没有外层版本；只将该旧格式解释为 v1，不能猜测未来版本。 */
export function restoreWorkspaceEvent(
  raw: Record<string, unknown>,
  sessionId: string,
  sequence: number,
  fallbackCreatedAt: number,
): WorkspaceEvent {
  if ((raw.schemaVersion !== undefined && raw.schemaVersion !== WORKSPACE_EVENT_SCHEMA_VERSION)
    || raw.sessionId !== sessionId || typeof raw.type !== 'string') throw new Error('工作区事件格式不兼容');
  return createWorkspaceEvent({
    sessionId, type: raw.type,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : fallbackCreatedAt,
    payload: object(raw.payload),
  }, sequence, { ...(typeof raw.id === 'string' ? { id: raw.id } : {}) });
}

type ConvertedEvent = {
  route: 'workspace' | 'runtime';
  type: string;
  payload: Record<string, unknown>;
};

type CodexEventContext = {
  threadId?: string;
  activeTurnId?: string;
  thinkingBlocks: Set<string>;
  compactionTracker: () => CodexCompactionTracker;
};

/** 映射只产生投影；会话状态、审批和持久化仍由调用方按返回顺序执行。 */
export function convertCodexNotification(
  method: string,
  params: Record<string, unknown>,
  context: CodexEventContext,
): { events: ConvertedEvent[]; save: boolean } {
  const events: ConvertedEvent[] = [];
  const emit = (type: string, payload: Record<string, unknown>) => events.push({ route: 'workspace', type, payload });
  const runtime = (type: string, payload: Record<string, unknown>) => events.push({ route: 'runtime', type, payload });
  if (method === 'thread/tokenUsage/updated' || method === 'thread/compacted') {
    const result = context.compactionTracker().ingest(method, params, {
      ...(context.threadId ? { expectedThreadId: context.threadId } : {}),
      ...(context.activeTurnId ? { activeTurnId: context.activeTurnId } : {}),
    });
    if (result.status === 'rejected') emit('native.event', {
      nativeType: method, reason: 'compaction_' + result.reason,
      parameterKeys: Object.keys(params).slice(0, 32).map((key) => safeText(key, 'unknown', 80)), redacted: true,
    });
    else for (const event of result.events) emit(event.type, event.payload);
    return { events, save: true };
  }
  if (method === 'item/agentMessage/delta') {
    emit('assistant.delta', { text: truncate(String(params.delta ?? ''), 32_000) });
    return { events, save: false };
  }
  if (method === 'item/reasoning/textDelta' || method === 'item/reasoning/summaryTextDelta') {
    const itemId = safeText(params.itemId, '', 120);
    const indexName = method.endsWith('summaryTextDelta') ? 'summaryIndex' : 'contentIndex';
    const index = Number.isSafeInteger(params[indexName]) && Number(params[indexName]) >= 0 ? Number(params[indexName]) : null;
    if (!itemId || index === null) emit('native.event', {
      nativeType: method, reason: 'invalid_reasoning_delta_identity', redacted: true,
    });
    else {
      const kind = method.endsWith('summaryTextDelta') ? 'summary' : 'content';
      const blockId = `codex:${itemId}:${kind}:${index}`;
      context.thinkingBlocks.add(blockId);
      runtime('assistant.thinking.delta', {
        blockId, index: blockId, source: `codex.reasoning.${kind}`,
        text: truncate(String(params.delta ?? ''), 32_000),
      });
    }
    return { events, save: false };
  }
  if (method === 'item/reasoning/summaryPartAdded') {
    const itemId = safeText(params.itemId, '', 120);
    const index = Number.isSafeInteger(params.summaryIndex) && Number(params.summaryIndex) >= 0 ? Number(params.summaryIndex) : null;
    if (!itemId || index === null) emit('native.event', {
      nativeType: method, reason: 'invalid_reasoning_part_identity', redacted: true,
    });
    else {
      const blockId = `codex:${itemId}:summary:${index}`;
      context.thinkingBlocks.add(blockId);
      runtime('assistant.thinking.started', { blockId, index: blockId, source: 'codex.reasoning.summary' });
    }
    return { events, save: false };
  }
  if (method === 'turn/started') {
    runtime('turn.started', { turnId: String(object(params.turn).id ?? params.turnId ?? '') });
  } else if (method === 'turn/completed') {
    const turn = object(params.turn);
    runtime('turn.completed', {
      turnId: String(turn.id ?? params.turnId ?? ''), status: String(turn.status ?? 'completed'),
      ...(turn.error ? { error: runtimeFailure(turn.error).message } : {}),
    });
  } else if (method === 'item/started' || method === 'item/completed') {
    const item = object(params.item);
    const itemType = String(item.type ?? 'tool');
    if (itemType === 'reasoning' && method === 'item/completed') {
      const prefix = `codex:${safeText(item.id, '', 120)}:`;
      for (const blockId of [...context.thinkingBlocks]) {
        if (!blockId.startsWith(prefix)) continue;
        runtime('assistant.thinking.completed', { blockId, index: blockId });
        context.thinkingBlocks.delete(blockId);
      }
    }
    if (itemType === 'collabAgentToolCall') {
      emit('subagent.event', {
        schemaVersion: 1, runtimeEventType: method,
        runtimeTaskId: safeText(item.id, '', 160), senderThreadId: safeText(item.senderThreadId, '', 160),
        receiverThreadIds: Array.isArray(item.receiverThreadIds)
          ? item.receiverThreadIds.slice(0, 32).map((value) => safeText(value, '', 160)).filter(Boolean) : [],
        tool: safeText(item.tool, 'collabAgentToolCall', 80),
        status: safeText(item.status, method.endsWith('started') ? 'inProgress' : 'completed', 80),
        agents: Object.entries(object(item.agentsStates)).slice(0, 32).map(([threadId, value]) => ({
          threadId: safeText(threadId, 'unknown', 160), status: safeText(object(value).status, 'unknown', 80),
        })),
      });
    }
    if (!['agentMessage', 'userMessage', 'reasoning'].includes(itemType)) emit('tool.event', {
      phase: method.endsWith('started') ? 'started' : 'completed', tool: itemType,
      toolUseId: String(item.id ?? ''), summary: truncate(String(item.command ?? item.path ?? item.name ?? itemType), 2_000),
    });
  } else if (method === 'error') emit('runtime.error', runtimeFailure(params));
  else {
    const serialized = JSON.stringify(params);
    emit('native.event', {
      nativeType: safeText(method, 'unknown', 160),
      parameterKeys: Object.keys(params).slice(0, 32).map((key) => safeText(key, 'unknown', 80)),
      contentHash: 'sha256:' + createHash('sha256').update(serialized).digest('hex'),
      bytes: Buffer.byteLength(serialized, 'utf8'), redacted: true,
    });
  }
  return { events, save: true };
}

/** Direct API 的错误已在 ApiRuntimeClient 中分类；这里不能重新解释其分类。 */
export function normalizeRuntimeEvent(
  runtimeType: 'codex' | 'claude' | 'api', type: string, payload: Record<string, unknown>,
): Record<string, unknown> {
  if (runtimeType === 'api') return payload;
  if (type === 'runtime.error') return runtimeFailure(payload);
  if (type === 'turn.completed' && payload.error) {
    const safe = runtimeFailure(payload.error);
    return { ...payload, error: safe.message, category: safe.category };
  }
  return payload;
}

function safeText(value: unknown, fallback: string, max: number): string {
  if (typeof value !== 'string') return fallback;
  const text = value.trim();
  if (text.length > max || /[\0]/.test(text)) throw new Error('设置值无效');
  return text;
}

function truncate(value: string, max: number): string { return value.length <= max ? value : value.slice(0, max) + '\n…[truncated]'; }
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
