import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { openCodeRequestFailure } from '../../packages/adapter-opencode/dist/session-bridge.js';

test('request diagnostics use fixed categories and never carry transport messages or URLs', () => {
  const closed = new TypeError('private-url-and-input', { cause: { code: 'UND_ERR_SOCKET', message: 'private-detail' } });
  assert.equal(openCodeRequestFailure(closed), 'connection_closed');
  assert.equal(openCodeRequestFailure({ cause: { code: 'ECONNREFUSED' } }), 'connection_refused');
  assert.equal(openCodeRequestFailure({ name: 'TimeoutError', message: 'private-timeout' }), 'request_timeout');
  assert.equal(openCodeRequestFailure({ code: 'private-code' }), 'request_failed');
  assert.equal(openCodeRequestFailure(null), 'request_failed');
});

test('crash injection records its trigger and the actual child exit without recording input', { timeout: 10_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tsukiori-crash-evidence-'));
  const lifecyclePath = join(directory, 'lifecycle.jsonl');
  const config = join(directory, 'config.json');
  writeFileSync(config, JSON.stringify({ version: '1.18.4', crashOnPromptCount: 2, lifecyclePath }));
  const child = spawn(process.execPath, [join(process.cwd(), 'tests/fixtures/opencode/fake-opencode-cli.mjs'), config, 'serve'], {
    cwd: directory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, OPENCODE_SERVER_USERNAME: 'fixture', OPENCODE_SERVER_PASSWORD: 'local-test-only' },
  });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    rmSync(directory, { recursive: true, force: true });
  });
  const lines = createInterface({ input: child.stdout });
  const [line] = await once(lines, 'line');
  const base = line.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  assert.ok(base);
  const headers = { authorization: 'Basic ' + Buffer.from('fixture:local-test-only').toString('base64'), 'content-type': 'application/json' };
  const request = (path, body) => fetch(new URL(path, base), { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(3_000) });
  const session = await (await request('/session', { title: 'fixture' })).json();
  const promptPath = `/session/${session.id}/prompt_async`;
  assert.equal((await request(promptPath, { parts: [{ type: 'text', text: 'private-input-canary' }] })).status, 204);
  await assert.rejects(request(promptPath, { parts: [{ type: 'text', text: 'private-crash-canary' }] }));
  assert.deepEqual(await exited, [23, null]);
  const evidence = readFileSync(lifecyclePath, 'utf8');
  assert.deepEqual(evidence.trim().split('\n').map((entry) => JSON.parse(entry)), [
    { event: 'prompt_received', count: 1 }, { event: 'prompt_received', count: 2 },
    { event: 'crash_injected', code: 23, count: 2 }, { event: 'exit', code: 23 },
  ]);
  assert.doesNotMatch(evidence, /private-|local-test-only|authorization/);
});
