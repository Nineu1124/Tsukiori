import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { LocalDatabase } = await import(pathToFileURL(join(root, 'packages/database/dist/index.js')).href);
const projectModule = await import(pathToFileURL(join(root, 'packages/project-manager/dist/index.js')).href);
const {
  EnvironmentBoundaryError, ExecutionEnvironmentRegistry, GitProbe, ProjectManager,
  ProjectRegistrationError, assertEnvironmentConsistency, classifyExecutionPath,
} = projectModule;

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'tsukiori-project-'));
  const git = new GitProbe().resolveWindowsGit();
  const repository = join(directory, 'repository');
  execFileSync(git, ['init', '--quiet', '--initial-branch=main', repository], { windowsHide: true });
  const database = new LocalDatabase({ filePath: join(directory, 'state.db'), blobRoot: join(directory, 'blobs') });
  t.after(() => {
    try { database.close(); } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  let clock = 1_800_000_100_000;
  const gitProbe = new GitProbe();
  const environments = new ExecutionEnvironmentRegistry(database, { gitProbe, now: () => ++clock });
  const environment = environments.registerWindowsNative({ gitExecutable: git, homePath: directory });
  let serial = 0;
  const projects = new ProjectManager(database, environments, {
    gitProbe, now: () => ++clock, id: () => 'fixture-' + ++serial,
  });
  return { directory, git, repository, database, environments, environment, projects };
}

test('published T2.1 fixture is sanitized and records observed Windows Git capabilities', () => {
  const fixture = JSON.parse(readFileSync(join(root, 'tests/fixtures/project/t2.1-result.json'), 'utf8'));
  assert.equal(fixture.task, 'T2.1');
  assert.equal(fixture.environment.type, 'windows-native');
  assert.equal(fixture.git.probeUsesShell, false);
  assert.deepEqual(fixture.projectLifecycle, ['add', 'reprobe', 'remove']);
  assert.equal(fixture.containsCredentials, false);
  assert.doesNotMatch(JSON.stringify(fixture), /Bearer\s+|-----BEGIN|sk-[A-Za-z0-9]/);
});

test('Windows Native registry records canonical Git path, version, and probed capabilities', (t) => {
  const { database, environment } = fixture(t);
  assert.match(environment.gitExecutable, /^[A-Za-z]:\\/);
  assert.match(environment.gitExecutable, /git\.exe$/i);
  assert.match(environment.gitVersion, /^\d+\.\d+/);
  assert.equal(typeof environment.gitCapabilities.worktree, 'boolean');
  assert.equal(typeof environment.gitCapabilities.porcelainV2, 'boolean');
  assert.equal(environment.gitCapabilities.worktree, true);
  assert.equal(environment.gitCapabilities.porcelainV2, true);
  assert.equal(environment.pathStyle, 'windows');
  const restored = database.readExecutionEnvironment(environment.id);
  assert.equal(restored.gitVersion, environment.gitVersion);
  assert.deepEqual(restored.gitCapabilities, environment.gitCapabilities);
});

test('Project Manager adds, re-probes dirty state, persists, and removes a local Git project', (t) => {
  const { repository, database, environment, projects } = fixture(t);
  const project = projects.add({ rootPath: repository, executionEnvironmentId: environment.id });
  assert.equal(project.currentBranch, 'main');
  assert.equal(project.defaultBranch, 'main');
  assert.equal(project.remoteCount, 0);
  assert.equal(project.isDirty, false);
  assert.match(project.repositoryId, /^repo:[a-f0-9]{64}$/);
  assert.match(project.canonicalGitDir, /\\\.git$/i);
  assert.equal(database.readProject(project.id).repositoryId, project.repositoryId);

  writeFileSync(join(repository, 'untracked.txt'), 'fixture\n');
  const updated = projects.reProbe(project.id);
  assert.equal(updated.isDirty, true);
  assert.ok(updated.lastProbedAt > project.lastProbedAt);
  assert.throws(() => projects.add({ rootPath: repository, executionEnvironmentId: environment.id }),
    /already registered/);
  projects.remove(project.id);
  assert.equal(projects.list().length, 0);
});

test('Project removal is refused while Sessions or Worktrees reference it', (t) => {
  const { repository, database, environment, projects } = fixture(t);
  const project = projects.add({ rootPath: repository, executionEnvironmentId: environment.id });
  database.saveSession({
    id: 'session-guard', title: 'guard', projectId: project.id, runtimeType: 'fake',
    runtimeProfileId: 'profile', lifecycle: 'active', activity: 'idle', health: 'healthy',
    writeMode: 'isolated-worktree', createdAt: 1, updatedAt: 1,
  });
  assert.throws(() => projects.remove(project.id), ProjectRegistrationError);
  assert.equal(projects.get(project.id).id, project.id);

  const secondRepository = join(dirname(repository), 'repository-worktree');
  execFileSync(environment.gitExecutable, ['init', '--quiet', '--initial-branch=main', secondRepository], { windowsHide: true });
  const worktreeProject = projects.add({ rootPath: secondRepository, executionEnvironmentId: environment.id });
  database.saveWorktree({
    id: 'worktree-guard', projectId: worktreeProject.id, executionEnvironmentId: environment.id,
    path: join(dirname(repository), 'linked-worktree'), branchName: 'agent/fake/guard', baseRef: 'main',
    baseCommit: '0000000000000000000000000000000000000000', status: 'active', createdAt: 1,
  });
  assert.throws(() => projects.remove(worktreeProject.id), ProjectRegistrationError);
});

test('environment consistency accepts matching Windows bindings and rejects cross-environment IDs', (t) => {
  const { repository, environment, projects } = fixture(t);
  const project = projects.add({ rootPath: repository, executionEnvironmentId: environment.id });
  projects.assertBindings(project.id, {
    runtimeEnvironmentId: environment.id, gitEnvironmentId: environment.id,
    runtimeExecutable: 'C:\\Tools\\runtime.exe',
    worktree: {
      id: 'worktree-fixture', projectId: project.id, executionEnvironmentId: environment.id,
      path: 'D:\\worktrees\\fixture', branchName: 'agent/fake/fixture', baseRef: 'main',
      baseCommit: '0000000000000000000000000000000000000000', status: 'active', createdAt: 1,
    },
  });
  assert.throws(() => projects.assertBindings(project.id, {
    runtimeEnvironmentId: 'environment:wsl:ubuntu', gitEnvironmentId: environment.id,
  }), EnvironmentBoundaryError);
  assert.throws(() => projects.assertBindings(project.id, {
    runtimeEnvironmentId: environment.id, gitEnvironmentId: 'environment:wsl:ubuntu',
  }), EnvironmentBoundaryError);
  assert.throws(() => projects.assertBindings(project.id, {
    runtimeEnvironmentId: environment.id, gitEnvironmentId: environment.id,
    worktree: {
      id: 'worktree-wsl', projectId: project.id, executionEnvironmentId: 'environment:wsl:ubuntu',
      path: '/mnt/d/worktrees/fixture', branchName: 'agent/fake/wsl', baseRef: 'main',
      baseCommit: '0000000000000000000000000000000000000000', status: 'active', createdAt: 1,
    },
  }), EnvironmentBoundaryError);
});

test('Windows and WSL paths or executables cannot be mixed', (t) => {
  const { repository, environment, projects } = fixture(t);
  const project = projects.add({ rootPath: repository, executionEnvironmentId: environment.id });
  assert.equal(classifyExecutionPath('C:\\repo'), 'windows-native');
  assert.equal(classifyExecutionPath('\\\\wsl.localhost\\Ubuntu\\repo'), 'wsl');
  assert.equal(classifyExecutionPath('/mnt/c/repo'), 'wsl');
  for (const runtimeExecutable of ['/usr/bin/codex', '/mnt/c/tools/runtime', '\\\\wsl$\\Ubuntu\\usr\\bin\\codex']) {
    assert.throws(() => assertEnvironmentConsistency({
      project, environment, runtimeEnvironmentId: environment.id,
      gitEnvironmentId: environment.id, runtimeExecutable,
    }), EnvironmentBoundaryError);
  }
  const wslEnvironment = {
    ...environment, id: 'environment:wsl:ubuntu', type: 'wsl', pathStyle: 'posix',
    gitExecutable: '/usr/bin/git', homePath: '/home/fixture',
  };
  assert.throws(() => assertEnvironmentConsistency({
    project: { ...project, executionEnvironmentId: wslEnvironment.id }, environment: wslEnvironment,
    runtimeEnvironmentId: wslEnvironment.id, gitEnvironmentId: wslEnvironment.id,
    runtimeExecutable: 'C:\\Tools\\codex.exe',
  }), EnvironmentBoundaryError);
});