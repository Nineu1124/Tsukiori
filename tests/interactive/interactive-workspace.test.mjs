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

function fixture(t, options = {}) {
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
      clientOptions.onNotification('item/started', { item: { type: 'userMessage', text: 'must not become a tool' } });
      clientOptions.onNotification('item/completed', { item: { type: 'userMessage', text: 'must not become a tool' } });
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
    async request(method) {
      if (method === 'skills/list') return { data: [{ skills: [{ name: 'fixture-skill', description: 'safe fixture', enabled: true, scope: 'repo' }] }] };
      if (method === 'mcpServerStatus/list') return { data: [{ name: 'fixture-mcp', authStatus: 'notRequired', tools: { read: {} }, resources: [] }] };
      return {};
    }
    async stop() { clientOptions.onExit(null); }
  }
  const workspace = new InteractiveWorkspace({
    userDataPath: userData,
    emit: (event) => emitted.push(event),
    discoverCodex: () => ({
      executable: process.execPath, prefixArgs: [], version: '0.146.0', source: 'path-executable',
    }),
    createClient: (options) => new FakeClient(options),
    ...options,
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
  return { workspace, repository, userData, emitted, approval: () => approvalResult, clientOptions: () => clientOptions };
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
  const state = readFileSync(join(f.userData, 'workspace-state-v3.json'), 'utf8');
  assert.doesNotMatch(state, /prompt must remain/);
  const transcript = readFileSync(join(f.userData, 'transcripts', (await import('node:crypto')).createHash('sha256').update(session.id).digest('hex') + '.jsonl'), 'utf8');
  assert.match(transcript, /prompt must remain memory-only/);
  assert.equal(f.emitted.some((event) => event.type === 'tool.event' && event.payload.tool === 'userMessage'), false);
});

