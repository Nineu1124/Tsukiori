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
const architecturePath = join(root, '本地多Agent工作台_完整架构与实施方案.md');
const { LocalDatabase } = await import(pathToFileURL(join(root, 'packages/database/dist/index.js')).href);
const projectModule = await import(pathToFileURL(join(root, 'packages/project-manager/dist/index.js')).href);
const worktreeModule = await import(pathToFileURL(join(root, 'packages/worktree-manager/dist/index.js')).href);
const { WorkspaceCoordinator } = await import(pathToFileURL(join(root, 'packages/workspace-manager/dist/index.js')).href);
const { GitDiffService, GitServiceError } = await import(pathToFileURL(join(root, 'packages/git-service/dist/index.js')).href);
const { FakeRuntimeAdapter } = await import(pathToFileURL(join(root, 'packages/adapter-fake/dist/index.js')).href);
const { ExecutionEnvironmentRegistry, GitProbe, ProjectManager } = projectModule;
const { InjectedDaemonCrash, WorktreeManager, WorktreeSafetyError } = worktreeModule;

function command(git, args) {
  return execFileSync(git, args, { encoding: 'utf8', windowsHide: true }).trim();
}

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'tsukiori-gate2-'));
  const gitProbe = new GitProbe();
  const git = gitProbe.resolveWindowsGit();
  const repository = join(directory, 'repository');
  command(git, ['init', '--quiet', '--initial-branch=main', repository]);
  command(git, ['-C', repository, 'config', 'user.name', 'Fixture']);
  command(git, ['-C', repository, 'config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(repository, 'README.md'), '# gate2 fixture\n');
  command(git, ['-C', repository, 'add', 'README.md']);
  command(git, ['-C', repository, 'commit', '--quiet', '-m', 'fixture base']);
  const database = new LocalDatabase({ filePath: join(directory, 'state.db'), blobRoot: join(directory, 'blobs') });
  let clock = 1_800_000_500_000;
  let serial = 0;
  const now = () => ++clock;
  const id = () => 'id-' + ++serial;
  const environments = new ExecutionEnvironmentRegistry(database, { gitProbe, now });
  const environment = environments.registerWindowsNative({ gitExecutable: git, homePath: directory });
  const projects = new ProjectManager(database, environments, { gitProbe, now, id });
  const project = projects.add({ rootPath: repository, executionEnvironmentId: environment.id });
  const sessionIds = Array.from({ length: 10 }, (_, index) => 'session-' + (index + 1));
  for (const sessionId of sessionIds) {
    database.saveSession({
      id: sessionId, title: sessionId, projectId: project.id, runtimeType: 'fake',
      runtimeProfileId: 'profile', lifecycle: 'active', activity: 'idle', health: 'healthy',
      writeMode: 'isolated-worktree', createdAt: now(), updatedAt: clock,
    });
  }
  const worktreeRoot = join(directory, 'worktrees');
  function manager(crashAt, rootPath = worktreeRoot) {
    return new WorktreeManager(database, projects, environments, {
      worktreeRoot: rootPath, executionEnvironmentId: environment.id, now, id,
      ...(crashAt ? { crashAt } : {}),
    });
  }
  const stableManager = manager();
  const coordinator = new WorkspaceCoordinator(database, projects, environments, stableManager, { now, id });
  const gitService = new GitDiffService(database, projects, environments);
  t.after(() => {
    try { database.close(); } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  return {
    directory, git, repository, database, environments, environment, projects, project,
    sessionIds, worktreeRoot, manager, coordinator, gitService,
  };
}

test('T2.1 through T2.4 and every child Checkpoint are complete', () => {
  const architecture = readFileSync(architecturePath, 'utf8');
  for (const taskId of ['T2.1', 'T2.2', 'T2.3', 'T2.4']) {
    const section = architecture.match(new RegExp('^### ' + taskId.replace('.', '\\.') + '[\\s\\S]*?(?=^### )', 'm'));
    assert.ok(section, 'missing task section: ' + taskId);
    assert.equal(section[0].includes('- [ ]'), false, taskId + ' has an incomplete checkpoint');
    assert.equal(section[0].includes('- [x]'), true, taskId + ' has no completion evidence');
  }
});

test('three Fake Sessions modify three independent Worktrees without touching main', async (t) => {
  const f = fixture(t);
  const runtime = new FakeRuntimeAdapter();
  const runtimeSessions = Array.from({ length: 3 }, () => runtime.createSession());
  const bindings = runtimeSessions.map((runtimeSession, index) => {
    const host = f.database.readSession(f.sessionIds[index]);
    f.database.saveSession({ ...host, runtimeSessionId: runtimeSession.runtimeSessionId, updatedAt: host.updatedAt + 1 });
    return f.coordinator.createWritableSessionWorkspace({
      sessionId: f.sessionIds[index], projectId: f.project.id, runtimeType: 'fake', slug: 'parallel-' + index,
    }).binding;
  });
  await Promise.all(bindings.map(async (binding, index) => {
    runtime.runScript(runtimeSessions[index], [{ kind: 'event', nativeType: 'message.started', payload: { index } }]);
    await Promise.resolve();
    writeFileSync(join(binding.path, 'session-' + index + '.txt'), 'session ' + index + '\n');
    runtime.runScript(runtimeSessions[index], [{ kind: 'event', nativeType: 'message.completed', payload: { index } }]);
  }));
  assert.equal(new Set(bindings.map((binding) => binding.worktreeId)).size, 3);
  assert.equal(new Set(bindings.map((binding) => binding.path.toLowerCase())).size, 3);
  for (let index = 0; index < bindings.length; index += 1) {
    const status = f.gitService.status(f.sessionIds[index]);
    assert.equal(status.files.some((file) => file.path === 'session-' + index + '.txt'), true);
    for (let other = 0; other < bindings.length; other += 1) {
      assert.equal(existsSync(join(bindings[index].path, 'session-' + other + '.txt')), other === index);
    }
    assert.equal(runtimeSessions[index].activity, 'idle');
  }
  assert.equal(command(f.git, ['-C', f.repository, 'status', '--porcelain']), '');
  assert.equal(bindings.some((binding, index) => existsSync(join(f.repository, 'session-' + index + '.txt'))), false);
});

test('create and dirty-cleanup crash recovery keeps every uncommitted byte', (t) => {
  const f = fixture(t);
  const createCrash = f.manager((point) => {
    if (point === 'create_after_git_add') throw new InjectedDaemonCrash(point);
  });
  assert.throws(() => createCrash.create({
    projectId: f.project.id, sessionId: f.sessionIds[3], runtimeType: 'fake', slug: 'crash-recovery',
  }), InjectedDaemonCrash);
  const createRecovery = f.manager().recoverNonTerminal().at(-1);
  assert.equal(createRecovery.status, 'committed');
  const recovered = f.database.listWorktrees().find((worktree) => worktree.ownerSessionId === f.sessionIds[3]);
  const codePath = join(recovered.path, 'uncommitted-code.txt');
  writeFileSync(codePath, 'must survive cleanup crash\n');

  const cleanupCrash = f.manager((point) => {
    if (point === 'remove_after_running') throw new InjectedDaemonCrash(point);
  });
  assert.throws(() => cleanupCrash.remove(recovered.id), InjectedDaemonCrash);
  const cleanupRecovery = f.manager().recoverNonTerminal().at(-1);
  assert.equal(cleanupRecovery.status, 'failed');
  assert.equal(readFileSync(codePath, 'utf8'), 'must survive cleanup crash\n');
  assert.throws(() => f.manager().remove(recovered.id), /Dirty or untracked/);
  assert.equal(existsSync(codePath), true);
  const operations = f.database.listOperations();
  assert.equal(operations.filter((operation) => operation.type === 'worktree_create').length, 1);
  assert.equal(operations.filter((operation) => operation.type === 'worktree_remove').length, 2);
});

test('path, Junction, environment, delete, and Git boundaries reject escape attempts', (t) => {
  const f = fixture(t);
  assert.throws(() => f.manager().create({
    projectId: f.project.id, sessionId: f.sessionIds[0], runtimeType: 'fake', directoryName: '..',
  }), WorktreeSafetyError);

  const binding = f.coordinator.createWritableSessionWorkspace({
    sessionId: f.sessionIds[1], projectId: f.project.id, runtimeType: 'fake', slug: 'git-boundary',
  }).binding;
  assert.throws(() => f.gitService.diff(f.sessionIds[1], 'working', '..\\outside.txt'), GitServiceError);
  writeFileSync(join(binding.path, 'dirty.txt'), 'keep\n');
  assert.throws(() => f.manager().remove(binding.worktreeId), /Dirty or untracked/);
  assert.equal(existsSync(join(binding.path, 'dirty.txt')), true);

  const wslEnvironment = {
    id: 'environment:wsl:fixture', type: 'wsl', displayName: 'WSL Fixture', homePath: '/home/fixture',
    pathStyle: 'posix', defaultShell: 'bash', gitExecutable: '/usr/bin/git',
    capabilities: { pty: true, processGroups: true, jobObjects: false, symlinks: true },
    createdAt: 1, updatedAt: 1,
  };
  f.database.saveExecutionEnvironment(wslEnvironment);
  assert.throws(() => f.projects.assertBindings(f.project.id, {
    runtimeEnvironmentId: wslEnvironment.id, gitEnvironmentId: f.environment.id,
  }), /does not match/);

  const junctionRoot = join(f.directory, 'junction-worktrees');
  const unsafeManager = f.manager(undefined, junctionRoot);
  const projectDirectory = join(unsafeManager.worktreeRoot, f.project.repositoryId.slice(5, 17));
  const outside = join(f.directory, 'outside-junction');
  mkdirSync(outside);
  symlinkSync(outside, projectDirectory, 'junction');
  assert.throws(() => unsafeManager.create({
    projectId: f.project.id, sessionId: f.sessionIds[2], runtimeType: 'fake', slug: 'junction',
  }), WorktreeSafetyError);
});

test('published task evidence, CI runs, and commits are valid and credential-free', () => {
  const gate = JSON.parse(readFileSync(join(root, 'tests/fixtures/gates/g2-evidence.json'), 'utf8'));
  assert.equal(gate.gate, 'G2');
  assert.equal(gate.integration.fakeSessions, 3);
  assert.equal(gate.integration.independentWorktrees, 3);
  assert.equal(gate.integration.mainWorkspaceChanged, false);
  assert.equal(gate.recovery.uncommittedCodeRetained, true);
  assert.equal(gate.recovery.externalActionReplayed, false);
  assert.equal(Object.values(gate.security).every(Boolean), true);
  assert.equal(Object.values(gate.windowsCi).every((run) => run.conclusion === 'success'), true);
  assert.equal(gate.containsCredentials, false);
  assert.doesNotMatch(JSON.stringify(gate), /Bearer\\s+|-----BEGIN|sk-[A-Za-z0-9]/);
  for (const commit of Object.values(gate.taskCommits)) {
    execFileSync('git', ['merge-base', '--is-ancestor', commit, 'HEAD'], { cwd: root, stdio: 'ignore' });
  }
});
