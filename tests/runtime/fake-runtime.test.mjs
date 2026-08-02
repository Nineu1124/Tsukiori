import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runAdapterContract } from '../contract/runtime-adapter-harness.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { FakeRuntimeAdapter } = await import(pathToFileURL(
  join(repositoryRoot, 'packages', 'adapter-fake', 'dist', 'index.js'),
).href);
const resultFixture = JSON.parse(
  readFileSync(join(repositoryRoot, 'tests', 'fixtures', 'fake-runtime', 't1.4-result.json'), 'utf8'),
);

function raw(adapter, session, nativeSequence, nativeType, payload = {}, overrides = {}) {
  return adapter.ingestRaw({
    nativeType, payload, nativeSequence,
    runtimeEventId: session.runtimeSessionId + '-' + nativeSequence,
    runtimeSessionId: session.runtimeSessionId,
    connectionEpoch: adapter.connectionEpoch,
    ...overrides,
  });
}

test('published Fake Runtime fixture covers every fault class without credentials', () => {
  assert.equal(resultFixture.oneReaderPerHandle, true);
  assert.equal(resultFixture.parallelSessions, 3);
  assert.equal(resultFixture.unknownEvent.persisted, true);
  assert.equal(resultFixture.recovery.automaticPromptReplay, false);
  assert.equal(resultFixture.containsCredentials, false);
  assert.equal(new Set(resultFixture.faultInjection).size, 7);
});

test('contract harness routes three scripted Sessions without cross-talk', () => {
  const adapter = new FakeRuntimeAdapter();
  const { sessionEvents } = runAdapterContract(adapter);
  assert.equal(sessionEvents.length, 18);
});

test('duplicate, out-of-order, backpressure, unknown, and Runtime Scope events are observable', () => {
  const adapter = new FakeRuntimeAdapter({ maxBuffered: 1 });
  const session = adapter.createSession();
  assert.equal(raw(adapter, session, 2, 'text.delta', { text: 'second' }).status, 'buffered');
  assert.equal(raw(adapter, session, 3, 'text.delta', { text: 'third' }).status, 'backpressure');
  const flushed = raw(adapter, session, 1, 'message.started');
  assert.equal(flushed.status, 'accepted');
  assert.deepEqual(flushed.events.map(({ streamSequence }) => streamSequence), [1, 2]);
  assert.equal(raw(adapter, session, 1, 'message.started').status, 'duplicate');

  const unknown = raw(adapter, session, 3, 'future.protocol.event', { safe: true });
  assert.equal(unknown.events[0].type, 'native.event');
  const runtime = adapter.runScript(session, [
    { kind: 'runtime_event', nativeType: 'runtime.state', payload: { state: 'ready' }, nativeSequence: 1 },
  ])[0];
  assert.equal(runtime.events[0].scope, 'runtime');
  assert.equal(runtime.events[0].sessionId, undefined);
});

test('connection epoch rejects stale events and accepts the reconnected stream', () => {
  const adapter = new FakeRuntimeAdapter();
  const session = adapter.createSession();
  const oldEpoch = adapter.connectionEpoch;
  raw(adapter, session, 1, 'message.started');
  adapter.disconnect();
  const stale = adapter.ingestRaw({
    nativeType: 'message.completed', payload: {}, nativeSequence: 2,
    runtimeEventId: 'old-event', runtimeSessionId: session.runtimeSessionId,
    connectionEpoch: oldEpoch,
  });
  assert.equal(stale.status, 'stale_epoch');
  assert.equal(stale.events.length, 0);
  const current = raw(adapter, session, 1, 'session.state', { activity: 'idle' });
  assert.equal(current.status, 'accepted');
  assert.notEqual(adapter.connectionEpoch, oldEpoch);
});

test('unknown events are redacted and bounded without blocking later known events', () => {
  const adapter = new FakeRuntimeAdapter({ maxPayloadBytes: 192 });
  const session = adapter.createSession();
  const secret = 'fixture-credential-value-123456';
  const unknown = raw(adapter, session, 1, 'future.large', {
    api_key: secret,
    body: 'x'.repeat(2_000),
  });
  const event = unknown.events[0];
  assert.equal(event.type, 'native.event');
  assert.equal(event.payload.redacted, true);
  assert.equal(event.payload.truncated, true);
  assert.doesNotMatch(JSON.stringify(event), /fixture-credential-value/);
  assert.ok(Buffer.byteLength(JSON.stringify(event.payload.raw), 'utf8') <= 192);

  const known = raw(adapter, session, 2, 'text.delta', { text: 'still flowing' });
  assert.equal(known.status, 'accepted');
  assert.equal(known.events[0].type, 'assistant.text_delta');
});

test('Runtime without replay produces an explainable Snapshot Recovery', () => {
  const adapter = new FakeRuntimeAdapter({ supportsEventReplay: false });
  const first = adapter.createSession();
  const second = adapter.createSession();
  adapter.runScript(first, [{ kind: 'event', nativeType: 'message.started', payload: {} }]);
  adapter.runScript(second, [{ kind: 'event', nativeType: 'permission.requested', payload: { requestId: 'r2' } }]);
  const before = adapter.events.length;
  adapter.disconnect();
  const recovery = adapter.events.slice(before);
  assert.equal(recovery.some(({ type }) => type === 'runtime.warning'), true);
  const snapshots = recovery.filter(({ type }) => type === 'session.state_changed');
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots.every(({ payload }) => payload.recoveredFromSnapshot === true), true);
  assert.equal(recovery.some(({ type }) => type === 'assistant.text_delta'), false);
});