import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { win32 } from 'node:path';
import type { LocalDatabase } from '@tsukiori/database';
import type { JsonValue, OperationRecord, ProcessRecord, WorktreeRecord } from '@tsukiori/domain';
import {
  EnvironmentBoundaryError,
  ExecutionEnvironmentRegistry,
  ProjectManager,
  assertPathForEnvironment,
} from '@tsukiori/project-manager';

export class WorktreeSafetyError extends Error {
  constructor(message: string) { super(message); this.name = 'WorktreeSafetyError'; }
}
export class WorktreeGitError extends Error {
  constructor(message: string) { super(message); this.name = 'WorktreeGitError'; }
}
export class InjectedDaemonCrash extends Error {
  constructor(readonly point: WorktreeCrashPoint) { super('Injected daemon crash at ' + point); this.name = 'InjectedDaemonCrash'; }
}

export type WorktreeCrashPoint =
  | 'create_after_prepare' | 'create_after_running' | 'create_after_git_add'
  | 'remove_after_prepare' | 'remove_after_running' | 'remove_after_git_remove';

type WorktreeOperationPayload = {
  schemaVersion: 1;
  action: 'create' | 'remove';
  worktreeId: string;
  projectId: string;
  sessionId: string;
  executionEnvironmentId: string;
  worktreeRoot: string;
  targetPath: string;
  branchName: string;
  baseRef: string;
  baseCommit: string;
};

type WorktreeFact = { path: string; branch?: string; head?: string };

export type ObservedProcessIdentity = {
  pid: number;
  daemonBootId: string;
  processStartTime: number;
  spawnNonce: string;
  executable?: string;
  processFingerprint?: string;
};

export class ProcessIdentityGuard {
  static matches(record: ProcessRecord, observed: ObservedProcessIdentity): boolean {
    if (record.pid !== observed.pid || record.daemonBootId !== observed.daemonBootId
      || record.processStartTime !== observed.processStartTime || record.spawnNonce !== observed.spawnNonce) return false;
    if (record.executable && (!observed.executable
      || win32.normalize(record.executable).toLowerCase() !== win32.normalize(observed.executable).toLowerCase())) return false;
    if (record.processFingerprint && record.processFingerprint !== observed.processFingerprint) return false;
    return true;
  }
}

