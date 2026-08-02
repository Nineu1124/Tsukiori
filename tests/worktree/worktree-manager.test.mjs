import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { LocalDatabase } = await import(pathToFileURL(join(root, 'packages/database/dist/index.js')).href);
const projectModule = await import(pathToFileURL(join(root, 'packages/project-manager/dist/index.js')).href);
const worktreeModule = await import(pathToFileURL(join(root, 'packages/worktree-manager/dist/index.js')).href);
const { ExecutionEnvironmentRegistry, GitProbe, ProjectManager } = projectModule;
const {
  InjectedDaemonCrash, ProcessIdentityGuard, WorktreeManager, WorktreeSafetyError,
} = worktreeModule;

function command(git, args) {
  return execFileSync(git, args, { encoding: 'utf8', windowsHide: true }).trim();
}

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'tsukiori-worktree-'));
  const gitProbe = new GitProbe();
  const git = gitProbe.resolveWindowsGit();
  const repository = join(directory, 'repository');
  command(git, ['init', '--quiet', '--initial-branch=main', repository]);
  command(git, ['-C', repository, 'config', 'user.name', 'Fixture']);
  command(git, ['-C', repository, 'config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(repository, 'README.md'), '# fixture\n');
  command(git, ['-C', repository, 'add', 'README.md']);
  command(git, ['-C', repository, 'commit', '--quiet', '-m', 'fixture base']);
  const database = new LocalDatabase({ filePath: join(directory, 'state.db'), blobRoot: join(directory, 'blobs') });
  let clock = 1_800_000_200_000;
  let serial = 0;
  const environments = new ExecutionEnvironmentRegistry(database, { gitProbe, now: () => ++clock });
  const environment = environments.registerWindowsNative({ gitExecutable: git, homePath: directory });
  const projects = new ProjectManager(database, environments, {
    gitProbe, now: () => ++clock, id: () => 'project-' + ++serial,
  });
  const project = projects.add({ rootPath: repository, executionEnvironmentId: environment.id });
  const sessionIds = Array.from({ length: 8 }, (_, index) => 'session-' + (index + 1));
  for (const sessionId of sessionIds) {
    database.saveSession({
      id: sessionId, title: sessionId, projectId: project.id, runtimeType: 'fake',
      runtimeProfileId: 'profile', lifecycle: 'active', activity: 'idle', health: 'healthy',
      writeMode: 'isolated-worktree', createdAt: ++clock, updatedAt: clock,
    });
  }
  const worktreeRoot = join(directory, 'worktrees');
  function manager(crashAt) {
    return new WorktreeManager(database, projects, environments, {
      worktreeRoot, executionEnvironmentId: environment.id, now: () => ++clock,
      id: () => 'id-' + ++serial, ...(crashAt ? { crashAt } : {}),
    });
  }
  t.after(() => {
    try { database.close(); } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  return { directory, git, repository, database, environments, environment, projects, project, sessionIds, worktreeRoot, manager };
}

test('published T2.2 fixture is sanitized and records all recovery terminal states', () => {
  const fixture = JSON.parse(readFileSync(join(root, 'tests/fixtures/worktree/t2.2-result.json'), 'utf8'));
  assert.equal(fixture.task, 'T2.2');
  assert.deepEqual(fixture.recovery.terminalStates, ['committed', 'failed', 'uncertain']);
  assert.equal(fixture.recovery.replaysExternalAction, false);
  assert.equal(fixture.cleanup.forceByDefault, false);
  assert.equal(fixture.containsCredentials, false);
});

test('configured Worktree Root enforces lexical, Windows, and Junction boundaries', (t) => {
  const f = fixture(t);
  const manager = f.manager();
  assert.ok(manager.worktreeRoot.startsWith(f.directory));
  assert.throws(() => new WorktreeManager(f.database, f.projects, f.environments, {
    worktreeRoot: '/mnt/c/escape', executionEnvironmentId: f.environment.id,
  }), /Windows Native absolute path/);
  assert.throws(() => manager.create({
    projectId: f.project.id, sessionId: f.sessionIds[0], runtimeType: 'fake', directoryName: '..',
  }), WorktreeSafetyError);

  const projectDirectory = join(manager.worktreeRoot, f.project.repositoryId.slice(5, 17));
  const outside = join(f.directory, 'outside-root');
  mkdirSync(outside);
  symlinkSync(outside, projectDirectory, 'junction');
  assert.throws(() => manager.create({
    projectId: f.project.id, sessionId: f.sessionIds[0], runtimeType: 'fake', slug: 'junction',
  }), WorktreeSafetyError);
});

test('create records fixed base commit, branch, environment, Worktree, and committed Operation', (t) => {
  const f = fixture(t);
  const worktree = f.manager().create({
    projectId: f.project.id, sessionId: f.sessionIds[0], runtimeType: 'fake', baseRef: 'main', slug: 'create',
  });
  const operation = f.database.listOperations().find((item) => item.type === 'worktree_create');
  const baseCommit = command(f.git, ['-C', f.repository, 'rev-parse', 'main^{commit}']);
  assert.equal(operation.status, 'committed');
  assert.equal(operation.requestPayload.baseCommit, baseCommit);
  assert.equal(operation.requestPayload.branchName, worktree.branchName);
  assert.equal(operation.requestPayload.executionEnvironmentId, f.environment.id);
  assert.equal(worktree.baseCommit, baseCommit);
  assert.equal(f.database.readWorktree(worktree.id).status, 'active');
  assert.equal(command(f.git, ['-C', worktree.path, 'branch', '--show-current']), worktree.branchName);
});

test('dirty or untracked files refuse default removal; a clean Worktree can be removed', (t) => {
  const f = fixture(t);
  const manager = f.manager();
  const worktree = manager.create({
    projectId: f.project.id, sessionId: f.sessionIds[0], runtimeType: 'fake', slug: 'dirty',
  });
  writeFileSync(join(worktree.path, 'README.md'), '# changed\n');
  writeFileSync(join(worktree.path, 'untracked.txt'), 'untracked\n');
  assert.throws(() => manager.remove(worktree.id), /Dirty or untracked/);
  assert.equal(existsSync(worktree.path), true);
  assert.equal(f.database.listOperations().filter((item) => item.type === 'worktree_remove').at(-1).status, 'failed');
  command(f.git, ['-C', worktree.path, 'restore', 'README.md']);
  rmSync(join(worktree.path, 'untracked.txt'));
  manager.remove(worktree.id);
  assert.equal(existsSync(worktree.path), false);
  assert.equal(f.database.readWorktree(worktree.id).status, 'removed');
});

test('create and remove crash recovery ends in committed, failed, or uncertain without replay', (t) => {
  const f = fixture(t);
  const crash = (expected, sideEffect) => (point, payload) => {
    if (point !== expected) return;
    if (sideEffect) sideEffect(payload);
    throw new InjectedDaemonCrash(point);
  };

  const noCreate = f.manager(crash('create_after_prepare'));
  assert.throws(() => noCreate.create({
    projectId: f.project.id, sessionId: f.sessionIds[0], runtimeType: 'fake', slug: 'no-create',
  }), InjectedDaemonCrash);
  assert.equal(f.manager().recoverNonTerminal().at(-1).status, 'failed');

  const partialCreate = f.manager(crash('create_after_prepare', (payload) => {
    command(f.git, ['-C', f.repository, 'branch', payload.branchName, payload.baseCommit]);
  }));
  assert.throws(() => partialCreate.create({
    projectId: f.project.id, sessionId: f.sessionIds[1], runtimeType: 'fake', slug: 'partial',
  }), InjectedDaemonCrash);
  assert.equal(f.manager().recoverNonTerminal().at(-1).status, 'uncertain');

  const completedCreate = f.manager(crash('create_after_git_add'));
  assert.throws(() => completedCreate.create({
    projectId: f.project.id, sessionId: f.sessionIds[2], runtimeType: 'fake', slug: 'complete-create',
  }), InjectedDaemonCrash);
  const createRecovery = f.manager().recoverNonTerminal().at(-1);
  assert.equal(createRecovery.status, 'committed');
  const recoveredWorktree = f.database.listWorktrees().find((item) => item.ownerSessionId === f.sessionIds[2]);
  assert.equal(recoveredWorktree.status, 'active');

  const noRemove = f.manager(crash('remove_after_prepare'));
  assert.throws(() => noRemove.remove(recoveredWorktree.id), InjectedDaemonCrash);
  assert.equal(f.manager().recoverNonTerminal().at(-1).status, 'failed');

  const completedRemove = f.manager(crash('remove_after_git_remove'));
  assert.throws(() => completedRemove.remove(recoveredWorktree.id), InjectedDaemonCrash);
  const removeRecovery = f.manager().recoverNonTerminal().at(-1);
  assert.equal(removeRecovery.status, 'committed');
  assert.equal(f.database.readWorktree(recoveredWorktree.id).status, 'removed');

  const uncertainRemoveWorktree = f.manager().create({
    projectId: f.project.id, sessionId: f.sessionIds[3], runtimeType: 'fake', slug: 'partial-remove',
  });
  const partialRemove = f.manager(crash('remove_after_running', (payload) => {
    rmSync(payload.targetPath, { recursive: true, force: true });
  }));
  assert.throws(() => partialRemove.remove(uncertainRemoveWorktree.id), InjectedDaemonCrash);
  const uncertainRemoveRecovery = f.manager().recoverNonTerminal().at(-1);
  assert.equal(uncertainRemoveRecovery.status, 'uncertain');
  const terminal = new Set(f.database.listOperations().map((item) => item.status));
  assert.equal(terminal.has('committed'), true);
  assert.equal(terminal.has('failed'), true);
  assert.equal(terminal.has('uncertain'), true);
});

test('stale or PID-reused ProcessRecord blocks cleanup and never authorizes termination', (t) => {
  const f = fixture(t);
  const manager = f.manager();
  const worktree = manager.create({
    projectId: f.project.id, sessionId: f.sessionIds[0], runtimeType: 'fake', slug: 'pid-guard',
  });
  const record = {
    id: 'process-stale', sessionId: f.sessionIds[0], executionEnvironmentId: f.environment.id,
    processType: 'runtime', pid: 4242, daemonBootId: 'old-boot', processStartTime: 100,
    processFingerprint: 'fingerprint-a', spawnNonce: 'nonce-a', executable: 'C:\\Tools\\runtime.exe',
    cwd: worktree.path, status: 'running', startedAt: 100,
  };
  f.database.saveProcess(record);
  assert.equal(ProcessIdentityGuard.matches(record, {
    pid: 4242, daemonBootId: 'new-boot', processStartTime: 200, spawnNonce: 'nonce-b',
    processFingerprint: 'fingerprint-b', executable: 'C:\\Tools\\unrelated.exe',
  }), false);
  assert.equal(ProcessIdentityGuard.matches(record, {
    pid: 4242, daemonBootId: 'old-boot', processStartTime: 100, spawnNonce: 'nonce-a',
    processFingerprint: 'fingerprint-a',
  }), false);  assert.throws(() => manager.remove(worktree.id), /Active ProcessRecord/);
  assert.equal(existsSync(worktree.path), true);
  assert.equal(command(f.git, ['-C', worktree.path, 'branch', '--show-current']), worktree.branchName);
});