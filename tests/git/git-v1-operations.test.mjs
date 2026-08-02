import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
const {
  GitDiffService, IntegrationMergeService, GitIntegrationError,
} = await import(pathToFileURL(join(root, 'packages/git-service/dist/index.js')).href);

function command(git, args, options = {}) {
  return execFileSync(git, args, {
    encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options,
  }).trim();
}

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'tsukiori-git-v1-'));
  const gitProbe = new GitProbe();
  const git = gitProbe.resolveWindowsGit();
  const repository = join(directory, 'repository');
  mkdirSync(repository);
  command(git, ['init', '--quiet', '--initial-branch=main', repository]);
  command(git, ['-C', repository, 'config', 'user.name', 'Git V1 Fixture']);
  command(git, ['-C', repository, 'config', 'user.email', 'git-v1@example.invalid']);
  writeFileSync(join(repository, 'README.md'), 'base\n');
  command(git, ['-C', repository, 'add', '--', 'README.md']);
  command(git, ['-C', repository, 'commit', '--quiet', '-m', 'base']);
  const database = new LocalDatabase({ filePath: join(directory, 'state.db'), blobRoot: join(directory, 'blobs') });
  let clock = 1_800_005_000_000;
  let serial = 0;
  const now = () => ++clock;
  const id = () => 'git-v1-id-' + ++serial;
  const environments = new ExecutionEnvironmentRegistry(database, { gitProbe, now });
  const environment = environments.registerWindowsNative({ gitExecutable: git, homePath: directory });
  const projects = new ProjectManager(database, environments, { gitProbe, now, id });
  const project = projects.add({ rootPath: repository, executionEnvironmentId: environment.id });
  const sessionIds = Array.from({ length: 8 }, (_, index) => 'git-v1-session-' + (index + 1));
  for (const sessionId of sessionIds) {
    database.saveSession({
      id: sessionId, title: sessionId, projectId: project.id, runtimeType: indexRuntime(sessionId),
      runtimeProfileId: 'profile', lifecycle: 'active', activity: 'idle', health: 'healthy',
      writeMode: 'isolated-worktree', createdAt: now(), updatedAt: clock,
    });
  }
  const worktrees = new WorktreeManager(database, projects, environments, {
    worktreeRoot: join(directory, 'worktrees'), executionEnvironmentId: environment.id, now, id,
  });
  const workspaces = new WorkspaceCoordinator(database, projects, environments, worktrees, { now, id });
  const permissions = new PermissionBroker(database, { now, id });
  function workspace(index, slug = 'v1-' + index) {
    return workspaces.createWritableSessionWorkspace({
      sessionId: sessionIds[index], projectId: project.id, runtimeType: 'codex', slug,
    }).binding;
  }
  function gitService(options = {}) {
    return new GitDiffService(database, projects, environments, { now, id, ...options });
  }
  function integrations(options = {}) {
    return new IntegrationMergeService({
      database, projects, environments, permissions,
      integrationRoot: join(directory, 'integrations'), now, id, ...options,
    });
  }
  t.after(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  });
  return {
    directory, git, repository, database, environment, project, sessionIds,
    permissions, workspace, gitService, integrations,
  };
}

function indexRuntime(sessionId) { return sessionId.endsWith('1') ? 'opencode' : 'codex'; }

test('published T4.4 fixture is sanitized and declares V1 Git safety boundaries', () => {
  const result = JSON.parse(readFileSync(join(root, 'tests/fixtures/git/t4.4-result.json'), 'utf8'));
  assert.equal(result.task, 'T4.4');
  assert.deepEqual(result.auditedOperations, [
    'git_review', 'git_stage', 'git_unstage', 'commit', 'git_revert', 'merge', 'rebase',
  ]);
  assert.equal(result.revert.failureRetainsSnapshot, true);
  assert.equal(result.integration.mainWorkspaceModified, false);
  assert.equal(result.integration.targetPromotion, 'explicit-required');
  assert.equal(result.integration.submodulePolicy, 'unsupported-fail-closed');
  assert.equal(result.containsCredentials, false);
  assert.equal(result.containsSourceOrDiff, false);
});
test('Stage, Unstage, Commit, and Session Commit Diff are durable and auditable', (t) => {
  const f = fixture(t);
  const binding = f.workspace(0);
  const service = f.gitService();
  writeFileSync(join(binding.path, 'README.md'), 'changed\n');
  writeFileSync(join(binding.path, 'new.txt'), 'new\n');
  service.stage(f.sessionIds[0], ['README.md', 'new.txt']);
  let status = service.unstage(f.sessionIds[0], ['new.txt']);
  assert.equal(status.files.find((file) => file.path === 'new.txt').staged, false);
  service.stage(f.sessionIds[0], ['new.txt']);
  const committed = service.commit(f.sessionIds[0], 'feat: auditable git v1');
  assert.equal(service.reviewSessionDiff(f.sessionIds[0]).commit.available, true);
  assert.equal(service.status(f.sessionIds[0]).clean, true);

  const operations = f.database.listOperations().filter((item) => item.sessionId === f.sessionIds[0]);
  assert.deepEqual(operations.map((item) => item.type), ['worktree_create', 'git_stage', 'git_unstage', 'git_stage', 'commit', 'git_review']);
  assert.equal(operations.every((item) => item.status === 'committed'), true);
  const commitAudit = operations.find((item) => item.type === 'commit');
  const reviewAudit = operations.find((item) => item.type === 'git_review');
  assert.equal(reviewAudit.resultPayload.persistedDiffContent, false);
  assert.equal(commitAudit.resultPayload.commitHash, committed.commitHash);
  assert.match(commitAudit.requestPayload.subjectHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(commitAudit).includes('auditable git v1'), false);
});

