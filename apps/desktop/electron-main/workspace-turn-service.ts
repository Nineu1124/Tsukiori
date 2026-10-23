import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runtimeFailure } from '@tsukiori/runtime-core';
import type { ClaudeCodeClient } from '@tsukiori/adapter-claude';
import type { CodexAppServerClient } from './codex-app-server-client.js';
import { deepSeekClaudeModel, type ProviderRegistry } from './provider-registry.js';
import type { ApiRuntimeClient, ApiRuntimeTurn } from './api-runtime.js';
import { safeApiError } from './api-runtime-error.js';
import { TranscriptStoreError } from './transcript-store.js';
import type { SessionState } from './workspace-types.js';

export type WorkspaceTurnDependencies = {
  session: (sessionId: string) => SessionState;
  assertWritable: (session: SessionState) => void;
  ensureCodexClient: (sessionId: string) => Promise<CodexAppServerClient>;
  codexClients: ReadonlyMap<string, CodexAppServerClient>;
  claudeClient: () => ClaudeCodeClient | null;
  providers: Pick<ProviderRegistry, 'get' | 'withSecret' | 'withEnvironment'>;
  apiRuntime: Pick<ApiRuntimeClient, 'runTurn'>;
  apiHistory: Pick<ReadonlyMap<string, ApiRuntimeTurn['history']>, 'get'>;
  activeTurns: Map<string, string>;
  apiAborts: Map<string, AbortController>;
  emit: (event: { sessionId: string; type: string; payload: Record<string, unknown> }) => void;
  runtimeEvent: (sessionId: string, type: string, payload: Record<string, unknown>) => void;
  refreshTeams: (sessionId: string) => void;
  save: () => void;
};

/** Main 装配依赖；活动句柄与事件回调共享，避免创建另一份 Turn 状态。 */
export class WorkspaceTurnService {
  constructor(readonly dependencies: WorkspaceTurnDependencies) {}

