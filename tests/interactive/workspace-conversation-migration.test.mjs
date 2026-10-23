import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { appendTranscriptLine, replaceTranscript } from '../../apps/desktop/dist/electron-main/transcript-store.js';
import { WorkspaceSqliteStore } from '../../apps/desktop/dist/electron-main/workspace-sqlite.js';
import { planConversationMigration, applyConversationMigration } from '../../apps/desktop/dist/electron-main/workspace-conversation-migration.js';
import { WORKSPACE_MIGRATION_BACKUPS } from '../../apps/desktop/dist/electron-main/workspace-state-migration.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'tsukiori-conversation-migration-'));
  const transcriptRoot = join(directory, 'transcripts'); mkdirSync(transcriptRoot);
  const state = { schemaVersion: 3,
    projects: [{ id: 'p', name: 'fixture', rootPath: directory, gitRoot: directory }],
    sessions: ['s1', 's2'].map((id) => ({ id, projectId: 'p', name: id, worktreePath: directory, branch: 'main' })),
    settings: {}, providers: [], teams: [] };
  const stores = [];
  const open = () => { const store = new WorkspaceSqliteStore(join(directory, 'workspace.sqlite')); stores.push(store); return store; };
  const path = (sessionId) => join(transcriptRoot, createHash('sha256').update(sessionId).digest('hex') + '.jsonl');
  t.after(() => { for (const store of stores) store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, state, transcriptRoot, open, path };
}
const event = (id = 'e1', sessionId = 's1', payload = { text: 'fixture text' }) => ({ id, sessionId, type: 'user.message', createdAt: 1, payload });
const line = (...args) => JSON.stringify(event(...args)) + '\n';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('dry run reads only active segments, preserves full API messages and changes no source files', (t) => {
  const f = fixture(t);
  appendTranscriptLine(f.path('s1'), line('retired-first'), 1);
  appendTranscriptLine(f.path('s1'), line('retired-second'), 1);
  const fullMessage = { ...event('native-event'), type: 'api.assistant.message', schemaVersion: 1,
    payload: { runtimeSessionId: 'native-session-id', message: { role: 'assistant', content: [{ type: 'text', text: '完整'.repeat(150_000) }], responseId: 'native-response-id' } } };
  replaceTranscript(f.path('s1'), JSON.stringify(fullMessage) + '\n');
  const legacy = event(undefined, 's2'); delete legacy.id;
  writeFileSync(f.path('s2'), JSON.stringify(legacy) + '\n');
  const names = readdirSync(f.transcriptRoot);
  const before = names.map((name) => [name, digest(readFileSync(join(f.transcriptRoot, name)))]);
  const plan = planConversationMigration(f.directory, f.state);
  assert.deepEqual(plan.counts, { projects: 1, sessions: 2, events: 2 });
  assert.deepEqual(JSON.parse(plan.sessions[0].events[0]), fullMessage);
  assert.match(JSON.parse(plan.sessions[1].events[0]).id, /^legacy:[a-f0-9]{64}$/);
  assert.deepEqual(planConversationMigration(f.directory, f.state), plan);
  assert.equal(plan.sourceFiles.some((file) => file.name.endsWith(f.path('s1').split(/[\\/]/).at(-1))), false);
  assert.equal(plan.sourceFiles.length, 3);
  assert.deepEqual(readdirSync(f.transcriptRoot).map((name) => [name, digest(readFileSync(join(f.transcriptRoot, name)))]), before);
  assert.equal(existsSync(join(f.directory, 'workspace.sqlite')), false);
  assert.equal(existsSync(join(f.directory, WORKSPACE_MIGRATION_BACKUPS)), false);
});

