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

const privateMarker = 'fixture-private-api-value/+';
const errorBody = `401 rejected ${privateMarker} ${encodeURIComponent(privateMarker)} private-response-body`;

for (const kind of ['factory', 'iterator', 'error event', 'failed completion']) {
  test(`Direct API removes the error body from a ${kind} failure`, async () => {
    const events = [];
    const client = new ApiRuntimeClient({ stream() {
      if (kind === 'factory') throw new Error(errorBody, { cause: { token: privateMarker } });
      if (kind === 'iterator') return { async *[Symbol.asyncIterator]() { throw new Error(errorBody); } };
      if (kind === 'error event') return streamOf([{ type: 'error', reason: 'error', error: { errorMessage: errorBody } }]);
      return streamOf([{ type: 'done', reason: 'error', message: { ...assistantMessage(), stopReason: 'error', errorMessage: errorBody, content: [{ type: 'text', text: privateMarker }] } }]);
    } });
    await assert.rejects(() => client.runTurn({
      turnId: 'turn:private-error', provider: provider(), modelId: 'fixture-model', apiKey: privateMarker,
      history: [], signal: new AbortController().signal, callbacks: { onEvent: (type, payload) => events.push({ type, payload }) },
    }), (error) => {
      assert.equal(error.category, 'authentication_failed');
      assert.equal(error.cause, undefined);
      const output = JSON.stringify({ error, message: error.message, stack: error.stack, events });
      for (const marker of [privateMarker, encodeURIComponent(privateMarker), 'private-response-body']) assert.equal(output.includes(marker), false);
      return true;
    });
    assert.equal(events.some((event) => event.type === 'api.assistant.message' || event.type === 'turn.completed'), false);
  });
}

test('Direct API retains useful error categories without returning raw errors', async () => {
  const cyclic = { message: privateMarker };
  cyclic.cause = cyclic;
  const cases = [
    [Object.assign(new Error(privateMarker), { status: 403 }), 'authentication_failed'],
    [{ cause: { statusCode: 429, message: privateMarker } }, 'rate_limited'],
    [new Error(`insufficient_quota ${privateMarker}`), 'quota_exhausted'],
    [new Error(`maximum tokens ${privateMarker}`), 'context_window_exceeded'],
    [{ error: { code: 'ETIMEDOUT', message: privateMarker } }, 'timeout'],
    [Object.assign(new Error(`Authorization ${privateMarker}`), { name: 'AbortError' }), 'aborted'],
    [{ cause: { code: 'ECONNRESET', message: privateMarker } }, 'network_error'],
    [cyclic, 'provider_error'],
    [{ get message() { throw new Error(privateMarker); } }, 'provider_error'],
  ];
  for (const [error, category] of cases) {
    const result = await verifyApiProvider(provider(), privateMarker, { stream: () => { throw error; } });
    assert.deepEqual(result, { ok: false, category });
    assert.equal(JSON.stringify(result).includes(privateMarker), false);
  }
});

test('successful API messages and history do not retain error metadata', async () => {
  const seen = [];
  const message = { ...assistantMessage(), errorMessage: errorBody };
  const client = new ApiRuntimeClient({ stream: () => streamOf([{ type: 'done', reason: 'stop', message }]) });
  const result = await client.runTurn({
    turnId: 'turn:safe-message', provider: provider(), modelId: 'fixture-model', apiKey: privateMarker,
    history: [], signal: new AbortController().signal, callbacks: { onEvent: (type, payload) => seen.push({ type, payload }) },
  });
  const history = readApiHistory([{ type: 'api.assistant.message', createdAt: 1, payload: { message } }]);
  assert.equal(result.errorMessage, undefined);
  assert.equal(history[0].errorMessage, undefined);
  assert.equal(JSON.stringify({ seen, result, history }).includes(privateMarker), false);
});
