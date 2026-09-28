import { historyFixture } from './history-fixture.mjs';

export async function codexHistoryFixture(t) {
  const calls = [];
  const clients = [];
  const control = { resume: undefined, start: undefined };
  const f = await historyFixture(t, {
    discoverCodex: () => ({ executable: process.execPath, prefixArgs: [], version: '0.146.0', source: 'path-executable' }),
    createClient(options) {
      const index = clients.length;
      const client = {
        options,
        async start() {
          calls.push([index, 'initialize']);
          await control.start?.();
          return { authenticated: true, authSource: 'fixture' };
        },
        async startThread() { calls.push([index, 'thread/start']); return 'thread:fixture'; },
        async resumeThread(id) {
          calls.push([index, 'thread/resume', id]);
          return control.resume ? await control.resume(id) : id;
        },
        async startTurn(threadId) {
          const id = `turn:${calls.filter((call) => call[1] === 'turn/start').length + 1}`;
          calls.push([index, 'turn/start', threadId, id]);
          options.onNotification('turn/started', { turn: { id } });
          return id;
        },
        async interrupt(threadId, turnId) {
          calls.push([index, 'turn/interrupt', threadId, turnId]);
          options.onNotification('turn/completed', { turn: { id: turnId, status: 'interrupted' } });
        },
        async request(method) { calls.push([index, method]); return {}; },
        async stop() { calls.push([index, 'stop']); options.onExit(null); },
        complete(id) { options.onNotification('turn/completed', { turn: { id, status: 'completed' } }); },
      };
      clients.push(client);
      return client;
    },
  });
  const session = await f.workspace.createSession(f.session.projectId, { runtimeType: 'codex', providerId: 'provider:chatgpt', model: 'auto' });
  return { ...f, session, calls, clients, control };
}