test('import backs up verified sources and is idempotent without overwriting later conversation activity', (t) => {
  const f = fixture(t);
  writeFileSync(f.path('s1'), line());
  const plan = planConversationMigration(f.directory, f.state);
  const store = f.open(); store.saveState(f.state);
  store.writeMigrationRun({ sourceHash: '1'.repeat(64), importedAt: 1, counts: { projects: 1, sessions: 2, events: 0 }, phase: 'state' });
  const result = applyConversationMigration(plan, store, { now: () => 123 });
  assert.equal(result.status, 'applied'); assert.equal(result.run.phase, 'events');
  for (const file of plan.sourceFiles) {
    const copied = readFileSync(join(f.directory, WORKSPACE_MIGRATION_BACKUPS, result.run.backupName, ...file.name.split('/')));
    assert.equal(digest(copied), file.sha256); assert.equal(copied.length, file.bytes);
  }
  assert.equal(readFileSync(f.path('s1'), 'utf8'), line());
  store.appendEvent('s1', JSON.stringify(event('later-message')));
  const activeState = store.readState();
  activeState.projects.push({ id: 'new-project', name: 'new project', rootPath: f.directory, gitRoot: f.directory });
  activeState.sessions.push({ id: 'new-session', projectId: 'new-project', name: 'new session', worktreePath: f.directory, branch: 'main' });
  store.saveState(activeState);
  store.appendEvent('new-session', JSON.stringify(event('new-session-message', 'new-session')));
  const repeated = applyConversationMigration(plan, store);
  assert.equal(repeated.status, 'already_applied');
  assert.equal(store.readEvents('s1').length, 2);
  assert.deepEqual(store.readState(), activeState);
  assert.equal(store.readEvents('new-session').length, 1);
  assert.equal(store.listMigrationRuns().length, 2);
  store.close();
  assert.equal(f.open().readEvents('s1').length, 2);
});

test('sessions with previous turns cannot migrate an absent or empty saved history as complete', (t) => {
  const f = fixture(t);
  f.state.settings.persistConversation = true;
  f.state.sessions[0].turnCount = 4;
  assert.throws(() => planConversationMigration(f.directory, f.state), { reason: 'source_invalid' });
  writeFileSync(f.path('s1'), '');
  assert.throws(() => planConversationMigration(f.directory, f.state), { reason: 'source_invalid' });
  assert.equal(readFileSync(f.path('s1'), 'utf8'), '');
  assert.equal(existsSync(join(f.directory, 'workspace.sqlite')), false);
  assert.equal(existsSync(join(f.directory, WORKSPACE_MIGRATION_BACKUPS)), false);
  writeFileSync(f.path('s1'), line());
  const plan = planConversationMigration(f.directory, f.state);
  assert.equal(plan.sessions.find((session) => session.sessionId === 's1').requiresHistory, true);
  rmSync(f.path('s1'));
  const store = f.open(); store.saveState(f.state);
  assert.throws(() => applyConversationMigration(plan, store), { reason: 'source_changed' });
  assert.deepEqual(store.readEvents('s1'), []);
  assert.deepEqual(store.listMigrationRuns(), []);
});

test('intentionally unsaved and new sessions may be empty, but incomplete-history flags always require recovery', (t) => {
  const f = fixture(t);
  f.state.settings.persistConversation = false;
  f.state.sessions[0].turnCount = 4;
  const unsaved = planConversationMigration(f.directory, f.state);
  assert.equal(unsaved.counts.events, 0);
  assert.equal(unsaved.sessions.some((session) => session.requiresHistory), false);
  const store = f.open(); store.saveState(f.state);
  assert.equal(applyConversationMigration(unsaved, store).status, 'applied');
  f.state.sessions[0].transcriptIncomplete = true;
  assert.throws(() => planConversationMigration(f.directory, f.state), { reason: 'source_invalid' });
  writeFileSync(f.path('s1'), line());
  assert.throws(() => planConversationMigration(f.directory, f.state), { reason: 'source_invalid' });
  delete f.state.sessions[0].transcriptIncomplete;
  f.state.sessions[0].turnCount = 0;
  f.state.settings.persistConversation = true;
  rmSync(f.path('s1'));
  assert.equal(planConversationMigration(f.directory, f.state).counts.events, 0);
});

for (const point of ['after_backup', 'after_session', 'before_commit']) {
  test(`interruption ${point} preserves sources and rolls back every imported session`, (t) => {
    const f = fixture(t);
    writeFileSync(f.path('s1'), line()); writeFileSync(f.path('s2'), line('e2', 's2'));
    const plan = planConversationMigration(f.directory, f.state);
    const store = f.open(); store.saveState(f.state);
    assert.throws(() => applyConversationMigration(plan, store, { fault: (stage) => { if (stage === point) throw new Error('private failure detail'); } }),
      (error) => error.reason === 'import_failed' && !error.message.includes('private'));
    assert.deepEqual(store.readEvents('s1'), []); assert.deepEqual(store.readEvents('s2'), []);
    assert.deepEqual(store.listMigrationRuns(), []); assert.deepEqual(store.readState(), f.state);
    assert.equal(readFileSync(f.path('s1'), 'utf8'), line()); assert.equal(readFileSync(f.path('s2'), 'utf8'), line('e2', 's2'));
    assert.ok(readdirSync(join(f.directory, WORKSPACE_MIGRATION_BACKUPS)).length > 0);
    assert.equal(applyConversationMigration(plan, store).status, 'applied');
    assert.equal(store.readEvents('s1').length, 1); assert.equal(store.readEvents('s2').length, 1);
  });
}

