import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const desktopRoot = join(repositoryRoot, 'apps', 'desktop');
const requireFromDesktop = createRequire(join(desktopRoot, 'package.json'));
const electronExecutable = requireFromDesktop('electron');

test('a real Renderer crash does not terminate the independently spawned Daemon', async (t) => {
  const userData = mkdtempSync(join(tmpdir(), 'tsukiori-electron-smoke-'));
  const child = spawn(electronExecutable, [desktopRoot, `--user-data-dir=${userData}`], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      TSUKIORI_DESKTOP_SMOKE: '1',
      TSUKIORI_NODE_EXECUTABLE: process.execPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGKILL');
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });

  const exitCode = await new Promise((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      rejectExit(new Error('Electron smoke timed out; stderr=' + stderr.slice(-2000)));
    }, 30_000);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      resolveExit(code);
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      rejectExit(error);
    });
  });

  assert.equal(exitCode, 0, stderr);
  const marker = stdout
    .split(/\r?\n/)
    .find((line) => line.startsWith('TSUKIORI_DESKTOP_SMOKE_RESULT '));
  assert.ok(marker, 'missing smoke marker; stdout=' + stdout + ' stderr=' + stderr);
  const result = JSON.parse(marker.slice('TSUKIORI_DESKTOP_SMOKE_RESULT '.length));
  assert.equal(result.nodeIntegration, false);
  assert.equal(result.contextIsolation, true);
  assert.equal(result.sandbox, true);
  assert.equal(result.rendererGoneReason, 'crashed');
  assert.equal(result.daemonAliveAfterRendererCrash, true);
  assert.equal(result.fakeRuntimeAliveAfterRendererCrash, true);
  assert.equal(result.fakeRuntimeEventCount, 1);
  assert.deepEqual(result.rendererState, {
    permissionCards: 1, toolCards: 1, attentionItems: 4,
    permissionCategory: 'shell', enforcementLevel: 'interceptable',
    runtimeCards: 2, runtimeAuthSource: 'chatgpt', runtimeCompatibility: 'supported',
    nativeCapabilityRows: 5,
    nativeCapabilityLevels: ['supported', 'experimental', 'degraded', 'unsupported', 'unknown'],
    nativeCapabilityScopes: [
      'runtime_native', 'runtime_native', 'runtime_native', 'runtime_native', 'runtime_native',
    ],
    sandboxEnforcement: 'runtime_native · enforcement=unknown',
    openCodeProvider: 'dpsk', openCodeModel: 'deepseek-v4-flash',
    openCodeDestination: 'api.deepseek.com', modelRequestStarted: 'false',
    modelRequestState: '模型请求尚未启动',
    alphaVisible: true, alphaPhase: 'review', alphaDestination: 'api.deepseek.com',
    workflowSteps: 5, changedFiles: 1,
    alphaActionNames: ['stage', 'commit', 'archive', 'safeCleanup'],
    attentionKinds: ['waiting_permission', 'waiting_input', 'completed', 'failed'],
    prohibitedActionCount: 0,
    v1GitVisible: true,
    v1GitActions: ['unstage', 'revert', 'integrate', 'continue', 'external-editor'],
    recoverySnapshot: 'required',
    integrationLocation: 'temporary-worktree',
  });
  assert.deepEqual(result.alphaCommandResult, { ok: true, command: 'stage', sequence: 1 });
  assert.deepEqual(result.integrationCommandResult, { ok: true, command: 'integrate', sequence: 2 });
  assert.deepEqual(result.editorCommandResult, { ok: true, command: 'open_external_editor', sequence: 3 });
  assert.equal(result.smokeCommandCount, 3);
  assert.equal(result.daemonVersion, '1.0.0-rc.7');
  assert.equal(result.protocolVersion, 1);
});
