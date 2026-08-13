import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = join(root, 'tests', 'fixtures', 'session', 'runtime-session-snapshots.v1.json');
const { EventNormalizer } = await import(pathToFileURL(
  join(root, 'packages', 'runtime-core', 'dist', 'index.js'),
).href);

const scenarios = Object.freeze([
  {
    id: 'normal-conversation',
    events: [
      ['message.started', { messageId: 'fixture-message-normal' }],
      ['text.delta', { text: 'fixture assistant response' }],
      ['message.completed', { status: 'completed' }],
    ],
  },
  {
    id: 'permission-roundtrip',
    events: [
      ['message.started', { messageId: 'fixture-message-permission' }],
      ['permission.requested', { category: 'file_write', risk: 'medium', enforcementLevel: 'interceptable' }],
      ['permission.resolved', { decision: 'allow_once', decisionScope: 'once' }],
      ['message.completed', { status: 'completed' }],
    ],
  },
  {
    id: 'thinking-forward-compatibility',
    events: [
      ['message.started', { messageId: 'fixture-message-thinking' }],
      ['thinking.started', { index: 0 }],
      ['thinking.delta', { index: 0, text: 'fixture reasoning fragment' }],
      ['thinking.completed', { index: 0 }],
      ['message.completed', { status: 'completed' }],
    ],
  },
  {
    id: 'tool-lifecycle',
    events: [
      ['message.started', { messageId: 'fixture-message-tool' }],
      ['tool.started', { tool: 'read', toolUseId: 'fixture-tool-1' }],
      ['tool.progress', { tool: 'read', toolUseId: 'fixture-tool-1', summary: 'fixture progress' }],
      ['tool.completed', { tool: 'read', toolUseId: 'fixture-tool-1', status: 'completed' }],
      ['message.completed', { status: 'completed' }],
    ],
  },
]);

export function generateSessionSnapshotFixture() {
  return {
    schemaVersion: 1,
    generator: 'scripts/session-fixture-snapshots.mjs',
    contract: 'runtime-core/EventNormalizer',
    externalProviderCalls: false,
    containsCredentials: false,
    containsUserPrompt: false,
    scenarios: scenarios.map((scenario) => generateScenario(scenario)),
  };
}

export function fixtureDigest(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

export function serializedFixture(value = generateSessionSnapshotFixture()) {
  const serialized = JSON.stringify(value, null, 2) + '\n';
  assertSanitized(serialized);
  return serialized;
}

function generateScenario(scenario) {
  const runtimeHandleId = `fixture-handle:${scenario.id}`;
  const connectionEpoch = `fixture-epoch:${scenario.id}:1`;
  const runtimeSessionId = `fixture-session:${scenario.id}`;
  const runtimeTurnId = `fixture-turn:${scenario.id}:1`;
  const normalizer = new EventNormalizer({
    runtimeHandleId,
    runtimeType: 'fake',
    streamId: `fixture-stream:${scenario.id}`,
    connectionEpoch,
  });
  const expected = [];
  scenario.events.forEach(([nativeType, payload], index) => {
    const nativeSequence = index + 1;
    const result = normalizer.ingest({
      nativeType,
      payload,
      nativeSequence,
      runtimeEventId: `${scenario.id}:event:${nativeSequence}`,
      runtimeSessionId,
      runtimeTurnId,
      connectionEpoch,
      createdAt: 1_800_100_000_000 + nativeSequence,
    });
    if (result.status !== 'accepted') throw new Error(`${scenario.id} event ${nativeSequence} was ${result.status}`);
    expected.push(...result.events.map((event, outputIndex) => canonicalEvent(event, expected.length + outputIndex + 1)));
  });
  return {
    id: scenario.id,
    input: scenario.events.map(([nativeType, payload], index) => ({
      nativeSequence: index + 1,
      nativeType,
      payload,
    })),
    expected,
    expectedSha256: fixtureDigest(expected),
  };
}

function canonicalEvent(event, index) {
  return {
    ...event,
    eventId: `fixture-event:${index}`,
    receivedAt: 0,
  };
}

function stableJson(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
}

function assertSanitized(serialized) {
  for (const pattern of [
    /\bsk-[A-Za-z0-9_-]{12,}/,
    /\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/i,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /[A-Z]:\\Users\\[^\\"\s]+/i,
  ]) {
    if (pattern.test(serialized)) throw new Error('Session Fixture contains forbidden sensitive content');
  }
}

function currentFixture() {
  try { return readFileSync(fixturePath, 'utf8'); }
  catch { return null; }
}

async function main() {
  const mode = process.argv[2] ?? '--check';
  const generated = serializedFixture();
  if (mode === '--update') {
    mkdirSync(dirname(fixturePath), { recursive: true });
    writeFileSync(fixturePath, generated, 'utf8');
    process.stdout.write(JSON.stringify({ mode: 'updated', fixture: 'tests/fixtures/session/runtime-session-snapshots.v1.json', scenarios: scenarios.length }) + '\n');
    return;
  }
  if (mode !== '--check') throw new Error('Usage: session-fixture-snapshots.mjs [--update|--check]');
  const current = currentFixture();
  if (current !== generated) throw new Error('Session Snapshot Fixture is stale; run pnpm run test:snapshot:record');
  process.stdout.write(JSON.stringify({ mode: 'verified', fixture: 'tests/fixtures/session/runtime-session-snapshots.v1.json', scenarios: scenarios.length }) + '\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
