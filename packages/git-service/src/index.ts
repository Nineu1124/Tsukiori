import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { isAbsolute, join, posix, resolve, win32 } from 'node:path';
import type { LocalDatabase } from '@tsukiori/database';
import type { JsonValue, OperationRecord, Project, WorkspaceBindingRecord, WorktreeRecord } from '@tsukiori/domain';
import { ExecutionEnvironmentRegistry, ProjectManager } from '@tsukiori/project-manager';

const DEFAULT_DIFF_LIMIT = 256 * 1024;
const DEFAULT_FILE_LIMIT = 1024 * 1024;
const METADATA_LIMIT = 2 * 1024 * 1024;

export class GitServiceError extends Error {
  constructor(message: string) { super(message); this.name = 'GitServiceError'; }
}

export type GitInvocation = {
  executable: string;
  args: readonly string[];
  cwd: string;
  shell: false;
};

export type GitFileKind =
  | 'modified' | 'added' | 'deleted' | 'renamed' | 'copied'
  | 'type-changed' | 'unmerged' | 'untracked' | 'unknown';

export type GitFileStatus = {
  path: string;
  originalPath?: string;
  kind: GitFileKind;
  indexStatus: string;
  workingStatus: string;
  staged: boolean;
  working: boolean;
  untracked: boolean;
  conflict: boolean;
};

export type GitStatusSnapshot = {
  sessionId: string;
  worktreeId: string;
  branch: string;
  headCommit: string;
  clean: boolean;
  files: GitFileStatus[];
};

export type DiffScope = 'working' | 'staged' | 'session-commit';
export type DiffDegradedReason = 'binary' | 'large' | 'untracked' | 'output-limit' | 'not-changed';

export type DiffResult = {
  scope: DiffScope;
  path?: string;
  available: boolean;
  degraded: boolean;
  degradedReason?: DiffDegradedReason;
  byteLength: number;
  content?: string;
  baseCommit?: string;
  headCommit: string;
};

export type GitCommitResult = {
  sessionId: string;
  worktreeId: string;
  branch: string;
  commitHash: string;
  subject: string;
  stagedPaths: string[];
};

export type GitRevertResult = {
  sessionId: string;
  worktreeId: string;
  snapshotRef: string;
  snapshotCommit: string;
  revertedPaths: string[];
  status: GitStatusSnapshot;
};

type GitContext = {
  sessionId: string;
  project: Project;
  binding: WorkspaceBindingRecord;
  worktree: WorktreeRecord;
  executable: string;
};

type CommandResult = { stdout: string; truncated: boolean };

class StructuredGitRunner {
  readonly #observe: ((invocation: GitInvocation) => void) | undefined;

  constructor(observe?: (invocation: GitInvocation) => void) { this.#observe = observe; }

  run(
    executable: string,
    cwd: string,
    args: readonly string[],
    maxBuffer = METADATA_LIMIT,
    environment: Readonly<Record<string, string>> = {},
  ): CommandResult {
    const invocation: GitInvocation = { executable, args: [...args], cwd, shell: false };
    this.#observe?.(invocation);
    const result = spawnSync(executable, [...args], {
      cwd, encoding: 'utf8', windowsHide: true, shell: false, timeout: 30_000, maxBuffer,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0', ...environment },
    });
    const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
    const truncated = errorCode === 'ENOBUFS';
    if ((!truncated && result.error) || (!truncated && result.status !== 0)) {
      throw new GitServiceError('Structured Git command failed');
    }
    return { stdout: result.stdout ?? '', truncated };
  }
}

export class GitDiffService {
  readonly #database: LocalDatabase;
  readonly #projects: ProjectManager;
  readonly #environments: ExecutionEnvironmentRegistry;
  readonly #runner: StructuredGitRunner;
  readonly #maxDiffBytes: number;
  readonly #maxFileBytes: number;
  readonly #now: () => number;
  readonly #id: () => string;
  readonly #faultInjector: ((point: 'after_revert_snapshot') => void) | undefined;

  constructor(
    database: LocalDatabase,
    projects: ProjectManager,
    environments: ExecutionEnvironmentRegistry,
    options: {
      maxDiffBytes?: number;
      maxFileBytes?: number;
      observeInvocation?: (invocation: GitInvocation) => void;
      now?: () => number;
      id?: () => string;
      faultInjector?: (point: 'after_revert_snapshot') => void;
    } = {},
  ) {
    this.#database = database;
    this.#projects = projects;
    this.#environments = environments;
    this.#maxDiffBytes = this.#positiveLimit(options.maxDiffBytes ?? DEFAULT_DIFF_LIMIT, 'Diff');
    this.#maxFileBytes = this.#positiveLimit(options.maxFileBytes ?? DEFAULT_FILE_LIMIT, 'File');
    this.#runner = new StructuredGitRunner(options.observeInvocation);
    this.#now = options.now ?? Date.now;
    this.#id = options.id ?? randomUUID;
    this.#faultInjector = options.faultInjector;
  }

