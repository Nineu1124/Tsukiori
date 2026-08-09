import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const { CheckpointService, CheckpointServiceError } = await import(
  new URL('../../apps/desktop/dist/electron-main/checkpoint-service.js', import.meta.url)
);

function git(cwd, args) {
  return execFileSync('git.exe', ['-C', cwd, ...args], {
    encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function transcriptLine(sessionId, id, type, payload) {
  return JSON.stringify({ id, sessionId, type, createdAt: Date.now(), payload }) + '\n';
}

function fixture(t, options = {}) {
  const temporary = mkdtempSync(join(tmpdir(), 'tsukiori-checkpoint-'));
  const repository = join(temporary, 'repository');
  const userData = join(temporary, 'user-data');
  const transcriptPath = join(temporary, 'conversation.jsonl');
  execFileSync('git.exe', ['init', '--quiet', repository]);
  git(repository, ['config', 'user.name', 'Tsukiori Test']);
  git(repository, ['config', 'user.email', 'test@tsukiori.invalid']);
  writeFileSync(join(repository, 'README.md'), 'base\n');
  git(repository, ['add', 'README.md']);
  git(repository, ['commit', '-m', 'base']);
  let id = 0;
  const service = new CheckpointService(userData, {
    id: () => `checkpoint-${++id}`,
    ...options,
  });
  t.after(() => rmSync(temporary, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }));
  return { temporary, repository, userData, transcriptPath, service };
}

test('Checkpoint preserves HEAD, index, worktree, untracked files, transcript, and an undo recovery point', (t) => {
  const f = fixture(t);
  const sessionId = 'session:checkpoint-fixture';
  writeFileSync(join(f.repository, 'README.md'), 'checkpoint staged\n');
  git(f.repository, ['add', 'README.md']);
  writeFileSync(join(f.repository, 'README.md'), 'checkpoint working\n');
  writeFileSync(join(f.repository, 'notes.txt'), 'checkpoint untracked\n');
  writeFileSync(f.transcriptPath,
    transcriptLine(sessionId, 'event-1', 'user.message', { text: 'checkpoint prompt' })
    + transcriptLine(sessionId, 'event-2', 'turn.completed', { turnId: 'turn-checkpoint', status: 'completed' }),
  );
  const checkpoint = f.service.create({
    sessionId, worktreePath: f.repository, transcriptPath: f.transcriptPath,
    label: 'Before risky change', runtimeSessionId: 'thread-checkpoint', runtimeTurnId: 'turn-checkpoint', turnCount: 1,
  });
  assert.equal(checkpoint.conversationEventCount, 2);
  assert.match(checkpoint.snapshotRef, /^refs\/tsukiori\/checkpoints\//);

  git(f.repository, ['commit', '-m', 'advance head']);
  const headAfterCheckpoint = git(f.repository, ['rev-parse', 'HEAD']);
  writeFileSync(join(f.repository, 'README.md'), 'future working state\n');
  writeFileSync(join(f.repository, 'extra.txt'), 'future untracked state\n');
  writeFileSync(f.transcriptPath, readFileSync(f.transcriptPath, 'utf8')
    + transcriptLine(sessionId, 'event-3', 'assistant.delta', { text: 'future response' }));

  const preview = f.service.preview(sessionId, checkpoint.id, f.repository, f.transcriptPath);
  assert.equal(preview.headWillMove, false);
  assert.equal(preview.conversationEventsRemoved, 1);
  assert.equal(preview.changedPaths.includes('README.md'), true);
  assert.equal(preview.changedPaths.includes('extra.txt'), true);

  const rewound = f.service.rewind({
    sessionId, checkpointId: checkpoint.id, worktreePath: f.repository, transcriptPath: f.transcriptPath,
    label: checkpoint.label, runtimeSessionId: 'thread-future', runtimeTurnId: 'turn-future', turnCount: 2,
  });
  assert.equal(git(f.repository, ['rev-parse', 'HEAD']), headAfterCheckpoint);
  assert.equal(readFileSync(join(f.repository, 'README.md'), 'utf8').replaceAll('\r\n', '\n'), 'checkpoint working\n');
  assert.equal(git(f.repository, ['show', ':README.md']), 'checkpoint staged');
  assert.equal(readFileSync(join(f.repository, 'notes.txt'), 'utf8').replaceAll('\r\n', '\n'), 'checkpoint untracked\n');
  assert.equal(existsSync(join(f.repository, 'extra.txt')), false);
  assert.equal(readFileSync(f.transcriptPath, 'utf8').includes('future response'), false);
  assert.equal(rewound.recoveryCheckpoint.kind, 'recovery');
  assert.equal(f.service.list(sessionId).length, 2);

  f.service.rewind({
    sessionId, checkpointId: rewound.recoveryCheckpoint.id,
    worktreePath: f.repository, transcriptPath: f.transcriptPath,
    label: rewound.recoveryCheckpoint.label,
    runtimeSessionId: 'thread-checkpoint', runtimeTurnId: 'turn-checkpoint', turnCount: 1,
  });
  assert.equal(readFileSync(join(f.repository, 'README.md'), 'utf8').replaceAll('\r\n', '\n'), 'future working state\n');
  assert.equal(readFileSync(join(f.repository, 'extra.txt'), 'utf8').replaceAll('\r\n', '\n'), 'future untracked state\n');
  assert.equal(readFileSync(f.transcriptPath, 'utf8').includes('future response'), true);
  assert.equal(f.service.list(sessionId).length, 3);
});

test('Checkpoint fails closed when changed files exceed the configured byte limit', (t) => {
  const f = fixture(t, { maxChangedBytes: 4 });
  const sessionId = 'session:checkpoint-limit';
  writeFileSync(join(f.repository, 'large.txt'), '12345');
  writeFileSync(f.transcriptPath, transcriptLine(sessionId, 'event-limit', 'turn.completed', { turnId: 'turn-limit' }));
  assert.throws(() => f.service.create({
    sessionId, worktreePath: f.repository, transcriptPath: f.transcriptPath,
    label: 'Too large', runtimeSessionId: 'thread-limit', runtimeTurnId: 'turn-limit', turnCount: 1,
  }), CheckpointServiceError);
  assert.equal(f.service.list(sessionId).length, 0);
});

test('Checkpoint rejects traversal IDs and malformed persisted manifests', (t) => {
  const f = fixture(t);
  const sessionId = 'session:checkpoint-manifest';
  writeFileSync(f.transcriptPath, transcriptLine(sessionId, 'event-manifest', 'turn.completed', { turnId: 'turn-manifest' }));
  const checkpoint = f.service.create({
    sessionId, worktreePath: f.repository, transcriptPath: f.transcriptPath,
    label: 'Manifest validation', runtimeSessionId: 'thread-manifest', runtimeTurnId: 'turn-manifest', turnCount: 1,
  });
  assert.throws(() => f.service.preview(sessionId, '..', f.repository, f.transcriptPath), CheckpointServiceError);

  const sessionDirectory = createHash('sha256').update(sessionId).digest('hex');
  const manifestPath = join(f.userData, 'checkpoints', sessionDirectory, `${checkpoint.id}.json`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.runtimeTurnId = 42;
  writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(
    () => f.service.preview(sessionId, checkpoint.id, f.repository, f.transcriptPath),
    (error) => error instanceof CheckpointServiceError && /Runtime Session ID/.test(error.message),
  );
  assert.equal(f.service.list(sessionId).length, 0);
});
