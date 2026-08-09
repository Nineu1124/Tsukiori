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
  for (const label of ['侧边对话','文件','全部变更','浏览器','Computer Use']) assert.match(html, new RegExp(label));
  for (const token of ['#f5fbff','#258fe8','#4bb9ef','#20364b','#526b80','#45c995','#f3c94f','#ef6b7c','#8e7bef']) {
    assert.ok(styles.toLowerCase().includes(token));
  }
  assert.match(styles, /--titlebar-height:\s*40px/);
  assert.match(styles, /--rail-width:\s*300px/);
  assert.match(styles, /--work-panel-width:\s*360px/);
  assert.match(styles, /--terminal-height:\s*220px/);
  assert.match(styles, /grid-template:[^;]*var\(--titlebar-height\)[^;]*var\(--rail-width\) minmax\(620px,1fr\) var\(--work-panel-width\)/);
  assert.match(styles, /grid-template-rows:\s*48px 28px minmax\(140px,1fr\) auto auto var\(--terminal-height\)/);
  assert.match(styles, /\.chat-message\.user[\s\S]*justify-self:\s*end/);
  assert.match(styles, /\.chat-message\.assistant[\s\S]*background:\s*transparent/);
  assert.match(styles, /\.message-body\s*\{[^}]*font-size:\s*13px/);
  assert.match(styles, /\.composer textarea\s*\{[^}]*font-size:\s*13px/);
  assert.match(styles, /\.terminal-panel pre[^}]*font-size:\s*12px/);
  assert.match(styles, /prefers-reduced-motion/);
});

