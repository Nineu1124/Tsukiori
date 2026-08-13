import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const adapterModule = await import(pathToFileURL(join(root, 'packages/adapter-claude/dist/index.js')).href);
const {
  CLAUDE_MAXIMUM_TESTED_VERSION,
  ClaudeAdapterError,
  ClaudeCodeClient,
  discoverClaudeLaunch,
  probeClaudeAuth,
} = adapterModule;
const fakeCli = join(root, 'tests', 'fixtures', 'claude', 'fake-claude-cli.mjs');

function fixture(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'tsukiori-claude-adapter-'));
  const logPath = join(directory, 'invocations.jsonl');
  const configPath = join(directory, 'config.json');
  writeFileSync(configPath, JSON.stringify({ version: CLAUDE_MAXIMUM_TESTED_VERSION, logPath, ...overrides }));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const candidate = { executable: process.execPath, prefixArgs: [fakeCli, configPath], source: 'explicit' };
  return { directory, logPath, candidate };
}

test('discovery locks the tested version, capabilities, and sanitized native auth source', (t) => {
  const f = fixture(t);
  const launch = discoverClaudeLaunch({ candidates: [f.candidate] });
  assert.equal(launch.version, CLAUDE_MAXIMUM_TESTED_VERSION);
  assert.equal(launch.compatibility, 'supported');
  for (const capability of ['stream-json', 'session-resume', 'hook-events', 'subagent-forwarding', 'mcp-config', 'skills']) {
    assert.equal(launch.capabilities.includes(capability), true, capability);
  }
  assert.deepEqual(probeClaudeAuth(launch), {
    authenticated: true, source: 'claude-oauth', method: 'oauth_token', provider: 'firstParty',
  });
});

test('published B1 capability matrix is versioned, partial, and sanitized', () => {
  const result = JSON.parse(readFileSync(join(root, 'tests', 'fixtures', 'claude', 'b1-native-result.json'), 'utf8'));
  assert.equal(result.task, 'B1');
  assert.equal(result.testedVersion, CLAUDE_MAXIMUM_TESTED_VERSION);
  assert.equal(result.capabilities.sessionResume, 'supported');
  assert.equal(result.capabilities.permissionBroker, 'degraded');
  assert.equal(result.capabilities.fork, 'degraded');
  assert.equal(result.capabilities.checkpoint, 'degraded');
  assert.equal(result.checkpointEvidence.gitTranscriptRecoveryContract, true);
  assert.equal(result.checkpointEvidence.resumeSessionAtFixtureContract, true);
  assert.equal(result.checkpointEvidence.realCliMessageRewindE2e, false);
  assert.equal(result.containsCredentials, false);
  assert.equal(result.containsIdentity, false);
  assert.equal(result.containsPrompt, false);
  assert.equal(result.containsUserSource, false);
});

test('native mode streams thinking, text, tools, completion, and does not inherit API keys', async (t) => {
  const f = fixture(t);
  const launch = discoverClaudeLaunch({ candidates: [f.candidate] });
  const client = new ClaudeCodeClient(launch);
  const events = [];
  let exitError;
  const exited = new Promise((resolveExit) => {
    const sessionId = randomUUID();
    client.startTurn({
      cwd: f.directory, sessionId, resume: false, prompt: 'fixture-success', model: 'sonnet',
      permissionMode: 'manual', authMode: 'native', environment: { ANTHROPIC_API_KEY: 'must-not-cross-native-boundary' },
      onEvent: (type, payload) => events.push({ type, payload }),
      onExit: (error) => { exitError = error; resolveExit(); },
    });
  });
  await exited;
  assert.equal(exitError, null);
  for (const type of ['turn.started', 'session.started', 'assistant.thinking.delta', 'assistant.delta', 'tool.event', 'turn.completed']) {
    assert.equal(events.some((event) => event.type === type), true, type);
  }
  const started = events.find((event) => event.type === 'turn.started');
  assert.match(started.payload.connectionEpoch, /^claude-epoch:/);
  assert.equal(started.payload.runtimeSequence, 1);
  assert.equal(events.at(-1).payload.status, 'completed');
  const invocation = JSON.parse(readFileSync(f.logPath, 'utf8').trim());
  assert.equal(invocation.apiKeyPresent, false);
  assert.deepEqual(invocation.providerEnvironmentKeys, []);
  assert.equal(invocation.inputType, 'user');
  assert.equal(invocation.parentToolUseId, null);
  assert.equal(invocation.args.includes('--bare'), false);
  assert.deepEqual(invocation.args.slice(invocation.args.indexOf('--input-format'), invocation.args.indexOf('--input-format') + 2), ['--input-format', 'stream-json']);
  assert.deepEqual(invocation.args.slice(invocation.args.indexOf('--permission-prompt-tool'), invocation.args.indexOf('--permission-prompt-tool') + 2), ['--permission-prompt-tool', 'stdio']);
  assert.equal(invocation.args.includes('--include-hook-events'), true);
  assert.equal(invocation.args.includes('--forward-subagent-text'), true);
  await client.stop();
});

