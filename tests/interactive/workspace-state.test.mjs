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

const minimalState = () => ({ schemaVersion: 3, projects: [], sessions: [], settings: {}, providers: [], teams: [] });

for (const [label, content, reason] of [
  ['truncated JSON', '{"privateMarker":', 'invalid'],
  ['null', 'null', 'invalid'],
  ['array root', '[]', 'invalid'],
  ['unsupported version', JSON.stringify({ ...minimalState(), schemaVersion: 99 }), 'unsupported_version'],
  ['missing collection', JSON.stringify({ ...minimalState(), projects: undefined }), 'invalid'],
  ['invalid record', JSON.stringify({ ...minimalState(), sessions: [null] }), 'invalid'],
  ['orphan session', JSON.stringify({ ...minimalState(), sessions: [{ id: 's1', projectId: 'missing', name: 'session', branch: 'main', worktreePath: 'unused' }] }), 'invalid'],
  ['invalid settings', JSON.stringify({ ...minimalState(), settings: [] }), 'invalid'],
]) {
  test(`workspace refuses ${label} without overwriting the source`, (t) => {
    const f = fixture(t);
    fs.writeFileSync(f.path, content);
    assert.throws(() => f.open(), (error) => {
      assert.equal(error.name, 'WorkspaceStateError');
      assert.equal(error.reason, reason);
      assert.match(error.message, /原文件已保留/);
      assert.doesNotMatch(error.message, /privateMarker/);
      return true;
    });
    assert.equal(fs.readFileSync(f.path, 'utf8'), content);
  });
}

test('an unreadable current state cannot fall back to an empty or older workspace', (t) => {
  const f = fixture(t);
  const saved = JSON.stringify(minimalState());
  fs.writeFileSync(f.path, saved);
  fs.writeFileSync(join(f.directory, 'workspace-state-v2.json'), JSON.stringify({ ...minimalState(), schemaVersion: 2 }));
  const read = fs.readFileSync;
  withFaults(t, { readFileSync: (path, ...args) => {
    if (path === f.path) throw Object.assign(new Error('private filesystem details'), { code: 'EACCES' });
    return read(path, ...args);
  } }, () => assert.throws(() => f.open(), { name: 'WorkspaceStateError', reason: 'unreadable' }));
  assert.equal(fs.readFileSync(f.path, 'utf8'), saved);
});

test('a corrupt current state is not silently replaced by a legacy state', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.path, '{broken');
  fs.writeFileSync(join(f.directory, 'workspace-state-v2.json'), JSON.stringify({ ...minimalState(), schemaVersion: 2 }));
  assert.throws(() => f.open(), { reason: 'invalid' });
  assert.equal(fs.readFileSync(f.path, 'utf8'), '{broken');
});

