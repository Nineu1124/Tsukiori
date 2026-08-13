import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const { CodexAppServerClient } = await import(
  new URL('../../apps/desktop/dist/electron-main/codex-app-server-client.js', import.meta.url)
);
const fakeCli = join(process.cwd(), 'tests', 'fixtures', 'codex', 'fake-codex-cli.mjs');

test('parallel Codex app-server children receive only their selected Provider environment', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tsukiori-codex-environment-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const previous = new Map();
  for (const key of ['ANTHROPIC_API_KEY','ANTHROPIC_BASE_URL','ANTHROPIC_MODEL','OPENAI_BASE_URL','OPENAI_MODEL','DEEPSEEK_API_KEY','OPENROUTER_API_KEY']) {
    previous.set(key, process.env[key]);
    process.env[key] = 'inherited-stale-' + key;
  }
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const clients = [];
  for (const index of [1, 2]) {
    const expectedOpenaiKey = 'fixture-selected-openai-key-' + index;
    const environmentLogPath = join(directory, 'environment-' + index + '.jsonl');
    const configPath = join(directory, 'config-' + index + '.json');
    writeFileSync(configPath, JSON.stringify({
      version: '0.146.0', accountType: 'apiKey', environmentLogPath, expectedOpenaiKey,
    }));
    clients.push({
      client: new CodexAppServerClient({
        cwd: directory,
        launch: { executable: process.execPath, prefixArgs: [fakeCli, configPath], version: '0.146.0', source: 'path-executable' },
        environment: { OPENAI_API_KEY: expectedOpenaiKey },
        onNotification: () => undefined,
        onApproval: async () => ({ decision: 'decline' }),
        onExit: () => undefined,
      }),
      environmentLogPath,
    });
  }
  await Promise.all(clients.map(({ client }) => client.start()));
  await Promise.all(clients.map(({ client }) => client.stop()));
  for (const { environmentLogPath } of clients) {
    const invocation = JSON.parse(readFileSync(environmentLogPath, 'utf8').trim());
    assert.deepEqual(invocation.providerEnvironmentKeys, ['OPENAI_API_KEY']);
    assert.equal(invocation.selectedKeyMatches, true);
  }
});
