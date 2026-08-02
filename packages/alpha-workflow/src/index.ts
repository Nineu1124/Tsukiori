import { randomUUID } from 'node:crypto';
import type { OpenCodeRuntimeAdapter, OpenCodeRuntimeHandle } from '@tsukiori/adapter-opencode';
import type { LocalDatabase } from '@tsukiori/database';
import type {
  AttentionItemRecord, HostSession, HostTurn, PermissionAuditRecord, PermissionDecision,
  Project, WorkspaceBindingRecord,
} from '@tsukiori/domain';
import {
  GitDiffService, type DiffResult, type GitCommitResult, type GitStatusSnapshot,
} from '@tsukiori/git-service';
import { PermissionBroker } from '@tsukiori/permission-broker';
import { ProjectManager } from '@tsukiori/project-manager';
import { WorkspaceCoordinator, type WorkspaceArchiveResult } from '@tsukiori/workspace-manager';

export const ALPHA_VISIBLE_ENTRY_POINTS = [
  'project', 'worktree', 'opencode', 'deepseek', 'attention', 'diff', 'commit', 'archive',
] as const;
export const ALPHA_HIDDEN_ENTRY_POINTS = [
  'merge', 'claude', 'acp', 'wsl', 'macos', 'linux',
] as const;

export type AlphaStartInput = {
  projectRoot: string;
  executionEnvironmentId: string;
  runtimeProfileId: string;
  providerId: string;
  modelId: string;
  title: string;
  firstPrompt: string;
  projectName?: string;
  baseRef?: string;
  slug?: string;
};

export type AlphaWorkflowSnapshot = {
  schemaVersion: 1;
  project: Project;
  session: HostSession;
  binding: WorkspaceBindingRecord;
  git: GitStatusSnapshot;
  diff: { commit: DiffResult; staged: DiffResult; working: DiffResult };
  attention: AttentionItemRecord[];
  visibleEntryPoints: readonly string[];
  hiddenEntryPoints: readonly string[];
  actions: {
    reviewDiff: true;
    stage: boolean;
    commit: boolean;
    archive: true;
    safeCleanup: boolean;
  };
};

export class AlphaWorkflowError extends Error {
  constructor(message: string) { super(message); this.name = 'AlphaWorkflowError'; }
}

export class OpenCodeAlphaWorkflow {
  readonly #database: LocalDatabase;
  readonly #projects: ProjectManager;
  readonly #workspaces: WorkspaceCoordinator;
  readonly #git: GitDiffService;
  readonly #runtime: OpenCodeRuntimeAdapter;
  readonly #permissions: PermissionBroker;
  readonly #now: () => number;
  readonly #id: () => string;
  readonly #handles = new Map<string, OpenCodeRuntimeHandle>();

  constructor(input: {
    database: LocalDatabase;
    projects: ProjectManager;
    workspaces: WorkspaceCoordinator;
    git: GitDiffService;
    runtime: OpenCodeRuntimeAdapter;
    permissions: PermissionBroker;
    now?: () => number;
    id?: () => string;
  }) {
    this.#database = input.database;
    this.#projects = input.projects;
    this.#workspaces = input.workspaces;
    this.#git = input.git;
    this.#runtime = input.runtime;
    this.#permissions = input.permissions;
    this.#now = input.now ?? Date.now;
    this.#id = input.id ?? randomUUID;
  }

