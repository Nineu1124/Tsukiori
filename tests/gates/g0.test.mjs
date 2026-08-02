import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDirectory, '..', '..');
const architecturePath = join(repositoryRoot, '本地多Agent工作台_完整架构与实施方案.md');

async function readJson(...segments) {
  return JSON.parse(await readFile(join(repositoryRoot, ...segments), 'utf8'));
}

test('T0.1 through T0.4 are complete before G0', async () => {
  const architecture = await readFile(architecturePath, 'utf8');
  for (const taskId of ['T0.1', 'T0.2', 'T0.3', 'T0.4']) {
    const escaped = taskId.replace('.', '\\.');
    const section = architecture.match(
      new RegExp('^### ' + escaped + '[\\s\\S]*?(?=^### )', 'm'),
    );
    assert.ok(section, 'missing task section: ' + taskId);
    assert.equal(section[0].includes('- [ ]'), false, taskId + ' has an incomplete checkpoint');
    assert.equal(section[0].includes('- [x]'), true, taskId + ' has no completion evidence');
  }
});

test('both Runtime contracts separate control commands from Handle events', async () => {
  for (const runtime of ['opencode', 'codex']) {
    const contract = await readJson(
      'tests',
      'fixtures',
      'adapter-contract',
      'v1',
      runtime + '.contract.json',
    );
    assert.equal(contract.boundaries.oneReaderPerHandle, true);
    assert.notEqual(contract.boundaries.controlChannel, contract.boundaries.eventChannel);
    assert.match(contract.boundaries.controlChannel, /request|JSON-RPC/i);
    assert.match(contract.boundaries.eventChannel, /SSE|reader/i);
  }
});

test('permission matrix covers interceptable, observable, opaque, and unknown', async () => {
  const matrix = await readJson(
    'tests',
    'fixtures',
    'adapter-contract',
    'v1',
    'compatibility-matrix.json',
  );
  for (const level of ['interceptable', 'observable_only', 'opaque', 'unknown']) {
    assert.ok(matrix.enforcementCoverage[level].length > 0, 'missing ' + level);
  }
});

test('GUI, daemon, and Runtime crash outcomes are explained without destructive recovery', async () => {
  const windows = await readJson(
    'tests',
    'fixtures',
    'windows',
    'control-plane-result.json',
  );
  const gate = await readJson(
    'tests',
    'fixtures',
    'gates',
    'g0-evidence.json',
  );

  assert.equal(windows.crash.expected, true);
  assert.deepEqual(
    windows.crash.scenarios.map(({ target }) => target).sort(),
    ['daemon', 'gui', 'runtime'],
  );
  assert.deepEqual(
    gate.recoveryAssessments.map(({ target }) => target).sort(),
    ['daemon', 'gui', 'runtime'],
  );
  for (const assessment of gate.recoveryAssessments) {
    const observed = windows.crash.scenarios.find(({ target }) => target === assessment.target);
    assert.equal(assessment.observedState, observed.state);
    assert.equal(assessment.dataDestructionObserved, false);
    assert.ok(assessment.requiredRecovery.length > 20);
  }

  const opencode = await readJson(
    'tests',
    'fixtures',
    'adapter-contract',
    'v1',
    'opencode.contract.json',
  );
  const inFlight = opencode.capabilities.find(
    ({ name }) => name === 'in_flight_turn_crash_recovery',
  );
  assert.equal(inFlight.supportLevel, 'unknown');
  assert.equal(inFlight.commitment, 'not_committed');
});

test('versioned ADR, Schema, fixtures, and successful T0.4 CI evidence are tracked', async () => {
  const required = [
    'contracts/runtime-adapter-contract.v1.schema.json',
    'docs/adr/0001-runtime-adapter-contract-baseline.md',
    'tests/fixtures/adapter-contract/v1/opencode.contract.json',
    'tests/fixtures/adapter-contract/v1/codex.contract.json',
    'tests/fixtures/adapter-contract/v1/compatibility-matrix.json',
  ];
  const tracked = new Set(
    execFileSync('git', ['ls-files'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    }).split(/\r?\n/).filter(Boolean),
  );
  for (const path of required) {
    assert.equal(tracked.has(path), true, 'untracked Gate input: ' + path);
  }

  const gate = await readJson('tests', 'fixtures', 'gates', 'g0-evidence.json');
  assert.equal(gate.t04Ci.conclusion, 'success');
  assert.match(gate.taskCommits['T0.4'], /^[a-f0-9]{40}$/);
  execFileSync(
    'git',
    ['merge-base', '--is-ancestor', gate.taskCommits['T0.4'], 'HEAD'],
    { cwd: repositoryRoot, stdio: 'ignore' },
  );
  assert.equal(gate.security.rawRuntimePayloadsCommitted, false);
  assert.equal(gate.security.providerCredentialsRequiredInCi, false);
  assert.equal(gate.security.worktreeDescribedAsSandbox, false);
});
