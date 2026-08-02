import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { LocalDatabase } = await import(pathToFileURL(join(root, 'packages/database/dist/index.js')).href);
const { ExecutionEnvironmentRegistry, GitProbe } = await import(
  pathToFileURL(join(root, 'packages/project-manager/dist/index.js')).href
);
const { OpenCodeRuntimeAdapter, OpenCodeAdapterError } = await import(
  pathToFileURL(join(root, 'packages/adapter-opencode/dist/index.js')).href
);
const fakeCli = join(root, 'tests', 'fixtures', 'opencode', 'fake-opencode-cli.mjs');

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function fixture(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'tsukiori-opencode-adapter-'));
  const repository = join(directory, 'repository');
  const worktree1 = join(directory, 'worktree-1');
  const worktree2 = join(directory, 'worktree-2');
  mkdirSync(repository);
  git(['init', '-b', 'main'], repository);
  git(['config', 'user.name', 'Tsukiori Fixture'], repository);
  git(['config', 'user.email', 'fixture@invalid.local'], repository);
  writeFileSync(join(repository, 'README.md'), '# fixture\n');
  git(['add', 'README.md'], repository);
  git(['commit', '-m', 'fixture'], repository);
  git(['worktree', 'add', '-b', 'fixture-one', worktree1], repository);
  git(['worktree', 'add', '-b', 'fixture-two', worktree2], repository);

  const docBody = JSON.stringify({
    openapi: '3.1.0',
    info: { title: 'OpenCode fixture', version: '1.18.4' },
  });
  const configPath = join(directory, 'fake-opencode.json');
  const manifestPath = join(directory, 'openapi-manifest.json');
  const writeConfig = (value) => writeFileSync(configPath, JSON.stringify({
    version: '1.18.4',
    credentialCount: 1,
    docBody,
    docContentType: 'application/json',
    ...value,
  }));
  writeConfig(overrides);
  writeFileSync(manifestPath, JSON.stringify({
    runtimeVersion: '1.18.4',
    contentType: 'application/json',
    sha256: createHash('sha256').update(docBody).digest('hex'),
    bytes: Buffer.byteLength(docBody),
  }));

  const database = new LocalDatabase({
    filePath: join(directory, 'state.db'),
    blobRoot: join(directory, 'blobs'),
  });
  let clock = 1_800_003_000_000;
  let serial = 0;
  const now = () => ++clock;
  const id = () => 'opencode-id-' + ++serial;
  const environments = new ExecutionEnvironmentRegistry(database, {
    gitProbe: new GitProbe(),
    now,
  });
  const environment = environments.registerWindowsNative({ homePath: directory });
  const adapters = [];
  function adapter(options = {}) {
    const instance = new OpenCodeRuntimeAdapter(database, environments, {
      executionEnvironmentId: environment.id,
      openApiManifestPath: manifestPath,
      candidates: () => [{
        executable: process.execPath,
        prefixArgs: [fakeCli, configPath],
        source: 'explicit',
      }],
      now,
      id,
      daemonBootId: 'daemon:opencode-test',
      ...options,
    });
    adapters.push(instance);
    return instance;
  }
  t.after(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  });
  return {
    directory, repository, worktree1, worktree2, database,
    configPath, writeConfig, manifestPath, adapter,
  };
}

test('published T3.1 fixture is sanitized and records the DeepSeek data destination', () => {
  const result = JSON.parse(readFileSync(
    join(root, 'tests/fixtures/opencode/t3.1-result.json'),
    'utf8',
  ));
  assert.equal(result.task, 'T3.1');
  assert.equal(result.runtimeVersion, '1.18.4');
  assert.equal(result.worktreeScopedServers, 2);
  assert.equal(result.deepSeek.providerId, 'dpsk');
  assert.equal(result.deepSeek.destinationHost, 'api.deepseek.com');
  assert.equal(result.deepSeek.realSessionCompleted, true);
  assert.equal(result.credentials.persisted, false);
  assert.equal(result.credentials.commandLineArguments, false);
  assert.equal(result.containsCredentials, false);
  assert.doesNotMatch(JSON.stringify(result), /Bearer\s+|Basic\s+[A-Za-z0-9+/=]+|sk-[A-Za-z0-9]/);
});

test('discovery probes canonical path version authentication and compatibility', (t) => {
  const f = fixture(t);
  const adapter = f.adapter();
  const profile = adapter.probe();
  assert.equal(profile.runtimeType, 'opencode');
  assert.equal(profile.discoveredVersion, '1.18.4');
  assert.equal(profile.compatibility, 'supported');
  assert.equal(profile.authenticated, true);
  assert.equal(profile.authSource, 'apikey');
  assert.equal(profile.schemaVersion, '1.18.4');
  assert.match(profile.schemaHash, /^sha256:/);
  const audits = f.database.listRuntimeAudits('opencode');
  assert.equal(audits.some((item) => item.action === 'discover'), true);
  assert.equal(audits.some((item) => (
    item.action === 'auth_probe'
    && item.detail.credentialCount === 1
    && item.detail.rawOutputPersisted === false
  )), true);
});

