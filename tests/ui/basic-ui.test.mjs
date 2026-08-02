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