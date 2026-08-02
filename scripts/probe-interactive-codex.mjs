import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const { InteractiveWorkspace } = await import(pathToFileURL(
  join(root, 'apps', 'desktop', 'dist', 'electron-main', 'interactive-workspace.js'),
).href);
const temporary = mkdtempSync(join(tmpdir(), 'tsukiori-real-interactive-'));
const repository = join(temporary, 'repository');
const userData = join(temporary, 'user-data');
let workspace;
let session;

function git(cwd, args, options = {}) {
  return execFileSync('git.exe', ['-C', cwd, ...args], {
    encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options,
  }).trim();
}

try {
  execFileSync('git.exe', ['init', '--quiet', repository]);
  git(repository, ['config', 'user.name', 'Tsukiori Probe']);
  git(repository, ['config', 'user.email', 'probe@tsukiori.invalid']);
  writeFileSync(join(repository, 'README.md'), '# isolated probe\n');
  git(repository, ['add', 'README.md']);
  git(repository, ['commit', '-m', 'init']);

  workspace = new InteractiveWorkspace({ userDataPath: userData, emit: () => undefined });
  const project = workspace.addProject(repository);
  session = await workspace.createSession(project.id);
  const before = workspace.pollEvents(0).cursor;
  await workspace.sendPrompt(
    session.id,
    'Reply with the exact token TSUKIORI_INTERACTIVE_OK. Do not use tools and do not modify files.',
  );
  const deadline = Date.now() + 120_000;
  let cursor = before;
  let assistantText = '';
  let completed = false;
  while (Date.now() < deadline && !completed) {
    const poll = workspace.pollEvents(cursor);
    cursor = poll.cursor;
    for (const event of poll.events) {
      if (event.sessionId !== session.id) continue;
      if (event.type === 'assistant.delta') assistantText += String(event.payload.text ?? '');
      if (event.type === 'permission.requested') {
        throw new Error('Harmless token probe unexpectedly requested permission');
      }
      if (event.type === 'runtime.error') throw new Error(String(event.payload.message ?? 'Runtime error'));
      if (event.type === 'turn.completed') {
        completed = String(event.payload.status ?? '') === 'completed';
      }
    }
    if (!completed) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!completed) throw new Error('Real interactive Codex turn timed out');
  if (!assistantText.includes('TSUKIORI_INTERACTIVE_OK')) {
    throw new Error('Real interactive Codex response marker was missing');
  }
  if (git(session.worktreePath, ['status', '--porcelain'])) {
    throw new Error('Real interactive Codex probe modified its Worktree unexpectedly');
  }
  const snapshot = workspace.snapshot();
  const runtime = snapshot.runtimes[0];
  process.stdout.write(JSON.stringify({
    schemaVersion: 1,
    runtime: 'codex',
    version: runtime.version,
    authenticated: runtime.authenticated,
    authSource: runtime.authSource,
    isolatedWorktree: true,
    threadCreated: Boolean(session.threadId),
    turnCompleted: true,
    streamedMarkerObserved: true,
    worktreeClean: true,
    promptPersisted: false,
    containsCredentials: false,
    containsUserSource: false,
  }, null, 2) + '\n');
} finally {
  if (workspace) await workspace.shutdown().catch(() => undefined);
  if (session && existsSync(session.worktreePath)) {
    execFileSync('git.exe', ['-C', repository, 'worktree', 'remove', '--force', session.worktreePath], {
      windowsHide: true, stdio: 'ignore',
    });
    execFileSync('git.exe', ['-C', repository, 'branch', '-D', session.branch], {
      windowsHide: true, stdio: 'ignore',
    });
  }
  rmSync(temporary, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
