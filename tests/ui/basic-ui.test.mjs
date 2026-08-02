import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const rendererRoot = join(root, 'apps', 'desktop', 'renderer');

test('Session workspace includes Attention, Tool, Permission, and Runtime auth presentation surfaces', async () => {
  const [html, script] = await Promise.all([
    readFile(join(rendererRoot, 'index.html'), 'utf8'),
    readFile(join(rendererRoot, 'renderer.js'), 'utf8'),
  ]);
  assert.match(html, /id="attention-center"/);
  assert.match(html, /id="session-timeline"/);
  assert.match(html, /id="tool-card-template"/);
  assert.match(html, /id="permission-card-template"/);
  assert.match(html, /id="runtime-card-template"/);
  assert.match(html, /认证来源/);
  assert.match(html, /兼容性/);
  assert.match(html, /CODEX NATIVE CAPABILITIES/);
  assert.match(html, /PROVIDER &amp; DATA DESTINATION/);
  assert.match(html, /数据出口/);
  assert.match(html, /模型请求尚未启动/);
  assert.match(html, /不自动提升为公共 Adapter 能力/);
  for (const label of ['类别', '风险', '范围', 'Enforcement Level']) assert.match(html, new RegExp(label));
  assert.match(script, /window\.tsukiori\.workspace\.snapshot\(\)/);
  assert.match(script, /runtime\.authenticated/);
  assert.match(script, /runtime\.nativeCapabilities/);
  assert.match(script, /supportLevel/);
  assert.match(script, /enforcementLevel/);
  assert.match(script, /runtime_native/);
  assert.match(script, /runtime\.providers/);
  assert.match(script, /destinationHost/);
  assert.match(script, /modelRequestStarted/);
  assert.match(script, /textContent/);
  assert.doesNotMatch(script, /innerHTML|insertAdjacentHTML|eval\(/);
});

test('interactive workspace exposes real project, Codex turn, Worktree review, and commit controls', async () => {
  const [html, script, preload] = await Promise.all([
    readFile(join(rendererRoot, 'index.html'), 'utf8'),
    readFile(join(rendererRoot, 'renderer.js'), 'utf8'),
    readFile(join(root, 'apps', 'desktop', 'preload', 'index.cjs'), 'utf8'),
  ]);
  for (const id of [
    'add-project', 'project-list', 'session-list', 'new-session', 'conversation',
    'prompt-input', 'send-prompt', 'interrupt-turn', 'git-files', 'git-diff',
    'stage-files', 'unstage-files', 'commit-files',
  ]) assert.match(html, new RegExp(`id="${id}"`));
  for (const method of [
    'pickProject', 'createSession', 'sendPrompt', 'interruptTurn', 'gitStatus',
    'gitDiff', 'stage', 'unstage', 'commit', 'pollEvents',
  ]) assert.match(script + preload, new RegExp(`workspace\\.${method}`));
  assert.match(script, /snapshot\?\.mode === 'interactive'/);
  assert.match(html, /独立 Git Worktree/);
});

test('interactive workspace follows the V1.0 four-region layout and light design tokens', async () => {
  const [html, styles, script] = await Promise.all([
    readFile(join(rendererRoot, 'index.html'), 'utf8'),
    readFile(join(rendererRoot, 'styles.css'), 'utf8'),
    readFile(join(rendererRoot, 'renderer.js'), 'utf8'),
  ]);
  for (const id of [
    'toggle-left-panel', 'toggle-right-panel', 'toggle-terminal', 'terminal-panel',
    'terminal-output', 'runtime-select', 'model-select', 'environment-select',
    'permission-select', 'session-context-path',
  ]) assert.match(html, new RegExp(`id="${id}"`));
  for (const view of ['permissions', 'changes']) {
    assert.match(html, new RegExp(`data-panel-tab="${view}"`));
    assert.match(html, new RegExp(`data-panel-view="${view}"`));
  }
  for (const token of [
    '--tsukiori-bg: #f5fbff', '--tsukiori-primary: #258fe8',
    '--tsukiori-primary-300: #4bb9ef', '--tsukiori-text: #20364b',
    '--tsukiori-success: #45c995', '--tsukiori-warning: #f3c94f',
    '--tsukiori-danger: #ef6b7c', '--tsukiori-special: #8e7bef',
  ]) assert.ok(styles.toLowerCase().includes(token));
  assert.match(styles, /grid-template:\s*40px minmax\(0,1fr\) \/ 300px minmax\(480px,1fr\) 300px/);
  assert.match(styles, /grid-template-rows:\s*38px minmax\(140px,1fr\) auto 220px/);
  assert.match(styles, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  assert.match(styles, /\.chat-message\.user[\s\S]*justify-self:\s*end/);
  assert.match(styles, /\.chat-message\.assistant[\s\S]*background:\s*transparent/);
  assert.match(styles, /prefers-reduced-motion/);
  assert.match(script, /classifyToolEvent/);
  assert.match(script, /activateWorkPanel/);
  assert.match(script, /terminal-collapsed/);
});
test('Windows Alpha UI exposes only implemented OpenCode workflow actions', async () => {
  const [html, script] = await Promise.all([
    readFile(join(rendererRoot, 'index.html'), 'utf8'),
    readFile(join(rendererRoot, 'renderer.js'), 'utf8'),
  ]);
  assert.match(html, /id="alpha-workflow"/);
  for (const step of ['project', 'worktree', 'runtime', 'review', 'archive']) {
    assert.match(html, new RegExp('data-step="' + step + '"'));
  }
  for (const action of ['stage', 'commit', 'archive', 'safeCleanup']) {
    assert.match(html, new RegExp('data-action="' + action + '"'));
  }
  for (const method of ['stage', 'commit', 'archive', 'decidePermission', 'answerInput']) {
    assert.match(script, new RegExp('workspace\\.' + method));
  }
  for (const unavailable of ['data-action="merge"', 'data-runtime="claude"', 'data-runtime="acp"', 'data-platform=']) {
    assert.doesNotMatch(html, new RegExp(unavailable));
  }
  assert.doesNotMatch(script, /child_process|node:fs|shell:/);
});
test('V1 Git UI exposes audited operations and Integration Worktree boundaries', async () => {
  const [html, script] = await Promise.all([
    readFile(join(rendererRoot, 'index.html'), 'utf8'),
    readFile(join(rendererRoot, 'renderer.js'), 'utf8'),
  ]);
  assert.match(html, /id="v1-git-workflow"/);
  for (const action of ['unstage', 'revert', 'integrate', 'continue', 'external-editor']) {
    assert.match(html, new RegExp('data-v1-action="' + action + '"'));
  }
  assert.match(html, /Revert with snapshot/);
  assert.match(html, /临时 Integration Worktree/);
  assert.match(html, /更新目标分支需要再次明确确认/);
  for (const method of ['unstage', 'revert', 'integrate', 'continueIntegration', 'openExternalEditor']) {
    assert.match(script, new RegExp('workspace\\.' + method));
  }
  assert.doesNotMatch(script, /child_process|node:fs|spawn\(|exec\(/);
});
test('Diagnostic UI defaults safe and shows re-sanitized opt-in size before export', async () => {
  const [html, script, preload] = await Promise.all([
    readFile(join(rendererRoot, 'index.html'), 'utf8'),
    readFile(join(rendererRoot, 'renderer.js'), 'utf8'),
    readFile(join(root, 'apps/desktop/preload/index.cjs'), 'utf8'),
  ]);
  assert.match(html, /id="diagnostic-bundle"/);
  assert.match(html, /默认排除源码、完整 Prompt、Raw Payload、凭据和认证存储/);
  assert.match(html, /包含再次脱敏的敏感预览/);
  assert.match(html, /diagnosticEstimatedBytes/);
  assert.match(script, /sensitiveEstimatedBytes/);
  assert.match(script, /defaultEstimatedBytes/);
  assert.match(script, /exportDiagnostic\(checkbox\.checked\)/);
  assert.match(preload, /type: 'export_diagnostic'/);
  assert.doesNotMatch(script + preload, /child_process|node:fs|spawn\(|exec\(|innerHTML/);
});
