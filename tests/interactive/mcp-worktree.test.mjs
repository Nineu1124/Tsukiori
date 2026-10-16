import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { codexHistoryFixture } from './codex-history-fixture.mjs';

const mcp = (name, projectId, scope = 'project') => ({ name, projectId, scope, transport: 'stdio', command: 'node', args: [] });
const config = (root) => JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8')).mcpServers;
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true, stdio: 'pipe' });

test('managed project, local and user MCP reach existing and newly created session directories', async (t) => {
  const f = await codexHistoryFixture(t);
  f.workspace.saveMcp(mcp('project-server', f.session.projectId));
  f.workspace.saveMcp(mcp('local-server', f.session.projectId, 'local'));
  f.workspace.saveMcp(mcp('user-server', undefined, 'user'));
  const expected = ['local-server', 'project-server', 'user-server'];
  assert.deepEqual(Object.keys(config(f.session.worktreePath)).sort(), expected);
  const next = await f.workspace.createSession(f.session.projectId, { runtimeType: 'codex', providerId: 'provider:chatgpt' });
  assert.deepEqual(Object.keys(config(next.worktreePath)).sort(), expected);
  f.control.start = () => assert.deepEqual(Object.keys(config(f.clients.at(-1).options.cwd)).sort(), expected);
  const turn = await f.workspace.sendPrompt(next.id, 'fixture configuration');
  f.clients.at(-1).complete(turn.turnId);
});

test('a new Worktree can inherit committed managed configuration without claiming independent entries', async (t) => {
  const f = await codexHistoryFixture(t);
  writeFileSync(join(f.repository, '.mcp.json'), '{"mcpServers":{"independent":{"command":"keep"}}}');
  f.workspace.saveMcp(mcp('managed', f.session.projectId));
  git(f.repository, 'add', '.mcp.json');
  git(f.repository, 'commit', '-qm', 'fixture configuration');
  const next = await f.workspace.createSession(f.session.projectId, { runtimeType: 'codex', providerId: 'provider:chatgpt' });
  assert.equal(config(next.worktreePath).independent.command, 'keep');
  const record = f.workspace.listMcp().find((item) => item.name === 'managed');
  f.workspace.deleteMcp(record.id);
  assert.deepEqual(Object.keys(config(next.worktreePath)), ['independent']);
});

test('failed MCP binding cleans up only the new Worktree and branch', async (t) => {
  const f = await codexHistoryFixture(t);
  f.workspace.saveMcp(mcp('managed', f.session.projectId));
  writeFileSync(join(f.repository, '.mcp.json'), '{"mcpServers":{"managed":{"command":"external"}}}');
  git(f.repository, 'add', '.mcp.json');
  git(f.repository, 'commit', '-qm', 'fixture external edit');
  const branches = git(f.repository, 'branch', '--list');
  const worktrees = git(f.repository, 'worktree', 'list', '--porcelain');
  const count = f.workspace.snapshot().sessions.length;
  await assert.rejects(f.workspace.createSession(f.session.projectId, { runtimeType: 'codex', providerId: 'provider:chatgpt' }), /外部修改/);
  assert.equal(f.workspace.snapshot().sessions.length, count);
  assert.equal(git(f.repository, 'branch', '--list'), branches);
  assert.equal(git(f.repository, 'worktree', 'list', '--porcelain'), worktrees);
  assert.equal(existsSync(f.session.worktreePath), true);
});
