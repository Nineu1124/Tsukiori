import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const prompt = process.env.TSUKIORI_G3_PROBE_PROMPT;
if (!prompt || prompt.length > 1000) throw new Error('TSUKIORI_G3_PROBE_PROMPT is required and bounded');
const root = resolve(import.meta.dirname, '..');
const { LocalDatabase } = await import(pathToFileURL(join(root, 'packages/database/dist/index.js')).href);
const { ExecutionEnvironmentRegistry, GitProbe, ProjectManager } = await import(
  pathToFileURL(join(root, 'packages/project-manager/dist/index.js')).href
);
const { WorktreeManager } = await import(pathToFileURL(join(root, 'packages/worktree-manager/dist/index.js')).href);
const { WorkspaceCoordinator } = await import(pathToFileURL(join(root, 'packages/workspace-manager/dist/index.js')).href);
const { GitDiffService } = await import(pathToFileURL(join(root, 'packages/git-service/dist/index.js')).href);
const { PermissionBroker } = await import(pathToFileURL(join(root, 'packages/permission-broker/dist/index.js')).href);
const { OpenCodeRuntimeAdapter } = await import(
  pathToFileURL(join(root, 'packages/adapter-opencode/dist/index.js')).href
);
const { OpenCodeAlphaWorkflow } = await import(
  pathToFileURL(join(root, 'packages/alpha-workflow/dist/index.js')).href
);

const directory = mkdtempSync(join(tmpdir(), 'tsukiori-gate3-real-'));
const repository = join(directory, 'repository');
let database;
let workflow;

function command(git, args) {
  return execFileSync(git, args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function waitForTerminal(sessionId, permissions) {
  const decided = new Set();
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    for (const request of permissions.snapshot().permissions) {
      if (request.sessionId !== sessionId || decided.has(request.id)) continue;
      await workflow.decidePermission(sessionId, request.id, request.connectionEpoch, 'allow_once');
      decided.add(request.id);
    }
    const session = database.readSession(sessionId);
    const attention = permissions.snapshot().attention.filter((item) => item.sessionId === sessionId);
    if (attention.some((item) => item.kind === 'failed' && item.status === 'open')) {
      throw new Error('Real DeepSeek Turn reported failed Attention');
    }
    if (attention.some((item) => item.kind === 'waiting_input' && item.status === 'open')) {
      throw new Error('Real DeepSeek probe unexpectedly requested user input');
    }
    if (session?.activity === 'idle' && attention.some(
      (item) => item.kind === 'completed' && item.status === 'open',
    )) return decided.size;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error('Timed out waiting for real DeepSeek Alpha Turn');
}

try {
  const gitProbe = new GitProbe();
  const git = gitProbe.resolveWindowsGit();
  mkdirSync(repository);
  command(git, ['init', '--quiet', '--initial-branch=main', repository]);
  command(git, ['-C', repository, 'config', 'user.name', 'Tsukiori Gate Probe']);
  command(git, ['-C', repository, 'config', 'user.email', 'gate-probe@example.invalid']);
  writeFileSync(join(repository, 'README.md'), '# isolated G3 probe\n');
  command(git, ['-C', repository, 'add', '--', 'README.md']);
  command(git, ['-C', repository, 'commit', '--quiet', '-m', 'probe base']);

  database = new LocalDatabase({ filePath: join(directory, 'state.db'), blobRoot: join(directory, 'blobs') });
  const environments = new ExecutionEnvironmentRegistry(database, { gitProbe });
  const environment = environments.registerWindowsNative({ gitExecutable: git, homePath: directory });
  const projects = new ProjectManager(database, environments, { gitProbe });
  const worktrees = new WorktreeManager(database, projects, environments, {
    worktreeRoot: join(directory, 'worktrees'), executionEnvironmentId: environment.id,
  });
  const workspaces = new WorkspaceCoordinator(database, projects, environments, worktrees);
  const permissions = new PermissionBroker(database);
  const runtime = new OpenCodeRuntimeAdapter(database, environments, {
    executionEnvironmentId: environment.id,
    openApiManifestPath: join(root, 'tests', 'fixtures', 'opencode', '1.18.4', 'openapi-manifest.json'),
    permissionBroker: permissions,
  });
  const profile = runtime.probe();
  const gitService = new GitDiffService(database, projects, environments);
  workflow = new OpenCodeAlphaWorkflow({
    database, projects, workspaces, git: gitService, runtime, permissions,
  });
  const started = await workflow.start({
    projectRoot: repository,
    executionEnvironmentId: environment.id,
    runtimeProfileId: profile.id,
    providerId: 'dpsk',
    modelId: 'deepseek-v4-flash',
    title: 'G3 real provider probe',
    firstPrompt: prompt,
    slug: 'g3-real',
  });
  const sessionId = started.snapshot.session.id;
  const worktreePath = started.snapshot.binding.path;
  const permissionDecisionCount = await waitForTerminal(sessionId, permissions);
  const targetPath = join(worktreePath, 'gate3-real.txt');
  if (!existsSync(targetPath)) throw new Error('Real DeepSeek Turn did not create the expected Worktree file');
  const reviewed = workflow.snapshot(sessionId);
  const changed = reviewed.git.files.find((file) => file.path === 'gate3-real.txt');
  if (!changed?.untracked) throw new Error('Expected Runtime file is not visible in Session Git status');
  workflow.stage(sessionId, ['gate3-real.txt']);
  const staged = workflow.review(sessionId).staged;
  if (!staged.available) throw new Error('Real DeepSeek change has no Staged Diff');
  const committed = workflow.commit(sessionId, 'test: verify real DeepSeek Alpha closure');
  if (!/^[a-f0-9]{40,64}$/i.test(committed.commitHash)) throw new Error('Real probe Commit is invalid');
  const archived = await workflow.archive(sessionId, 'run');
  if (archived.binding.cleanupState !== 'succeeded' || existsSync(worktreePath)) {
    throw new Error('Real probe Worktree cleanup did not succeed');
  }
  const persisted = JSON.stringify({
    profiles: database.listRuntimeProfiles('opencode'),
    audits: database.listRuntimeAudits('opencode'),
    attention: permissions.snapshot(),
  });
  if (persisted.includes(prompt) || /Authorization|Basic\s+[A-Za-z0-9+/=]+|sk-[A-Za-z0-9]/.test(persisted)) {
    throw new Error('Real G3 probe found forbidden persisted content');
  }
  process.stdout.write(JSON.stringify({
    gate: 'G3',
    runtimeVersion: profile.discoveredVersion,
    compatibility: profile.compatibility,
    providerId: 'dpsk',
    modelId: 'deepseek-v4-flash',
    destinationHost: 'api.deepseek.com',
    providerRequestCompleted: true,
    permissionDecisionCount,
    runtimeModifiedBoundWorktree: true,
    mainWorkspaceChanged: existsSync(join(repository, 'gate3-real.txt')),
    diffReviewed: true,
    commitCreated: true,
    archiveCompleted: archived.binding.status === 'archived',
    cleanupState: archived.binding.cleanupState,
    pathFingerprint: 'sha256:' + createHash('sha256').update(profile.executablePath).digest('hex'),
    persistedPromptOrSource: false,
    containsCredentials: false,
  }, null, 2) + '\n');
} finally {
  if (workflow) await workflow.dispose().catch(() => undefined);
  if (database) database.close();
  rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}