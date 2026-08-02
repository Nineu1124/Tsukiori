import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { LocalDatabase } = await import(pathToFileURL(join(root, 'packages/database/dist/index.js')).href);
const { ExecutionEnvironmentRegistry, GitProbe, ProjectManager } = await import(
  pathToFileURL(join(root, 'packages/project-manager/dist/index.js')).href
);
const { WorktreeManager } = await import(pathToFileURL(join(root, 'packages/worktree-manager/dist/index.js')).href);
const { WorkspaceCoordinator } = await import(pathToFileURL(join(root, 'packages/workspace-manager/dist/index.js')).href);
const { PermissionBroker } = await import(pathToFileURL(join(root, 'packages/permission-broker/dist/index.js')).href);
const { GitDiffService, IntegrationMergeService } = await import(
  pathToFileURL(join(root, 'packages/git-service/dist/index.js')).href
);
const { OpenCodeRuntimeAdapter } = await import(
  pathToFileURL(join(root, 'packages/adapter-opencode/dist/index.js')).href
);
const { CodexRuntimeAdapter, CodexSessionBridge } = await import(
  pathToFileURL(join(root, 'packages/adapter-codex/dist/index.js')).href
);

const fakeOpenCode = join(root, 'tests', 'fixtures', 'opencode', 'fake-opencode-cli.mjs');
const fakeCodex = join(root, 'tests', 'fixtures', 'codex', 'fake-codex-cli.mjs');
const codexSchemaRoot = join(root, 'tests', 'fixtures', 'codex', '0.146.0');

function command(git, args) {
  return execFileSync(git, args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function waitFor(predicate, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error('Timed out waiting for dual Runtime state');
}

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'tsukiori-dual-runtime-'));
  const gitProbe = new GitProbe();
  const git = gitProbe.resolveWindowsGit();
  const repository = join(directory, 'repository');
  mkdirSync(repository);
  command(git, ['init', '--quiet', '--initial-branch=main', repository]);
  command(git, ['-C', repository, 'config', 'user.name', 'Dual Runtime Fixture']);
  command(git, ['-C', repository, 'config', 'user.email', 'dual-runtime@example.invalid']);
  writeFileSync(join(repository, 'README.md'), '# dual Runtime\n');
  command(git, ['-C', repository, 'add', '--', 'README.md']);
  command(git, ['-C', repository, 'commit', '--quiet', '-m', 'fixture base']);

  const docBody = JSON.stringify({ openapi: '3.1.0', info: { title: 'OpenCode fixture', version: '1.18.4' } });
  const openCodeConfig = join(directory, 'fake-opencode.json');
  const openCodeManifest = join(directory, 'openapi-manifest.json');
  writeFileSync(openCodeConfig, JSON.stringify({
    version: '1.18.4', credentialCount: 1, docBody, docContentType: 'application/json',
    writeFixtureFile: true, crashOnPromptCount: 6,
  }));
  writeFileSync(openCodeManifest, JSON.stringify({
    runtimeVersion: '1.18.4', contentType: 'application/json',
    sha256: createHash('sha256').update(docBody).digest('hex'), bytes: Buffer.byteLength(docBody),
  }));
  const codexConfig = join(directory, 'fake-codex.json');
  writeFileSync(codexConfig, JSON.stringify({
    version: '0.146.0', accountType: 'chatgpt', requiresOpenaiAuth: true,
    writeFixtureFile: true, fixtureFileName: 'codex-runtime.txt', turnDelayMs: 5,
  }));

  const database = new LocalDatabase({ filePath: join(directory, 'state.db'), blobRoot: join(directory, 'blobs') });
  let clock = 1_800_006_000_000;
  let serial = 0;
  const now = () => ++clock;
  const id = () => 'dual-id-' + ++serial;
  const environments = new ExecutionEnvironmentRegistry(database, { gitProbe, now });
  const environment = environments.registerWindowsNative({ gitExecutable: git, homePath: directory });
  const projects = new ProjectManager(database, environments, { gitProbe, now, id });
  const project = projects.add({ rootPath: repository, executionEnvironmentId: environment.id });
  const permissions = new PermissionBroker(database, { now, id });
  const openCodeAdapter = new OpenCodeRuntimeAdapter(database, environments, {
    executionEnvironmentId: environment.id, openApiManifestPath: openCodeManifest,
    candidates: () => [{ executable: process.execPath, prefixArgs: [fakeOpenCode, openCodeConfig], source: 'explicit' }],
    permissionBroker: permissions, now, id, daemonBootId: 'daemon:dual-runtime',
  });
  const codexAdapter = new CodexRuntimeAdapter(database, environments, {
    executionEnvironmentId: environment.id,
    schemaManifestPath: join(codexSchemaRoot, 'schema-manifest.json'),
    schemaBundlePath: join(codexSchemaRoot, 'codex_app_server_protocol.schemas.json'),
    candidates: () => [{ executable: process.execPath, prefixArgs: [fakeCodex, codexConfig], source: 'explicit' }],
    now, id, daemonBootId: 'daemon:dual-runtime',
  });
  const openCodeProfile = openCodeAdapter.probe();
  const codexProfile = codexAdapter.probe();
  const sessions = [
    { id: 'dual-opencode', runtimeType: 'opencode', profileId: openCodeProfile.id },
    { id: 'dual-codex-a', runtimeType: 'codex', profileId: codexProfile.id },
    { id: 'dual-codex-b', runtimeType: 'codex', profileId: codexProfile.id },
  ];
  for (const value of sessions) {
    database.saveSession({
      id: value.id, title: value.id, projectId: project.id, runtimeType: value.runtimeType,
      runtimeProfileId: value.profileId, lifecycle: 'active', activity: 'idle', health: 'healthy',
      writeMode: 'isolated-worktree', createdAt: now(), updatedAt: clock,
    });
  }
  const worktrees = new WorktreeManager(database, projects, environments, {
    worktreeRoot: join(directory, 'worktrees'), executionEnvironmentId: environment.id, now, id,
  });
  const workspaces = new WorkspaceCoordinator(database, projects, environments, worktrees, { now, id });
  const bindings = sessions.map((session) => workspaces.createWritableSessionWorkspace({
    sessionId: session.id, projectId: project.id, runtimeType: session.runtimeType, slug: session.id,
  }).binding);
  const gitService = new GitDiffService(database, projects, environments, { now, id });
  const integrations = new IntegrationMergeService({
    database, projects, environments, permissions,
    integrationRoot: join(directory, 'integrations'), now, id,
  });
  const handles = [];
  t.after(async () => {
    await Promise.all(handles.map((handle) => handle.stop().catch(() => undefined)));
    database.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  });
  return {
    directory, git, repository, database, environment, project, permissions,
    openCodeAdapter, codexAdapter, openCodeProfile, codexProfile,
    sessions, bindings, gitService, integrations, handles, now, id,
  };
}

