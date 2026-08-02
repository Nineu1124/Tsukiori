import { app, BrowserWindow, ipcMain } from 'electron';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DAEMON_VERSION, HOST_PROTOCOL_VERSION } from '@tsukiori/protocol';
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
  await new Promise<void>((resolveLoad, rejectLoad) => {
    window.webContents.once('did-finish-load', () => resolveLoad());
    window.webContents.once('did-fail-load', (_event, code, description) => {
      rejectLoad(new Error('Renderer failed to load: ' + code + ' ' + description));
    });
  });

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
