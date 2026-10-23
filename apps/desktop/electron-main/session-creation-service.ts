import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { validatedThinkingEffort, type ThinkingControlMatrix } from './thinking-control.js';
import { assertProviderCompatibility, compatibleDefaultProvider, defaultPermission, permissionMode, providerNeedsSecret, safeModel } from './session-policy.js';
import type { ProjectState, SessionState, WorkspaceSettings, RuntimeState, RuntimeType } from './workspace-types.js';
import type { ProviderConfig } from './provider-registry.js';
import type { WorkspaceEvent } from './interactive-workspace.js';

export type SessionSelection = Partial<Pick<SessionState, 'runtimeType' | 'providerId' | 'model' | 'permissionMode' | 'thinkingEffort'>>;
export type SessionCreationDependencies = {
  worktreeRoot: string;
  project(id: string): ProjectState;
  settings(): WorkspaceSettings;
  provider(id: string): ProviderConfig;
  runtime(type: RuntimeType): RuntimeState | undefined;
  thinkingControl(type: RuntimeType, providerId: string): ThinkingControlMatrix;
  sessions(): SessionState[];
  git(cwd: string, args: readonly string[]): string;
  bindMcp(project: ProjectState, path: string, branch: string, runtime: RuntimeType): void;
  save(): void;
  emit(event: Pick<WorkspaceEvent, 'sessionId' | 'type' | 'payload'>): void;
};

export class SessionCreationService {
  constructor(private readonly dependencies: SessionCreationDependencies) {}
  async create(projectId: string, selection?: Partial<Pick<SessionState, 'runtimeType' | 'providerId' | 'model' | 'permissionMode' | 'thinkingEffort'>>): Promise<SessionState> {
    const d = this.dependencies;
    const project = d.project(projectId);
    const runtimeType = selection?.runtimeType ?? d.settings().defaultRuntime;
    const providerId = selection?.providerId ?? compatibleDefaultProvider(runtimeType, d.settings().defaultProviderId);
    const provider = d.provider(providerId);
    assertProviderCompatibility(runtimeType, provider.kind);
    const runtime = d.runtime(runtimeType);
    if (!runtime?.available) throw new Error(runtime?.error ?? `${runtimeType} Runtime 不可用`);
    if (providerNeedsSecret(provider) && !provider.secretRef) throw new Error('所选 Provider 尚未保存 API Key');
    if (provider.kind === 'claude-native' && !runtime.authenticated) throw new Error('Claude Code 本机 Runtime 尚未登录');
    const preferredModel = selection?.model ?? d.settings().defaultModel;
    const model = safeModel(provider.models.includes(preferredModel) ? preferredModel : provider.models[0] ?? 'auto');
    const selectedPermission = permissionMode(selection?.permissionMode ?? defaultPermission(runtimeType));
    const thinkingEffort = validatedThinkingEffort(
      selection?.thinkingEffort,
      d.thinkingControl(runtimeType, provider.id),
    );
    const token = randomUUID();
    const branch = 'tsukiori/session-' + token.slice(0, 8);
    const worktreePath = join(d.worktreeRoot, project.id.replace(':', '-'), token.slice(0, 12));
    mkdirSync(dirname(worktreePath), { recursive: true });
    d.git(project.gitRoot, ['worktree', 'add', '-b', branch, worktreePath, 'HEAD']);
    d.bindMcp(project, worktreePath, branch, runtimeType);
    const runtimeCount = d.sessions().filter((item) => item.runtimeType === runtimeType).length + 1;
    const runtimeName = runtimeType === 'codex' ? 'Codex' : runtimeType === 'claude' ? 'Claude' : 'API';
    const session: SessionState = {
      id: 'session:' + token, projectId,
      name: `${runtimeName} ${runtimeCount}`,
      runtimeType, providerId, model, environment: 'windows-native', permissionMode: selectedPermission,
      ...(thinkingEffort ? { thinkingEffort } : {}),
      worktreePath, branch, ...(runtimeType !== 'codex' ? { threadId: randomUUID() } : {}),
      turnCount: 0, status: 'ready', createdAt: Date.now(), updatedAt: Date.now(),
    };
    d.sessions().push(session);
    d.save();
    d.emit({ sessionId: session.id, type: 'session.created', payload: {
      name: session.name, projectId, worktreePath, branch, runtimeType, providerId, model,
    } });
    d.emit({ sessionId: session.id, type: 'session.ready', payload: { branch, worktreePath } });
    return session;
  }

}
