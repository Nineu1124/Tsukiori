import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve, win32 } from 'node:path';
import type { LocalDatabase } from '@tsukiori/database';
import type { JsonValue, OperationRecord, Project, WorkspaceBindingRecord, WorktreeRecord } from '@tsukiori/domain';
import { ExecutionEnvironmentRegistry, ProjectManager, assertPathForEnvironment } from '@tsukiori/project-manager';

const OUTPUT_LIMIT = 2 * 1024 * 1024;

export class GitIntegrationError extends Error {
  constructor(message: string) { super(message); this.name = 'GitIntegrationError'; }
}

export type IntegrationStrategy = 'merge' | 'rebase';
export type VerificationCommand = { executable: string; args: readonly string[] };
export type IntegrationInvocation = {
  executable: string;
  args: readonly string[];
  cwd: string;
  shell: false;
};
export type VerificationResult = { executable: string; exitCode: number; success: boolean };
export type IntegrationAttentionSink = {
  addAttention(input: {
    projectId: string;
    sessionId: string;
    kind: 'conflict';
    title: string;
    sourceRef: string;
    risk: 'high';
    payload: JsonValue;
  }): unknown;
  resolveAttention(kind: 'conflict', sourceRef: string): boolean;
};
export type IntegrationResult = {
  operationId: string;
  status: 'verified' | 'conflicted' | 'verification_failed';
  strategy: IntegrationStrategy;
  sourceSessionId: string;
  targetRef: string;
  sourceCommit: string;
  targetCommit: string;
  integrationBranch: string;
  integrationPath: string;
  resultCommit?: string;
  conflictPaths: string[];
  verification: VerificationResult[];
  retained: boolean;
  promotionRequired: true;
  externalEditorTarget?: { kind: 'directory'; path: string };
};

type CommandResult = { status: number; stdout: string; stderr: string };
type SourceContext = {
  project: Project;
  binding: WorkspaceBindingRecord;
  worktree: WorktreeRecord;
  git: string;
};

export class IntegrationMergeService {
  readonly integrationRoot: string;
  readonly #database: LocalDatabase;
  readonly #projects: ProjectManager;
  readonly #environments: ExecutionEnvironmentRegistry;
  readonly #permissions: IntegrationAttentionSink;
  readonly #now: () => number;
  readonly #id: () => string;
  readonly #observe: ((invocation: IntegrationInvocation) => void) | undefined;

  constructor(input: {
    database: LocalDatabase;
    projects: ProjectManager;
    environments: ExecutionEnvironmentRegistry;
    permissions: IntegrationAttentionSink;
    integrationRoot: string;
    now?: () => number;
    id?: () => string;
    observeInvocation?: (invocation: IntegrationInvocation) => void;
  }) {
    this.#database = input.database;
    this.#projects = input.projects;
    this.#environments = input.environments;
    this.#permissions = input.permissions;
    this.#now = input.now ?? Date.now;
    this.#id = input.id ?? randomUUID;
    this.#observe = input.observeInvocation;
    mkdirSync(input.integrationRoot, { recursive: true });
    this.integrationRoot = realpathSync.native(input.integrationRoot);
  }