test('published T4.5 fixture is sanitized and declares dual Runtime isolation', () => {
  const result = JSON.parse(readFileSync(join(root, 'tests/fixtures/dual-runtime/t4.5-result.json'), 'utf8'));
  assert.equal(result.task, 'T4.5');
  assert.equal(result.parallelSessions, 3);
  assert.deepEqual(result.runtimes, ['opencode/1.18.4', 'codex/0.146.0']);
  assert.equal(result.eventCrossTalkObserved, false);
  assert.equal(result.codeCrossContaminationObserved, false);
  assert.equal(result.containsCredentials, false);
  assert.equal(result.persistedPromptOrSource, false);
});

test('OpenCode and Codex run three isolated Sessions, merge two commits, and survive one Runtime crash', async (t) => {
  const f = fixture(t);
  const [openCodeHandle, codexHandleA, codexHandleB] = await Promise.all([
    f.openCodeAdapter.start(f.openCodeProfile.id, f.bindings[0].path),
    f.codexAdapter.start(f.codexProfile.id, f.bindings[1].path),
    f.codexAdapter.start(f.codexProfile.id, f.bindings[2].path),
  ]);
  f.handles.push(openCodeHandle, codexHandleA, codexHandleB);
  await openCodeHandle.createSession('dual-opencode', 'dpsk', 'deepseek-v4-flash', 'dual OpenCode');
  const codexBridgeA = new CodexSessionBridge(
    f.database, f.permissions, f.database.readRuntimeHandle(codexHandleA.id), { now: f.now, id: f.id },
  );
  const codexBridgeB = new CodexSessionBridge(
    f.database, f.permissions, f.database.readRuntimeHandle(codexHandleB.id), { now: f.now, id: f.id },
  );
  f.codexAdapter.bindProtocolBridge(codexHandleA.id, codexBridgeA);
  f.codexAdapter.bindProtocolBridge(codexHandleB.id, codexBridgeB);
  await Promise.all([
    codexBridgeA.startThread(codexHandleA, 'dual-codex-a', { cwd: f.bindings[1].path }),
    codexBridgeB.startThread(codexHandleB, 'dual-codex-b', { cwd: f.bindings[2].path }),
  ]);

  for (let round = 1; round <= 5; round += 1) {
    await Promise.all([
      openCodeHandle.startTurn('dual-opencode', 'sanitized fixture round ' + round),
      codexBridgeA.startTurn(codexHandleA, 'dual-codex-a', [{ type: 'text', text: 'fixture round ' + round }]),
      codexBridgeB.startTurn(codexHandleB, 'dual-codex-b', [{ type: 'text', text: 'fixture round ' + round }]),
    ]);
    await waitFor(() => f.sessions.every((session) => f.database.readSession(session.id).activity === 'idle'));
  }

  assert.equal(new Set(f.bindings.map((binding) => binding.worktreeId)).size, 3);
  assert.equal(new Set(f.bindings.map((binding) => binding.path.toLowerCase())).size, 3);
  assert.equal(existsSync(join(f.bindings[0].path, 'alpha-runtime.txt')), true);
  assert.equal(existsSync(join(f.bindings[1].path, 'codex-runtime.txt')), true);
  assert.equal(existsSync(join(f.bindings[2].path, 'codex-runtime.txt')), true);
  assert.equal(existsSync(join(f.bindings[0].path, 'codex-runtime.txt')), false);
  assert.equal(existsSync(join(f.bindings[1].path, 'alpha-runtime.txt')), false);
  assert.equal(existsSync(join(f.repository, 'alpha-runtime.txt')), false);
  assert.equal(existsSync(join(f.repository, 'codex-runtime.txt')), false);

  const attention = f.permissions.snapshot().attention;
  for (const session of f.sessions) {
    assert.equal(attention.some((item) => item.sessionId === session.id && item.kind === 'completed'), true);
  }
  const eventCounts = f.database.sqlite.prepare(`
    SELECT session_id AS sessionId, COUNT(*) AS count FROM session_events
    WHERE session_id IN ('dual-opencode','dual-codex-a','dual-codex-b') GROUP BY session_id
  `).all();
  assert.equal(eventCounts.length, 3);
  assert.equal(eventCounts.every((item) => item.count >= 5), true);

  f.gitService.stage('dual-opencode', ['alpha-runtime.txt']);
  const openCodeCommit = f.gitService.commit('dual-opencode', 'feat: OpenCode isolated change');
  f.gitService.stage('dual-codex-a', ['codex-runtime.txt']);
  const codexCommit = f.gitService.commit('dual-codex-a', 'feat: Codex isolated change');
  assert.equal(f.gitService.reviewSessionDiff('dual-opencode').commit.available, true);
  assert.equal(f.gitService.reviewSessionDiff('dual-codex-a').commit.available, true);
  assert.notEqual(openCodeCommit.commitHash, codexCommit.commitHash);

  const first = f.integrations.integrate({ sourceSessionId: 'dual-opencode', targetRef: 'main', strategy: 'merge' });
  const second = f.integrations.integrate({
    sourceSessionId: 'dual-codex-a', targetRef: first.integrationBranch, strategy: 'merge',
  });
  assert.equal(first.status, 'verified');
  assert.equal(second.status, 'verified');
  assert.equal(command(f.git, ['-C', f.repository, 'show', second.resultCommit + ':alpha-runtime.txt']), 'sanitized fake Runtime change');
  assert.equal(command(f.git, ['-C', f.repository, 'show', second.resultCommit + ':codex-runtime.txt']), 'sanitized fake Codex change');
  assert.equal(command(f.git, ['-C', f.repository, 'status', '--porcelain']), '');

  await assert.rejects(
    openCodeHandle.startTurn('dual-opencode', 'sanitized crash injection'),
    /OpenCode Turn failed to start/,
  );
  await waitFor(() => f.database.readSession('dual-opencode').health === 'interrupted_runtime');
  await codexBridgeB.startTurn(codexHandleB, 'dual-codex-b', [{ type: 'text', text: 'after peer crash' }]);
  await waitFor(() => f.database.readSession('dual-codex-b').activity === 'idle');
  assert.equal(f.database.readRuntimeHandle(codexHandleB.id).state, 'ready');
  assert.equal(f.database.readSession('dual-codex-b').health, 'healthy');

  const persisted = JSON.stringify({
    sessions: f.sessions.map((item) => f.database.readSession(item.id)),
    attention: f.permissions.snapshot(),
    events: f.database.sqlite.prepare('SELECT normalized_payload_json FROM session_events').all(),
  });
  assert.doesNotMatch(persisted, /fixture round|after peer crash|sanitized crash injection/);
});