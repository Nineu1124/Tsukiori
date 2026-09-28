import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { readTranscriptLines } from '../../apps/desktop/dist/electron-main/transcript-store.js';
import { historyFixture, send } from './history-fixture.mjs';

const content = (messages) => messages.map((message) => ({ role: message.role, content: message.content }));
const transcriptPath = (f) => join(f.userDataPath, 'transcripts', createHash('sha256').update(f.session.id).digest('hex') + '.jsonl');

test('over 1100 deltas and 8 MiB preserve identical API history before and after restart', async (t) => {
  const f = await historyFixture(t);
  await send(f.workspace, f.session.id, 'earliest complete fixture');
  for (let i = 0; i < 1_100; i++) f.workspace.publishLocalEvent(f.session.id, 'assistant.delta', { text: 'x'.repeat(8_192) });
  await send(f.workspace, f.session.id, 'before restart');
  const expected = content(f.histories[1]);
  expected.push({ role: 'assistant', content: [{ type: 'text', text: 'fixture answer' }] });
  assert.equal(readdirSync(join(f.userDataPath, 'transcripts')).reduce((bytes, name) => bytes + statSync(join(f.userDataPath, 'transcripts', name)).size, 0) > 8 * 1024 * 1024, true);
  assert.equal([...readTranscriptLines(transcriptPath(f))].filter((line) => JSON.parse(line).type === 'assistant.delta').length, 1_100);
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
  appendFileSync(transcriptPath(f), '{"partial":');
  const bytes = readFileSync(transcriptPath(f));
  const damaged = f.open();
  await assert.rejects(send(damaged, f.session.id, 'must not continue'), /会话记录不完整/);
  assert.deepEqual(readFileSync(transcriptPath(f)), bytes);
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
