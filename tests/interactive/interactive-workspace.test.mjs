import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = process.cwd();
const { InteractiveWorkspace } = await import(
  new URL('../../apps/desktop/dist/electron-main/interactive-workspace.js', import.meta.url)
);

function git(cwd, args) {
  return execFileSync('git.exe', ['-C', cwd, ...args], {
    encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function fixture(t) {
  const temporary = mkdtempSync(join(tmpdir(), 'tsukiori-interactive-'));
  const repository = join(temporary, 'repository');
  const userData = join(temporary, 'user-data');
  execFileSync('git.exe', ['init', '--quiet', repository]);
  git(repository, ['config', 'user.name', 'Tsukiori Test']);
  git(repository, ['config', 'user.email', 'test@tsukiori.invalid']);
  writeFileSync(join(repository, 'README.md'), '# fixture\n');
  git(repository, ['add', 'README.md']);
  git(repository, ['commit', '-m', 'init']);
  const emitted = [];
  let clientOptions;
  let approvalResult;
  class FakeClient {
    constructor(options) { clientOptions = options; }
    async start() { return { authenticated: true, authSource: 'chatgpt' }; }
    async startThread() { return 'thread-real'; }
    async resumeThread(id) { return id; }
    async startTurn() {
      clientOptions.onNotification('turn/started', { turn: { id: 'turn-real' } });
      queueMicrotask(async () => {
        approvalResult = await clientOptions.onApproval({
          requestId: 'approval-real',
          method: 'item/fileChange/requestApproval',
          params: { reason: 'write fixture file' },
        });
        clientOptions.onNotification('item/agentMessage/delta', { delta: '真实流式响应' });
        clientOptions.onNotification('turn/completed', { turn: { id: 'turn-real', status: 'completed' } });
      });
      return 'turn-real';
    }
    async interrupt() {}
    async stop() { clientOptions.onExit(null); }
  }
  const workspace = new InteractiveWorkspace({
    userDataPath: userData,
    emit: (event) => emitted.push(event),
    discoverCodex: () => ({
      executable: process.execPath, prefixArgs: [], version: '0.146.0', source: 'path-executable',
    }),
    createClient: (options) => new FakeClient(options),
  });
  t.after(async () => {
    await workspace.shutdown();
    const sessions = workspace.snapshot().sessions;
    for (const session of sessions) {
      if (existsSync(session.worktreePath)) {
        execFileSync('git.exe', ['-C', repository, 'worktree', 'remove', '--force', session.worktreePath]);
      }
      execFileSync('git.exe', ['-C', repository, 'branch', '-D', session.branch], { stdio: 'ignore' });
    }
    rmSync(temporary, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  });
  return { workspace, repository, userData, emitted, approval: () => approvalResult };
}

test('interactive workspace creates an isolated Worktree and runs a permission-aware Codex turn', async (t) => {
  const f = fixture(t);
  const project = f.workspace.addProject(f.repository);
  const session = await f.workspace.createSession(project.id);
  assert.equal(existsSync(session.worktreePath), true);
  assert.match(session.branch, /^tsukiori\/session-/);
  assert.notEqual(session.worktreePath.toLowerCase(), f.repository.toLowerCase());

  await f.workspace.sendPrompt(session.id, 'prompt must remain memory-only');
  await new Promise((resolve) => setTimeout(resolve, 20));
  const permission = f.workspace.snapshot().permissions[0];
  assert.equal(permission.category, 'file_write');
  f.workspace.decidePermission(permission.id, 'allow_once');
  await new Promise((resolve) => setTimeout(resolve, 20));

  const polled = f.workspace.pollEvents(0);
  assert.equal(polled.events.some((event) => event.type === 'assistant.delta'), true);
  assert.equal(polled.events.some((event) => event.type === 'turn.completed'), true);
  assert.deepEqual(f.approval(), { decision: 'accept' });
  assert.doesNotMatch(readFileSync(join(f.userData, 'workspace-state-v1.json'), 'utf8'), /prompt must remain/);
});

test('interactive Git review stages and commits only selected Worktree paths', async (t) => {
  const f = fixture(t);
  const project = f.workspace.addProject(f.repository);
  const session = await f.workspace.createSession(project.id);
  writeFileSync(join(session.worktreePath, 'agent-result.txt'), 'reviewed\n');
  const status = f.workspace.gitStatus(session.id);
  assert.deepEqual(status.files, [{ status: '??', path: 'agent-result.txt' }]);
  f.workspace.stage(session.id, ['agent-result.txt']);
  const sha = f.workspace.commit(session.id, 'test: commit reviewed agent result');
  assert.match(sha, /^[a-f0-9]{40}$/);
  assert.equal(git(session.worktreePath, ['status', '--porcelain']), '');
  assert.equal(existsSync(join(f.repository, 'agent-result.txt')), false);
});
