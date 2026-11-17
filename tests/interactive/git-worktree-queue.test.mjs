import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { GitWorktreeQueue } from '../../apps/desktop/dist/electron-main/git-worktree-queue.js';
import { GitExecutor, GitCommandError } from '../../apps/desktop/dist/electron-main/git-executor.js';
import { historyFixture } from './history-fixture.mjs';
import { commandHarness } from './workspace-command-harness.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'tsukiori-git-queue-'));
  const first = join(root, 'first');
  const second = join(root, 'second');
  mkdirSync(first); mkdirSync(second);
  const queue = new GitWorktreeQueue();
  t.after(async () => { await queue.shutdown(); rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); });
  return { root, first, second, queue };
}

function gate() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { release, wait(signal) {
    return Promise.race([promise, new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('gate cancelled')), { once: true });
    })]);
  } };
}

test('canonical Worktree queues are FIFO while another Worktree progresses independently', async (t) => {
  const f = fixture(t);
  const alias = join(f.root, 'alias');
  symlinkSync(f.first, alias, 'junction');
  const held = gate();
  const order = [];
  const first = f.queue.run(f.first, async (signal) => { order.push('first'); f.queue.assertIdle(alias); await held.wait(signal); order.push('first done'); });
  const second = f.queue.run(alias, () => { order.push('second'); });
  const other = f.queue.run(f.second, () => { order.push('other'); });
  await other;
  assert.deepEqual(order, ['first', 'other']);
  assert.throws(() => f.queue.assertIdle(alias), { code: 'busy', outcome: 'not_started' });
  held.release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first', 'other', 'first done', 'second']);
  f.queue.assertIdle(f.first);
});

test('queued cancellation settles before the preceding operation finishes and never invokes the cancelled mutation', async (t) => {
  const f = fixture(t);
  const held = gate();
  const first = f.queue.run(f.first, (signal) => held.wait(signal));
  const controller = new AbortController();
  let invoked = false;
  const cancelled = assert.rejects(f.queue.run(f.first, () => { invoked = true; }, { signal: controller.signal }), (error) => {
    assert.equal(error.code, 'cancelled');
    assert.equal(error.outcome, 'not_started');
    assert.match(error.operationId, /^git:/);
    return true;
  });
  controller.abort();
  await cancelled;
  assert.equal(invoked, false);
  held.release();
  await first;
});

test('an old async callback cannot inherit authority over a later operation on the same Worktree', async (t) => {
  const f = fixture(t);
  let verifyOldContext;
  const oldCallback = new Promise((resolve, reject) => {
    verifyOldContext = () => {
      try { assert.throws(() => f.queue.assertIdle(f.first), { code: 'busy' }); resolve(); }
      catch (error) { reject(error); }
    };
  });
  await f.queue.run(f.first, () => { setTimeout(verifyOldContext, 25); });
  const held = gate();
  const next = f.queue.run(f.first, (signal) => held.wait(signal));
  try { await oldCallback; } finally { held.release(); }
  await next;
});

test('cancelling a running child reports unknown mutation outcome and does not replay it', async (t) => {
  const f = fixture(t);
  const script = join(f.root, 'slow.mjs');
  writeFileSync(script, 'setTimeout(() => process.stdout.write("done"), 1000)');
  const executor = new GitExecutor({ executable: process.execPath, prefixArgs: [script] });
  t.after(() => executor.shutdown());
  const controller = new AbortController();
  const states = [];
  const pending = assert.rejects(f.queue.run(f.first, (signal) => executor.run(f.first, [], { signal }), {
    signal: controller.signal, onState: (value) => states.push(value),
  }), { code: 'cancelled', outcome: 'unknown' });
  await delay(20);
  controller.abort();
  await pending;
  assert.deepEqual(states.map((value) => value.state), ['queued', 'running', 'cancelled']);
  assert.equal(new Set(states.map((value) => value.operationId)).size, 1);
});

test('formal queued stage, unstage, stage and commit execute in order and resolve only after persistence', async (t) => {
  const f = await historyFixture(t);
  const harness = commandHarness(f.workspace);
  writeFileSync(join(f.session.worktreePath, 'queued.txt'), 'queued fixture\n');
  const results = await Promise.all([
    harness.invoke({ type: 'stage', sessionId: f.session.id, paths: ['queued.txt'] }),
    harness.invoke({ type: 'unstage', sessionId: f.session.id, paths: ['queued.txt'] }),
    harness.invoke({ type: 'stage', sessionId: f.session.id, paths: ['queued.txt'] }),
    harness.invoke({ type: 'commit', sessionId: f.session.id, subject: 'fixture queued commit' }),
  ]);
  assert.equal(results.every((value) => value.ok), true);
  assert.match(results[3].sha, /^[a-f0-9]{40}$/);
  assert.deepEqual((await f.workspace.gitStatus(f.session.id)).files, []);
  const operations = f.emitted.filter((event) => event.type === 'git.operation');
  const ids = [...new Set(operations.map((event) => event.payload.operationId))];
  assert.equal(ids.length, 4);
  for (const id of ids) assert.deepEqual(operations.filter((event) => event.payload.operationId === id).map((event) => event.payload.state), ['queued', 'running', 'succeeded']);
  assert.doesNotMatch(JSON.stringify(operations), /fixture queued commit|queued\.txt/);
});

test('production IPC exposes Git cancellation identity and outcome instead of reporting success', async () => {
  const harness = commandHarness({ async stage() {
    throw new GitCommandError('cancelled', { operationId: 'git:fixture', outcome: 'unknown' });
  } });
  const result = await harness.invoke({ type: 'stage', sessionId: 'session:fixture', paths: ['fixture.txt'] });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'git_cancelled');
  assert.equal(result.operationId, 'git:fixture');
  assert.equal(result.outcome, 'unknown');
});

test('shutdown cancels queued work and rejects new requests without losing active cleanup', async (t) => {
  const f = fixture(t);
  const held = gate();
  const first = assert.rejects(f.queue.run(f.first, (signal) => held.wait(signal)), { code: 'cancelled', outcome: 'unknown' });
  await delay(0);
  const second = assert.rejects(f.queue.run(f.first, () => assert.fail('queued write ran')), { code: 'cancelled', outcome: 'not_started' });
  await f.queue.shutdown();
  await Promise.all([first, second]);
  await assert.rejects(f.queue.run(f.first, () => {}), { code: 'cancelled', outcome: 'not_started' });
});
