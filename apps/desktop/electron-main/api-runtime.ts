import {
  streamSimple,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  type Message,
  type Model,
} from '@earendil-works/pi-ai/compat';
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all';
import type { ProviderConfig, ProviderKind } from './provider-registry.js';

export type ApiRuntimeCallbacks = {
  onEvent: (type: string, payload: Record<string, unknown>) => void;
};

export type ApiRuntimeTurn = {
  turnId: string;
  provider: ProviderConfig;
  modelId: string;
  apiKey: string;
  history: Message[];
  signal: AbortSignal;
  callbacks: ApiRuntimeCallbacks;
};

type StreamFactory = typeof streamSimple;

const catalogProviderByKind: Partial<Record<ProviderKind, string>> = {
  openai: 'openai',
  anthropic: 'anthropic',
  deepseek: 'deepseek',
  google: 'google',
  openrouter: 'openrouter',
  xai: 'xai',
  groq: 'groq',
  mistral: 'mistral',
  cerebras: 'cerebras',
  together: 'together',
  zai: 'zai',
  moonshot: 'moonshotai',
  minimax: 'minimax',
  fireworks: 'fireworks',
  kimi: 'kimi-coding',
};

const readCatalogModels = getBuiltinModels as unknown as (provider: string) => Model<Api>[];

export class ApiRuntimeClient {
  readonly #stream: StreamFactory;

  constructor(options: { stream?: StreamFactory } = {}) {
    this.#stream = options.stream ?? streamSimple;
  }

  async runTurn(input: ApiRuntimeTurn): Promise<AssistantMessage> {
    const model = resolveApiModel(input.provider, input.modelId);
    const context: Context = { messages: input.history };
    input.callbacks.onEvent('turn.started', {
      turnId: input.turnId,
      api: model.api,
      providerId: input.provider.id,
      model: model.id,
    });
    input.callbacks.onEvent('assistant.message.started', {
      messageId: `api-message:${input.turnId}`,
      providerId: input.provider.id,
      model: model.id,
    });
    const stream = this.#stream(model, context, {
      apiKey: input.apiKey,
      signal: input.signal,
      maxTokens: Math.min(model.maxTokens, input.provider.maxTokens),
      maxRetries: 0,
    });
    let completed: AssistantMessage | undefined;
    for await (const event of stream) {
      this.#mapEvent(input, event);
      if (event.type === 'done') completed = event.message;
      if (event.type === 'error') {
        const error = new Error(safeError(event.error.errorMessage, event.reason));
        error.name = event.reason === 'aborted' ? 'AbortError' : 'ApiRuntimeError';
        throw error;
      }
    }
    if (!completed) throw new Error('API Runtime 流未返回完成事件');
    const toolCalls = completed.content.filter((item) => item.type === 'toolCall');
    if (toolCalls.length) throw new Error('此 API Runtime 尚未启用工具执行，请改用 Codex 或 Claude Code Runtime');
    input.callbacks.onEvent('assistant.usage', {
      providerId: input.provider.id,
      model: completed.responseModel ?? completed.model,
      inputTokens: safeCount(completed.usage.input),
      outputTokens: safeCount(completed.usage.output),
      cacheReadTokens: safeCount(completed.usage.cacheRead),
      cacheWriteTokens: safeCount(completed.usage.cacheWrite),
      reasoningTokens: safeOptionalCount(completed.usage.reasoning),
      totalTokens: safeCount(completed.usage.totalTokens),
      estimatedCost: safeMoney(completed.usage.cost.total),
    });
    input.callbacks.onEvent('api.assistant.message', {
      schemaVersion: 1,
      providerId: input.provider.id,
      message: serializableAssistant(completed),
    });
    input.callbacks.onEvent('assistant.message.completed', {
      messageId: completed.responseId ?? `api-message:${input.turnId}`,
      stopReason: completed.stopReason,
    });
    input.callbacks.onEvent('turn.completed', {
      turnId: input.turnId,
      status: completed.stopReason === 'error' ? 'failed' : 'completed',
    });
    return completed;
  }

  #mapEvent(input: ApiRuntimeTurn, event: AssistantMessageEvent): void {
    const blockId = `api:${input.turnId}:${'contentIndex' in event ? event.contentIndex : 0}`;
    if (event.type === 'text_delta') {
      input.callbacks.onEvent('assistant.delta', { text: event.delta });
    } else if (event.type === 'thinking_start') {
      input.callbacks.onEvent('assistant.thinking.started', {
        blockId, index: blockId, source: 'api.reasoning',
      });
    } else if (event.type === 'thinking_delta') {
      input.callbacks.onEvent('assistant.thinking.delta', { blockId, index: blockId, text: event.delta });
    } else if (event.type === 'thinking_end') {
      input.callbacks.onEvent('assistant.thinking.completed', { blockId, index: blockId });
    } else if (event.type === 'toolcall_start' || event.type === 'toolcall_delta' || event.type === 'toolcall_end') {
      input.callbacks.onEvent('native.event', {
        nativeType: event.type,
        reason: 'api_tool_loop_not_enabled',
        redacted: true,
      });
    }
  }
}

