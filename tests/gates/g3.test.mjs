import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const architecturePath = join(root, '本地多Agent工作台_完整架构与实施方案.md');
function fixture(relative) {
  return JSON.parse(readFileSync(join(root, ...relative.split('/')), 'utf8'));
}

const gate = fixture('tests/fixtures/gates/g3-evidence.json');
const alpha = fixture('tests/fixtures/opencode/t3.4-result.json');
const t31 = fixture('tests/fixtures/opencode/t3.1-result.json');
const t32 = fixture('tests/fixtures/opencode/t3.2-result.json');
const t33 = fixture('tests/fixtures/opencode/t3.3-result.json');
const g0 = fixture('tests/fixtures/gates/g0-evidence.json');
const g1 = fixture('tests/fixtures/gates/g1-evidence.json');
const contract = fixture('tests/fixtures/adapter-contract/v1/opencode.contract.json');
const matrix = fixture('tests/fixtures/opencode/1.18.4/capability-matrix.json');

test('T3.1 through T3.4 and every child Checkpoint are complete', () => {
  const architecture = readFileSync(architecturePath, 'utf8');
  for (const taskId of ['T3.1', 'T3.2', 'T3.3', 'T3.4']) {
    const section = architecture.match(new RegExp('^### ' + taskId.replace('.', '\\.') + '[\\s\\S]*?(?=^### )', 'm'));
    assert.ok(section, 'missing task section: ' + taskId);
    assert.equal(section[0].includes('- [ ]'), false, taskId + ' has an incomplete checkpoint');
    assert.equal(section[0].includes('- [x]'), true, taskId + ' has no completion evidence');
  }
  for (const commit of Object.values(gate.taskCommits)) {
    execFileSync('git', ['merge-base', '--is-ancestor', commit, 'HEAD'], { cwd: root, stdio: 'ignore' });
  }
  assert.equal(Object.values(gate.windowsCi).every((run) => run.conclusion === 'success'), true);
});

test('real DeepSeek request, permission, Diff, Commit, Archive and cleanup form one closure', () => {
  assert.equal(t31.deepSeek.realSessionCompleted, true);
  assert.equal(t31.deepSeek.destinationHost, 'api.deepseek.com');
  assert.deepEqual(gate.realDeepSeekClosure, {
    runtimeVersion: '1.18.4', compatibility: 'supported', providerId: 'dpsk',
    modelId: 'deepseek-v4-flash', destinationHost: 'api.deepseek.com', providerRequestCompleted: true,
    permissionDecisionCount: 1, runtimeModifiedBoundWorktree: true, mainWorkspaceChanged: false,
    diffReviewed: true, commitCreated: true, archiveCompleted: true, cleanupState: 'succeeded',
    persistedPromptOrSource: false,
  });
  assert.deepEqual(alpha.workflow, [
    'project', 'isolated-worktree', 'runtime-change', 'attention', 'diff', 'stage', 'commit', 'archive', 'safe-cleanup',
  ]);
  assert.equal(alpha.repeatableCleanEnvironmentRuns, 2);
  assert.equal(alpha.dirtyCleanupPreservesCode, true);
});

test('Runtime, Daemon, and GUI crash behavior is explicit and non-destructive', () => {
  assert.equal(t33.isolatedRuntimeHandles, 2);
  assert.equal(t33.unavailableSessionShownAsRunning, false);
  const assessments = Object.fromEntries(g0.recoveryAssessments.map((item) => [item.target, item]));
  assert.equal(assessments.runtime.dataDestructionObserved, false);
  assert.equal(assessments.daemon.dataDestructionObserved, false);
  assert.match(assessments.daemon.requiredRecovery, /fingerprint/);
  assert.equal(assessments.gui.dataDestructionObserved, false);
  assert.equal(g1.recovery.rendererCrashInjected, true);
  assert.equal(g1.recovery.daemonAliveAfterRendererCrash, true);
  assert.equal(g1.recovery.fakeRuntimeAliveAfterRendererCrash, true);
  assert.equal(gate.recovery.runtimeCrashIsolated, true);
  assert.equal(gate.recovery.runtimeUnavailableShownAsRunning, false);
  assert.equal(gate.recovery.daemonCrashDataDestructionObserved, false);
  assert.equal(gate.recovery.daemonRecoveryRequiresFingerprintReconciliation, true);
  assert.equal(gate.recovery.rendererCrashInjected, true);
  assert.equal(gate.recovery.daemonAliveAfterRendererCrash, true);
  assert.equal(gate.recovery.runtimeAliveAfterRendererCrash, true);
});

test('API keys, Native Events, Runtime logs, Prompt, and source are absent from Gate evidence', () => {
  const evidence = JSON.stringify({ gate, alpha, t31, t32, t33, g0, g1 });
  assert.doesNotMatch(evidence, /Bearer\\s+|Authorization|Basic\\s+[A-Za-z0-9+/=]+|-----BEGIN|sk-[A-Za-z0-9]/);
  assert.equal(gate.security.apiKeyPersisted, false);
  assert.equal(gate.security.rawNativeEventsCommitted, false);
  assert.equal(gate.security.rawRuntimeLogsCommitted, false);
  assert.equal(gate.security.publicCiRequiresProviderCredentials, false);
  assert.equal(t32.rawPayloadsCommitted, false);
  assert.equal(alpha.persistedPromptOrSource, false);
  assert.equal(gate.containsCredentials, false);
});

test('unverified capabilities remain unknown and unavailable entry points stay hidden', () => {
  const unknownCapabilities = matrix.capabilities.filter((item) => item.supportLevel === 'unknown');
  assert.ok(unknownCapabilities.some((item) => item.name === 'in_flight_turn_crash_recovery'));
  assert.ok(contract.unknowns.includes('event_replay'));
  assert.ok(contract.unknowns.includes('in_flight_turn_crash_recovery'));
  assert.deepEqual(gate.hiddenEntryPoints, ['merge', 'claude', 'acp', 'wsl', 'macos', 'linux']);
  assert.deepEqual(alpha.hiddenEntryPoints, gate.hiddenEntryPoints);
  for (const unknown of gate.unknownsPreserved) assert.equal(typeof unknown, 'string');
});