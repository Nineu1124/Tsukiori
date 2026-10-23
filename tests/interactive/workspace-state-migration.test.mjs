import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WorkspaceSqliteStore } from '../../apps/desktop/dist/electron-main/workspace-sqlite.js';
import { applyWorkspaceMigration, planWorkspaceMigration, WORKSPACE_MIGRATION_BACKUPS } from '../../apps/desktop/dist/electron-main/workspace-state-migration.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'tsukiori-state-migration-'));
  const stores = [];
  t.after(() => {
    for (const store of stores) store.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return { directory, store() {
    const store = new WorkspaceSqliteStore(join(directory, 'workspace.sqlite')); stores.push(store); return store;
  } };
}

function document(version = 3) {
  return {
    schemaVersion: version,
    projects: [{ id: 'project:a', name: 'Fixture', rootPath: 'C:\\fixture', gitRoot: 'C:\\fixture', branch: 'main' }],
    sessions: [{ id: 'session:a', projectId: 'project:a', name: 'Fixture session', worktreePath: 'C:\\fixture-worktree',
      branch: 'fixture-branch', runtimeType: 'codex', threadId: 'native:preserved', status: 'running',
      providerId: 'provider:fixture', model: 'fixture-model', permissionMode: 'manual', createdAt: 1, updatedAt: 2 }],
    ...(version >= 2 ? { settings: { density: 'compact', persistConversation: true }, providers: [
      { id: 'provider:fixture', name: 'Fixture', kind: 'openai-compatible', models: ['fixture-model'],
        secretRef: 'secretref:00000000-0000-4000-8000-000000000001' },
    ] } : {}),
    ...(version >= 3 ? { teams: [{ id: 'team:a', projectId: 'project:a', name: 'Team', goal: 'fixture goal',
      memberSessionIds: ['session:a'], status: 'running', createdAt: 1, updatedAt: 2 }] } : {}),
  };
}
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const reason = (expected) => (error) => error.reason === expected;

test('dry run inventories retained data without opening a database or changing legacy files', (t) => {
  const f = fixture(t);
  const file = join(f.directory, 'workspace-state-v3.json');
  const original = JSON.stringify(document());
  writeFileSync(file, original);
  mkdirSync(join(f.directory, 'transcripts'));
  writeFileSync(join(f.directory, 'transcripts', 'fixture.jsonl'), 'retained opaque fixture');
  writeFileSync(join(f.directory, 'scheduled-tasks-v1.json'), '{"fixture":true}');
  const before = readdirSync(f.directory).sort();
  const plan = planWorkspaceMigration(f.directory);
  assert.deepEqual(readdirSync(f.directory).sort(), before);
  assert.equal(readFileSync(file, 'utf8'), original);
  assert.equal(existsSync(join(f.directory, 'workspace.sqlite')), false);
  assert.equal(existsSync(join(f.directory, WORKSPACE_MIGRATION_BACKUPS)), false);
  assert.deepEqual(plan.counts, { projects: 1, sessions: 1, teams: 1, providers: 1 });
  assert.equal(plan.selectedSource, 'workspace-state-v3.json');
  assert.equal(plan.state.sessions[0].threadId, 'native:preserved');
  assert.equal(plan.state.sessions[0].status, 'ready');
  assert.equal(plan.state.teams[0].status, 'stopped');
  assert.equal(plan.state.settings.density, 'compact');
  assert.equal(plan.state.providers[0].secretRef, document().providers[0].secretRef);
  assert.equal(plan.sourceFiles[0].sha256, sha256(original));
  assert.deepEqual(plan.inventory.filter((entry) => entry.present).map((entry) => [entry.name, entry.disposition]),
    [['transcripts', 'retained_in_place'], ['scheduled-tasks-v1.json', 'retained_in_place']]);
  assert.doesNotMatch(JSON.stringify(plan), /retained opaque fixture/);
});

test('all supported JSON versions import in one transaction with verified source backup and stable IDs', (t) => {
  for (const version of [1, 2, 3]) {
    const f = fixture(t);
    const name = `workspace-state-v${version}.json`;
    const original = JSON.stringify(document(version));
    writeFileSync(join(f.directory, name), original);
    const plan = planWorkspaceMigration(f.directory);
    const store = f.store();
    const imported = applyWorkspaceMigration(plan, store, { now: () => 1234 });
    assert.equal(imported.status, 'applied');
    assert.equal(imported.run.importedAt, 1234);
    assert.equal(imported.run.phase, 'state');
    assert.deepEqual(store.readState(), plan.state);
    const backup = join(f.directory, WORKSPACE_MIGRATION_BACKUPS, imported.run.backupName);
    assert.equal(readFileSync(join(backup, name), 'utf8'), original);
    assert.equal(sha256(readFileSync(join(backup, name))), plan.sourceFiles[0].sha256);
    const manifest = JSON.parse(readFileSync(join(backup, 'manifest.json'), 'utf8'));
    assert.equal(manifest.sourceHash, plan.sourceHash);
    assert.deepEqual(manifest.sourceFiles, plan.sourceFiles);
    assert.equal(readFileSync(join(f.directory, name), 'utf8'), original);
    assert.equal(store.readState().sessions[0].id, 'session:a');
    assert.equal(store.readState().sessions[0].threadId, 'native:preserved');
    assert.equal(store.listMigrationRuns().length, 1);
  }
});

test('same source import is idempotent and never overwrites later state or event migration markers', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.directory, 'workspace-state-v3.json'), JSON.stringify(document()));
  const plan = planWorkspaceMigration(f.directory);
  const store = f.store();
  const first = applyWorkspaceMigration(plan, store);
  const later = store.readState(); later.sessions[0].name = 'later edit';
  store.saveState(later);
  store.writeMigrationRun({ sourceHash: 'e'.repeat(64), importedAt: 1235, phase: 'events', counts: { projects: 1, sessions: 1, events: 0 } });
  const second = applyWorkspaceMigration(plan, store);
  assert.equal(second.status, 'already_applied');
  assert.equal(second.run.backupName, first.run.backupName);
  assert.equal(store.readState().sessions[0].name, 'later edit');
  assert.equal(readdirSync(join(f.directory, WORKSPACE_MIGRATION_BACKUPS)).length, 1);
  assert.equal(store.listMigrationRuns().length, 2);
});