  status(sessionId: string): GitStatusSnapshot {
    const context = this.#context(sessionId);
    const status = this.#git(context, ['status', '--porcelain=v2', '-z', '--untracked-files=all']).stdout;
    const files = this.#parseStatus(status);
    return {
      sessionId, worktreeId: context.worktree.id,
      branch: this.#git(context, ['branch', '--show-current']).stdout.trim(),
      headCommit: this.#head(context), clean: files.length === 0, files,
    };
  }

  diff(sessionId: string, scope: DiffScope, filePath?: string): DiffResult {
    const context = this.#context(sessionId);
    const path = filePath === undefined ? undefined : this.#relativePath(filePath);
    const headCommit = this.#head(context);
    const baseArgs = this.#diffBaseArgs(scope, context.binding.baseCommit);
    if (path && scope === 'working') {
      const status = this.status(sessionId).files.find((file) => file.path === path);
      if (status?.untracked) return this.#degraded(scope, headCommit, 'untracked', path, context.binding.baseCommit);
    }
    if (path && this.#workingFileLarge(context, path)) {
      return this.#degraded(scope, headCommit, 'large', path, context.binding.baseCommit);
    }
    if (path && this.#binary(context, baseArgs, path)) {
      return this.#degraded(scope, headCommit, 'binary', path, context.binding.baseCommit);
    }
    const args = [...baseArgs, '--no-ext-diff', '--no-color', '--binary'];
    if (path) args.push('--', path);
    const result = this.#git(context, args, this.#maxDiffBytes);
    const byteLength = Buffer.byteLength(result.stdout);
    if (result.truncated) {
      return this.#degraded(scope, headCommit, 'output-limit', path, context.binding.baseCommit, byteLength);
    }
    if (!result.stdout) {
      return this.#degraded(scope, headCommit, 'not-changed', path, context.binding.baseCommit, 0);
    }
    return {
      scope, ...(path ? { path } : {}), available: true, degraded: false,
      byteLength, content: result.stdout,
      ...(scope === 'session-commit' ? { baseCommit: context.binding.baseCommit } : {}), headCommit,
    };
  }

  sessionDiff(sessionId: string): {
    commit: DiffResult;
    staged: DiffResult;
    working: DiffResult;
  } {
    return {
      commit: this.diff(sessionId, 'session-commit'),
      staged: this.diff(sessionId, 'staged'),
      working: this.diff(sessionId, 'working'),
    };
  }

