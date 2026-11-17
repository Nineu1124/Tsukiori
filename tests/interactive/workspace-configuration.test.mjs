import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ProviderRegistry } from '../../apps/desktop/dist/electron-main/provider-registry.js';
import { historyFixture, send } from './history-fixture.mjs';
import { readStateJSON, readStorageBytes } from './workspace-fixture-store.mjs';

function rejectConfiguration(userDataPath) {
  const database = new DatabaseSync(join(userDataPath, 'workspace.sqlite'));
  database.exec("CREATE TRIGGER fixture_reject_configuration BEFORE UPDATE ON workspace_header BEGIN SELECT RAISE(ABORT, 'fixture save failure'); END");
  database.close();
  return () => {
    const repair = new DatabaseSync(join(userDataPath, 'workspace.sqlite'));
    try { repair.exec('DROP TRIGGER fixture_reject_configuration'); } finally { repair.close(); }
  };
}

function credentialFixture() {
  const secrets = new Map();
  let serial = 0;
  return { secrets, credentials: {
    store(input) {
      const reference = `secretref:00000000-0000-4000-8000-${String(++serial).padStart(12, '0')}`;
      secrets.set(reference, { secret: input.secret, binding: input.binding });
      return reference;
    },
    use(reference, binding, consumer) {
      const item = secrets.get(reference);
      assert.deepEqual(item.binding, binding);
      return consumer(item.secret);
    },
    delete(reference) { return secrets.delete(reference); },
  } };
}

test('a failed formal settings save keeps both the live snapshot and SQLite at the previous value', async (t) => {
  const f = await historyFixture(t);
  const before = structuredClone(f.workspace.snapshot().settings);
  const restore = rejectConfiguration(f.userDataPath);
  try {
    assert.throws(() => f.workspace.updateSettings({ density: 'compact' }), /存储失败/);
    assert.deepEqual(f.workspace.snapshot().settings, before);
    assert.deepEqual(JSON.parse(readStateJSON(f.userDataPath)).settings, before);
  } finally { restore(); }
  const saved = f.workspace.updateSettings({ density: 'compact' });
  saved.density = 'comfortable';
  assert.equal(f.workspace.snapshot().settings.density, 'compact');
  await f.workspace.shutdown();
  assert.equal(f.open().snapshot().settings.density, 'compact');
  assert.equal(existsSync(join(f.userDataPath, 'workspace-state-v3.json')), false);
});

test('credential rotation publishes only a committed reference and failed saves retain the usable old key', async (t) => {
  const c = credentialFixture();
  const used = [];
  const f = await historyFixture(t, { credentials: c.credentials, apiRuntime: { async runTurn(input) {
    used.push(input.apiKey);
    input.callbacks.onEvent('turn.completed', { turnId: input.turnId, status: 'completed' });
  } } });
  const id = f.session.providerId;
  const before = JSON.parse(readStateJSON(f.userDataPath)).providers.find((item) => item.id === id);
  const restore = rejectConfiguration(f.userDataPath);
  try {
    assert.throws(() => f.workspace.saveProvider({ id, name: 'Changed', kind: 'openai-compatible', apiKey: 'replacement-fixture-value' }), /存储失败/);
    assert.equal(f.workspace.snapshot().providers.find((item) => item.id === id).name, before.name);
    assert.equal(JSON.parse(readStateJSON(f.userDataPath)).providers.find((item) => item.id === id).secretRef, before.secretRef);
    assert.deepEqual([...c.secrets.keys()], [before.secretRef]);
  } finally { restore(); }
  await send(f.workspace, f.session.id, 'old credential remains usable');
  assert.deepEqual(used, ['fixture-value']);
  f.workspace.saveProvider({ id, name: 'Changed', kind: 'openai-compatible', apiKey: 'replacement-fixture-value' });
  const after = JSON.parse(readStateJSON(f.userDataPath)).providers.find((item) => item.id === id);
  assert.notEqual(after.secretRef, before.secretRef);
  assert.deepEqual([...c.secrets.keys()], [after.secretRef]);
  await send(f.workspace, f.session.id, 'new credential is active');
  assert.equal(used.at(-1), 'replacement-fixture-value');
  assert.doesNotMatch(readStorageBytes(f.userDataPath), /replacement-fixture-value|fixture-value/);
  assert.doesNotMatch(JSON.stringify(f.workspace.snapshot().providers), /secretref:|replacement-fixture-value/);
  await f.workspace.shutdown();
  assert.equal(f.open().snapshot().providers.find((item) => item.id === id).name, 'Changed');
});

test('failed provider deletion and creation cannot change active configuration or lose a referenced credential', () => {
  const c = credentialFixture();
  let fail = false;
  let saved;
  const registry = new ProviderRegistry({ credentials: c.credentials,
    persist(providers) { if (fail) throw new Error('fixture persistence failure'); saved = providers; } });
  const provider = registry.save({ name: 'Fixture', kind: 'openai-compatible', baseUrl: 'https://example.invalid', models: ['fixture'], apiKey: 'fixture-value' });
  const before = registry.raw();
  fail = true;
  assert.throws(() => registry.delete(provider.id), /fixture persistence failure/);
  assert.deepEqual(registry.raw(), before);
  assert.equal(registry.withSecret(provider.id, (value) => value), 'fixture-value');
  assert.throws(() => registry.save({ name: 'New', kind: 'openai-compatible', baseUrl: 'https://example.invalid', models: ['fixture'], apiKey: 'new-fixture-value' }), /fixture persistence failure/);
  assert.deepEqual(registry.raw(), before);
  assert.deepEqual(saved, before);
  assert.equal(c.secrets.size, 1);
  fail = false;
  registry.delete(provider.id);
  assert.equal(c.secrets.size, 0);
});

test('Provider views and lookup results cannot mutate the authoritative configuration', () => {
  const registry = new ProviderRegistry({ persist() {} });
  const original = registry.raw();
  registry.list()[0].models.push('changed');
  registry.get(original[0].id).models.length = 0;
  registry.raw()[0].name = 'changed';
  assert.deepEqual(registry.raw(), original);
});

test('a delayed verification result cannot overwrite a newer Provider configuration', async () => {
  const c = credentialFixture();
  let finish;
  const registry = new ProviderRegistry({ credentials: c.credentials, persist() {},
    verify: () => new Promise((resolve) => { finish = resolve; }) });
  const provider = registry.save({ name: 'Old', kind: 'openai-compatible', baseUrl: 'https://old.example.invalid', models: ['fixture'], apiKey: 'fixture-value' });
  const pending = registry.test(provider.id);
  registry.save({ id: provider.id, name: 'New', kind: 'openai-compatible', baseUrl: 'https://new.example.invalid' });
  finish({ ok: true, category: 'connected' });
  await pending;
  assert.equal(registry.get(provider.id).baseUrl, 'https://new.example.invalid');
  assert.equal(registry.get(provider.id).lastTest, undefined);
});