test('corrupt primary selects only a valid same-version backup and preserves both original byte sequences', (t) => {
  const f = fixture(t);
  const corrupt = '{"schemaVersion":3,"projects":[';
  const valid = JSON.stringify(document());
  writeFileSync(join(f.directory, 'workspace-state-v3.json'), corrupt);
  writeFileSync(join(f.directory, 'workspace-state-v3.json.bak'), valid);
  writeFileSync(join(f.directory, 'workspace-state-v2.json'), JSON.stringify(document(2)));
  const plan = planWorkspaceMigration(f.directory);
  assert.equal(plan.selectedSource, 'workspace-state-v3.json.bak');
  assert.equal(plan.recoveredFromBackup, true);
  assert.equal(readFileSync(join(f.directory, 'workspace-state-v3.json'), 'utf8'), corrupt);
  const result = applyWorkspaceMigration(plan, f.store());
  const backup = join(f.directory, WORKSPACE_MIGRATION_BACKUPS, result.run.backupName);
  assert.equal(readFileSync(join(backup, 'workspace-state-v3.json'), 'utf8'), corrupt);
  assert.equal(readFileSync(join(backup, 'workspace-state-v3.json.bak'), 'utf8'), valid);
  assert.equal(readFileSync(join(f.directory, 'workspace-state-v3.json'), 'utf8'), corrupt);
  assert.equal(readdirSync(f.directory).some((name) => name.includes('.corrupt-')), false);
});

test('unsupported versions and broken latest sources fail without falling back to older data', (t) => {
  const f = fixture(t);
  const main = join(f.directory, 'workspace-state-v3.json');
  writeFileSync(main, JSON.stringify({ ...document(), schemaVersion: 99 }));
  writeFileSync(`${main}.bak`, JSON.stringify(document()));
  writeFileSync(join(f.directory, 'workspace-state-v2.json'), JSON.stringify(document(2)));
  assert.throws(() => planWorkspaceMigration(f.directory), reason('unsupported_version'));
  writeFileSync(main, 'broken fixture');
  writeFileSync(`${main}.bak`, 'also broken fixture');
  assert.throws(() => planWorkspaceMigration(f.directory), reason('source_invalid'));
  assert.equal(existsSync(join(f.directory, WORKSPACE_MIGRATION_BACKUPS)), false);
  assert.equal(existsSync(join(f.directory, 'workspace.sqlite')), false);
});

test('changed files, newly appearing higher versions and edited plans are rejected before target writes', (t) => {
  const f = fixture(t);
  const main = join(f.directory, 'workspace-state-v2.json');
  writeFileSync(main, JSON.stringify(document(2)));
  const plan = planWorkspaceMigration(f.directory);
  const store = f.store();
  writeFileSync(main, JSON.stringify({ ...document(2), settings: { density: 'comfortable' } }));
  assert.throws(() => applyWorkspaceMigration(plan, store), reason('source_changed'));
  writeFileSync(main, JSON.stringify(document(2)));
  writeFileSync(join(f.directory, 'workspace-state-v3.json'), JSON.stringify(document()));
  assert.throws(() => applyWorkspaceMigration(plan, store), reason('source_changed'));
  const next = planWorkspaceMigration(f.directory);
  next.state.sessions[0].name = 'tampered plan';
  assert.throws(() => applyWorkspaceMigration(next, store), reason('invalid_plan'));
  assert.equal(store.readState(), undefined);
  assert.deepEqual(store.listMigrationRuns(), []);
  assert.equal(existsSync(join(f.directory, WORKSPACE_MIGRATION_BACKUPS)), false);
});

test('existing target state or a different source migration is never overwritten', (t) => {
  for (const existing of ['active-state', 'different-source']) {
    const f = fixture(t);
    writeFileSync(join(f.directory, 'workspace-state-v3.json'), JSON.stringify(document()));
    const plan = planWorkspaceMigration(f.directory);
    const store = f.store();
    if (existing === 'active-state') store.saveState(plan.state);
    else store.writeMigrationRun({ sourceHash: 'f'.repeat(64), importedAt: 1, phase: 'state', counts: { projects: 0, sessions: 0, events: 0 } });
    const before = store.readState();
    const runs = store.listMigrationRuns();
    assert.throws(() => applyWorkspaceMigration(plan, store), reason('target_not_empty'));
    assert.deepEqual(store.readState(), before);
    assert.deepEqual(store.listMigrationRuns(), runs);
    assert.equal(existsSync(join(f.directory, WORKSPACE_MIGRATION_BACKUPS)), false);
  }
});

test('empty first-use dry run does not create its directory and can initialize a new store', (t) => {
  const f = fixture(t);
  const absent = join(f.directory, 'new-user-data');
  const plan = planWorkspaceMigration(absent);
  assert.equal(existsSync(absent), false);
  assert.equal(plan.selectedSource, undefined);
  assert.deepEqual(plan.sourceFiles, []);
  assert.deepEqual(plan.state.sessions, []);
  const store = new WorkspaceSqliteStore(':memory:');
  try {
    assert.equal(applyWorkspaceMigration(plan, store).status, 'applied');
    assert.deepEqual(store.readState(), plan.state);
  } finally { store.close(); }
});
