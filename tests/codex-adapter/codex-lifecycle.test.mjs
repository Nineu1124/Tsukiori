import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { LocalDatabase } = await import(pathToFileURL(join(root, 'packages/database/dist/index.js')).href);
const { ExecutionEnvironmentRegistry, GitProbe } = await import(pathToFileURL(join(root, 'packages/project-manager/dist/index.js')).href);
const { CodexRuntimeAdapter, CodexAdapterError } = await import(pathToFileURL(join(root, 'packages/adapter-codex/dist/index.js')).href);
const schemaRoot = join(root, 'tests', 'fixtures', 'codex', '0.146.0');
const schemaManifestPath = join(schemaRoot, 'schema-manifest.json');
const schemaBundlePath = join(schemaRoot, 'codex_app_server_protocol.schemas.json');
const fakeCli = join(root, 'tests', 'fixtures', 'codex', 'fake-codex-cli.mjs');

function fixture(t, config = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'tsukiori-codex-adapter-'));
  const configPath = join(directory, 'fake-codex.json');
  const writeConfig = (value) => writeFileSync(configPath, JSON.stringify({
    version: '0.146.0', accountType: 'chatgpt', requiresOpenaiAuth: true, ...value,
  }));
  writeConfig(config);
  const database = new LocalDatabase({ filePath: join(directory, 'state.db'), blobRoot: join(directory, 'blobs') });
  let clock = 1_800_000_600_000;
  let serial = 0;
  const now = () => ++clock;
  const id = () => 'id-' + ++serial;
  const gitProbe = new GitProbe();
  const environments = new ExecutionEnvironmentRegistry(database, { gitProbe, now });
  const environment = environments.registerWindowsNative({ homePath: directory });
  const adapters = [];
  function adapter(overrides = {}) {
    const instance = new CodexRuntimeAdapter(database, environments, {
      executionEnvironmentId: environment.id,
      schemaManifestPath,
      schemaBundlePath,
      candidates: () => [{
        executable: process.execPath, prefixArgs: [fakeCli, configPath], source: 'explicit',
      }],
      now, id, daemonBootId: 'daemon:test', ...overrides,
    });
    adapters.push(instance);
    return instance;
  }
  t.after(() => {
    try { database.close(); } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  return { directory, configPath, writeConfig, database, environments, environment, adapter };
}

async function waitFor(predicate, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error('condition timed out');
}

test('published T4.1 fixture is versioned, sanitized, and keeps credentials local', () => {
  const result = JSON.parse(readFileSync(join(root, 'tests/fixtures/codex/t4.1-result.json'), 'utf8'));
  assert.equal(result.task, 'T4.1');
  assert.equal(result.testedVersion, '0.146.0');
  assert.equal(result.schema.experimental, false);
  assert.equal(result.authentication.credentialsPersisted, false);
  assert.equal(result.newerVersionPolicy.startEnabledByDefault, false);
  assert.equal(result.containsCredentials, false);
});

test('discover, locked initialize, auth probe, stop, and ProcessRecord are auditable', async (t) => {
  const f = fixture(t);
  const adapter = f.adapter();
  const profile = adapter.probe();
  assert.equal(profile.discoveredVersion, '0.146.0');
  assert.equal(profile.compatibility, 'supported');
  assert.equal(profile.schemaVersion, '0.146.0');
  assert.equal(profile.schemaHash, 'sha256:776ab888b2e673311a4c53ed086d66b061dcfdc8ca595b4cf43220c2b3d04368');
  assert.equal(profile.discoverySource, 'explicit');

  const handle = await adapter.start(profile.id, f.directory);
  assert.deepEqual(handle.auth, { authenticated: true, source: 'chatgpt', requiresOpenaiAuth: true });
  const ready = f.database.readRuntimeHandle(handle.id);
  assert.equal(ready.state, 'ready');
  assert.equal(ready.platformFamily, 'windows');
  assert.equal(ready.platformOs, 'windows');
  assert.match(ready.userAgent, /^fake-codex\/0\.146\.0$/);
  const storedProfile = f.database.readRuntimeProfile(profile.id);
  assert.equal(storedProfile.authenticated, true);
  assert.equal(storedProfile.authSource, 'chatgpt');
  assert.equal(storedProfile.requiresOpenaiAuth, true);
  const persistedRuntime = JSON.stringify({
    profiles: f.database.listRuntimeProfiles('codex'),
    handles: f.database.listRuntimeHandles(profile.id),
    audits: f.database.listRuntimeAudits('codex'),
  });
  assert.doesNotMatch(persistedRuntime, /private-account|fixture-plan|codex-home/);
  assert.equal(f.database.sqlite.prepare("SELECT status FROM process_records WHERE runtime_handle_id=?").get(handle.id).status, 'running');
  await handle.stop();
  const stopped = await waitFor(() => {
    const value = f.database.readRuntimeHandle(handle.id);
    return value?.state === 'stopped' ? value : null;
  });
  assert.equal(stopped.expectedExit, true);
  const actions = f.database.listRuntimeAudits('codex').map((audit) => audit.action);
  for (const action of ['discover', 'schema_lock', 'probe', 'start', 'initialize', 'auth_probe', 'stop', 'exit']) {
    assert.equal(actions.includes(action), true, action);
  }
});

test('initialize response that violates the locked version Schema fails closed', async (t) => {
  const f = fixture(t, { invalidInitialize: true });
  const adapter = f.adapter();
  const profile = adapter.probe();
  await assert.rejects(adapter.start(profile.id, f.directory), /locked Schema validation/);
  const failed = await waitFor(() => f.database.listRuntimeHandles(profile.id).find((handle) => handle.state === 'failed'));
  assert.equal(failed.state, 'failed');
  assert.equal(f.database.listRuntimeAudits('codex').some((audit) => (
    audit.action === 'start' && audit.outcome === 'failed'
  )), true);
});

test('unexpected app-server exit is recorded and can be re-probed', async (t) => {
  const f = fixture(t, { crashCode: 23 });
  const adapter = f.adapter();
  const profile = adapter.probe();
  const handle = await adapter.start(profile.id, f.directory);
  await assert.rejects(handle.request('fixture/crash'), /exited/);
  const exited = await waitFor(() => {
    const value = f.database.readRuntimeHandle(handle.id);
    return value?.state === 'exited' ? value : null;
  });
  assert.equal(exited.exitCode, 23);
  assert.equal(exited.expectedExit, false);
  assert.equal(f.database.listRuntimeAudits('codex').some((audit) => (
    audit.action === 'exit' && audit.outcome === 'failed' && audit.detail.exitCode === 23
  )), true);
  const reprobed = adapter.reProbe(profile.id);
  assert.equal(reprobed.compatibility, 'supported');
  assert.equal(reprobed.id, profile.id);
});

test('newer and older versions are degraded without starting an unverified process', async (t) => {
  const f = fixture(t);
  const adapter = f.adapter();
  const profile = adapter.probe();
  f.writeConfig({ version: '0.147.0' });
  const newer = adapter.reProbe(profile.id);
  assert.equal(newer.compatibility, 'unverified_newer');
  await assert.rejects(adapter.start(profile.id, f.directory), /unverified_newer/);
  assert.equal(f.database.listRuntimeHandles(profile.id).length, 0);
  f.writeConfig({ version: '0.145.0' });
  const older = adapter.reProbe(profile.id);
  assert.equal(older.compatibility, 'incompatible_older');
  await assert.rejects(adapter.start(profile.id, f.directory), /incompatible_older/);
});

test('tampered Schema bundle produces schema_mismatch compatibility', (t) => {
  const f = fixture(t);
  const tampered = join(f.directory, 'tampered-schema.json');
  writeFileSync(tampered, readFileSync(schemaBundlePath, 'utf8') + ' ');
  const profile = f.adapter({ schemaBundlePath: tampered }).probe();
  assert.equal(profile.compatibility, 'schema_mismatch');
  assert.equal(f.database.listRuntimeAudits('codex').some((audit) => (
    audit.action === 'schema_lock' && audit.outcome === 'failed'
  )), true);
});

test('Codex adapter errors have a stable public type', () => {
  assert.equal(new CodexAdapterError('fixture').name, 'CodexAdapterError');
});
