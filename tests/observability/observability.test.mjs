import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const {
  DiagnosticBundleBuilder,
  ResourceGovernor,
  ResourceLimitError,
  StructuredLogger,
  V1_RESOURCE_BUDGETS,
} = await import(pathToFileURL(join(root, 'packages/observability/dist/index.js')).href);
const published = JSON.parse(readFileSync(
  join(root, 'tests/fixtures/observability/t5.3-result.json'), 'utf8',
));

test('published observability fixture freezes all V1 limits and diagnostic exclusions', () => {
  assert.deepEqual(published.limits, {
    runtimeConcurrent: 3, ptyConcurrent: 8, eventBytes: 65536, eventQueue: 1024,
    blobBytes: 10485760, diffBytes: 2097152, logBytes: 16384, logEntries: 256,
  });
  assert.deepEqual(published.diagnosticDefaultExcludes,
    ['source', 'complete_prompt', 'raw_payload', 'credentials', 'auth_store']);
  assert.equal(published.containsCredentials, false);
  assert.equal(published.containsPromptOrSource, false);
});

test('Runtime, PTY, event, Blob, Diff, and log limits degrade predictably and remain cancellable', () => {
  const governor = new ResourceGovernor();
  const cancelled = [];
  const runtime = [0, 1, 2].map((id) => governor.acquire('runtime', 'session-' + id, () => cancelled.push(id)));
  assert.throws(() => governor.acquire('runtime', 'session-3', () => {}),
    (error) => error instanceof ResourceLimitError && error.kind === 'runtime' && error.code === 'concurrency');
  const pty = Array.from({ length: 8 }, (_, id) => governor.acquire('pty', 'pty-' + id, () => {}));
  assert.throws(() => governor.acquire('pty', 'pty-8', () => {}), ResourceLimitError);
  assert.equal(governor.assertBytes('event', 'x'.repeat(V1_RESOURCE_BUDGETS.event.maxBytes)), 65536);
  assert.throws(() => governor.assertBytes('event', 'x'.repeat(65537)), ResourceLimitError);
  assert.throws(() => governor.assertBytes('blob', Buffer.alloc(10485761)), ResourceLimitError);
  assert.throws(() => governor.assertBytes('diff', Buffer.alloc(2097153)), ResourceLimitError);
  assert.throws(() => governor.assertBytes('log', Buffer.alloc(16385)), ResourceLimitError);
  for (let index = 0; index < 1024; index += 1) governor.enqueue('event');
  assert.throws(() => governor.enqueue('event'), ResourceLimitError);
  assert.equal(governor.cancelAll('runtime'), 3);
  assert.deepEqual(cancelled, [0, 1, 2]);
  assert.equal(governor.snapshot().activeRuntime, 0);
  for (const lease of pty) governor.release(lease.id);
  assert.equal(governor.snapshot().activePty, 0);
  assert.equal(runtime.length, 3);
});

test('structured logs redact, strip untrusted control content, truncate, and bound their ring', () => {
  const secret = 'fixture-log-secret-value';
  const lines = [];
  const logger = new StructuredLogger({
    knownSecrets: [secret], sink: (line) => lines.push(line), maxEntries: 2, maxBytes: 1024,
  });
  logger.log('info', 'runtime.started', {
    authorization: secret,
    message: '\u001b[31m<script>unsafe</script> ' + secret,
  }, 1);
  logger.log('warn', 'runtime.output', { text: 'x'.repeat(5000) }, 2);
  logger.log('error', 'runtime.stopped', { reason: 'bounded' }, 3);
  const snapshot = logger.snapshot();
  assert.equal(snapshot.records.length, 2);
  assert.equal(snapshot.dropped, 1);
  assert.equal(lines.length, 3);
  assert.equal(lines.every((line) => Buffer.byteLength(line, 'utf8') <= 1024), true);
  assert.doesNotMatch(lines.join('\n'), new RegExp(secret));
  assert.doesNotMatch(lines.join('\n'), /\u001b/);
  assert.equal(snapshot.records.some((record) => record.fields.truncated === true), true);
});

test('diagnostic bundle defaults safe; opt-in previews are re-sanitized and size-estimated', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tsukiori-diagnostic-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const secret = 'fixture-diagnostic-secret';
  const logger = new StructuredLogger({ knownSecrets: [secret] });
  logger.log('info', 'daemon.ready', { state: 'running' }, 1);
  const builder = new DiagnosticBundleBuilder({ knownSecrets: [secret] });
  const common = {
    versions: { host: '0.1.0 ' + secret, protocol: '1' },
    metrics: { activeSessions: 3, droppedLogs: 0 },
    logs: logger.snapshot(),
  };
  const defaultResult = builder.build(join(directory, 'default.json.gz'), {
    ...common,
    options: { includeSensitivePreviews: false, sensitive: {
      prompt: 'complete prompt ' + secret, source: 'source bytes ' + secret,
      rawPayload: { token: secret },
    } },
  });
  const defaultBody = JSON.parse(gunzipSync(readFileSync(defaultResult.path)).toString('utf8'));
  assert.equal(defaultBody.sensitivePreviewsIncluded, false);
  assert.equal('sensitivePreviews' in defaultBody, false);
  assert.doesNotMatch(JSON.stringify(defaultBody), /complete prompt|source bytes|fixture-diagnostic-secret/);

  const options = { includeSensitivePreviews: true, sensitive: {
    prompt: '\u001b[31mprompt preview ' + secret,
    source: 'source preview ' + secret,
    rawPayload: { authorization: secret, safe: 'preview' },
  } };
  const estimate = builder.estimate({ ...common, options });
  const opted = builder.build(join(directory, 'opted.json.gz'), { ...common, options });
  const optedBody = JSON.parse(gunzipSync(readFileSync(opted.path)).toString('utf8'));
  assert.equal(estimate.includesSensitivePreviews, true);
  assert.equal(estimate.estimatedBytes, opted.estimatedBytes);
  assert.equal(optedBody.sensitivePreviewsIncluded, true);
  assert.doesNotMatch(JSON.stringify(optedBody), new RegExp(secret));
  assert.doesNotMatch(JSON.stringify(optedBody), /\u001b/);
  assert.match(JSON.stringify(optedBody.sensitivePreviews), /<redacted>/);
});
