import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { LocalDatabase } from '@tsukiori/database';
import type {
  ActionAuditRecord, HostSession, JsonValue, Project, WorkspaceBindingRecord, WorktreeAction, WorktreeRecord,
} from '@tsukiori/domain';
import { ExecutionEnvironmentRegistry, ProjectManager } from '@tsukiori/project-manager';
import { InjectedDaemonCrash, WorktreeManager, WorktreeSafetyError } from '@tsukiori/worktree-manager';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 10 * 60_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

export class WorkspaceSetupError extends Error {
  constructor(message: string) { super(message); this.name = 'WorkspaceSetupError'; }
}

export type ActionResult = {
  auditId: string;
  actionIndex: number;
  success: boolean;
  exitCode?: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
};

export type ActionSequenceResult = {
  success: boolean;
  results: ActionResult[];
};

type ActionContext = {
  projectId: string;
  sessionId: string;
  worktreeId: string;
  worktreePath: string;
  phase: 'setup' | 'cleanup';
};

export class ActionExecutor {
  readonly #database: LocalDatabase;
  readonly #now: () => number;
  readonly #id: () => string;

  constructor(database: LocalDatabase, options: { now?: () => number; id?: () => string } = {}) {
    this.#database = database;
    this.#now = options.now ?? Date.now;
    this.#id = options.id ?? randomUUID;
  }

  run(actions: readonly WorktreeAction[], context: ActionContext): ActionSequenceResult {
    const results: ActionResult[] = [];
    for (let index = 0; index < actions.length; index += 1) {
      const action = actions[index];
      if (!action) continue;
      const result = this.#runOne(action, index, context);
      results.push(result);
      if (!result.success) return { success: false, results };
    }
    return { success: true, results };
  }

  #runOne(action: WorktreeAction, actionIndex: number, context: ActionContext): ActionResult {
    const invocation = this.#invocation(action);
    const startedAt = this.#now();
    const audit: ActionAuditRecord = {
      id: 'action-audit:' + this.#id(), projectId: context.projectId, sessionId: context.sessionId,
      worktreeId: context.worktreeId, phase: context.phase, actionIndex, actionType: action.type,
      ...(action.type === 'exec' ? { executable: action.executable } : {
        shellType: action.shell, scriptHash: this.#hash(action.script), approvalSource: action.approvalSource,
      }),
      status: 'prepared', diagnostic: {
        schemaVersion: 1, argumentsCount: invocation.args.length,
        outputPersistence: 'hash-and-byte-count-only', shellInvocation: action.type === 'shell',
      }, startedAt,
    };
    this.#database.saveActionAudit(audit);
    this.#database.saveActionAudit({ ...audit, status: 'running' });

    const timeout = Math.max(1, Math.min(action.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS));
    const result = spawnSync(invocation.executable, invocation.args, {
      cwd: context.worktreePath, encoding: 'utf8', windowsHide: true, shell: false, timeout,
      maxBuffer: MAX_OUTPUT_BYTES, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = this.#bounded(result.stdout ?? '');
    const stderr = this.#bounded(result.stderr ?? '');
    const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
    const timedOut = errorCode === 'ETIMEDOUT';
    const exitCode = result.status ?? undefined;
    const success = !result.error && exitCode === 0;
    const finishedAt = this.#now();
    const diagnostic: JsonValue = {
      schemaVersion: 1,
      argumentsCount: invocation.args.length,
      outputPersistence: 'hash-and-byte-count-only',
      shellInvocation: action.type === 'shell',
      stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr),
      stdoutHash: this.#hash(stdout), stderrHash: this.#hash(stderr),
      errorCode: errorCode ?? null, signal: result.signal ?? null,
    };
    this.#database.saveActionAudit({
      ...audit, status: success ? 'succeeded' : 'failed',
      ...(exitCode === undefined ? {} : { exitCode }), timedOut, diagnostic, finishedAt,
    });
    return {
      auditId: audit.id, actionIndex, success,
      ...(exitCode === undefined ? {} : { exitCode }), timedOut, stdout, stderr,
    };
  }

  #invocation(action: WorktreeAction): { executable: string; args: string[] } {
    if (action.type === 'exec') {
      if (!action.executable.trim()) throw new WorkspaceSetupError('Structured exec requires an executable');
      return { executable: action.executable, args: [...action.args] };
    }
    if (!action.approvalSource.trim()) throw new WorkspaceSetupError('Shell action requires an explicit approval source');
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
    if (action.shell === 'powershell') {
      return {
        executable: join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', action.script],
      };
    }
    if (action.shell === 'cmd') {
      return { executable: join(systemRoot, 'System32', 'cmd.exe'), args: ['/d', '/s', '/c', action.script] };
    }
    throw new WorkspaceSetupError('Shell type is not supported in Windows Native V1');
  }

  #bounded(value: string): string {
    const bytes = Buffer.from(value);
    return bytes.length <= MAX_OUTPUT_BYTES ? value : bytes.subarray(0, MAX_OUTPUT_BYTES).toString('utf8');
  }

  #hash(value: string): string { return 'sha256:' + createHash('sha256').update(value).digest('hex'); }
}

