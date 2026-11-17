import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openWorkspaceWithRecovery, workspaceStartupFailure } from '../../apps/desktop/dist/electron-main/workspace-startup.js';
import { InteractiveWorkspace } from '../../apps/desktop/dist/electron-main/interactive-workspace.js';
import { WorkspaceStorageError } from '../../apps/desktop/dist/electron-main/workspace-sqlite.js';
import { WorkspaceMigrationError } from '../../apps/desktop/dist/electron-main/workspace-state-migration.js';
import { ConversationMigrationError } from '../../apps/desktop/dist/electron-main/workspace-conversation-migration.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'tsukiori-startup-'));
  const path = join(root, 'workspace-state-v3.json');
  writeFileSync(path, '{broken fixture');
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }));
  return { root, path, create: () => new InteractiveWorkspace({ userDataPath: root, emit() {},
    discoverCodex() { throw new Error('offline fixture'); }, discoverClaude() { throw new Error('offline fixture'); } }) };
}

test('formal startup failure offers recovery and exit without constructing an empty workspace', async (t) => {
  const f = fixture(t);
  let attempts = 0;
  const failures = [];
  const result = await openWorkspaceWithRecovery({
    create() { attempts++; return f.create(); },
    async showRecovery(failure) { failures.push(failure); return 'exit'; },
    async openData() { assert.fail('not requested'); },
  });
  assert.equal(result, null);
  assert.equal(attempts, 1);
  assert.equal(failures[0].stage, 'state_migration');
  assert.equal(failures[0].code, 'source_invalid');
  assert.equal(failures[0].dataRetained, true);
  assert.equal(readFileSync(f.path, 'utf8'), '{broken fixture');
  assert.equal(existsSync(join(f.root, 'workspace.sqlite')), false);
});

test('opening the data directory never retries writes; explicit retry can load restored data', async (t) => {
  const f = fixture(t);
  let attempts = 0;
  let dialogs = 0;
  let opened = 0;
  const workspace = await openWorkspaceWithRecovery({
    create() { attempts++; return f.create(); },
    async showRecovery() {
      if (++dialogs === 1) return 'open_data';
      assert.equal(attempts, 1);
      writeFileSync(f.path, JSON.stringify({ schemaVersion: 3, projects: [], sessions: [], teams: [], providers: [], settings: { density: 'compact' } }));
      return 'retry';
    },
    async openData() { opened++; },
  });
  try {
    assert.equal(attempts, 2);
    assert.equal(opened, 1);
    assert.equal(workspace.snapshot().settings.density, 'compact');
  } finally { await workspace.shutdown(); }
});

test('failure to open the data directory remains in recovery and does not expose exception bodies', async () => {
  let dialogs = 0;
  const failures = [];
  const result = await openWorkspaceWithRecovery({
    create() { throw new WorkspaceStorageError('unavailable'); },
    async showRecovery(failure) { failures.push(failure); return ++dialogs === 1 ? 'open_data' : 'exit'; },
    async openData() { throw new Error('private filesystem error fixture'); },
  });
  assert.equal(result, null);
  assert.equal(failures[1].openDataFailed, true);
  assert.doesNotMatch(JSON.stringify(failures), /private filesystem error/);
});

test('migration and storage failures have distinct allowlisted diagnostics', () => {
  for (const [error, stage, code] of [
    [new WorkspaceMigrationError('backup_failed'), 'state_migration', 'backup_failed'],
    [new ConversationMigrationError('source_invalid'), 'conversation_migration', 'source_invalid'],
    [new WorkspaceStorageError('unsupported_version'), 'storage', 'unsupported_version'],
    [new Error('private raw response fixture'), 'initialization', 'initialization_failed'],
  ]) {
    error.message = 'private raw response fixture';
    const failure = workspaceStartupFailure(error);
    assert.equal(failure.stage, stage);
    assert.equal(failure.code, code);
    assert.doesNotMatch(JSON.stringify(failure), /private raw response/);
  }
});