test('settings center exposes all specification categories and functional controls', async () => {
  const [html, script] = await rendererFiles();
  assert.match(html, /id="open-settings"/);
  assert.match(html, /id="settings-dialog"/);
  for (const page of ['general','appearance','account','agent','terminal','mcp','agents','skills','memory','scheduled','usage','trace','diagnostics','projects','devices','github','shortcuts','billing','about']) {
    assert.match(html, new RegExp(`data-settings-page="${page}"`));
    assert.match(html, new RegExp(`data-settings-view="${page}"`));
  }
  for (const id of ['save-settings','new-provider','save-provider','test-provider','fetch-provider-models','delete-provider','settings-refresh-runtimes','new-mcp','save-mcp','delete-provider','refresh-mcp','import-skill','refresh-skills','load-memory','save-memory','refresh-agent-activity','new-scheduled-task','save-scheduled-task','run-doctor','export-diagnostic-settings','export-settings','pick-cc-haha-source','scan-cc-haha-import','run-cc-haha-import']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  for (const method of ['updateSettings','saveProvider','testProvider','listProviderModels','listMcp','saveMcp','deleteMcp','listSkills','skillDetail','pickSkillSource','installSkill','uninstallSkill','listMemory','readMemory','saveMemory','activity','stopBackgroundTask','listScheduledTasks','saveScheduledTask','setScheduledTaskEnabled','deleteScheduledTask','runScheduledTask','diagnosticSummary','exportDiagnostic','exportSettings','pickCcHahaSource','scanCcHahaImport','importCcHaha']) {
    assert.match(script, new RegExp(`workspace\.${method}`));
  }
});

test('dialogs provide consistent cancel, close, Escape, and backdrop dismissal', async () => {
  const [html, script] = await rendererFiles();
  const probe = await readFile(join(root, 'scripts', 'probe-ui-interactions.mjs'), 'utf8');
  for (const id of ['session-dialog','team-dialog','settings-dialog']) {
    assert.match(script, new RegExp(`bindDialogDismissal\\(byId\\('${id}'\\)`));
  }
  assert.equal((html.match(/data-dialog-dismiss/g) ?? []).length, 5);
  assert.doesNotMatch(html, /value="cancel" type="submit"/);
  assert.match(script, /event\.submitter\?\.value==='cancel'/);
  assert.match(script, /addEventListener\('cancel'/);
  assert.match(script, /event\.target === dialog/);
  assert.match(script, /queueMicrotask\(\(\) => invoker\.focus\(\)\)/);
  for (const result of ['teamFooterCancel','teamHeaderClose','teamEscape','teamBackdrop','sessionCancel','settingsClose','noDialogLeftOpen']) {
    assert.match(probe, new RegExp(result));
  }
});

test('Provider and Runtime selection includes API providers and two executable runtimes', async () => {
  const [html, script,, preload] = await rendererFiles();
  for (const kind of ['openai','anthropic','deepseek','openai-compatible','anthropic-compatible']) assert.match(html, new RegExp(`value="${kind}"`));
  assert.match(script, /claude-native/);
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
  assert.match(script, /function thinkingNode/);
  assert.match(script, /function upsertToolEvent/);
  assert.match(script, /state\.toolCards\.get\(id\)/);
  assert.match(script, /assistant\.thinking\.delta/);
  assert.match(styles, /data-tool-kind="modify"/);
  assert.match(styles, /data-tool-kind="execute"/);
  assert.match(styles, /\.thinking-block/);
  assert.match(styles, /data-phase="completed"/);
  assert.match(workspace, /WorkspaceCapabilities/);
  assert.match(workspace, /saveMemory/);
  assert.match(workspace, /installSkill/);
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

test('complete workbench exposes persisted sessions, files, attachments, ConPTY, preview, native tools, and Agent Team', async () => {
  const [html, script, styles, preload] = await rendererFiles();
  for (const id of [
    'history-query','session-rename','session-pin','session-fork','session-archive','attach-files','composer-attachments',
    'terminal-input','file-query','file-preview','browser-preview','team-dialog','new-team',
    'refresh-native-capabilities','native-capability-list','setting-persist-conversation',
    'refresh-checkpoints','checkpoint-label','create-checkpoint','checkpoint-list','checkpoint-status',
  ]) assert.match(html, new RegExp(`id="${id}"`));
  for (const method of [
    'renameSession','pinSession','forkSession','searchSessions','archiveSession','listFiles','readFile','pickAttachments','codexNative',
    'createTeam','startTerminal','terminalInput','stopTerminal','copyText',
    'listCheckpoints','createCheckpoint','previewCheckpoint','rewindCheckpoint','extensionHealth',
  ]) assert.match(preload, new RegExp(method));
  for (const functionName of [
    'renderMarkdownBody','refreshFiles','loadFilePreview','loadCodexNative','createTeam','ensureTerminal',
    'renderCheckpoints','refreshCheckpoints','rewindToCheckpoint',
    'renderCcHahaImport','pickCcHahaSource','scanCcHahaImport','runCcHahaImport',
  ]) assert.match(script, new RegExp(`function ${functionName}`));
  assert.match(styles, /\.terminal-command/);
  assert.match(styles, /#browser-preview/);
  assert.match(styles, /\.team-agent-grid/);
  assert.match(html, /id="browser-preview" sandbox="allow-scripts allow-forms allow-same-origin"/);
  assert.match(html, /frame-src http:\/\/localhost:\* http:\/\/127\.0\.0\.1:\* https:/);
  assert.match(script, /window\.tsukiori\.workspace\.forkSession/);
  assert.match(script, /function scheduleSessionSearch/);
  assert.match(script, /未提交变更不会被复制/);
  assert.match(script, /可能重复执行工具副作用/);
  assert.match(script, /分支 HEAD 不会移动/);
  assert.match(script, /自动创建恢复点/);
  assert.match(script, /Runtime 实际观察/);
  assert.match(script, /Runtime 原生/);
  assert.match(script, /subagents/);
  assert.match(script, /导入历史为只读/);
  assert.match(script, /失败时整批回滚/);
  assert.match(html, /不导入密钥、登录态、工具原始参数或运行中进程/);
  assert.match(html, /未知状态不会伪装成已生效/);
  assert.match(styles, /\.checkpoint-row/);
});

test('Computer Use exposes a locked, one-time-approved Windows action surface', async () => {
  const [html, script, styles, preload] = await rendererFiles();
  for (const id of ['computer-refresh','computer-lock','computer-unlock','computer-screenshot','computer-move','computer-click','computer-type','computer-key-combo','computer-screenshot-image']) assert.match(html, new RegExp(`id="${id}"`));
  for (const method of ['computerUseStatus','computerUseForeground','computerUseAcquire','computerUseRelease','computerUseRequest','computerUseApprove']) assert.match(preload, new RegExp(method));
  for (const functionName of ['refreshComputerUse','lockComputerUse','releaseComputerUse','runComputerAction']) assert.match(script, new RegExp(`function ${functionName}`));
  assert.match(script, /window\.confirm\(`确认执行 Computer Use/);
  assert.match(html, /不是 OS 安全沙箱/);
  assert.match(styles, /\.computer-use-panel/);
});

test('every button receives motion feedback with specialized actions and reduced-motion fallbacks', async () => {
  const [html, script, styles] = await rendererFiles();
  assert.match(styles, /button\s*\{[\s\S]*transition:[\s\S]*transform var\(--motion-fast\)/);
  assert.match(styles, /button:not\(:disabled\):hover\s*\{[\s\S]*translateY\(-1px\)/);
  assert.match(styles, /button:not\(:disabled\):active\s*\{[\s\S]*scale\(\.97\)/);
  assert.match(styles, /button:disabled:hover[\s\S]*transform:\s*none/);
  assert.match(styles, /tsukiori-button-sweep/);
  assert.match(styles, /#interrupt-turn:not\(:disabled\)[\s\S]*tsukiori-interrupt-ready/);
  assert.match(styles, /#terminal-run:not\(:disabled\):hover/);
  assert.match(styles, /#new-team,#panel-new-team,#confirm-create-team/);
  assert.match(styles, /\.settings-dialog\[open\][\s\S]*tsukiori-dialog-in/);
  assert.match(styles, /\.reduce-motion button[\s\S]*animation:\s*none !important/);
  assert.match(styles, /@media \(prefers-reduced-motion:\s*reduce\)/);
  for (const id of ['workspace-settings','project-filter','session-favorite','terminal-tab-shell','terminal-new']) {
    assert.match(html, new RegExp(`id="${id}"`));
    assert.match(script, new RegExp(`byId\\('${id}'\\)\\.addEventListener`));
  }
  assert.match(html, /id="terminal-run" type="submit"/);
  assert.match(script, /byId\('terminal-form'\)\.addEventListener\('submit'/);
});

test('desktop proportions preserve the conversation at compact widths by overlaying the work panel', async () => {
  const [html, script, styles] = await rendererFiles();
  assert.match(html, /id="work-panel-resizer"[^>]*role="separator"[^>]*aria-valuemin="260"[^>]*aria-valuemax="720"/);
  assert.match(script, /function setupWorkPanelResize/);
  assert.match(script, /workPanelWidth:current/);
  assert.match(styles, /\.work-panel-resizer[^}]*cursor:\s*col-resize/);
  assert.match(styles, /@media \(max-width:\s*1179px\)/);
  assert.match(styles, /grid-template-columns:\s*240px minmax\(620px,1fr\)/);
  assert.match(styles, /\.attention-panel\s*\{[\s\S]*position:\s*fixed[\s\S]*width:\s*min\(var\(--work-panel-width\),calc\(100vw - 90px\)\)/);
  assert.match(styles, /\.app-shell\.right-collapsed \.attention-panel[\s\S]*translateX\(105%\)/);
});
