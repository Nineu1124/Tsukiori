import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = resolve(currentDirectory, '..', '..');

export const supportLevels = new Set([
  'supported',
  'experimental',
  'degraded',
  'unsupported',
  'unknown',
]);

export const enforcementLevels = new Set([
  'runtime_sandbox',
  'os_sandbox',
  'interceptable',
  'observable_only',
  'opaque',
  'unknown',
]);

export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function sha256File(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

function assertInsideRepository(relativePath) {
  const absolutePath = resolve(repositoryRoot, relativePath);
  assert.ok(
    absolutePath.startsWith(repositoryRoot + sep),
    'evidence path must stay inside the repository',
  );
  return absolutePath;
}

function validateCapability(capability) {
  assert.match(capability.name, /^[a-z][a-z0-9_]*$/);
  assert.equal(supportLevels.has(capability.supportLevel), true);
  assert.equal(enforcementLevels.has(capability.enforcementLevel), true);
  assert.ok(['stage0_evidence', 'not_committed'].includes(capability.commitment));
  assert.equal(typeof capability.evidence, 'string');
  assert.ok(capability.evidence.length > 0);
  if (
    capability.supportLevel === 'unknown' ||
    capability.enforcementLevel === 'unknown'
  ) {
    assert.equal(capability.commitment, 'not_committed');
  }
}

export async function validateRuntimeContract(fixturePath) {
  const contract = await readJson(fixturePath);
  assert.equal(contract.schemaVersion, 1);
  assert.match(contract.runtime.type, /^[a-z][a-z0-9_-]*$/);
  assert.equal(typeof contract.runtime.version, 'string');
  assert.ok(['global', 'project', 'worktree', 'session'].includes(contract.runtime.recommendedScope));
  assert.equal(contract.boundaries.oneReaderPerHandle, true);

  const boundaryCapabilities = [
    contract.boundaries.runtimeScopeEvents,
    contract.boundaries.connectionEpoch,
    contract.boundaries.eventReplay,
  ];
  for (const capability of [...boundaryCapabilities, ...contract.capabilities]) {
    validateCapability(capability);
  }

  const capabilityNames = contract.capabilities.map(({ name }) => name);
  assert.equal(new Set(capabilityNames).size, capabilityNames.length);

  const unknownNames = new Set(contract.unknowns);
  for (const capability of [...boundaryCapabilities, ...contract.capabilities]) {
    if (
      capability.supportLevel === 'unknown' ||
      capability.enforcementLevel === 'unknown'
    ) {
      assert.equal(unknownNames.has(capability.name), true);
    }
  }

  const matrixPath = assertInsideRepository(contract.evidence.capabilityMatrix);
  const reportPath = assertInsideRepository(contract.evidence.report);
  await access(reportPath);
  assert.equal(await sha256File(matrixPath), contract.evidence.capabilityMatrixSha256);

  const sourceMatrix = await readJson(matrixPath);
  assert.equal(sourceMatrix.runtime, contract.runtime.type);
  assert.equal(sourceMatrix.runtimeVersion, contract.runtime.version);
  assert.equal(sourceMatrix.capabilities.length, contract.capabilities.length);

  const sourceByName = new Map(
    sourceMatrix.capabilities.map((capability) => [capability.name, capability]),
  );
  for (const capability of contract.capabilities) {
    const source = sourceByName.get(capability.name);
    assert.ok(source, 'missing source capability: ' + capability.name);
    assert.equal(capability.supportLevel, source.supportLevel);
    assert.equal(capability.enforcementLevel, source.enforcementLevel);
    assert.equal(capability.evidence, source.evidence);
  }

  return contract;
}
