import assert from 'node:assert/strict';
import test from 'node:test';
import { historyFixture, assistant, send } from './history-fixture.mjs';
import { codexHistoryFixture } from './codex-history-fixture.mjs';
import { readConversationLines } from './workspace-fixture-store.mjs';

test('stable event replay does not duplicate the UI, model history, durable rows or event cursor', async (t) => {
  const f = await historyFixture(t);
  const identity = { id: 'source:event-one', createdAt: 123 };
  f.workspace.publishLocalEvent(f.session.id, 'user.message', { text: 'one durable fixture', nested: { b: 2, a: 1 } }, identity);
  const cursor = f.workspace.pollEvents(0).cursor;
  f.workspace.publishLocalEvent(f.session.id, 'user.message', { nested: { a: 1, b: 2 }, text: 'one durable fixture' }, identity);
  assert.equal(f.workspace.pollEvents(0).cursor, cursor);
  assert.equal(readConversationLines(f.userDataPath, f.session.id).map(JSON.parse).filter((event) => event.id === identity.id).length, 1);
  assert.equal(f.workspace.pollEvents(0).events.filter((event) => event.id === identity.id).length, 1);
  assert.throws(() => f.workspace.publishLocalEvent(f.session.id, 'user.message', { text: 'conflicting fixture' }, identity), /存储失败/);
  assert.equal(f.workspace.pollEvents(0).cursor, cursor);
  await send(f.workspace, f.session.id, 'check complete model history');
  assert.equal(f.histories[0].filter((message) => message.content === 'one durable fixture').length, 1);
});

test('a replay older than the UI and identity cache remains idempotent after restart', async (t) => {
  const f = await historyFixture(t);
  const identity = { id: 'source:earliest', createdAt: 1 };
  f.workspace.publishLocalEvent(f.session.id, 'user.message', { text: 'earliest fixture' }, identity);
  for (let i = 0; i < 2100; i++) f.workspace.publishLocalEvent(f.session.id, 'assistant.delta', { text: '.' });
  const before = readConversationLines(f.userDataPath, f.session.id).length;
  f.workspace.publishLocalEvent(f.session.id, 'user.message', { text: 'earliest fixture' }, identity);
  assert.equal(readConversationLines(f.userDataPath, f.session.id).length, before);
  await f.workspace.shutdown();
  const restarted = f.open();
  const cursor = restarted.pollEvents(0).cursor;
  restarted.publishLocalEvent(f.session.id, 'user.message', { text: 'earliest fixture' }, identity);
  assert.equal(restarted.pollEvents(0).cursor, cursor);
  assert.equal(readConversationLines(f.userDataPath, f.session.id).length, before);
  await send(restarted, f.session.id, 'after restart');
  assert.equal(f.histories.at(-1).filter((message) => message.content === 'earliest fixture').length, 1);
});

test('unidentified equal deltas remain distinct and memory-only stable duplicates are suppressed', async (t) => {
  const f = await historyFixture(t);
  f.workspace.updateSettings({ persistConversation: false });
  f.workspace.publishLocalEvent(f.session.id, 'assistant.delta', { text: 'same' });
  f.workspace.publishLocalEvent(f.session.id, 'assistant.delta', { text: 'same' });
  assert.equal(f.workspace.pollEvents(0).events.filter((event) => event.payload.text === 'same').length, 2);
  const identity = { id: 'memory:stable', createdAt: 2 };
  f.workspace.publishLocalEvent(f.session.id, 'user.message', { text: 'memory fixture' }, identity);
  f.workspace.publishLocalEvent(f.session.id, 'user.message', { text: 'memory fixture' }, identity);
  assert.equal(f.workspace.pollEvents(0).events.filter((event) => event.id === identity.id).length, 1);
  assert.equal(readConversationLines(f.userDataPath, f.session.id).some((line) => line.includes('memory fixture')), false);
});

test('duplicate and old Codex completion cannot finish a newer active Turn or duplicate completion records', async (t) => {
  const f = await codexHistoryFixture(t);
  const first = await f.workspace.sendPrompt(f.session.id, 'first');
  const client = f.clients.at(-1);
  client.complete(first.turnId);
  const count = readConversationLines(f.userDataPath, f.session.id).map(JSON.parse).filter((event) => event.type === 'turn.completed').length;
  client.complete(first.turnId);
  assert.equal(readConversationLines(f.userDataPath, f.session.id).map(JSON.parse).filter((event) => event.type === 'turn.completed').length, count);
  const second = await f.workspace.sendPrompt(f.session.id, 'second');
  client.complete(first.turnId);
  assert.equal(f.workspace.snapshot().sessions.find((item) => item.id === f.session.id).status, 'running');
  await f.workspace.interrupt(f.session.id);
  assert.equal(f.calls.at(-1)[3], second.turnId);
});

test('duplicate complete API messages are stored and restored only once', async (t) => {
  const f = await historyFixture(t, { apiRuntime: { async runTurn(input) {
    const payload = { message: assistant('single complete fixture') };
    input.callbacks.onEvent('api.assistant.message', payload);
    input.callbacks.onEvent('api.assistant.message', structuredClone(payload));
    input.callbacks.onEvent('turn.completed', { turnId: input.turnId, status: 'completed' });
  } } });
  await send(f.workspace, f.session.id, 'first');
  const events = readConversationLines(f.userDataPath, f.session.id).map(JSON.parse);
  assert.equal(events.filter((event) => event.type === 'api.assistant.message').length, 1);
  assert.equal(f.workspace.pollEvents(0).events.filter((event) => event.type === 'api.assistant.message').length, 1);
});

test('late API failure and cleanup retain the next Turn status and its own cancellation controller', async (t) => {
  const runs = [];
  const f = await historyFixture(t, { apiRuntime: { runTurn(input) {
    let reject;
    const promise = new Promise((_, fail) => { reject = fail; });
    runs.push({ input, reject });
    return promise;
  } } });
  await f.workspace.sendPrompt(f.session.id, 'first');
  runs[0].input.callbacks.onEvent('turn.completed', { turnId: runs[0].input.turnId, status: 'completed' });
  await f.workspace.sendPrompt(f.session.id, 'second');
  runs[0].reject(new Error('late private fixture failure'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.workspace.snapshot().sessions[0].status, 'running');
  assert.equal(f.workspace.pollEvents(0).events.some((event) => event.type === 'runtime.error'), false);
  await f.workspace.interrupt(f.session.id);
  assert.equal(runs[1].input.signal.aborted, true);
  runs[1].reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
  await new Promise((resolve) => setImmediate(resolve));
});
