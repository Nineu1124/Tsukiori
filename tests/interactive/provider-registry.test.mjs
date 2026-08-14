import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const { ProviderRegistry } = await import(
  new URL('../../apps/desktop/dist/electron-main/provider-registry.js', import.meta.url)
);
const { ProviderVerificationAuditStore } = await import(
  new URL('../../apps/desktop/dist/electron-main/provider-verification-audit.js', import.meta.url)
);

test('Provider Registry tests a connection without exposing or persisting the secret', async () => {
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
  const audits = [];
  const registry = new ProviderRegistry({
    credentials,
    persist: (providers) => persisted.push(structuredClone(providers)),
    audit: (record) => audits.push(structuredClone(record)),
    verify: async (provider, secret) => {
      assert.equal(provider.baseUrl, 'https://api.example.invalid');
      assert.equal(provider.apiFormat, 'openai-completions');
      assert.equal(secret, 'provider-fixture-secret');
      return { ok: true, category: 'connected' };
    },
    now: () => 1_800_200_000_000,
    id: () => 'fixture-audit-id',
  });
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
  assert.deepEqual(audits, [{
    schemaVersion: 1,
    id: 'provider-audit:fixture-audit-id',
    action: 'provider_verify',
    providerId: provider.id,
    providerKind: 'openai-compatible',
    outcome: 'succeeded',
    category: 'connected',
    latencyMs: 0,
    testedAt: 1_800_200_000_000,
  }]);
  assert.equal(registry.list().find((item) => item.id === provider.id).lastTest.testedAt, audits[0].testedAt);
  assert.equal(registry.list().find((item) => item.id === provider.id).lastTest.auditStatus, 'recorded');
});

test('Provider verification failures are audited and missing credentials are observable', async () => {
  const audits = [];
  const registry = new ProviderRegistry({
    persist: () => undefined,
    audit: (record) => audits.push(structuredClone(record)),
    now: () => 1_800_200_000_100,
    id: () => 'fixture-failed-audit-id',
  });
  const result = await registry.test('provider:deepseek');
  assert.deepEqual(result, { ok: false, latencyMs: 0, category: 'credential_required' });
  assert.equal(audits[0].outcome, 'failed');
  assert.equal(audits[0].category, 'credential_required');
  assert.equal(audits[0].testedAt, registry.get('provider:deepseek').lastTest.testedAt);
});

test('Provider success remains distinct from a degraded audit sink', async () => {
  const persisted = [];
  const registry = new ProviderRegistry({
    persist: (providers) => persisted.push(structuredClone(providers)),
    audit: () => { throw new Error('fixture audit disk failure'); },
    now: () => 1_800_200_000_200,
  });
  registry.recordTest('provider:chatgpt', { ok: true, latencyMs: 7, category: 'runtime_auth' });
  const lastTest = registry.get('provider:chatgpt').lastTest;
  assert.equal(lastTest.ok, true);
  assert.equal(lastTest.auditStatus, 'degraded');
  assert.equal(lastTest.auditCategory, 'audit_write_failed');
  assert.doesNotMatch(JSON.stringify(persisted), /fixture audit disk failure/);
});

test('Provider Audit Store persists only its bounded allowlisted projection', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tsukiori-provider-audit-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new ProviderVerificationAuditStore(directory);
  store.record({
    schemaVersion: 1,
    id: 'provider-audit:fixture-store-id',
    action: 'provider_verify',
    providerId: 'provider:deepseek',
    providerKind: 'deepseek',
    outcome: 'failed',
    category: 'authentication_failed',
    latencyMs: 42,
    testedAt: 1_800_200_000_300,
    secret: 'must-not-be-written',
    request: { prompt: 'must-not-be-written' },
  });
  const reopened = new ProviderVerificationAuditStore(directory);
  assert.deepEqual(reopened.list(), [{
    schemaVersion: 1,
    id: 'provider-audit:fixture-store-id',
    action: 'provider_verify',
    providerId: 'provider:deepseek',
    providerKind: 'deepseek',
    outcome: 'failed',
    category: 'authentication_failed',
    latencyMs: 42,
    testedAt: 1_800_200_000_300,
  }]);
  const serialized = readFileSync(join(directory, 'provider-verification-audit-v1.json'), 'utf8');
  assert.doesNotMatch(serialized, /must-not-be-written|prompt|request|secret/);
});

