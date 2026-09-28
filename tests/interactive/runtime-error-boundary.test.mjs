import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
const { CodexAppServerClient } = await import('../../apps/desktop/dist/electron-main/codex-app-server-client.js');
const { ClaudeCodeClient, ClaudeStreamJsonMapper } = await import('../../packages/adapter-claude/dist/index.js');
const marker = 'fixture-private-runtime-detail/+';

test('real child stderr cannot escape Codex or Claude error callbacks', { timeout: 15_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tsukiori-error-boundary-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const script = join(directory, 'fail.mjs');
  writeFileSync(script, `process.stdin.once('data', () => { process.stderr.write(${JSON.stringify(marker)}, () => process.exit(7)); });`);
  const exits = [];
  const codex = new CodexAppServerClient({
    cwd: directory, launch: { executable: process.execPath, prefixArgs: [script], version: '0.146.0', source: 'path-executable' },
    onNotification() {}, onApproval: async () => ({}), onExit: (error) => exits.push(error),
  });
  try {
    await assert.rejects(() => codex.start(), (error) => !error.message.includes(marker) && /Runtime/.test(error.message));
  } finally { await codex.stop(); }
  const claude = new ClaudeCodeClient({ executable: process.execPath, prefixArgs: [script], version: '2.1.226', source: 'explicit' });
  const events = [];
  await new Promise((resolve) => claude.startTurn({
    cwd: directory, sessionId: randomUUID(), resume: false, prompt: 'fixture', model: 'sonnet', permissionMode: 'plan', authMode: 'native',
    onEvent: (type, payload) => events.push({ type, payload }), onExit: (error) => { exits.push(error); resolve(); },
  }));
  await claude.stop();
  assert.equal(events.some((event) => event.type === 'turn.completed' && event.payload.status === 'failed'), true);
  assert.equal(JSON.stringify({ events, exits }).includes(marker), false);
});

test('nested Claude failure results keep their category without the original body', () => {
  const mapper = new ClaudeStreamJsonMapper();
  const events = mapper.mapLine(JSON.stringify({ type: 'result', is_error: true, error: { cause: { message: `401 ${marker}` } } }));
  assert.equal(events[0].payload.status, 'failed');
  assert.match(events[0].payload.error, /认证失败/);
  assert.equal(JSON.stringify(events).includes(marker), false);
});
