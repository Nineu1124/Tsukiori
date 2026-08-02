import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const spikeDirectory = dirname(fileURLToPath(import.meta.url));
const fixtureDirectory = resolve(spikeDirectory, '..', '..', 'tests', 'fixtures', 'opencode', '1.18.4');

async function readJson(name) {
  return JSON.parse(await readFile(join(fixtureDirectory, name), 'utf8'));
}

test('sanitized result proves the direct provider flow without retaining credentials', async () => {
  const result = await readJson('result.sanitized.json');

  assert.equal(result.taskId, 'T0.1');
  assert.equal(result.startedAt, '<timestamp>');
  assert.equal(result.completedAt, '<timestamp>');
  assert.equal(result.runtime.version, '1.18.4');
  assert.equal(result.model.providerID, 'dpsk');
  assert.equal(result.model.requiredProvider, 'dpsk');
  assert.equal(result.model.evidence.source, 'config');
  assert.equal(result.model.evidence.endpointHost, 'api.deepseek.com');
  assert.equal(result.model.evidence.modelListed, true);
  assert.equal(result.model.evidence.credentialPresent, true);
  assert.match(result.model.evidence.credentialLocation, /^provider\.options\./);
  assert.deepEqual(Object.values(result.checks).filter((value) => value === false), []);

  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /sk-[a-z0-9_-]{12,}/i);
  assert.doesNotMatch(serialized, /Basic\s+[A-Za-z0-9+/=]{8,}/i);
});

test('OpenAPI manifest is versioned and content-addressed', async () => {
  const manifest = await readJson('openapi-manifest.json');
  assert.equal(manifest.runtimeVersion, '1.18.4');
  assert.equal(manifest.contentType, 'application/json');
  assert.match(manifest.sha256, /^[a-f0-9]{64}$/);
  assert.ok(manifest.bytes > 100_000);
});

test('event fixture contains routing metadata only', async () => {
  const summary = await readJson('event-summary.json');
  assert.equal(summary.rawPayloadsCommitted, false);
  assert.equal(summary.eventTypeCounts['permission.asked'], 1);
  assert.equal(summary.eventTypeCounts['permission.replied'], 1);
  assert.ok(summary.eventTypeCounts['session.created'] >= 1);
  assert.ok(summary.eventTypeCounts['session.idle'] >= 1);
  assert.equal(Object.hasOwn(summary, 'events'), false);
});

test('capability matrix preserves unverified crash behavior as unknown', async () => {
  const matrix = await readJson('capability-matrix.json');
  const capability = matrix.capabilities.find(({ name }) => name === 'in_flight_turn_crash_recovery');
  assert.deepEqual(
    { supportLevel: capability.supportLevel, enforcementLevel: capability.enforcementLevel },
    { supportLevel: 'unknown', enforcementLevel: 'unknown' },
  );
});
