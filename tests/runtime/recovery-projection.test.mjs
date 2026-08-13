import assert from 'node:assert/strict';
import test from 'node:test';

const { EventNormalizer, runtimeRecoveryProjection } = await import(
  new URL('../../packages/runtime-core/dist/index.js', import.meta.url)
);

test('Runtime recovery matrix preserves verified Snapshot support and unknown Runtime facts', () => {
  for (const runtimeType of ['fake', 'opencode']) {
    assert.deepEqual(runtimeRecoveryProjection(runtimeType), {
      runtimeType,
      state: 'snapshot_recovery',
      supportLevel: 'degraded',
      replaySupport: 'unsupported',
      snapshotSupport: 'supported',
      reason: 'event_replay_unavailable',
      autoReplay: false,
    });
  }
  for (const runtimeType of ['claude', 'codex']) {
    assert.deepEqual(runtimeRecoveryProjection(runtimeType), {
      runtimeType,
      state: 'unrecoverable',
      supportLevel: 'unknown',
      replaySupport: 'unknown',
      snapshotSupport: 'unknown',
      reason: 'runtime_recovery_unverified',
      autoReplay: false,
    });
  }
});

test('EventNormalizer refuses to manufacture Snapshot Recovery for unverified Runtimes', () => {
  const normalizer = new EventNormalizer({
    runtimeHandleId: 'fixture-handle', runtimeType: 'claude',
    streamId: 'fixture-stream', connectionEpoch: 'fixture-epoch',
  });
  assert.throws(() => normalizer.snapshotRecovery([]), /Snapshot Recovery is unverified: claude/);
});

test('verified Snapshot Recovery emits the common recovery projection without replaying content', () => {
  const normalizer = new EventNormalizer({
    runtimeHandleId: 'fixture-handle', runtimeType: 'opencode',
    streamId: 'fixture-stream', connectionEpoch: 'fixture-epoch',
  });
  const [warning, session] = normalizer.snapshotRecovery([{
    sessionId: 'fixture-runtime-session', hostSessionId: 'fixture-host-session',
    activity: 'stopped', health: 'recovery_required',
  }]);
  assert.equal(warning.type, 'runtime.warning');
  assert.deepEqual(warning.payload, {
    runtimeType: 'opencode', state: 'snapshot_recovery', supportLevel: 'degraded',
    replaySupport: 'unsupported', snapshotSupport: 'supported',
    reason: 'event_replay_unavailable', autoReplay: false, mode: 'snapshot_recovery',
  });
  assert.equal(session.payload.recoveredFromSnapshot, true);
});
