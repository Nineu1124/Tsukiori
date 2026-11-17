import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { WorkspaceStateWriter } from '../../apps/desktop/dist/electron-main/workspace-state-writer.js';
import { SqliteWorkspaceRepository } from '../../apps/desktop/dist/electron-main/workspace-state-repository.js';
import { historyFixture } from './history-fixture.mjs';
import { readConversationLines, readStateJSON } from './workspace-fixture-store.mjs';
import { commandHarness } from './workspace-command-harness.mjs';

function deferredRuntime() {
  const calls = [];
  return { calls, runtime: { runTurn(input) {
    let finish;
    const promise = new Promise((resolve) => { finish = resolve; });
    const call = { input, finish };
    calls.push(call);
    input.signal.addEventListener('abort', () => {
      setTimeout(() => {
        input.callbacks.onEvent('assistant.delta', { text: 'final exit fixture' });
        finish();
      }, 15);
    }, { once: true });
    return promise;
  } } };
}

function rejectState(userDataPath) {
  const path = join(userDataPath, 'workspace.sqlite');
  const database = new DatabaseSync(path);
  database.exec("CREATE TRIGGER fixture_reject_state BEFORE UPDATE ON workspace_header BEGIN SELECT RAISE(ABORT, 'fixture state failure'); END");
  database.close();
  return () => {
    const repair = new DatabaseSync(path);
    try { repair.exec('DROP TRIGGER fixture_reject_state'); } finally { repair.close(); }
  };
}

test('a metadata burst produces one delayed write of the latest state', async () => {
  const writes = [];
  let current = 0;
  const writer = new WorkspaceStateWriter({ delayMs: 15, snapshot: () => ({ current }), write: (value) => writes.push(value) });
  for (let i = 1; i <= 200; i++) { current = i; writer.schedule(); }
  assert.equal(writes.length, 0);
  await delay(40);
  assert.deepEqual(writes, [{ current: 200 }]);
  assert.equal(writer.pending, false);
  writer.close();
});

test('continuous updates do not postpone the first flush indefinitely', async () => {
  let writes = 0;
  const writer = new WorkspaceStateWriter({ delayMs: 10, snapshot: () => writes, write() { writes++; } });
  writer.schedule();
  const timer = setInterval(() => writer.schedule(), 2);
  try { await delay(35); assert.ok(writes > 0); }
  finally { clearInterval(timer); writer.close(); }
});

test('a rejected explicit candidate is never silently retried during close', () => {
  const writes = [];
  let fail = true;
  const writer = new WorkspaceStateWriter({ snapshot: () => 'confirmed', write(value) {
    if (fail) throw new Error('fixture failure'); writes.push(value);
  } });
  assert.throws(() => writer.write('unconfirmed candidate'), /fixture failure/);
  fail = false;
  writer.close();
  assert.deepEqual(writes, []);
});

test('shutdown cancels an overdue timer and retains later updates for the final flush', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const writes = [];
  let current = 'before exit';
  const writer = new WorkspaceStateWriter({ delayMs: 10, snapshot: () => current, write: (value) => writes.push(value) });
  writer.schedule();
  writer.beginShutdown();
  current = 'last Runtime callback';
  writer.schedule();
  t.mock.timers.tick(1000);
  assert.deepEqual(writes, []);
  assert.equal(writer.pending, true);
  writer.close();
  assert.deepEqual(writes, ['last Runtime callback']);
  assert.equal(writer.pending, false);
});

test('formal API deltas commit their records immediately while aggregate state writes are coalesced through exit', async (t) => {
  const runtime = deferredRuntime();
  const f = await historyFixture(t, { apiRuntime: runtime.runtime, stateSaveDelayMs: 1000 });
  await f.workspace.sendPrompt(f.session.id, 'confirmed before exit');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const original = SqliteWorkspaceRepository.prototype.save;
  let writes = 0;
  t.mock.method(SqliteWorkspaceRepository.prototype, 'save', function (state) { writes++; return original.call(this, state); });
  for (let i = 0; i < 200; i++) runtime.calls[0].input.callbacks.onEvent('assistant.delta', { text: 'delta fixture' });
  assert.equal(writes, 0);
  assert.equal(readConversationLines(f.userDataPath, f.session.id).map(JSON.parse).filter((event) => event.type === 'assistant.delta').length, 200);
  const shutdown = f.workspace.shutdown();
  // Simulate a slow CI runner advancing beyond the coalescing window while
  // Runtime cancellation finishes. Only the final state may be flushed here.
  t.mock.timers.tick(2000);
  await shutdown;
  assert.equal(writes, 1);
  assert.equal(JSON.parse(readStateJSON(f.userDataPath)).sessions[0].status, 'stopped');
  assert.equal(readConversationLines(f.userDataPath, f.session.id).some((row) => row.includes('final exit fixture')), true);
  const restarted = f.open();
  assert.equal(restarted.snapshot().sessions[0].id, f.session.id);
});

