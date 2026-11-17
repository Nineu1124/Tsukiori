import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

test('real Electron Main routes invalid storage to recovery before opening a workbench', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tsukiori-startup-smoke-'));
  const statePath = join(directory, 'workspace-state-v3.json');
  const original = '{private damaged fixture';
  writeFileSync(statePath, original);
  const bootstrap = join(directory, 'startup.mjs');
  const main = pathToFileURL(join(process.cwd(), 'apps/desktop/dist/electron-main/main.js')).href;
  writeFileSync(bootstrap, `
    import { app, dialog, BrowserWindow } from 'electron';
    app.setPath('userData', ${JSON.stringify(directory)});
    dialog.showMessageBox = async (options) => {
      process.stdout.write('TSUKIORI_RECOVERY_SMOKE ' + JSON.stringify({
        title: options.title, detail: options.detail, buttons: options.buttons,
        windows: BrowserWindow.getAllWindows().length,
      }) + '\\n');
      return { response: 2, checkboxChecked: false };
    };
    await import(${JSON.stringify(main)});
  `);
  const electron = createRequire(join(process.cwd(), 'apps/desktop/package.json'))('electron');
  const child = spawn(electron, [bootstrap, `--user-data-dir=${directory}`], {
    cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, TSUKIORI_NODE_EXECUTABLE: process.execPath, TSUKIORI_DAEMON_EXIT_POLICY: 'stop' },
  });
  t.after(() => {
    if (child.exitCode === null) child.kill();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (data) => { stdout += data; });
  child.stderr.on('data', (data) => { stderr += data; });
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('startup recovery smoke timed out')); }, 30_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (value) => { clearTimeout(timer); resolve(value); });
  });
  assert.equal(code, 0, stderr.slice(-2000));
  const line = stdout.split(/\r?\n/).find((value) => value.startsWith('TSUKIORI_RECOVERY_SMOKE '));
  assert.ok(line, stderr.slice(-2000));
  const result = JSON.parse(line.slice('TSUKIORI_RECOVERY_SMOKE '.length));
  assert.equal(result.title, '工作区需要恢复');
  assert.deepEqual(result.buttons, ['重试', '打开数据目录', '退出']);
  assert.match(result.detail, /state_migration.*source_invalid/);
  assert.equal(result.windows, 0);
  assert.doesNotMatch(stdout + stderr, /private damaged fixture/);
  assert.equal(readFileSync(statePath, 'utf8'), original);
  assert.equal(existsSync(join(directory, 'workspace.sqlite')), false);
});
