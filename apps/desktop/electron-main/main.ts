import { app, BrowserWindow, dialog, ipcMain, screen, type OpenDialogOptions } from 'electron';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DAEMON_VERSION, HOST_PROTOCOL_VERSION } from '@tsukiori/protocol';
import { FakeRuntimeAdapter } from '@tsukiori/adapter-fake';
import { DaemonSupervisor } from './daemon-supervisor.js';
import { InteractiveWorkspace } from './interactive-workspace.js';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const daemonEntry = app.isPackaged
  ? resolve(app.getAppPath(), 'dist', 'daemon', 'main.js')
  : resolve(currentDirectory, '..', '..', '..', 'daemon', 'dist', 'main.js');
const preloadEntry = resolve(currentDirectory, '..', 'preload', 'index.cjs');
const rendererEntry = resolve(currentDirectory, '..', 'renderer', 'index.html');
const smokeMode = process.env.TSUKIORI_DESKTOP_SMOKE === '1';
const captureDesktopPath = process.env.TSUKIORI_DESKTOP_CAPTURE_PATH;
const daemonExitPolicy = process.env.TSUKIORI_DAEMON_EXIT_POLICY === 'keep' ? 'keep' : 'stop';
const daemonLeaseFile = resolve(app.getPath('userData'), 'daemon-lease-v1.json');

const supervisor = new DaemonSupervisor({
  daemonEntry,
  executable: process.env.TSUKIORI_NODE_EXECUTABLE ?? process.execPath,
  expectedVersion: DAEMON_VERSION,
  leaseFile: daemonLeaseFile,
  exitPolicy: daemonExitPolicy,
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
  diagnostics: { available: true, defaultEstimatedBytes: 8192, sensitiveEstimatedBytes: 12288 },
} : { permissions: [], attention: [], tools: [], runtimes: [], workflow: null, v1Git: null, diagnostics: null };
let quitting = false;
let smokeCommandCount = 0;
let interactiveWorkspace: InteractiveWorkspace | null = null;

function createWindow(): BrowserWindow {
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.min(1440, Math.max(960, workArea.width - 32));
  const height = Math.min(900, Math.max(680, workArea.height - 32));
  const window = new BrowserWindow({
    width,
    height,
    minWidth: 960,
    minHeight: 680,
    show: !smokeMode && !captureDesktopPath,
    backgroundColor: '#f5fbff',
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadEntry,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      devTools: false,
    },
  });
  window.center();

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

ipcMain.handle('workspace:snapshot', () => smokeMode ? workspaceSnapshot : interactiveWorkspace?.snapshot());
ipcMain.handle('workspace:command', async (event, value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, code: 'invalid_command', message: '命令格式无效' };
  }
  const command = value as Record<string, unknown>;
  if (typeof command.type !== 'string' || Buffer.byteLength(JSON.stringify(command)) > 128 * 1024) {
    return { ok: false, code: 'invalid_command', message: '命令过大或缺少类型' };
  }
  if (smokeMode) {
    const allowed = new Set([
      'stage', 'unstage', 'revert', 'commit', 'archive', 'permission', 'answer_input',
      'integrate', 'continue_integration', 'open_external_editor', 'export_diagnostic',
    ]);
    if (!allowed.has(command.type)) return { ok: false, code: 'invalid_command' };
    smokeCommandCount += 1;
    return { ok: true, command: command.type, sequence: smokeCommandCount };
  }
  const workspace = interactiveWorkspace;
  if (!workspace) return { ok: false, code: 'workspace_unavailable', message: 'Workspace 尚未初始化' };
  try {
    if (command.type === 'pick_project') {
      const owner = BrowserWindow.fromWebContents(event.sender);
      const options: OpenDialogOptions = { title: '选择本地 Git 项目', properties: ['openDirectory'] };
      const selection = owner
        ? await dialog.showOpenDialog(owner, options)
        : await dialog.showOpenDialog(options);
      if (selection.canceled || !selection.filePaths[0]) return { ok: true, canceled: true };
      return { ok: true, project: workspace.addProject(selection.filePaths[0]) };
    }
    if (command.type === 'refresh_runtimes') return { ok: true, runtime: workspace.refreshRuntimes() };
    if (command.type === 'poll_events') return {
      ok: true,
      ...workspace.pollEvents(Number(command.afterSequence ?? 0)),
    };
    if (command.type === 'create_session') {
      return { ok: true, session: await workspace.createSession(String(command.projectId ?? '')) };
    }
    if (command.type === 'send_prompt') {
      return { ok: true, ...(await workspace.sendPrompt(
        String(command.sessionId ?? ''), String(command.text ?? ''),
      )) };
    }
    if (command.type === 'interrupt_turn') {
      await workspace.interrupt(String(command.sessionId ?? ''));
      return { ok: true };
    }
    if (command.type === 'permission') {
      const decision = String(command.decision ?? '');
      if (!['allow_once', 'deny_once', 'cancel_turn'].includes(decision)) throw new Error('权限决策无效');
      workspace.decidePermission(
        String(command.requestId ?? ''),
        decision as 'allow_once' | 'deny_once' | 'cancel_turn',
      );
      return { ok: true };
    }
    if (command.type === 'git_status') return { ok: true, git: workspace.gitStatus(String(command.sessionId ?? '')) };
    if (command.type === 'git_diff') return {
      ok: true,
      diff: workspace.gitDiff(
        String(command.sessionId ?? ''),
        typeof command.path === 'string' ? command.path : undefined,
      ),
    };
    if (command.type === 'stage' || command.type === 'unstage') {
      const paths = Array.isArray(command.paths) ? command.paths.map(String) : [];
      if (command.type === 'stage') workspace.stage(String(command.sessionId ?? ''), paths);
      else workspace.unstage(String(command.sessionId ?? ''), paths);
      return { ok: true };
    }
    if (command.type === 'commit') {
      return { ok: true, sha: workspace.commit(String(command.sessionId ?? ''), String(command.subject ?? '')) };
    }
    return { ok: false, code: 'unsupported_command', message: '该操作尚未接入真实 Workspace' };
  } catch (error) {
    return { ok: false, code: 'command_failed', message: error instanceof Error ? error.message : String(error) };
  }
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
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  void Promise.allSettled([
    supervisor.release(),
    interactiveWorkspace?.shutdown() ?? Promise.resolve(),
  ]).finally(() => app.quit());
});

app.whenReady()
  .then(async () => {
    await supervisor.start();
    const window = createWindow();
    if (!smokeMode) {
      interactiveWorkspace = new InteractiveWorkspace({
        userDataPath: app.getPath('userData'),
        emit: () => undefined,
      });
    }
    if (captureDesktopPath) {
      window.webContents.once('did-finish-load', () => {
        setTimeout(() => {
          void (async () => {
            const image = await window.webContents.capturePage();
            writeFileSync(captureDesktopPath, image.toPNG());
            await Promise.allSettled([
              supervisor.release('stop'),
              interactiveWorkspace?.shutdown() ?? Promise.resolve(),
            ]);
            quitting = true;
            app.quit();
          })();
        }, 2_000).unref();
      });
    }
    if (smokeMode) {
      await runSmoke(window);
    }
  })
  .catch(async (error: unknown) => {
    process.stderr.write(String(error) + '\n');
    await supervisor.stop(true).catch(() => undefined);
    app.exit(1);
  });
