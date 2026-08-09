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
const userData = mkdtempSync(join(tmpdir(), 'tsukiori-ui-probe-'));
writeFileSync(join(userData, 'workspace-state-v3.json'), JSON.stringify({
  schemaVersion: 3,
  projects: [{
    id: 'ui-probe-project',
    name: 'UI Probe',
    rootPath: join(userData, 'fixture-project'),
    gitRoot: join(userData, 'fixture-project'),
    branch: 'main',
  }],
  sessions: [],
  teams: [],
  providers: [],
  settings: {},
}), 'utf8');
const port = await availablePort();
const child = spawn(electron, [desktopRoot, `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`], {
  cwd: root,
  env: { ...process.env, TSUKIORI_DAEMON_EXIT_POLICY: 'stop', TSUKIORI_NODE_EXECUTABLE: process.execPath },
  stdio: ['ignore', 'ignore', 'pipe'],
  windowsHide: true,
});

let stderr = '';
child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString('utf8')).slice(-4_000); });

try {
  const target = await waitForTarget(port);
  const cdp = await connect(target.webSocketDebuggerUrl);
  await waitForRenderer(cdp);
  const expression = `(async () => {
    const handle = document.querySelector('#work-panel-resizer');
    if (!handle) throw new Error('resizer_missing');
    handle.setPointerCapture = () => {};
    handle.releasePointerCapture = () => {};
    const before = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--work-panel-width'), 10);
    handle.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 7, button: 0, clientX: 1200, bubbles: true }));
    handle.dispatchEvent(new PointerEvent('pointermove', { pointerId: 7, buttons: 1, clientX: 1120, bubbles: true }));
    handle.dispatchEvent(new PointerEvent('pointerup', { pointerId: 7, button: 0, clientX: 1120, bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 250));
    const after = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--work-panel-width'), 10);
    const snapshot = await window.tsukiori.workspace.snapshot();
    return {
      before,
      after,
      ariaValue: Number(handle.getAttribute('aria-valuenow')),
      persisted: snapshot.settings.workPanelWidth,
      resizingClassCleared: !document.querySelector('.app-shell').classList.contains('resizing-panel'),
    };
  })()`;
  const response = await cdp.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  const result = response.result?.result?.value;
  if (!result || result.after <= result.before || result.after !== result.persisted
    || result.ariaValue !== result.after || result.resizingClassCleared !== true) {
    throw new Error('Resizable panel probe failed: ' + JSON.stringify({ result, response }));
  }
  const dialogExpression = `(async () => {
    const wait = () => new Promise((resolve) => setTimeout(resolve, 60));
    const state = () => ({
      session: document.querySelector('#session-dialog').open,
      team: document.querySelector('#team-dialog').open,
      settings: document.querySelector('#settings-dialog').open,
    });
    const results = {};

    document.querySelector('#new-team').click();
    await wait();
    results.teamOpened = state().team;
    document.querySelector('#team-dialog footer button[data-dialog-dismiss]').click();
    await wait();
    results.teamFooterCancel = !state().team;

    document.querySelector('#new-team').click();
    await wait();
    document.querySelector('#team-dialog header button[data-dialog-dismiss]').click();
    await wait();
    results.teamHeaderClose = !state().team;

    document.querySelector('#new-team').click();
    await wait();
    document.querySelector('#team-dialog').dispatchEvent(new Event('cancel', { cancelable: true }));
    await wait();
    results.teamEscape = !state().team;

    document.querySelector('#new-team').click();
    await wait();
    document.querySelector('#team-dialog').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await wait();
    results.teamBackdrop = !state().team;

    document.querySelector('#new-session').click();
    await wait();
    document.querySelector('#session-dialog footer button[data-dialog-dismiss]').click();
    await wait();
    results.sessionCancel = !state().session;

    document.querySelector('#open-settings').click();
    await wait();
    document.querySelector('#close-settings').click();
    await wait();
    results.settingsClose = !state().settings;
    results.noDialogLeftOpen = Object.values(state()).every((open) => !open);
    return results;
  })()`;
  const dialogResponse = await cdp.call('Runtime.evaluate', { expression: dialogExpression, awaitPromise: true, returnByValue: true });
  const dialogs = dialogResponse.result?.result?.value;
  if (!dialogs || Object.values(dialogs).some((passed) => passed !== true)) {
    throw new Error('Dialog dismissal probe failed: ' + JSON.stringify({ dialogs, dialogResponse }));
  }
  process.stdout.write(JSON.stringify({ schemaVersion: 1, resizableWorkPanel: 'passed', dialogs: 'passed', ...result, dialogResults: dialogs }) + '\n');
  await cdp.call('Runtime.evaluate', { expression: 'window.close()' }).catch(() => undefined);
  cdp.close();
  await waitForExit(child, 15_000);
} finally {
  if (child.exitCode === null) child.kill('SIGTERM');
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

async function waitForTarget(debugPort) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Electron exited before DevTools target: ' + stderr);
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      const targets = await response.json();
      const target = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
      if (target) return target;
    } catch {
      // Electron has not opened its DevTools endpoint yet.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error('Timed out waiting for Electron DevTools target: ' + stderr);
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

async function waitForRenderer(cdp) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const response = await cdp.call('Runtime.evaluate', {
      expression: "Boolean(document.querySelector('#work-panel-resizer') && window.tsukiori?.workspace)",
      returnByValue: true,
    });
    if (response.result?.result?.value === true) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error('Timed out waiting for the interactive Renderer');
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
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
  }
}