export function providerCatalogModels(kind: ProviderKind): Model<Api>[] {
  const provider = catalogProviderByKind[kind];
  if (!provider) return [];
  return readCatalogModels(provider).map((model) => ({ ...model }));
}

export function providerCatalogId(kind: ProviderKind): string | undefined {
  return catalogProviderByKind[kind];
}

export function resolveApiModel(provider: ProviderConfig, modelId: string): Model<Api> {
  const api = provider.apiFormat;
  if (!isApiProtocol(api)) throw new Error('所选 Provider 不能用于直接 API Runtime');
  const source = providerCatalogModels(provider.kind).find((model) => model.id === modelId && model.api === api);
  if (source) {
    return {
      ...source,
      baseUrl: effectiveBaseUrl(provider, source.baseUrl),
      maxTokens: Math.min(source.maxTokens, provider.maxTokens),
      contextWindow: Math.min(source.contextWindow, provider.contextWindow),
    };
  }
  return {
    id: modelId,
    name: modelId,
    api,
    provider: provider.id,
    baseUrl: effectiveBaseUrl(provider, provider.baseUrl),
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: provider.contextWindow,
    maxTokens: provider.maxTokens,
  };
}

export async function verifyApiProvider(
  provider: ProviderConfig,
  apiKey: string,
  options: { timeoutMs?: number; stream?: StreamFactory } = {},
): Promise<{ ok: boolean; category: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
  try {
    const client = new ApiRuntimeClient({ ...(options.stream ? { stream: options.stream } : {}) });
    await client.runTurn({
      turnId: 'provider-probe',
      provider,
      modelId: provider.models[0] ?? '',
      apiKey,
      history: [{ role: 'user', content: 'Reply with OK.', timestamp: Date.now() }],
      signal: controller.signal,
      callbacks: { onEvent: () => undefined },
    });
    return { ok: true, category: 'connected' };
  } catch (error) {
    return { ok: false, category: apiErrorCategory(error, controller.signal.aborted) };
  } finally {
    clearTimeout(timer);
  }
}

export function readApiHistory(events: readonly { type: string; createdAt: number; payload: Record<string, unknown> }[]): Message[] {
  const messages: Message[] = [];
  for (const event of events) {
    if (event.type === 'user.message' && typeof event.payload.text === 'string') {
      messages.push({ role: 'user', content: event.payload.text, timestamp: event.createdAt });
      continue;
    }
    if (event.type !== 'api.assistant.message') continue;
    const message = parseAssistant(event.payload.message);
    if (message) messages.push(message);
  }
  return messages.slice(-100);
}

