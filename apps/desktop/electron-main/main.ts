import { app, BrowserWindow, ipcMain } from 'electron';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DAEMON_VERSION, HOST_PROTOCOL_VERSION } from '@tsukiori/protocol';
import { FakeRuntimeAdapter } from '@tsukiori/adapter-fake';
import { DaemonSupervisor } from './daemon-supervisor.js';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const daemonEntry = resolve(currentDirectory, '..', '..', '..', 'daemon', 'dist', 'main.js');
const preloadEntry = resolve(currentDirectory, '..', 'preload', 'index.cjs');
const rendererEntry = resolve(currentDirectory, '..', 'renderer', 'index.html');
const smokeMode = process.env.TSUKIORI_DESKTOP_SMOKE === '1';

const supervisor = new DaemonSupervisor({
  daemonEntry,
  executable: process.env.TSUKIORI_NODE_EXECUTABLE ?? process.execPath,
  expectedVersion: DAEMON_VERSION,
});

const workspaceSnapshot = smokeMode ? {
  permissions: [{
    id: 'smoke-permission', title: '运行 Git 状态检查', description: '无破坏的结构化命令探测',
    category: 'shell', risk: 'low', scope: 'git status', enforcementLevel: 'interceptable',
  }],
  attention: [
    { id: 'smoke-attention-permission', kind: 'waiting_permission', status: 'open',
      title: '等待权限确认', sourceRef: 'smoke-permission',
      actions: [{ id: 'allow_once', label: '允许一次' }, { id: 'deny_once', label: '拒绝' }] },
    { id: 'smoke-attention-input', kind: 'waiting_input', status: 'open',
      title: '等待用户输入', sourceRef: 'question-smoke',
      actions: [{ id: 'answer_input', label: '提交输入' }] },
    { id: 'smoke-attention-completed', kind: 'completed', status: 'open',
      title: '上一轮已完成', sourceRef: 'turn-complete',
      actions: [{ id: 'review_diff', label: 'Review Diff' }] },
    { id: 'smoke-attention-failed', kind: 'failed', status: 'open',
      title: '失败事项示例', sourceRef: 'turn-failed', actions: [] },
  ],
  tools: [{ id: 'smoke-tool', title: 'Shell', summary: 'git status' }],
  runtimes: [{
    id: 'runtime-codex', runtimeType: 'codex', version: '0.146.0', state: 'ready',
    authenticated: true, authSource: 'chatgpt', requiresOpenaiAuth: true, compatibility: 'supported',
    nativeCapabilities: [
      { id: 'configuration', label: 'Codex 配置', supportLevel: 'supported',
        enforcementLevel: 'unknown', scope: 'runtime_native', summary: 'sandbox=workspace-write' },
      { id: 'mcp', label: 'MCP', supportLevel: 'experimental',
        enforcementLevel: 'unknown', scope: 'runtime_native', summary: 'experimental presentation fixture' },
      { id: 'skills', label: 'Skills', supportLevel: 'degraded',
        enforcementLevel: 'unknown', scope: 'runtime_native', summary: '1 parse error' },
      { id: 'sandbox', label: 'Sandbox', supportLevel: 'unsupported',
        enforcementLevel: 'unknown', scope: 'runtime_native', summary: 'readiness method unavailable' },
      { id: 'authentication', label: '认证来源', supportLevel: 'unknown',
        enforcementLevel: 'unknown', scope: 'runtime_native', summary: 'not verified' },
    ],
  }, {
    id: 'runtime-opencode', runtimeType: 'opencode', version: '1.18.4', state: 'ready',
    authenticated: true, authSource: 'apikey', compatibility: 'supported',
    providers: [{
      id: 'dpsk', name: 'DeepSeek', connected: true, destinationHost: 'api.deepseek.com',
      models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }],
    }],
    nativeCapabilities: [],
  }],
  workflow: {
    phase: 'review',
    project: { name: 'Local workspace', environment: 'Windows Native' },
    binding: { type: 'isolated-worktree', branch: 'agent/opencode/alpha' },
    runtime: { type: 'opencode', version: '1.18.4', provider: 'DeepSeek', model: 'deepseek-v4-flash',
      destinationHost: 'api.deepseek.com' },
    files: [{ path: 'alpha-runtime.txt', state: 'untracked', selected: true }],
    diff: { scope: 'working', content: '+ sanitized fake Runtime change' },
    actions: { stage: true, commit: true, archive: true, safeCleanup: false },
  },
  v1Git: {
    available: true,
    sourceSessionId: 'smoke-session',
    targetRef: 'main',
    strategy: 'merge',
    recoverySnapshot: 'required',
    integrationLocation: 'temporary-worktree',
    promotion: 'explicit-required',
    conflictOperationId: 'operation:smoke-conflict',
  },
} : { permissions: [], attention: [], tools: [], runtimes: [], workflow: null, v1Git: null };
let quitting = false;
let smokeCommandCount = 0;

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1100,
    height: 720,
    show: !smokeMode,
    backgroundColor: '#10131a',
    webPreferences: {
      preload: preloadEntry,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      devTools: false,
    },
  });

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) {
      event.preventDefault();
    }
  });
  void window.loadFile(rendererEntry);
  return window;
}

