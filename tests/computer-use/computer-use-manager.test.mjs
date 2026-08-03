import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const { ComputerUseManager } = await import(
  new URL('../../apps/desktop/dist/electron-main/computer-use-manager.js', import.meta.url),
);

const pngFixture = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'tsukiori-computer-use-'));
  const helperPath = join(root, 'computer-use-helper.ps1');
  writeFileSync(helperPath, '# fixture helper');
  let now = 1_000;
  let current = { pid: 1234, path: join(root, 'FixtureApp.exe'), startTime: 77, title: 'Fixture Window' };
  const calls = [];
  const manager = new ComputerUseManager({
    helperPath, userDataPath: root, platform: 'win32', now: () => now,
    invokeHelper: async (request) => {
      calls.push(request);
      if (request.command === 'foreground') return { ok: true, ...current, screen: { left: 0, top: 0, width: 1600, height: 900 } };
      if (request.command === 'screenshot') { writeFileSync(request.path, pngFixture); return { ok: true, width: 1, height: 1 }; }
      return { ok: true, action: request.command };
    },
  });
  return { root, manager, calls, setNow(value) { now = value; }, setCurrent(value) { current = value; } };
}

test('Computer Use requires Windows, a session lock, and a one-time approval', async (t) => {
  const f = fixture();
  t.after(() => { f.manager.shutdown(); rmSync(f.root, { recursive: true, force: true }); });
  const initial = await f.manager.status('window-1');
  assert.equal(initial.supportLevel, 'supported');
  assert.equal(initial.enforcementLevel, 'interceptable');
  assert.equal(initial.locked, false);
  assert.equal((await f.manager.foreground()).name, 'FixtureApp.exe');
  assert.throws(() => f.manager.requestAction('window-1', { type: 'screenshot' }), /锁定前台应用/);

  const locked = await f.manager.acquire('window-1', 'session-1');
  assert.equal(locked.locked, true);
  assert.equal(locked.target.name, 'FixtureApp.exe');
  const pending = f.manager.requestAction('window-1', { type: 'screenshot' });
  const result = await f.manager.approveAction('window-1', pending.approvalId);
  assert.equal(result.action, 'screenshot');
  assert.match(result.screenshot.dataUrl, /^data:image\/png;base64,/);
  assert.equal(result.screenshot.width, 1);
  assert.equal(existsSync(join(f.root, 'computer-use', 'screenshots')), false);
  await assert.rejects(() => f.manager.approveAction('window-1', pending.approvalId), /不存在或已过期/);
  assert.equal(f.calls.filter((call) => call.command === 'screenshot').length, 1);
});

test('Computer Use rejects foreground changes, unsafe targets, invalid input, and foreign owners', async (t) => {
  const f = fixture();
  t.after(() => { f.manager.shutdown(); rmSync(f.root, { recursive: true, force: true }); });
  await f.manager.acquire('window-1', 'session-1');
  await assert.rejects(() => f.manager.acquire('window-2', 'session-2'), /另一个窗口锁定/);
  assert.throws(() => f.manager.requestAction('window-1', { type: 'keyboard_type', text: '' }), /为空/);
  assert.throws(() => f.manager.requestAction('window-1', { type: 'key_combo', keys: ['CTRL', 'BAD KEY'] }), /格式无效/);
  const pending = f.manager.requestAction('window-1', { type: 'mouse_click', x: 12, y: 14, button: 'left', clicks: 1 });
  f.setCurrent({ pid: 9999, path: join(f.root, 'Other.exe'), startTime: 78, title: 'Other' });
  await assert.rejects(() => f.manager.approveAction('window-1', pending.approvalId), /前台应用已变化/);
  f.setCurrent({ pid: 1234, path: join(f.root, 'FixtureApp.exe'), startTime: 77, title: 'Fixture Window' });
  assert.throws(() => f.manager.release('window-2'), /锁定者不匹配/);
  f.setNow(1_000 + 5 * 60_000 + 1);
  assert.equal((await f.manager.status('window-1')).locked, false);
});

test('Computer Use does not expose full executable paths to the renderer', async (t) => {
  const f = fixture();
  t.after(() => { f.manager.shutdown(); rmSync(f.root, { recursive: true, force: true }); });
  const status = await f.manager.acquire('window-1', 'session-1');
  const text = JSON.stringify(status);
  assert.doesNotMatch(text, /FixtureApp\.exe.*tsukiori-computer-use/);
  assert.match(text, /FixtureApp\.exe/);
  assert.doesNotMatch(text, /computer-use-helper\.ps1/);
});