test('interactive workspace stores provider secrets outside state and runs a Claude Code session', async (t) => {
  const temporary = mkdtempSync(join(tmpdir(), 'tsukiori-claude-'));
  const repository = join(temporary, 'repository');
  const userData = join(temporary, 'user-data');
  execFileSync('git.exe', ['init', '--quiet', repository]);
  git(repository, ['config', 'user.name', 'Tsukiori Test']);
  git(repository, ['config', 'user.email', 'test@tsukiori.invalid']);
  writeFileSync(join(repository, 'README.md'), '# fixture\n');
  git(repository, ['add', 'README.md']); git(repository, ['commit', '-m', 'init']);
  const secrets = new Map();
  const credentials = {
    store(input) { const reference = input.reference ?? 'secretref:00000000-0000-4000-8000-000000000001'; secrets.set(reference, { secret: input.secret, binding: input.binding }); return reference; },
    use(reference, binding, consumer) { const value = secrets.get(reference); assert.deepEqual(value.binding, binding); return consumer(value.secret); },
    delete(reference) { return secrets.delete(reference); },
  };
  const emitted = [];
  const fakeClaude = {
    startTurn(options) {
      assert.equal(options.environment.ANTHROPIC_API_KEY, 'fixture-secret-value');
      queueMicrotask(() => {
        options.onEvent('assistant.delta', { text: 'Claude fixture response' });
        options.onEvent('turn.completed', { status: 'completed', costUsd: 0, durationMs: 1 });
        options.onExit(null);
      });
      options.onEvent('turn.started', { turnId: 'claude-turn:fixture' });
      return 'claude-turn:fixture';
    },
    interrupt() {}, async stop() {},
  };
  const workspace = new InteractiveWorkspace({
    userDataPath: userData, emit: (event) => emitted.push(event), credentials,
    discoverCodex: () => ({ executable: process.execPath, prefixArgs: [], version: '0.146.0', source: 'path-executable' }),
    discoverClaude: () => ({ executable: process.execPath, version: '2.1.214', source: 'path-executable' }),
    createClaudeClient: () => fakeClaude,
  });
  t.after(async () => {
    await workspace.shutdown();
    for (const session of workspace.snapshot().sessions) {
      if (existsSync(session.worktreePath)) execFileSync('git.exe', ['-C', repository, 'worktree', 'remove', '--force', session.worktreePath]);
      execFileSync('git.exe', ['-C', repository, 'branch', '-D', session.branch], { stdio: 'ignore' });
    }
    rmSync(temporary, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  });
  workspace.saveProvider({ id: 'provider:anthropic', name: 'Anthropic API', kind: 'anthropic', apiKey: 'fixture-secret-value', models: ['claude-sonnet-4-6'] });
  const project = workspace.addProject(repository);
  const session = await workspace.createSession(project.id, { runtimeType: 'claude', providerId: 'provider:anthropic', model: 'claude-sonnet-4-6', permissionMode: 'plan' });
  await workspace.sendPrompt(session.id, 'memory-only claude prompt');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(emitted.some((event) => event.type === 'assistant.delta'), true);
  const persisted = readFileSync(join(userData, 'workspace-state-v3.json'), 'utf8');
  assert.doesNotMatch(persisted, /fixture-secret-value|memory-only claude prompt/);
  assert.match(persisted, /secretref:/);
  const snapshotText = JSON.stringify(workspace.snapshot());
  assert.doesNotMatch(snapshotText, /fixture-secret-value|secretref:/);
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

test('Codex custom OpenAI-compatible Provider is bound to app-server without persisting its key', async (t) => {
  const secrets = new Map();
  const credentials = {
    store(input) { const reference = input.reference ?? 'secretref:00000000-0000-4000-8000-000000000003'; secrets.set(reference, { secret: input.secret, binding: input.binding }); return reference; },
    use(reference, binding, consumer) { const value = secrets.get(reference); assert.deepEqual(value.binding, binding); return consumer(value.secret); },
    delete(reference) { return secrets.delete(reference); },
  };
  const f = fixture(t, { credentials });
  const provider = f.workspace.saveProvider({
    name: 'Custom Responses API', kind: 'openai-compatible', baseUrl: 'https://responses.example.invalid',
    models: ['custom-codex-model'], apiKey: 'custom-provider-fixture-secret',
  });
  const project = f.workspace.addProject(f.repository);
  const session = await f.workspace.createSession(project.id, {
    runtimeType: 'codex', providerId: provider.id, model: 'custom-codex-model', permissionMode: 'manual',
  });
  await f.workspace.sendPrompt(session.id, 'memory-only custom provider prompt');
  await new Promise((resolve) => setTimeout(resolve, 20));
  const permission = f.workspace.snapshot().permissions[0];
  if (permission) f.workspace.decidePermission(permission.id, 'deny_once');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(f.clientOptions().environment.OPENAI_API_KEY, 'custom-provider-fixture-secret');
  assert.deepEqual(f.clientOptions().configArgs.slice(0, 2), ['-c', 'model_provider="tsukiori"']);
  assert.match(f.clientOptions().configArgs.join(' '), /responses\.example\.invalid/);
  const state = readFileSync(join(f.userData, 'workspace-state-v3.json'), 'utf8');
  assert.doesNotMatch(state, /custom-provider-fixture-secret|memory-only custom provider prompt/);
});

test('session lifecycle, persisted transcript, files, attachments, and native capabilities are complete', async (t) => {
  const f = fixture(t);
  const project = f.workspace.addProject(f.repository);
  const session = await f.workspace.createSession(project.id);
  f.workspace.renameSession(session.id, 'Pinned implementation');
  f.workspace.pinSession(session.id, true);
  writeFileSync(join(session.worktreePath, 'feature.md'), '# feature\nlocal preview\n');
  const source = join(f.userData, 'selected.txt');
  writeFileSync(source, 'attachment body\n');
  const attachments = f.workspace.attachFiles(session.id, [source]);
  assert.equal(attachments.length, 1);
  assert.equal(existsSync(join(session.worktreePath, attachments[0].path)), true);
  assert.equal(f.workspace.listFiles(session.id, 'feature').some((file) => file.path === 'feature.md'), true);
  assert.match(f.workspace.readTextFile(session.id, 'feature.md').content, /local preview/);
  assert.throws(() => f.workspace.readTextFile(session.id, '../README.md'), /Worktree|路径/);
  const native = await f.workspace.codexNativeCapabilities(session.id);
  assert.deepEqual(native.skills.map((item) => item.name), ['fixture-skill']);
  assert.deepEqual(native.servers.map((item) => item.name), ['fixture-mcp']);
  const archived = f.workspace.archiveSession(session.id);
  assert.equal(archived.pinned, true);
  assert.equal(typeof archived.archivedAt, 'number');
  assert.equal(existsSync(session.worktreePath), true);
  assert.doesNotMatch(readFileSync(join(f.userData, 'workspace-state-v3.json'), 'utf8'), /attachment body/);
});

test('Agent Team dispatches two independent sessions and Worktrees', async (t) => {
  const prompts = [];
  class TeamClient {
    constructor(options) { this.options = options; }
    async start() { return { authenticated: true, authSource: 'chatgpt' }; }
    async startThread(cwd) { return 'thread:' + cwd; }
    async startTurn(_threadId, prompt) { prompts.push(prompt); return 'turn:' + prompts.length; }
    async interrupt() {}
    async stop() { this.options.onExit(null); }
  }
  const f = fixture(t, { createClient: (options) => new TeamClient(options) });
  const project = f.workspace.addProject(f.repository);
  const team = await f.workspace.createTeam(project.id, 'Implement and review a bounded feature', [
    { role: 'Implementer', runtimeType: 'codex', providerId: 'provider:chatgpt', model: 'auto' },
    { role: 'Reviewer', runtimeType: 'codex', providerId: 'provider:chatgpt', model: 'auto' },
  ]);
  assert.equal(team.memberSessionIds.length, 2);
  assert.equal(new Set(team.memberSessionIds.map((id) => f.workspace.sessionWorktree(id))).size, 2);
  assert.equal(prompts.length, 2);
  assert.equal(f.workspace.snapshot().teams[0].status, 'running');
});

test('resizable work panel, terminal shell, and diagnostics persist without prompts or credentials', async (t) => {
  const f = fixture(t);
  const project = f.workspace.addProject(f.repository);
  const session = await f.workspace.createSession(project.id);
  const settings = f.workspace.updateSettings({ workPanelWidth: 900, terminalShell: 'pwsh' });
  assert.equal(settings.workPanelWidth, 720);
  assert.equal(settings.terminalShell, 'pwsh');
  assert.equal(f.workspace.terminalShell(), 'pwsh');
  const diagnostic = f.workspace.diagnosticSummary();
  assert.equal(diagnostic.projects, 1);
  assert.equal(diagnostic.sessions, 1);
  assert.equal(diagnostic.containsCredentials, false);
  assert.equal(diagnostic.containsPrompts, false);
  assert.equal(diagnostic.containsUserSource, false);
  const persisted = readFileSync(join(f.userData, 'workspace-state-v3.json'), 'utf8');
  assert.match(persisted, /"workPanelWidth": 720/);
  assert.match(persisted, /"terminalShell": "pwsh"/);
  assert.doesNotMatch(JSON.stringify(diagnostic), new RegExp(session.worktreePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});