  integrate(input: {
    sourceSessionId: string;
    targetRef: string;
    strategy?: IntegrationStrategy;
    verificationCommands?: readonly VerificationCommand[];
  }): IntegrationResult {
    const strategy = input.strategy ?? 'merge';
    const source = this.#source(input.sourceSessionId);
    this.#validateRoot(source.project);
    this.#assertNoSubmodules(source);
    this.#assertCleanSource(source);
    const targetRef = this.#targetRef(input.targetRef);
    const sourceCommit = this.#head(source.git, source.worktree.path);
    const targetCommit = this.#resolveCommit(source.git, source.project.gitRoot, targetRef);
    const token = this.#token();
    const integrationBranch = 'integration/' + token;
    const integrationPath = join(this.integrationRoot, token);
    this.#assertWithinRoot(integrationPath);
    const commands = this.#verificationCommands(input.verificationCommands ?? []);
    const operation = this.#begin(strategy, input.sourceSessionId, {
      schemaVersion: 1,
      projectId: source.project.id,
      sourceWorktreeId: source.worktree.id,
      sourceCommit,
      targetRef,
      targetCommit,
      strategy,
      integrationBranch,
      integrationPath,
      verificationCommandCount: commands.length,
      hooksDisabled: true,
      signingDisabled: true,
      targetPromotion: 'explicit_required',
    });
    let created = false;
    try {
      const startCommit = strategy === 'merge' ? targetCommit : sourceCommit;
      this.#success(source.git, source.project.gitRoot, [
        'worktree', 'add', '-b', integrationBranch, integrationPath, startCommit,
      ]);
      created = true;
      const action = strategy === 'merge'
        ? ['-c', 'core.hooksPath=NUL', '-c', 'commit.gpgSign=false', 'merge', '--no-ff', '--no-edit', '--no-gpg-sign', sourceCommit]
        : ['-c', 'core.hooksPath=NUL', '-c', 'commit.gpgSign=false', 'rebase', targetCommit];
      const actionResult = this.#run(source.git, integrationPath, action);
      if (actionResult.status !== 0) return this.#conflicted(operation, source, input.sourceSessionId, targetRef,
        strategy, sourceCommit, targetCommit, integrationBranch, integrationPath);
      return this.#verifyAndFinish(operation, source, input.sourceSessionId, targetRef,
        strategy, sourceCommit, targetCommit, integrationBranch, integrationPath, commands);
    } catch (error) {
      this.#database.saveOperation({
        ...operation,
        status: created ? 'uncertain' : 'failed',
        error: { code: created ? 'integration_worktree_retained' : 'integration_setup_failed' },
        updatedAt: this.#now(),
      });
      throw error;
    }
  }

  continue(input: { operationId: string; verificationCommands?: readonly VerificationCommand[] }): IntegrationResult {
    const operation = this.#database.readOperation(input.operationId);
    if (!operation || (operation.type !== 'merge' && operation.type !== 'rebase') || operation.status !== 'uncertain') {
      throw new GitIntegrationError('Conflicted Integration Operation not found');
    }
    const request = operation.requestPayload as Record<string, JsonValue>;
    const sessionId = String(operation.sessionId ?? '');
    const source = this.#source(sessionId);
    const integrationPath = this.#existingIntegrationPath(String(request.integrationPath ?? ''));
    const strategy = String(request.strategy) as IntegrationStrategy;
    const command = strategy === 'merge'
      ? ['-c', 'core.hooksPath=NUL', '-c', 'commit.gpgSign=false', '-c', 'core.editor=true', 'merge', '--continue']
      : ['-c', 'core.hooksPath=NUL', '-c', 'commit.gpgSign=false', '-c', 'sequence.editor=true', '-c', 'core.editor=true', 'rebase', '--continue'];
    this.#success(source.git, integrationPath, command);
    return this.#verifyAndFinish(
      operation,
      source,
      sessionId,
      String(request.targetRef),
      strategy,
      String(request.sourceCommit),
      String(request.targetCommit),
      String(request.integrationBranch),
      integrationPath,
      this.#verificationCommands(input.verificationCommands ?? []),
    );
  }

  externalEditorInvocation(
    integrationPath: string,
    editorExecutable: string,
    prefixArgs: readonly string[] = [],
  ): IntegrationInvocation {
    const canonicalPath = this.#existingIntegrationPath(integrationPath);
    if (!isAbsolute(editorExecutable) && !win32.isAbsolute(editorExecutable)) {
      throw new GitIntegrationError('External editor executable must be absolute');
    }
    if (prefixArgs.length > 32 || prefixArgs.some((value) => value.includes('\0'))) {
      throw new GitIntegrationError('External editor arguments are invalid');
    }
    return { executable: editorExecutable, args: [...prefixArgs, canonicalPath], cwd: canonicalPath, shell: false };
  }

  #verifyAndFinish(
    operation: OperationRecord,
    source: SourceContext,
    sessionId: string,
    targetRef: string,
    strategy: IntegrationStrategy,
    sourceCommit: string,
    targetCommit: string,
    integrationBranch: string,
    integrationPath: string,
    commands: readonly VerificationCommand[],
  ): IntegrationResult {
    const verification: VerificationResult[] = [];
    for (const command of commands) {
      const result = this.#run(command.executable, integrationPath, command.args);
      verification.push({ executable: command.executable, exitCode: result.status, success: result.status === 0 });
      if (result.status !== 0) {
        this.#database.saveOperation({
          ...operation,
          status: 'failed',
          resultPayload: { integrationPath, verification, retained: true },
          error: { code: 'integration_verification_failed' },
          updatedAt: this.#now(),
        });
        return {
          operationId: operation.operationId,
          status: 'verification_failed', strategy, sourceSessionId: sessionId, targetRef,
          sourceCommit, targetCommit, integrationBranch, integrationPath,
          conflictPaths: [], verification, retained: true, promotionRequired: true,
        };
      }
    }
    const resultCommit = this.#head(source.git, integrationPath);
    this.#success(source.git, source.project.gitRoot, ['worktree', 'remove', integrationPath]);
    this.#permissions.resolveAttention('conflict', 'integration:' + operation.operationId);
    this.#database.saveOperation({
      ...operation,
      status: 'committed',
      resultPayload: {
        resultCommit, integrationBranch, verification, retained: false,
        mainWorkspaceModified: false, targetPromotion: 'explicit_required',
      },
      updatedAt: this.#now(),
    });
    return {
      operationId: operation.operationId,
      status: 'verified', strategy, sourceSessionId: sessionId, targetRef,
      sourceCommit, targetCommit, integrationBranch, integrationPath, resultCommit,
      conflictPaths: [], verification, retained: false, promotionRequired: true,
    };
  }

  #conflicted(
    operation: OperationRecord,
    source: SourceContext,
    sessionId: string,
    targetRef: string,
    strategy: IntegrationStrategy,
    sourceCommit: string,
    targetCommit: string,
    integrationBranch: string,
    integrationPath: string,
  ): IntegrationResult {
    const conflictOutput = this.#success(source.git, integrationPath, [
      'diff', '--name-only', '--diff-filter=U', '-z', '--no-color', '--no-ext-diff',
    ]).stdout;
    const conflictPaths = conflictOutput.split('\0').filter(Boolean).sort();
    if (conflictPaths.length === 0) {
      throw new GitIntegrationError('Integration failed without observable conflicts');
    }
    this.#database.saveOperation({
      ...operation,
      status: 'uncertain',
      resultPayload: { integrationPath, conflictPaths, retained: true },
      error: { code: strategy + '_conflict' },
      updatedAt: this.#now(),
    });
    this.#permissions.addAttention({
      projectId: source.project.id,
      sessionId,
      kind: 'conflict',
      title: 'Integration Worktree 存在 Git 冲突',
      sourceRef: 'integration:' + operation.operationId,
      risk: 'high',
      payload: {
        operationId: operation.operationId,
        integrationPath,
        conflictPaths,
        externalEditorTarget: { kind: 'directory', path: integrationPath },
      },
    });
    return {
      operationId: operation.operationId,
      status: 'conflicted', strategy, sourceSessionId: sessionId, targetRef,
      sourceCommit, targetCommit, integrationBranch, integrationPath,
      conflictPaths, verification: [], retained: true, promotionRequired: true,
      externalEditorTarget: { kind: 'directory', path: integrationPath },
    };
  }

  #source(sessionId: string): SourceContext {
    const session = this.#database.readSession(sessionId);
    if (!session) throw new GitIntegrationError('Source Session not found');
    const binding = this.#database.readWorkspaceBinding(sessionId);
    if (!binding || binding.bindingType !== 'isolated-worktree') throw new GitIntegrationError('Source Session has no isolated Worktree');
    const worktree = this.#database.readWorktree(binding.worktreeId);
    if (!worktree || worktree.ownerSessionId !== sessionId || worktree.projectId !== session.projectId) {
      throw new GitIntegrationError('Source Worktree ownership mismatch');
    }
    const project = this.#projects.get(session.projectId);
    const environment = this.#environments.get(project.executionEnvironmentId);
    this.#projects.assertBindings(project.id, {
      runtimeEnvironmentId: environment.id, gitEnvironmentId: environment.id, worktree,
    });
    return { project, binding, worktree, git: environment.gitExecutable };
  }

  #assertCleanSource(source: SourceContext): void {
    const status = this.#success(source.git, source.worktree.path, [
      'status', '--porcelain=v2', '-z', '--untracked-files=all',
    ]).stdout;
    if (status) throw new GitIntegrationError('Source Session must be committed before integration');
    for (const state of ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD']) {
      if (this.#run(source.git, source.worktree.path, ['rev-parse', '--verify', '--quiet', state]).status === 0) {
        throw new GitIntegrationError('Source Session has an in-progress Git operation');
      }
    }
  }

  #assertNoSubmodules(source: SourceContext): void {
    const index = this.#success(source.git, source.worktree.path, ['ls-files', '--stage']).stdout;
    if (/^160000 /m.test(index)) throw new GitIntegrationError('Submodule integration requires explicit future support');
  }

  #verificationCommands(values: readonly VerificationCommand[]): VerificationCommand[] {
    if (values.length > 10) throw new GitIntegrationError('Too many verification commands');
    return values.map((value) => {
      if (!value.executable.trim() || value.executable.includes('\0') || value.args.length > 64
        || value.args.some((argument) => argument.includes('\0'))) {
        throw new GitIntegrationError('Verification command is invalid');
      }
      return { executable: value.executable, args: [...value.args] };
    });
  }

  #targetRef(value: string): string {
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 240 || trimmed.startsWith('-') || /[\0\r\n]/.test(trimmed)) {
      throw new GitIntegrationError('Target ref is invalid');
    }
    return trimmed;
  }

  #validateRoot(project: Project): void {
    const environment = this.#environments.get(project.executionEnvironmentId);
    assertPathForEnvironment(environment, this.integrationRoot, 'Integration Worktree Root');
  }

  #begin(strategy: IntegrationStrategy, sessionId: string, requestPayload: JsonValue): OperationRecord {
    const at = this.#now();
    const operation: OperationRecord = {
      id: 'record:' + this.#id(), operationId: 'operation:' + this.#id(),
      type: strategy, sessionId, status: 'prepared', requestPayload, createdAt: at, updatedAt: at,
    };
    this.#database.saveOperation(operation);
    const running = { ...operation, status: 'running' as const, updatedAt: this.#now() };
    this.#database.saveOperation(running);
    return running;
  }

  #resolveCommit(git: string, cwd: string, ref: string): string {
    return this.#commit(this.#success(git, cwd, ['rev-parse', '--verify', ref + '^{commit}']).stdout.trim());
  }

  #head(git: string, cwd: string): string {
    return this.#resolveCommit(git, cwd, 'HEAD');
  }

  #commit(value: string): string {
    if (!/^[a-f0-9]{40,64}$/i.test(value)) throw new GitIntegrationError('Git commit is invalid');
    return value;
  }

  #success(executable: string, cwd: string, args: readonly string[]): CommandResult {
    const result = this.#run(executable, cwd, args);
    if (result.status !== 0) throw new GitIntegrationError('Structured integration command failed');
    return result;
  }

  #run(executable: string, cwd: string, args: readonly string[]): CommandResult {
    const invocation: IntegrationInvocation = { executable, args: [...args], cwd, shell: false };
    this.#observe?.(invocation);
    const result = spawnSync(executable, [...args], {
      cwd, encoding: 'utf8', windowsHide: true, shell: false, timeout: 60_000,
      maxBuffer: OUTPUT_LIMIT, stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true',
      },
    });
    if (result.error) throw new GitIntegrationError('Integration process failed to start');
    return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }

  #assertWithinRoot(value: string): void {
    const root = win32.normalize(this.integrationRoot).toLowerCase();
    const target = win32.normalize(resolve(value)).toLowerCase();
    if (!target.startsWith(root + '\\')) throw new GitIntegrationError('Integration path escapes configured Root');
  }

  #existingIntegrationPath(value: string): string {
    this.#assertWithinRoot(value);
    if (!existsSync(value)) throw new GitIntegrationError('Integration Worktree is missing');
    const requested = win32.normalize(resolve(value)).toLowerCase();
    const canonical = realpathSync.native(value);
    this.#assertWithinRoot(canonical);
    if (win32.normalize(canonical).toLowerCase() !== requested) {
      throw new GitIntegrationError('Integration Worktree canonical path changed');
    }
    return canonical;
  }

  #token(): string {
    return this.#id().replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 48) || randomUUID();
  }
}