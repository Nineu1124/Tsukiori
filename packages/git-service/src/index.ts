import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, posix, win32 } from 'node:path';
import type { LocalDatabase } from '@tsukiori/database';
import type { Project, WorkspaceBindingRecord, WorktreeRecord } from '@tsukiori/domain';
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

  run(executable: string, cwd: string, args: readonly string[], maxBuffer = METADATA_LIMIT): CommandResult {
    const invocation: GitInvocation = { executable, args: [...args], cwd, shell: false };
    this.#observe?.(invocation);
    const result = spawnSync(executable, [...args], {
      cwd, encoding: 'utf8', windowsHide: true, shell: false, timeout: 30_000, maxBuffer,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' },
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

  constructor(
    database: LocalDatabase,
    projects: ProjectManager,
    environments: ExecutionEnvironmentRegistry,
    options: {
      maxDiffBytes?: number;
      maxFileBytes?: number;
      observeInvocation?: (invocation: GitInvocation) => void;
    } = {},
  ) {
    this.#database = database;
    this.#projects = projects;
    this.#environments = environments;
    this.#maxDiffBytes = this.#positiveLimit(options.maxDiffBytes ?? DEFAULT_DIFF_LIMIT, 'Diff');
    this.#maxFileBytes = this.#positiveLimit(options.maxFileBytes ?? DEFAULT_FILE_LIMIT, 'File');
    this.#runner = new StructuredGitRunner(options.observeInvocation);
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

  #git(context: GitContext, args: readonly string[], maxBuffer?: number): CommandResult {
    return this.#runner.run(context.executable, context.worktree.path, ['-C', context.worktree.path, ...args], maxBuffer);
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

  #positiveLimit(value: number, label: string): number {
    if (!Number.isInteger(value) || value < 64) throw new GitServiceError(label + ' limit is invalid');
    return value;
  }
}
