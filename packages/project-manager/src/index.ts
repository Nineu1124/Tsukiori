import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute as isPosixAbsolute, join, win32 } from 'node:path';
import type { LocalDatabase } from '@tsukiori/database';
import type { ExecutionEnvironment, Project, WorktreeRecord } from '@tsukiori/domain';

export class EnvironmentBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvironmentBoundaryError';
  }
}

export class ProjectRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectRegistrationError';
  }
}

type CommandResult = { stdout: string; ok: true } | { stdout: string; ok: false };

function execute(executable: string, args: readonly string[], cwd?: string): string {
  return execFileSync(executable, [...args], {
    ...(cwd === undefined ? {} : { cwd }),
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function tryExecute(executable: string, args: readonly string[], cwd?: string): CommandResult {
  try {
    return { ok: true, stdout: execute(executable, args, cwd) };
  } catch {
    return { ok: false, stdout: '' };
  }
}

export type ExecutionPathKind = 'windows-native' | 'wsl' | 'posix' | 'relative';

export function classifyExecutionPath(value: string): ExecutionPathKind {
  if (/^\\\\(?:wsl\$|wsl\.localhost)\\/i.test(value)) return 'wsl';
  if (/^\/(?:mnt\/[a-z]|home|usr|var|opt|tmp)(?:\/|$)/i.test(value)) return 'wsl';
  if (win32.isAbsolute(value)) return 'windows-native';
  if (isPosixAbsolute(value)) return 'posix';
  return 'relative';
}

export function assertPathForEnvironment(
  environment: Pick<ExecutionEnvironment, 'type' | 'id'>,
  value: string,
  label: string,
): void {
  if (!value || value.includes('\0')) throw new EnvironmentBoundaryError(label + ' is empty or invalid');
  const kind = classifyExecutionPath(value);
  if (environment.type === 'windows-native') {
    if (kind !== 'windows-native') {
      throw new EnvironmentBoundaryError(label + ' must be a Windows Native absolute path, received ' + kind);
    }
    return;
  }
  if (environment.type === 'wsl' || environment.type === 'linux' || environment.type === 'macos') {
    if (kind !== 'wsl' && kind !== 'posix') {
      throw new EnvironmentBoundaryError(label + ' must be a POSIX path for ' + environment.type);
    }
    return;
  }
  if (kind === 'relative') throw new EnvironmentBoundaryError(label + ' must be absolute');
}

export function assertEnvironmentConsistency(input: {
  project: Project;
  environment: ExecutionEnvironment;
  runtimeEnvironmentId: string;
  gitEnvironmentId: string;
  runtimeExecutable?: string;
  worktree?: WorktreeRecord;
}): void {
  const expected = input.environment.id;
  const bindings: Array<[string, string]> = [
    ['project', input.project.executionEnvironmentId],
    ['runtime', input.runtimeEnvironmentId],
    ['git', input.gitEnvironmentId],
  ];
  if (input.worktree) bindings.push(['worktree', input.worktree.executionEnvironmentId]);
  for (const [label, actual] of bindings) {
    if (actual !== expected) {
      throw new EnvironmentBoundaryError(label + ' environment ' + actual + ' does not match ' + expected);
    }
  }
  assertPathForEnvironment(input.environment, input.environment.gitExecutable, 'Git executable');
  assertPathForEnvironment(input.environment, input.project.rootPath, 'Project root');
  assertPathForEnvironment(input.environment, input.project.gitRoot, 'Git root');
  if (input.project.canonicalGitDir) {
    assertPathForEnvironment(input.environment, input.project.canonicalGitDir, 'Canonical Git dir');
  }
  if (input.runtimeExecutable) {
    assertPathForEnvironment(input.environment, input.runtimeExecutable, 'Runtime executable');
  }
  if (input.worktree) assertPathForEnvironment(input.environment, input.worktree.path, 'Worktree path');
}

export type GitInstallationProbe = {
  executable: string;
  version: string;
  capabilities: NonNullable<ExecutionEnvironment['gitCapabilities']>;
};

export type GitRepositoryProbe = {
  rootPath: string;
  gitRoot: string;
  canonicalGitDir: string;
  repositoryId: string;
  currentBranch?: string;
  defaultBranch?: string;
  remoteCount: number;
  isDirty: boolean;
};

export class GitProbe {
  resolveWindowsGit(provided?: string): string {
    const candidate = provided ?? execute('where.exe', ['git']).split(/\r?\n/)[0];
    if (!candidate) throw new ProjectRegistrationError('Windows Git executable was not found');
    assertPathForEnvironment({ id: 'windows-native', type: 'windows-native' }, candidate, 'Git executable');
    if (!/git\.exe$/i.test(candidate)) throw new EnvironmentBoundaryError('Windows Git executable must end in git.exe');
    if (!existsSync(candidate)) throw new ProjectRegistrationError('Git executable does not exist');
    return realpathSync.native(candidate);
  }

  probeInstallation(executable: string): GitInstallationProbe {
    assertPathForEnvironment({ id: 'windows-native', type: 'windows-native' }, executable, 'Git executable');
    const versionOutput = execute(executable, ['--version']);
    const match = /^git version\s+([^\s]+)/i.exec(versionOutput);
    if (!match?.[1]) throw new ProjectRegistrationError('Git version output is not understood');
    const probeRoot = mkdtempSync(join(tmpdir(), 'tsukiori-git-probe-'));
    try {
      execute(executable, ['init', '--quiet', probeRoot]);
      const worktree = tryExecute(executable, ['-C', probeRoot, 'worktree', 'list', '--porcelain']).ok;
      const porcelainV2 = tryExecute(executable, ['-C', probeRoot, 'status', '--porcelain=v2', '-z']).ok;
      const lfs = tryExecute(executable, ['lfs', 'version']).ok;
      const symlinks = tryExecute(executable, ['-C', probeRoot, 'config', '--bool', 'core.symlinks']).stdout === 'true';
      return {
        executable: realpathSync.native(executable),
        version: match[1],
        capabilities: { worktree, porcelainV2, lfs, symlinks },
      };
    } finally {
      rmSync(probeRoot, { recursive: true, force: true });
    }
  }

  probeRepository(rootPath: string, environment: ExecutionEnvironment): GitRepositoryProbe {
    if (environment.type !== 'windows-native') {
      throw new EnvironmentBoundaryError('T2.1 Git probe supports only windows-native');
    }
    assertPathForEnvironment(environment, rootPath, 'Project root');
    assertPathForEnvironment(environment, environment.gitExecutable, 'Git executable');
    if (!existsSync(rootPath) || !statSync(rootPath).isDirectory()) {
      throw new ProjectRegistrationError('Project root is not a directory');
    }
    const canonicalRoot = realpathSync.native(rootPath);
    const reportedRoot = execute(environment.gitExecutable, ['-C', canonicalRoot, 'rev-parse', '--show-toplevel']);
    const reportedGitDir = execute(environment.gitExecutable, ['-C', canonicalRoot, 'rev-parse', '--absolute-git-dir']);
    const gitRoot = realpathSync.native(reportedRoot);
    const canonicalGitDir = realpathSync.native(reportedGitDir);
    assertPathForEnvironment(environment, gitRoot, 'Git root');
    assertPathForEnvironment(environment, canonicalGitDir, 'Canonical Git dir');
    const currentBranchResult = tryExecute(environment.gitExecutable, ['-C', gitRoot, 'branch', '--show-current']);
    const originHead = tryExecute(environment.gitExecutable, [
      '-C', gitRoot, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD',
    ]);
    const defaultBranch = originHead.ok && originHead.stdout
      ? originHead.stdout.replace(/^origin\//, '')
      : currentBranchResult.stdout || undefined;
    const remotes = execute(environment.gitExecutable, ['-C', gitRoot, 'remote'])
      .split(/\r?\n/).filter(Boolean);
    const status = execute(environment.gitExecutable, ['-C', gitRoot, 'status', '--porcelain=v2', '-z']);
    const repositoryId = 'repo:' + createHash('sha256')
      .update(canonicalGitDir.replaceAll('\\', '/').toLowerCase()).digest('hex');
    return {
      rootPath: canonicalRoot, gitRoot, canonicalGitDir, repositoryId,
      ...(currentBranchResult.stdout ? { currentBranch: currentBranchResult.stdout } : {}),
      ...(defaultBranch ? { defaultBranch } : {}), remoteCount: remotes.length, isDirty: status.length > 0,
    };
  }
}

export class ExecutionEnvironmentRegistry {
  readonly #database: LocalDatabase;
  readonly #git: GitProbe;
  readonly #now: () => number;

  constructor(database: LocalDatabase, options: { gitProbe?: GitProbe; now?: () => number } = {}) {
    this.#database = database;
    this.#git = options.gitProbe ?? new GitProbe();
    this.#now = options.now ?? Date.now;
  }

  registerWindowsNative(options: { gitExecutable?: string; homePath?: string } = {}): ExecutionEnvironment {
    const executable = this.#git.resolveWindowsGit(options.gitExecutable);
    const installation = this.#git.probeInstallation(executable);
    const homePath = options.homePath ?? process.env.USERPROFILE;
    if (!homePath) throw new ProjectRegistrationError('Windows home path is unavailable');
    assertPathForEnvironment({ id: 'windows-native', type: 'windows-native' }, homePath, 'Home path');
    const at = this.#now();
    const id = 'environment:windows-native:' + createHash('sha256')
      .update(realpathSync.native(homePath).toLowerCase()).digest('hex').slice(0, 16);
    const existing = this.#database.readExecutionEnvironment(id);
    const environment: ExecutionEnvironment = {
      id, type: 'windows-native', displayName: 'Windows Native', homePath: realpathSync.native(homePath),
      pathStyle: 'windows', defaultShell: 'powershell.exe', gitExecutable: installation.executable,
      capabilities: {
        pty: true, processGroups: false, jobObjects: true, symlinks: installation.capabilities.symlinks,
      },
      gitVersion: installation.version, gitCapabilities: installation.capabilities,
      lastProbedAt: at, createdAt: existing?.createdAt ?? at, updatedAt: at,
    };
    this.#database.saveExecutionEnvironment(environment);
    return environment;
  }

  get(id: string): ExecutionEnvironment {
    const environment = this.#database.readExecutionEnvironment(id);
    if (!environment) throw new ProjectRegistrationError('Execution Environment not found');
    return environment;
  }

  list(): ExecutionEnvironment[] { return this.#database.listExecutionEnvironments(); }
}

export class ProjectManager {
  readonly #database: LocalDatabase;
  readonly #environments: ExecutionEnvironmentRegistry;
  readonly #git: GitProbe;
  readonly #now: () => number;
  readonly #id: () => string;

  constructor(
    database: LocalDatabase,
    environments: ExecutionEnvironmentRegistry,
    options: { gitProbe?: GitProbe; now?: () => number; id?: () => string } = {},
  ) {
    this.#database = database;
    this.#environments = environments;
    this.#git = options.gitProbe ?? new GitProbe();
    this.#now = options.now ?? Date.now;
    this.#id = options.id ?? randomUUID;
  }

  add(input: { rootPath: string; executionEnvironmentId: string; name?: string }): Project {
    const environment = this.#environments.get(input.executionEnvironmentId);
    const probe = this.#git.probeRepository(input.rootPath, environment);
    const duplicate = this.#database.sqlite.prepare('SELECT id FROM projects WHERE repository_id=?')
      .get(probe.repositoryId) as { id: string } | undefined;
    if (duplicate) throw new ProjectRegistrationError('Git repository is already registered as ' + duplicate.id);
    const at = this.#now();
    const project: Project = {
      id: 'project:' + this.#id(), name: input.name ?? (win32.basename(probe.gitRoot) || basename(probe.gitRoot)),
      executionEnvironmentId: environment.id, rootPath: probe.rootPath, gitRoot: probe.gitRoot,
      repositoryId: probe.repositoryId, ...(probe.defaultBranch ? { defaultBranch: probe.defaultBranch } : {}),
      ...(probe.defaultBranch ? { defaultBaseRef: probe.defaultBranch } : {}),
      canonicalGitDir: probe.canonicalGitDir,
      ...(probe.currentBranch ? { currentBranch: probe.currentBranch } : {}),
      remoteCount: probe.remoteCount, isDirty: probe.isDirty, lastProbedAt: at,
      createdAt: at, updatedAt: at,
    };
    assertEnvironmentConsistency({
      project, environment, runtimeEnvironmentId: environment.id, gitEnvironmentId: environment.id,
    });
    this.#database.saveProject(project);
    return project;
  }

  reProbe(projectId: string): Project {
    const project = this.get(projectId);
    const environment = this.#environments.get(project.executionEnvironmentId);
    const probe = this.#git.probeRepository(project.rootPath, environment);
    if (probe.repositoryId !== project.repositoryId) {
      throw new ProjectRegistrationError('Repository identity changed; remove and add it explicitly');
    }
    const at = this.#now();
    const { currentBranch: _oldCurrentBranch, defaultBranch: _oldDefaultBranch, ...stableProject } = project;
    const updated: Project = {
      ...stableProject, rootPath: probe.rootPath, gitRoot: probe.gitRoot, canonicalGitDir: probe.canonicalGitDir,
      ...(probe.currentBranch ? { currentBranch: probe.currentBranch } : {}),
      ...(probe.defaultBranch ? { defaultBranch: probe.defaultBranch } : {}),
      remoteCount: probe.remoteCount, isDirty: probe.isDirty,
      lastProbedAt: at, updatedAt: at,
    };
    assertEnvironmentConsistency({
      project: updated, environment, runtimeEnvironmentId: environment.id, gitEnvironmentId: environment.id,
    });
    this.#database.saveProject(updated);
    return updated;
  }

  remove(projectId: string): void {
    this.get(projectId);
    const sessions = this.#database.sqlite.prepare('SELECT COUNT(*) AS count FROM sessions WHERE project_id=?')
      .get(projectId) as { count: number };
    const worktrees = this.#database.sqlite.prepare('SELECT COUNT(*) AS count FROM worktrees WHERE project_id=?')
      .get(projectId) as { count: number };
    if (sessions.count > 0 || worktrees.count > 0) {
      throw new ProjectRegistrationError('Project has Sessions or Worktrees and cannot be removed');
    }
    if (!this.#database.deleteProject(projectId)) throw new ProjectRegistrationError('Project removal failed');
  }

  get(projectId: string): Project {
    const project = this.#database.readProject(projectId);
    if (!project) throw new ProjectRegistrationError('Project not found');
    return project;
  }

  list(): Project[] { return this.#database.listProjects(); }

  assertBindings(projectId: string, input: {
    runtimeEnvironmentId: string;
    gitEnvironmentId: string;
    runtimeExecutable?: string;
    worktree?: WorktreeRecord;
  }): void {
    const project = this.get(projectId);
    const environment = this.#environments.get(project.executionEnvironmentId);
    assertEnvironmentConsistency({ project, environment, ...input });
  }
}