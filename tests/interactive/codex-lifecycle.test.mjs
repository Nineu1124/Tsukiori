import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { codexHistoryFixture } from './codex-history-fixture.mjs';
import { historyFixture } from './history-fixture.mjs';

test('two turns, restart, cancellation and a second restart retain the same Codex identity', async (t) => {
  const f = await codexHistoryFixture(t);
  for (let i = 0; i < 2; i++) {
    const turn = await f.workspace.sendPrompt(f.session.id, `fixture ${i}`);
    f.clients[0].complete(turn.turnId);
  }
  assert.equal(f.calls.filter((call) => call[1] === 'thread/start').length, 1);
  assert.equal(f.calls.some((call) => call[1] === 'thread/resume'), false);
  await f.workspace.shutdown();
  const restarted = f.open();
  const active = await restarted.sendPrompt(f.session.id, 'interrupt fixture');
  await restarted.interrupt(f.session.id);
  assert.deepEqual(f.calls.find((call) => call[1] === 'turn/interrupt'), [1, 'turn/interrupt', 'thread:fixture', active.turnId]);
  assert.equal(restarted.snapshot().sessions.find((s) => s.id === f.session.id).status, 'ready');
  await assert.rejects(restarted.interrupt(f.session.id), /没有可中断/);
  await restarted.shutdown();
  const again = f.open();
  const fourth = await again.sendPrompt(f.session.id, 'after cancellation');
  assert.equal(again.snapshot().sessions.find((s) => s.id === f.session.id).threadId, 'thread:fixture');
  assert.equal(again.snapshot().sessions.find((s) => s.id === f.session.id).turnCount, 4);
  f.clients[2].complete(fourth.turnId);
});

test('a crashed client can retry restoration and late callbacks cannot remove its replacement', async (t) => {
  const f = await codexHistoryFixture(t);
  const first = await f.workspace.sendPrompt(f.session.id, 'first fixture');
  f.clients[0].complete(first.turnId);
  f.clients[0].options.onExit('fixture process failure');
  f.control.resume = () => { throw new Error('fixture resume failure'); };
  await assert.rejects(f.workspace.sendPrompt(f.session.id, 'retry fixture'));
  f.control.resume = undefined;
  const active = await f.workspace.sendPrompt(f.session.id, 'recovered fixture');
  f.clients[1].options.onExit('late fixture exit');
  f.clients[1].complete('late-turn');
  assert.equal(f.workspace.snapshot().sessions.find((s) => s.id === f.session.id).status, 'running');
  await f.workspace.interrupt(f.session.id);
  assert.deepEqual(f.calls.find((call) => call[1] === 'turn/interrupt'), [2, 'turn/interrupt', 'thread:fixture', active.turnId]);
  assert.equal(f.calls.filter((call) => call[1] === 'thread/start').length, 1);
  assert.equal(f.calls.filter((call) => call[1] === 'thread/resume').length, 2);
});

test('concurrent capabilities and prompt requests wait for one initialization', async (t) => {
  const f = await codexHistoryFixture(t);
  let release;
  f.control.start = () => new Promise((resolve) => { release = resolve; });
  const capabilities = f.workspace.codexNativeCapabilities(f.session.id);
  const turn = f.workspace.sendPrompt(f.session.id, 'concurrent fixture');
  assert.deepEqual(f.calls, [[0, 'initialize']]);
  release();
  const [, started] = await Promise.all([capabilities, turn]);
  assert.equal(f.clients.length, 1);
  assert.equal(f.calls.filter((call) => call[1] === 'turn/start').length, 1);
  f.clients[0].complete(started.turnId);
});

test('formal workspace and real stdio client resume and interrupt an offline RPC server', async (t) => {
  const temporary = mkdtempSync(join(tmpdir(), 'tsukiori-rpc-lifecycle-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }));
  const script = join(temporary, 'server.mjs');
  const log = join(temporary, 'requests.jsonl');
  writeFileSync(script, `
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const loaded = new Set(); let turn = 0;
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (!request.id) return;
  appendFileSync(process.argv[2], JSON.stringify({ method: request.method, threadId: request.params.threadId, turnId: request.params.turnId }) + '\\n');
  let result = {};
  if (request.method === 'account/read') result = { account: { type: 'fixture' } };
  if (request.method === 'thread/start' || request.method === 'thread/resume') {
    const id = request.params.threadId ?? 'rpc-thread'; loaded.add(id); result = { thread: { id } };
  }
  if (request.method === 'turn/start') {
    if (!loaded.has(request.params.threadId)) return send({ id: request.id, error: { message: 'thread not resumed' } });
    result = { turn: { id: 'turn:' + process.pid + ':' + (++turn) } };
  }
  send({ id: request.id, result });
  if (request.method === 'turn/start') send({ method: 'turn/started', params: result });
  if (request.method === 'turn/interrupt') send({ method: 'turn/completed', params: { turn: { id: request.params.turnId, status: 'interrupted' } } });
});
`);
  const f = await historyFixture(t, { discoverCodex: () => ({ executable: process.execPath, prefixArgs: [script, log],
    version: '0.146.0', source: 'path-executable' }) });
  const session = await f.workspace.createSession(f.session.projectId, { runtimeType: 'codex', providerId: 'provider:chatgpt' });
  await f.workspace.sendPrompt(session.id, 'fixture first');
  await f.workspace.interrupt(session.id);
  await f.workspace.shutdown();
  const restarted = f.open();
  const turn = await restarted.sendPrompt(session.id, 'fixture second');
  await restarted.interrupt(session.id);
  await restarted.shutdown();
  const requests = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(requests.map((request) => request.method), [
    'initialize', 'account/read', 'thread/start', 'turn/start', 'turn/interrupt',
    'initialize', 'account/read', 'thread/resume', 'turn/start', 'turn/interrupt',
  ]);
  assert.equal(requests.at(-1).threadId, 'rpc-thread');
  assert.equal(requests.at(-1).turnId, turn.turnId);
  assert.equal(restarted.snapshot().sessions.find((s) => s.id === session.id).threadId, 'rpc-thread');
});
