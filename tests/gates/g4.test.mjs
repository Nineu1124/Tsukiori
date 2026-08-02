import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const architecture = readFileSync(join(root, '本地多Agent工作台_完整架构与实施方案.md'), 'utf8');
function fixture(relative) { return JSON.parse(readFileSync(join(root, ...relative.split('/')), 'utf8')); }
const gate = fixture('tests/fixtures/gates/g4-evidence.json');
const openCodeContract = fixture('tests/fixtures/adapter-contract/v1/opencode.contract.json');
const codexContract = fixture('tests/fixtures/adapter-contract/v1/codex.contract.json');
const dual = fixture('tests/fixtures/dual-runtime/t4.5-result.json');
const git = fixture('tests/fixtures/git/t4.4-result.json');
const permission = fixture('tests/fixtures/permission/t1.5-result.json');
const native = fixture('tests/fixtures/codex/t4.3-result.json');

test('T4.1 through T4.5 and every child Checkpoint are complete with successful CI', () => {
  for (const taskId of ['T4.1', 'T4.2', 'T4.3', 'T4.4', 'T4.5']) {
    const section = architecture.match(new RegExp('^### ' + taskId.replace('.', '\\.') + '[\\s\\S]*?(?=^### )', 'm'));
    assert.ok(section, 'missing task section: ' + taskId);
    assert.equal(section[0].includes('- [ ]'), false, taskId + ' has incomplete Checkpoints');
    execFileSync('git', ['merge-base', '--is-ancestor', gate.taskCommits[taskId], 'HEAD'], { cwd: root, stdio: 'ignore' });
    assert.equal(gate.windowsCi[taskId].conclusion, 'success');
  }
});

test('OpenCode and Codex Adapter Contract v1 evidence is complete and credential-free', () => {
  assert.equal(openCodeContract.schemaVersion, 1);
  assert.equal(openCodeContract.runtime.type, 'opencode');
  assert.equal(codexContract.schemaVersion, 1);
  assert.equal(codexContract.runtime.type, 'codex');
  assert.equal(gate.adapterContracts.credentialFreeCi, true);
  assert.ok(openCodeContract.capabilities.length >= 5);
  assert.ok(codexContract.capabilities.length >= 5);
});

test('dual Runtime, Git integration, and Permission evidence all pass without contamination', () => {
  assert.equal(dual.parallelSessions, 3);
  assert.equal(dual.eventCrossTalkObserved, false);
  assert.equal(dual.codeCrossContaminationObserved, false);
  assert.equal(dual.mainWorkspaceChanged, false);
  assert.equal(git.integration.mainWorkspaceModified, false);
  assert.equal(git.integration.mergeVerified, true);
  assert.equal(git.integration.rebaseVerified, true);
  assert.ok(permission.decisions.includes('allow_once'));
  assert.ok(permission.attentionKinds.includes('waiting_permission'));
  assert.equal(permission.oldConnectionEpochResponsesRejected, true);
  assert.equal(gate.integration.permissionTests, true);
});

test('Claude, ACP, WSL, macOS, and Linux remain non-blocking backlog items', () => {
  assert.deepEqual(gate.nonBlockingBacklog, ['claude', 'acp', 'wsl', 'macos', 'linux']);
  for (const backlogId of ['B1', 'B2', 'B3']) {
    const section = architecture.match(new RegExp('^### ' + backlogId + '[\\s\\S]*?(?=^### |^## )', 'm'));
    assert.ok(section, 'missing backlog section: ' + backlogId);
    assert.equal(section[0].includes('- [ ]'), true, backlogId + ' must remain future work');
  }
  const g4 = architecture.match(/^### G4[\s\S]*?(?=^## )/m)?.[0] ?? '';
  for (const name of gate.nonBlockingBacklog) assert.equal(g4.toLowerCase().includes(name), true);
});

test('experimental, degraded, unsupported, and unknown capability states remain distinct in UI evidence', () => {
  assert.deepEqual(native.presentationSupportLevels, gate.supportLevelsVisible);
  assert.equal(native.sandbox.securityClaim, 'not_inferred');
  assert.equal(native.nativeCapabilitiesPromotedToCommon, false);
  const serialized = JSON.stringify({ gate, openCodeContract, codexContract, dual, git, permission, native });
  assert.doesNotMatch(serialized, /Bearer\\s+|Authorization|Basic\\s+[A-Za-z0-9+/=]+|-----BEGIN|sk-[A-Za-z0-9]/);
  assert.equal(gate.containsCredentials, false);
  assert.equal(gate.containsSourceOrPrompt, false);
});