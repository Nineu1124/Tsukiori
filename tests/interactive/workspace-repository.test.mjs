import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { historyFixture } from './history-fixture.mjs';
import { InteractiveWorkspace } from '../../apps/desktop/dist/electron-main/interactive-workspace.js';
import { SqliteWorkspaceRepository } from '../../apps/desktop/dist/electron-main/workspace-state-repository.js';
import { readStateJSON } from './workspace-fixture-store.mjs';

test('formal project and session operations use the supplied repository through restart', async (t) => {
  let saved;
  let writes = 0;
  const stateRepository = {
    read: () => saved ? { value: structuredClone(saved) } : {},
    save: (state) => { writes++; saved = structuredClone(state); },
  };
  const f = await historyFixture(t, { stateRepository });
  f.workspace.renameSession(f.session.id, '保留会话名称');
  f.workspace.pinProject(f.session.projectId, true);
  assert.ok(writes >= 4);
  assert.equal(existsSync(join(f.userDataPath, 'workspace-state-v3.json')), false);
  await f.workspace.shutdown();
  const reopened = f.open().snapshot();
  assert.equal(reopened.sessions[0].name, '保留会话名称');
  assert.equal(reopened.sessions[0].threadId, f.session.threadId);
  assert.equal(reopened.projects[0].pinned, true);
  assert.equal(saved.sessions[0].projectId, saved.projects[0].id);
});

test('a repository read failure cannot initialize or save an empty workspace', (t) => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'tsukiori-repository-failure-'));
  t.after(() => rmSync(userDataPath, { recursive: true, force: true }));
  let writes = 0;
  assert.throws(() => new InteractiveWorkspace({ userDataPath, emit() {}, stateRepository: {
    read() { throw new Error('fixture read failure'); }, save() { writes++; },
  } }), /fixture read failure/);
  assert.equal(writes, 0);
  assert.equal(existsSync(join(userDataPath, 'workspace-state-v3.json')), false);
});

test('the default formal workspace persists projects and sessions only in SQLite', async (t) => {
  const f = await historyFixture(t);
  f.workspace.renameSession(f.session.id, 'SQLite 中的会话');
  f.workspace.pinProject(f.session.projectId, true);
  assert.equal(existsSync(join(f.userDataPath, 'workspace.sqlite')), true);
  assert.equal(existsSync(join(f.userDataPath, 'workspace-state-v3.json')), false);
  assert.equal(existsSync(join(f.userDataPath, 'workspace-state-v3.json.bak')), false);
  const persisted = JSON.parse(readStateJSON(f.userDataPath));
  assert.equal(persisted.sessions[0].name, 'SQLite 中的会话');
  assert.equal(persisted.sessions[0].projectId, persisted.projects[0].id);
  await f.workspace.shutdown();
  const snapshot = f.open().snapshot();
  assert.equal(snapshot.sessions[0].id, f.session.id);
  assert.equal(snapshot.sessions[0].name, 'SQLite 中的会话');
  assert.equal(snapshot.projects[0].pinned, true);
});

function storageFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'tsukiori-default-storage-'));
  const repositories = [];
  t.after(() => {
    for (const repository of repositories) repository.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  });
  return { directory, open() { const repository = new SqliteWorkspaceRepository(directory); repositories.push(repository); return repository; } };
}

test('legacy state is backed up once, retained byte-for-byte and never reread after activation', (t) => {
  const f = storageFixture(t);
  const path = join(f.directory, 'workspace-state-v3.json');
  const original = JSON.stringify({ schemaVersion: 3, projects: [], sessions: [], providers: [], teams: [], settings: { density: 'compact' } }, null, 2);
  writeFileSync(path, original);
  const first = f.open();
  assert.equal(first.read().value.settings.density, 'compact');
  assert.equal(readFileSync(path, 'utf8'), original);
  const state = first.read().value;
  state.settings.density = 'comfortable';
  first.save(state);
  const backups = readdirSync(join(f.directory, 'workspace-migration-backups'));
  assert.equal(backups.length, 1);
  first.close();
  writeFileSync(path, 'obsolete corrupt legacy file');
  const restarted = f.open();
  assert.equal(restarted.read().value.settings.density, 'comfortable');
  assert.equal(restarted.store.listMigrationRuns().length, 1);
  assert.deepEqual(readdirSync(join(f.directory, 'workspace-migration-backups')), backups);
  assert.equal(readFileSync(path, 'utf8'), 'obsolete corrupt legacy file');
});

test('invalid legacy input is preserved without initializing a new database', (t) => {
  const f = storageFixture(t);
  const path = join(f.directory, 'workspace-state-v3.json');
  writeFileSync(path, '{broken');
  assert.throws(() => f.open(), /损坏|无法加载/);
  assert.equal(readFileSync(path, 'utf8'), '{broken');
  assert.equal(existsSync(join(f.directory, 'workspace.sqlite')), false);
});

test('a corrupt SQLite database cannot fall back to otherwise valid legacy state', (t) => {
  const f = storageFixture(t);
  const path = join(f.directory, 'workspace.sqlite');
  writeFileSync(path, 'corrupt database fixture');
  writeFileSync(join(f.directory, 'workspace-state-v3.json'), JSON.stringify({ schemaVersion: 3, projects: [], sessions: [], providers: [], teams: [], settings: {} }));
  assert.throws(() => f.open(), /存储失败/);
  assert.equal(readFileSync(path, 'utf8'), 'corrupt database fixture');
});
