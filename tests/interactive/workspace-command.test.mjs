import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { MAX_WORKSPACE_COMMAND_BYTES, validateWorkspaceCommand, workspaceCommandTypes } from '../../apps/desktop/dist/electron-main/workspace-command.js';
import { commandHarness } from './workspace-command-harness.mjs';

test('production IPC rejects unknown commands and malformed envelopes before dispatch', async () => {
  let executions = 0;
  const workspace = new Proxy({}, { get() { executions += 1; throw new Error('must not dispatch'); } });
  const f = commandHarness(workspace);
  const cyclic = { type: 'send_prompt' }; cyclic.self = cyclic;
  const getter = Object.defineProperty({ type: 'send_prompt' }, 'text', { enumerable: true, get() { throw new Error('must not read accessor'); } });
  for (const value of [null, [], false, 'send_prompt', {}, { type: 3 }, { type: 'unknown' },
    { type: 'constructor' }, cyclic, getter, { type: 'send_prompt', text: 1n },
    { type: 'update_settings', settings: new Date() }]) {
    const result = await f.invoke(value);
    assert.equal(result.ok, false);
    assert.match(result.code, /^(invalid_command|unknown_command)$/);
  }
  assert.equal(executions, 0);
});

test('production IPC rejects coercion, unknown fields, invalid enums and nested arguments', async () => {
  let executions = 0;
  const f = commandHarness(new Proxy({}, { get() { executions += 1; throw new Error('must not dispatch'); } }));
  const invalid = [
    { type: 'send_prompt', sessionId: { toString: 'session:a' }, text: 'hello' },
    { type: 'pin_session', sessionId: 'session:a', pinned: 'true' },
    { type: 'terminal_resize', sessionId: 'session:a', columns: '120', rows: 28 },
    { type: 'poll_events', afterSequence: -1 }, { type: 'poll_events', afterSequence: Infinity },
    { type: 'create_session', projectId: 'project:a', runtimeType: 'invented-runtime' },
    { type: 'create_session', projectId: 'project:a', permissionMode: 'acceptEverything' },
    { type: 'update_settings', settings: { autoUpdate: 'false' } },
    { type: 'update_settings', settings: { ownerId: 'other' } },
    { type: 'stage', sessionId: 'session:a', paths: [17] },
    { type: 'stage', sessionId: 'session:a', paths: Array(3) },
    { type: 'create_team', projectId: 'project:a', goal: 'goal', agents: [{ role: 'one' }] },
    { type: 'create_team', projectId: 'project:a', goal: 'goal', agents: [{ role: 'one' }, { model: [] }] },
    { type: 'save_mcp', name: 'local', scope: 'project', transport: 'stdio', command: 'node' },
    { type: 'save_mcp', name: 'local', transport: 'stdio' },
    { type: 'save_provider', name: 'test', kind: 'openai', models: [false] },
    { type: 'save_scheduled_task', name: 'task', projectId: 'project:a', prompt: 'prompt', intervalMinutes: 4 },
    { type: 'computer_use_request', action: { type: 'keyboard_type', text: 6 } },
    { type: 'computer_use_request', action: { type: 'screenshot', execute: 'shell' } },
    { type: 'git_status', sessionId: 'session:a', shell: 'unexpected' },
  ];
  for (const command of invalid) assert.equal((await f.invoke(command)).code, 'invalid_command', command.type);
  assert.equal(executions, 0);
});

test('IPC budget admits existing maximum prompt, memory and clipboard content including JSON escapes', async () => {
  const received = [];
  const f = commandHarness({
    async sendPrompt(id, text) { received.push(['prompt', id, text.length]); return { turnId: 'turn:fixture' }; },
    saveMemory(id, path, content) { received.push(['memory', id, path, Buffer.byteLength(content)]); return { path }; },
  }, { clipboard: { writeText(text) { received.push(['clipboard', text.length]); } } });
  const commands = [
    { type: 'send_prompt', sessionId: 'session:a', text: '中'.repeat(64000) },
    { type: 'save_memory', projectId: 'project:a', path: 'MEMORY.md', content: '\u0001'.repeat(512 * 1024) },
    { type: 'copy_text', text: '\u0001'.repeat(512000) },
  ];
  for (const command of commands) {
    assert.ok(Buffer.byteLength(JSON.stringify(command)) > 128 * 1024);
    assert.ok(Buffer.byteLength(JSON.stringify(command)) <= MAX_WORKSPACE_COMMAND_BYTES);
    assert.equal((await f.invoke(command)).ok, true);
  }
  assert.equal(received.length, 3);
  for (const command of [
    { ...commands[0], text: 'a'.repeat(64001) },
    { ...commands[1], content: 'a'.repeat(512 * 1024 + 1) },
    { ...commands[2], text: 'a'.repeat(512001) },
  ]) assert.equal((await f.invoke(command)).code, 'invalid_command');
  assert.equal(received.length, 3);
  assert.equal((await f.invoke({ type: 'copy_text', text: '\u0001'.repeat(800000) })).code, 'command_too_large');
});

test('production IPC preserves valid optional settings and array arguments without coercion', async () => {
  const received = [];
  const f = commandHarness({
    async createSession(id, options) { received.push({ id, ...options }); return { id: 'session:new' }; },
    stage(id, paths) { received.push({ id, paths }); },
    updateSettings(settings) { received.push(settings); return settings; },
    saveProvider(provider) { received.push(provider); return provider; },
  });
  assert.equal((await f.invoke({ type: 'create_session', projectId: 'project:a', runtimeType: 'api', providerId: undefined })).ok, true);
  assert.equal((await f.invoke({ type: 'stage', sessionId: 'session:a', paths: ['中文 file.txt', 'src/index.ts'] })).ok, true);
  assert.equal((await f.invoke({ type: 'update_settings', settings: { showThinking: false, workPanelWidth: 350.5 } })).ok, true);
  assert.equal((await f.invoke({ type: 'save_provider', name: 'fixture', kind: 'google', apiFormat: 'google-generative-ai', contextWindow: 1000000, maxTokens: 8192, models: ['fixture-model'], baseUrl: '', enabled: true })).ok, true);
  assert.equal(received[0].runtimeType, 'api');
  assert.equal(JSON.stringify(received[1].paths), JSON.stringify(['中文 file.txt', 'src/index.ts']));
  assert.equal(received[2].showThinking, false);
  assert.equal(received.length, 4);
});

test('every formal Main command branch is represented in the contract', () => {
  const source = readFileSync(new URL('../../apps/desktop/electron-main/main.ts', import.meta.url), 'utf8');
  const formal = source.slice(source.indexOf('const workspace = interactiveWorkspace;'), source.indexOf("ipcMain.handle('daemon:status'"));
  const branches = [...formal.matchAll(/command\.type === '([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(branches)].sort(), [...workspaceCommandTypes].sort());
  for (const type of ['revert', 'archive', 'integrate', 'answer_input']) {
    assert.equal(validateWorkspaceCommand({ type }).code, 'unknown_command');
  }
});