test('a failed timer retains pending state, reports once, and recovers only after a successful write', async (t) => {
  const runtime = deferredRuntime();
  const f = await historyFixture(t, { apiRuntime: runtime.runtime, stateSaveDelayMs: 10 });
  await f.workspace.sendPrompt(f.session.id, 'confirmed fixture');
  const repair = rejectState(f.userDataPath);
  runtime.calls[0].input.callbacks.onEvent('assistant.delta', { text: 'confirmed event despite metadata failure' });
  await delay(35);
  assert.equal(f.workspace.snapshot().storageFailure.code, 'state_write_failed');
  for (let i = 0; i < 10; i++) runtime.calls[0].input.callbacks.onEvent('assistant.delta', { text: 'later delta' });
  assert.equal(f.emitted.filter((event) => event.type === 'workspace.storage_failed').length, 1);
  assert.equal(readConversationLines(f.userDataPath, f.session.id).some((row) => row.includes('confirmed event despite metadata failure')), true);
  repair();
  f.workspace.updateSettings({ density: 'compact' });
  assert.equal(f.workspace.snapshot().storageFailure, undefined);
  assert.equal(f.emitted.filter((event) => event.type === 'workspace.storage_recovered').length, 1);
  runtime.calls[0].input.callbacks.onEvent('turn.completed', { turnId: runtime.calls[0].input.turnId, status: 'completed' });
  runtime.calls[0].finish();
});

test('failed exit flush rejects while preserving confirmed records and releasing ownership', async (t) => {
  const runtime = deferredRuntime();
  const f = await historyFixture(t, { apiRuntime: runtime.runtime, stateSaveDelayMs: 1000 });
  await f.workspace.sendPrompt(f.session.id, 'confirmed exit fixture');
  const repair = rejectState(f.userDataPath);
  runtime.calls[0].input.callbacks.onEvent('assistant.delta', { text: 'confirmed event fixture' });
  await assert.rejects(f.workspace.shutdown(), /存储失败/);
  assert.equal(readConversationLines(f.userDataPath, f.session.id).some((row) => row.includes('confirmed event fixture')), true);
  repair();
  const restarted = f.open();
  assert.equal(restarted.snapshot().sessions[0].id, f.session.id);
  assert.equal(readConversationLines(f.userDataPath, f.session.id).some((row) => row.includes('confirmed exit fixture')), true);
});

test('uncooperative API shutdown is bounded and late callbacks cannot write after close', async (t) => {
  let input;
  const f = await historyFixture(t, { shutdownTimeoutMs: 30, apiRuntime: { runTurn(value) { input = value; return new Promise(() => {}); } } });
  await f.workspace.sendPrompt(f.session.id, 'bounded exit fixture');
  await assert.rejects(f.workspace.shutdown(), /运行结果未能确认/);
  const before = readConversationLines(f.userDataPath, f.session.id).length;
  input.callbacks.onEvent('assistant.delta', { text: 'late unconfirmed data' });
  assert.equal(readConversationLines(f.userDataPath, f.session.id).length, before);
});

test('shutdown rejects a new Turn and Main refuses commands while exit cleanup is pending', async (t) => {
  const runtime = deferredRuntime();
  const f = await historyFixture(t, { apiRuntime: runtime.runtime });
  await f.workspace.sendPrompt(f.session.id, 'first confirmed fixture');
  const pending = f.workspace.shutdown();
  await assert.rejects(f.workspace.sendPrompt(f.session.id, 'must not start while closing'), /正在退出/);
  await pending;
  assert.equal(runtime.calls.length, 1);
  assert.equal(readConversationLines(f.userDataPath, f.session.id).some((row) => row.includes('must not start while closing')), false);
  let calls = 0;
  const harness = commandHarness({ sendPrompt() { calls++; } });
  harness.context.quitting = true;
  const result = await harness.invoke({ type: 'send_prompt', sessionId: f.session.id, text: 'late IPC fixture' });
  assert.equal(result.code, 'workspace_closing');
  assert.equal(calls, 0);
});
