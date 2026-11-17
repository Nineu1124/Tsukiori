import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WorkspaceInstanceLock, WORKSPACE_OWNER_FILE } from '../../apps/desktop/dist/electron-main/workspace-instance-lock.js';
import { InteractiveWorkspace } from '../../apps/desktop/dist/electron-main/interactive-workspace.js';
import { workspaceStartupFailure } from '../../apps/desktop/dist/electron-main/workspace-startup.js';
import { historyFixture } from './history-fixture.mjs';
import { readStateJSON } from './workspace-fixture-store.mjs';

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGKILL');
  await exited;
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'tsukiori-owner-lock-'));
  const first = join(root, 'first');
  const second = join(root, 'second');
  mkdirSync(first); mkdirSync(second);
  const locks = [];
  const children = [];
  t.after(async () => {
    for (const child of children) await stop(child);
    for (const lock of locks) lock.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { root, first, second, children, open(path) {
    const lock = new WorkspaceInstanceLock(path);
    locks.push(lock);
    return lock;
  } };
}

test('only one formal workspace can write a data instance and the rejected host changes no state', async (t) => {
  const f = await historyFixture(t);
  const before = readStateJSON(f.userDataPath);
  assert.throws(() => f.open(), { reason: 'in_use' });
  assert.equal(readStateJSON(f.userDataPath), before);
  f.workspace.renameSession(f.session.id, 'owner remains active');
  const firstShutdown = f.workspace.shutdown();
  assert.equal(firstShutdown, f.workspace.shutdown());
  await firstShutdown;
  const restarted = f.open();
  assert.equal(restarted.snapshot().sessions[0].name, 'owner remains active');
  await f.workspace.shutdown();
  assert.throws(() => f.open(), { reason: 'in_use' });
});

test('Junction aliases share OS ownership while independent data directories remain available', (t) => {
  const f = fixture(t);
  const alias = join(f.root, 'alias');
  symlinkSync(f.first, alias, 'junction');
  f.open(f.first);
  assert.throws(() => f.open(alias), { reason: 'in_use' });
  f.open(f.second);
});

test('OS releases ownership after a real owner process is forcibly terminated', async (t) => {
  const f = fixture(t);
  const module = new URL('../../apps/desktop/dist/electron-main/workspace-instance-lock.js', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { WorkspaceInstanceLock } from ${JSON.stringify(module)};
    const lock = new WorkspaceInstanceLock(process.argv[1]);
    process.stdout.write('LOCK_READY\\n');
    process.stdin.resume();
  `, f.first], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  f.children.push(child);
  await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('ownership child did not become ready')), 10_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.stdout.on('data', (data) => { output += data; if (output.includes('LOCK_READY')) { clearTimeout(timer); resolve(); } });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('ownership child exited before ready')); });
  });
  assert.throws(() => f.open(f.first), { reason: 'in_use' });
  await stop(child);
  const next = f.open(f.first);
  next.close();
  f.open(f.first);
});

test('failed initialization releases its ownership without replacing bad source files', (t) => {
  const f = fixture(t);
  const path = join(f.first, 'workspace-state-v3.json');
  writeFileSync(path, '{private broken fixture');
  assert.throws(() => new InteractiveWorkspace({ userDataPath: f.first, emit() {} }), /迁移失败/);
  assert.equal(readFileSync(path, 'utf8'), '{private broken fixture');
  f.open(f.first).close();
});

test('unrecognized ownership files are preserved and produce a safe recovery classification', (t) => {
  const f = fixture(t);
  const path = join(f.first, WORKSPACE_OWNER_FILE);
  writeFileSync(path, 'private lock contents fixture');
  assert.throws(() => f.open(f.first), (error) => {
    assert.equal(error.reason, 'invalid_lock');
    const failure = workspaceStartupFailure(error);
    assert.equal(failure.stage, 'ownership');
    assert.doesNotMatch(JSON.stringify(failure), /private lock contents/);
    return true;
  });
  assert.equal(readFileSync(path, 'utf8'), 'private lock contents fixture');
});