for (const version of [1, 2]) {
  test(`workspace still migrates valid version ${version} data`, (t) => {
    const f = fixture(t);
    const legacy = { schemaVersion: version, projects: [], sessions: [], ...(version === 2 ? { settings: { density: 'compact' }, providers: [] } : {}) };
    const legacyPath = join(f.directory, `workspace-state-v${version}.json`);
    const content = JSON.stringify(legacy);
    fs.writeFileSync(legacyPath, content);
    const workspace = f.open();
    assert.equal(workspace.snapshot().settings.density, version === 2 ? 'compact' : 'comfortable');
    assert.equal(JSON.parse(fs.readFileSync(f.path, 'utf8')).schemaVersion, 3);
    assert.equal(fs.readFileSync(legacyPath, 'utf8'), content);
  });
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
    const rename = fs.renameSync;
    fs.renameSync = (source, destination) => {
      if (destination.endsWith('workspace-state-v3.json')) process.exit(86);
      return rename(source, destination);
    };
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

test('each save keeps the previous valid state as its backup', (t) => {
  const f = fixture(t);
  const workspace = f.open();
  const initial = fs.readFileSync(f.path, 'utf8');
  assert.equal(fs.readFileSync(`${f.path}.bak`, 'utf8'), initial);
  workspace.updateSettings({ density: 'compact' });
  assert.equal(fs.readFileSync(`${f.path}.bak`, 'utf8'), initial);
  const latest = fs.readFileSync(f.path, 'utf8');
  workspace.updateSettings({ reduceMotion: true });
  assert.equal(fs.readFileSync(`${f.path}.bak`, 'utf8'), latest);
});

test('recovery keeps corrupt bytes and restores consistent project, session and team references', (t) => {
  const f = fixture(t);
  const state = {
    ...minimalState(), settings: { density: 'compact' },
    projects: [{ id: 'project:backup', name: 'backup', rootPath: f.directory, gitRoot: f.directory }],
    sessions: [{ id: 'session:backup', projectId: 'project:backup', name: 'saved session', branch: 'main', worktreePath: f.directory }],
    teams: [{ id: 'team:backup', projectId: 'project:backup', memberSessionIds: ['session:backup'] }],
  };
  fs.writeFileSync(f.path, '{truncated-state');
  fs.writeFileSync(`${f.path}.bak`, JSON.stringify(state));
  const snapshot = f.open().snapshot();
  assert.equal(snapshot.settings.density, 'compact');
  assert.equal(snapshot.sessions[0].projectId, snapshot.projects[0].id);
  assert.equal(snapshot.teams[0].memberSessionIds[0], snapshot.sessions[0].id);
  assert.equal(snapshot.stateRecovery.backupFile, 'workspace-state-v3.json.bak');
  assert.equal(fs.readFileSync(join(f.directory, snapshot.stateRecovery.preservedFile), 'utf8'), '{truncated-state');
  assert.equal(JSON.parse(fs.readFileSync(f.path, 'utf8')).sessions[0].id, 'session:backup');
});

test('a missing primary state is recovered from the backup', (t) => {
  const f = fixture(t);
  fs.writeFileSync(`${f.path}.bak`, JSON.stringify({ ...minimalState(), settings: { reduceMotion: true } }));
  const snapshot = f.open().snapshot();
  assert.equal(snapshot.settings.reduceMotion, true);
  assert.equal(snapshot.stateRecovery.preservedFile, undefined);
  assert.equal(fs.existsSync(f.path), true);
});

for (const [label, backup] of [
  ['truncated', '{bad-backup'],
  ['orphaned', JSON.stringify({ ...minimalState(), sessions: [{ id: 's1', projectId: 'missing' }] })],
  ['incompatible', JSON.stringify({ ...minimalState(), schemaVersion: 99 })],
]) {
  test(`a ${label} backup is refused without modifying either file`, (t) => {
    const f = fixture(t);
    fs.writeFileSync(f.path, '{bad-primary');
    fs.writeFileSync(`${f.path}.bak`, backup);
    assert.throws(() => f.open(), { name: 'WorkspaceStateError' });
    assert.equal(fs.readFileSync(f.path, 'utf8'), '{bad-primary');
    assert.equal(fs.readFileSync(`${f.path}.bak`, 'utf8'), backup);
    fs.unlinkSync(f.path);
    assert.throws(() => f.open(), { name: 'WorkspaceStateError' });
    assert.equal(fs.existsSync(f.path), false);
  });
}

test('backup replacement failure leaves the current state and old backup intact', (t) => {
  const f = fixture(t);
  const workspace = f.open();
  const original = fs.readFileSync(f.path, 'utf8');
  const backup = fs.readFileSync(`${f.path}.bak`, 'utf8');
  const rename = fs.renameSync;
  const error = Object.assign(new Error('backup replacement denied'), { code: 'EPERM' });
  withFaults(t, { renameSync: (source, destination) => {
    if (destination === `${f.path}.bak`) throw error;
    return rename(source, destination);
  } }, () => assert.throws(() => workspace.updateSettings({ density: 'compact' }), (actual) => actual === error));
  assert.equal(fs.readFileSync(f.path, 'utf8'), original);
  assert.equal(fs.readFileSync(`${f.path}.bak`, 'utf8'), backup);
});

test('recovery must preserve the corrupt file before replacing it', (t) => {
  const f = fixture(t);
  const backup = JSON.stringify(minimalState());
  fs.writeFileSync(f.path, '{original-corruption');
  fs.writeFileSync(`${f.path}.bak`, backup);
  const error = Object.assign(new Error('cannot preserve damaged file'), { code: 'ENOSPC' });
  withFaults(t, { copyFileSync: () => { throw error; } }, () => assert.throws(() => f.open(), (actual) => actual === error));
  assert.equal(fs.readFileSync(f.path, 'utf8'), '{original-corruption');
  assert.equal(fs.readFileSync(`${f.path}.bak`, 'utf8'), backup);
});

test('recovery replacement failure keeps the corrupt file and valid backup', (t) => {
  const f = fixture(t);
  const backup = JSON.stringify(minimalState());
  fs.writeFileSync(f.path, '{original-corruption');
  fs.writeFileSync(`${f.path}.bak`, backup);
  const error = new Error('recovery replacement failure');
  withFaults(t, { renameSync: () => { throw error; } }, () => assert.throws(() => f.open(), (actual) => actual === error));
  assert.equal(fs.readFileSync(f.path, 'utf8'), '{original-corruption');
  assert.equal(fs.readFileSync(`${f.path}.bak`, 'utf8'), backup);
});

test('a newer primary schema is not downgraded to a supported backup', (t) => {
  const f = fixture(t);
  const primary = JSON.stringify({ ...minimalState(), schemaVersion: 99 });
  fs.writeFileSync(f.path, primary);
  fs.writeFileSync(`${f.path}.bak`, JSON.stringify(minimalState()));
  assert.throws(() => f.open(), { reason: 'unsupported_version' });
  assert.equal(fs.readFileSync(f.path, 'utf8'), primary);
});

test('a valid primary repairs an invalid backup without restoring stale data', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.path, JSON.stringify({ ...minimalState(), settings: { density: 'compact' } }));
  fs.writeFileSync(`${f.path}.bak`, '{bad-backup');
  const snapshot = f.open().snapshot();
  assert.equal(snapshot.settings.density, 'compact');
  assert.equal(snapshot.stateRecovery, undefined);
  assert.equal(JSON.parse(fs.readFileSync(`${f.path}.bak`, 'utf8')).settings.density, 'compact');
});

test('a running workspace cannot overwrite its good backup with a corrupt primary', (t) => {
  const f = fixture(t);
  const workspace = f.open();
  const backup = fs.readFileSync(`${f.path}.bak`, 'utf8');
  fs.writeFileSync(f.path, '{corrupted-after-startup');
  assert.throws(() => workspace.updateSettings({ density: 'compact' }), { reason: 'invalid' });
  assert.equal(fs.readFileSync(f.path, 'utf8'), '{corrupted-after-startup');
  assert.equal(fs.readFileSync(`${f.path}.bak`, 'utf8'), backup);
});
