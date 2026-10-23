import assert from 'node:assert/strict';
import { join } from 'node:path';
import { symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { commandHarness } from './workspace-command-harness.mjs';
import { historyFixture } from './history-fixture.mjs';
import { codexHistoryFixture } from './codex-history-fixture.mjs';

test('production commands require the current window, its main frame and the expected local document', async () => {
  let executions = 0;
  const f = commandHarness({ pollEvents() { executions += 1; return { events: [] }; } });
  const command = { type: 'poll_events', afterSequence: 0 };
  const forgedWindow = { ...f.sender };
  const cases = [
    { sender: forgedWindow, senderFrame: f.sender.mainFrame },
    { sender: f.sender, senderFrame: { ...f.sender.mainFrame } },
    { sender: f.sender, senderFrame: null },
  ];
  for (const event of cases) assert.equal((await f.invoke(command, event)).code, 'untrusted_command_source');
  const trustedUrl = f.sender.mainFrame.url;
  for (const url of ['https://example.invalid/', trustedUrl + '?embedded=1', 'file:///other/index.html']) {
    f.sender.mainFrame.url = url;
    assert.equal((await f.invoke(command)).code, 'untrusted_command_source');
  }
  f.sender.mainFrame.url = trustedUrl;
  f.context.mainWindow.isDestroyed = () => true;
  assert.equal((await f.invoke(command)).code, 'untrusted_command_source');
  f.context.mainWindow.isDestroyed = () => false;
  assert.equal(executions, 0);
  assert.equal((await f.invoke(command)).ok, true);
  assert.equal(executions, 1);
});

test('desktop command version accepts legacy omission and version 1, rejecting explicit incompatible versions', async () => {
  let executions = 0;
  const f = commandHarness({ pollEvents() { executions += 1; return { events: [] }; } });
  for (const protocolVersion of [0, 2, '1', null, { version: 1 }]) {
    assert.equal((await f.invoke({ type: 'poll_events', protocolVersion })).code, 'unsupported_command_version');
  }
  assert.equal(executions, 0);
  assert.equal((await f.invoke({ type: 'poll_events' })).ok, true);
  assert.equal((await f.invoke({ type: 'poll_events', protocolVersion: 1 })).ok, true);
  assert.equal(executions, 2);
});

test('concurrent production dispatch preserves each invocation result when completion order reverses', async () => {
  const pending = new Map();
  const f = commandHarness({ sendPrompt(sessionId) {
    const deferred = Promise.withResolvers(); pending.set(sessionId, deferred); return deferred.promise;
  } });
  let firstResolved = false;
  const first = f.invoke({ type: 'send_prompt', sessionId: 'session:first', text: 'first' }).then((result) => {
    firstResolved = true; return result;
  });
  const second = f.invoke({ type: 'send_prompt', sessionId: 'session:second', text: 'second' });
  pending.get('session:second').resolve({ turnId: 'turn:second' });
  assert.equal((await second).turnId, 'turn:second');
  assert.equal(firstResolved, false);
  pending.get('session:first').resolve({ turnId: 'turn:first' });
  assert.equal((await first).turnId, 'turn:first');
});

test('production input rejects malformed IDs and traversal before a service receives them', async () => {
  let executions = 0;
  const f = commandHarness(new Proxy({}, { get() { executions += 1; throw new Error('must not dispatch'); } }));
  for (const sessionId of ['', '../session:a', 'session:a\0', 'session:a\n', 'session:a/other', 17, {}]) {
    assert.equal((await f.invoke({ type: 'read_file', sessionId, path: 'README.md' })).code, 'invalid_command');
  }
  for (const path of ['../outside.md', '..\\outside.md', 'safe/../../outside.md', 'C:\\outside.md', '\\\\server\\share\\file', '/absolute', 'README.md\0']) {
    assert.equal((await f.invoke({ type: 'read_file', sessionId: 'session:a', path })).code, 'invalid_command');
  }
  assert.equal((await f.invoke({ type: 'read_file', sessionId: 'session:a', path: 'README.md', ownerId: 'forged' })).code, 'invalid_command');
  assert.equal(executions, 0);
});

test('formal file dispatch enforces real session existence and rejects a junction into another worktree', async (t) => {
  const f = await historyFixture(t);
  const ipc = commandHarness(f.workspace);
  const second = await f.workspace.createSession(f.session.projectId, {
    runtimeType: 'api', providerId: f.session.providerId, model: 'fixture',
  });
  writeFileSync(join(f.session.worktreePath, 'owned.txt'), 'first-worktree');
  writeFileSync(join(second.worktreePath, 'owned.txt'), 'second-worktree');
  const firstRead = await ipc.invoke({ type: 'read_file', sessionId: f.session.id, path: 'owned.txt' });
  const secondRead = await ipc.invoke({ type: 'read_file', sessionId: second.id, path: 'owned.txt' });
  assert.equal(firstRead.file.content, 'first-worktree');
  assert.equal(secondRead.file.content, 'second-worktree');
  const missing = await ipc.invoke({ type: 'read_file', sessionId: 'session:missing', path: 'owned.txt' });
  assert.equal(missing.code, 'command_failed');
  assert.match(missing.message, /Session 不存在/);
  const junction = join(f.session.worktreePath, 'other-worktree');
  symlinkSync(second.worktreePath, junction, 'junction');
  try {
    const escaped = await ipc.invoke({ type: 'read_file', sessionId: f.session.id, path: 'other-worktree/owned.txt' });
    assert.equal(escaped.code, 'command_failed');
    assert.match(escaped.message, /越出 Session Worktree/);
    assert.doesNotMatch(JSON.stringify(escaped), /second-worktree/);
  } finally { unlinkSync(junction); }
  assert.equal(f.histories.length, 0, 'file commands never start a model request');
});

test('production permission replies preserve the snapshot string epoch and resolve only the addressed pending request', async (t) => {
  const f = await codexHistoryFixture(t);
  await f.workspace.sendPrompt(f.session.id, 'offline fixture');
  const ipc = commandHarness(f.workspace);
  const approval = f.clients[0].options.onApproval;
  const first = approval({ requestId: 'native:first', method: 'item/fileChange/requestApproval', params: {} });
  const second = approval({ requestId: 'native:second', method: 'item/fileChange/requestApproval', params: {} });
  const requests = f.workspace.snapshot().permissions;
  assert.equal(requests.length, 2);
  assert.notEqual(requests[0].id, requests[1].id);
  assert.equal(requests[0].connectionEpoch, 'interactive-codex');
  assert.equal(typeof requests[1].connectionEpoch, 'string');
  // This is the payload used by Renderer -> fixed Preload -> Main. The epoch
  // remains a string; accepting its shape does not implement epoch ownership.
  const reply = (request, decision) => ({ type: 'permission', requestId: request.id,
    connectionEpoch: request.connectionEpoch, decision });
  for (const connectionEpoch of [17, {}, 'bad\nepoch']) {
    assert.equal((await ipc.invoke({ ...reply(requests[0], 'allow_once'), connectionEpoch })).code, 'invalid_command');
  }
  const invalid = await ipc.invoke({ type: 'permission', requestId: 'approval:missing', decision: 'allow_once' });
  assert.equal(invalid.code, 'command_failed');
  assert.equal(f.workspace.snapshot().permissions.length, 2);
  assert.equal((await ipc.invoke(reply(requests[1], 'deny_once'))).ok, true);
  assert.equal((await second).decision, 'decline');
  assert.equal(f.workspace.snapshot().permissions.length, 1);
  assert.equal((await ipc.invoke(reply(requests[0], 'allow_once'))).ok, true);
  assert.equal((await first).decision, 'accept');
  assert.equal((await ipc.invoke(reply(requests[0], 'allow_once'))).code, 'command_failed');
  assert.equal(f.workspace.snapshot().permissions.length, 0);
});
