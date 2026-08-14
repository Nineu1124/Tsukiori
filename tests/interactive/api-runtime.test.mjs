import assert from 'node:assert/strict';
import test from 'node:test';

const {
  ApiRuntimeClient,
  providerCatalogModels,
  readApiHistory,
  resolveApiModel,
  verifyApiProvider,
} = await import(new URL('../../apps/desktop/dist/electron-main/api-runtime.js', import.meta.url));

function provider(overrides = {}) {
  return {
    id: 'provider:fixture',
    name: 'Fixture API',
    kind: 'openai-compatible',
    apiFormat: 'openai-completions',
    baseUrl: 'https://api.example.invalid/v1',
    models: ['fixture-model'],
    contextWindow: 32_000,
    maxTokens: 4_096,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function assistantMessage() {
  return {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'bounded reasoning' },
      { type: 'text', text: 'fixture response' },
    ],
    api: 'openai-completions',
    provider: 'provider:fixture',
    model: 'fixture-model',
    responseId: 'response:fixture',
    usage: {
      input: 3,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 1,
      totalTokens: 5,
      cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
    },
    stopReason: 'stop',
    timestamp: 1_800_300_000_000,
  };
}

function streamOf(events) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
  };
}

test('Direct API Runtime normalizes streaming, usage, and a resumable sanitized assistant message', async () => {
  const seen = [];
  let call;
  const message = assistantMessage();
  const client = new ApiRuntimeClient({
    stream(model, context, options) {
      call = { model, context, options };
      return streamOf([
        { type: 'text_delta', contentIndex: 1, delta: 'fixture ' },
        { type: 'thinking_start', contentIndex: 0 },
        { type: 'thinking_delta', contentIndex: 0, delta: 'bounded reasoning' },
        { type: 'thinking_end', contentIndex: 0 },
        { type: 'text_delta', contentIndex: 1, delta: 'response' },
        { type: 'done', reason: 'stop', message },
      ]);
    },
  });
  const controller = new AbortController();
  const result = await client.runTurn({
    turnId: 'turn:fixture',
    provider: provider(),
    modelId: 'fixture-model',
    apiKey: 'fixture-secret-must-not-enter-events',
    history: [{ role: 'user', content: 'fixture prompt', timestamp: 1_800_299_999_000 }],
    signal: controller.signal,
    callbacks: { onEvent: (type, payload) => seen.push({ type, payload }) },
  });

  assert.equal(result, message);
  assert.equal(call.model.api, 'openai-completions');
  assert.equal(call.model.baseUrl, 'https://api.example.invalid/v1');
  assert.equal(call.options.apiKey, 'fixture-secret-must-not-enter-events');
  assert.equal(call.options.maxTokens, 4_096);
  assert.equal(call.options.maxRetries, 0);
  assert.deepEqual(seen.filter((event) => event.type === 'assistant.delta').map((event) => event.payload.text), ['fixture ', 'response']);
  assert.equal(seen.some((event) => event.type === 'assistant.thinking.delta'), true);
  assert.deepEqual(seen.find((event) => event.type === 'assistant.usage').payload, {
    providerId: 'provider:fixture',
    model: 'fixture-model',
    inputTokens: 3,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 1,
    totalTokens: 5,
    estimatedCost: 0.003,
  });
  assert.doesNotMatch(JSON.stringify(seen), /fixture-secret-must-not-enter-events/);

  const persisted = seen.find((event) => event.type === 'api.assistant.message');
  const history = readApiHistory([
    { type: 'user.message', createdAt: 1_800_299_999_000, payload: { text: 'fixture prompt' } },
    { type: persisted.type, createdAt: 1_800_300_000_000, payload: persisted.payload },
  ]);
  assert.equal(history.length, 2);
  assert.equal(history[1].content.some((block) => block.type === 'text' && block.text === 'fixture response'), true);
});

test('Direct API Runtime classifies aborts and refuses returned tool calls', async () => {
  const aborted = await verifyApiProvider(provider(), 'fixture-secret', {
    stream: () => streamOf([{ type: 'error', reason: 'aborted', error: { errorMessage: 'request aborted' } }]),
  });
  assert.deepEqual(aborted, { ok: false, category: 'aborted' });

  const toolMessage = { ...assistantMessage(), content: [{ type: 'toolCall', id: 'tool:1', name: 'shell', arguments: { command: 'ignored' } }] };
  const client = new ApiRuntimeClient({ stream: () => streamOf([{ type: 'done', reason: 'toolUse', message: toolMessage }]) });
  await assert.rejects(() => client.runTurn({
    turnId: 'turn:tool', provider: provider(), modelId: 'fixture-model', apiKey: 'fixture-secret',
    history: [], signal: new AbortController().signal, callbacks: { onEvent: () => undefined },
  }), /尚未启用工具执行/);
});

test('Direct API Runtime exposes locked catalogs while custom models remain conservative', () => {
  assert.equal(providerCatalogModels('openai').length > 0, true);
  assert.equal(providerCatalogModels('openrouter').length > 0, true);
  const model = resolveApiModel(provider(), 'fixture-model');
  assert.equal(model.reasoning, false);
  assert.deepEqual(model.input, ['text']);
  assert.equal(model.contextWindow, 32_000);
  assert.equal(model.maxTokens, 4_096);
});
