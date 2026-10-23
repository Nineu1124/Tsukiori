import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { JsonConversationRepository } from '../../apps/desktop/dist/electron-main/conversation-repository.js';
import { ModelHistoryRepository } from '../../apps/desktop/dist/electron-main/model-history-repository.js';
import { CheckpointService } from '../../apps/desktop/dist/electron-main/checkpoint-service.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'tsukiori-conversation-repository-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }));
  return { root, repository: new JsonConversationRepository(join(root, 'transcripts')) };
}

function event(sessionId, id, text = 'fixture') {
  return { schemaVersion: 1, id, sessionId, type: 'user.message', createdAt: 1, payload: { text } };
}

test('JSON repository reuses real segment rotation, replacement, restart and removal', (t) => {
  const f = fixture(t);
  const sessionId = 'session:segmented-repository';
  const text = '中'.repeat(190_000);
  for (let i = 0; i < 9; i++) f.repository.append(sessionId, JSON.stringify(event(sessionId, `event-${i}`, text)) + '\n');
  const path = f.repository.legacyPath(sessionId);
  assert.equal(path, join(f.root, 'transcripts', createHash('sha256').update(sessionId).digest('hex') + '.jsonl'));
  assert.equal(existsSync(`${path}.index.json`), true);
  assert.equal(readdirSync(join(f.root, 'transcripts')).some((name) => name.includes('.segment-')), true);
  const reopened = new JsonConversationRepository(join(f.root, 'transcripts'));
  assert.deepEqual([...reopened.read(sessionId)].map((line) => JSON.parse(line).id), Array.from({ length: 9 }, (_, i) => `event-${i}`));
  assert.equal([...reopened.read(sessionId)].every((line) => JSON.parse(line).payload.text === text), true);
  reopened.replace(sessionId, [JSON.stringify(event(sessionId, 'restored'))]);
  reopened.append(sessionId, JSON.stringify(event(sessionId, 'after-restore')));
  assert.deepEqual([...new JsonConversationRepository(join(f.root, 'transcripts')).read(sessionId)].map((line) => JSON.parse(line).id), ['restored', 'after-restore']);
  reopened.remove(sessionId);
  assert.deepEqual([...reopened.read(sessionId)], []);
  assert.equal(existsSync(`${path}.index.json`), false);
});

test('JSON repository preserves legacy logs and rejects multiline replacement before changing content', (t) => {
  const f = fixture(t);
  const sessionId = 'session:legacy';
  const old = JSON.stringify(event(sessionId, 'legacy'));
  writeFileSync(f.repository.legacyPath(sessionId), old);
  f.repository.append(sessionId, JSON.stringify(event(sessionId, 'appended')) + '\r\n');
  const before = [...f.repository.read(sessionId)];
  assert.deepEqual(before.map((line) => JSON.parse(line).id), ['legacy', 'appended']);
  assert.throws(() => f.repository.replace(sessionId, [old, `${old}\n${old}`]), /会话记录/);
  assert.deepEqual([...f.repository.read(sessionId)], before);
  f.repository.replace(sessionId, []);
  assert.deepEqual([...f.repository.read(sessionId)], []);
});

test('full model history restores independently from a 500-event UI window and ignores UI-only deltas', (t) => {
  const f = fixture(t);
  const sessionId = 'session:complete-model-history';
  const history = new ModelHistoryRepository();
  const ui = [];
  for (let i = 0; i < 530; i++) {
    const row = event(sessionId, `event-${i}`, `message-${i}`);
    history.appendEvent(sessionId, row);
    f.repository.append(sessionId, JSON.stringify(row));
    ui.push(row);
    if (ui.length > 500) ui.shift();
  }
  history.appendEvent(sessionId, { type: 'assistant.delta', createdAt: 2, payload: { text: 'display-only fixture' } });
  assert.equal(ui.length, 500);
  assert.equal(history.get(sessionId).length, 530);
  const restarted = new ModelHistoryRepository();
  for (const line of f.repository.read(sessionId)) restarted.appendEvent(sessionId, JSON.parse(line));
  assert.deepEqual(restarted.get(sessionId), history.get(sessionId));
  assert.equal(restarted.get(sessionId)[0].content, 'message-0');
  assert.equal(restarted.get(sessionId).at(-1).content, 'message-529');
  const branch = structuredClone(restarted.get(sessionId));
  restarted.set('session:branch', branch);
  branch[0].content = 'branch-only edit';
  assert.equal(restarted.get(sessionId)[0].content, 'message-0');
  assert.equal(restarted.delete('session:branch'), true);
  assert.equal(restarted.get('session:branch'), undefined);
});