  async start(input: AlphaStartInput): Promise<{ snapshot: AlphaWorkflowSnapshot; turn: HostTurn }> {
    if (!input.title.trim()) throw new AlphaWorkflowError('Session title is required');
    if (!input.firstPrompt.trim()) throw new AlphaWorkflowError('First Prompt is required');
    const project = this.#projects.add({
      rootPath: input.projectRoot,
      executionEnvironmentId: input.executionEnvironmentId,
      ...(input.projectName === undefined ? {} : { name: input.projectName }),
    });
    const at = this.#now();
    const session: HostSession = {
      id: 'session:alpha:' + this.#id(),
      title: input.title.trim(),
      projectId: project.id,
      runtimeType: 'opencode',
      runtimeProfileId: input.runtimeProfileId,
      lifecycle: 'active',
      activity: 'preparing',
      health: 'healthy',
      writeMode: 'isolated-worktree',
      createdAt: at,
      updatedAt: at,
    };
    this.#database.saveSession(session);
    let handle: OpenCodeRuntimeHandle | undefined;
    try {
      const created = this.#workspaces.createWritableSessionWorkspace({
        sessionId: session.id,
        projectId: project.id,
        runtimeType: 'opencode',
        ...(input.baseRef === undefined ? {} : { baseRef: input.baseRef }),
        ...(input.slug === undefined ? {} : { slug: input.slug }),
      });
      if (!created.setup.success || created.binding.status !== 'active') {
        throw new AlphaWorkflowError('Worktree setup did not complete');
      }
      handle = await this.#runtime.start(input.runtimeProfileId, created.binding.path);
      const selection = handle.selectProvider(input.providerId, input.modelId);
      if (selection.destinationHost !== 'api.deepseek.com') {
        throw new AlphaWorkflowError('Windows Alpha requires the verified DeepSeek data destination');
      }
      await handle.createSession(session.id, input.providerId, input.modelId, session.title);
      this.#handles.set(session.id, handle);
      const turn = await handle.startTurn(session.id, input.firstPrompt);
      return { snapshot: this.snapshot(session.id), turn };
    } catch (error) {
      if (handle) await handle.stop().catch(() => undefined);
      this.#handles.delete(session.id);
      this.#permissions.addAttention({
        projectId: project.id,
        sessionId: session.id,
        kind: 'failed',
        title: 'OpenCode Alpha 启动失败',
        sourceRef: 'alpha-start:' + session.id,
        payload: { code: 'alpha_start_failed', retainedWorkspace: true },
      });
      throw error;
    }
  }

  snapshot(sessionId: string): AlphaWorkflowSnapshot {
    const session = this.#session(sessionId);
    const project = this.#projects.get(session.projectId);
    const binding = this.#database.readWorkspaceBinding(sessionId);
    if (!binding) throw new AlphaWorkflowError('Session has no Workspace Binding');
    const git = this.#git.status(sessionId);
    const diff = this.#git.sessionDiff(sessionId);
    const attention = this.#permissions.snapshot().attention.filter((item) => item.sessionId === sessionId);
    return {
      schemaVersion: 1,
      project,
      session,
      binding,
      git,
      diff,
      attention,
      visibleEntryPoints: ALPHA_VISIBLE_ENTRY_POINTS,
      hiddenEntryPoints: ALPHA_HIDDEN_ENTRY_POINTS,
      actions: {
        reviewDiff: true,
        stage: git.files.some((file) => file.working || file.untracked),
        commit: git.files.some((file) => file.staged) && !git.files.some((file) => file.conflict),
        archive: true,
        safeCleanup: git.clean && session.activity !== 'running' && session.activity !== 'waiting_permission',
      },
    };
  }

  review(sessionId: string): AlphaWorkflowSnapshot['diff'] {
    this.#session(sessionId);
    return this.#git.reviewSessionDiff(sessionId);
  }

  stage(sessionId: string, filePaths: readonly string[]): GitStatusSnapshot {
    this.#active(sessionId);
    return this.#git.stage(sessionId, filePaths);
  }

  unstage(sessionId: string, filePaths: readonly string[]): GitStatusSnapshot {
    this.#active(sessionId);
    return this.#git.unstage(sessionId, filePaths);
  }

  revert(sessionId: string, filePaths: readonly string[]) {
    this.#active(sessionId);
    return this.#git.revert(sessionId, filePaths);
  }

  commit(sessionId: string, subject: string): GitCommitResult {
    this.#active(sessionId);
    return this.#git.commit(sessionId, subject);
  }

  decidePermission(
    sessionId: string,
    permissionId: string,
    connectionEpoch: string,
    decision: PermissionDecision,
  ): Promise<PermissionAuditRecord> {
    return this.#handle(sessionId).decidePermission(permissionId, connectionEpoch, decision);
  }

  answerInput(sessionId: string, requestId: string, answers: readonly (readonly string[])[]): Promise<void> {
    return this.#handle(sessionId).answerQuestion(sessionId, requestId, answers);
  }

  rejectInput(sessionId: string, requestId: string): Promise<void> {
    return this.#handle(sessionId).rejectQuestion(sessionId, requestId);
  }

  async archive(sessionId: string, cleanup: 'retain' | 'run' = 'retain'): Promise<WorkspaceArchiveResult> {
    this.#active(sessionId);
    const handle = this.#handles.get(sessionId);
    if (handle) await handle.stop();
    this.#handles.delete(sessionId);
    return this.#workspaces.archive(sessionId, { cleanup });
  }

  async dispose(): Promise<void> {
    const handles = [...this.#handles.values()];
    this.#handles.clear();
    await Promise.all(handles.map((handle) => handle.stop().catch(() => undefined)));
  }

  #handle(sessionId: string): OpenCodeRuntimeHandle {
    this.#active(sessionId);
    const handle = this.#handles.get(sessionId);
    if (!handle) throw new AlphaWorkflowError('OpenCode Runtime Handle is unavailable');
    return handle;
  }

  #active(sessionId: string): HostSession {
    const session = this.#session(sessionId);
    if (session.lifecycle !== 'active') throw new AlphaWorkflowError('Session is not active');
    return session;
  }

  #session(sessionId: string): HostSession {
    const session = this.#database.readSession(sessionId);
    if (!session) throw new AlphaWorkflowError('Session not found');
    return session;
  }
}