export type WorkspaceCreationResult = {
  binding: WorkspaceBindingRecord;
  setup: ActionSequenceResult;
};

export type WorkspaceArchiveResult = {
  binding: WorkspaceBindingRecord;
  cleanup?: ActionSequenceResult;
};

export class WorkspaceCoordinator {
  readonly #database: LocalDatabase;
  readonly #projects: ProjectManager;
  readonly #environments: ExecutionEnvironmentRegistry;
  readonly #worktrees: WorktreeManager;
  readonly #actions: ActionExecutor;
  readonly #now: () => number;
  readonly #id: () => string;

  constructor(
    database: LocalDatabase,
    projects: ProjectManager,
    environments: ExecutionEnvironmentRegistry,
    worktrees: WorktreeManager,
    options: { actionExecutor?: ActionExecutor; now?: () => number; id?: () => string } = {},
  ) {
    this.#database = database;
    this.#projects = projects;
    this.#environments = environments;
    this.#worktrees = worktrees;
    this.#now = options.now ?? Date.now;
    this.#id = options.id ?? randomUUID;
    this.#actions = options.actionExecutor ?? new ActionExecutor(database, { now: this.#now, id: this.#id });
  }

  createWritableSessionWorkspace(input: {
    sessionId: string;
    projectId: string;
    runtimeType: string;
    baseRef?: string;
    slug?: string;
  }): WorkspaceCreationResult {
    const session = this.#requireSession(input.sessionId);
    if (session.projectId !== input.projectId) throw new WorkspaceSetupError('Session belongs to another Project');
    if (session.lifecycle !== 'active') throw new WorkspaceSetupError('Only an active Session can bind a workspace');
    if (session.writeMode !== 'isolated-worktree') {
      throw new WorkspaceSetupError('Writable Session must use an independent Worktree');
    }
    if (this.#database.readWorkspaceBinding(session.id)) throw new WorkspaceSetupError('Session already has a Workspace Binding');
    const project = this.#projects.get(input.projectId);
    const environment = this.#environments.get(project.executionEnvironmentId);
    const worktree = this.#worktrees.create(input);
    const at = this.#now();
    let binding: WorkspaceBindingRecord = {
      id: 'workspace-binding:' + this.#id(), sessionId: session.id, projectId: project.id,
      worktreeId: worktree.id, executionEnvironmentId: environment.id,
      bindingType: 'isolated-worktree', status: 'preparing', path: worktree.path,
      baseCommit: worktree.baseCommit, cleanupState: 'not_requested', createdAt: at, updatedAt: at,
    };
    this.#database.sqlite.transaction(() => {
      this.#database.saveWorkspaceBinding(binding);
      this.#database.saveSession({
        ...session, primaryWorkspaceBindingId: binding.id, activity: 'preparing', updatedAt: at,
      });
    })();
    const setup = this.#actions.run(project.setupActions ?? [], this.#context(project, session, worktree, 'setup'));
    const finishedAt = this.#now();
    if (setup.success) {
      binding = { ...binding, status: 'active', updatedAt: finishedAt };
      this.#database.sqlite.transaction(() => {
        this.#database.saveWorkspaceBinding(binding);
        this.#database.saveSession({
          ...session, primaryWorkspaceBindingId: binding.id, activity: 'idle', health: 'healthy', updatedAt: finishedAt,
        });
      })();
      return { binding, setup };
    }
    if (this.#isDirty(project, worktree)) this.#database.saveWorktree({ ...worktree, status: 'dirty' });
    binding = { ...binding, status: 'setup_failed', cleanupState: 'retained', updatedAt: finishedAt };
    this.#database.sqlite.transaction(() => {
      this.#database.saveWorkspaceBinding(binding);
      this.#database.saveSession({
        ...session, primaryWorkspaceBindingId: binding.id, activity: 'stopped', health: 'error', updatedAt: finishedAt,
      });
    })();
    return { binding, setup };
  }

  archive(sessionId: string, options: { cleanup?: 'retain' | 'run' } = {}): WorkspaceArchiveResult {
    const session = this.#requireSession(sessionId);
    const existing = this.#database.readWorkspaceBinding(sessionId);
    if (!existing) throw new WorkspaceSetupError('Session has no Workspace Binding');
    const project = this.#projects.get(existing.projectId);
    const worktree = this.#database.readWorktree(existing.worktreeId);
    if (!worktree) throw new WorkspaceSetupError('Workspace Binding Worktree record is missing');
    const startedAt = this.#now();
    this.#database.saveSession({ ...session, lifecycle: 'archiving', activity: 'stopped', updatedAt: startedAt });
    const lastKnownCommit = this.#head(project, worktree) ?? existing.lastKnownCommit ?? existing.baseCommit;
    let binding: WorkspaceBindingRecord = {
      ...existing, status: 'archived', lastKnownCommit,
      cleanupState: options.cleanup === 'run' ? 'not_requested' : 'retained',
      updatedAt: startedAt, archivedAt: startedAt,
    };
    let cleanup: ActionSequenceResult | undefined;
    if (options.cleanup === 'run') {
      cleanup = this.#actions.run(project.cleanupActions ?? [], this.#context(project, session, worktree, 'cleanup'));
      if (!cleanup.success) {
        binding = { ...binding, cleanupState: 'failed', updatedAt: this.#now() };
      } else {
        try {
          this.#worktrees.remove(worktree.id);
          binding = { ...binding, cleanupState: 'succeeded', updatedAt: this.#now() };
        } catch (error) {
          if (error instanceof InjectedDaemonCrash) throw error;
          binding = {
            ...binding,
            cleanupState: error instanceof WorktreeSafetyError ? 'blocked' : 'failed',
            updatedAt: this.#now(),
          };
        }
      }
    }
    const archivedAt = this.#now();
    binding = { ...binding, updatedAt: archivedAt, archivedAt };
    this.#database.sqlite.transaction(() => {
      this.#database.saveWorkspaceBinding(binding);
      this.#database.saveSession({
        ...session, lifecycle: 'archived', activity: 'stopped', updatedAt: archivedAt, archivedAt,
      });
    })();
    return { binding, ...(cleanup ? { cleanup } : {}) };
  }

  #context(
    project: Project, session: HostSession, worktree: WorktreeRecord, phase: 'setup' | 'cleanup',
  ): ActionContext {
    return {
      projectId: project.id, sessionId: session.id, worktreeId: worktree.id,
      worktreePath: worktree.path, phase,
    };
  }

  #requireSession(id: string): HostSession {
    const session = this.#database.readSession(id);
    if (!session) throw new WorkspaceSetupError('Session not found');
    return session;
  }

  #head(project: Project, worktree: WorktreeRecord): string | undefined {
    if (!existsSync(worktree.path)) return undefined;
    const environment = this.#environments.get(project.executionEnvironmentId);
    const result = spawnSync(environment.gitExecutable, ['-C', worktree.path, 'rev-parse', '--verify', 'HEAD^{commit}'], {
      encoding: 'utf8', windowsHide: true, shell: false, timeout: 20_000,
      maxBuffer: MAX_OUTPUT_BYTES, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const head = result.status === 0 ? (result.stdout ?? '').trim() : '';
    return /^[a-f0-9]{40,64}$/i.test(head) ? head : undefined;
  }

  #isDirty(project: Project, worktree: WorktreeRecord): boolean {
    const environment = this.#environments.get(project.executionEnvironmentId);
    const result = spawnSync(environment.gitExecutable, [
      '-C', worktree.path, 'status', '--porcelain=v2', '-z', '--untracked-files=all',
    ], {
      encoding: 'utf8', windowsHide: true, shell: false, timeout: 20_000,
      maxBuffer: MAX_OUTPUT_BYTES, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return result.status !== 0 || (result.stdout ?? '').length > 0;
  }
}
