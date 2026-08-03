import assert from 'node:assert/strict';
import test from 'node:test';

const { ProviderRegistry } = await import(
  new URL('../../apps/desktop/dist/electron-main/provider-registry.js', import.meta.url)
);

test('Provider Registry tests a connection without exposing or persisting the secret', async (t) => {
  const secrets = new Map();
  const persisted = [];
  const credentials = {
    store(input) {
      const reference = input.reference ?? 'secretref:00000000-0000-4000-8000-000000000002';
      secrets.set(reference, { secret: input.secret, binding: input.binding });
      return reference;
    },
    use(reference, binding, consumer) {
      const value = secrets.get(reference);
      assert.deepEqual(value.binding, binding);
      return consumer(value.secret);
    },
    delete(reference) { return secrets.delete(reference); },
  };
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://api.example.invalid/v1/models');
    assert.equal(options.headers.Authorization, 'Bearer provider-fixture-secret');
    return new Response('{"data":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const registry = new ProviderRegistry({ credentials, persist: (providers) => persisted.push(structuredClone(providers)) });
  const provider = registry.save({
    name: 'Fixture OpenAI', kind: 'openai-compatible', baseUrl: 'https://api.example.invalid',
    models: ['fixture-model'], apiKey: 'provider-fixture-secret',
  });
  assert.equal(provider.hasSecret, true);
  assert.doesNotMatch(JSON.stringify(provider), /provider-fixture-secret|secretref:/);
  const result = await registry.test(provider.id);
  assert.deepEqual(result, { ok: true, latencyMs: result.latencyMs, category: 'connected' });
  assert.doesNotMatch(JSON.stringify(registry.list()), /provider-fixture-secret|secretref:/);
  assert.doesNotMatch(JSON.stringify(persisted), /provider-fixture-secret/);
  assert.match(JSON.stringify(persisted), /secretref:/);
});

test('Provider Registry rejects incompatible or unsafe endpoint forms', () => {
  const registry = new ProviderRegistry({ persist: () => undefined });
  assert.throws(() => registry.save({ name: 'Unsafe', kind: 'openai-compatible', baseUrl: 'http://example.com', models: ['x'] }), /HTTPS/);
  assert.throws(() => registry.save({ name: 'Embedded auth', kind: 'anthropic-compatible', baseUrl: 'https://user:pass@example.com', models: ['x'] }), /认证/);
  assert.throws(() => registry.save({ name: 'No models', kind: 'openai-compatible', baseUrl: 'https://example.com', models: [] }), /Model/);
});

test('Anthropic-compatible connection test sends a bounded one-token probe and discards the body', async (t) => {
  const secrets = new Map();
  const credentials = {
    store(input) { const reference = input.reference ?? 'secretref:00000000-0000-4000-8000-000000000004'; secrets.set(reference, { secret: input.secret, binding: input.binding }); return reference; },
    use(reference, binding, consumer) { const value = secrets.get(reference); assert.deepEqual(value.binding, binding); return consumer(value.secret); },
    delete(reference) { return secrets.delete(reference); },
  };
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let bodyCancelled = false;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://anthropic.example.invalid/v1/messages');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['x-api-key'], 'anthropic-fixture-secret');
    assert.deepEqual(JSON.parse(options.body), {
      model: 'fixture-claude', max_tokens: 1, messages: [{ role: 'user', content: 'Reply OK.' }],
    });
    return { ok: true, status: 200, body: { async cancel() { bodyCancelled = true; } } };
  };
  const registry = new ProviderRegistry({ credentials, persist: () => undefined });
  const provider = registry.save({ name: 'Fixture Anthropic', kind: 'anthropic-compatible', baseUrl: 'https://anthropic.example.invalid', models: ['fixture-claude'], apiKey: 'anthropic-fixture-secret' });
  const result = await registry.test(provider.id);
  assert.equal(result.ok, true);
  assert.equal(bodyCancelled, true);
});

test('DeepSeek injects the complete Claude Code model map and discovers remote models safely', async (t) => {
  const secrets = new Map();
  const credentials = {
    store(input) { const reference = input.reference ?? 'secretref:00000000-0000-4000-8000-000000000005'; secrets.set(reference, { secret: input.secret, binding: input.binding }); return reference; },
    use(reference, binding, consumer) { const value = secrets.get(reference); assert.deepEqual(value.binding, binding); return consumer(value.secret); },
    delete(reference) { return secrets.delete(reference); },
  };
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://api.deepseek.com/models');
    assert.equal(options.headers.Authorization, 'Bearer deepseek-fixture-secret');
    return new Response(JSON.stringify({ data: [
      { id: 'deepseek-v4-pro' }, { id: 'deepseek-v4-flash' },
    ] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const registry = new ProviderRegistry({ credentials, persist: () => undefined });
  registry.save({
    id: 'provider:deepseek', name: 'DeepSeek', kind: 'deepseek',
    models: ['deepseek-v4-pro', 'deepseek-v4-flash'], apiKey: 'deepseek-fixture-secret',
  });
  registry.withEnvironment('provider:deepseek', (environment) => {
    assert.equal(environment.ANTHROPIC_AUTH_TOKEN, 'deepseek-fixture-secret');
    assert.equal(environment.ANTHROPIC_MODEL, 'deepseek-v4-pro[1m]');
    assert.equal(environment.ANTHROPIC_DEFAULT_OPUS_MODEL, 'deepseek-v4-pro[1m]');
    assert.equal(environment.ANTHROPIC_DEFAULT_SONNET_MODEL, 'deepseek-v4-pro[1m]');
    assert.equal(environment.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'deepseek-v4-flash');
    assert.equal(environment.CLAUDE_CODE_SUBAGENT_MODEL, 'deepseek-v4-flash');
    assert.equal(environment.CLAUDE_CODE_EFFORT_LEVEL, 'max');
  }, 'deepseek-v4-pro');
  assert.deepEqual(await registry.listModels('provider:deepseek'), {
    models: ['deepseek-v4-pro', 'deepseek-v4-flash'], source: 'remote',
  });
});
