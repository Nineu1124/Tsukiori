import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { WorkspaceSqliteStore, WORKSPACE_SQLITE_VERSION } from '../../apps/desktop/dist/electron-main/workspace-sqlite.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'tsukiori-workspace-db-'));
  const path = join(directory, 'workspace.sqlite');
  const stores = [];
  const open = () => { const store = new WorkspaceSqliteStore(path); stores.push(store); return store; };
  t.after(() => { for (const store of stores) store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, path, open };
}

const state = () => ({
  schemaVersion: 3,
  projects: [{ id: 'p1', name: 'one', rootPath: 'E:/one', gitRoot: 'E:/one' }, { id: 'p2', name: 'two', rootPath: 'E:/two', gitRoot: 'E:/two' }],
  sessions: [{ id: 's1', projectId: 'p1', name: 'first', branch: 'main', worktreePath: 'E:/one/tree', threadId: 'native-one' },
    { id: 's2', projectId: 'p1', name: 'second', branch: 'work', worktreePath: 'E:/one/other' }],
  settings: { density: 'compact' },
  providers: [{ id: 'provider', kind: 'openai', models: ['local-model'], secretRef: 'secretref:fixture-reference' }],
  teams: [{ id: 'team', projectId: 'p1', memberSessionIds: ['s1', 's2'] }],
});
const event = (id = 'e1', sessionId = 's1', text = 'complete message') => JSON.stringify({ id, sessionId, type: 'user.message', createdAt: 1, payload: { text } });

test('formal aggregate and complete events survive updates and reopening', (t) => {
  const f = fixture(t);
  const store = f.open();
  assert.equal(store.readState(), undefined);
  const document = state();
  store.saveState(document);
  store.appendEvent('s1', event());
  const long = event('large', 's1', '完整'.repeat(200_000));
  store.appendEvent('s1', long);
  document.sessions[0].name = 'renamed';
  document.providers[0].models.push('second-model');
  document.projects.reverse();
  document.sessions.reverse();
  store.saveState(document);
  assert.deepEqual(store.readEvents('s1'), [event(), long]);
  store.close();
  const reopened = f.open();
  assert.deepEqual(reopened.readState(), document);
  assert.deepEqual(reopened.readEvents('s1'), [event(), long]);
  const detached = reopened.readState();
  detached.settings.density = 'changed in consumer';
  assert.equal(reopened.readState().settings.density, 'compact');
});

test('removing a session cascades only its events and preserves surviving history', (t) => {
  const f = fixture(t);
  const store = f.open();
  const document = state();
  store.saveState(document);
  store.appendEvent('s1', event());
  store.appendEvent('s2', event('e2', 's2'));
  document.sessions.splice(0, 1);
  document.teams[0].memberSessionIds = ['s2'];
  store.saveState(document);
  assert.throws(() => store.readEvents('s1'), { reason: 'invalid_data' });
  assert.deepEqual(store.readEvents('s2'), [event('e2', 's2')]);
  store.close();
  const raw = new DatabaseSync(f.path);
  try { assert.equal(raw.prepare("SELECT count(*) AS n FROM workspace_events WHERE session_id='s1'").get().n, 0); }
  finally { raw.close(); }
});

test('a failed nested import rolls back state, events and migration marker together', (t) => {
  const f = fixture(t);
  const store = f.open();
  const failure = new Error('injected before commit');
  const marker = { sourceHash: 'a'.repeat(64), importedAt: 1, phase: 'complete', counts: { projects: 2, sessions: 2, events: 1 }, backupName: 'backup-one' };
  assert.throws(() => store.transactions(() => {
    store.saveState(state()); store.appendEvent('s1', event()); store.writeMigrationRun(marker); throw failure;
  }), (error) => error === failure);
  assert.equal(store.readState(), undefined);
  assert.deepEqual(store.listMigrationRuns(), []);
  store.transaction(() => { store.saveState(state()); store.appendEvent('s1', event()); store.writeMigrationRun(marker); });
  store.close();
  const reopened = f.open();
  assert.deepEqual(reopened.readMigrationRun(marker.sourceHash), marker);
  assert.deepEqual(reopened.listMigrationRuns(), [marker]);
  assert.deepEqual(reopened.readEvents('s1'), [event()]);
});

test('failed event replacement keeps previous records; replay is idempotent and conflicting ids fail', (t) => {
  const f = fixture(t);
  const store = f.open();
  store.saveState(state()); store.appendEvent('s1', event()); store.appendEvent('s1', event());
  assert.equal(store.readEvents('s1').length, 1);
  assert.throws(() => store.appendEvent('s1', event('e1', 's1', 'different')), { reason: 'invalid_data' });
  assert.throws(() => store.replaceEvents('s1', [event('good'), event('bad', 's2')]), { reason: 'invalid_data' });
  assert.throws(() => store.replaceEvents('s1', [event(), event()]), { reason: 'invalid_data' });
  assert.deepEqual(store.readEvents('s1'), [event()]);
  store.replaceEvents('s1', [event('new-first'), event('new-second')]);
  assert.deepEqual(store.readEvents('s1'), [event('new-first'), event('new-second')]);
  store.removeEvents('s1'); assert.deepEqual(store.readEvents('s1'), []);
});