function parseAssistant(value: unknown): AssistantMessage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.role !== 'assistant' || !Array.isArray(raw.content)
    || typeof raw.api !== 'string' || typeof raw.provider !== 'string' || typeof raw.model !== 'string') return undefined;
  const content = raw.content.flatMap((item): AssistantMessage['content'] => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const block = item as Record<string, unknown>;
    if (block.type === 'text' && typeof block.text === 'string') return [{ type: 'text', text: block.text }];
    if (block.type === 'thinking' && typeof block.thinking === 'string') {
      return [{ type: 'thinking', thinking: block.thinking, ...(typeof block.thinkingSignature === 'string' ? { thinkingSignature: block.thinkingSignature } : {}) }];
    }
    return [];
  });
  return {
    role: 'assistant', content,
    api: raw.api, provider: raw.provider, model: raw.model,
    ...(typeof raw.responseModel === 'string' ? { responseModel: raw.responseModel } : {}),
    ...(typeof raw.responseId === 'string' ? { responseId: raw.responseId } : {}),
    usage: parseUsage(raw.usage),
    stopReason: ['stop', 'length', 'error', 'aborted'].includes(String(raw.stopReason))
      ? raw.stopReason as AssistantMessage['stopReason'] : 'stop',
    ...(typeof raw.errorMessage === 'string' ? { errorMessage: raw.errorMessage } : {}),
    timestamp: Number.isFinite(raw.timestamp) ? Number(raw.timestamp) : Date.now(),
  };
}

function serializableAssistant(message: AssistantMessage): AssistantMessage {
  return {
    role: 'assistant',
    content: message.content.flatMap((block): AssistantMessage['content'] => {
      if (block.type === 'text') return [{ type: 'text', text: block.text }];
      if (block.type === 'thinking') return [{
        type: 'thinking', thinking: block.thinking,
        ...(block.thinkingSignature ? { thinkingSignature: block.thinkingSignature } : {}),
        ...(block.redacted ? { redacted: true } : {}),
      }];
      return [];
    }),
    api: message.api,
    provider: message.provider,
    model: message.model,
    ...(message.responseModel ? { responseModel: message.responseModel } : {}),
    ...(message.responseId ? { responseId: message.responseId } : {}),
    usage: parseUsage(message.usage),
    stopReason: message.stopReason,
    ...(message.errorMessage ? { errorMessage: safeError(message.errorMessage, 'provider_error') } : {}),
    timestamp: message.timestamp,
  };
}

function parseUsage(value: unknown): AssistantMessage['usage'] {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const cost = raw.cost && typeof raw.cost === 'object' && !Array.isArray(raw.cost)
    ? raw.cost as Record<string, unknown> : {};
  return {
    input: safeCount(raw.input), output: safeCount(raw.output),
    cacheRead: safeCount(raw.cacheRead), cacheWrite: safeCount(raw.cacheWrite),
    ...(raw.reasoning === undefined ? {} : { reasoning: safeCount(raw.reasoning) }),
    totalTokens: safeCount(raw.totalTokens),
    cost: {
      input: safeMoney(cost.input), output: safeMoney(cost.output),
      cacheRead: safeMoney(cost.cacheRead), cacheWrite: safeMoney(cost.cacheWrite),
      total: safeMoney(cost.total),
    },
  };
}

function isApiProtocol(value: string): value is Api {
  return ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai', 'mistral-conversations'].includes(value);
}

function effectiveBaseUrl(provider: ProviderConfig, catalogBaseUrl: string): string {
  const base = provider.baseUrl.replace(/\/+$/, '');
  if (provider.kind === 'openai' && base === 'https://api.openai.com') return catalogBaseUrl;
  return base;
}

function safeError(value: unknown, fallback: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return (text || fallback).slice(0, 2_000);
}

function safeCount(value: unknown): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function safeOptionalCount(value: unknown): number | undefined {
  return value === undefined ? undefined : safeCount(value);
}

function safeMoney(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.min(number, Number.MAX_SAFE_INTEGER) : 0;
}

function apiErrorCategory(error: unknown, timedOut: boolean): string {
  if (timedOut) return 'timeout';
  const text = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (/401|403|auth|api key|unauthorized|forbidden/.test(text)) return 'authentication_failed';
  if (/429|rate.?limit/.test(text)) return 'rate_limited';
  if (/quota|credit|balance/.test(text)) return 'quota_exhausted';
  if (/context|too many tokens|maximum token/.test(text)) return 'context_window_exceeded';
  if (/abort/.test(text)) return 'aborted';
  return /fetch|network|connect|dns|socket|tls/.test(text) ? 'network_error' : 'provider_error';
}