test('Provider Registry rejects incompatible or unsafe endpoint forms', () => {
  const registry = new ProviderRegistry({ persist: () => undefined });
  assert.throws(() => registry.save({ name: 'Unsafe', kind: 'openai-compatible', baseUrl: 'http://example.com', models: ['x'] }), /HTTPS/);
  assert.throws(() => registry.save({ name: 'Embedded auth', kind: 'anthropic-compatible', baseUrl: 'https://user:pass@example.com', models: ['x'] }), /认证/);
  assert.throws(() => registry.save({ name: 'No models', kind: 'openai-compatible', baseUrl: 'https://example.com', models: [] }), /Model/);
});

test('Claude native login is a built-in secretless Provider mode', async () => {
  const persisted = [];
  const registry = new ProviderRegistry({ persist: (providers) => persisted.push(structuredClone(providers)) });
  const provider = registry.list().find((item) => item.id === 'provider:claude-native');
  assert.equal(provider.kind, 'claude-native');
  assert.equal(provider.hasSecret, false);
  assert.deepEqual(provider.models, ['sonnet', 'opus']);
  assert.deepEqual(await registry.listModels(provider.id), { models: ['sonnet', 'opus'], source: 'configured' });
  assert.throws(() => registry.delete(provider.id), /不能删除/);
  assert.doesNotMatch(JSON.stringify(persisted), /api.key|secretref:/i);
});

test('Anthropic-compatible connection test routes through the unified direct API verifier', async () => {
  const secrets = new Map();
  const credentials = {
    store(input) { const reference = input.reference ?? 'secretref:00000000-0000-4000-8000-000000000004'; secrets.set(reference, { secret: input.secret, binding: input.binding }); return reference; },
    use(reference, binding, consumer) { const value = secrets.get(reference); assert.deepEqual(value.binding, binding); return consumer(value.secret); },
    delete(reference) { return secrets.delete(reference); },
  };
  let verified = false;
  const registry = new ProviderRegistry({
    credentials,
    persist: () => undefined,
    verify: async (provider, secret) => {
      assert.equal(provider.apiFormat, 'anthropic-messages');
      assert.equal(provider.baseUrl, 'https://anthropic.example.invalid');
      assert.deepEqual(provider.models, ['fixture-claude']);
      assert.equal(secret, 'anthropic-fixture-secret');
      verified = true;
      return { ok: true, category: 'connected' };
    },
  });
  const provider = registry.save({ name: 'Fixture Anthropic', kind: 'anthropic-compatible', apiFormat: 'anthropic-messages', baseUrl: 'https://anthropic.example.invalid', models: ['fixture-claude'], apiKey: 'anthropic-fixture-secret' });
  const result = await registry.test(provider.id);
  assert.equal(result.ok, true);
  assert.equal(verified, true);
});

test('DeepSeek injects the complete Claude Code model map and exposes the locked model catalog', async () => {
  const secrets = new Map();
  const credentials = {
    store(input) { const reference = input.reference ?? 'secretref:00000000-0000-4000-8000-000000000005'; secrets.set(reference, { secret: input.secret, binding: input.binding }); return reference; },
    use(reference, binding, consumer) { const value = secrets.get(reference); assert.deepEqual(value.binding, binding); return consumer(value.secret); },
    delete(reference) { return secrets.delete(reference); },
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
    assert.equal(Object.hasOwn(environment, 'CLAUDE_CODE_EFFORT_LEVEL'), false);
  }, 'deepseek-v4-pro');
  const catalog = await registry.listModels('provider:deepseek');
  assert.equal(catalog.source, 'catalog');
  assert.deepEqual([...catalog.models].sort(), ['deepseek-v4-flash', 'deepseek-v4-pro']);
});
