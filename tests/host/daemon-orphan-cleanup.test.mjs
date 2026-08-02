import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const daemonEntry = join(repositoryRoot, 'apps', 'daemon', 'dist', 'main.js');

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error('Timed out waiting for ' + label);
}

async function startDaemon() {
  const child = spawn(process.execPath, [daemonEntry], {
    env: {
      ...process.env,
      TSUKIORI_IPC_BOOTSTRAP_TOKEN: randomBytes(32).toString('hex'),
    },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString('utf8')).slice(-4096); });
  const ready = await new Promise((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => rejectReady(new Error('daemon.ready timeout: ' + stderr)), 20_000);
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
      try {
        const value = JSON.parse(line);
        if (value.type === 'daemon.ready') {
          clearTimeout(timeout);
          resolveReady(value);
        }
      } catch {}
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      rejectReady(new Error('Daemon exited before ready: ' + code + ' ' + stderr));
    });
  });
  return { child, ready };
}

test('Named Pipe Host exits after an ungraceful Daemon parent termination', async (t) => {
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const { child, ready } = await startDaemon();
    const daemonPid = child.pid;
    const pipeHostPid = ready.pipeHostPid;
    t.after(() => {
      if (daemonPid && alive(daemonPid)) process.kill(daemonPid, 'SIGKILL');
      if (pipeHostPid && alive(pipeHostPid)) process.kill(pipeHostPid, 'SIGKILL');
    });
    assert.ok(Number.isInteger(pipeHostPid) && pipeHostPid > 0);
    assert.equal(alive(pipeHostPid), true);
    child.kill('SIGKILL');
    await waitUntil(() => !alive(daemonPid), 5_000, 'Daemon exit');
    await waitUntil(() => !alive(pipeHostPid), 5_000, 'orphan Pipe Host exit');
    assert.equal(alive(pipeHostPid), false);
  }
});

test('Named Pipe Host exits after Daemon stdin closes', async (t) => {
  const { child, ready } = await startDaemon();
  const pipeHostPid = ready.pipeHostPid;
  t.after(() => {
    if (child.pid && alive(child.pid)) process.kill(child.pid, 'SIGKILL');
    if (pipeHostPid && alive(pipeHostPid)) process.kill(pipeHostPid, 'SIGKILL');
  });
  child.stdin.end();
  await waitUntil(() => !alive(child.pid), 5_000, 'Daemon stdin-close exit');
  await waitUntil(() => !alive(pipeHostPid), 5_000, 'Pipe Host stdin-close exit');
});
