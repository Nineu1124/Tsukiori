import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { codexHistoryFixture } from './codex-history-fixture.mjs';

const input = (f) => ({ name: 'managed', scope: 'project', projectId: f.session.projectId, transport: 'stdio', command: 'node', args: [] });

test('MCP changes keep an active turn alive and resume the same thread with new config on the next turn', async (t) => {
  const f = await codexHistoryFixture(t);
  const first = await f.workspace.sendPrompt(f.session.id, 'fixture first');
  const record = f.workspace.saveMcp(input(f));
  assert.equal((await f.workspace.extensionHealth(f.session.id)).mcpConfigState, 'pending_next_turn');
  assert.equal(f.clients.length, 1);
  assert.equal(f.calls.some((call) => call[1] === 'stop'), false);
  f.clients[0].complete(first.turnId);
  const second = await f.workspace.sendPrompt(f.session.id, 'fixture second');
  assert.deepEqual(f.calls.filter((call) => call[0] === 1).map((call) => call[1]), ['initialize', 'thread/resume', 'turn/start']);
  assert.ok(f.clients[1].options.configArgs.some((arg) => arg.endsWith('.command="node"')));
  f.clients[1].complete(second.turnId);
  f.workspace.deleteMcp(record.id);
  const third = await f.workspace.sendPrompt(f.session.id, 'fixture third');
  assert.equal(f.clients[2].options.configArgs.some((arg) => arg.startsWith('mcp_servers.')), false);
  assert.equal(f.calls.filter((call) => call[1] === 'thread/start').length, 1);
  f.clients[2].complete(third.turnId);
});

test('a failed MCP save leaves the existing client usable without a restart', async (t) => {
  const f = await codexHistoryFixture(t);
  const record = f.workspace.saveMcp(input(f));
  const first = await f.workspace.sendPrompt(f.session.id, 'fixture first');
  f.clients[0].complete(first.turnId);
  writeFileSync(join(f.repository, '.mcp.json'), '{"mcpServers":{"managed":{"command":"external"}}}');
  assert.throws(() => f.workspace.saveMcp({ ...record, command: 'new' }), /外部修改/);
  const second = await f.workspace.sendPrompt(f.session.id, 'fixture second');
  assert.equal(f.clients.length, 1);
  f.clients[0].complete(second.turnId);
});

test('failed reload retains the native thread, reports a safe error and can retry', async (t) => {
  const f = await codexHistoryFixture(t);
  const first = await f.workspace.sendPrompt(f.session.id, 'fixture first');
  f.clients[0].complete(first.turnId);
  f.workspace.saveMcp(input(f));
  f.control.resume = () => { throw new Error('private-mcp-reload-error'); };
  await assert.rejects(f.workspace.sendPrompt(f.session.id, 'fixture retry'), /Runtime 执行失败/);
  assert.equal(f.calls.filter((call) => call[1] === 'turn/start').length, 1);
  const failed = f.workspace.snapshot().sessions.find((session) => session.id === f.session.id);
  assert.equal(failed.threadId, 'thread:fixture');
  assert.equal(failed.status, 'error');
  assert.doesNotMatch(JSON.stringify(f.emitted), /private-mcp-reload-error/);
  f.control.resume = undefined;
  const retry = await f.workspace.sendPrompt(f.session.id, 'fixture retry');
  f.clients.at(-1).complete(retry.turnId);
  assert.equal((await f.workspace.extensionHealth(f.session.id)).mcpConfigState, 'loaded');
});
