import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import test from 'node:test';
import { historyFixture } from './history-fixture.mjs';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });

test('the formal creation service keeps session metadata, worktree and event order across restart', async (t) => {
  const f = await historyFixture(t);
  const session = await f.workspace.createSession(f.session.projectId, {
    runtimeType: 'api', providerId: f.session.providerId, model: 'fixture', permissionMode: 'manual',
  });
  assert.notEqual(session.id, f.session.id);
  assert.notEqual(session.worktreePath, f.session.worktreePath);
  assert.ok(existsSync(session.worktreePath));
  assert.equal(git(session.worktreePath, 'branch', '--show-current').trim(), session.branch);
  assert.equal(session.name, 'API 2');
  assert.equal(session.status, 'ready');
  assert.equal(session.turnCount, 0);
  assert.deepEqual(f.emitted.filter((e) => e.sessionId === session.id).map((e) => e.type), ['session.created', 'session.ready']);
  await f.workspace.shutdown();
  const restored = f.open().snapshot().sessions.find((item) => item.id === session.id);
  assert.equal(restored.threadId, session.threadId);
  assert.equal(restored.worktreePath, session.worktreePath);
});

test('invalid creation choices fail before adding a session, branch, worktree or event', async (t) => {
  const f = await historyFixture(t);
  const before = f.workspace.snapshot().sessions;
  const branches = git(f.repository, 'branch', '--list');
  const worktrees = git(f.repository, 'worktree', 'list', '--porcelain');
  const events = f.emitted.length;
  await assert.rejects(f.workspace.createSession(f.session.projectId, { runtimeType: 'api', providerId: 'provider:chatgpt' }), /不支持/);
  await assert.rejects(f.workspace.createSession(f.session.projectId, { runtimeType: 'codex', providerId: 'provider:chatgpt' }), /unavailable/);
  await assert.rejects(f.workspace.createSession(f.session.projectId, { runtimeType: 'api', providerId: f.session.providerId, permissionMode: 'invalid' }), /Permission Mode/);
  assert.deepEqual(f.workspace.snapshot().sessions, before);
  assert.equal(git(f.repository, 'branch', '--list'), branches);
  assert.equal(git(f.repository, 'worktree', 'list', '--porcelain'), worktrees);
  assert.equal(f.emitted.length, events);
});
