import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const { InteractiveIntegrationManager } = await import(
  new URL('../../apps/desktop/dist/electron-main/integration-workspace.js', import.meta.url)
);

function git(cwd, args) {
  return execFileSync('git.exe', ['-C', cwd, ...args], {
    encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'tsukiori-interactive-integration-'));
  const repository = join(root, 'repository');
  const source = join(root, 'source-worktree');
  const userData = join(root, 'user-data');
  mkdirSync(repository); mkdirSync(userData);
  execFileSync('git.exe', ['init', '--quiet', '--initial-branch=main', repository], { windowsHide: true });
  git(repository, ['config', 'user.name', 'Tsukiori Integration Fixture']);
  git(repository, ['config', 'user.email', 'integration@example.invalid']);
  writeFileSync(join(repository, 'README.md'), 'base\n');
  git(repository, ['add', '--', 'README.md']);
  git(repository, ['commit', '--quiet', '-m', 'base']);
  git(repository, ['worktree', 'add', '-b', 'tsukiori/session-fixture', source, 'HEAD']);
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }));
  return {
    root, repository, source, userData,
    manager: new InteractiveIntegrationManager(userData),
    prepare(strategy = 'merge') {
      return this.manager.prepare({
        sessionId: 'session:fixture', projectId: 'project:fixture',
        sessionWorktree: source, projectGitRoot: repository, targetRef: 'main', strategy,
      });
    },
  };
}

test('interactive Integration verifies outside the project and promotes only with a recovery ref', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.source, 'feature.txt'), 'isolated result\n');
  git(f.source, ['add', '--', 'feature.txt']);
  git(f.source, ['commit', '--quiet', '-m', 'feat: isolated result']);
  const originalMain = git(f.repository, ['rev-parse', 'HEAD']);

  const prepared = f.prepare('merge');
  assert.equal(prepared.status, 'verified');
  assert.equal(prepared.promotionRequired, true);
  assert.equal(prepared.retained, false);
  assert.equal(existsSync(prepared.integrationPath), false);
  assert.equal(git(f.repository, ['rev-parse', 'HEAD']), originalMain);
  assert.equal(existsSync(join(f.repository, 'feature.txt')), false);

  const promoted = f.manager.promote(prepared.id, f.repository);
  assert.equal(promoted.status, 'promoted');
  assert.equal(promoted.promotionRequired, false);
  assert.equal(readFileSync(join(f.repository, 'feature.txt'), 'utf8').replaceAll('\r\n', '\n'), 'isolated result\n');
  assert.equal(git(f.repository, ['rev-parse', promoted.recoveryRef]), originalMain);
  assert.equal(git(f.repository, ['rev-parse', 'HEAD']), promoted.resultCommit);

  const restored = new InteractiveIntegrationManager(f.userData).list('session:fixture')[0];
  assert.equal(restored.status, 'promoted');
  assert.equal(restored.recoveryRef, promoted.recoveryRef);
  assert.doesNotMatch(JSON.stringify(restored), /isolated result|feat: isolated result/);
});

test('interactive Integration retains conflicts, continues after resolution, and never mutates main early', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.source, 'README.md'), 'session side\n');
  git(f.source, ['add', '--', 'README.md']);
  git(f.source, ['commit', '--quiet', '-m', 'feat: session side']);
  writeFileSync(join(f.repository, 'README.md'), 'target side\n');
  git(f.repository, ['add', '--', 'README.md']);
  git(f.repository, ['commit', '--quiet', '-m', 'target advance']);
  const targetHead = git(f.repository, ['rev-parse', 'HEAD']);

  const conflicted = f.prepare('merge');
  assert.equal(conflicted.status, 'conflicted');
  assert.equal(conflicted.retained, true);
  assert.deepEqual(conflicted.conflictPaths, ['README.md']);
  assert.equal(existsSync(conflicted.integrationPath), true);
  assert.equal(git(f.repository, ['rev-parse', 'HEAD']), targetHead);

  writeFileSync(join(conflicted.integrationPath, 'README.md'), 'resolved result\n');
  git(conflicted.integrationPath, ['add', '--', 'README.md']);
  const verified = f.manager.continue(conflicted.id, f.repository);
  assert.equal(verified.status, 'verified');
  assert.equal(existsSync(conflicted.integrationPath), false);
  assert.equal(git(f.repository, ['rev-parse', 'HEAD']), targetHead);
  const promoted = f.manager.promote(verified.id, f.repository);
  assert.equal(promoted.status, 'promoted');
  assert.equal(readFileSync(join(f.repository, 'README.md'), 'utf8').replaceAll('\r\n', '\n'), 'resolved result\n');
});