test('duplicate keys, cross-project memberships and orphan records cannot replace a valid graph', (t) => {
  const f = fixture(t);
  const store = f.open();
  store.saveState(state());
  for (const mutate of [
    (value) => value.projects.push(value.projects[0]),
    (value) => { value.sessions[0].projectId = 'missing'; },
    (value) => { value.teams[0].projectId = 'p2'; },
    (value) => value.teams[0].memberSessionIds.push('s1'),
  ]) {
    const changed = state(); mutate(changed);
    assert.throws(() => store.saveState(changed), { reason: 'invalid_data' });
    assert.deepEqual(store.readState(), state());
  }
});

test('SQL itself enforces references, identity payloads, ordering and JSON shape', (t) => {
  const f = fixture(t);
  const store = f.open(); store.saveState(state()); store.close();
  const raw = new DatabaseSync(f.path);
  raw.exec('PRAGMA foreign_keys=ON');
  try {
    assert.throws(() => raw.prepare('INSERT INTO workspace_sessions(id,project_id,payload) VALUES (?,?,?)').run('bad', 'missing', JSON.stringify({ id: 'bad', projectId: 'missing' })));
    assert.throws(() => raw.prepare('INSERT INTO workspace_projects(id,payload) VALUES (?,?)').run('other', JSON.stringify({ id: 'mismatch' })));
    assert.throws(() => raw.prepare('INSERT INTO workspace_projects(id,payload) VALUES (?,?)').run('missing-id', '{}'));
    assert.throws(() => raw.prepare('INSERT INTO workspace_projects(id,payload) VALUES (?,?)').run('invalid', '[]'));
    assert.throws(() => raw.prepare('INSERT INTO workspace_team_members VALUES (?,?,?,?)').run('team', 'p2', 's1', 2));
    assert.throws(() => raw.prepare('INSERT INTO workspace_events VALUES (?,?,?,?)').run('s1', 'e1', 0, event()));
    assert.throws(() => raw.prepare('INSERT INTO workspace_events VALUES (?,?,?,?)').run('s1', 'e1', 1, event('e1', 's2')));
    assert.equal(raw.prepare('PRAGMA user_version').get().user_version, WORKSPACE_SQLITE_VERSION);
  } finally { raw.close(); }
});

test('future schemas, unrelated databases and damaged structures are never reopened as empty workspaces', (t) => {
  for (const mutation of ['PRAGMA user_version=99', 'PRAGMA application_id=0', 'DROP TABLE workspace_events']) {
    const f = fixture(t);
    const store = f.open(); store.saveState(state()); store.close();
    const raw = new DatabaseSync(f.path); raw.exec(mutation); raw.close();
    const before = readFileSync(f.path);
    assert.throws(() => f.open(), { name: 'WorkspaceStorageError', reason: mutation.includes('user_version') ? 'unsupported_version' : 'invalid_schema' });
    assert.deepEqual(readFileSync(f.path), before);
  }
});

test('credentials and invalid migration metadata are rejected before persistence', (t) => {
  const f = fixture(t);
  const store = f.open(); store.saveState(state());
  const secret = 'sk-' + 'fixtureSecret'.repeat(4);
  const value = state(); value.providers[0].apiKey = secret;
  assert.throws(() => store.saveState(value), (error) => error.reason === 'invalid_data' && !error.message.includes(secret));
  const nested = state(); nested.settings.credentials = { authorization: `Bearer ${secret}` };
  assert.throws(() => store.saveState(nested), { reason: 'invalid_data' });
  assert.throws(() => store.writeMigrationRun({ sourceHash: 'a'.repeat(64), importedAt: 1, counts: { projects: 1, sessions: 1, events: 0 }, phase: 'complete', backupName: '../outside' }), { reason: 'invalid_data' });
  store.close();
  assert.equal(readFileSync(f.path).includes(Buffer.from(secret)), false);
  assert.deepEqual(f.open().readState(), state());
});

