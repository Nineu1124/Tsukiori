import { readApiHistory } from './api-runtime.js';

export type ModelHistory = ReturnType<typeof readApiHistory>;
export type ModelHistoryEvent = Parameters<typeof readApiHistory>[0][number];

/** 完整模型消息不受 UI 事件缓存限制；该 Repository 不承担持久化。 */
export class ModelHistoryRepository {
  readonly #history = new Map<string, ModelHistory>();

  get(sessionId: string): ModelHistory | undefined { return this.#history.get(sessionId); }

  set(sessionId: string, history: ModelHistory): this {
    this.#history.set(sessionId, history);
    return this;
  }

  delete(sessionId: string): boolean { return this.#history.delete(sessionId); }

  appendEvent(sessionId: string, event: ModelHistoryEvent): void {
    const messages = readApiHistory([event]);
    if (!messages.length) return;
    const history = this.#history.get(sessionId) ?? [];
    history.push(...messages);
    this.#history.set(sessionId, history);
  }
}