async function runSmoke(window: BrowserWindow): Promise<void> {
  const fakeRuntime = new FakeRuntimeAdapter();
  const fakeSession = fakeRuntime.createSession();
  fakeRuntime.runScript(fakeSession, [{ kind: 'event', nativeType: 'message.started', payload: { sanitized: true } }]);
  await new Promise<void>((resolveLoad, rejectLoad) => {
    window.webContents.once('did-finish-load', () => resolveLoad());
    window.webContents.once('did-fail-load', (_event, code, description) => {
      rejectLoad(new Error('Renderer failed to load: ' + code + ' ' + description));
    });
  });

  const rendererState = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    let attempts = 0;
    const timer = setInterval(() => {
      const permissionCards = document.querySelectorAll('.permission-card').length;
      if (permissionCards > 0) {
        clearInterval(timer);
        resolve({
          permissionCards,
          toolCards: document.querySelectorAll('.tool-card').length,
          attentionItems: document.querySelectorAll('.attention-item').length,
          permissionCategory: document.querySelector('[data-field="category"]')?.textContent,
          enforcementLevel: document.querySelector('.permission-card [data-field="enforcement"]')?.textContent,
          runtimeCards: document.querySelectorAll('.runtime-card').length,
          runtimeAuthSource: document.querySelector('.runtime-card [data-field="authSource"]')?.textContent,
          runtimeCompatibility: document.querySelector('.runtime-card [data-field="compatibility"]')?.textContent,
          nativeCapabilityRows: document.querySelectorAll('.native-capability').length,
          nativeCapabilityLevels: [...document.querySelectorAll('.native-capability [data-field="supportLevel"]')]
            .map((element) => element.textContent),
          nativeCapabilityScopes: [...document.querySelectorAll('.native-capability [data-field="enforcement"]')]
            .map((element) => element.textContent?.split(' · ')[0]),
          sandboxEnforcement: document.querySelector(
            '.native-capability[data-capability="sandbox"] [data-field="enforcement"]',
          )?.textContent,
          openCodeProvider: document.querySelector(
            '.provider-panel[data-provider-id="dpsk"] [data-field="providerSelect"]',
          )?.value,
          openCodeModel: document.querySelector(
            '.provider-panel[data-provider-id="dpsk"] [data-field="modelSelect"]',
          )?.value,
          openCodeDestination: document.querySelector(
            '.provider-panel[data-provider-id="dpsk"] [data-field="destinationHost"]',
          )?.textContent,
          modelRequestStarted: document.querySelector(
            '.provider-panel[data-provider-id="dpsk"]',
          )?.dataset.modelRequestStarted,
          modelRequestState: document.querySelector(
            '.provider-panel[data-provider-id="dpsk"] [data-field="modelRequestState"]',
          )?.textContent,
          alphaVisible: document.querySelector('#alpha-workflow')?.hidden === false,
          alphaPhase: document.querySelector('#alpha-workflow [data-field="phase"]')?.textContent,
          alphaDestination: document.querySelector('#alpha-workflow [data-field="alphaDestination"]')?.textContent,
          workflowSteps: document.querySelectorAll('#alpha-workflow [data-step]').length,
          changedFiles: document.querySelectorAll('#alpha-workflow [data-field="changedFiles"] li').length,
          alphaActionNames: [...document.querySelectorAll('#alpha-workflow [data-action]')]
            .map((element) => element.dataset.action),
          attentionKinds: [...document.querySelectorAll('.attention-item')]
            .map((element) => [...element.classList].find((name) => name !== 'attention-item')),
          prohibitedActionCount: document.querySelectorAll(
            '[data-action="merge"],[data-runtime="claude"],[data-runtime="acp"],[data-platform]',
          ).length,
          v1GitVisible: document.querySelector('#v1-git-workflow')?.hidden === false,
          v1GitActions: [...document.querySelectorAll('#v1-git-workflow [data-v1-action]')]
            .map((element) => element.dataset.v1Action),
          recoverySnapshot: document.querySelector('#v1-git-workflow [data-field="recoverySnapshot"]')?.textContent,
          integrationLocation: document.querySelector('#v1-git-workflow [data-field="integrationLocation"]')?.textContent,
        });
      } else if (++attempts >= 40) {
        clearInterval(timer);
        reject(new Error('Renderer workspace snapshot did not become visible'));
      }
    }, 50);
  })`, true) as Record<string, unknown>;
  const alphaCommandResult = await window.webContents.executeJavaScript(
    `window.tsukiori.workspace.stage(['alpha-runtime.txt'])`,
    true,
  ) as Record<string, unknown>;
  const integrationCommandResult = await window.webContents.executeJavaScript(
    `window.tsukiori.workspace.integrate('smoke-session', 'main', 'merge')`,
    true,
  ) as Record<string, unknown>;
  const editorCommandResult = await window.webContents.executeJavaScript(
    `window.tsukiori.workspace.openExternalEditor('operation:smoke-conflict')`,
    true,
  ) as Record<string, unknown>;
  const crash = new Promise<Electron.RenderProcessGoneDetails>((resolveCrash) => {
    window.webContents.once('render-process-gone', (_event, details) => resolveCrash(details));
  });
  window.webContents.forcefullyCrashRenderer();
  const details = await crash;
  const status = await supervisor.probe();

  process.stdout.write(
    'TSUKIORI_DESKTOP_SMOKE_RESULT ' +
      JSON.stringify({
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        rendererGoneReason: details.reason,
        daemonAliveAfterRendererCrash: supervisor.snapshot().state === 'running',
        fakeRuntimeAliveAfterRendererCrash: fakeSession.activity === 'running' && fakeSession.health === 'healthy',
        fakeRuntimeEventCount: fakeRuntime.events.length,
        rendererState,
        alphaCommandResult,
        integrationCommandResult,
        editorCommandResult,
        smokeCommandCount,
        daemonVersion: status.daemonVersion,
        protocolVersion: status.protocolVersion,
      }) +
      '\n',
  );

  await supervisor.stop();
  quitting = true;
  app.quit();
}

ipcMain.handle('host:versions', () => ({
  desktop: app.getVersion(),
  daemon: DAEMON_VERSION,
  protocol: HOST_PROTOCOL_VERSION,
}));

ipcMain.handle('workspace:snapshot', () => workspaceSnapshot);
ipcMain.handle('workspace:command', (_event, value: unknown) => {
  if (!smokeMode || !value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, code: 'workflow_unavailable' };
  }
  const command = value as Record<string, unknown>;
  const allowed = new Set([
    'stage', 'unstage', 'revert', 'commit', 'archive', 'permission', 'answer_input',
    'integrate', 'continue_integration', 'open_external_editor',
  ]);
  if (typeof command.type !== 'string' || !allowed.has(command.type)
    || Buffer.byteLength(JSON.stringify(command)) > 8192) {
    return { ok: false, code: 'invalid_command' };
  }
  smokeCommandCount += 1;
  return { ok: true, command: command.type, sequence: smokeCommandCount };
});
ipcMain.handle('daemon:status', async () => {
  const status = await supervisor.probe();
  return {
    state: 'running',
    daemonVersion: status.daemonVersion,
    protocolVersion: status.protocolVersion,
    instanceId: status.instanceId,
  };
});

app.on('before-quit', (event) => {
  if (quitting || supervisor.snapshot().state === 'stopped') {
    return;
  }
  event.preventDefault();
  quitting = true;
  void supervisor.stop().finally(() => app.quit());
});

app.whenReady()
  .then(async () => {
    await supervisor.start();
    const window = createWindow();
    if (smokeMode) {
      await runSmoke(window);
    }
  })
  .catch(async (error: unknown) => {
    process.stderr.write(String(error) + '\n');
    await supervisor.stop(true).catch(() => undefined);
    app.exit(1);
  });
