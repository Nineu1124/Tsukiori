import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WorkspaceSqliteStore } from '../../apps/desktop/dist/electron-main/workspace-sqlite.js';
import { applyWorkspaceMigration, planWorkspaceMigration, WORKSPACE_MIGRATION_BACKUPS } from '../../apps/desktop/dist/electron-main/workspace-state-migration.js';
import { appendTranscriptLine } from '../../apps/desktop/dist/electron-main/transcript-store.js';
import { applyConversationMigration, planConversationMigration } from '../../apps/desktop/dist/electron-main/workspace-conversation-migration.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'tsukiori-migration-recovery-'));
  const stores = [];
  const document = {
    schemaVersion: 3,
    projects: [{ id: 'project:a', name: 'Fixture', rootPath: 'C:\\fixture', gitRoot: 'C:\\fixture', branch: 'main' }],
    sessions: ['one', 'two'].map((id) => ({ id: `session:${id}`, projectId: 'project:a', name: id,
      branch: `fixture-${id}`, worktreePath: `C:\\fixture-${id}`, runtimeType: 'api', createdAt: 1, updatedAt: 2 })),
    settings: {}, providers: [], teams: [],
  };
  const sourceFiles = new Map([
    ['workspace-state-v3.json', Buffer.from(JSON.stringify(document))],
    ['workspace-state-v3.json.bak', Buffer.from(JSON.stringify(document, null, 2))],
  ]);
  for (const [name, content] of sourceFiles) writeFileSync(join(directory, name), content);
  t.after(() => {
    for (const store of stores) store.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return {
    directory, sourceFiles, document,
    open() { const store = new WorkspaceSqliteStore(join(directory, 'workspace.sqlite')); stores.push(store); return store; },
    assertSources() {
      for (const [name, content] of sourceFiles) assert.deepEqual(readFileSync(join(directory, name)), content);
    },
  };
}

function addLongTranscripts(f) {
  mkdirSync(join(f.directory, 'transcripts'));
  for (const session of f.document.sessions) {
    const path = join(f.directory, 'transcripts', createHash('sha256').update(session.id).digest('hex') + '.jsonl');
    const events = [
      { id: `${session.id}:user`, sessionId: session.id, type: 'user.message', createdAt: 1, payload: { text: '长'.repeat(220000) } },
      { id: `${session.id}:usage`, sessionId: session.id, type: 'assistant.usage', createdAt: 2, payload: { totalTokens: 10 } },
      { id: `${session.id}:assistant`, sessionId: session.id, type: 'api.assistant.message', createdAt: 3,
        payload: { message: { role: 'assistant', content: [{ type: 'text', text: '答'.repeat(220000) }] }, runtimeSessionId: `native:${session.id}` } },
    ];
    for (const event of events) appendTranscriptLine(path, JSON.stringify(event) + '\n', 4096);
  }
}

for (const point of ['after_session', 'before_commit']) {
  test(`segmented conversation failure at ${point} keeps migrated state and rolls back the whole history batch after reopen`, (t) => {
    const f = fixture(t);
    addLongTranscripts(f);
    const statePlan = planWorkspaceMigration(f.directory);
    const store = f.open();
    applyWorkspaceMigration(statePlan, store);
    const plan = planConversationMigration(f.directory, store.readState());
    assert.equal(plan.counts.events, 6);
    assert.ok(plan.sourceFiles.some((file) => file.name.includes('.segment-')));
    assert.equal(JSON.parse(plan.sessions[0].events[0]).payload.text.length, 220000);
    const originalState = store.readState();
    const stateRuns = store.listMigrationRuns();
    const originalSources = new Map(plan.sourceFiles.map((source) => [source.name, readFileSync(join(f.directory, source.name))]));
    let injected = 0;
    assert.throws(() => applyConversationMigration(plan, store, {
      fault(current, sessionId) {
        if (current !== point || injected) return;
        injected++;
        if (point === 'after_session') {
          assert.equal(sessionId, plan.sessions[0].sessionId);
          assert.equal(store.readEvents(sessionId).length, 3);
          assert.equal(store.readEvents(plan.sessions[1].sessionId).length, 0);
        } else {
          assert.equal(store.readEvents(plan.sessions[0].sessionId).length, 3);
          assert.equal(store.readEvents(plan.sessions[1].sessionId).length, 3);
          assert.equal(store.listMigrationRuns().length, 2);
        }
        throw new Error('private conversation failure detail');
      },
    }), (error) => error.reason === 'import_failed' && !error.message.includes('private conversation'));
    assert.equal(injected, 1);
    for (const session of plan.sessions) assert.deepEqual(store.readEvents(session.sessionId), []);
    assert.deepEqual(store.readState(), originalState);
    assert.deepEqual(store.listMigrationRuns(), stateRuns);
    f.assertSources();
    for (const [name, content] of originalSources) assert.deepEqual(readFileSync(join(f.directory, name)), content);
    const backupRoot = join(f.directory, WORKSPACE_MIGRATION_BACKUPS);
    const failedBackup = readdirSync(backupRoot).find((name) => name.startsWith('events-'));
    assert.ok(failedBackup);
    for (const source of plan.sourceFiles) {
      const copied = readFileSync(join(backupRoot, failedBackup, source.name));
      assert.equal(createHash('sha256').update(copied).digest('hex'), source.sha256);
    }
    store.close();
    const restarted = f.open();
    assert.deepEqual(restarted.readState(), originalState);
    assert.deepEqual(restarted.listMigrationRuns(), stateRuns);
    for (const session of plan.sessions) assert.deepEqual(restarted.readEvents(session.sessionId), []);
    assert.equal(applyWorkspaceMigration(statePlan, restarted).status, 'already_applied');
    assert.equal(applyConversationMigration(plan, restarted).status, 'applied');
    for (const session of plan.sessions) assert.deepEqual(restarted.readEvents(session.sessionId), session.events);
    const completeBackups = readdirSync(backupRoot).sort();
    assert.equal(applyConversationMigration(plan, restarted).status, 'already_applied');
    assert.equal(applyWorkspaceMigration(statePlan, restarted).status, 'already_applied');
    assert.equal(restarted.listMigrationRuns().length, 2);
    assert.deepEqual(readdirSync(backupRoot).sort(), completeBackups);
    f.assertSources();
  });
}

test('a missing active long-message segment blocks planning and stale-plan apply until the exact segment is restored', (t) => {
  const f = fixture(t);
  addLongTranscripts(f);
  const statePlan = planWorkspaceMigration(f.directory);
  const store = f.open();
  applyWorkspaceMigration(statePlan, store);
  const plan = planConversationMigration(f.directory, store.readState());
  const source = plan.sourceFiles.find((file) => file.name.includes('.segment-') && file.bytes > 512 * 1024);
  assert.ok(source, 'fixture has an indexed long-message segment');
  const path = join(f.directory, source.name);
  const content = readFileSync(path);
  unlinkSync(path);
  assert.throws(() => planConversationMigration(f.directory, store.readState()), { reason: 'source_invalid' });
  assert.throws(() => applyConversationMigration(plan, store), { reason: 'source_changed' });
  for (const session of plan.sessions) assert.deepEqual(store.readEvents(session.sessionId), []);
  assert.equal(store.listMigrationRuns().length, 1);
  assert.equal(readdirSync(join(f.directory, WORKSPACE_MIGRATION_BACKUPS)).length, 1);
  f.assertSources();
  writeFileSync(path, content);
  const restored = planConversationMigration(f.directory, store.readState());
  assert.equal(restored.sourceHash, plan.sourceHash);
  assert.equal(applyConversationMigration(restored, store).status, 'applied');
  for (const session of restored.sessions) assert.deepEqual(store.readEvents(session.sessionId), session.events);
});

for (const point of ['after_backup', 'after_state', 'before_commit']) {
  test(`state migration failure at ${point} rolls back, preserves backups and resumes once after reopen`, (t) => {
    const f = fixture(t);
    const plan = planWorkspaceMigration(f.directory);
    const store = f.open();
    let injected = 0;
    assert.throws(() => applyWorkspaceMigration(plan, store, {
      fault(current) {
        if (current !== point) return;
        injected++;
        assert.equal(existsSync(join(f.directory, WORKSPACE_MIGRATION_BACKUPS)), true);
        if (point === 'after_backup') assert.equal(store.readState(), undefined);
        else assert.equal(store.readState().sessions.length, 2, 'fault occurs after actual state writes');
        if (point === 'before_commit') assert.equal(store.listMigrationRuns().length, 1, 'fault occurs after actual marker write');
        throw new Error('private injected failure detail');
      },
    }), (error) => {
      assert.equal(error.reason, 'import_failed');
      assert.doesNotMatch(error.message, /private injected failure detail/);
      return true;
    });
    assert.equal(injected, 1);
    f.assertSources();
    assert.equal(store.readState(), undefined);
    assert.deepEqual(store.listMigrationRuns(), []);
    const backupRoot = join(f.directory, WORKSPACE_MIGRATION_BACKUPS);
    const failedBackups = readdirSync(backupRoot);
    assert.equal(failedBackups.length, 1);
    const failedBackup = join(backupRoot, failedBackups[0]);
    const manifest = JSON.parse(readFileSync(join(failedBackup, 'manifest.json'), 'utf8'));
    assert.equal(manifest.sourceHash, plan.sourceHash);
    for (const source of manifest.sourceFiles) {
      const content = readFileSync(join(failedBackup, source.name));
      assert.deepEqual(content, f.sourceFiles.get(source.name));
      assert.equal(createHash('sha256').update(content).digest('hex'), source.sha256);
    }
    store.close();
    const restarted = f.open();
    assert.equal(restarted.readState(), undefined);
    assert.deepEqual(restarted.listMigrationRuns(), []);
    assert.equal(applyWorkspaceMigration(plan, restarted).status, 'applied');
    assert.equal(restarted.readState().sessions.length, 2);
    assert.equal(restarted.listMigrationRuns().length, 1);
    const completeBackups = readdirSync(backupRoot).sort();
    assert.equal(completeBackups.length, 2, 'failed backup is retained separately');
    assert.equal(applyWorkspaceMigration(plan, restarted).status, 'already_applied');
    assert.deepEqual(readdirSync(backupRoot).sort(), completeBackups);
    assert.equal(restarted.listMigrationRuns().length, 1);
    f.assertSources();
  });
}