test('changed sources, edited plans and mismatched target sessions are rejected', (t) => {
  const f = fixture(t);
  writeFileSync(f.path('s1'), line());
  const plan = planConversationMigration(f.directory, f.state);
  const store = f.open(); store.saveState(f.state);
  const edited = structuredClone(plan); edited.sessions[0].events[0] = JSON.stringify(event('different'));
  assert.throws(() => applyConversationMigration(edited, store), { reason: 'invalid_plan' });
  appendFileSync(f.path('s1'), line('new-source-event'));
  assert.throws(() => applyConversationMigration(plan, store), { reason: 'source_changed' });
  assert.deepEqual(store.readEvents('s1'), []);
  const fresh = planConversationMigration(f.directory, f.state);
  const target = structuredClone(f.state); target.sessions.pop(); store.saveState(target);
  assert.throws(() => applyConversationMigration(fresh, store), { reason: 'target_mismatch' });
});

test('an existing conversation or a different event import cannot be overwritten', (t) => {
  const f = fixture(t);
  writeFileSync(f.path('s1'), line());
  const plan = planConversationMigration(f.directory, f.state);
  const store = f.open(); store.saveState(f.state);
  store.appendEvent('s1', JSON.stringify(event('active')));
  assert.throws(() => applyConversationMigration(plan, store), { reason: 'target_not_empty' });
  store.removeEvents('s1');
  store.writeMigrationRun({ sourceHash: 'f'.repeat(64), importedAt: 1, counts: { projects: 1, sessions: 2, events: 1 }, phase: 'events' });
  assert.throws(() => applyConversationMigration(plan, store), { reason: 'target_not_empty' });
});

test('empty histories remain empty and the later appearance of a source invalidates an older plan', (t) => {
  const f = fixture(t);
  const plan = planConversationMigration(f.directory, f.state);
  assert.equal(plan.counts.events, 0); assert.deepEqual(plan.sourceFiles, []);
  const store = f.open(); store.saveState(f.state);
  assert.equal(applyConversationMigration(plan, store).status, 'applied');
  assert.equal(applyConversationMigration(plan, store).status, 'already_applied');
  writeFileSync(f.path('s2'), line('appeared', 's2'));
  assert.throws(() => applyConversationMigration(plan, store), { reason: 'source_changed' });
});

for (const [label, content, reason] of [
  ['wrong session', line('e1', 's2'), 'source_invalid'],
  ['future event version', JSON.stringify({ ...event(), schemaVersion: 9 }) + '\n', 'unsupported_version'],
  ['malformed JSON', '{private-data', 'source_invalid'],
  ['duplicate id', line() + line(), 'source_invalid'],
  ['invalid payload', JSON.stringify({ ...event(), payload: [] }) + '\n', 'source_invalid'],
]) {
  test(`dry run rejects ${label} while keeping its source bytes`, (t) => {
    const f = fixture(t); writeFileSync(f.path('s1'), content);
    assert.throws(() => planConversationMigration(f.directory, f.state), { reason });
    assert.equal(readFileSync(f.path('s1'), 'utf8'), content);
    assert.equal(existsSync(join(f.directory, WORKSPACE_MIGRATION_BACKUPS)), false);
  });
}

test('missing segments and escaped segment names fail without falling back to retired data', (t) => {
  const f = fixture(t); writeFileSync(f.path('s1'), line('retired'));
  const base = f.path('s1').split(/[\\/]/).at(-1);
  for (const segments of [[`${base}.segment-00000000-0000-0000-0000-000000000000.jsonl`], ['../outside.jsonl']]) {
    writeFileSync(`${f.path('s1')}.index.json`, JSON.stringify({ version: 1, segments }));
    assert.throws(() => planConversationMigration(f.directory, f.state), { reason: 'source_invalid' });
    assert.equal(readFileSync(f.path('s1'), 'utf8'), line('retired'));
  }
});

test('a transcript junction cannot read or copy files outside the data directory', (t) => {
  const f = fixture(t);
  const outside = mkdtempSync(join(tmpdir(), 'tsukiori-external-transcripts-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  rmSync(f.transcriptRoot, { recursive: true });
  symlinkSync(outside, f.transcriptRoot, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => planConversationMigration(f.directory, f.state), { reason: 'source_unavailable' });
  assert.deepEqual(readdirSync(outside), []);
});
