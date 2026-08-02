import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const desktopRoot = join(repositoryRoot, 'apps', 'desktop');
const requireFromDesktop = createRequire(join(desktopRoot, 'package.json'));
const electronExecutable = requireFromDesktop('electron');

test('a real Renderer crash does not terminate the independently spawned Daemon', async () => {
  const child = spawn(electronExecutable, [desktopRoot], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      TSUKIORI_DESKTOP_SMOKE: '1',
      TSUKIORI_NODE_EXECUTABLE: process.execPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
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
    permissionCards: 1, toolCards: 1, attentionItems: 1,
    permissionCategory: 'shell', enforcementLevel: 'interceptable',
    runtimeCards: 1, runtimeAuthSource: 'chatgpt', runtimeCompatibility: 'supported',
    nativeCapabilityRows: 5,
    nativeCapabilityLevels: ['supported', 'experimental', 'degraded', 'unsupported', 'unknown'],
    nativeCapabilityScopes: [
      'runtime_native', 'runtime_native', 'runtime_native', 'runtime_native', 'runtime_native',
    ],
    sandboxEnforcement: 'runtime_native · enforcement=unknown',
  });
  assert.equal(result.daemonVersion, '0.1.0');
  assert.equal(result.protocolVersion, 1);
});