test('interactive Integration rebases in isolation and preserves a concurrently advanced target', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.source, 'session.txt'), 'session commit\n');
  git(f.source, ['add', '--', 'session.txt']);
  git(f.source, ['commit', '--quiet', '-m', 'feat: session commit']);
  writeFileSync(join(f.repository, 'target.txt'), 'target commit\n');
  git(f.repository, ['add', '--', 'target.txt']);
  git(f.repository, ['commit', '--quiet', '-m', 'feat: target commit']);
  const targetHead = git(f.repository, ['rev-parse', 'HEAD']);

  const verified = f.prepare('rebase');
  assert.equal(verified.status, 'verified');
  assert.equal(git(f.repository, ['rev-parse', 'HEAD']), targetHead);
  const promoted = f.manager.promote(verified.id, f.repository);
  assert.equal(promoted.status, 'promoted');
  assert.equal(readFileSync(join(f.repository, 'session.txt'), 'utf8').replaceAll('\r\n', '\n'), 'session commit\n');
  assert.equal(readFileSync(join(f.repository, 'target.txt'), 'utf8').replaceAll('\r\n', '\n'), 'target commit\n');
});

test('interactive Integration retains verification failures and can re-verify a corrected result', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.source, 'whitespace.txt'), 'bad trailing space \n');
  git(f.source, ['add', '--', 'whitespace.txt']);
  git(f.source, ['commit', '--quiet', '-m', 'feat: needs verification repair']);
  const failed = f.prepare('merge');
  assert.equal(failed.status, 'verification_failed');
  assert.equal(failed.retained, true);
  assert.equal(existsSync(failed.integrationPath), true);

  writeFileSync(join(failed.integrationPath, 'whitespace.txt'), 'repaired\n');
  git(failed.integrationPath, ['add', '--', 'whitespace.txt']);
  git(failed.integrationPath, ['commit', '--quiet', '-m', 'fix: pass diff check']);
  const verified = f.manager.continue(failed.id, f.repository);
  assert.equal(verified.status, 'verified');
  assert.equal(existsSync(failed.integrationPath), false);
});

test('interactive Integration fails closed for dirty sources, stale targets, and explicit discard', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.source, 'dirty.txt'), 'not committed\n');
  assert.throws(() => f.prepare(), /先提交/);
  rmSync(join(f.source, 'dirty.txt'));

  writeFileSync(join(f.source, 'ready.txt'), 'ready\n');
  git(f.source, ['add', '--', 'ready.txt']);
  git(f.source, ['commit', '--quiet', '-m', 'feat: ready']);
  const verified = f.prepare();
  writeFileSync(join(f.repository, 'advance.txt'), 'advance\n');
  git(f.repository, ['add', '--', 'advance.txt']);
  git(f.repository, ['commit', '--quiet', '-m', 'target changed']);
  assert.throws(() => f.manager.promote(verified.id, f.repository), /HEAD 已变化/);
  const discarded = f.manager.discard(verified.id, f.repository);
  assert.equal(discarded.status, 'discarded');
  assert.throws(() => git(f.repository, ['show-ref', '--verify', '--quiet', 'refs/heads/' + verified.integrationBranch]));
});
