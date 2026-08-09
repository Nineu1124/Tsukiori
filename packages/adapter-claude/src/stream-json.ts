import { createHash } from 'node:crypto';

export type ClaudeClientEvent = {
  type: string;
  payload: Record<string, unknown>;
};

type JsonObject = Record<string, unknown>;

const sensitiveKey = /(^|[_-])(api[_-]?key|secret|token|password|cookie|authorization|private[_-]?key)([_-]|$)/i;
const sensitiveValue = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+\/-]{8,}|\bsk-[A-Za-z0-9_-]{12,}/gi;

export class ClaudeStreamJsonMapper {
  readonly #maxLineBytes: number;
  readonly #maxPayloadBytes: number;
  readonly #startedTools = new Map<string, string>();
  readonly #blocks = new Map<number, { type: string; toolUseId?: string }>();
  #streamedText = false;
  #streamedThinking = false;
  #sawResult = false;

  constructor(options: { maxLineBytes?: number; maxPayloadBytes?: number } = {}) {
    this.#maxLineBytes = options.maxLineBytes ?? 256 * 1024;
    this.#maxPayloadBytes = options.maxPayloadBytes ?? 32 * 1024;
  }

  get sawResult(): boolean { return this.#sawResult; }

  mapLine(line: string): ClaudeClientEvent[] {
    const bytes = Buffer.byteLength(line, 'utf8');
    if (bytes > this.#maxLineBytes) {
      return [warning('line_too_large', { bytes, contentHash: hash(line) })];
    }
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      return [warning('invalid_json', { bytes, contentHash: hash(line) })];
    }
    if (!isObject(value)) return [this.#native('non_object_message', { value })];
    return this.#mapMessage(value);
  }

  #mapMessage(message: JsonObject): ClaudeClientEvent[] {
    const type = text(message.type);
    if (type === 'system' && text(message.subtype) === 'init') {
      const tools = strings(message.tools);
      const mcpServers = Array.isArray(message.mcp_servers) ? message.mcp_servers : [];
      return [{
        type: 'session.started',
        payload: compact({
          runtimeSessionId: text(message.session_id),
          model: text(message.model),
          permissionMode: text(message.permissionMode ?? message.permission_mode),
          toolCount: tools.length,
          tools,
          mcpServerCount: mcpServers.length,
          claudeCodeVersion: text(message.claude_code_version),
        }),
      }];
    }
    if (type === 'stream_event') return this.#mapStreamEvent(object(message.event));
    if (type === 'assistant') return this.#mapAssistant(message);
    if (type === 'user') return this.#mapUser(message);
    if (type === 'result') {
      this.#sawResult = true;
      const failed = message.is_error === true || text(message.subtype) === 'error';
      return [{
        type: 'turn.completed',
        payload: compact({
          status: failed ? 'failed' : 'completed',
          runtimeSessionId: text(message.session_id),
          costUsd: finite(message.total_cost_usd),
          durationMs: finite(message.duration_ms),
          durationApiMs: finite(message.duration_api_ms),
          turns: finite(message.num_turns),
          error: failed ? boundedText(message.result ?? message.error, 2_000) : undefined,
          usage: sanitize(object(message.usage)),
        }),
      }];
    }
    if (type === 'rate_limit_event') {
      return [warning('rate_limit', sanitize(message))];
    }
    if (type.includes('hook')) {
      return [{ type: 'hook.event', payload: limited(message, this.#maxPayloadBytes) }];
    }
    if (type.includes('subagent') || message.parent_tool_use_id) {
      return [{ type: 'subagent.event', payload: subagentSummary(message) }];
    }
    return [this.#native(type || 'unknown', message)];
  }

  #mapStreamEvent(event: JsonObject): ClaudeClientEvent[] {
    const type = text(event.type);
    if (type === 'message_start') {
      return [{ type: 'assistant.message.started', payload: { messageId: text(object(event.message).id) } }];
    }
    if (type === 'content_block_start') {
      const block = object(event.content_block);
      const blockType = text(block.type);
      const index = finite(event.index);
      if (blockType === 'tool_use' || blockType === 'server_tool_use') {
        const toolUseId = text(block.id) || `index:${finite(event.index) ?? 'unknown'}`;
        this.#startedTools.set(toolUseId, text(block.name) || 'tool');
        if (index !== undefined) this.#blocks.set(index, { type: blockType, toolUseId });
        return [{ type: 'tool.event', payload: toolPayload('started', block, toolUseId) }];
      }
      if (blockType === 'thinking') {
        if (index !== undefined) this.#blocks.set(index, { type: blockType });
        return [{ type: 'assistant.thinking.started', payload: { index } }];
      }
      if (index !== undefined) this.#blocks.set(index, { type: blockType || 'unknown' });
      return [];
    }
    if (type === 'content_block_delta') {
      const delta = object(event.delta);
      const deltaType = text(delta.type);
      if (deltaType === 'text_delta' && typeof delta.text === 'string') {
        this.#streamedText = true;
        return [{ type: 'assistant.delta', payload: { text: boundedText(delta.text, 32_000) } }];
      }
      if (deltaType === 'thinking_delta' && typeof delta.thinking === 'string') {
        this.#streamedThinking = true;
        return [{ type: 'assistant.thinking.delta', payload: { text: boundedText(delta.thinking, 32_000) } }];
      }
      if (deltaType === 'input_json_delta') {
        return [{
          type: 'tool.input.delta',
          payload: {
            index: finite(event.index),
            partialJson: boundedText(delta.partial_json, 16_000),
          },
        }];
      }
      return [this.#native(`stream_event.${type}.${deltaType || 'unknown'}`, event)];
    }
    if (type === 'content_block_stop') {
      const index = finite(event.index);
      const block = index === undefined ? undefined : this.#blocks.get(index);
      if (index !== undefined) this.#blocks.delete(index);
      if (block?.type === 'thinking') {
        return [{ type: 'assistant.thinking.completed', payload: { index } }];
      }
      if (block?.toolUseId) {
        return [{ type: 'tool.input.completed', payload: { index, toolUseId: block.toolUseId } }];
      }
      return [{ type: 'content.block.completed', payload: { index, blockType: block?.type ?? 'unknown' } }];
    }
    if (type === 'message_delta') {
      return [{
        type: 'assistant.usage',
        payload: limited({ delta: event.delta, usage: event.usage }, this.#maxPayloadBytes),
      }];
    }
    if (type === 'message_stop') return [{ type: 'assistant.message.completed', payload: {} }];
    return [this.#native(`stream_event.${type || 'unknown'}`, event)];
  }

  #mapAssistant(message: JsonObject): ClaudeClientEvent[] {
    const events: ClaudeClientEvent[] = [];
    for (const block of contentBlocks(message)) {
      const type = text(block.type);
      if (type === 'text' && typeof block.text === 'string' && !this.#streamedText) {
        events.push({ type: 'assistant.delta', payload: { text: boundedText(block.text, 32_000) } });
      } else if (type === 'thinking' && typeof block.thinking === 'string' && !this.#streamedThinking) {
        events.push({ type: 'assistant.thinking.delta', payload: { text: boundedText(block.thinking, 32_000) } });
      } else if (type === 'tool_use' || type === 'server_tool_use') {
        const toolUseId = text(block.id) || `assistant:${this.#startedTools.size + 1}`;
        if (!this.#startedTools.has(toolUseId)) {
          this.#startedTools.set(toolUseId, text(block.name) || 'tool');
          events.push({ type: 'tool.event', payload: toolPayload('started', block, toolUseId) });
        }
      }
    }
    if (events.length === 0 && contentBlocks(message).length === 0) {
      events.push(this.#native('assistant', message));
    }
    return events;
  }

  #mapUser(message: JsonObject): ClaudeClientEvent[] {
    const events: ClaudeClientEvent[] = [];
    for (const block of contentBlocks(message)) {
      if (text(block.type) !== 'tool_result') continue;
      const failed = block.is_error === true;
      const toolUseId = text(block.tool_use_id);
      const tool = this.#startedTools.get(toolUseId) ?? 'tool';
      events.push({
        type: 'tool.event',
        payload: compact({
          phase: failed ? 'failed' : 'completed',
          tool,
          toolUseId,
          summary: boundedText(toolResultText(block.content), 2_000),
          isError: failed,
        }),
      });
    }
    return events.length > 0 ? events : [this.#native('user', message)];
  }

  #native(nativeType: string, payload: unknown): ClaudeClientEvent {
    const safe = limited(payload, this.#maxPayloadBytes);
    return {
      type: 'native.event',
      payload: { nativeType, raw: safe, contentHash: hash(JSON.stringify(safe)) },
    };
  }
}

function toolPayload(phase: string, block: JsonObject, toolUseId: string): Record<string, unknown> {
  const tool = text(block.name) || 'tool';
  return compact({
    phase,
    tool,
    toolUseId,
    summary: tool,
    input: Object.hasOwn(block, 'input') ? limited(block.input, 16 * 1024) : undefined,
    parentToolUseId: text(block.parent_tool_use_id),
  });
}

function warning(reason: string, detail: unknown): ClaudeClientEvent {
  return { type: 'runtime.warning', payload: { reason, detail: limited(detail, 8 * 1024) } };
}

function contentBlocks(message: JsonObject): JsonObject[] {
  const nested = object(message.message);
  return Array.isArray(nested.content) ? nested.content.map(object) : [];
}

function toolResultText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return JSON.stringify(sanitize(value));
  return value.map((item) => {
    const block = object(item);
    return typeof block.text === 'string' ? block.text : JSON.stringify(sanitize(block));
  }).join('\n');
}

function sanitize(value: unknown, depth = 0, seen = new Set<object>()): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.replace(sensitiveValue, '[REDACTED]');
  if (typeof value !== 'object') return '[UNSUPPORTED]';
  if (depth >= 12) return '[MAX_DEPTH]';
  if (seen.has(value)) return '[CYCLE]';
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.slice(0, 256).map((item) => sanitize(item, depth + 1, seen));
    seen.delete(value);
    return result;
  }
  const result: JsonObject = {};
  for (const [key, item] of Object.entries(value).slice(0, 256)) {
    result[key] = sensitiveKey.test(key) ? '[REDACTED]' : sanitize(item, depth + 1, seen);
  }
  seen.delete(value);
  return result;
}

function limited(value: unknown, maxBytes: number): Record<string, unknown> {
  const safe = sanitize(value);
  const serialized = JSON.stringify(safe);
  if (Buffer.byteLength(serialized, 'utf8') <= maxBytes) {
    return isObject(safe) ? safe : { value: safe };
  }
  return {
    truncated: true,
    contentHash: hash(serialized),
    preview: Buffer.from(serialized, 'utf8').subarray(0, Math.max(0, maxBytes - 160)).toString('utf8'),
  };
}

function boundedText(value: unknown, maxLength: number): string {
  return String(value ?? '').replace(sensitiveValue, '[REDACTED]').slice(0, maxLength);
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== ''));
}

function subagentSummary(message: JsonObject): Record<string, unknown> {
  const nested = object(message.message);
  return compact({
    schemaVersion: 1,
    runtimeEventType: boundedText(message.type, 80),
    runtimeSubagentId: boundedText(message.agent_id ?? message.agentId ?? nested.agent_id ?? nested.agentId, 160),
    runtimeTaskId: boundedText(message.task_id ?? message.taskId ?? nested.task_id ?? nested.taskId, 160),
    parentToolUseId: boundedText(message.parent_tool_use_id ?? message.parentToolUseId, 160),
    status: boundedText(message.status ?? message.subtype, 80),
    name: boundedText(message.name ?? message.agent_name ?? message.agentName, 120),
  });
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, 128) : [];
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function text(value: unknown): string { return typeof value === 'string' ? value : ''; }

function object(value: unknown): JsonObject { return isObject(value) ? value : {}; }

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hash(value: string): string { return 'sha256:' + createHash('sha256').update(value).digest('hex'); }