test('two Worktrees start independent password-protected Servers and stop cleanly', async (t) => {
  const f = fixture(t);
  const adapter = f.adapter();
  const profile = adapter.probe();
  const [first, second] = await Promise.all([
    adapter.start(profile.id, f.worktree1),
    adapter.start(profile.id, f.worktree2),
  ]);
  assert.equal(first.providers.workspacePathVerified, true);
  assert.equal(second.providers.workspacePathVerified, true);
  assert.equal(first.providers.vcsDetected, true);
  const firstRecord = f.database.readRuntimeHandle(first.id);
  const secondRecord = f.database.readRuntimeHandle(second.id);
  assert.equal(firstRecord.state, 'ready');
  assert.equal(secondRecord.state, 'ready');
  assert.notEqual(firstRecord.pid, secondRecord.pid);
  const selection = first.selectProvider('dpsk', 'deepseek-v4-flash');
  assert.deepEqual({
    provider: selection.providerId,
    model: selection.modelId,
    destination: selection.destinationHost,
    source: selection.credentialSource,
    support: selection.supportLevel,
  }, {
    provider: 'dpsk',
    model: 'deepseek-v4-flash',
    destination: 'api.deepseek.com',
    source: 'config',
    support: 'supported',
  });
  assert.throws(
    () => first.selectProvider('offline', 'local'),
    OpenCodeAdapterError,
  );
  const persisted = JSON.stringify({
    profiles: f.database.listRuntimeProfiles('opencode'),
    handles: f.database.listRuntimeHandles(profile.id),
    audits: f.database.listRuntimeAudits('opencode'),
  });
  assert.doesNotMatch(persisted, /OPENCODE_SERVER_PASSWORD|Authorization|Basic\s|TSUKIORI_PROVIDER_OK/);
  await Promise.all([first.stop(), second.stop()]);
  assert.equal(f.database.readRuntimeHandle(first.id).state, 'stopped');
  assert.equal(f.database.readRuntimeHandle(second.id).state, 'stopped');
});

test('Provider verification completes without persisting prompt output or credentials', async (t) => {
  const f = fixture(t);
  const adapter = f.adapter();
  const profile = adapter.probe();
  const handle = await adapter.start(profile.id, f.worktree1);
  const result = await handle.verifyProviderConnection('dpsk', 'deepseek-v4-flash');
  assert.deepEqual(result, {
    providerId: 'dpsk',
    modelId: 'deepseek-v4-flash',
    destinationHost: 'api.deepseek.com',
    completed: true,
    messageCount: 2,
    containsCredentials: false,
  });
  const audits = f.database.listRuntimeAudits('opencode');
  assert.equal(audits.some((item) => (
    item.action === 'provider_verify'
    && item.outcome === 'succeeded'
    && item.detail.persistedPromptOrOutput === false
  )), true);
  assert.doesNotMatch(JSON.stringify(audits), /TSUKIORI_PROVIDER_OK|message-user|message-assistant/);
  await handle.stop();
});

test('OpenAPI mismatch and Worktree scope mismatch fail closed', async (t) => {
  const f = fixture(t);
  const adapter = f.adapter();
  const profile = adapter.probe();
  f.writeConfig({ docBody: '{"tampered":true}' });
  await assert.rejects(adapter.start(profile.id, f.worktree1), /OpenAPI lock mismatch/);
  const failed = f.database.listRuntimeHandles(profile.id).find((item) => item.state === 'failed');
  assert.ok(failed);
  f.writeConfig({ wrongWorkspace: f.repository });
  const secondAdapter = f.adapter();
  await assert.rejects(
    secondAdapter.start(profile.id, f.worktree1),
    /Worktree scope/,
  );
});

test('newer older and unauthenticated probes remain explicit degraded states', async (t) => {
  const f = fixture(t);
  const adapter = f.adapter();
  const profile = adapter.probe();
  f.writeConfig({ version: '1.19.0' });
  const newer = adapter.reProbe(profile.id);
  assert.equal(newer.compatibility, 'unverified_newer');
  await assert.rejects(adapter.start(profile.id, f.worktree1), /unverified_newer/);
  f.writeConfig({ version: '1.17.0' });
  assert.equal(adapter.reProbe(profile.id).compatibility, 'incompatible_older');
  f.writeConfig({ version: '1.18.4', credentialCount: 0 });
  const unauthenticated = adapter.reProbe(profile.id);
  assert.equal(unauthenticated.authenticated, false);
  assert.equal(unauthenticated.authSource, 'none');
});