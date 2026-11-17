import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { GitExecutor } from '../../apps/desktop/dist/electron-main/git-executor.js';
import { historyFixture } from './history-fixture.mjs';
import { commandHarness } from './workspace-command-harness.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'tsukiori-async-git-'));
  const script = join(root, 'git-fixture.mjs');
  writeFileSync(script, `
    const args = process.argv.slice(2);
    if (args.includes('failure')) { process.stderr.write('private stderr fixture'); process.exitCode = 1; }
    else if (args.includes('large')) process.stdout.write('x'.repeat(1024));
    else if (args.includes('status')) setTimeout(() => process.stdout.write(' M README.md\\n'), 350);
    else if (args.includes('diff')) process.stdout.write('fixture diff\\n');
    else if (args.includes('slow')) setTimeout(() => process.stdout.write('done'), 1000);
    else process.stdout.write('fixture output');
  `);
  const executor = new GitExecutor({ executable: process.execPath, prefixArgs: [script] });
  t.after(async () => {
    await executor.shutdown();
    rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  });
  return { root, executor };
}

test('formal async Git status leaves the event loop and other IPC commands responsive', async (t) => {
  const f = fixture(t);
  const workspace = await historyFixture(t, { gitExecutor: f.executor });
  const harness = commandHarness(workspace.workspace);
  let completed = false;
  const pending = harness.invoke({ type: 'git_status', sessionId: workspace.session.id }).then((result) => { completed = true; return result; });
  await delay(20);
  const other = await harness.invoke({ type: 'poll_events', afterSequence: 0 });
  assert.equal(other.ok, true);
  assert.equal(completed, false);
  const result = await pending;
  assert.equal(result.ok, true);
  assert.deepEqual(Array.from(result.git.files, (item) => ({ ...item })), [{ status: ' M', path: 'README.md' }]);
  const diff = await harness.invoke({ type: 'git_diff', sessionId: workspace.session.id, path: 'README.md' });
  assert.equal(diff.diff, 'fixture diff\n');
});

test('real Git status and diff preserve the Worktree result and reject traversal', async (t) => {
  const f = await historyFixture(t);
  writeFileSync(join(f.session.worktreePath, 'README.md'), 'changed fixture\n');
  const status = await f.workspace.gitStatus(f.session.id);
  assert.deepEqual(status.files, [{ status: ' M', path: 'README.md' }]);
  assert.match(await f.workspace.gitDiff(f.session.id, 'README.md'), /changed fixture/);
  await assert.rejects(f.workspace.gitDiff(f.session.id, '../outside'), /路径/);
});

test('Git failures expose categories without raw stderr or command data', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.executor.run(f.root, ['failure']), (error) => {
    assert.equal(error.code, 'failed');
    assert.doesNotMatch(JSON.stringify(error) + error.message, /private stderr/);
    return true;
  });
  const unavailable = new GitExecutor({ executable: join(f.root, 'missing.exe') });
  await assert.rejects(unavailable.run(f.root, ['status']), { code: 'unavailable' });
  await unavailable.shutdown();
});

test('Git output, deadline and cancellation limits reject rather than returning partial output', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.executor.run(f.root, ['large'], { maxOutputBytes: 64 }), { code: 'output_limit' });
  await assert.rejects(f.executor.run(f.root, ['slow'], { timeoutMs: 50 }), { code: 'timeout' });
  const controller = new AbortController();
  const cancelled = assert.rejects(f.executor.run(f.root, ['slow'], { signal: controller.signal }), { code: 'cancelled' });
  controller.abort('private cancellation reason fixture');
  await cancelled;
  await assert.rejects(f.executor.run(f.root, ['slow'], { signal: controller.signal }), { code: 'cancelled' });
});

test('shutdown cancels pending Git reads, waits for process exit and prevents later starts', async (t) => {
  const f = fixture(t);
  const first = assert.rejects(f.executor.run(f.root, ['slow']), { code: 'cancelled' });
  const second = assert.rejects(f.executor.run(f.root, ['slow']), { code: 'cancelled' });
  await f.executor.shutdown();
  await Promise.all([first, second]);
  await assert.rejects(f.executor.run(f.root, ['status']), { code: 'cancelled' });
});
