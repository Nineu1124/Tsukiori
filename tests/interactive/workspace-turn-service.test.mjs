import assert from 'node:assert/strict';
import test from 'node:test';
import { historyFixture } from './history-fixture.mjs';
import { codexHistoryFixture } from './codex-history-fixture.mjs';

test('formal Codex sends are exclusive while the shared client is still initializing', async (t) => {
  const f = await codexHistoryFixture(t);
  let release;
  f.control.start = () => new Promise((resolve) => { release = resolve; });
  const first = f.workspace.sendPrompt(f.session.id, 'first fixture');
  await assert.rejects(f.workspace.sendPrompt(f.session.id, 'concurrent fixture'), /当前 Turn 尚未结束/);
  assert.equal(f.clients.length, 1);
  assert.equal(f.calls.some((call) => call[1] === 'turn/start'), false);
  assert.deepEqual(f.emitted.filter((event) => event.type === 'user.message').map((event) => event.payload.text), ['first fixture']);
  release();
  const active = await first;
  assert.equal(f.calls.filter((call) => call[1] === 'turn/start').length, 1);
  await f.workspace.interrupt(f.session.id);
  assert.deepEqual(f.calls.find((call) => call[1] === 'turn/interrupt'), [0, 'turn/interrupt', 'thread:fixture', active.turnId]);
  assert.equal(f.workspace.snapshot().sessions.find((session) => session.id === f.session.id).status, 'ready');
});

test('formal API cancellation uses the active controller and preserves complete independent history', async (t) => {
  const inputs = [];
  const histories = [];
  const f = await historyFixture(t, { apiRuntime: { async runTurn(input) {
    inputs.push(input);
    histories.push(structuredClone(input.history));
    input.history[0].content = 'runtime mutation';
    input.callbacks.onEvent('turn.started', { turnId: input.turnId });
    await new Promise((_, reject) => input.signal.addEventListener('abort', () => reject(new Error('private aborted provider text')), { once: true }));
  } } });
  const first = await f.workspace.sendPrompt(f.session.id, 'first API fixture');
  await assert.rejects(f.workspace.sendPrompt(f.session.id, 'overlapping API fixture'), /当前 Turn 尚未结束/);
  assert.equal(inputs.length, 1);
  await f.workspace.interrupt(f.session.id);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(inputs[0].signal.aborted, true);
  assert.equal(f.workspace.snapshot().sessions.find((session) => session.id === f.session.id).status, 'ready');
  const completed = f.emitted.find((event) => event.type === 'turn.completed' && event.payload.turnId === first.turnId);
  assert.equal(completed.payload.status, 'interrupted');
  await assert.rejects(f.workspace.interrupt(f.session.id), /没有可中断/);
  const next = await f.workspace.sendPrompt(f.session.id, 'second API fixture');
  assert.notEqual(next.turnId, first.turnId);
  assert.deepEqual(histories[1].map((message) => message.content), ['first API fixture', 'second API fixture']);
  assert.equal(inputs[1].signal.aborted, false);
  await f.workspace.interrupt(f.session.id);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(inputs[1].signal.aborted, true);
  assert.doesNotMatch(JSON.stringify(f.emitted), /private aborted provider text|runtime mutation|overlapping API fixture/);
});

test('formal Turn service restores a Codex thread before sending and interrupts that same identity', async (t) => {
  const f = await codexHistoryFixture(t);
  const first = await f.workspace.sendPrompt(f.session.id, 'before restart fixture');
  f.clients[0].complete(first.turnId);
  await f.workspace.shutdown();
  const restarted = f.open();
  const second = await restarted.sendPrompt(f.session.id, 'after restart fixture');
  await restarted.interrupt(f.session.id);
  assert.deepEqual(f.calls.filter((call) => call[0] === 1), [
    [1, 'initialize'], [1, 'thread/resume', 'thread:fixture'],
    [1, 'turn/start', 'thread:fixture', second.turnId],
    [1, 'turn/interrupt', 'thread:fixture', second.turnId],
  ]);
  const session = restarted.snapshot().sessions.find((item) => item.id === f.session.id);
  assert.equal(session.threadId, 'thread:fixture');
  assert.equal(session.turnCount, 2);
  assert.equal(session.status, 'ready');
});

test('invalid prompts and incomplete transcripts never reach a Runtime or append a user message', async (t) => {
  const f = await historyFixture(t);
  const before = f.emitted.length;
  for (const text of ['   ', 'x'.repeat(64_001)]) await assert.rejects(f.workspace.sendPrompt(f.session.id, text), /1–64000/);
  f.session.transcriptIncomplete = true;
  await assert.rejects(f.workspace.sendPrompt(f.session.id, 'blocked fixture'), /会话记录不完整/);
  assert.equal(f.histories.length, 0);
  assert.equal(f.emitted.length, before);
  assert.equal(f.session.turnCount, 0);
});