  async sendPrompt(sessionId: string, text: string): Promise<{ turnId: string }> {
    const d = this.dependencies;
    const prompt = text.trim();
    if (!prompt || prompt.length > 64_000) throw new Error('Prompt 必须为 1–64000 个字符');
    const session = d.session(sessionId);
    d.assertWritable(session);
    if (session.transcriptIncomplete) throw new Error('会话记录不完整，请恢复有效检查点或新建会话。');
    if (session.status === 'running' || session.status === 'waiting_permission') {
      throw new Error('当前 Turn 尚未结束；请等待、处理中断或完成权限确认');
    }
    session.status = 'running';
    session.updatedAt = Date.now();
    delete session.lastError;
    d.emit({ sessionId, type: 'user.message', payload: { text: prompt } });
    if (session.transcriptIncomplete) {
      session.status = 'error';
      throw new TranscriptStoreError();
    }
    try {
      if (session.runtimeType === 'codex') {
        const client = await d.ensureCodexClient(sessionId);
        if (!session.threadId) session.threadId = await client.startThread(session.worktreePath);
        const turnId = await client.startTurn(session.threadId, prompt);
        d.activeTurns.set(sessionId, turnId);
        session.turnCount += 1;
        d.save();
        return { turnId };
      }
      if (session.runtimeType === 'api') {
        const provider = d.providers.get(session.providerId);
        const turnId = `api-turn:${randomUUID()}`;
        const controller = new AbortController();
        const history = structuredClone(d.apiHistory.get(sessionId) ?? []);
        const running = d.providers.withSecret(provider.id, (apiKey) => d.apiRuntime.runTurn({
          turnId, provider: { ...provider, models: [...provider.models] }, modelId: session.model,
          apiKey, history, signal: controller.signal,
          callbacks: { onEvent: (type, payload) => d.runtimeEvent(sessionId, type, payload) },
        }));
        d.apiAborts.set(sessionId, controller);
        d.activeTurns.set(sessionId, turnId);
        session.turnCount += 1;
        d.save();
        void running.catch((error: unknown) => {
          const interrupted = controller.signal.aborted || (error instanceof Error && error.name === 'AbortError');
          const safe = safeApiError(error, interrupted);
          d.runtimeEvent(sessionId, 'runtime.error', { message: safe.message, category: safe.category });
          d.runtimeEvent(sessionId, 'turn.completed', {
            turnId, status: interrupted ? 'interrupted' : 'failed',
            ...(interrupted ? {} : { error: safe.message, category: safe.category }),
          });
        }).finally(() => d.apiAborts.delete(sessionId));
        return { turnId };
      }
      const claude = d.claudeClient();
      if (!claude || !session.threadId) throw new Error('Claude Code Runtime 不可用');
      const provider = d.providers.get(session.providerId);
      const turnId = d.providers.withEnvironment(provider.id, (environment) => claude.startTurn({
        cwd: session.worktreePath, sessionId: session.threadId as string,
        ...(existsSync(join(session.worktreePath, '.mcp.json')) ? { mcpConfigPath: join(session.worktreePath, '.mcp.json') } : {}),
        resume: session.turnCount > 0 && !session.forkSourceRuntimeSessionId,
        ...(session.forkSourceRuntimeSessionId ? { forkFromSessionId: session.forkSourceRuntimeSessionId } : {}),
        ...(session.forkSourceRuntimeMessageId ? { resumeSessionAt: session.forkSourceRuntimeMessageId } : {}),
        prompt, model: provider.kind === 'deepseek' ? deepSeekClaudeModel(session.model) : session.model,
        permissionMode: session.permissionMode,
        ...(session.thinkingEffort ? { thinkingEffort: session.thinkingEffort } : {}),
        authMode: provider.kind === 'claude-native' ? 'native' : 'provider', environment,
        onEvent: (type, payload) => d.runtimeEvent(sessionId, type, payload),
        onExit: (error) => {
          if (!error) return;
          error = runtimeFailure(error).message;
          session.status = 'error'; session.lastError = error; session.updatedAt = Date.now();
          d.activeTurns.delete(sessionId);
          d.emit({ sessionId, type: 'runtime.error', payload: { message: error } });
          d.refreshTeams(sessionId);
          d.save();
        },
      }), session.model);
      d.activeTurns.set(sessionId, turnId);
      session.turnCount += 1;
      d.save();
      return { turnId };
    } catch (error) {
      const safe = session.runtimeType === 'api' ? safeApiError(error) : undefined;
      const failure = safe ?? new Error(runtimeFailure(error).message);
      const message = truncate(failure instanceof Error ? failure.message : String(failure), 2_000);
      session.status = 'error'; session.lastError = message; session.updatedAt = Date.now();
      d.activeTurns.delete(sessionId);
      d.emit({ sessionId, type: 'runtime.error', payload: { message, ...(safe ? { category: safe.category } : {}) } });
      d.refreshTeams(sessionId);
      d.save();
      throw failure;
    }
  }

  async interrupt(sessionId: string): Promise<void> {
    const d = this.dependencies;
    const session = d.session(sessionId);
    const turnId = d.activeTurns.get(sessionId);
    if (!turnId) throw new Error('当前没有可中断的 Turn');
    if (session.runtimeType === 'api') {
      const controller = d.apiAborts.get(sessionId);
      if (!controller) throw new Error('当前 Direct API Turn 不可中断');
      controller.abort();
    } else if (session.runtimeType === 'claude') d.claudeClient()?.interrupt(turnId);
    else {
      const client = d.codexClients.get(sessionId);
      if (!client || !session.threadId) throw new Error('当前 Codex Turn 不可中断');
      await client.interrupt(session.threadId, turnId);
    }
    d.emit({ sessionId, type: 'turn.interrupt_requested', payload: { turnId } });
  }
}

function truncate(value: string, max: number): string { return value.length <= max ? value : value.slice(0, max) + '\n…[truncated]'; }
