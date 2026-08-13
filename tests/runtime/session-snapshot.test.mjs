import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  fixtureDigest,
  generateSessionSnapshotFixture,
  serializedFixture,
} from '../../scripts/session-fixture-snapshots.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const path = join(root, 'tests', 'fixtures', 'session', 'runtime-session-snapshots.v1.json');
const published = JSON.parse(readFileSync(path, 'utf8'));

test('published Session Snapshot Fixture is deterministic and current', () => {
  assert.equal(readFileSync(path, 'utf8'), serializedFixture());
  assert.deepEqual(published, generateSessionSnapshotFixture());
  assert.equal(published.schemaVersion, 1);
  assert.equal(published.externalProviderCalls, false);
  assert.equal(published.containsCredentials, false);
  assert.equal(published.containsUserPrompt, false);
});

test('Session Snapshot Fixture covers conversation, permission, thinking, and tool lifecycles', () => {
  assert.deepEqual(published.scenarios.map((scenario) => scenario.id), [
    'normal-conversation',
    'permission-roundtrip',
    'thinking-forward-compatibility',
    'tool-lifecycle',
  ]);
  for (const scenario of published.scenarios) {
    assert.equal(scenario.expectedSha256, fixtureDigest(scenario.expected), scenario.id);
    assert.deepEqual(scenario.expected.map((event) => event.streamSequence), scenario.expected.map((_, index) => index + 1));
  }
  const types = new Set(published.scenarios.flatMap((scenario) => scenario.expected.map((event) => event.type)));
  for (const type of [
    'assistant.message_started', 'assistant.text_delta', 'assistant.message_completed',
    'permission.requested', 'permission.resolved', 'tool.started', 'tool.progress', 'tool.completed',
    'native.event',
  ]) assert.equal(types.has(type), true, type);
});

test('Session Snapshot Fixture remains sanitized and contains no machine-specific path', () => {
  const serialized = JSON.stringify(published);
  assert.doesNotMatch(serialized, /\bsk-[A-Za-z0-9_-]{12,}/);
  assert.doesNotMatch(serialized, /\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/i);
  assert.doesNotMatch(serialized, /-----BEGIN [A-Z ]*PRIVATE KEY-----/);
  assert.doesNotMatch(serialized, /[A-Z]:\\Users\\[^\\"\s]+/i);
});
