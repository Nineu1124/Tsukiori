import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { CodexCompactionTracker } from '../../packages/runtime-core/dist/index.js';
import {
  createWorkspaceEvent, restoreWorkspaceEvent, convertCodexNotification, normalizeRuntimeEvent,
} from '../../apps/desktop/dist/electron-main/workspace-events.js';

function context() {
  const tracker = new CodexCompactionTracker();
  return { threadId: 'thread-one', activeTurnId: 'turn-one', thinkingBlocks: new Set(), compactionTracker: () => tracker };
}

test('workspace event envelopes preserve session identity, payload versions, and import timestamps', () => {
  const payload = { schemaVersion: 3, turnId: 'turn-one', messageId: 'message-one' };
  const event = createWorkspaceEvent({ sessionId: 'session-one', type: 'assistant.message.started', payload, createdAt: 123 }, 41, { id: 'event-one', now: 999 });
  assert.deepEqual(event, { schemaVersion: 1, id: 'event-one', sequence: 41, sessionId: 'session-one', type: 'assistant.message.started', createdAt: 123, payload });
  const global = createWorkspaceEvent({ type: 'project.changed', payload: {} }, 42, { now: 999 });
  assert.equal(global.createdAt, 999);
  assert.equal('sessionId' in global, false);
  assert.notEqual(global.id, event.id);
  for (const sequence of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => createWorkspaceEvent({ type: 'x', payload: {} }, sequence));
});

test('legacy transcripts retain IDs and model payloads while future versions and cross-session rows are rejected', () => {
  const legacy = { id: 'legacy-one', sessionId: 'session-one', type: 'user.message', payload: { text: 'fixture history' } };
  const restored = restoreWorkspaceEvent(legacy, 'session-one', 7, 200);
  assert.deepEqual(restored, { ...legacy, schemaVersion: 1, sequence: 7, createdAt: 200 });
  assert.deepEqual(restoreWorkspaceEvent(restored, 'session-one', 8, 300), { ...restored, sequence: 8 });
  assert.throws(() => restoreWorkspaceEvent({ ...legacy, schemaVersion: 2 }, 'session-one', 9, 300), /不兼容/);
  assert.throws(() => restoreWorkspaceEvent(legacy, 'session-other', 9, 300), /不兼容/);
  assert.throws(() => restoreWorkspaceEvent({ ...legacy, type: {} }, 'session-one', 9, 300), /不兼容/);
});

test('Codex turn and tool projections preserve ordering, runtime IDs and existing routes', () => {
  const c = context();
  assert.deepEqual(convertCodexNotification('turn/started', { turn: { id: 'turn-native' }, turnId: 'fallback' }, c), {
    save: true, events: [{ route: 'runtime', type: 'turn.started', payload: { turnId: 'turn-native' } }],
  });
  const converted = convertCodexNotification('item/started', { item: {
    type: 'collabAgentToolCall', id: 'task-one', tool: 'spawnAgent', senderThreadId: 'thread-one', receiverThreadIds: ['child-one'],
    agentsStates: { 'child-one': { status: 'running', message: 'private child content' } }, prompt: 'private delegated prompt',
  } }, c);
  assert.deepEqual(converted.events.map(({ type }) => type), ['subagent.event', 'tool.event']);
  assert.deepEqual(converted.events.map(({ route }) => route), ['workspace', 'workspace']);
  assert.equal(converted.events[0].payload.schemaVersion, 1);
  assert.equal(converted.events[0].payload.runtimeTaskId, 'task-one');
  assert.deepEqual(converted.events[0].payload.receiverThreadIds, ['child-one']);
  assert.equal(converted.events[1].payload.toolUseId, 'task-one');
  assert.doesNotMatch(JSON.stringify(converted), /private child content|private delegated prompt/);
  for (const type of ['userMessage', 'agentMessage', 'reasoning']) {
    assert.deepEqual(convertCodexNotification('item/started', { item: { type } }, c).events, []);
  }
});

test('reasoning completion only closes matching blocks and keeps another session independent', () => {
  const a = context();
  const b = context();
  for (const c of [a, b]) {
    convertCodexNotification('item/reasoning/summaryPartAdded', { itemId: 'reason-one', summaryIndex: 0 }, c);
    convertCodexNotification('item/reasoning/summaryTextDelta', { itemId: 'reason-one', summaryIndex: 0, delta: 'summary fixture' }, c);
  }
  convertCodexNotification('item/reasoning/textDelta', { itemId: 'reason-two', contentIndex: 1, delta: 'content fixture' }, a);
  const done = convertCodexNotification('item/completed', { item: { id: 'reason-one', type: 'reasoning' } }, a);
  assert.deepEqual(done.events, [{ route: 'runtime', type: 'assistant.thinking.completed', payload: { blockId: 'codex:reason-one:summary:0', index: 'codex:reason-one:summary:0' } }]);
  assert.deepEqual([...a.thinkingBlocks], ['codex:reason-two:content:1']);
  assert.deepEqual([...b.thinkingBlocks], ['codex:reason-one:summary:0']);
});

