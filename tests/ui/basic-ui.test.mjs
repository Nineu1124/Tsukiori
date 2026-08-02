import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const rendererRoot = join(root, 'apps', 'desktop', 'renderer');

async function rendererFiles() {
  return Promise.all([
    readFile(join(rendererRoot, 'index.html'), 'utf8'),
    readFile(join(rendererRoot, 'renderer.js'), 'utf8'),
    readFile(join(rendererRoot, 'styles.css'), 'utf8'),
    readFile(join(root, 'apps', 'desktop', 'preload', 'index.cjs'), 'utf8'),
  ]);
}

test('main workspace matches the V1.0 four-region information architecture', async () => {
  const [html,, styles] = await rendererFiles();
  for (const id of ['project-list','session-list','conversation','prompt-input','terminal-panel','attention-center']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  for (const label of ['侧边对话','文件','全部变更','浏览器']) assert.match(html, new RegExp(label));
  for (const token of ['#f5fbff','#258fe8','#4bb9ef','#20364b','#526b80','#45c995','#f3c94f','#ef6b7c','#8e7bef']) {
    assert.ok(styles.toLowerCase().includes(token));
  }
  assert.match(styles, /grid-template:\s*40px minmax\(0,1fr\) \/ 300px minmax\(480px,1fr\) 300px/);
  assert.match(styles, /grid-template-rows:\s*48px 28px minmax\(140px,1fr\) auto 220px/);
  assert.match(styles, /\.chat-message\.user[\s\S]*justify-self:\s*end/);
  assert.match(styles, /\.chat-message\.assistant[\s\S]*background:\s*transparent/);
  assert.match(styles, /prefers-reduced-motion/);
});

test('settings center exposes all specification categories and functional controls', async () => {
  const [html, script] = await rendererFiles();
  assert.match(html, /id="open-settings"/);
  assert.match(html, /id="settings-dialog"/);
  for (const page of ['general','appearance','account','agent','usage','projects','devices','github','shortcuts','billing','about']) {
    assert.match(html, new RegExp(`data-settings-page="${page}"`));
    assert.match(html, new RegExp(`data-settings-view="${page}"`));
  }
  for (const id of ['save-settings','new-provider','save-provider','test-provider','delete-provider','settings-refresh-runtimes','export-settings']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  for (const method of ['updateSettings','saveProvider','testProvider','deleteProvider','refreshRuntimes','exportSettings']) {
    assert.match(script, new RegExp(`workspace\.${method}`));
  }
});

test('Provider and Runtime selection includes API providers and two executable runtimes', async () => {
  const [html, script,, preload] = await rendererFiles();
  for (const kind of ['openai','anthropic','deepseek','openai-compatible','anthropic-compatible']) assert.match(html, new RegExp(`value="${kind}"`));
  for (const id of ['runtime-select','provider-select','model-select','environment-select','permission-select','create-runtime','create-provider','create-model','create-permission']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.doesNotMatch(html, /id="(?:runtime|provider|model|environment|permission)-select"[^>]*disabled/);
  assert.match(script, /\['codex','claude'\]/);
  for (const method of ['createSession','updateSessionOptions','saveProvider','testProvider']) assert.match(preload, new RegExp(method));
});

test('userMessage never becomes a Tool Card and tool colors retain READ/MODIFY/EXECUTE semantics', async () => {
  const [, script, styles] = await rendererFiles();
  const workspace = await readFile(join(root, 'apps', 'desktop', 'electron-main', 'interactive-workspace.ts'), 'utf8');
  assert.match(workspace, /\['agentMessage', 'userMessage'\]\.includes\(itemType\)/);
  assert.match(script, /event\.type === 'user\.message'/);
  assert.match(script, /function classifyToolEvent/);
  assert.match(script, /return 'execute'/);
  assert.match(script, /return 'modify'/);
  assert.match(script, /return 'read'/);
  assert.match(styles, /data-tool-kind="modify"/);
  assert.match(styles, /data-tool-kind="execute"/);
});

test('Renderer uses a fixed preload surface and does not gain Node or HTML injection primitives', async () => {
  const [, script,, preload] = await rendererFiles();
  for (const method of ['snapshot','pickProject','createSession','sendPrompt','interruptTurn','gitStatus','gitDiff','stage','unstage','commit','pollEvents','openWorktree','openUrl']) {
    assert.match(preload, new RegExp(method));
  }
  assert.doesNotMatch(script + preload, /innerHTML|insertAdjacentHTML|eval\(|child_process|node:fs|spawn\(|exec\(/);
});

test('legacy smoke fixtures remain isolated from the interactive product surface', async () => {
  const [html, script] = await rendererFiles();
  for (const id of ['legacy-workspace','alpha-workflow','v1-git-workflow','diagnostic-bundle','runtime-card-template','tool-card-template','permission-card-template']) assert.match(html,new RegExp(`id="${id}"`));
  assert.match(script, /snapshot\?\.mode==='interactive'/);
  assert.match(html, /默认排除源码、完整 Prompt、Raw Payload、凭据和认证存储/);
});
