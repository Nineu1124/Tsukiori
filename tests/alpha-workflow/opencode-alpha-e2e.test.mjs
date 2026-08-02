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
const { GitDiffService } = await import(pathToFileURL(join(root, 'packages/git-service/dist/index.js')).href);
const { PermissionBroker } = await import(pathToFileURL(join(root, 'packages/permission-broker/dist/index.js')).href);
const { OpenCodeRuntimeAdapter } = await import(pathToFileURL(join(root, 'packages/adapter-opencode/dist/index.js')).href);
const { OpenCodeAlphaWorkflow } = await import(pathToFileURL(join(root, 'packages/alpha-workflow/dist/index.js')).href);
const fakeCli = join(root, 'tests', 'fixtures', 'opencode', 'fake-opencode-cli.mjs');

function command(git, args) {
  return execFileSync(git, args, { encoding: 'utf8', windowsHide: true }).trim();
}

function fixture(t, config = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'tsukiori-alpha-e2e-'));
  const gitProbe = new GitProbe();
  const git = gitProbe.resolveWindowsGit();
  const repository = join(directory, 'repository');
  mkdirSync(repository);
  command(git, ['init', '--quiet', '--initial-branch=main', repository]);
  command(git, ['-C', repository, 'config', 'user.name', 'Alpha Fixture']);
  command(git, ['-C', repository, 'config', 'user.email', 'alpha@example.invalid']);
  writeFileSync(join(repository, 'README.md'), '# alpha fixture\n');
  command(git, ['-C', repository, 'add', '--', 'README.md']);
  command(git, ['-C', repository, 'commit', '--quiet', '-m', 'fixture base']);

  const docBody = JSON.stringify({ openapi: '3.1.0', info: { title: 'OpenCode fixture', version: '1.18.4' } });
  const configPath = join(directory, 'fake-opencode.json');
  const manifestPath = join(directory, 'openapi-manifest.json');
  writeFileSync(configPath, JSON.stringify({
    version: '1.18.4', credentialCount: 1, docBody, docContentType: 'application/json', ...config,
  }));
  writeFileSync(manifestPath, JSON.stringify({
    runtimeVersion: '1.18.4', contentType: 'application/json',
    sha256: createHash('sha256').update(docBody).digest('hex'), bytes: Buffer.byteLength(docBody),
  }));

  const database = new LocalDatabase({ filePath: join(directory, 'state.db'), blobRoot: join(directory, 'blobs') });
  let clock = 1_800_004_000_000;
  let serial = 0;
  const now = () => ++clock;
  const id = () => 'alpha-id-' + ++serial;
  const environments = new ExecutionEnvironmentRegistry(database, { gitProbe, now });
  const environment = environments.registerWindowsNative({ gitExecutable: git, homePath: directory });
  const projects = new ProjectManager(database, environments, { gitProbe, now, id });
  const worktrees = new WorktreeManager(database, projects, environments, {
    worktreeRoot: join(directory, 'worktrees'), executionEnvironmentId: environment.id, now, id,
  });
  const workspaces = new WorkspaceCoordinator(database, projects, environments, worktrees, { now, id });
  const permissions = new PermissionBroker(database, { now, id });
  const runtime = new OpenCodeRuntimeAdapter(database, environments, {
    executionEnvironmentId: environment.id,
    openApiManifestPath: manifestPath,
    candidates: () => [{ executable: process.execPath, prefixArgs: [fakeCli, configPath], source: 'explicit' }],
    permissionBroker: permissions,
    now,
    id,
    daemonBootId: 'daemon:alpha-e2e',
  });
  const profile = runtime.probe();
  const gitService = new GitDiffService(database, projects, environments);
  const workflow = new OpenCodeAlphaWorkflow({
    database, projects, workspaces, git: gitService, runtime, permissions, now, id,
  });
  t.after(async () => {
    await workflow.dispose();
    database.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  });
  return { directory, git, repository, database, environment, profile, permissions, workflow };
}

function startInput(f, suffix = 'one') {
  return {
    projectRoot: f.repository,
    executionEnvironmentId: f.environment.id,
    runtimeProfileId: f.profile.id,
    providerId: 'dpsk',
    modelId: 'deepseek-v4-flash',
    title: 'Alpha ' + suffix,
    firstPrompt: 'Create the fixture change',
    slug: 'alpha-' + suffix,
  };
}

async function waitFor(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error('Timed out waiting for Alpha E2E state');
}

test('published T3.4 fixture declares the sanitized Windows Alpha boundary', () => {
  const result = JSON.parse(readFileSync(join(root, 'tests/fixtures/opencode/t3.4-result.json'), 'utf8'));
  assert.equal(result.task, 'T3.4');
  assert.equal(result.platform, 'windows-native');
  assert.equal(result.runtime, 'opencode/1.18.4');
  assert.equal(result.provider.destinationHost, 'api.deepseek.com');
  assert.deepEqual(result.hiddenEntryPoints, ['merge', 'claude', 'acp', 'wsl', 'macos', 'linux']);
  assert.equal(result.repeatableCleanEnvironmentRuns, 2);
  assert.equal(result.containsCredentials, false);
  assert.equal(result.persistedPromptOrSource, false);
});

