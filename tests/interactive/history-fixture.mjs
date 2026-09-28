import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InteractiveWorkspace } from '../../apps/desktop/dist/electron-main/interactive-workspace.js';

export function assistant(text = 'fixture answer') {
  return { role: 'assistant', content: [{ type: 'text', text }], api: 'openai-completions',
    provider: 'fixture', model: 'fixture', stopReason: 'stop', timestamp: 1,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

export async function historyFixture(t, overrides = {}) {
  const temporary = mkdtempSync(join(tmpdir(), 'tsukiori-history-'));
  const repository = join(temporary, 'repository');
  const userDataPath = join(temporary, 'user-data');
  const git = (...args) => execFileSync('git', args, { windowsHide: true, stdio: 'pipe' });
  git('init', '--quiet', repository);
  git('-C', repository, 'config', 'user.name', 'Fixture');
  git('-C', repository, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(repository, 'README.md'), '# fixture\n');
  git('-C', repository, 'add', '.');
  git('-C', repository, 'commit', '-qm', 'fixture');
  const instances = [];
  const emitted = [];
  const histories = [];
  const unavailable = () => { throw new Error('fixture runtime unavailable'); };
  const credentials = { store: () => 'secretref:00000000-0000-4000-8000-000000000009',
    use: (_reference, _binding, consumer) => consumer('fixture-value'), delete: () => true };
  const apiRuntime = { async runTurn(input) {
    histories.push(structuredClone(input.history));
    input.history[0].content = 'client mutation must stay isolated';
    await Promise.resolve();
    input.callbacks.onEvent('api.assistant.message', { message: assistant() });
    input.callbacks.onEvent('turn.completed', { turnId: input.turnId, status: 'completed' });
    return assistant();
  } };
  const open = () => {
    const workspace = new InteractiveWorkspace({ userDataPath, emit: (event) => emitted.push(event),
      discoverCodex: unavailable, discoverClaude: unavailable, credentials, apiRuntime, ...overrides });
    instances.push(workspace);
    return workspace;
  };
  t.after(async () => {
    for (const workspace of instances) await workspace.shutdown();
    // mkdtemp creates this fixture's isolated tree; no user paths are included.
    rmSync(temporary, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  });
  const workspace = open();
  const provider = workspace.saveProvider({ name: 'Fixture', kind: 'openai-compatible',
    baseUrl: 'https://example.invalid/v1', models: ['fixture'], apiKey: 'fixture-value',
    contextWindow: 32_000, maxTokens: 4_096 });
  const project = workspace.addProject(repository);
  const session = await workspace.createSession(project.id, { runtimeType: 'api', providerId: provider.id, model: 'fixture' });
  return { workspace, open, session, histories, emitted, userDataPath, repository };
}

export async function send(workspace, sessionId, text) {
  await workspace.sendPrompt(sessionId, text);
  await new Promise((resolve) => setImmediate(resolve));
}