  reviewSessionDiff(sessionId: string): {
    commit: DiffResult;
    staged: DiffResult;
    working: DiffResult;
  } {
    const context = this.#context(sessionId);
    const operation = this.#begin('git_review', sessionId, {
      schemaVersion: 1, worktreeId: context.worktree.id, scopes: ['session-commit', 'staged', 'working'],
    });
    try {
      const diff = this.sessionDiff(sessionId);
      this.#complete(operation, {
        headCommit: diff.commit.headCommit,
        baseCommit: diff.commit.baseCommit ?? context.binding.baseCommit,
        commitAvailable: diff.commit.available,
        stagedAvailable: diff.staged.available,
        workingAvailable: diff.working.available,
        persistedDiffContent: false,
      });
      return diff;
    } catch (error) {
      this.#fail(operation, 'git_review_failed');
      throw error;
    }
  }

  stage(sessionId: string, filePaths: readonly string[]): GitStatusSnapshot {
    const context = this.#context(sessionId);
    const paths = this.#mutationPaths(sessionId, filePaths, 'Stage');
    const operation = this.#begin('git_stage', sessionId, {
      schemaVersion: 1, worktreeId: context.worktree.id, paths,
    });
    try {
      this.#git(context, ['add', '--', ...paths]);
      const status = this.status(sessionId);
      this.#complete(operation, { headCommit: status.headCommit, stagedPathCount: status.files.filter((file) => file.staged).length });
      return status;
    } catch (error) {
      this.#fail(operation, 'git_stage_failed');
      throw error;
    }
  }

  unstage(sessionId: string, filePaths: readonly string[]): GitStatusSnapshot {
    const context = this.#context(sessionId);
    const paths = this.#mutationPaths(sessionId, filePaths, 'Unstage', true);
    const operation = this.#begin('git_unstage', sessionId, {
      schemaVersion: 1, worktreeId: context.worktree.id, paths,
    });
    try {
      this.#git(context, ['restore', '--staged', '--', ...paths]);
      const status = this.status(sessionId);
      this.#complete(operation, { headCommit: status.headCommit, stagedPathCount: status.files.filter((file) => file.staged).length });
      return status;
    } catch (error) {
      this.#fail(operation, 'git_unstage_failed');
      throw error;
    }
  }

  revert(sessionId: string, filePaths: readonly string[]): GitRevertResult {
    const context = this.#context(sessionId);
    const paths = this.#mutationPaths(sessionId, filePaths, 'Revert');
    const operation = this.#begin('git_revert', sessionId, {
      schemaVersion: 1, worktreeId: context.worktree.id, paths,
    });
    let snapshot: { ref: string; commit: string } | undefined;
    try {
      snapshot = this.#recoverySnapshot(context);
      this.#faultInjector?.('after_revert_snapshot');
      const changed = new Map(this.status(sessionId).files.map((file) => [file.path, file]));
      const tracked = paths.filter((path) => changed.get(path)?.untracked !== true);
      const untracked = paths.filter((path) => changed.get(path)?.untracked === true);
      if (tracked.length > 0) this.#git(context, ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...tracked]);
      if (untracked.length > 0) this.#git(context, ['clean', '-f', '--', ...untracked]);
      const status = this.status(sessionId);
      this.#complete(operation, {
        snapshotRef: snapshot.ref, snapshotCommit: snapshot.commit, revertedPathCount: paths.length,
      });
      return {
        sessionId,
        worktreeId: context.worktree.id,
        snapshotRef: snapshot.ref,
        snapshotCommit: snapshot.commit,
        revertedPaths: paths,
        status,
      };
    } catch (error) {
      this.#fail(operation, 'git_revert_failed', snapshot ? {
        snapshotRef: snapshot.ref, snapshotCommit: snapshot.commit,
      } : undefined);
      throw error;
    }
  }

  commit(sessionId: string, subjectValue: string): GitCommitResult {
    const context = this.#context(sessionId);
    const subject = subjectValue.trim();
    if (!subject || subject.length > 200 || /[\r\n\0]/.test(subject)) {
      throw new GitServiceError('Commit subject must be one line between 1 and 200 characters');
    }
    const before = this.status(sessionId);
    if (before.files.some((file) => file.conflict)) throw new GitServiceError('Conflicts block Commit');
    const stagedPaths = before.files.filter((file) => file.staged).map((file) => file.path);
    if (stagedPaths.length === 0) throw new GitServiceError('Commit requires staged changes');
    const previousHead = before.headCommit;
    const operation = this.#begin('commit', sessionId, {
      schemaVersion: 1,
      worktreeId: context.worktree.id,
      stagedPaths,
      subjectHash: 'sha256:' + createHash('sha256').update(subject).digest('hex'),
      hooksDisabled: true,
      signingDisabled: true,
    });
    try {
      this.#git(context, [
        '-c', 'core.hooksPath=NUL',
        '-c', 'commit.gpgSign=false',
        'commit', '--no-gpg-sign', '--no-verify', '-m', subject,
      ]);
      const commitHash = this.#head(context);
      if (commitHash === previousHead) throw new GitServiceError('Commit did not advance HEAD');
      const at = this.#now();
      this.#database.saveWorkspaceBinding({
        ...context.binding,
        lastKnownCommit: commitHash,
        updatedAt: Math.max(at, context.binding.updatedAt + 1),
      });
      const result = {
        sessionId,
        worktreeId: context.worktree.id,
        branch: this.#git(context, ['branch', '--show-current']).stdout.trim(),
        commitHash,
        subject,
        stagedPaths,
      };
      this.#complete(operation, {
        commitHash, previousHead, worktreeId: context.worktree.id, stagedPathCount: stagedPaths.length,
      });
      return result;
    } catch (error) {
      this.#fail(operation, 'git_commit_failed');
      throw error;
    }
  }

  #context(sessionId: string): GitContext {
    const session = this.#database.readSession(sessionId);
    if (!session) throw new GitServiceError('Session not found');
    const binding = this.#database.readWorkspaceBinding(sessionId);
    if (!binding || binding.bindingType !== 'isolated-worktree') {
      throw new GitServiceError('Session does not have an isolated Workspace Binding');
    }
    const worktree = this.#database.readWorktree(binding.worktreeId);
    if (!worktree || worktree.ownerSessionId !== sessionId || worktree.projectId !== session.projectId) {
      throw new GitServiceError('Workspace Binding does not match its Worktree owner');
    }
    if (win32.normalize(worktree.path).toLowerCase() !== win32.normalize(binding.path).toLowerCase()) {
      throw new GitServiceError('Workspace Binding path does not match its Worktree record');
    }
    const project = this.#projects.get(session.projectId);
    const environment = this.#environments.get(project.executionEnvironmentId);
    this.#projects.assertBindings(project.id, {
      runtimeEnvironmentId: environment.id, gitEnvironmentId: environment.id, worktree,
    });
    return { sessionId, project, binding, worktree, executable: environment.gitExecutable };
  }

  #git(
    context: GitContext,
    args: readonly string[],
    maxBuffer?: number,
    environment?: Readonly<Record<string, string>>,
  ): CommandResult {
    return this.#runner.run(
      context.executable,
      context.worktree.path,
      ['-C', context.worktree.path, ...args],
      maxBuffer,
      environment,
    );
  }

  #recoverySnapshot(context: GitContext): { ref: string; commit: string } {
    const commonValue = this.#git(context, ['rev-parse', '--git-common-dir']).stdout.trim();
    const commonCandidate = isAbsolute(commonValue) || win32.isAbsolute(commonValue)
      ? commonValue
      : resolve(context.worktree.path, commonValue);
    const common = realpathSync.native(commonCandidate);
    if (context.project.canonicalGitDir
      && win32.normalize(common).toLowerCase() !== win32.normalize(context.project.canonicalGitDir).toLowerCase()) {
      throw new GitServiceError('Recovery snapshot Git directory does not match Project');
    }
    mkdirSync(join(common, 'tsukiori-recovery'), { recursive: true });
    const token = this.#id().replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64) || randomUUID();
    const indexPath = join(common, 'tsukiori-recovery', 'index-' + token);
    const environment = { GIT_INDEX_FILE: indexPath };
    try {
      this.#git(context, ['read-tree', 'HEAD'], undefined, environment);
      this.#git(context, ['add', '-A', '--', '.'], undefined, environment);
      const tree = this.#git(context, ['write-tree'], undefined, environment).stdout.trim();
      if (!/^[a-f0-9]{40,64}$/i.test(tree)) throw new GitServiceError('Recovery snapshot tree is invalid');
      const commit = this.#git(context, [
        '-c', 'commit.gpgSign=false', 'commit-tree', tree, '-p', 'HEAD', '-m', 'Tsukiori recovery snapshot',
      ], undefined, environment).stdout.trim();
      if (!/^[a-f0-9]{40,64}$/i.test(commit)) throw new GitServiceError('Recovery snapshot commit is invalid');
      const ref = 'refs/tsukiori/recovery/' + token;
      this.#git(context, ['update-ref', ref, commit]);
      return { ref, commit };
    } finally {
      for (const value of [indexPath, indexPath + '.lock']) {
        if (existsSync(value)) rmSync(value, { force: true });
      }
    }
  }

  #head(context: GitContext): string {
    const head = this.#git(context, ['rev-parse', '--verify', 'HEAD^{commit}']).stdout.trim();
    if (!/^[a-f0-9]{40,64}$/i.test(head)) throw new GitServiceError('Worktree HEAD is not a commit');
    return head;
  }

  #diffBaseArgs(scope: DiffScope, baseCommit: string): string[] {
    if (!/^[a-f0-9]{40,64}$/i.test(baseCommit)) throw new GitServiceError('Workspace base commit is invalid');
    if (scope === 'working') return ['diff'];
    if (scope === 'staged') return ['diff', '--cached'];
    return ['diff', baseCommit + '...HEAD'];
  }

  #binary(context: GitContext, baseArgs: readonly string[], path: string): boolean {
    const output = this.#git(context, [...baseArgs, '--numstat', '-z', '--', path]).stdout;
    return output.split('\0').some((record) => record.startsWith('-\t-\t'));
  }

  #workingFileLarge(context: GitContext, path: string): boolean {
    const absolute = win32.join(context.worktree.path, ...path.split('/'));
    return existsSync(absolute) && statSync(absolute).isFile() && statSync(absolute).size > this.#maxFileBytes;
  }

  #relativePath(value: string): string {
    if (!value || value.includes('\0') || isAbsolute(value) || win32.isAbsolute(value)) {
      throw new GitServiceError('Diff path must be repository-relative');
    }
    const normalized = posix.normalize(value.replaceAll('\\', '/'));
    if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/')) {
      throw new GitServiceError('Diff path escapes the Worktree');
    }
    return normalized;
  }

  #parseStatus(output: string): GitFileStatus[] {
    const records = output.split('\0');
    const files: GitFileStatus[] = [];
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (!record) continue;
      if (record.startsWith('? ')) {
        files.push({
          path: record.slice(2), kind: 'untracked', indexStatus: '?', workingStatus: '?',
          staged: false, working: true, untracked: true, conflict: false,
        });
        continue;
      }
      const ordinary = /^1 ([^ ]{2}) [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ (.*)$/.exec(record);
      if (ordinary) {
        const xy = ordinary[1] ?? '..';
        files.push(this.#file(ordinary[2] ?? '', xy, this.#kind(xy)));
        continue;
      }
      const renamed = /^2 ([^ ]{2}) [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ ([RC])[0-9]+ (.*)$/.exec(record);
      if (renamed) {
        const xy = renamed[1] ?? '..';
        const originalPath = records[index + 1] ?? '';
        index += 1;
        files.push(this.#file(renamed[3] ?? '', xy, renamed[2] === 'R' ? 'renamed' : 'copied', originalPath));
        continue;
      }
      const unmerged = /^u ([^ ]{2}) [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ (.*)$/.exec(record);
      if (unmerged) files.push(this.#file(unmerged[2] ?? '', unmerged[1] ?? 'UU', 'unmerged'));
    }
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }

  #file(path: string, xy: string, kind: GitFileKind, originalPath?: string): GitFileStatus {
    const indexStatus = xy[0] ?? '.';
    const workingStatus = xy[1] ?? '.';
    return {
      path, ...(originalPath ? { originalPath } : {}), kind, indexStatus, workingStatus,
      staged: indexStatus !== '.', working: workingStatus !== '.', untracked: false,
      conflict: kind === 'unmerged' || indexStatus === 'U' || workingStatus === 'U',
    };
  }

  #kind(xy: string): GitFileKind {
    if (xy.includes('U') || xy === 'AA' || xy === 'DD') return 'unmerged';
    const code = xy[1] !== '.' ? xy[1] : xy[0];
    if (code === 'M') return 'modified';
    if (code === 'A') return 'added';
    if (code === 'D') return 'deleted';
    if (code === 'T') return 'type-changed';
    return 'unknown';
  }

  #degraded(
    scope: DiffScope,
    headCommit: string,
    degradedReason: DiffDegradedReason,
    path?: string,
    baseCommit?: string,
    byteLength = 0,
  ): DiffResult {
    return {
      scope, ...(path ? { path } : {}), available: false, degraded: true, degradedReason, byteLength,
      ...(scope === 'session-commit' && baseCommit ? { baseCommit } : {}), headCommit,
    };
  }

  #mutationPaths(
    sessionId: string,
    filePaths: readonly string[],
    label: string,
    requireStaged = false,
  ): string[] {
    if (filePaths.length === 0 || filePaths.length > 256) {
      throw new GitServiceError(label + ' requires between 1 and 256 paths');
    }
    const paths = [...new Set(filePaths.map((value) => this.#relativePath(value)))];
    const changed = new Map(this.status(sessionId).files.map((file) => [file.path, file]));
    if (paths.some((path) => !changed.has(path))) {
      throw new GitServiceError(label + ' path is not present in the Session change set');
    }
    if (requireStaged && paths.some((path) => changed.get(path)?.staged !== true)) {
      throw new GitServiceError('Unstage path is not staged');
    }
    return paths;
  }

  #begin(type: OperationRecord['type'], sessionId: string, requestPayload: JsonValue): OperationRecord {
    const at = this.#now();
    const operation: OperationRecord = {
      id: 'record:' + this.#id(),
      operationId: 'operation:' + this.#id(),
      type,
      sessionId,
      status: 'prepared',
      requestPayload,
      createdAt: at,
      updatedAt: at,
    };
    this.#database.saveOperation(operation);
    const running = { ...operation, status: 'running' as const, updatedAt: this.#now() };
    this.#database.saveOperation(running);
    return running;
  }

  #complete(operation: OperationRecord, resultPayload: JsonValue): void {
    this.#database.saveOperation({
      ...operation, status: 'committed', resultPayload, updatedAt: this.#now(),
    });
  }

  #fail(operation: OperationRecord, code: string, resultPayload?: JsonValue): void {
    this.#database.saveOperation({
      ...operation,
      status: 'failed',
      ...(resultPayload === undefined ? {} : { resultPayload }),
      error: { code },
      updatedAt: this.#now(),
    });
  }

  #positiveLimit(value: number, label: string): number {
    if (!Number.isInteger(value) || value < 64) throw new GitServiceError(label + ' limit is invalid');
    return value;
  }
}

export * from './v1.js';