test('stdio permission requests are redacted, correlated, and answered once', async (t) => {
  const f = fixture(t);
  const client = new ClaudeCodeClient(discoverClaudeLaunch({ candidates: [f.candidate] }));
  const run = async (decision) => {
    const events = [];
    let turnId = '';
    let requestId = '';
    await new Promise((resolveExit, rejectExit) => {
      turnId = client.startTurn({
        cwd: f.directory, sessionId: randomUUID(), resume: false,
        prompt: `fixture-permission-${decision}`, model: 'sonnet', permissionMode: 'manual', authMode: 'native',
        onEvent: (type, payload) => {
          events.push({ type, payload });
          if (type === 'permission.requested') {
            requestId = payload.requestId;
            queueMicrotask(() => {
              try { client.respondToPermission(turnId, requestId, decision); }
              catch (error) { rejectExit(error); }
            });
          }
        },
        onExit: (error) => error ? rejectExit(new Error(error)) : resolveExit(),
      });
    });
    const requested = events.find((event) => event.type === 'permission.requested');
    assert.equal(requested.payload.tool, 'Bash');
    assert.equal(requested.payload.input.command, 'echo safe');
    assert.equal(requested.payload.input.api_key, '[REDACTED]');
    assert.throws(() => client.respondToPermission(turnId, requestId, decision), /已结束|不存在|失效/);
  };
  await run('allow');
  await run('deny');
  const lines = readFileSync(f.logPath, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  const responses = lines.filter((line) => line.permissionBehavior);
  assert.deepEqual(responses.map((line) => line.permissionBehavior), ['allow', 'deny']);
  assert.equal(responses[0].updatedCommand, 'echo safe');
  assert.equal(Object.hasOwn(responses[1], 'updatedCommand'), false);
  await client.stop();
});

test('interrupt invalidates pending Claude permissions before ending the Turn', async (t) => {
  const f = fixture(t);
  const client = new ClaudeCodeClient(discoverClaudeLaunch({ candidates: [f.candidate] }));
  const events = [];
  let turnId = '';
  await new Promise((resolveExit) => {
    turnId = client.startTurn({
      cwd: f.directory, sessionId: randomUUID(), resume: false,
      prompt: 'fixture-permission-interrupt', model: 'sonnet', permissionMode: 'manual', authMode: 'native',
      onEvent: (type, payload) => {
        events.push({ type, payload });
        if (type === 'permission.requested') queueMicrotask(() => client.interrupt(turnId));
      },
      onExit: () => resolveExit(),
    });
  });
  assert.equal(events.some((event) => event.type === 'permission.invalidated' && event.payload.reason === 'turn_interrupted'), true);
  assert.equal(events.some((event) => event.type === 'turn.completed' && event.payload.status === 'interrupted'), true);
  await client.stop();
});

test('Provider mode is isolated with --bare, uses resume, and receives only the selected key', async (t) => {
  const f = fixture(t);
  const client = new ClaudeCodeClient(discoverClaudeLaunch({ candidates: [f.candidate] }));
  await new Promise((resolveExit) => client.startTurn({
    cwd: f.directory, sessionId: randomUUID(), resume: true, prompt: 'fixture-provider', model: 'sonnet',
    permissionMode: 'plan', authMode: 'provider', environment: { ANTHROPIC_API_KEY: 'fixture-provider-key' },
    onEvent: () => undefined, onExit: () => resolveExit(),
  }));
  const invocation = JSON.parse(readFileSync(f.logPath, 'utf8').trim());
  assert.equal(invocation.apiKeyPresent, true);
  assert.deepEqual(invocation.providerEnvironmentKeys, ['ANTHROPIC_API_KEY']);
  assert.equal(invocation.args.includes('--bare'), true);
  assert.equal(invocation.args.includes('--resume'), true);
  await client.stop();
});

test('Claude failure retry and parallel Turns never inherit the previous Provider environment', async (t) => {
  const f = fixture(t);
  const client = new ClaudeCodeClient(discoverClaudeLaunch({ candidates: [f.candidate] }));
  await new Promise((resolveExit) => client.startTurn({
    cwd: f.directory, sessionId: randomUUID(), resume: false, prompt: 'fixture-fail', model: 'sonnet',
    permissionMode: 'plan', authMode: 'provider', environment: { ANTHROPIC_API_KEY: 'fixture-first-key' },
    onEvent: () => undefined, onExit: () => resolveExit(),
  }));
  const parallel = [
    { ANTHROPIC_API_KEY: 'fixture-parallel-api-key' },
    { ANTHROPIC_AUTH_TOKEN: 'fixture-parallel-auth-token' },
  ];
  await Promise.all(parallel.map((environment) => new Promise((resolveExit) => client.startTurn({
    cwd: f.directory, sessionId: randomUUID(), resume: false, prompt: 'fixture-provider-retry', model: 'sonnet',
    permissionMode: 'plan', authMode: 'provider', environment,
    onEvent: () => undefined, onExit: () => resolveExit(),
  }))));
  const invocations = readFileSync(f.logPath, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  assert.deepEqual(invocations[0].providerEnvironmentKeys, ['ANTHROPIC_API_KEY']);
  assert.deepEqual(invocations.slice(1).map((item) => item.providerEnvironmentKeys).sort(), [
    ['ANTHROPIC_API_KEY'], ['ANTHROPIC_AUTH_TOKEN'],
  ].sort());
  await client.stop();
});

test('fork resumes the source runtime session but adopts the new runtime session id', async (t) => {
  const forkSessionId = '00000000-0000-4000-8000-000000000099';
  const sourceSessionId = '00000000-0000-4000-8000-000000000042';
  const f = fixture(t, { forkSessionId });
  const client = new ClaudeCodeClient(discoverClaudeLaunch({ candidates: [f.candidate] }));
  const events = [];
  await new Promise((resolveExit, rejectExit) => client.startTurn({
    cwd: f.directory, sessionId: randomUUID(), resume: false, forkFromSessionId: sourceSessionId,
    resumeSessionAt: 'message:checkpoint',
    prompt: 'fixture-fork', model: 'sonnet', permissionMode: 'manual', authMode: 'native',
    onEvent: (type, payload) => events.push({ type, payload }),
    onExit: (error) => error ? rejectExit(new Error(error)) : resolveExit(),
  }));
  const invocation = JSON.parse(readFileSync(f.logPath, 'utf8').trim());
  assert.deepEqual(invocation.args.slice(invocation.args.indexOf('--resume'), invocation.args.indexOf('--resume') + 3), [
    '--resume', sourceSessionId, '--fork-session',
  ]);
  assert.equal(invocation.args.includes('--session-id'), false);
  assert.deepEqual(invocation.args.slice(invocation.args.indexOf('--resume-session-at'), invocation.args.indexOf('--resume-session-at') + 2), [
    '--resume-session-at', 'message:checkpoint',
  ]);
  assert.equal(events.find((event) => event.type === 'turn.started').payload.forkedFromRuntimeSessionId, sourceSessionId);
  assert.equal(events.find((event) => event.type === 'turn.started').payload.resumedAtRuntimeMessageId, 'message:checkpoint');
  assert.equal(events.find((event) => event.type === 'session.started').payload.runtimeSessionId, forkSessionId);
  await client.stop();
});

test('interrupt and process failure always close the Turn and redact stderr secrets', async (t) => {
  const f = fixture(t);
  const client = new ClaudeCodeClient(discoverClaudeLaunch({ candidates: [f.candidate] }));
  const interruptedEvents = [];
  await new Promise((resolveExit) => {
    const turnId = client.startTurn({
      cwd: f.directory, sessionId: randomUUID(), resume: false, prompt: 'fixture-hang', model: 'sonnet',
      permissionMode: 'plan', authMode: 'native', onEvent: (type, payload) => interruptedEvents.push({ type, payload }),
      onExit: () => resolveExit(),
    });
    setTimeout(() => client.interrupt(turnId), 100);
  });
  assert.equal(interruptedEvents.some((event) => event.type === 'turn.completed' && event.payload.status === 'interrupted'), true);

  const failedEvents = [];
  let failure = '';
  await new Promise((resolveExit) => client.startTurn({
    cwd: f.directory, sessionId: randomUUID(), resume: false, prompt: 'fixture-fail', model: 'sonnet',
    permissionMode: 'plan', authMode: 'provider', environment: { ANTHROPIC_API_KEY: 'fixture-key' },
    onEvent: (type, payload) => failedEvents.push({ type, payload }),
    onExit: (error) => { failure = error; resolveExit(); },
  }));
  assert.match(failure, /REDACTED/);
  assert.doesNotMatch(failure, /fixture-super-secret-value/);
  assert.equal(failedEvents.some((event) => event.type === 'turn.completed' && event.payload.status === 'failed'), true);
  await client.stop();
});

test('unverified newer versions fail closed unless explicitly enabled', (t) => {
  const f = fixture(t, { version: '2.1.227' });
  const launch = discoverClaudeLaunch({ candidates: [f.candidate] });
  assert.equal(launch.compatibility, 'unverified_newer');
  const client = new ClaudeCodeClient(launch);
  assert.throws(() => client.startTurn({
    cwd: f.directory, sessionId: randomUUID(), resume: false, prompt: 'fixture', model: 'sonnet',
    permissionMode: 'plan', onEvent: () => undefined, onExit: () => undefined,
  }), ClaudeAdapterError);
});