class GitWorktreeRunner {
  run(executable: string, args: readonly string[]): string {
    try {
      return execFileSync(executable, [...args], {
        encoding: 'utf8', windowsHide: true, shell: false, timeout: 20_000,
        maxBuffer: 2 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    } catch {
      throw new WorktreeGitError('Structured Git command failed');
    }
  }

  succeeds(executable: string, args: readonly string[]): boolean {
    try { this.run(executable, args); return true; } catch { return false; }
  }

  list(executable: string, projectRoot: string): WorktreeFact[] {
    const output = this.run(executable, ['-C', projectRoot, 'worktree', 'list', '--porcelain']);
    if (!output) return [];
    return output.split(/\r?\n\r?\n/).map((block) => {
      const fields = new Map(block.split(/\r?\n/).map((line) => {
        const index = line.indexOf(' ');
        return index < 0 ? [line, ''] : [line.slice(0, index), line.slice(index + 1)];
      }));
      const path = fields.get('worktree');
      if (!path) throw new WorktreeGitError('Git worktree output omitted its path');
      const branchRef = fields.get('branch');
      const head = fields.get('HEAD');
      return {
        path,
        ...(branchRef ? { branch: branchRef.replace(/^refs\/heads\//, '') } : {}),
        ...(head ? { head } : {}),
      };
    });
  }
}

export type RecoveryResult = {
  operationId: string;
  action: 'create' | 'remove';
  status: 'committed' | 'failed' | 'uncertain';
  reason: string;
};

export class WorktreeManager {
  readonly worktreeRoot: string;
  readonly #database: LocalDatabase;
  readonly #projects: ProjectManager;
  readonly #environments: ExecutionEnvironmentRegistry;
  readonly #environmentId: string;
  readonly #git = new GitWorktreeRunner();
  readonly #now: () => number;
  readonly #id: () => string;
  readonly #crashAt: ((point: WorktreeCrashPoint, payload: WorktreeOperationPayload) => void) | undefined;

  constructor(
    database: LocalDatabase,
    projects: ProjectManager,
    environments: ExecutionEnvironmentRegistry,
    options: {
      worktreeRoot: string;
      executionEnvironmentId: string;
      now?: () => number;
      id?: () => string;
      crashAt?: (point: WorktreeCrashPoint, payload: WorktreeOperationPayload) => void;
    },
  ) {
    this.#database = database;
    this.#projects = projects;
    this.#environments = environments;
    this.#environmentId = options.executionEnvironmentId;
    this.#now = options.now ?? Date.now;
    this.#id = options.id ?? randomUUID;
    this.#crashAt = options.crashAt;
    const environment = environments.get(options.executionEnvironmentId);
    if (environment.type !== 'windows-native') throw new EnvironmentBoundaryError('T2.2 supports only windows-native');
    assertPathForEnvironment(environment, options.worktreeRoot, 'Worktree Root');
    mkdirSync(options.worktreeRoot, { recursive: true });
    this.worktreeRoot = realpathSync.native(options.worktreeRoot);
    assertPathForEnvironment(environment, this.worktreeRoot, 'Canonical Worktree Root');
  }

  create(input: {
    projectId: string;
    sessionId: string;
    runtimeType: string;
    baseRef?: string;
    slug?: string;
    directoryName?: string;
  }): WorktreeRecord {
    const project = this.#projects.get(input.projectId);
    const environment = this.#environments.get(project.executionEnvironmentId);
    if (environment.id !== this.#environmentId) throw new EnvironmentBoundaryError('Project and Worktree Root environments differ');
    this.#projects.assertBindings(project.id, {
      runtimeEnvironmentId: environment.id, gitEnvironmentId: environment.id,
    });
    const session = this.#database.sqlite.prepare('SELECT id FROM sessions WHERE id=? AND project_id=?')
      .get(input.sessionId, project.id) as { id: string } | undefined;
    if (!session) throw new WorktreeSafetyError('Worktree owner Session is missing or belongs to another Project');
    const baseRef = input.baseRef ?? project.defaultBaseRef ?? project.defaultBranch ?? 'HEAD';
    const baseCommit = this.#git.run(environment.gitExecutable, [
      '-C', project.gitRoot, 'rev-parse', '--verify', baseRef + '^{commit}',
    ]);
    if (!/^[a-f0-9]{40,64}$/i.test(baseCommit)) throw new WorktreeGitError('Base ref did not resolve to a commit');
    const sessionPart = this.#segment(input.sessionId).slice(-12);
    const runtimePart = this.#segment(input.runtimeType).slice(0, 20) || 'runtime';
    const slugPart = this.#segment(input.slug ?? 'task').slice(0, 32) || 'task';
    const branchName = `agent/${runtimePart}/${sessionPart}-${slugPart}`;
    const directoryName = input.directoryName ?? sessionPart + '-' + slugPart;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(directoryName) || directoryName === '.' || directoryName === '..') {
      throw new WorktreeSafetyError('Worktree directory name is unsafe');
    }
    const projectDirectory = win32.join(this.worktreeRoot, project.repositoryId.slice(5, 17));
    const targetPath = win32.join(projectDirectory, directoryName);
    this.#assertWithinRoot(targetPath);
    if (existsSync(targetPath)) throw new WorktreeSafetyError('Worktree target already exists');
    if (this.#git.succeeds(environment.gitExecutable, ['-C', project.gitRoot, 'show-ref', '--verify', '--quiet', 'refs/heads/' + branchName])) {
      throw new WorktreeSafetyError('Worktree branch already exists');
    }
    const at = this.#now();
    const payload: WorktreeOperationPayload = {
      schemaVersion: 1, action: 'create', worktreeId: 'worktree:' + this.#id(),
      projectId: project.id, sessionId: input.sessionId, executionEnvironmentId: environment.id,
      worktreeRoot: this.worktreeRoot, targetPath, branchName, baseRef, baseCommit,
    };
    const operation: OperationRecord = {
      id: 'record:' + this.#id(), operationId: 'operation:' + this.#id(), type: 'worktree_create',
      sessionId: input.sessionId, status: 'prepared', requestPayload: payload as unknown as JsonValue,
      createdAt: at, updatedAt: at,
    };
    this.#database.saveOperation(operation);
    this.#inject('create_after_prepare', payload);
    let externalAttempted = false;
    try {
      this.#update(operation, 'running');
      this.#inject('create_after_running', payload);
      mkdirSync(projectDirectory, { recursive: true });
      this.#assertWithinRoot(realpathSync.native(projectDirectory));
      externalAttempted = true;
      this.#git.run(environment.gitExecutable, [
        '-C', project.gitRoot, 'worktree', 'add', '-b', branchName, targetPath, baseCommit,
      ]);
      this.#inject('create_after_git_add', payload);
      const canonicalTarget = realpathSync.native(targetPath);
      this.#assertWithinRoot(canonicalTarget);
      const facts = this.#git.list(environment.gitExecutable, project.gitRoot);
      if (!this.#findFact(facts, canonicalTarget, branchName)) throw new WorktreeGitError('Created Worktree facts do not match');
      const worktree: WorktreeRecord = {
        id: payload.worktreeId, projectId: project.id, ownerSessionId: input.sessionId,
        executionEnvironmentId: environment.id, path: canonicalTarget, branchName,
        baseRef, baseCommit, status: 'active', createdAt: at,
      };
      this.#database.sqlite.transaction(() => {
        this.#database.saveWorktree(worktree);
        this.#update(operation, 'committed', { worktreeId: worktree.id, path: '<worktree-path>' });
      })();
      return worktree;
    } catch (error) {
      if (error instanceof InjectedDaemonCrash) throw error;
      this.#update(operation, externalAttempted ? 'uncertain' : 'failed', undefined,
        { code: externalAttempted ? 'worktree_create_uncertain' : 'worktree_create_failed' });
      throw error;
    }
  }

  remove(worktreeId: string): void {
    const worktree = this.#database.readWorktree(worktreeId);
    if (!worktree) throw new WorktreeSafetyError('Worktree record not found');
    const project = this.#projects.get(worktree.projectId);
    const environment = this.#environments.get(worktree.executionEnvironmentId);
    if (environment.id !== this.#environmentId || project.executionEnvironmentId !== environment.id) {
      throw new EnvironmentBoundaryError('Worktree, Project, and configured Root environments differ');
    }
    this.#assertWithinRoot(worktree.path);
    if (!existsSync(worktree.path) || !statSync(worktree.path).isDirectory()) {
      throw new WorktreeSafetyError('Worktree path is missing; recovery is required');
    }
    const canonicalPath = realpathSync.native(worktree.path);
    this.#assertWithinRoot(canonicalPath);
    if (this.#normalize(canonicalPath) !== this.#normalize(worktree.path)) {
      throw new WorktreeSafetyError('Worktree canonical path no longer matches its record');
    }
    const at = this.#now();
    const payload: WorktreeOperationPayload = {
      schemaVersion: 1, action: 'remove', worktreeId: worktree.id, projectId: project.id,
      sessionId: worktree.ownerSessionId ?? '', executionEnvironmentId: environment.id,
      worktreeRoot: this.worktreeRoot, targetPath: canonicalPath, branchName: worktree.branchName,
      baseRef: worktree.baseRef, baseCommit: worktree.baseCommit,
    };
    const operation: OperationRecord = {
      id: 'record:' + this.#id(), operationId: 'operation:' + this.#id(), type: 'worktree_remove',
      ...(worktree.ownerSessionId ? { sessionId: worktree.ownerSessionId } : {}), status: 'prepared',
      requestPayload: payload as unknown as JsonValue, createdAt: at, updatedAt: at,
    };
    this.#database.saveOperation(operation);
    this.#inject('remove_after_prepare', payload);
    let externalAttempted = false;
    try {
      this.#update(operation, 'running');
      this.#inject('remove_after_running', payload);
      const active = this.#database.sqlite.prepare(`
        SELECT COUNT(*) AS count FROM process_records
        WHERE session_id=? AND status IN ('starting','running','stopping')
      `).get(worktree.ownerSessionId ?? '') as { count: number };
      if (active.count > 0) throw new WorktreeSafetyError('Active ProcessRecord blocks Worktree removal');
      const status = this.#git.run(environment.gitExecutable, [
        '-C', canonicalPath, 'status', '--porcelain=v2', '-z', '--untracked-files=all',
      ]);
      if (status.length > 0) throw new WorktreeSafetyError('Dirty or untracked files block Worktree removal');
      this.#database.saveWorktree({ ...worktree, status: 'removing' });
      externalAttempted = true;
      this.#git.run(environment.gitExecutable, ['-C', project.gitRoot, 'worktree', 'remove', canonicalPath]);
      this.#inject('remove_after_git_remove', payload);
      const facts = this.#git.list(environment.gitExecutable, project.gitRoot);
      if (existsSync(canonicalPath) || this.#findFact(facts, canonicalPath)) {
        throw new WorktreeGitError('Removed Worktree facts still exist');
      }
      const removedAt = this.#now();
      this.#database.sqlite.transaction(() => {
        this.#database.saveWorktree({ ...worktree, status: 'removed', removedAt });
        this.#update(operation, 'committed', { worktreeId, removed: true });
      })();
    } catch (error) {
      if (error instanceof InjectedDaemonCrash) throw error;
      this.#update(operation, externalAttempted ? 'uncertain' : 'failed', undefined,
        { code: externalAttempted ? 'worktree_remove_uncertain' : 'worktree_remove_failed' });
      throw error;
    }
  }

  recoverNonTerminal(): RecoveryResult[] {
    const operations = this.#database.listOperations(['prepared', 'running']);
    return operations
      .filter((operation) => operation.type === 'worktree_create' || operation.type === 'worktree_remove')
      .map((operation) => {
        try { return this.#recover(operation); }
        catch {
          const action = operation.type === 'worktree_create' ? 'create' : 'remove';
          return this.#finishRecovery(operation, action, 'uncertain', 'invalid_or_unreadable_operation');
        }
      });
  }

  #recover(operation: OperationRecord): RecoveryResult {
    const payload = this.#payload(operation.requestPayload);
    const project = this.#projects.get(payload.projectId);
    const environment = this.#environments.get(payload.executionEnvironmentId);
    if (environment.id !== this.#environmentId || this.#normalize(payload.worktreeRoot) !== this.#normalize(this.worktreeRoot)) {
      return this.#finishRecovery(operation, payload.action, 'uncertain', 'environment_or_root_mismatch');
    }
    try {
      this.#assertWithinRoot(payload.targetPath);
      const facts = this.#git.list(environment.gitExecutable, project.gitRoot);
      const exists = existsSync(payload.targetPath) && statSync(payload.targetPath).isDirectory();
      const fact = this.#findFact(facts, payload.targetPath);
      if (payload.action === 'create') {
        const branchExists = this.#git.succeeds(environment.gitExecutable, [
          '-C', project.gitRoot, 'show-ref', '--verify', '--quiet', 'refs/heads/' + payload.branchName,
        ]);
        if (exists && fact?.branch === payload.branchName) {
          const canonicalPath = realpathSync.native(payload.targetPath);
          this.#assertWithinRoot(canonicalPath);
          const worktree: WorktreeRecord = {
            id: payload.worktreeId, projectId: payload.projectId, ownerSessionId: payload.sessionId,
            executionEnvironmentId: payload.executionEnvironmentId, path: canonicalPath,
            branchName: payload.branchName, baseRef: payload.baseRef, baseCommit: payload.baseCommit,
            status: 'active', createdAt: operation.createdAt,
          };
          this.#database.saveWorktree(worktree);
          return this.#finishRecovery(operation, 'create', 'committed', 'worktree_present_and_registered');
        }
        if (!exists && !fact && !branchExists) {
          return this.#finishRecovery(operation, 'create', 'failed', 'no_external_side_effect_observed');
        }
        return this.#finishRecovery(operation, 'create', 'uncertain', 'partial_or_mismatched_git_facts');
      }
      if (!exists && !fact) {
        const record = this.#database.readWorktree(payload.worktreeId);
        if (record) this.#database.saveWorktree({ ...record, status: 'removed', removedAt: this.#now() });
        return this.#finishRecovery(operation, 'remove', 'committed', 'worktree_absent_and_unregistered');
      }
      if (exists && fact) return this.#finishRecovery(operation, 'remove', 'failed', 'remove_not_observed');
      return this.#finishRecovery(operation, 'remove', 'uncertain', 'filesystem_and_git_disagree');
    } catch {
      return this.#finishRecovery(operation, payload.action, 'uncertain', 'fact_probe_failed');
    }
  }

  #finishRecovery(
    operation: OperationRecord,
    action: 'create' | 'remove',
    status: RecoveryResult['status'],
    reason: string,
  ): RecoveryResult {
    this.#update(operation, status, { recovery: reason });
    return { operationId: operation.operationId, action, status, reason };
  }

  #payload(value: JsonValue): WorktreeOperationPayload {
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new WorktreeSafetyError('Invalid Worktree operation payload');
    const payload = value as Record<string, JsonValue>;
    for (const key of ['action', 'worktreeId', 'projectId', 'sessionId', 'executionEnvironmentId',
      'worktreeRoot', 'targetPath', 'branchName', 'baseRef', 'baseCommit']) {
      if (typeof payload[key] !== 'string') throw new WorktreeSafetyError('Invalid Worktree operation payload field: ' + key);
    }
    if (payload.action !== 'create' && payload.action !== 'remove') throw new WorktreeSafetyError('Invalid Worktree action');
    return value as unknown as WorktreeOperationPayload;
  }

  #update(operation: OperationRecord, status: OperationRecord['status'], result?: JsonValue, error?: JsonValue): void {
    this.#database.saveOperation({
      ...operation, status,
      ...(result === undefined ? {} : { resultPayload: result }),
      ...(error === undefined ? {} : { error }),
      updatedAt: this.#now(),
    });
  }

  #inject(point: WorktreeCrashPoint, payload: WorktreeOperationPayload): void {
    if (!this.#crashAt) return;
    this.#crashAt(point, payload);
  }

  #findFact(facts: readonly WorktreeFact[], path: string, branch?: string): WorktreeFact | undefined {
    return facts.find((fact) => this.#normalize(fact.path) === this.#normalize(path)
      && (branch === undefined || fact.branch === branch));
  }

  #assertWithinRoot(path: string): void {
    const relative = win32.relative(this.worktreeRoot, path);
    if (!relative || relative === '..' || relative.startsWith('..' + win32.sep) || win32.isAbsolute(relative)) {
      throw new WorktreeSafetyError('Worktree path escapes or equals configured root');
    }
    if (path.length > 220) throw new WorktreeSafetyError('Worktree path exceeds the V1 safe length limit');
  }

  #normalize(path: string): string { return win32.normalize(path).replaceAll('/', '\\').toLowerCase(); }
  #segment(value: string): string { return value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, ''); }
}