test('Revert snapshots tracked and untracked bytes before deletion and preserves snapshot on failure', (t) => {
  const f = fixture(t);
  const binding = f.workspace(0);
  const service = f.gitService();
  writeFileSync(join(binding.path, 'README.md'), 'recover tracked\n');
  writeFileSync(join(binding.path, 'recover.txt'), 'recover untracked\n');
  const reverted = service.revert(f.sessionIds[0], ['README.md', 'recover.txt']);
  assert.equal(reverted.status.clean, true);
  assert.equal(existsSync(join(binding.path, 'recover.txt')), false);
  assert.equal(command(f.git, ['-C', binding.path, 'show', reverted.snapshotCommit + ':README.md']), 'recover tracked');
  assert.equal(command(f.git, ['-C', binding.path, 'show', reverted.snapshotCommit + ':recover.txt']), 'recover untracked');
  assert.equal(command(f.git, ['-C', binding.path, 'rev-parse', reverted.snapshotRef]), reverted.snapshotCommit);

  writeFileSync(join(binding.path, 'README.md'), 'survive injected failure\n');
  const failing = f.gitService({ faultInjector: () => { throw new Error('injected'); } });
  assert.throws(() => failing.revert(f.sessionIds[0], ['README.md']), /injected/);
  assert.equal(readFileSync(join(binding.path, 'README.md'), 'utf8'), 'survive injected failure\n');
  const failed = f.database.listOperations().filter((item) => item.type === 'git_revert').at(-1);
  assert.equal(failed.status, 'failed');
  assert.match(failed.resultPayload.snapshotRef, /^refs\/tsukiori\/recovery\//);
  assert.equal(command(f.git, ['-C', binding.path, 'show', failed.resultPayload.snapshotCommit + ':README.md']), 'survive injected failure');
});

test('Merge and Rebase verify in Integration Worktrees without touching main or invoking signing', (t) => {
  const f = fixture(t);
  const mergeBinding = f.workspace(0, 'merge-source');
  const rebaseBinding = f.workspace(1, 'rebase-source');
  const git = f.gitService();
  writeFileSync(join(mergeBinding.path, 'merge.txt'), 'merge source\n');
  git.stage(f.sessionIds[0], ['merge.txt']);
  git.commit(f.sessionIds[0], 'feat: merge source');
  writeFileSync(join(rebaseBinding.path, 'rebase.txt'), 'rebase source\n');
  git.stage(f.sessionIds[1], ['rebase.txt']);
  git.commit(f.sessionIds[1], 'feat: rebase source');

  writeFileSync(join(f.repository, 'target.txt'), 'target advance\n');
  command(f.git, ['-C', f.repository, 'add', '--', 'target.txt']);
  command(f.git, ['-C', f.repository, 'commit', '--quiet', '-m', 'target advance']);
  command(f.git, ['-C', f.repository, 'config', 'commit.gpgSign', 'true']);
  command(f.git, ['-C', f.repository, 'config', 'gpg.program', join(f.directory, 'missing-signer.exe')]);
  const mainHead = command(f.git, ['-C', f.repository, 'rev-parse', 'HEAD']);
  const invocations = [];
  const service = f.integrations({ observeInvocation: (value) => invocations.push(value) });
  const verification = [{ executable: f.git, args: ['diff', '--check', 'HEAD^', 'HEAD'] }];

  const merged = service.integrate({
    sourceSessionId: f.sessionIds[0], targetRef: 'main', strategy: 'merge', verificationCommands: verification,
  });
  assert.equal(merged.status, 'verified');
  assert.equal(merged.retained, false);
  assert.equal(existsSync(merged.integrationPath), false);
  assert.equal(command(f.git, ['-C', f.repository, 'show', merged.resultCommit + ':merge.txt']), 'merge source');
  assert.equal(command(f.git, ['-C', f.repository, 'rev-parse', 'HEAD']), mainHead);
  assert.equal(command(f.git, ['-C', f.repository, 'status', '--porcelain']), '');

  const rebased = service.integrate({
    sourceSessionId: f.sessionIds[1], targetRef: 'main', strategy: 'rebase', verificationCommands: verification,
  });
  assert.equal(rebased.status, 'verified');
  assert.equal(command(f.git, ['-C', f.repository, 'show', rebased.resultCommit + ':rebase.txt']), 'rebase source');
  assert.equal(command(f.git, ['-C', f.repository, 'rev-parse', 'HEAD']), mainHead);
  const mergeInvocation = invocations.find((item) => item.args.includes('merge'));
  assert.equal(mergeInvocation.shell, false);
  assert.equal(mergeInvocation.args.includes('--no-gpg-sign'), true);
  assert.equal(mergeInvocation.args.includes('commit.gpgSign=false'), true);
  assert.equal(invocations.every((item) => item.shell === false), true);
});

test('conflicts enter Attention Center, expose external editor target, and can continue safely', (t) => {
  const f = fixture(t);
  const binding = f.workspace(0, 'conflict-source');
  const git = f.gitService();
  writeFileSync(join(binding.path, 'README.md'), 'session side\n');
  git.stage(f.sessionIds[0], ['README.md']);
  git.commit(f.sessionIds[0], 'feat: session conflict');
  writeFileSync(join(f.repository, 'README.md'), 'target side\n');
  command(f.git, ['-C', f.repository, 'add', '--', 'README.md']);
  command(f.git, ['-C', f.repository, 'commit', '--quiet', '-m', 'target conflict']);
  const mainHead = command(f.git, ['-C', f.repository, 'rev-parse', 'HEAD']);
  const service = f.integrations();
  const result = service.integrate({ sourceSessionId: f.sessionIds[0], targetRef: 'main', strategy: 'merge' });
  assert.equal(result.status, 'conflicted');
  assert.deepEqual(result.conflictPaths, ['README.md']);
  assert.equal(result.retained, true);
  assert.equal(existsSync(result.integrationPath), true);
  assert.equal(command(f.git, ['-C', f.repository, 'rev-parse', 'HEAD']), mainHead);
  const attention = f.permissions.snapshot().attention.find((item) => item.kind === 'conflict' && item.status === 'open');
  assert.equal(attention.payload.operationId, result.operationId);
  const editor = service.externalEditorInvocation(result.integrationPath, process.execPath, ['--version']);
  assert.equal(editor.shell, false);
  assert.equal(editor.args.at(-1), result.integrationPath);
  assert.throws(() => service.externalEditorInvocation(result.integrationPath, 'code'), GitIntegrationError);
  const outside = join(f.directory, 'outside-editor-target');
  const junction = join(service.integrationRoot, 'editor-junction');
  mkdirSync(outside);
  symlinkSync(outside, junction, 'junction');
  assert.throws(() => service.externalEditorInvocation(junction, process.execPath), /canonical path changed|escapes/);

  writeFileSync(join(result.integrationPath, 'README.md'), 'resolved\n');
  command(f.git, ['-C', result.integrationPath, 'add', '--', 'README.md']);
  const continued = service.continue({ operationId: result.operationId });
  assert.equal(continued.status, 'verified');
  assert.equal(existsSync(result.integrationPath), false);
  assert.equal(f.permissions.snapshot().attention.find((item) => item.id === attention.id).status, 'resolved');
  assert.equal(command(f.git, ['-C', f.repository, 'rev-parse', 'HEAD']), mainHead);
});

test('Submodule gitlinks are rejected before an Integration Worktree or Operation is created', (t) => {
  const f = fixture(t);
  const binding = f.workspace(0, 'submodule-source');
  const head = command(f.git, ['-C', binding.path, 'rev-parse', 'HEAD']);
  command(f.git, ['-C', binding.path, 'update-index', '--add', '--cacheinfo', '160000,' + head + ',vendor/sub']);
  command(f.git, ['-C', binding.path, 'commit', '--quiet', '-m', 'add gitlink fixture']);
  const before = f.database.listOperations().length;
  assert.throws(() => f.integrations().integrate({
    sourceSessionId: f.sessionIds[0], targetRef: 'main', strategy: 'merge',
  }), /Submodule integration requires explicit future support/);
  assert.equal(f.database.listOperations().length, before);
});