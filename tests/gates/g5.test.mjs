import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const architecture = readFileSync(join(root, '本地多Agent工作台_完整架构与实施方案.md'), 'utf8');
const evidence = fixture('tests/fixtures/gates/g5-evidence.json');
const compatibility = fixture('tests/fixtures/release/v1.0.0-rc.1-compatibility.json');

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

test('T0.1 through T5.5 and G0 through G5 are complete', () => {
  const counts = [4, 5, 4, 4, 5, 5];
  for (let stage = 0; stage < counts.length; stage += 1) {
    const count = counts[stage];
    assert.ok(count !== undefined);
    for (let item = 1; item <= count; item += 1) {
      assert.match(taskBlock(`T${stage}.${item}`), /^- \[x\] /m, `T${stage}.${item}`);
    }
  }
  for (let gate = 0; gate <= 5; gate += 1) {
    assert.match(taskBlock(`G${gate}`), /^- \[x\] /m, `G${gate}`);
  }
});

test('all Local V1 acceptance items in sections 37.1 through 37.8 are checked and evidenced', () => {
  const start = architecture.indexOf('## 37.1');
  const end = architecture.indexOf('# 38.', start);
  assert.ok(start > 0 && end > start);
  const items = architecture.slice(start, end).split(/\r?\n/)
    .filter((line) => /^- \[[ xX]\] \[/.test(line));
  assert.equal(items.length, evidence.acceptance.items);
  assert.equal(items.every((line) => line.startsWith('- [x] ')), true);
  const index = fixture('tests/fixtures/release/v1-acceptance-evidence.json');
  for (const line of items) {
    const ids = [...line.matchAll(/T\d+\.\d+|G\d+/g)].map((match) => match[0]);
    assert.ok(ids.length > 0, line);
    for (const id of ids) {
      const paths = index.evidence[id];
      assert.ok(Array.isArray(paths) && paths.length > 0, `${id}: missing evidence`);
      for (const path of paths) assert.equal(existsSync(join(root, path)), true, path);
    }
  }
});

test('Local V1 allows unsigned NSIS without weakening the Verified Publisher channel', () => {
  assert.equal(compatibility.publication.channel, 'local');
  assert.equal(compatibility.publication.localV1RequiresAuthenticode, false);
  assert.equal(compatibility.publication.verifiedPublisherRequiresAuthenticode, true);
  assert.equal(compatibility.publication.unsignedSmartScreenWarningRequired, true);
  assert.deepEqual(evidence.releasePolicy.integrity, [
    'sha256', 'ed25519-release-manifest', 'https-origin', 'channel', 'database-schema',
  ]);
  const config = readFileSync(join(root, 'apps/desktop/electron-builder.config.cjs'), 'utf8');
  assert.match(config, /TSUKIORI_REQUIRE_CODE_SIGNING === '1'/);
  assert.match(config, /forceCodeSigning: requireSigning/);
  const adr = readFileSync(join(root, 'docs/adr/0003-windows-local-release-signing-policy.md'), 'utf8');
  assert.match(adr, /允许 Authenticode 状态为 `NotSigned`/);
  assert.match(adr, /Verified Publisher/);
});

test('severe issue counts are zero and B1 through B3 remain excluded', () => {
  assert.deepEqual(evidence.unresolvedSevereIssues, {
    security: 0,
    dataLoss: 0,
    wrongProcessTermination: 0,
  });
  assert.deepEqual(evidence.backlogExcluded, ['B1', 'B2', 'B3']);
  for (const id of evidence.backlogExcluded) assert.match(taskBlock(id), /^- \[ \] /m, id);
  assert.equal(evidence.containsCredentials, false);
  assert.equal(evidence.containsPrivateSigningMaterial, false);
  assert.equal(evidence.containsUserSource, false);
});

test('the final clean Windows CI evidence includes regression and installer success', () => {
  assert.equal(evidence.continuousIntegration.runId, 30750424400);
  assert.match(evidence.continuousIntegration.headSha, /^[a-f0-9]{40}$/);
  assert.equal(evidence.continuousIntegration.credentialFreeRegression, 'success');
  assert.equal(evidence.continuousIntegration.installerLifecycle, 'success');
  const workflow = readFileSync(join(root, '.github/workflows/windows-ci.yml'), 'utf8');
  assert.match(workflow, /npm run test:gate5/);
  assert.match(workflow, /verify-windows-release-candidate\.ps1/);
});
