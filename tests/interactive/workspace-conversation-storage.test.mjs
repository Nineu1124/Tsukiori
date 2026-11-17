import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { InteractiveWorkspace } from '../../apps/desktop/dist/electron-main/interactive-workspace.js';
import { WorkspaceSqliteStore } from '../../apps/desktop/dist/electron-main/workspace-sqlite.js';
import { SqliteConversationRepository } from '../../apps/desktop/dist/electron-main/conversation-repository.js';
import { assistant } from './history-fixture.mjs';
import { readConversationLines } from './workspace-fixture-store.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'tsukiori-default-conversation-'));
  const instances = [];
  const sessionId = 'session:legacy-conversation';
  const document = { schemaVersion: 3,
    projects: [{ id: 'project:fixture', name: 'fixture', rootPath: root, gitRoot: root }],
    sessions: [{ id: sessionId, projectId: 'project:fixture', name: 'Legacy', runtimeType: 'api',
      worktreePath: root, branch: 'fixture', turnCount: 1, createdAt: 1 }],
    providers: [], teams: [], settings: { persistConversation: true } };
  const statePath = join(root, 'workspace-state-v3.json');
  const historyPath = join(root, 'transcripts', createHash('sha256').update(sessionId).digest('hex') + '.jsonl');
  mkdirSync(join(root, 'transcripts'));
  writeFileSync(statePath, JSON.stringify(document));
  const events = [
    { id: 'old-user', sessionId, type: 'user.message', createdAt: 1, payload: { text: 'full legacy fixture' } },
    { id: 'old-answer', sessionId, type: 'api.assistant.message', createdAt: 2, payload: { message: assistant('x'.repeat(900 * 1024)) } },
  ];
  const history = events.map((event) => JSON.stringify(event)).join('\n') + '\n';
  t.after(async () => {
    for (const instance of instances) await instance.shutdown();
    rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  });
  return { root, sessionId, statePath, historyPath, history, events,
    open() {
      const workspace = new InteractiveWorkspace({ userDataPath: root, emit() {},
        discoverCodex() { throw new Error('offline fixture'); }, discoverClaude() { throw new Error('offline fixture'); } });
      instances.push(workspace);
      return workspace;
    } };
}

test('the formal default imports complete legacy messages once and writes subsequent events only to SQLite', async (t) => {
  const f = fixture(t);
  writeFileSync(f.historyPath, f.history);
  const legacyState = readFileSync(f.statePath);
  const workspace = f.open();
  assert.equal(workspace.snapshot().sessions[0].transcriptIncomplete, undefined);
  const imported = readConversationLines(f.root, f.sessionId).map(JSON.parse);
  assert.deepEqual(imported.map((event) => event.id), ['old-user', 'old-answer']);
  assert.deepEqual(imported[1].payload.message, f.events[1].payload.message);
  workspace.publishLocalEvent(f.sessionId, 'assistant.delta', { text: 'new sqlite-only fixture' });
  assert.deepEqual(readFileSync(f.statePath), legacyState);
  assert.equal(readFileSync(f.historyPath, 'utf8'), f.history);
  assert.equal(readdirSync(join(f.root, 'workspace-migration-backups')).length, 2);
  await workspace.shutdown();
  writeFileSync(f.historyPath, '{obsolete corrupt legacy fixture');
  const restarted = f.open();
  assert.equal(restarted.snapshot().sessions[0].transcriptIncomplete, undefined);
  assert.equal(readConversationLines(f.root, f.sessionId).length, 3);
  assert.equal(readFileSync(f.historyPath, 'utf8'), '{obsolete corrupt legacy fixture');
  assert.equal(readdirSync(join(f.root, 'workspace-migration-backups')).length, 2);
});

test('a missing required legacy history stops activation and can resume after restoring the exact source', async (t) => {
  const f = fixture(t);
  assert.throws(() => f.open(), /会话迁移失败/);
  assert.equal(existsSync(f.historyPath), false);
  const inspection = new WorkspaceSqliteStore(join(f.root, 'workspace.sqlite'));
  assert.equal(inspection.readState().sessions[0].id, f.sessionId);
  assert.deepEqual(inspection.readEvents(f.sessionId), []);
  assert.deepEqual(inspection.listMigrationRuns().map((run) => run.phase), ['state']);
  inspection.close();
  writeFileSync(f.historyPath, f.history);
  const workspace = f.open();
  assert.equal(workspace.snapshot().sessions[0].transcriptIncomplete, undefined);
  assert.equal(readConversationLines(f.root, f.sessionId).length, 2);
});

test('SQLite conversation replacement rolls back invalid batches and preserves session association', async (t) => {
  const f = fixture(t);
  writeFileSync(f.historyPath, f.history);
  const workspace = f.open();
  await workspace.shutdown();
  const store = new WorkspaceSqliteStore(join(f.root, 'workspace.sqlite'));
  try {
    const repository = new SqliteConversationRepository(f.root, store);
    const before = [...repository.read(f.sessionId)];
    assert.throws(() => repository.replace(f.sessionId, [before[0], JSON.stringify({ ...f.events[1], sessionId: 'foreign' })]), /存储失败/);
    assert.deepEqual([...repository.read(f.sessionId)], before);
    assert.throws(() => repository.append(f.sessionId, `${before[0]}\n${before[1]}`), /会话记录/);
    assert.deepEqual([...repository.read(f.sessionId)], before);
    repository.replace(f.sessionId, [before[0]]);
    assert.equal([...repository.read(f.sessionId)].length, 1);
  } finally { store.close(); }
});
