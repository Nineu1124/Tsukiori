export type RuntimeRecoveryProjection = {
  runtimeType: string;
  state: 'snapshot_recovery' | 'unrecoverable';
  supportLevel: 'degraded' | 'unknown';
  replaySupport: 'unsupported' | 'unknown';
  snapshotSupport: 'supported' | 'unknown';
  reason: 'event_replay_unavailable' | 'runtime_recovery_unverified';
  autoReplay: false;
};

const verifiedSnapshotRuntimes = new Set(['fake', 'opencode']);

export function runtimeRecoveryProjection(runtimeType: string): RuntimeRecoveryProjection {
  const normalized = String(runtimeType ?? '').trim().toLowerCase();
  if (verifiedSnapshotRuntimes.has(normalized)) {
    return {
      runtimeType: normalized,
      state: 'snapshot_recovery',
      supportLevel: 'degraded',
      replaySupport: 'unsupported',
      snapshotSupport: 'supported',
      reason: 'event_replay_unavailable',
      autoReplay: false,
    };
  }
  return {
    runtimeType: normalized || 'unknown',
    state: 'unrecoverable',
    supportLevel: 'unknown',
    replaySupport: 'unknown',
    snapshotSupport: 'unknown',
    reason: 'runtime_recovery_unverified',
    autoReplay: false,
  };
}