test('Project to DeepSeek Runtime change, permission, Diff, Commit, Archive and cleanup is repeatable', async (t) => {
  for (const suffix of ['one', 'two']) {
    const f = fixture(t, { holdPermission: true, writeFixtureFile: true });
    const started = await f.workflow.start(startInput(f, suffix));
    const sessionId = started.snapshot.session.id;
    const worktreePath = started.snapshot.binding.path;
    assert.equal(['running', 'waiting_permission'].includes(started.turn.status), true);
    assert.equal(started.snapshot.project.rootPath, f.repository);
    assert.equal(started.snapshot.session.provider, 'dpsk');
    assert.equal(started.snapshot.session.model, 'deepseek-v4-flash');
    assert.equal(started.snapshot.visibleEntryPoints.includes('deepseek'), true);
    assert.equal(existsSync(join(worktreePath, 'alpha-runtime.txt')), true);
    assert.equal(existsSync(join(f.repository, 'alpha-runtime.txt')), false);

    const permission = await waitFor(() => f.permissions.snapshot().permissions[0]);
    assert.equal(f.database.readSession(sessionId).activity, 'waiting_permission');
    assert.equal(permission.enforcementLevel, 'interceptable');
    await f.workflow.decidePermission(sessionId, permission.id, permission.connectionEpoch, 'allow_once');
    await waitFor(() => f.permissions.snapshot().attention.find(
      (item) => item.sessionId === sessionId && item.kind === 'completed' && item.status === 'open',
    ));
    assert.equal(f.permissions.snapshot().attention.find(
      (item) => item.kind === 'waiting_permission' && item.sessionId === sessionId,
    ).status, 'resolved');

    const reviewed = f.workflow.snapshot(sessionId);
    assert.equal(reviewed.git.files.some((file) => file.path === 'alpha-runtime.txt' && file.untracked), true);
    assert.equal(reviewed.hiddenEntryPoints.includes('merge'), true);
    f.workflow.stage(sessionId, ['alpha-runtime.txt']);
    const staged = f.workflow.review(sessionId).staged;
    assert.equal(staged.available, true);
    assert.match(staged.content, /alpha-runtime\.txt/);
    const committed = f.workflow.commit(sessionId, 'feat: apply sanitized Alpha change');
    assert.match(committed.commitHash, /^[a-f0-9]{40,64}$/);
    assert.equal(f.workflow.snapshot(sessionId).git.clean, true);

    const archived = await f.workflow.archive(sessionId, 'run');
    assert.equal(archived.binding.cleanupState, 'succeeded');
    assert.equal(existsSync(worktreePath), false);
    assert.equal(existsSync(join(f.repository, 'alpha-runtime.txt')), false);
  }
});

test('Attention Center can answer user input and observe completion without persisting answer text', async (t) => {
  const f = fixture(t, { holdQuestion: true });
  const started = await f.workflow.start(startInput(f, 'input'));
  const sessionId = started.snapshot.session.id;
  assert.equal(['running', 'waiting_user_input'].includes(started.turn.status), true);
  const waiting = await waitFor(() => f.permissions.snapshot().attention.find(
    (item) => item.sessionId === sessionId && item.kind === 'waiting_input' && item.status === 'open',
  ));
  assert.equal(f.database.readSession(sessionId).activity, 'waiting_user_input');
  assert.equal(waiting.payload.persistedQuestionText, false);
  await f.workflow.answerInput(sessionId, waiting.payload.requestId, [['Continue']]);
  await waitFor(() => f.permissions.snapshot().attention.find(
    (item) => item.sessionId === sessionId && item.kind === 'completed' && item.status === 'open',
  ));
  assert.equal(f.permissions.snapshot().attention.find((item) => item.id === waiting.id).status, 'resolved');
  assert.equal(JSON.stringify(f.permissions.snapshot()).includes('Continue'), false);
  await f.workflow.archive(sessionId, 'retain');
});

test('Runtime failure becomes failed Attention instead of a running Session', async (t) => {
  const f = fixture(t, { emitSessionError: true });
  const started = await f.workflow.start(startInput(f, 'failure'));
  const sessionId = started.snapshot.session.id;
  assert.equal(['running', 'failed'].includes(started.turn.status), true);
  await waitFor(() => f.permissions.snapshot().attention.find(
    (item) => item.sessionId === sessionId && item.kind === 'failed' && item.status === 'open',
  ));
  const snapshot = f.workflow.snapshot(sessionId);
  assert.equal(snapshot.session.health, 'error');
  assert.equal(snapshot.session.activity, 'idle');
  assert.equal(snapshot.attention.some((item) => item.kind === 'failed' && item.status === 'open'), true);
  await f.workflow.archive(sessionId, 'retain');
});

test('dirty archive cleanup preserves Runtime changes and reports blocked cleanup', async (t) => {
  const f = fixture(t, { writeFixtureFile: true });
  const started = await f.workflow.start(startInput(f, 'dirty'));
  const sessionId = started.snapshot.session.id;
  const worktreePath = started.snapshot.binding.path;
  assert.equal(existsSync(join(worktreePath, 'alpha-runtime.txt')), true);
  const archived = await f.workflow.archive(sessionId, 'run');
  assert.equal(archived.binding.cleanupState, 'blocked');
  assert.equal(existsSync(join(worktreePath, 'alpha-runtime.txt')), true);
  assert.equal(existsSync(join(f.repository, 'alpha-runtime.txt')), false);
});