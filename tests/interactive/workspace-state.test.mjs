import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const workspaceModule = new URL('../../apps/desktop/dist/electron-main/interactive-workspace.js', import.meta.url);
const { InteractiveWorkspace } = await import(workspaceModule);

function openWorkspace(userDataPath) {
  return new InteractiveWorkspace({
    userDataPath,
    emit: () => {},
    discoverCodex: () => { throw new Error('offline fixture'); },
    discoverClaude: () => { throw new Error('offline fixture'); },
  });
}

function fixture(t) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'tsukiori-state-'));
  const workspaces = [];
  const open = () => {
    const workspace = openWorkspace(directory);
    workspaces.push(workspace);
    return workspace;
  };
  t.after(async () => {
    for (const workspace of workspaces) await workspace.shutdown();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  });
  return { directory, path: join(directory, 'workspace-state-v3.json'), open };
}

function withFaults(t, methods, action) {
  const mocks = Object.entries(methods).map(([name, implementation]) => t.mock.method(fs, name, implementation));
  syncBuiltinESMExports();
  try {
    return action();
  } finally {
    for (const mock of mocks) mock.mock.restore();
    syncBuiltinESMExports();
  }
}

function temporaryFiles(directory) {
  return fs.readdirSync(directory).filter((name) => name.startsWith('workspace-state-v3.json.') && name.endsWith('.tmp'));
}

test('workspace state can be created, replaced and reopened without temporary files', async (t) => {
  const f = fixture(t);
  const workspace = f.open();
  assert.equal(JSON.parse(fs.readFileSync(f.path, 'utf8')).schemaVersion, 3);
  workspace.updateSettings({ density: 'compact', defaultProjectDirectory: 'E:/项目/状态测试' });
  workspace.updateSettings({ reduceMotion: true });
  const saved = JSON.parse(fs.readFileSync(f.path, 'utf8'));
  assert.equal(saved.settings.density, 'compact');
  assert.equal(saved.settings.reduceMotion, true);
  assert.equal(saved.settings.defaultProjectDirectory, 'E:/项目/状态测试');
  assert.deepEqual(temporaryFiles(f.directory), []);
  await workspace.shutdown();
  assert.deepEqual(f.open().snapshot().settings, saved.settings);
});

for (const stage of ['create', 'partial write', 'flush', 'close', 'replace']) {
  test(`workspace preserves the previous state when ${stage} fails`, async (t) => {
    const f = fixture(t);
    const workspace = f.open();
    const original = fs.readFileSync(f.path, 'utf8');
    const error = Object.assign(new Error(`injected ${stage} failure`), { code: stage === 'partial write' ? 'ENOSPC' : 'EIO' });
    const write = fs.writeFileSync;
    const close = fs.closeSync;
    const methods = {
      create: { openSync: () => { throw error; } },
      'partial write': { writeFileSync: (target) => { write(target, '{"incomplete":', 'utf8'); throw error; } },
      flush: { fsyncSync: () => { throw error; } },
      close: { closeSync: (fd) => { close(fd); throw error; } },
      replace: { renameSync: () => { throw error; } },
    };
    withFaults(t, methods[stage], () => {
      assert.throws(() => workspace.updateSettings({ density: 'compact' }), (actual) => actual === error);
    });
    assert.equal(fs.readFileSync(f.path, 'utf8'), original);
    assert.deepEqual(temporaryFiles(f.directory), []);
    await workspace.shutdown();
    assert.deepEqual(f.open().snapshot().settings, JSON.parse(original).settings);
  });
}

test('temporary file cleanup does not hide the original save error', async (t) => {
  const f = fixture(t);
  const workspace = f.open();
  const original = fs.readFileSync(f.path, 'utf8');
  const saveError = Object.assign(new Error('injected replacement failure'), { code: 'EPERM' });
  withFaults(t, {
    renameSync: () => { throw saveError; },
    unlinkSync: () => { throw new Error('injected cleanup failure'); },
  }, () => {
    assert.throws(() => workspace.updateSettings({ density: 'compact' }), (actual) => actual === saveError);
  });
  assert.equal(fs.readFileSync(f.path, 'utf8'), original);
  assert.equal(temporaryFiles(f.directory).length, 1);
  await workspace.shutdown();
  assert.deepEqual(f.open().snapshot().settings, JSON.parse(original).settings);
});

test('a process exit before replacement preserves state and does not block later saves', async (t) => {
  const f = fixture(t);
  const workspace = f.open();
  workspace.updateSettings({ density: 'compact' });
  await workspace.shutdown();
  const original = fs.readFileSync(f.path, 'utf8');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const { InteractiveWorkspace } = await import(${JSON.stringify(workspaceModule.href)});
    const openWorkspace = ${openWorkspace.toString()};
    const workspace = openWorkspace(process.argv[1]);
    fs.renameSync = () => process.exit(86);
    syncBuiltinESMExports();
    workspace.updateSettings({ density: 'comfortable' });
    await workspace.shutdown();
  `, f.directory], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
  assert.ifError(child.error);
  assert.equal(child.status, 86, child.stderr);
  assert.equal(fs.readFileSync(f.path, 'utf8'), original);
  const leftovers = temporaryFiles(f.directory);
  assert.equal(leftovers.length, 1);
  const pending = fs.readFileSync(join(f.directory, leftovers[0]), 'utf8');
  assert.equal(JSON.parse(pending).settings.density, 'comfortable');
  const restored = f.open();
  assert.equal(restored.snapshot().settings.density, 'compact');
  restored.updateSettings({ reduceMotion: true });
  assert.equal(JSON.parse(fs.readFileSync(f.path, 'utf8')).settings.reduceMotion, true);
  assert.equal(fs.readFileSync(join(f.directory, leftovers[0]), 'utf8'), pending);
});
