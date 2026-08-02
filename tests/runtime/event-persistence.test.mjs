import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { FakeRuntimeAdapter } = await import(pathToFileURL(
  join(repositoryRoot, 'packages', 'adapter-fake', 'dist', 'index.js'),
).href);
const { toSessionEventRecord } = await import(pathToFileURL(
  join(repositoryRoot, 'packages', 'runtime-core', 'dist', 'index.js'),
).href);
const { LocalDatabase } = await import(pathToFileURL(
  join(repositoryRoot, 'packages', 'database', 'dist', 'index.js'),
).href);

test('normalized unknown and known events persist after sanitization without blocking the stream', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'tsukiori-event-store-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const adapter = new FakeRuntimeAdapter({ maxPayloadBytes: 256 });
  const session = adapter.createSession();
  const secret = 'fixture-runtime-value-12345678';
  const results = adapter.runScript(session, [
    { kind: 'runtime_event', nativeType: 'future.runtime.event', payload: { api_key: secret, safe: 'metadata' } },
    { kind: 'runtime_event', nativeType: 'runtime.state', payload: { state: 'ready' } },
  ]);
  assert.equal(results[0].events[0].type, 'native.event');
  assert.equal(results[1].events[0].type, 'runtime.state_changed');

  let database = new LocalDatabase({
    filePath: join(root, 'events.db'),
    blobRoot: join(root, 'blobs'),
    knownSecrets: [secret],
  });
  for (const result of results) {
    for (const event of result.events) database.appendSessionEvent(toSessionEventRecord(event));
  }
  assert.equal(database.count('session_events'), 2);
  const stored = database.sqlite.prepare(
    'SELECT event_type, normalized_payload_json FROM session_events ORDER BY stream_sequence',
  ).all();
  assert.deepEqual(stored.map(({ event_type }) => event_type), ['native.event', 'runtime.state_changed']);
  assert.doesNotMatch(JSON.stringify(stored), /fixture-runtime-value|api_key/);
  database.close();

  database = new LocalDatabase({ filePath: join(root, 'events.db'), blobRoot: join(root, 'blobs') });
  assert.equal(database.count('session_events'), 2);
  database.close();
});