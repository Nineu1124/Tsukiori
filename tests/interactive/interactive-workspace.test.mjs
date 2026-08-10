import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
  const codexForks = [];
  class FakeClient {
    constructor(options) { clientOptions = options; }
    async start() { return { authenticated: true, authSource: 'chatgpt' }; }
    async startThread() { return 'thread-real'; }
    async resumeThread(id) { return id; }
    async forkThread(threadId, lastTurnId) { codexForks.push({ threadId, lastTurnId }); return 'thread-rewound'; }
    async startTurn() {
      clientOptions.onNotification('turn/started', { turn: { id: 'turn-real' } });
      clientOptions.onNotification('item/started', { item: { type: 'userMessage', text: 'must not become a tool' } });
      clientOptions.onNotification('item/completed', { item: { type: 'userMessage', text: 'must not become a tool' } });
      clientOptions.onNotification('item/started', { item: {
        type: 'collabAgentToolCall', id: 'collab-real', tool: 'spawnAgent', status: 'inProgress',
        senderThreadId: 'thread-real', receiverThreadIds: ['thread-child'],
        agentsStates: { 'thread-child': { status: 'running', message: 'must-not-enter-activity' } },
        prompt: 'must-not-enter-activity',
      } });
      queueMicrotask(async () => {
        approvalResult = await clientOptions.onApproval({
          requestId: 'approval-real',
          method: 'item/fileChange/requestApproval',
          params: { reason: 'write fixture file' },
        });
        clientOptions.onNotification('item/agentMessage/delta', { delta: '真实流式响应' });
        clientOptions.onNotification('item/completed', { item: {
          type: 'collabAgentToolCall', id: 'collab-real', tool: 'spawnAgent', status: 'completed',
          senderThreadId: 'thread-real', receiverThreadIds: ['thread-child'],
          agentsStates: { 'thread-child': { status: 'completed', message: 'must-not-enter-activity' } },
          prompt: 'must-not-enter-activity',
        } });
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
  return { workspace, repository, userData, emitted, approval: () => approvalResult, clientOptions: () => clientOptions, codexForks };
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
  const activity = f.workspace.activity(session.id);
  assert.deepEqual(activity.subagents.map((agent) => [agent.source, agent.runtimeId, agent.status]), [['runtime', 'thread-child', 'completed']]);
  assert.doesNotMatch(JSON.stringify(activity), /must-not-enter-activity/);
});

test('interactive workspace exposes verified Integration and explicit Promotion to the project branch', async (t) => {
  const f = fixture(t);
  const project = f.workspace.addProject(f.repository);
  const session = await f.workspace.createSession(project.id);
  writeFileSync(join(session.worktreePath, 'integrated.txt'), 'verified in isolation\n');
  git(session.worktreePath, ['add', '--', 'integrated.txt']);
  git(session.worktreePath, ['commit', '-m', 'feat: integration fixture']);
  const target = f.workspace.integrationTarget(session.id);
  const mainBefore = git(f.repository, ['rev-parse', 'HEAD']);
  assert.equal(target.targetCommit, mainBefore);
  assert.equal(target.clean, true);
  assert.deepEqual(f.workspace.listIntegrations(session.id), []);

  const prepared = f.workspace.prepareIntegration(session.id, 'merge', target.targetRef);
  assert.equal(prepared.status, 'verified');
  assert.equal(git(f.repository, ['rev-parse', 'HEAD']), mainBefore);
  assert.equal(existsSync(join(f.repository, 'integrated.txt')), false);
  assert.equal(f.workspace.snapshot().integrations[0].id, prepared.id);

  const promoted = f.workspace.promoteIntegration(session.id, prepared.id);
  assert.equal(promoted.status, 'promoted');
  assert.equal(readFileSync(join(f.repository, 'integrated.txt'), 'utf8').replaceAll('\r\n', '\n'), 'verified in isolation\n');
  assert.equal(git(f.repository, ['rev-parse', promoted.recoveryRef]), mainBefore);
  assert.equal(f.emitted.some((event) => event.type === 'integration.prepared'), true);
  assert.equal(f.emitted.some((event) => event.type === 'integration.promoted'), true);
});

test('cc-haha import creates idempotent read-only Claude history and requires an explicit Fork', async (t) => {
  const f = fixture(t);
  const sourceRoot = join(f.userData, 'cc-haha-source');
  const projectDirectory = join(sourceRoot, 'projects', 'lossy-project-directory');
  const sourceSessionId = '00000000-0000-4000-8000-000000000088';
  const sourceFile = join(projectDirectory, `${sourceSessionId}.jsonl`);
  mkdirSync(projectDirectory, { recursive: true });
  const source = [
    { type: 'custom-title', customTitle: 'Imported workspace history', cwd: f.repository, timestamp: '2026-02-03T04:05:06.000Z' },
    { type: 'user', uuid: 'u-1', cwd: f.repository, timestamp: '2026-02-03T04:05:07.000Z', message: { id: 'user-1', content: 'imported user message' } },
    { type: 'assistant', uuid: 'a-1', cwd: f.repository, timestamp: '2026-02-03T04:05:08.000Z', message: { id: 'assistant-1', model: 'sonnet', content: [{ type: 'text', text: 'imported answer' }] } },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n';
  writeFileSync(sourceFile, source);
  const scan = f.workspace.scanCcHahaImport(sourceRoot);
  assert.equal(scan.importableCount, 1);
  assert.equal(Object.hasOwn(scan.sessions[0], 'sourceFile'), false);
  const result = f.workspace.importCcHaha(sourceRoot, scan.sourceFingerprint, [scan.sessions[0].candidateId]);
  assert.equal(result.importedCount, 1);
  const imported = f.workspace.snapshot().sessions.find((session) => session.id === result.sessions[0].id);
  assert.equal(imported.importedReadOnly, true);
  assert.equal(imported.importSource, 'cc-haha');
  assert.equal(imported.threadId, sourceSessionId);
  assert.equal(imported.turnCount, 1);
  assert.equal(readFileSync(sourceFile, 'utf8'), source);
  assert.match(JSON.stringify(f.workspace.snapshot().recentEvents), /imported user message/);
  await assert.rejects(f.workspace.sendPrompt(imported.id, 'must not run'), /只读.*Fork/);
  assert.equal(f.workspace.snapshot().sessions.find((session) => session.id === imported.id).status, 'ready');
  assert.throws(() => f.workspace.attachFiles(imported.id, [sourceFile]), /只读.*Fork/);
  assert.throws(() => f.workspace.writableSessionWorktree(imported.id), /只读.*Fork/);
  const repeatedScan = f.workspace.scanCcHahaImport(sourceRoot);
  assert.equal(repeatedScan.alreadyImportedCount, 1);
  assert.equal(f.workspace.importCcHaha(sourceRoot, repeatedScan.sourceFingerprint).importedCount, 0);
  const fork = await f.workspace.forkSession(imported.id);
  assert.equal(fork.forkedFromSessionId, imported.id);
  assert.equal(fork.forkSourceRuntimeSessionId, sourceSessionId);
  assert.equal(Boolean(fork.importedReadOnly), false);
});

test('cc-haha import rolls back Session, Transcript, Worktree, branch, and newly added Project on batch failure', (t) => {
  const f = fixture(t, {
    emit(event) {
      if (event.type === 'session.created' && event.payload.importedFrom === 'cc-haha') {
        throw new Error('fixture import event failure');
      }
    },
  });
  const sourceRoot = join(f.userData, 'cc-haha-rollback-source');
  const projectDirectory = join(sourceRoot, 'projects', 'project');
  const sourceSessionId = '00000000-0000-4000-8000-000000000099';
  mkdirSync(projectDirectory, { recursive: true });
  writeFileSync(join(projectDirectory, `${sourceSessionId}.jsonl`), [
    { type: 'user', cwd: f.repository, timestamp: '2026-03-01T00:00:00.000Z', message: { id: 'u', content: 'rollback me' } },
    { type: 'assistant', cwd: f.repository, timestamp: '2026-03-01T00:00:01.000Z', message: { id: 'a', model: 'sonnet', content: 'rollback answer' } },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n');
  const scan = f.workspace.scanCcHahaImport(sourceRoot);
  assert.throws(
    () => f.workspace.importCcHaha(sourceRoot, scan.sourceFingerprint, [scan.sessions[0].candidateId]),
    /fixture import event failure/,
  );
  assert.deepEqual(f.workspace.snapshot().sessions, []);
  assert.deepEqual(f.workspace.snapshot().projects, []);
  const transcriptRoot = join(f.userData, 'transcripts');
  assert.deepEqual(readdirSync(transcriptRoot), []);
  assert.doesNotMatch(git(f.repository, ['branch', '--list']), /tsukiori\/import-/);
  assert.equal(f.workspace.scanCcHahaImport(sourceRoot).importableCount, 1);
});

test('Codex Checkpoint rewinds code and transcript through thread/fork without moving HEAD', async (t) => {
  const f = fixture(t);
  const project = f.workspace.addProject(f.repository);
  const session = await f.workspace.createSession(project.id);
  await f.workspace.sendPrompt(session.id, 'checkpoint source turn');
  await new Promise((resolve) => setTimeout(resolve, 20));
  f.workspace.decidePermission(f.workspace.snapshot().permissions[0].id, 'allow_once');
  await new Promise((resolve) => setTimeout(resolve, 20));
  writeFileSync(join(session.worktreePath, 'checkpoint.txt'), 'checkpoint code\n');
  const headBefore = git(session.worktreePath, ['rev-parse', 'HEAD']);
  const checkpoint = f.workspace.createCheckpoint(session.id, 'Stable Codex state');
  assert.equal(checkpoint.runtimeSessionId, 'thread-real');
  assert.equal(checkpoint.runtimeTurnId, 'turn-real');

  writeFileSync(join(session.worktreePath, 'checkpoint.txt'), 'future code\n');
  writeFileSync(join(session.worktreePath, 'future.txt'), 'remove on rewind\n');
  await f.workspace.sendPrompt(session.id, 'future turn must be removed');
  await new Promise((resolve) => setTimeout(resolve, 20));
  f.workspace.decidePermission(f.workspace.snapshot().permissions[0].id, 'deny_once');
  await new Promise((resolve) => setTimeout(resolve, 20));
  const preview = f.workspace.previewCheckpoint(session.id, checkpoint.id);
  assert.equal(preview.headWillMove, false);
  assert.equal(preview.conversationEventsRemoved > 0, true);
  const result = await f.workspace.rewindCheckpoint(session.id, checkpoint.id);
  assert.deepEqual(f.codexForks, [{ threadId: 'thread-real', lastTurnId: 'turn-real' }]);
  assert.equal(git(session.worktreePath, ['rev-parse', 'HEAD']), headBefore);
  assert.equal(readFileSync(join(session.worktreePath, 'checkpoint.txt'), 'utf8').replaceAll('\r\n', '\n'), 'checkpoint code\n');
  assert.equal(existsSync(join(session.worktreePath, 'future.txt')), false);
  const restored = f.workspace.snapshot().sessions.find((item) => item.id === session.id);
  assert.equal(restored.threadId, 'thread-rewound');
  assert.equal(restored.turnCount, 1);
  const transcriptName = (await import('node:crypto')).createHash('sha256').update(session.id).digest('hex') + '.jsonl';
  const transcript = readFileSync(join(f.userData, 'transcripts', transcriptName), 'utf8');
  assert.doesNotMatch(transcript, /future turn must be removed/);
  assert.match(transcript, /checkpoint\.rewound/);
  assert.equal(result.recoveryCheckpoint.kind, 'recovery');
  assert.deepEqual(new Set(f.workspace.listCheckpoints(session.id).map((item) => item.kind)), new Set(['manual', 'recovery']));
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

test('Claude native login runs without an API Key and reports the real auth source', async (t) => {
  const calls = [];
  const sourceRuntimeSessionId = '11111111-1111-4111-8111-111111111111';
  const rewoundRuntimeSessionId = '22222222-2222-4222-8222-222222222222';
  const fakeClaude = {
    startTurn(options) {
      const callNumber = calls.length;
      calls.push(options);
      assert.equal(options.authMode, 'native');
      assert.deepEqual(options.environment, {});
      queueMicrotask(() => {
        options.onEvent('session.started', {
          runtimeSessionId: callNumber === 0 ? sourceRuntimeSessionId : rewoundRuntimeSessionId,
        });
        options.onEvent('assistant.message.started', { messageId: 'message:native' });
        options.onEvent('assistant.thinking.started', { index: 0 });
        options.onEvent('assistant.thinking.delta', { text: 'native reasoning' });
        options.onEvent('assistant.thinking.completed', { index: 0 });
        options.onEvent('assistant.delta', { text: 'native Claude response' });
        options.onEvent('assistant.message.completed', {});
        options.onEvent('tool.event', { phase: 'started', tool: 'Read', toolUseId: 'tool:native', summary: 'README.md' });
        options.onEvent('tool.event', { phase: 'completed', tool: 'Read', toolUseId: 'tool:native', summary: 'README.md read' });
        options.onEvent('turn.completed', { status: 'completed' });
        options.onExit(null);
      });
      options.onEvent('turn.started', { turnId: 'claude-turn:native' });
      return 'claude-turn:native';
    },
    interrupt() {}, async stop() {},
  };
  const f = fixture(t, {
    discoverClaude: () => ({
      executable: process.execPath, version: '2.1.226', source: 'path-executable',
      compatibility: 'supported', capabilities: ['stream-json', 'session-resume'],
    }),
    probeClaudeAuth: () => ({ authenticated: true, source: 'claude-oauth', method: 'oauth_token', provider: 'firstParty' }),
    createClaudeClient: () => fakeClaude,
  });
  const nativeProvider = f.workspace.snapshot().providers.find((provider) => provider.id === 'provider:claude-native');
  assert.equal(nativeProvider.hasSecret, false);
  assert.equal(f.workspace.snapshot().runtimes.find((runtime) => runtime.type === 'claude').authSource, 'claude-oauth');
  assert.equal((await f.workspace.testProvider(nativeProvider.id)).ok, true);
  const project = f.workspace.addProject(f.repository);
  const session = await f.workspace.createSession(project.id, {
    runtimeType: 'claude', providerId: nativeProvider.id, model: 'sonnet', permissionMode: 'manual',
  });
  await f.workspace.sendPrompt(session.id, 'native auth prompt');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.length, 1);
  assert.equal(f.emitted.some((event) => event.type === 'assistant.delta'), true);
  assert.equal(f.emitted.some((event) => event.type === 'assistant.thinking.delta'), true);
  assert.deepEqual(f.emitted.filter((event) => event.type === 'tool.event').map((event) => event.payload.phase), ['started', 'completed']);
  const transcriptName = (await import('node:crypto')).createHash('sha256').update(session.id).digest('hex') + '.jsonl';
  const transcript = readFileSync(join(f.userData, 'transcripts', transcriptName), 'utf8');
  for (const eventType of ['assistant.message.started', 'assistant.thinking.delta', 'assistant.message.completed', 'tool.event', 'turn.completed']) {
    assert.match(transcript, new RegExp(eventType.replaceAll('.', '\\.')));
  }
  assert.doesNotMatch(readFileSync(join(f.userData, 'workspace-state-v3.json'), 'utf8'), /native auth prompt|oauth_token/);

  writeFileSync(join(session.worktreePath, 'checkpoint.txt'), 'claude checkpoint\n');
  const checkpoint = f.workspace.createCheckpoint(session.id, 'Stable Claude state');
  assert.equal(checkpoint.runtimeSessionId, sourceRuntimeSessionId);
  assert.equal(checkpoint.runtimeMessageId, 'message:native');
  writeFileSync(join(session.worktreePath, 'checkpoint.txt'), 'future Claude code\n');
  writeFileSync(join(session.worktreePath, 'future.txt'), 'remove after Claude rewind\n');
  await f.workspace.rewindCheckpoint(session.id, checkpoint.id);
  assert.equal(readFileSync(join(session.worktreePath, 'checkpoint.txt'), 'utf8').replaceAll('\r\n', '\n'), 'claude checkpoint\n');
  assert.equal(existsSync(join(session.worktreePath, 'future.txt')), false);
  const pendingFork = f.workspace.snapshot().sessions.find((item) => item.id === session.id);
  assert.equal(pendingFork.forkSourceRuntimeSessionId, sourceRuntimeSessionId);
  assert.equal(pendingFork.forkSourceRuntimeMessageId, 'message:native');

  await f.workspace.sendPrompt(session.id, 'continue from Claude checkpoint');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.length, 2);
  assert.equal(calls[1].forkFromSessionId, sourceRuntimeSessionId);
  assert.equal(calls[1].resumeSessionAt, 'message:native');
  const resumed = f.workspace.snapshot().sessions.find((item) => item.id === session.id);
  assert.equal(resumed.threadId, rewoundRuntimeSessionId);
  assert.equal(resumed.forkSourceRuntimeSessionId, undefined);
  assert.equal(resumed.forkSourceRuntimeMessageId, undefined);
});

test('Claude stdio permissions enter Attention Center and route one correlated decision back to the active Turn', async (t) => {
  const decisions = [];
  let activeOptions;
  const fakeClaude = {
    startTurn(options) {
      activeOptions = options;
      options.onEvent('turn.started', {
        turnId: 'claude-turn:permission', runtimeTurnId: 'claude-turn:permission',
        connectionEpoch: 'claude-epoch:permission', runtimeSequence: 1,
      });
      queueMicrotask(() => options.onEvent('permission.requested', {
        runtimeTurnId: 'claude-turn:permission', connectionEpoch: 'claude-epoch:permission', runtimeSequence: 2,
        requestId: 'claude-request:permission', toolUseId: 'tool:permission', tool: 'Bash',
        title: 'Run git status', description: 'Inspect the isolated Worktree',
        input: { command: 'git status', api_key: '[REDACTED]' },
      }));
      return 'claude-turn:permission';
    },
    respondToPermission(turnId, requestId, decision) {
      decisions.push({ turnId, requestId, decision });
      queueMicrotask(() => {
        activeOptions.onEvent('tool.event', { phase: 'completed', tool: 'Bash', toolUseId: 'tool:permission', summary: 'git status' });
        activeOptions.onEvent('turn.completed', { status: 'completed' });
        activeOptions.onExit(null);
      });
    },
    interrupt() {}, async stop() {},
  };
  const f = fixture(t, {
    discoverClaude: () => ({
      executable: process.execPath, version: '2.1.226', source: 'path-executable',
      compatibility: 'supported', capabilities: ['stream-json', 'session-resume'],
    }),
    probeClaudeAuth: () => ({ authenticated: true, source: 'claude-oauth', method: 'oauth_token', provider: 'firstParty' }),
    createClaudeClient: () => fakeClaude,
  });
  const project = f.workspace.addProject(f.repository);
  const session = await f.workspace.createSession(project.id, {
    runtimeType: 'claude', providerId: 'provider:claude-native', model: 'sonnet', permissionMode: 'manual',
  });
  await f.workspace.sendPrompt(session.id, 'request a harmless permission');
  await new Promise((resolve) => setTimeout(resolve, 20));
  const permission = f.workspace.snapshot().permissions[0];
  assert.equal(permission.connectionEpoch, 'claude-epoch:permission');
  assert.equal(permission.category, 'shell');
  assert.equal(permission.scope, 'git status');
  assert.equal(permission.enforcementLevel, 'interceptable');
  assert.equal(f.workspace.snapshot().sessions.find((item) => item.id === session.id).status, 'waiting_permission');
  f.workspace.decidePermission(permission.id, 'allow_once');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(decisions, [{
    turnId: 'claude-turn:permission', requestId: 'claude-request:permission', decision: 'allow',
  }]);
  assert.equal(f.workspace.snapshot().permissions.length, 0);
  assert.equal(f.workspace.snapshot().sessions.find((item) => item.id === session.id).status, 'ready');
  const requested = f.emitted.find((event) => event.type === 'permission.requested');
  assert.equal(requested.payload.permissionId, permission.id);
  assert.equal(JSON.stringify(f.workspace.snapshot()).includes('must-not-reach-ui'), false);
});

test('Claude Session Fork branches committed code and adopts a new runtime session on first Turn', async (t) => {
  const calls = [];
  const sourceRuntimeSessionId = '00000000-0000-4000-8000-000000000042';
  const forkRuntimeSessionId = '00000000-0000-4000-8000-000000000099';
  const fakeClaude = {
    startTurn(options) {
      calls.push(options);
      const index = calls.length;
      const turnId = `claude-turn:fork-${index}`;
      options.onEvent('turn.started', { turnId });
      queueMicrotask(() => {
        options.onEvent('session.started', { runtimeSessionId: index === 1 ? sourceRuntimeSessionId : forkRuntimeSessionId });
        options.onEvent('assistant.delta', { text: index === 1 ? 'source response' : 'fork response' });
        options.onEvent('turn.completed', { status: 'completed' });
        options.onExit(null);
      });
      return turnId;
    },
    respondToPermission() {}, interrupt() {}, async stop() {},
  };
  const f = fixture(t, {
    discoverClaude: () => ({
      executable: process.execPath, version: '2.1.226', source: 'path-executable',
      compatibility: 'supported', capabilities: ['stream-json', 'session-resume', 'session-fork'],
    }),
    probeClaudeAuth: () => ({ authenticated: true, source: 'claude-oauth', method: 'oauth_token', provider: 'firstParty' }),
    createClaudeClient: () => fakeClaude,
  });
  const project = f.workspace.addProject(f.repository);
  const source = await f.workspace.createSession(project.id, {
    runtimeType: 'claude', providerId: 'provider:claude-native', model: 'sonnet', permissionMode: 'manual',
  });
  await f.workspace.sendPrompt(source.id, 'source fork history');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(f.workspace.searchSessions(project.id, 'fork history').map((result) => result.sessionId), [source.id]);
  assert.equal(f.workspace.searchSessions(project.id, 'source response')[0].matchType, 'transcript');
  const fork = await f.workspace.forkSession(source.id);
  assert.equal(fork.forkedFromSessionId, source.id);
  assert.equal(fork.forkSourceRuntimeSessionId, sourceRuntimeSessionId);
  assert.equal(existsSync(fork.worktreePath), true);
  assert.notEqual(fork.worktreePath, source.worktreePath);
  assert.match(fork.name, /\(Fork\)$/);
  const copiedPrompt = f.workspace.snapshot().recentEvents.find((event) => (
    event.sessionId === fork.id && event.type === 'user.message' && event.payload.text === 'source fork history'
  ));
  assert.equal(typeof copiedPrompt.payload.forkedFromEventId, 'string');
  await f.workspace.sendPrompt(fork.id, 'continue only in fork');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls[1].forkFromSessionId, sourceRuntimeSessionId);
  assert.equal(calls[1].resume, false);
  const forkSnapshot = f.workspace.snapshot().sessions.find((session) => session.id === fork.id);
  assert.equal(forkSnapshot.threadId, forkRuntimeSessionId);
  assert.equal(Object.hasOwn(forkSnapshot, 'forkSourceRuntimeSessionId'), false);
  writeFileSync(join(source.worktreePath, 'uncommitted.txt'), 'do not silently fork this\n');
  await assert.rejects(f.workspace.forkSession(source.id), /提交或清理/);
});

test('Claude native login fails explicitly when the local Runtime is logged out', async (t) => {
  const f = fixture(t, {
    discoverClaude: () => ({
      executable: process.execPath, version: '2.1.226', source: 'path-executable', compatibility: 'supported',
    }),
    probeClaudeAuth: () => ({ authenticated: false, source: 'unknown', method: 'none', provider: 'unknown' }),
    createClaudeClient: () => ({ startTurn() { throw new Error('must not start'); }, interrupt() {}, async stop() {} }),
  });
  const project = f.workspace.addProject(f.repository);
  await assert.rejects(f.workspace.createSession(project.id, {
    runtimeType: 'claude', providerId: 'provider:claude-native', model: 'sonnet', permissionMode: 'plan',
  }), /尚未登录/);
  const result = await f.workspace.testProvider('provider:claude-native');
  assert.equal(result.ok, false);
  assert.equal(result.category, 'authentication_required');
  assert.equal(Number.isFinite(result.latencyMs), true);
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
  const settings = f.workspace.updateSettings({
    defaultRuntime: 'codex', defaultProviderId: provider.id, defaultModel: 'custom-codex-model',
    language: 'en-US', theme: 'system', confirmHighRisk: false,
  });
  assert.equal(settings.language, 'zh-CN');
  assert.equal(settings.theme, 'light');
  assert.equal(settings.confirmHighRisk, true);
  const session = await f.workspace.createSession(project.id);
  assert.equal(session.providerId, provider.id);
  assert.equal(session.model, 'custom-codex-model');
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
  f.workspace.saveMcp({ name: 'fixture-mcp', scope: 'project', projectId: project.id, transport: 'stdio', command: 'node.exe', args: [] });
  f.workspace.saveMcp({ name: 'offline-mcp', scope: 'project', projectId: project.id, transport: 'stdio', command: 'node.exe', args: [] });
  const skillRoot = join(session.worktreePath, '.codex', 'skills', 'fixture-skill');
  mkdirSync(skillRoot, { recursive: true });
  writeFileSync(join(skillRoot, 'SKILL.md'), '---\nname: fixture-skill\ndescription: effective fixture\n---\n# Fixture\n');
  const native = await f.workspace.codexNativeCapabilities(session.id);
  assert.deepEqual(native.skills.map((item) => item.name), ['fixture-skill']);
  assert.deepEqual(native.servers.map((item) => item.name), ['fixture-mcp']);
  const health = await f.workspace.extensionHealth(session.id);
  assert.equal(health.supportLevel, 'supported');
  assert.deepEqual(
    health.mcp.map((item) => [item.name, item.configuredScope, item.runtimePresence, item.health]),
    [['fixture-mcp', 'project', 'observed', 'healthy'], ['offline-mcp', 'project', 'not_observed', 'unavailable']],
  );
  assert.deepEqual(
    health.skills.map((item) => [item.name, item.configuredScope, item.runtimeScope, item.health]),
    [['fixture-skill', 'project', 'repo', 'healthy']],
  );
  const archived = f.workspace.archiveSession(session.id);
  assert.equal(archived.pinned, true);
  assert.equal(typeof archived.archivedAt, 'number');
  assert.equal(existsSync(session.worktreePath), true);
  assert.doesNotMatch(readFileSync(join(f.userData, 'workspace-state-v3.json'), 'utf8'), /attachment body/);
});

test('Agent Team runs 2-4 isolated members, follow-up, synthesis, failure recovery, and stop', async (t) => {
  const prompts = [];
  const clients = [];
  let interrupts = 0;
  class TeamClient {
    constructor(options) { this.options = options; clients.push(options); }
    async start() { return { authenticated: true, authSource: 'chatgpt' }; }
    async startThread(cwd) { return 'thread:' + cwd; }
    async startTurn(_threadId, prompt) { prompts.push({ cwd: this.options.cwd, prompt }); return 'turn:' + prompts.length; }
    async interrupt() { interrupts += 1; }
    async stop() { this.options.onExit(null); }
  }
  const f = fixture(t, { createClient: (options) => new TeamClient(options) });
  const project = f.workspace.addProject(f.repository);
  const team = await f.workspace.createTeam(project.id, 'Implement and review a bounded feature', [
    { role: 'Implementer', runtimeType: 'codex', providerId: 'provider:chatgpt', model: 'auto' },
    { role: 'Reviewer', runtimeType: 'codex', providerId: 'provider:chatgpt', model: 'auto' },
    { role: 'Tester', runtimeType: 'codex', providerId: 'provider:chatgpt', model: 'auto' },
    { role: 'Security', runtimeType: 'codex', providerId: 'provider:chatgpt', model: 'auto' },
  ]);
  assert.equal(team.memberSessionIds.length, 4);
  assert.deepEqual(team.members.map((member) => member.role), ['Implementer', 'Reviewer', 'Tester', 'Security']);
  assert.equal(new Set(team.memberSessionIds.map((id) => f.workspace.sessionWorktree(id))).size, 4);
  assert.equal(prompts.length, 4);
  assert.equal(f.workspace.snapshot().teams[0].status, 'running');

  const sessions = f.workspace.snapshot().sessions.filter((session) => team.memberSessionIds.includes(session.id));
  for (const [index, session] of sessions.entries()) {
    const options = clients.find((item) => item.cwd === session.worktreePath);
    options.onNotification('item/agentMessage/delta', { delta: `member-result-${index + 1}` });
    options.onNotification('turn/completed', { turn: { id: `initial-${index + 1}`, status: 'completed' } });
  }
  assert.equal(f.workspace.snapshot().teams[0].status, 'completed');

  const follow = await f.workspace.sendTeamMessage(team.id, 'Run a focused follow-up', [team.memberSessionIds[1]]);
  assert.deepEqual(follow.sentSessionIds, [team.memberSessionIds[1]]);
  assert.equal(prompts.length, 5);
  const reviewer = sessions.find((session) => session.id === team.memberSessionIds[1]);
  const reviewerOptions = clients.find((item) => item.cwd === reviewer.worktreePath);
  reviewerOptions.onNotification('item/agentMessage/delta', { delta: 'review-follow-up-result' });
  reviewerOptions.onNotification('turn/completed', { turn: { id: 'follow-up', status: 'completed' } });

  const synthesis = await f.workspace.synthesizeTeam(team.id, team.memberSessionIds[0]);
  assert.equal(synthesis.coordinatorSessionId, team.memberSessionIds[0]);
  assert.match(prompts.at(-1).prompt, /member-result-1/);
  assert.match(prompts.at(-1).prompt, /review-follow-up-result/);
  assert.doesNotMatch(JSON.stringify(f.workspace.snapshot().teams[0]), /member-result|follow-up-result/);
  const coordinator = sessions.find((session) => session.id === team.memberSessionIds[0]);
  const coordinatorOptions = clients.find((item) => item.cwd === coordinator.worktreePath);
  coordinatorOptions.onNotification('item/agentMessage/delta', { delta: 'verified-team-summary' });
  coordinatorOptions.onNotification('turn/completed', { turn: { id: 'synthesis', status: 'completed' } });
  assert.equal(f.workspace.snapshot().teams[0].synthesisCount, 1);
  assert.equal(f.workspace.snapshot().teams[0].status, 'completed');

  const failingOptions = clients.find((item) => item.cwd === sessions[2].worktreePath);
  failingOptions.onExit('fixture member crash');
  assert.equal(f.workspace.snapshot().teams[0].status, 'partial_failure');
  await f.workspace.retryTeamMember(team.id, sessions[2].id);
  assert.match(prompts.at(-1).prompt, /避免重复已经完成的副作用/);
  const stop = await f.workspace.stopTeam(team.id);
  assert.deepEqual(stop.requestedSessionIds, [sessions[2].id]);
  assert.equal(interrupts, 1);
  const replacementOptions = clients.filter((item) => item.cwd === sessions[2].worktreePath).at(-1);
  replacementOptions.onNotification('turn/completed', { turn: { id: 'retry', status: 'interrupted' } });
  assert.equal(f.workspace.snapshot().teams[0].status, 'stopped');

  await f.workspace.sendTeamMessage(team.id, 'Keep this harmless turn active for restart recovery', [sessions[0].id]);
  assert.equal(f.workspace.snapshot().teams[0].status, 'running');
  await f.workspace.shutdown();
  const reopened = new InteractiveWorkspace({
    userDataPath: f.userData,
    emit: () => {},
    discoverCodex: () => ({ executable: process.execPath, prefixArgs: [], version: '0.146.0', source: 'path-executable' }),
    createClient: (options) => new TeamClient(options),
  });
  assert.equal(reopened.snapshot().teams[0].status, 'stopped');
  assert.deepEqual(reopened.snapshot().teams[0].members.map((member) => member.role), ['Implementer', 'Reviewer', 'Tester', 'Security']);
  await reopened.shutdown();
});

test('resizable work panel, terminal shell, and diagnostics persist without prompts or credentials', async (t) => {
  const f = fixture(t);
  const project = f.workspace.addProject(f.repository);
  const session = await f.workspace.createSession(project.id);
  const settings = f.workspace.updateSettings({ workPanelWidth: 900, terminalHeight: 999, terminalShell: 'pwsh' });
  assert.equal(settings.workPanelWidth, 720);
  assert.equal(settings.terminalHeight, 560);
  assert.equal(settings.terminalShell, 'pwsh');
  assert.equal(f.workspace.terminalShell(), 'pwsh');
  const pinned = f.workspace.pinProject(project.id, true);
  assert.equal(pinned.pinned, true);
  assert.equal(f.workspace.snapshot().projects.find((item) => item.id === project.id)?.pinned, true);
  const diagnostic = f.workspace.diagnosticSummary();
  assert.equal(diagnostic.projects, 1);
  assert.equal(diagnostic.sessions, 1);
  assert.equal(diagnostic.containsCredentials, false);
  assert.equal(diagnostic.containsPrompts, false);
  assert.equal(diagnostic.containsUserSource, false);
  const persisted = readFileSync(join(f.userData, 'workspace-state-v3.json'), 'utf8');
  assert.match(persisted, /"workPanelWidth": 720/);
  assert.match(persisted, /"terminalHeight": 560/);
  assert.match(persisted, /"terminalShell": "pwsh"/);
  assert.doesNotMatch(JSON.stringify(diagnostic), new RegExp(session.worktreePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('scheduled task launches an isolated Runtime Session and records activity', async (t) => {
  const f = fixture(t);
  const project = f.workspace.addProject(f.repository);
  const task = f.workspace.saveScheduledTask({
    name: 'Fixture scheduled review', projectId: project.id, prompt: 'Review the fixture changes', intervalMinutes: 60,
    enabled: true,
  });
  const launched = await f.workspace.runScheduledTask(task.id);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const permission = f.workspace.snapshot().permissions[0];
  if (permission) f.workspace.decidePermission(permission.id, 'deny_once');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(typeof launched.sessionId, 'string');
  assert.equal(f.workspace.snapshot().sessions.some((session) => session.id === launched.sessionId), true);
  assert.equal(f.emitted.some((event) => event.type === 'scheduled.task.started'), true);
  assert.equal(f.workspace.listScheduledTasks(project.id)[0].enabled, true);
});
