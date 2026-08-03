import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const architecture = readFileSync(join(root, '本地多Agent工作台_完整架构与实施方案.md'), 'utf8');
const ready = fixture('tests/fixtures/release/v1-ready.json');
const g5 = fixture('tests/fixtures/gates/g5-evidence.json');

function fixture(path) {
  return JSON.parse(readFileSync(join(root, path), 'utf8'));
}

function taskBlock(id) {
  const pattern = new RegExp(`^### ${id.replace('.', '\\.')} .+$`, 'm');
  const match = architecture.match(pattern);
  assert.ok(match?.index !== undefined, `missing ${id}`);
  const start = match.index;
  const next = architecture.indexOf('\n### ', start + match[0].length);
  return architecture.slice(start, next < 0 ? architecture.length : next);
}

function checkboxLines(startMarker, endMarker) {
  const start = architecture.indexOf(startMarker);
  const end = architecture.indexOf(endMarker, start);
  assert.ok(start > 0 && end > start, `${startMarker}: invalid section`);
  return architecture.slice(start, end).split(/\r?\n/)
    .filter((line) => /^- \[[ xX]\] /.test(line));
}

test('all 30 V1 tasks and all six stage gates are complete', () => {
  const counts = [4, 5, 4, 4, 5, 8];
  let taskCount = 0;
  for (let stage = 0; stage < counts.length; stage += 1) {
    for (let item = 1; item <= counts[stage]; item += 1) {
      assert.match(taskBlock(`T${stage}.${item}`), /^- \[x\] /m);
      taskCount += 1;
    }
  }
  for (let gate = 0; gate <= 5; gate += 1) {
    assert.match(taskBlock(`G${gate}`), /^- \[x\] /m);
  }
  assert.equal(taskCount, ready.completion.tasks);
  assert.equal(ready.completion.gates, 6);
});

test('all Local V1 acceptance and final readiness checks are complete', () => {
  const readyChecks = checkboxLines('## 37.0', '## 37.1');
  const acceptance = checkboxLines('## 37.1', '# 38.');
  assert.equal(readyChecks.length, ready.completion.readyChecks);
  assert.equal(acceptance.length, ready.completion.acceptanceItems);
  assert.equal([...readyChecks, ...acceptance].every((line) => line.startsWith('- [x] ')), true);
  assert.equal(ready.completion.allChecked, true);
});

test('release candidate, matrix, report, known issues, and G5 evidence are archived', () => {
  for (const path of ready.releaseEvidence) {
    assert.equal(existsSync(join(root, path)), true, path);
  }
  assert.equal(g5.gate, 'G5');
  assert.equal(g5.decision, 'pass');
  assert.equal(ready.g5ContinuousIntegration.workflow, 'windows-ci');
  assert.equal(ready.g5ContinuousIntegration.trigger, 'g5-completion-push');
  assert.equal(ready.g5ContinuousIntegration.requiredConclusion, 'success');
  assert.equal(ready.g5ContinuousIntegration.credentialFreeRegression, 'required');
  assert.equal(ready.g5ContinuousIntegration.installerLifecycle, 'required');
});

test('Local V1 signing policy remains explicit and Verified Publisher stays fail closed', () => {
  assert.equal(ready.publication.channel, 'local');
  assert.equal(ready.publication.authenticodeRequired, false);
  assert.equal(ready.publication.smartScreenWarningRequired, true);
  assert.equal(ready.publication.verifiedPublisherRemainsFailClosed, true);
  const releaseVersion = fixture('apps/desktop/package.json').version;
  const compatibility = fixture(`tests/fixtures/release/v${releaseVersion}-compatibility.json`);
  assert.equal(compatibility.publication.localV1RequiresAuthenticode, false);
  assert.equal(compatibility.publication.verifiedPublisherRequiresAuthenticode, true);
});

test('B1 through B3 stay unchecked and outside Local V1 completion', () => {
  assert.deepEqual(ready.backlogExcluded, ['B1', 'B2', 'B3']);
  for (const id of ready.backlogExcluded) assert.match(taskBlock(id), /^- \[ \] /m, id);
  assert.equal(ready.containsCredentials, false);
  assert.equal(ready.containsPrivateSigningMaterial, false);
  assert.equal(ready.containsUserSource, false);
});

test('Windows CI runs the final readiness test after G5', () => {
  const workflow = readFileSync(join(root, '.github/workflows/windows-ci.yml'), 'utf8');
  const g5Index = workflow.indexOf('npm run test:gate5');
  const readyIndex = workflow.indexOf('npm run test:v1-ready');
  assert.ok(g5Index > 0 && readyIndex > g5Index);
});