test('invalid reasoning identities produce metadata without retaining rejected text', () => {
  for (const method of ['item/reasoning/summaryPartAdded', 'item/reasoning/summaryTextDelta', 'item/reasoning/textDelta']) {
    const c = context();
    const result = convertCodexNotification(method, { itemId: 'reason-one', summaryIndex: -1, contentIndex: 1.5, delta: 'rejected private reasoning' }, c);
    assert.equal(result.save, false);
    assert.equal(result.events[0].type, 'native.event');
    assert.equal(result.events[0].payload.redacted, true);
    assert.equal(c.thinkingBlocks.size, 0);
    assert.doesNotMatch(JSON.stringify(result), /rejected private reasoning/);
  }
});

test('unknown notifications retain a bounded metadata digest and no native values', () => {
  const params = { secret: 'synthetic private value', nested: { prompt: 'synthetic prompt' }, unicode: '月' };
  const result = convertCodexNotification('future/runtimeEvent', params, context());
  const serialized = JSON.stringify(params);
  assert.deepEqual(result.events[0], { route: 'workspace', type: 'native.event', payload: {
    nativeType: 'future/runtimeEvent', parameterKeys: ['secret', 'nested', 'unicode'],
    contentHash: 'sha256:' + createHash('sha256').update(serialized).digest('hex'),
    bytes: Buffer.byteLength(serialized, 'utf8'), redacted: true,
  } });
  assert.doesNotMatch(JSON.stringify(result), /synthetic private value|synthetic prompt/);
  const many = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`key${i}`, 'private']));
  assert.equal(convertCodexNotification('future/event', many, context()).events[0].payload.parameterKeys.length, 32);
});

test('assistant deltas retain the display budget without forcing a full state save', () => {
  const result = convertCodexNotification('item/agentMessage/delta', { delta: 'x'.repeat(32_100) }, context());
  assert.equal(result.save, false);
  assert.deepEqual(result.events.map(({ route, type }) => [route, type]), [['workspace', 'assistant.delta']]);
  assert.equal(result.events[0].payload.text, 'x'.repeat(32_000) + '\n…[truncated]');
});

test('compaction association rejects a foreign thread or turn before tracker state changes', () => {
  const c = context();
  for (const [threadId, turnId, reason] of [['foreign-thread', 'turn-one', 'thread_mismatch'], ['thread-one', 'foreign-turn', 'turn_mismatch']]) {
    const result = convertCodexNotification('thread/compacted', { threadId, turnId, unsafe: 'rejected private data' }, c);
    assert.equal(result.events[0].payload.reason, 'compaction_' + reason);
    assert.doesNotMatch(JSON.stringify(result), /rejected private data/);
  }
  assert.equal(c.compactionTracker().summary().compactionCount, 0);
  const accepted = convertCodexNotification('thread/compacted', { threadId: 'thread-one', turnId: 'turn-one' }, c);
  assert.equal(accepted.events[0].type, 'context.compacted');
  assert.equal(accepted.events[0].payload.schemaVersion, 1);
  assert.equal(accepted.events[0].payload.threadId, 'thread-one');
  assert.equal(accepted.events[0].payload.turnId, 'turn-one');
});

test('runtime errors are redacted while turn IDs and Direct API categories stay intact', () => {
  const unsafe = { message: 'authentication failure with synthetic private credential', cause: { secret: 'synthetic secret' } };
  for (const runtime of ['codex', 'claude']) {
    const error = normalizeRuntimeEvent(runtime, 'runtime.error', unsafe);
    assert.doesNotMatch(JSON.stringify(error), /synthetic|credential|secret/);
    assert.equal(typeof error.category, 'string');
    const completion = normalizeRuntimeEvent(runtime, 'turn.completed', { turnId: 'turn-original', status: 'failed', error: unsafe });
    assert.equal(completion.turnId, 'turn-original');
    assert.equal(completion.status, 'failed');
    assert.doesNotMatch(JSON.stringify(completion), /synthetic|credential|secret/);
  }
  const api = { turnId: 'api-turn', status: 'failed', error: 'API 请求过于频繁，请稍后重试。', category: 'rate_limited' };
  assert.deepEqual(normalizeRuntimeEvent('api', 'turn.completed', api), api);
  const native = convertCodexNotification('error', unsafe, context());
  assert.equal(native.events[0].type, 'runtime.error');
  assert.doesNotMatch(JSON.stringify(native), /synthetic|credential|secret/);
});
