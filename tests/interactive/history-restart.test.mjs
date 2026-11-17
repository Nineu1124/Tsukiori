import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { readConversationLines } from './workspace-fixture-store.mjs';
import { WorkspaceSqliteStore } from '../../apps/desktop/dist/electron-main/workspace-sqlite.js';
import { join } from 'node:path';
import test from 'node:test';
import { historyFixture, send } from './history-fixture.mjs';

const content = (messages) => messages.map((message) => ({ role: message.role, content: message.content }));

test('over 1100 deltas and 8 MiB preserve identical API history before and after restart', async (t) => {
  const f = await historyFixture(t);
  await send(f.workspace, f.session.id, 'earliest complete fixture');
  for (let i = 0; i < 1_100; i++) f.workspace.publishLocalEvent(f.session.id, 'assistant.delta', { text: 'x'.repeat(8_192) });
  await send(f.workspace, f.session.id, 'before restart');
  const expected = content(f.histories[1]);
  expected.push({ role: 'assistant', content: [{ type: 'text', text: 'fixture answer' }] });
  const rows = readConversationLines(f.userDataPath, f.session.id);
  assert.equal(rows.reduce((bytes, row) => bytes + Buffer.byteLength(row), 0) > 8 * 1024 * 1024, true);
  assert.equal(rows.filter((line) => JSON.parse(line).type === 'assistant.delta').length, 1_100);
  assert.deepEqual(readdirSync(join(f.userDataPath, 'transcripts')), []);
  assert.throws(() => f.workspace.createCheckpoint(f.session.id, 'too large'), /8 MiB/);
  await f.workspace.shutdown();
  const restarted = f.open();
  await send(restarted, f.session.id, 'after restart');
  assert.deepEqual(content(f.histories[2].slice(0, -1)), expected);
  assert.equal(f.histories[2][0].content, 'earliest complete fixture');
  assert.equal(restarted.pollEvents(0).events.length <= 1_000, true);
  assert.equal(f.histories[2].some((message) => typeof message.content === 'string' && message.content.startsWith('xxxxx')), false);
});

test('more than 100 full messages survive a disk round trip', async (t) => {
  const f = await historyFixture(t);
  for (let i = 0; i < 55; i++) await send(f.workspace, f.session.id, `complete fixture ${i}`);
  assert.equal(f.histories.at(-1).length, 109);
  await f.workspace.shutdown();
  const restarted = f.open();
  await send(restarted, f.session.id, 'after 55 turns');
  assert.equal(f.histories.at(-1).length, 111);
  assert.deepEqual(f.histories.at(-1).filter((m) => m.role === 'user').map((m) => m.content),
    [...Array.from({ length: 55 }, (_, i) => `complete fixture ${i}`), 'after 55 turns']);
});

test('unsaved messages stay memory-only and corrupt rows block incomplete restart history', async (t) => {
  const f = await historyFixture(t);
  f.workspace.updateSettings({ persistConversation: false });
  await send(f.workspace, f.session.id, 'memory-only fixture');
  await f.workspace.shutdown();
  const restarted = f.open();
  await send(restarted, f.session.id, 'new memory-only fixture');
  assert.equal(f.histories.at(-1).length, 1);
  await restarted.shutdown();
  const path = join(f.userDataPath, 'workspace.sqlite');
  const store = new WorkspaceSqliteStore(path);
  store.appendEvent(f.session.id, JSON.stringify({ id: 'damaged', sessionId: f.session.id, schemaVersion: 1, type: 'user.message', createdAt: 1, payload: { text: 'future record' } }));
  store.close();
  const database = new DatabaseSync(path);
  database.prepare("UPDATE workspace_events SET payload = json_set(payload, '$.schemaVersion', 2) WHERE event_id = 'damaged'").run();
  const bytes = database.prepare("SELECT payload FROM workspace_events WHERE event_id = 'damaged'").get().payload;
  database.close();
  const damaged = f.open();
  await assert.rejects(send(damaged, f.session.id, 'must not continue'), /会话记录不完整/);
  const inspection = new DatabaseSync(path);
  try { assert.equal(inspection.prepare("SELECT payload FROM workspace_events WHERE event_id = 'damaged'").get().payload, bytes); } finally { inspection.close(); }
});

test('forking after UI eviction preserves full API history through another restart', async (t) => {
  const f = await historyFixture(t);
  await send(f.workspace, f.session.id, 'fork source fixture');
  for (let i = 0; i < 510; i++) f.workspace.publishLocalEvent(f.session.id, 'assistant.delta', { text: '.' });
  const fork = await f.workspace.forkSession(f.session.id);
  await send(f.workspace, fork.id, 'fork continuation');
  assert.deepEqual(f.histories.at(-1).map((m) => m.role), ['user', 'assistant', 'user']);
  assert.equal(f.histories.at(-1)[0].content, 'fork source fixture');
  await f.workspace.shutdown();
  const restarted = f.open();
  await send(restarted, fork.id, 'fork after restart');
  assert.equal(f.histories.at(-1).length, 5);
  assert.equal(f.histories.at(-1)[0].content, 'fork source fixture');
});
