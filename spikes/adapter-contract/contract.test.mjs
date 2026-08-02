import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import {
  enforcementLevels,
  readJson,
  repositoryRoot,
  supportLevels,
  validateRuntimeContract,
} from './lib.mjs';

const fixtureDirectory = join(
  repositoryRoot,
  'tests',
  'fixtures',
  'adapter-contract',
  'v1',
);

test('OpenCode and Codex evidence use the same v1 contract harness', async () => {
  const contracts = await Promise.all([
    validateRuntimeContract(join(fixtureDirectory, 'opencode.contract.json')),
    validateRuntimeContract(join(fixtureDirectory, 'codex.contract.json')),
  ]);

  assert.deepEqual(
    contracts.map(({ runtime }) => runtime.type).sort(),
    ['codex', 'opencode'],
  );
  assert.equal(contracts.every(({ unknowns }) => unknowns.length > 0), true);
  assert.equal(
    contracts.flatMap(({ capabilities }) => capabilities)
      .filter(({ supportLevel }) => supportLevel === 'unknown')
      .every(({ commitment }) => commitment === 'not_committed'),
    true,
  );
});

test('JSON Schema freezes support and enforcement vocabularies', async () => {
  const schema = await readJson(
    join(repositoryRoot, 'contracts', 'runtime-adapter-contract.v1.schema.json'),
  );
  assert.equal(schema.properties.schemaVersion.const, 1);
  assert.deepEqual(
    new Set(schema.$defs.supportLevel.enum),
    supportLevels,
  );
  assert.deepEqual(
    new Set(schema.$defs.enforcementLevel.enum),
    enforcementLevels,
  );
  assert.equal(schema.$defs.capability.additionalProperties, false);
});

test('compatibility matrix covers every enforcement knowledge state', async () => {
  const matrix = await readJson(join(fixtureDirectory, 'compatibility-matrix.json'));
  assert.equal(matrix.schemaVersion, 1);
  for (const level of ['interceptable', 'observable_only', 'opaque', 'unknown']) {
    assert.ok(matrix.enforcementCoverage[level].length > 0, 'missing coverage: ' + level);
  }
  assert.match(matrix.v1Commitment, /^none;/);

  for (const row of matrix.permissionAndVisibility) {
    assert.equal(supportLevels.has(row.supportLevel), true);
    assert.equal(enforcementLevels.has(row.enforcementLevel), true);
    if (row.supportLevel === 'unknown') {
      assert.equal(row.enforcementLevel, 'unknown');
    }
  }
});

test('ADR records boundaries, safe defaults, and every Stage 0 failure decision', async () => {
  const adr = await readFile(
    join(repositoryRoot, 'docs', 'adr', '0001-runtime-adapter-contract-baseline.md'),
    'utf8',
  );

  for (const phrase of [
    'Control Plane',
    'Handle Event Stream',
    'Runtime Scope',
    'interceptable',
    'observable_only',
    'opaque',
    'unknown',
    'OpenCode 1.18.4',
    'Codex 0.142.5',
    'CurrentUserOnly',
    'PID reuse',
  ]) {
    assert.equal(adr.includes(phrase), true, 'ADR is missing: ' + phrase);
  }
});
