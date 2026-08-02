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
const workspaceModule = await import(pathToFileURL(join(root, 'packages/workspace-manager/dist/index.js')).href);
const { ExecutionEnvironmentRegistry, GitProbe, ProjectManager } = projectModule;
const { ActionExecutor, WorkspaceCoordinator, WorkspaceSetupError } = workspaceModule;

function command(git, args) {
  return execFileSync(git, args, { encoding: 'utf8', windowsHide: true }).trim();
}

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'tsukiori-workspace-'));
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
  let clock = 1_800_000_300_000;
  let serial = 0;
  const now = () => ++clock;
  const id = () => 'id-' + ++serial;
  const environments = new ExecutionEnvironmentRegistry(database, { gitProbe, now });
  const environment = environments.registerWindowsNative({ gitExecutable: git, homePath: directory });
  const projects = new ProjectManager(database, environments, { gitProbe, now, id });
  let project = projects.add({ rootPath: repository, executionEnvironmentId: environment.id });
  const sessionIds = Array.from({ length: 6 }, (_, index) => 'session-' + (index + 1));
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
  const actions = new ActionExecutor(database, { now, id });
  const coordinator = new WorkspaceCoordinator(database, projects, environments, worktrees, {
    actionExecutor: actions, now, id,
  });
  function configure(input) {
    project = { ...projects.get(project.id), ...input, updatedAt: now() };
    database.saveProject(project);
    return project;
  }
  t.after(() => {
    try { database.close(); } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  return {
    directory, git, repository, database, environments, environment, projects,
    get project() { return project; }, sessionIds, worktrees, actions, coordinator, configure,
  };
}

test('published T2.3 fixture is sanitized and encodes the completion contract', () => {
  const result = JSON.parse(readFileSync(join(root, 'tests/fixtures/workspace/t2.3-result.json'), 'utf8'));
  assert.equal(result.task, 'T2.3');
  assert.equal(result.actionExecution.structuredExecUsesShell, false);
  assert.equal(result.actionExecution.shellRequiresApprovalSource, true);
  assert.equal(result.setupFailure.automaticDelete, false);
  assert.equal(result.workspaceBinding.oneWritableSessionPerWorktree, true);
  assert.equal(result.archive.retainsSessionCommitWorktreeLink, true);
  assert.equal(result.containsCredentials, false);
});

test('structured exec and explicitly approved Shell produce distinct, redacted audits', (t) => {
  const f = fixture(t);
  const worktree = f.worktrees.create({
    projectId: f.project.id, sessionId: f.sessionIds[0], runtimeType: 'fake', slug: 'audit',
  });
  const context = {
    projectId: f.project.id, sessionId: f.sessionIds[0], worktreeId: worktree.id,
    worktreePath: worktree.path, phase: 'setup',
  };
  const execResult = f.actions.run([{
    type: 'exec', executable: process.execPath, args: ['-e', "process.stdout.write('exec-ok')"],
  }], context);
  const shellScript = "Write-Output 'shell-ok'";
  const shellResult = f.actions.run([{
    type: 'shell', shell: 'powershell', script: shellScript, approvalSource: 'permission:test-user',
  }], context);
  assert.equal(execResult.success, true);
  assert.equal(execResult.results[0].stdout, 'exec-ok');
  assert.equal(shellResult.success, true);
  assert.match(shellResult.results[0].stdout, /shell-ok/);
  const [execAudit, shellAudit] = f.database.listActionAudits(worktree.id);
  assert.equal(execAudit.actionType, 'exec');
  assert.equal(execAudit.executable, process.execPath);
  assert.equal(execAudit.shellType, undefined);
  assert.equal(shellAudit.actionType, 'shell');
  assert.equal(shellAudit.executable, undefined);
  assert.equal(shellAudit.shellType, 'powershell');
  assert.equal(shellAudit.approvalSource, 'permission:test-user');
  assert.match(shellAudit.scriptHash, /^sha256:[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(shellAudit), /Write-Output|shell-ok/);
  assert.equal(shellAudit.diagnostic.outputPersistence, 'hash-and-byte-count-only');
});

test('unsupported or unapproved Shell is rejected before process execution', (t) => {
  const f = fixture(t);
  const worktree = f.worktrees.create({
    projectId: f.project.id, sessionId: f.sessionIds[0], runtimeType: 'fake', slug: 'shell-reject',
  });
  const context = {
    projectId: f.project.id, sessionId: f.sessionIds[0], worktreeId: worktree.id,
    worktreePath: worktree.path, phase: 'setup',
  };
  assert.throws(() => f.actions.run([{
    type: 'shell', shell: 'powershell', script: 'exit 0', approvalSource: '',
  }], context), WorkspaceSetupError);
  assert.throws(() => f.actions.run([{
    type: 'shell', shell: 'bash', script: 'exit 0', approvalSource: 'permission:test-user',
  }], context), WorkspaceSetupError);
  assert.equal(f.database.listActionAudits(worktree.id).length, 0);
});

test('Setup failure preserves a dirty, diagnosable Worktree and never auto-removes code', (t) => {
  const f = fixture(t);
  f.configure({ setupActions: [
    { type: 'exec', executable: process.execPath, args: ['-e', "require('node:fs').writeFileSync('setup-artifact.txt','kept')"] },
    { type: 'exec', executable: process.execPath, args: ['-e', 'process.exit(7)'] },
  ] });
  const result = f.coordinator.createWritableSessionWorkspace({
    sessionId: f.sessionIds[0], projectId: f.project.id, runtimeType: 'fake', slug: 'setup-failure',
  });
  assert.equal(result.setup.success, false);
  assert.equal(result.binding.status, 'setup_failed');
  assert.equal(result.binding.cleanupState, 'retained');
  assert.equal(existsSync(result.binding.path), true);
  assert.equal(readFileSync(join(result.binding.path, 'setup-artifact.txt'), 'utf8'), 'kept');
  assert.equal(f.database.readWorktree(result.binding.worktreeId).status, 'dirty');
  assert.equal(f.database.readSession(f.sessionIds[0]).health, 'error');
  const audits = f.database.listActionAudits(result.binding.worktreeId);
  assert.equal(audits.length, 2);
  assert.equal(audits[1].status, 'failed');
  assert.equal(audits[1].exitCode, 7);
  assert.match(audits[1].diagnostic.stderrHash, /^sha256:/);
  assert.equal(f.database.listOperations().some((operation) => operation.type === 'worktree_remove'), false);
});

test('every writable Session gets an independent Worktree and binding', (t) => {
  const f = fixture(t);
  const first = f.coordinator.createWritableSessionWorkspace({
    sessionId: f.sessionIds[0], projectId: f.project.id, runtimeType: 'fake', slug: 'first',
  });
  const second = f.coordinator.createWritableSessionWorkspace({
    sessionId: f.sessionIds[1], projectId: f.project.id, runtimeType: 'fake', slug: 'second',
  });
  assert.notEqual(first.binding.id, second.binding.id);
  assert.notEqual(first.binding.worktreeId, second.binding.worktreeId);
  assert.notEqual(first.binding.path.toLowerCase(), second.binding.path.toLowerCase());
  assert.equal(f.database.readSession(f.sessionIds[0]).primaryWorkspaceBindingId, first.binding.id);
  assert.equal(f.database.readSession(f.sessionIds[1]).primaryWorkspaceBindingId, second.binding.id);
});

test('archive defaults to retention and preserves Session, Commit, Worktree, and cleanup traceability', (t) => {
  const f = fixture(t);
  const created = f.coordinator.createWritableSessionWorkspace({
    sessionId: f.sessionIds[0], projectId: f.project.id, runtimeType: 'fake', slug: 'archive-retain',
  });
  const archived = f.coordinator.archive(f.sessionIds[0]);
  const session = f.database.readSession(f.sessionIds[0]);
  const binding = f.database.readWorkspaceBinding(f.sessionIds[0]);
  const worktree = f.database.readWorktree(created.binding.worktreeId);
  assert.equal(session.lifecycle, 'archived');
  assert.equal(binding.status, 'archived');
  assert.equal(binding.cleanupState, 'retained');
  assert.equal(binding.lastKnownCommit, command(f.git, ['-C', created.binding.path, 'rev-parse', 'HEAD^{commit}']));
  assert.equal(worktree.status, 'active');
  assert.equal(existsSync(worktree.path), true);
  assert.equal(archived.binding.id, session.primaryWorkspaceBindingId);
});

test('explicit cleanup runs audited actions and removes only a clean Worktree', (t) => {
  const f = fixture(t);
  f.configure({ cleanupActions: [
    { type: 'exec', executable: process.execPath, args: ['-e', "process.stdout.write('cleanup-ok')"] },
  ] });
  const created = f.coordinator.createWritableSessionWorkspace({
    sessionId: f.sessionIds[0], projectId: f.project.id, runtimeType: 'fake', slug: 'archive-clean',
  });
  const archived = f.coordinator.archive(f.sessionIds[0], { cleanup: 'run' });
  assert.equal(archived.cleanup.success, true);
  assert.equal(archived.binding.cleanupState, 'succeeded');
  assert.equal(existsSync(created.binding.path), false);
  assert.equal(f.database.readWorktree(created.binding.worktreeId).status, 'removed');
  const audit = f.database.listActionAudits(created.binding.worktreeId).find((item) => item.phase === 'cleanup');
  assert.equal(audit.status, 'succeeded');
  assert.equal(audit.diagnostic.outputPersistence, 'hash-and-byte-count-only');
});
test('a failing Cleanup action records failed and does not attempt Worktree removal', (t) => {
  const f = fixture(t);
  f.configure({ cleanupActions: [
    { type: 'exec', executable: process.execPath, args: ['-e', 'process.exit(9)'] },
  ] });
  const created = f.coordinator.createWritableSessionWorkspace({
    sessionId: f.sessionIds[0], projectId: f.project.id, runtimeType: 'fake', slug: 'cleanup-failed',
  });
  const archived = f.coordinator.archive(f.sessionIds[0], { cleanup: 'run' });
  assert.equal(archived.cleanup.success, false);
  assert.equal(archived.binding.cleanupState, 'failed');
  assert.equal(existsSync(created.binding.path), true);
  assert.equal(f.database.readWorktree(created.binding.worktreeId).status, 'active');
  assert.equal(f.database.listOperations().some((operation) => operation.type === 'worktree_remove'), false);
});

test('dirty Worktree cleanup is blocked and retains uncommitted code', (t) => {
  const f = fixture(t);
  const created = f.coordinator.createWritableSessionWorkspace({
    sessionId: f.sessionIds[0], projectId: f.project.id, runtimeType: 'fake', slug: 'cleanup-blocked',
  });
  writeFileSync(join(created.binding.path, 'uncommitted.txt'), 'retain me\n');
  const archived = f.coordinator.archive(f.sessionIds[0], { cleanup: 'run' });
  assert.equal(archived.cleanup.success, true);
  assert.equal(archived.binding.cleanupState, 'blocked');
  assert.equal(existsSync(join(created.binding.path, 'uncommitted.txt')), true);
  assert.equal(f.database.readWorktree(created.binding.worktreeId).status, 'active');
  assert.equal(f.database.listOperations().filter((operation) => operation.type === 'worktree_remove').at(-1).status, 'failed');
});