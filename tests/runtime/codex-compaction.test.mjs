import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const { CodexCompactionTracker } = await import(
  new URL('../../packages/runtime-core/dist/index.js', import.meta.url)
);
const fixtureUrl = new URL('../fixtures/codex/0.146.0/compaction.sanitized.json', import.meta.url);
const schemaUrl = new URL('../fixtures/codex/0.146.0/codex_app_server_protocol.schemas.json', import.meta.url);
const fixture = JSON.parse(await readFile(fixtureUrl, 'utf8'));
const schemaText = await readFile(schemaUrl, 'utf8');
const schema = JSON.parse(schemaText);

test('Codex Compaction fixture is locked to the 0.146.0 Schema and remains sanitized', () => {
  assert.equal(createHash('sha256').update(schemaText).digest('hex'), fixture.schemaSha256);
  const compacted = schema.definitions.v2.ContextCompactedNotification;
  const compactedEnvelope = findSchemaByTitle(schema, 'Thread/compactedNotification');
  assert.deepEqual(compactedEnvelope.properties.method.enum, ['thread/compacted']);
  assert.equal(compactedEnvelope.properties.params.$ref, '#/definitions/v2/ContextCompactedNotification');
  assert.deepEqual(compacted.required, ['threadId', 'turnId']);
  assert.equal(fixture.notification.method, 'thread/compacted');
  for (const key of compacted.required) assert.equal(typeof fixture.notification.params[key], 'string');
  const usage = schema.definitions.v2.ThreadTokenUsageUpdatedNotification;
  const usageEnvelope = findSchemaByTitle(schema, 'Thread/tokenUsage/updatedNotification');
  assert.deepEqual(usageEnvelope.properties.method.enum, ['thread/tokenUsage/updated']);
  assert.equal(usageEnvelope.properties.params.$ref, '#/definitions/v2/ThreadTokenUsageUpdatedNotification');
  assert.deepEqual(usage.required, ['threadId', 'tokenUsage', 'turnId']);
  for (const sample of [fixture.usageBefore, fixture.usageAfter]) {
    assert.equal(sample.method, 'thread/tokenUsage/updated');
    for (const key of usage.required) assert.equal(Object.hasOwn(sample.params, key), true);
  }
  assert.equal(schemaText.includes('"contextCompaction"'), true);
  assert.doesNotMatch(JSON.stringify(fixture), /api.?key|authorization|bearer|cookie|private.?key|transcript|source.?code/i);
  assert.deepEqual(fixture.compatibility.map((entry) => [entry.runtime, entry.supportLevel]), [
    ['codex', 'supported'], ['claude-code', 'unknown'],
  ]);
});

test('Compaction projection preserves Thread/Turn identity and before/after usage deterministically', () => {
  const tracker = new CodexCompactionTracker();
  const association = { expectedThreadId: 'fixture-thread-compaction', activeTurnId: 'fixture-turn-compaction' };
  const before = tracker.ingest(fixture.usageBefore.method, fixture.usageBefore.params, association);
  const compacted = tracker.ingest(fixture.notification.method, fixture.notification.params, association);
  const after = tracker.ingest(fixture.usageAfter.method, fixture.usageAfter.params, association);
  assert.equal(before.status, 'accepted');
  assert.equal(compacted.status, 'accepted');
  assert.equal(after.status, 'accepted');
  assert.deepEqual(compacted.events.map((event) => event.type), ['context.compacted']);
  assert.deepEqual(after.events.map((event) => event.type), ['assistant.usage', 'context.compaction.updated']);
  const start = compacted.events[0].payload;
  const update = after.events[1].payload;
  assert.equal(start.threadId, association.expectedThreadId);
  assert.equal(start.turnId, association.activeTurnId);
  assert.equal(start.observedTotalTokensBefore, 12_000);
  assert.equal(update.compactionId, start.compactionId);
  assert.equal(update.observedTotalTokensAfter, 13_000);
  assert.equal(update.usageDelta, 1_000);
  assert.equal(update.association, 'same_turn');
  assert.deepEqual(tracker.summary(association.expectedThreadId), {
    compactionCount: 1, latestTotalTokens: 13_000, pendingCount: 0,
  });
  assert.doesNotMatch(JSON.stringify([...before.events, ...compacted.events, ...after.events]), /"(?:text|content|message|prompt|transcript)"\s*:/i);
});

test('Compaction projection fails closed on mismatched identities and invalid usage', () => {
  const tracker = new CodexCompactionTracker({ maxPending: 1, maxCompactions: 1 });
  assert.equal(tracker.ingest('thread/compacted', fixture.notification.params, {
    expectedThreadId: 'another-thread', activeTurnId: 'fixture-turn-compaction',
  }).reason, 'thread_mismatch');
  assert.equal(tracker.ingest('thread/compacted', fixture.notification.params, {
    expectedThreadId: 'fixture-thread-compaction', activeTurnId: 'another-turn',
  }).reason, 'turn_mismatch');
  assert.equal(tracker.ingest('thread/tokenUsage/updated', {
    threadId: 'fixture-thread-compaction', turnId: 'fixture-turn-compaction', tokenUsage: { total: { totalTokens: -1 } },
  }).reason, 'invalid_usage');
  assert.equal(tracker.ingest('thread/compacted', fixture.notification.params).status, 'accepted');
  assert.equal(tracker.ingest('thread/compacted', {
    threadId: 'fixture-thread-compaction', turnId: 'fixture-turn-second',
  }).reason, 'compaction_limit');
});

test('Compaction projection restores persisted event state without inventing Claude support', () => {
  const source = new CodexCompactionTracker();
  const events = [
    ...source.ingest(fixture.usageBefore.method, fixture.usageBefore.params).events,
    ...source.ingest(fixture.notification.method, fixture.notification.params).events,
    ...source.ingest(fixture.usageAfter.method, fixture.usageAfter.params).events,
  ];
  const restored = new CodexCompactionTracker();
  for (const event of events) restored.restore(event.type, event.payload);
  assert.deepEqual(restored.summary('fixture-thread-compaction'), {
    compactionCount: 1, latestTotalTokens: 13_000, pendingCount: 0,
  });
  assert.equal(fixture.compatibility.find((entry) => entry.runtime === 'claude-code').supportLevel, 'unknown');
});

function findSchemaByTitle(value, title) {
  if (!value || typeof value !== 'object') return null;
  if (value.title === title) return value;
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const match = findSchemaByTitle(child, title);
    if (match) return match;
  }
  return null;
}
