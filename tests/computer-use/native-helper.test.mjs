import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const helper = new URL('../../apps/desktop/dist/windows/computer-use-helper.ps1', import.meta.url);
const helperPath = fileURLToPath(helper);

test('Windows native helper compiles and exposes capability/foreground probes', { skip: process.platform !== 'win32' }, () => {
  assert.equal(existsSync(helper), true);
  const script = readFileSync(helper, 'utf8');
  assert.match(script, /GetForegroundWindow/);
  assert.match(script, /SendInput/);
  assert.match(script, /CopyFromScreen/);
  const output = execFileSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helperPath,
  ], { input: JSON.stringify({ command: 'capability' }), encoding: 'utf8', windowsHide: true });
  const response = JSON.parse(output.trim());
  assert.deepEqual(response, { ok: true, platform: 'windows', helper: 'user32-gdi' });
  const foreground = JSON.parse(execFileSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helperPath,
  ], { input: JSON.stringify({ command: 'foreground' }), encoding: 'utf8', windowsHide: true }).trim());
  assert.equal(foreground.ok, true);
  assert.ok(Number.isInteger(foreground.pid) && foreground.pid > 0);
  assert.match(String(foreground.path), /\.exe$/i);
  assert.ok(Number.isInteger(foreground.screen.width) && foreground.screen.width > 0);
});