test('complete normalized messages preserve tutorial text, signatures and redacted tool fields', (t) => {
  const f = fixture(t);
  const store = f.open(); store.saveState(state());
  const tutorial = 'Use Authorization: Bearer YOUR_API_KEY. The JSON field api_key contains [REDACTED].';
  const assistant = JSON.stringify({ id: 'assistant', sessionId: 's1', schemaVersion: 1, type: 'api.assistant.message', createdAt: 2,
    payload: { schemaVersion: 1, message: { role: 'assistant', content: [
      { type: 'text', text: tutorial.repeat(4_000) },
      { type: 'thinking', thinking: 'Read the documented headers.', thinkingSignature: 'opaque-signature:Bearer YOUR_API_KEY' },
    ], api: 'fixture', provider: 'fixture', model: 'fixture', responseId: 'native-response' } } });
  const tool = JSON.stringify({ id: 'tool', sessionId: 's1', type: 'tool.event', createdAt: 3,
    payload: { api_key: '[REDACTED]', authorization: '<redacted>', result: { token: '[REDACTED]', tokenCount: 12 } } });
  store.appendEvent('s1', event('question', 's1', tutorial));
  store.appendEvent('s1', assistant); store.appendEvent('s1', tool);
  const expected = [event('question', 's1', tutorial), assistant, tool];
  assert.deepEqual(store.readEvents('s1'), expected);
  store.replaceEvents('s1', expected); store.close();
  assert.deepEqual(f.open().readEvents('s1'), expected);
});

test('native async transaction callbacks are rejected before invocation and cannot write after an await', async (t) => {
  const f = fixture(t);
  const store = f.open(); store.saveState(state());
  let invoked = 0;
  const callback = async () => {
    invoked++;
    await Promise.resolve();
    store.appendEvent('s1', event('escaped'));
  };
  for (const method of ['transaction', 'transactions']) {
    assert.throws(() => store[method](callback), { reason: 'invalid_data' });
    assert.throws(() => store[method](callback.bind(null)), { reason: 'invalid_data' });
  }
  await new Promise((done) => setImmediate(done));
  assert.equal(invoked, 0);
  assert.deepEqual(store.readEvents('s1'), []);
});

test('a returned thenable rolls back synchronous changes without executing its continuation', async (t) => {
  const f = fixture(t);
  const store = f.open(); store.saveState(state());
  let thenCalled = false;
  assert.throws(() => store.transaction(() => {
    store.appendEvent('s1', event('rolled-back'));
    return { then: () => { thenCalled = true; store.appendEvent('s1', event('continued')); } };
  }), { reason: 'invalid_data' });
  await new Promise((done) => setImmediate(done));
  assert.equal(thenCalled, false);
  assert.deepEqual(store.readEvents('s1'), []);
});

test('the TypeScript transaction contract excludes PromiseLike and mixed async return values', (t) => {
  const f = fixture(t);
  const source = join(f.directory, 'transaction-contract.mts');
  const modulePath = fileURLToPath(new URL('../../apps/desktop/dist/electron-main/workspace-sqlite.js', import.meta.url)).replaceAll('\\', '/');
  writeFileSync(source, `import type { WorkspaceSqliteStore } from ${JSON.stringify(modulePath)};
declare const store: WorkspaceSqliteStore;
const result: number = store.transaction(() => 1);
store.transactions(() => undefined);
// @ts-expect-error Async transaction callbacks must not typecheck.
store.transaction(async () => 1);
// @ts-expect-error The alias has the same synchronous contract.
store.transactions(async () => undefined);
declare const thenable: PromiseLike<number>;
// @ts-expect-error Custom PromiseLike returns must not typecheck.
store.transaction(() => thenable);
declare const mixed: number | PromiseLike<number>;
// @ts-expect-error Unions must not admit an asynchronous return path.
store.transaction(() => mixed);
void result;
`);
  const require = createRequire(import.meta.url);
  const compiler = join(dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');
  const result = spawnSync(process.execPath, [compiler, '--noEmit', '--strict', '--skipLibCheck',
    '--target', 'es2022', '--module', 'nodenext', '--moduleResolution', 'nodenext', source], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('events accept legacy and version one envelopes and refuse future versions without replacing history', (t) => {
  const f = fixture(t);
  const store = f.open(); store.saveState(state());
  const legacy = event();
  const current = JSON.stringify({ ...JSON.parse(event('version-one')), schemaVersion: 1 });
  const future = JSON.stringify({ ...JSON.parse(event('future')), schemaVersion: 2 });
  store.appendEvent('s1', legacy); store.appendEvent('s1', current);
  assert.throws(() => store.appendEvent('s1', future), { reason: 'unsupported_version' });
  assert.throws(() => store.replaceEvents('s1', [future]), { reason: 'unsupported_version' });
  assert.deepEqual(store.readEvents('s1'), [legacy, current]);
  store.close();
  const raw = new DatabaseSync(f.path);
  try { raw.prepare("UPDATE workspace_events SET payload=? WHERE event_id='e1'").run(JSON.stringify({ ...JSON.parse(legacy), schemaVersion: 2 })); }
  finally { raw.close(); }
  assert.throws(() => f.open().readEvents('s1'), { reason: 'unsupported_version' });
});
