import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktopRoot = join(root, 'apps', 'desktop');
const electron = createRequire(join(desktopRoot, 'package.json'))('electron');
const userData = mkdtempSync(join(tmpdir(), 'tsukiori-window-lifecycle-'));
writeFileSync(join(userData, 'workspace-state-v3.json'), JSON.stringify({
  schemaVersion: 3,
  projects: [], sessions: [], teams: [], providers: [],
  settings: { startMinimized: true },
}), 'utf8');

const port = await availablePort();
const commonArgs = [desktopRoot, `--user-data-dir=${userData}`];
const environment = {
  ...process.env,
  TSUKIORI_DAEMON_EXIT_POLICY: 'stop',
  TSUKIORI_NODE_EXECUTABLE: process.execPath,
};
const first = spawn(electron, [...commonArgs, `--remote-debugging-port=${port}`], {
  cwd: root, env: environment, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
});
let firstError = '';
first.stderr.on('data', (chunk) => { firstError = (firstError + chunk.toString('utf8')).slice(-4_000); });
let second;
let pageCdp;

try {
  const target = await waitForTarget(port, first, () => firstError);
  pageCdp = await connect(target.webSocketDebuggerUrl);
  await waitForRenderer(pageCdp);
  const initial = await waitForWindowState(pageCdp, (state) => state.minimized === true);

  second = spawn(electron, commonArgs, {
    cwd: root, env: environment, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
  });
  let secondError = '';
  second.stderr.on('data', (chunk) => { secondError = (secondError + chunk.toString('utf8')).slice(-4_000); });
  await waitForExit(second, 15_000);
  if (second.exitCode !== 0) throw new Error('Second instance failed: ' + secondError);
  const restored = await waitForWindowState(pageCdp, (state) => state.minimized === false && state.visible === true);
  if (first.exitCode !== null) throw new Error('The original instance exited after the second launch: ' + firstError);

  process.stdout.write(JSON.stringify({
    schemaVersion: 1,
    initialWindowState: initial.minimized ? 'minimized' : 'unexpected',
    secondInstanceExitCode: second.exitCode,
    restoredWindowState: restored.maximized ? 'maximized' : 'normal',
    originalInstanceAlive: true,
    status: 'passed',
  }) + '\n');
  await pageCdp.call('Runtime.evaluate', { expression: 'window.close()' }).catch(() => undefined);
  pageCdp.close();
  pageCdp = undefined;
  await waitForExit(first, 15_000);
} finally {
  pageCdp?.close();
  if (second?.exitCode === null) second.kill('SIGTERM');
  if (first.exitCode === null) first.kill('SIGTERM');
  await removeTemporaryDirectory(userData);
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  const value = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolveClose) => server.close(resolveClose));
  return value;
}

async function waitForTarget(debugPort, process, errorText) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error('Electron exited before DevTools target: ' + errorText());
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      const targets = await response.json();
      const target = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
      if (target) return target;
    } catch {
      // Electron has not opened its DevTools endpoint yet.
    }
    await delay(100);
  }
  throw new Error('Timed out waiting for Electron DevTools target: ' + errorText());
}

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener('open', resolveOpen, { once: true });
    socket.addEventListener('error', rejectOpen, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id || !pending.has(message.id)) return;
    const { resolveCall, rejectCall } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) rejectCall(new Error(message.error.message));
    else resolveCall(message);
  });
  return {
    call(method, params = {}) {
      const id = ++sequence;
      return new Promise((resolveCall, rejectCall) => {
        pending.set(id, { resolveCall, rejectCall });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { socket.close(); },
  };
}

async function waitForRenderer(connection) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const response = await connection.call('Runtime.evaluate', {
      expression: "Boolean(document.querySelector('#open-settings') && window.tsukiori?.workspace)",
      returnByValue: true,
    });
    if (response.result?.result?.value === true) return;
    await delay(100);
  }
  throw new Error('Timed out waiting for the interactive Renderer');
}

async function waitForWindowState(connection, predicate) {
  const deadline = Date.now() + 10_000;
  let latest = { exists: false, visible: false, minimized: false, maximized: false };
  while (Date.now() < deadline) {
    const response = await connection.call('Runtime.evaluate', {
      expression: 'window.tsukiori.windowState()', awaitPromise: true, returnByValue: true,
    });
    latest = response.result?.result?.value ?? latest;
    if (predicate(latest)) return latest;
    await delay(100);
  }
  throw new Error('Window state did not reach the expected value; latest=' + JSON.stringify(latest));
}

async function waitForExit(process, timeoutMs) {
  if (process.exitCode !== null) return;
  await new Promise((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => rejectExit(new Error('Electron did not exit cleanly')), timeoutMs);
    process.once('exit', () => { clearTimeout(timeout); resolveExit(); });
  });
}

async function removeTemporaryDirectory(path) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
      return;
    } catch (error) {
      if (attempt === 19) throw error;
      await delay(250);
    }
  }
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
