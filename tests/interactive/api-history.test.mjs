import assert from 'node:assert/strict';
import test from 'node:test';
import { readApiHistory } from '../../apps/desktop/dist/electron-main/api-runtime.js';
import { historyFixture, send } from './history-fixture.mjs';

test('UI event eviction does not remove API messages or expose mutable history', async (t) => {
  const f = await historyFixture(t);
  f.workspace.updateSettings({ persistConversation: false });
  await send(f.workspace, f.session.id, 'first complete message');
  for (let i = 0; i < 1_100; i++) f.workspace.publishLocalEvent(f.session.id, 'assistant.delta', { text: '.' });
  await send(f.workspace, f.session.id, 'second complete message');
  assert.deepEqual(f.histories[1].map((m) => m.role), ['user', 'assistant', 'user']);
  assert.equal(f.histories[1][0].content, 'first complete message');
  assert.equal(f.workspace.pollEvents(0).events.length <= 1_000, true);
  assert.equal(f.workspace.pollEvents(0).events.some((e) => e.payload.text === 'first complete message'), false);
});

test('history parsing keeps more than 100 complete messages and ignores UI deltas', () => {
  const events = Array.from({ length: 125 }, (_, i) => ({ type: 'user.message', createdAt: i, payload: { text: `message ${i}` } }));
  events.push({ type: 'assistant.delta', createdAt: 126, payload: { text: 'partial' } });
  const messages = readApiHistory(events);
  assert.equal(messages.length, 125);
  assert.equal(messages[0].content, 'message 0');
  assert.equal(messages.at(-1).content, 'message 124');
});
