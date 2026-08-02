import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { LocalDatabase } = await import(pathToFileURL(join(root, 'packages/database/dist/index.js')).href);
const projectModule = await import(pathToFileURL(join(root, 'packages/project-manager/dist/index.js')).href);
const { WorktreeManager } = await import(pathToFileURL(join(root, 'packages/worktree-manager/dist/index.js')).href);
const { WorkspaceCoordinator } = await import(pathToFileURL(join(root, 'packages/workspace-manager/dist/index.js')).href);
const { GitDiffService, GitServiceError } = await import(pathToFileURL(join(root, 'packages/git-service/dist/index.js')).href);
const { ExecutionEnvironmentRegistry, GitProbe, ProjectManager } = projectModule;

function command(git, args) {
  return execFileSync(git, args, { encoding: 'utf8', windowsHide: true }).trim();
}

function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'tsukiori-git-service-'));
  const gitProbe = new GitProbe();
  const git = gitProbe.resolveWindowsGit();
  const repository = join(directory, 'repository');
  command(git, ['init', '--quiet', '--initial-branch=main', repository]);
  command(git, ['-C', repository, 'config', 'user.name', 'Fixture']);
  command(git, ['-C', repository, 'config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(repository, 'README.md'), '# fixture\n');
  writeFileSync(join(repository, 'large.txt'), 'base\n');
  writeFileSync(join(repository, 'binary.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
  command(git, ['-C', repository, 'add', 'README.md', 'large.txt', 'binary.bin']);
  command(git, ['-C', repository, 'commit', '--quiet', '-m', 'fixture base']);
  if (options.dirtyMain) writeFileSync(join(repository, 'main-only.txt'), 'main dirty\n');
  const database = new LocalDatabase({ filePath: join(directory, 'state.db'), blobRoot: join(directory, 'blobs') });
  let clock = 1_800_000_400_000;
  let serial = 0;
  const now = () => ++clock;
  const id = () => 'id-' + ++serial;
  const environments = new ExecutionEnvironmentRegistry(database, { gitProbe, now });
  const environment = environments.registerWindowsNative({ gitExecutable: git, homePath: directory });
  const projects = new ProjectManager(database, environments, { gitProbe, now, id });
  const project = projects.add({ rootPath: repository, executionEnvironmentId: environment.id });
  const sessionIds = Array.from({ length: 4 }, (_, index) => 'session-' + (index + 1));
  for (const sessionId of sessionIds) {
    database.saveSession({
      id: sessionId, title: sessionId, projectId: project.id, runtimeType: 'fake',
      runtimeProfileId: 'profile', lifecycle: 'active', activity: 'idle', health: 'healthy',
      writeMode: 'isolated-worktree', createdAt: now(), updatedAt: clock,
    });
  }
  const worktrees = new WorktreeManager(database, projects, environments, {
    worktreeRoot: join(directory, 'worktrees'), executionEnvironmentId: environment.id, now, id,
  });
  const coordinator = new WorkspaceCoordinator(database, projects, environments, worktrees, { now, id });
  function createWorkspace(index = 0, slug = 'git-service') {
    return coordinator.createWritableSessionWorkspace({
      sessionId: sessionIds[index], projectId: project.id, runtimeType: 'fake', slug,
    }).binding;
  }
  function service(serviceOptions = {}) {
    return new GitDiffService(database, projects, environments, serviceOptions);
  }
  t.after(() => {
    try { database.close(); } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  return { directory, git, repository, database, environments, environment, projects, project, sessionIds, createWorkspace, service };
}

test('published T2.4 fixture is sanitized and declares all Git/Diff boundaries', () => {
  const result = JSON.parse(readFileSync(join(root, 'tests/fixtures/git/t2.4-result.json'), 'utf8'));
  assert.equal(result.task, 'T2.4');
  assert.deepEqual(result.diffScopes, ['working', 'staged', 'session-commit']);
  assert.equal(result.workspaceIsolation.dirtyMainWorkspacePreserved, true);
  assert.equal(result.commandExecution.structuredArguments, true);
  assert.equal(result.commandExecution.shell, false);
  assert.equal(result.containsCredentials, false);
});

test('file list, Working Diff, Staged Diff, and Session Commit Diff use real Git facts', (t) => {
  const f = fixture(t);
  const binding = f.createWorkspace();
  const service = f.service();
  writeFileSync(join(binding.path, 'README.md'), '# working change\n');
  let status = service.status(f.sessionIds[0]);
  assert.equal(status.clean, false);
  assert.equal(status.files.find((file) => file.path === 'README.md').working, true);
  const working = service.diff(f.sessionIds[0], 'working', 'README.md');
  assert.equal(working.available, true);
  assert.match(working.content, /working change/);

  command(f.git, ['-C', binding.path, 'add', '--', 'README.md']);
  status = service.status(f.sessionIds[0]);
  assert.equal(status.files.find((file) => file.path === 'README.md').staged, true);
  const staged = service.diff(f.sessionIds[0], 'staged', 'README.md');
  assert.equal(staged.available, true);
  assert.match(staged.content, /working change/);

  command(f.git, ['-C', binding.path, 'commit', '--quiet', '-m', 'session change']);
  const committed = service.diff(f.sessionIds[0], 'session-commit', 'README.md');
  assert.equal(committed.available, true);
  assert.equal(committed.baseCommit, binding.baseCommit);
  assert.notEqual(committed.headCommit, binding.baseCommit);
  assert.match(committed.content, /working change/);
  const total = service.sessionDiff(f.sessionIds[0]);
  assert.equal(total.commit.available, true);
  assert.equal(total.staged.degradedReason, 'not-changed');
  assert.equal(total.working.degradedReason, 'not-changed');
});

test('rename records preserve old and new paths', (t) => {
  const f = fixture(t);
  const binding = f.createWorkspace();
  command(f.git, ['-C', binding.path, 'mv', '--', 'README.md', 'renamed.md']);
  const renamed = f.service().status(f.sessionIds[0]).files.find((file) => file.kind === 'renamed');
  assert.equal(renamed.path, 'renamed.md');
  assert.equal(renamed.originalPath, 'README.md');
  assert.equal(renamed.staged, true);
});

test('binary, large, untracked, and output-limit files have explicit degraded results', (t) => {
  const f = fixture(t);
  const binding = f.createWorkspace();
  writeFileSync(join(binding.path, 'binary.bin'), Buffer.from([0, 9, 8, 7, 0, 6]));
  writeFileSync(join(binding.path, 'large.txt'), 'L'.repeat(4096));
  writeFileSync(join(binding.path, 'untracked.txt'), 'not in index\n');
  writeFileSync(join(binding.path, 'README.md'), '# ' + 'diff-line\n'.repeat(100));
  const service = f.service({ maxFileBytes: 256, maxDiffBytes: 128 });
  assert.equal(service.diff(f.sessionIds[0], 'working', 'binary.bin').degradedReason, 'binary');
  assert.equal(service.diff(f.sessionIds[0], 'working', 'large.txt').degradedReason, 'large');
  assert.equal(service.diff(f.sessionIds[0], 'working', 'untracked.txt').degradedReason, 'untracked');
  const outputLimited = f.service({ maxFileBytes: 8192, maxDiffBytes: 128 });
  assert.equal(outputLimited.diff(f.sessionIds[0], 'working', 'README.md').degradedReason, 'output-limit');
  const files = service.status(f.sessionIds[0]).files;
  assert.equal(files.find((file) => file.path === 'untracked.txt').kind, 'untracked');
});

test('dirty main workspace remains untouched by Session status and Diff operations', (t) => {
  const f = fixture(t, { dirtyMain: true });
  const originalMainReadme = readFileSync(join(f.repository, 'README.md'), 'utf8');
  const binding = f.createWorkspace();
  writeFileSync(join(binding.path, 'README.md'), '# session-only\n');
  writeFileSync(join(binding.path, 'session-only.txt'), 'session\n');
  const status = f.service().status(f.sessionIds[0]);
  assert.equal(status.files.some((file) => file.path === 'README.md'), true);
  assert.equal(status.files.some((file) => file.path === 'session-only.txt'), true);
  assert.equal(status.files.some((file) => file.path === 'main-only.txt'), false);
  assert.equal(readFileSync(join(f.repository, 'README.md'), 'utf8'), originalMainReadme);
  assert.equal(existsSync(join(f.repository, 'session-only.txt')), false);
  assert.match(command(f.git, ['-C', f.repository, 'status', '--porcelain']), /main-only\.txt/);
});

test('all Git calls use structured arguments, shell false, bound cwd, and path separator', (t) => {
  const f = fixture(t);
  const binding = f.createWorkspace();
  writeFileSync(join(binding.path, 'README.md'), '# observer\n');
  const invocations = [];
  const service = f.service({ observeInvocation: (invocation) => invocations.push(invocation) });
  service.status(f.sessionIds[0]);
  service.diff(f.sessionIds[0], 'working', 'README.md');
  assert.ok(invocations.length >= 5);
  for (const invocation of invocations) {
    assert.equal(invocation.shell, false);
    assert.equal(Array.isArray(invocation.args), true);
    assert.equal(invocation.cwd.toLowerCase(), binding.path.toLowerCase());
    assert.equal(invocation.executable.toLowerCase(), f.environment.gitExecutable.toLowerCase());
  }
  const pathCalls = invocations.filter((invocation) => invocation.args.includes('README.md'));
  assert.ok(pathCalls.length >= 2);
  assert.equal(pathCalls.every((invocation) => invocation.args.indexOf('--') < invocation.args.indexOf('README.md')), true);
  assert.throws(() => service.diff(f.sessionIds[0], 'working', '..\\outside.txt'), GitServiceError);
});
