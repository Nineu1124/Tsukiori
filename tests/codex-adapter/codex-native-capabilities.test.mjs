import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { LocalDatabase } = await import(pathToFileURL(join(root, 'packages/database/dist/index.js')).href);
const { ExecutionEnvironmentRegistry, GitProbe } = await import(
  pathToFileURL(join(root, 'packages/project-manager/dist/index.js')).href
);
const { CodexRuntimeAdapter } = await import(
  pathToFileURL(join(root, 'packages/adapter-codex/dist/index.js')).href
);

const schemaRoot = join(root, 'tests', 'fixtures', 'codex', '0.146.0');
const fakeCli = join(root, 'tests', 'fixtures', 'codex', 'fake-codex-cli.mjs');

function fixture(t, config = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'tsukiori-codex-capability-'));
  const configPath = join(directory, 'fake-codex.json');
  writeFileSync(configPath, JSON.stringify({
    version: '0.146.0',
    accountType: 'chatgpt',
    requiresOpenaiAuth: true,
    ...config,
  }));
  const database = new LocalDatabase({
    filePath: join(directory, 'state.db'),
    blobRoot: join(directory, 'blobs'),
  });
  let clock = 1_800_002_000_000;
  let serial = 0;
  const now = () => ++clock;
  const id = () => 'capability-id-' + ++serial;
  const environments = new ExecutionEnvironmentRegistry(database, {
    gitProbe: new GitProbe(),
    now,
  });
  const environment = environments.registerWindowsNative({ homePath: directory });
  const adapter = new CodexRuntimeAdapter(database, environments, {
    executionEnvironmentId: environment.id,
    schemaManifestPath: join(schemaRoot, 'schema-manifest.json'),
    schemaBundlePath: join(schemaRoot, 'codex_app_server_protocol.schemas.json'),
    candidates: () => [{
      executable: process.execPath,
      prefixArgs: [fakeCli, configPath],
      source: 'explicit',
    }],
    now,
    id,
    daemonBootId: 'daemon:capability',
  });
  t.after(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, database, adapter };
}

test('published T4.3 fixture is sanitized and models all support presentation states', () => {
  const result = JSON.parse(readFileSync(join(root, 'tests/fixtures/codex/t4.3-result.json'), 'utf8'));
  assert.equal(result.task, 'T4.3');
  assert.deepEqual(result.presentationSupportLevels, [
    'supported',
    'experimental',
    'degraded',
    'unsupported',
    'unknown',
  ]);
  assert.equal(result.nativeCapabilitiesPromotedToCommon, false);
  assert.equal(result.sandbox.enforcementLevel, 'unknown');
  assert.equal(result.sandbox.securityClaim, 'not_inferred');
  assert.equal(result.realLocalProbe.mcp.serverCount, 3);
  assert.equal(result.realLocalProbe.skills.enabledCount, 22);
  assert.equal(result.realLocalProbe.sandboxReadiness.enforcementLevel, 'unknown');
  assert.equal(result.realLocalProbe.authentication.authSource, 'none');
  assert.equal(result.containsCredentials, false);
  assert.doesNotMatch(JSON.stringify(result), /Bearer\s+|-----BEGIN|sk-[A-Za-z0-9]/);
});

test('Probe summarizes config MCP Skills Sandbox and auth without raw native content', async (t) => {
  const f = fixture(t);
  const profile = f.adapter.probe();
  const handle = await f.adapter.start(profile.id, f.directory);
  const snapshot = await handle.probeCapabilities(f.directory);

  assert.equal(snapshot.runtimeType, 'codex');
  assert.equal(snapshot.runtimeVersion, '0.146.0');
  assert.equal(snapshot.authenticated, true);
  assert.equal(snapshot.authSource, 'chatgpt');
  assert.deepEqual(snapshot.configuration, {
    supportLevel: 'supported',
    sandboxMode: 'workspace-write',
    approvalPolicy: 'on-request',
    layerCount: 1,
  });
  assert.deepEqual(snapshot.skills, {
    supportLevel: 'supported',
    entryCount: 1,
    enabledCount: 1,
    disabledCount: 1,
    errorCount: 0,
    scopes: { repo: 1, user: 1 },
  });
  assert.deepEqual(snapshot.mcp, {
    supportLevel: 'supported',
    serverCount: 1,
    toolCount: 1,
    resourceCount: 0,
    resourceTemplateCount: 0,
    authStatuses: { oAuth: 1 },
  });
  assert.deepEqual(snapshot.sandbox, {
    supportLevel: 'supported',
    readiness: 'ready',
    configuredMode: 'workspace-write',
    enforcementLevel: 'unknown',
    securityClaim: 'not_inferred',
  });
  assert.equal(snapshot.capabilities.length, 5);
  assert.equal(snapshot.capabilities.every((item) => item.scope === 'runtime_native'), true);
  assert.equal(snapshot.capabilities.every((item) => item.enforcementLevel === 'unknown'), true);
  assert.equal(Object.hasOwn(snapshot, 'commonCapabilities'), false);
  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, /fixture-enabled|fixture-disabled|SKILL\.md|fixture-mcp|C:\\fixture/);
  assert.equal(f.database.listRuntimeAudits('codex').some((audit) => (
    audit.action === 'capability_probe' && audit.outcome === 'succeeded'
  )), true);
  await handle.stop();
});

test('Probe degrades partial results and keeps unavailable native capability unknown', async (t) => {
  const f = fixture(t, {
    skillErrors: 1,
    sandboxReadiness: 'updateRequired',
    failCapabilityMethods: ['mcpServerStatus/list'],
  });
  const profile = f.adapter.probe();
  const handle = await f.adapter.start(profile.id, f.directory);
  const snapshot = await handle.probeCapabilities(f.directory);

  assert.equal(snapshot.skills.supportLevel, 'degraded');
  assert.equal(snapshot.skills.errorCount, 1);
  assert.equal(snapshot.sandbox.supportLevel, 'degraded');
  assert.equal(snapshot.sandbox.readiness, 'updateRequired');
  assert.equal(snapshot.sandbox.enforcementLevel, 'unknown');
  assert.equal(snapshot.mcp.supportLevel, 'unknown');
  const mcp = snapshot.capabilities.find((item) => item.id === 'mcp');
  assert.equal(mcp.commitment, 'not_committed');
  assert.equal(mcp.scope, 'runtime_native');
  assert.equal(snapshot.capabilities.some((item) => item.supportLevel === 'unsupported'), false);
  await handle.stop();
});