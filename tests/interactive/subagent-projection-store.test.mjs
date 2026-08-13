import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const { SubagentProjectionStore } = await import(
  new URL('../../apps/desktop/dist/electron-main/subagent-projection-store.js', import.meta.url)
);

function event(overrides = {}) {
  return {
    eventId: 'event-1', sequence: 1, sessionId: 'session-safe', runtimeType: 'codex',
    createdAt: 1_000,
    payload: {
      schemaVersion: 1, runtimeEventType: 'subagent_start',
      runtimeSubagentId: 'agent-shared', status: 'running', name: 'Reviewer',
      prompt: 'must-not-enter-projection', message: 'must-not-enter-projection',
      transcript_path: 'C:\\private\\transcript.jsonl',
    },
    ...overrides,
  };
}

test('Subagent lifecycle projection is source-isolated, ordered, persistent, and sanitized', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tsukiori-subagent-projection-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new SubagentProjectionStore(directory);

  store.apply(event());
  assert.equal(store.list()[0].status, 'started');
  store.apply(event({
    eventId: 'event-2', sequence: 2, createdAt: 2_000,
    payload: { runtimeEventType: 'subagent_progress', runtimeSubagentId: 'agent-shared', status: 'running' },
  }));
  assert.equal(store.list()[0].status, 'progress');
  store.apply(event({
    eventId: 'event-stale', sequence: 1, createdAt: 1_500,
    payload: { runtimeEventType: 'subagent_failed', runtimeSubagentId: 'agent-shared', status: 'failed' },
  }));
  assert.equal(store.list()[0].status, 'progress');
  store.apply(event({
    eventId: 'event-3', sequence: 3, createdAt: 3_000,
    payload: { runtimeEventType: 'subagent_stop', runtimeSubagentId: 'agent-shared', status: 'completed' },
  }));
  store.apply(event({
    eventId: 'event-4', sequence: 4, createdAt: 4_000,
    payload: { runtimeEventType: 'subagent_failed', runtimeSubagentId: 'agent-failed', status: 'failed' },
  }));
  store.apply(event({
    eventId: 'event-5', sequence: 5, createdAt: 5_000,
    payload: { runtimeEventType: 'subagent_waiting', runtimeSubagentId: 'agent-waiting', status: 'waiting' },
  }));
  store.apply(event({
    eventId: 'event-6', sequence: 6, createdAt: 6_000,
    payload: { runtimeEventType: 'subagent_action_needed', runtimeSubagentId: 'agent-action', status: 'requires_action' },
  }));
  store.apply(event({
    eventId: 'event-7', sequence: 7, createdAt: 7_000, runtimeType: 'claude',
    payload: { runtimeEventType: 'subagent_start', runtimeSubagentId: 'agent-shared', status: 'running' },
  }));

  const records = store.list();
  assert.equal(records.length, 5);
  assert.equal(records.filter((record) => record.runtimeId === 'agent-shared').length, 2);
  assert.deepEqual(store.attention().map((item) => item.kind).sort(), [
    'subagent_action_needed', 'subagent_failed', 'subagent_waiting',
  ]);
  assert.equal(store.attention().some((item) => item.payload.runtimeId === 'agent-shared'), false);

  const reopened = new SubagentProjectionStore(directory);
  assert.deepEqual(reopened.list(), records);
  assert.deepEqual(reopened.attention(), store.attention());
  const persisted = readFileSync(join(directory, 'subagent-projections-v1.json'), 'utf8');
  assert.doesNotMatch(persisted, /must-not-enter|private|transcript|prompt|message/i);
});

test('invalid projection files and identifiers fail closed', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tsukiori-subagent-invalid-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'subagent-projections-v1.json'), JSON.stringify({
    schemaVersion: 1,
    records: [{ schemaVersion: 1, id: 'subagent:not-a-hash', source: 'runtime', prompt: 'unsafe' }],
  }));
  const store = new SubagentProjectionStore(directory);
  assert.deepEqual(store.list(), []);
  assert.deepEqual(store.apply(event({
    eventId: 'bad event with spaces',
    payload: { runtimeEventType: 'subagent_failed', runtimeSubagentId: 'bad id with spaces', status: 'failed' },
  })), []);
  assert.deepEqual(store.attention(), []);
});