test('model messages remain memory-only unless the caller chooses to persist conversation', (t) => {
  const f = fixture(t);
  const history = new ModelHistoryRepository();
  const sessionId = 'session:memory';
  history.appendEvent(sessionId, event(sessionId, 'memory-only', 'private memory fixture'));
  history.appendEvent(sessionId, { type: 'api.assistant.message', createdAt: 2, payload: { message: {
    role: 'assistant', content: [{ type: 'text', text: 'complete fixture answer' }],
    api: 'openai-completions', provider: 'fixture', model: 'fixture', timestamp: 2, stopReason: 'stop',
  } } });
  assert.equal(history.get(sessionId).length, 2);
  assert.equal(history.get(sessionId)[1].content[0].text, 'complete fixture answer');
  assert.deepEqual(readdirSync(join(f.root, 'transcripts')), []);
  assert.deepEqual([...f.repository.read(sessionId)], []);
  history.appendEvent('session:ignored', { type: 'tool.event', createdAt: 2, payload: {} });
  assert.equal(history.get('session:ignored'), undefined);
});

function checkpointFixture(t, conversation) {
  const f = fixture(t);
  const worktreePath = join(f.root, 'repository');
  const git = (...args) => execFileSync('git.exe', args, { encoding: 'utf8', windowsHide: true, stdio: 'pipe' });
  git('init', '--quiet', worktreePath);
  git('-C', worktreePath, 'config', 'user.name', 'Fixture');
  git('-C', worktreePath, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(worktreePath, 'README.md'), 'fixture\n');
  git('-C', worktreePath, 'add', '.');
  git('-C', worktreePath, 'commit', '-qm', 'fixture');
  let id = 0;
  const userData = join(f.root, 'user-data');
  const service = new CheckpointService(userData, { conversation, id: () => `checkpoint-${++id}` });
  return { ...f, service, worktreePath, userData };
}

test('Checkpoint injects live conversation reads and replacements while verifying its own backup hash', (t) => {
  const sessionId = 'session:repository-checkpoint';
  const first = JSON.stringify(event(sessionId, 'first'));
  const second = JSON.stringify(event(sessionId, 'second'));
  let current = [first];
  const reads = [];
  const replacements = [];
  const f = checkpointFixture(t, {
    read(id) { reads.push(id); return current; },
    replace(id, lines) { replacements.push({ id, lines: [...lines] }); current = [...lines]; },
  });
  const transcriptPath = f.repository.legacyPath(sessionId);
  writeFileSync(transcriptPath, 'legacy sentinel that must not be read or overwritten');
  const input = { sessionId, worktreePath: f.worktreePath, transcriptPath, label: 'fixture', turnCount: 1 };
  const checkpoint = f.service.create(input);
  assert.equal(checkpoint.conversationEventCount, 1);
  const backupPath = join(f.userData, 'checkpoints', createHash('sha256').update(sessionId).digest('hex'), checkpoint.conversationFile);
  assert.equal(readFileSync(backupPath, 'utf8'), first + '\n');
  current = [first, second];
  assert.equal(f.service.preview(sessionId, checkpoint.id, f.worktreePath, transcriptPath).conversationEventsRemoved, 1);
  const result = f.service.rewind({ ...input, checkpointId: checkpoint.id });
  assert.deepEqual(replacements, [{ id: sessionId, lines: [first] }]);
  assert.deepEqual(current, [first]);
  assert.equal(result.recoveryCheckpoint.conversationEventCount, 2);
  assert.equal(readFileSync(transcriptPath, 'utf8'), 'legacy sentinel that must not be read or overwritten');
  assert.equal(reads.length >= 4, true);
  assert.equal(reads.every((id) => id === sessionId), true);

  writeFileSync(backupPath, JSON.stringify(event(sessionId, 'tampered')) + '\n');
  assert.throws(() => f.service.rewind({ ...input, checkpointId: checkpoint.id }), /回退未完成/);
  assert.equal(replacements.length, 1);
  assert.deepEqual(current, [first]);
});

test('injected Checkpoint reads retain session identity and size limits', (t) => {
  const sessionId = 'session:repository-boundary';
  let current = [JSON.stringify(event('session:foreign', 'bad'))];
  const f = checkpointFixture(t, { read: () => current, replace: () => assert.fail('unexpected replace') });
  const input = { sessionId, worktreePath: f.worktreePath, transcriptPath: 'unused', label: 'fixture', turnCount: 1 };
  assert.throws(() => f.service.create(input), /事件身份无效/);
  current = [JSON.stringify(event(sessionId, 'oversized', 'x'.repeat(8 * 1024 * 1024)))];
  assert.throws(() => f.service.create(input), /8 MiB/);
  assert.equal(f.service.list(sessionId).length, 0);
});
