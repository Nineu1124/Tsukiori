// Explicit opt-in probe for two real Codex app-server Sessions. The fixture has
// no user source and the output contains only bounded counters, never model text.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

if (process.argv[2] !== '--confirm-external-model-call') {
  throw new Error('Refusing external model calls without --confirm-external-model-call');
}

const { InteractiveWorkspace } = await import('../apps/desktop/dist/electron-main/interactive-workspace.js');
const temporaryRoot = mkdtempSync(join(tmpdir(), 'tsukiori-real-team-'));
const repository = join(temporaryRoot, 'repository');
const userData = join(temporaryRoot, 'user-data');
mkdirSync(repository, { recursive: true });

const git = (args, options = {}) => execFileSync('git.exe', args, {
  encoding: 'utf8', windowsHide: true, stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
});
git(['init', '--quiet', repository]);
git(['-C', repository, 'config', 'user.name', 'Tsukiori Runtime Probe']);
git(['-C', repository, 'config', 'user.email', 'probe@tsukiori.invalid']);
writeFileSync(join(repository, 'README.md'), '# Runtime probe fixture\n', 'utf8');
git(['-C', repository, 'add', 'README.md']);
git(['-C', repository, 'commit', '-m', 'fixture']);

let workspace;
let sessions = [];
try {
  workspace = new InteractiveWorkspace({ userDataPath: userData, emit: () => {} });
  const runtimeBefore = workspace.snapshot().runtimes.find((item) => item.type === 'codex');
  if (!runtimeBefore?.available) throw new Error('Codex Runtime is unavailable');
  const project = workspace.addProject(repository);
  const team = await workspace.createTeam(
    project.id,
    '这是无源码的运行时连通性测试。不要调用任何工具、不要修改文件；只用一句简短中文确认你已收到任务。',
    [
      { role: '连接验证 A', runtimeType: 'codex', providerId: 'provider:chatgpt', model: 'auto' },
      { role: '连接验证 B', runtimeType: 'codex', providerId: 'provider:chatgpt', model: 'auto' },
    ],
  );
  const deadline = Date.now() + 180_000;
  let snapshot;
  while (Date.now() < deadline) {
    snapshot = workspace.snapshot();
    const current = snapshot.teams.find((item) => item.id === team.id);
    if (['completed', 'partial_failure', 'stopped'].includes(current?.status)) break;
    if ((snapshot.permissions ?? []).length) throw new Error('Harmless probe unexpectedly requested permission');
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  snapshot = workspace.snapshot();
  const runtimeAfter = snapshot.runtimes.find((item) => item.type === 'codex');
  const current = snapshot.teams.find((item) => item.id === team.id);
  sessions = snapshot.sessions.filter((item) => team.memberSessionIds.includes(item.id));
  const deltas = snapshot.recentEvents.filter((event) => (
    team.memberSessionIds.includes(event.sessionId) && event.type === 'assistant.delta'
  ));
  const assistantChars = deltas.reduce((sum, event) => sum + String(event.payload?.text ?? '').length, 0);
  if (current?.status !== 'completed' || sessions.some((item) => item.status !== 'ready') || assistantChars < 2) {
    throw new Error(`Real Team probe did not complete: ${current?.status ?? 'missing'}`);
  }
  process.stdout.write(JSON.stringify({
    schemaVersion: 1,
    supportLevel: 'supported',
    runtimeVersion: runtimeAfter.version,
    authenticated: runtimeAfter.authenticated,
    authSource: runtimeAfter.authSource,
    teamStatus: current.status,
    memberCount: sessions.length,
    distinctWorktrees: new Set(sessions.map((item) => item.worktreePath.toLowerCase())).size,
    readyMembers: sessions.filter((item) => item.status === 'ready').length,
    assistantEventCount: deltas.length,
    assistantChars,
    permissionsRequested: 0,
    sourceFilesModified: sessions.filter((item) => git(['-C', item.worktreePath, 'status', '--porcelain']).trim()).length,
  }) + '\n');
} finally {
  if (workspace) sessions = workspace.snapshot().sessions;
  if (workspace) await workspace.shutdown().catch(() => undefined);
  const safeTemporaryPrefix = resolve(tmpdir()).toLowerCase() + sep;
  for (const session of sessions) {
    if (resolve(session.worktreePath).toLowerCase().startsWith(resolve(temporaryRoot).toLowerCase() + sep)) {
      try { git(['-C', repository, 'worktree', 'remove', '--force', session.worktreePath], { stdio: 'ignore' }); } catch {}
    }
    try { git(['-C', repository, 'branch', '-D', session.branch], { stdio: 'ignore' }); } catch {}
  }
  if (resolve(temporaryRoot).toLowerCase().startsWith(safeTemporaryPrefix)) {
    rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}
