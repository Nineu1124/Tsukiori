import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

const { ThinkingBlockProjector } = await import(
  new URL('../../packages/runtime-core/dist/index.js', import.meta.url)
);

test('interleaved Thinking blocks retain isolated indexes and replayable lifecycle order', () => {
  const projector = new ThinkingBlockProjector({ maxCapturedBytes: 8, maxActiveBlocks: 4 });
  const events = [];
  const ingest = (type, payload) => {
    const result = projector.ingest(type, payload);
    assert.equal(result.status, 'accepted');
    events.push(...result.events);
  };
  ingest('assistant.thinking.started', { index: 0 });
  ingest('assistant.thinking.started', { index: 1 });
  ingest('assistant.thinking.delta', { index: 0, text: 'alpha' });
  ingest('assistant.thinking.delta', { index: 1, text: 'βeta' });
  ingest('assistant.thinking.delta', { index: 0, text: '-omega' });
  ingest('assistant.thinking.completed', { index: 1 });
  ingest('assistant.thinking.completed', { index: 0 });

  assert.deepEqual(events.map((event) => [event.type, event.payload.blockId]), [
    ['assistant.thinking.started', '0'],
    ['assistant.thinking.started', '1'],
    ['assistant.thinking.delta', '0'],
    ['assistant.thinking.delta', '1'],
    ['assistant.thinking.delta', '0'],
    ['assistant.thinking.completed', '1'],
    ['assistant.thinking.completed', '0'],
  ]);
  const completed = events.filter((event) => event.type === 'assistant.thinking.completed');
  assert.deepEqual(completed.map((event) => ({
    blockId: event.payload.blockId,
    chunkCount: event.payload.chunkCount,
    totalBytes: event.payload.totalBytes,
    capturedBytes: event.payload.capturedBytes,
    truncated: event.payload.truncated,
    contentPersisted: event.payload.contentPersisted,
  })), [
    { blockId: '1', chunkCount: 1, totalBytes: 5, capturedBytes: 5, truncated: false, contentPersisted: false },
    { blockId: '0', chunkCount: 2, totalBytes: 11, capturedBytes: 8, truncated: true, contentPersisted: false },
  ]);
  assert.equal(completed[0].payload.contentSha256, createHash('sha256').update('βeta').digest('hex'));
  assert.equal(completed[1].payload.contentSha256, createHash('sha256').update('alpha-omega').digest('hex'));
  assert.equal(JSON.stringify(completed).includes('alpha-omega'), false);
  assert.deepEqual(projector.snapshot(), []);
});

test('Thinking blocks fail closed on ambiguous or invalid order and finalize active blocks without content', () => {
  const projector = new ThinkingBlockProjector({ maxCapturedBytes: 256, maxActiveBlocks: 2 });
  assert.equal(projector.ingest('assistant.thinking.started', { index: 0 }).status, 'accepted');
  assert.equal(projector.ingest('assistant.thinking.delta', { text: 'single active compatibility' }).status, 'accepted');
  assert.equal(projector.ingest('assistant.thinking.started', { index: 1 }).status, 'accepted');
  assert.deepEqual(projector.ingest('assistant.thinking.delta', { text: 'ambiguous' }), {
    status: 'rejected', reason: 'invalid_index', events: [],
  });
  assert.equal(projector.ingest('assistant.thinking.started', { index: 2 }).reason, 'active_limit');
  const finalized = projector.finalizeAll('turn_failed');
  assert.equal(finalized.length, 2);
  for (const event of finalized) {
    assert.equal(event.type, 'assistant.thinking.completed');
    assert.equal(event.payload.status, 'incomplete');
    assert.equal(event.payload.completionReason, 'turn_failed');
    assert.equal(event.payload.contentPersisted, false);
    assert.equal(Object.hasOwn(event.payload, 'text'), false);
  }
  assert.equal(projector.ingest('assistant.thinking.completed', { index: 0 }).reason, 'already_completed');
});

test('Thinking blocks enforce a bounded total count across sequential blocks', () => {
  const projector = new ThinkingBlockProjector({ maxCapturedBytes: 32, maxActiveBlocks: 1, maxBlocks: 2 });
  for (const index of [0, 1]) {
    assert.equal(projector.ingest('assistant.thinking.started', { index }).status, 'accepted');
    assert.equal(projector.ingest('assistant.thinking.completed', { index }).status, 'accepted');
  }
  assert.deepEqual(projector.ingest('assistant.thinking.started', { index: 2 }), {
    status: 'rejected', reason: 'block_limit', events: [],
  });
});
