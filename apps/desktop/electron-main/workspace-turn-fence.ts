type TurnRequest = { pending: boolean; completed: boolean; startedId?: string };

/** Shares the actual active-turn map; a notification cannot create a new request. */
export class WorkspaceTurnFence {
  readonly #requests = new Map<string, TurnRequest>();
  constructor(readonly activeTurns: Map<string, string>) {}

  begin(sessionId: string): void {
    this.activeTurns.delete(sessionId);
    this.#requests.set(sessionId, { pending: true, completed: false });
  }

  bind(sessionId: string, turnId: string): void {
    const request = this.#requests.get(sessionId);
    if (!request) return;
    request.pending = false;
    if (!request.completed) this.activeTurns.set(sessionId, turnId);
  }

  fail(sessionId: string): void {
    const request = this.#requests.get(sessionId);
    if (request) { request.pending = false; request.completed = true; }
  }

  matches(sessionId: string, turnId: string): boolean {
    const request = this.#requests.get(sessionId);
    if (!request || request.completed) return false;
    const active = this.activeTurns.get(sessionId);
    return active ? active === turnId : request.pending;
  }

  accept(sessionId: string, type: string, payload: Record<string, unknown>): boolean {
    const request = this.#requests.get(sessionId);
    const turnId = typeof payload.hostTurnId === 'string' ? payload.hostTurnId
      : typeof payload.turnId === 'string' ? payload.turnId : undefined;
    if (turnId && !this.matches(sessionId, turnId)) return false;
    if (type === 'turn.started') {
      if (!request || request.completed || (!request.pending && !this.activeTurns.has(sessionId))) return false;
      if (turnId && request.startedId === turnId) return false;
      if (turnId) request.startedId = turnId;
    } else if (type === 'turn.completed') {
      if (!request || request.completed) return false;
      request.completed = true; request.pending = false;
    }
    return true;
  }
}
