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
  attention: [{ id: 'smoke-attention', kind: 'waiting_permission', status: 'open', title: '等待权限确认' }],
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
  }],
} : { permissions: [], attention: [], tools: [], runtimes: [] };
let quitting = false;

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
        });
      } else if (++attempts >= 40) {
        clearInterval(timer);
        reject(new Error('Renderer workspace snapshot did not become visible'));
      }
    }, 50);
  })`, true) as Record<string, unknown>;
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
