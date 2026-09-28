import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
const { CodexAppServerClient } = await import('../../apps/desktop/dist/electron-main/codex-app-server-client.js');
const { ApiRuntimeClient, verifyApiProvider } = await import('../../apps/desktop/dist/electron-main/api-runtime.js');
const { runtimeFailure } = await import('../../packages/runtime-core/dist/index.js');
const marker = 'fixture-arbitrary-credential/+';

test('runtime failures handle nested, cyclic and unusual secret strings', () => {
  const cycle = { message: marker }; cycle.cause = cycle;
  for (const error of [marker, { cause: { stderr: marker } }, cycle, { get message() { throw new Error(marker); } }, marker.repeat(10_000)]) {
    const summary = runtimeFailure(error);
    assert.equal(summary.category, 'runtime_error');
    assert.equal(JSON.stringify(summary).includes(marker), false);
  }
  assert.equal(runtimeFailure({ cause: { message: `401 ${marker}` } }).category, 'authentication_failed');
  assert.equal(runtimeFailure(new Error(`timeout ${marker}`)).category, 'timeout');
  assert.equal(runtimeFailure({ name: 'AbortError', error: marker }).category, 'interrupted');
});

test('Codex RPC failures, deadlines and chunked stderr keep secrets out of pending requests', { timeout: 15_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tsukiori-error-matrix-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const script = join(directory, 'fixture.mjs');
  writeFileSync(script, `
    import { createInterface } from 'node:readline';
    const marker = ${JSON.stringify(marker)};
    const send = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + '\\n');
    createInterface({ input: process.stdin }).on('line', line => {
      const { id, method } = JSON.parse(line);
      if (method === 'initialize') send(id, {});
      if (method === 'account/read') send(id, { account: {} });
      if (method === 'fixture/reject') process.stdout.write(JSON.stringify({ id, error: { message: marker, data: { cause: marker } } }) + '\\n');
      if (method === 'fixture/crash') {
        process.stderr.write(marker.slice(0, 12));
        process.stderr.write(marker.slice(12) + marker.repeat(400), () => process.exit(9));
      }
    });
  `);
  const exits = [];
  const client = new CodexAppServerClient({
    cwd: directory, launch: { executable: process.execPath, prefixArgs: [script], version: '0.146.0', source: 'path-executable' },
    onNotification() {}, onApproval: async () => ({}), onExit: error => exits.push(error),
  });
  t.after(() => client.stop());
  await client.start();
  for (const [method, expected] of [['fixture/reject', /失败/], ['fixture/wait', /超时/], ['fixture/crash', /Runtime/]]) {
    await assert.rejects(() => client.request(method, {}, method === 'fixture/wait' ? 100 : 5_000), error => {
      assert.match(error.message, expected);
      assert.equal((error.stack + JSON.stringify(error)).includes(marker), false);
      return true;
    });
  }
  assert.equal(JSON.stringify(exits).includes(marker), false);
});

const provider = { id: 'provider:matrix', kind: 'openai-compatible', apiFormat: 'openai-completions', baseUrl: 'https://example.invalid', models: ['fixture'], maxTokens: 100, contextWindow: 1000 };
function blockedStream(_model, _context, options) {
  return { async *[Symbol.asyncIterator]() {
    if (!options.signal.aborted) await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
    throw new Error(`private abort response ${marker}`);
  } };
}

test('provider probe deadlines report timeout without raw abort details', async () => {
  assert.deepEqual(await verifyApiProvider(provider, marker, { timeoutMs: 10, stream: blockedStream }), { ok: false, category: 'timeout' });
});

test('explicit API cancellation remains distinguishable from request failure', async () => {
  const controller = new AbortController();
  const client = new ApiRuntimeClient({ stream: blockedStream });
  const events = [];
  const running = client.runTurn({ turnId: 'fixture', provider, modelId: 'fixture', apiKey: marker, history: [], signal: controller.signal, callbacks: { onEvent: (type, payload) => events.push({ type, payload }) } });
  controller.abort();
  await assert.rejects(running, error => error.name === 'AbortError' && error.category === 'aborted' && !error.message.includes(marker));
  assert.equal(JSON.stringify(events).includes(marker), false);
});
