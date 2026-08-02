import assert from 'node:assert/strict';
import test from 'node:test';
import {
  eventSummary,
  parseServerUrl,
  sanitizeText,
  sha256,
  unwrap,
} from './lib.mjs';

test('parseServerUrl accepts the OpenCode startup line', () => {
  assert.equal(
    parseServerUrl('opencode server listening on http://127.0.0.1:4096'),
    'http://127.0.0.1:4096',
  );
  assert.equal(parseServerUrl('unrelated output'), null);
});

test('sanitizeText redacts credentials and temporary paths', () => {
  const value = sanitizeText(
    ['C:\\temp\\fixture', ['sk', 'abcdefghijklmnopqrstuvwxyz'].join('-'), 'Basic dXNlcjpwYXNz'].join(' '),
    'C:\\temp\\fixture',
  );
  assert.equal(value.includes('abcdefghijklmnopqrstuvwxyz'), false);
  assert.equal(value.includes('dXNlcjpwYXNz'), false);
  assert.equal(value.includes('C:\\temp\\fixture'), false);
});

test('eventSummary keeps only routing-safe metadata', () => {
  assert.deepEqual(
    eventSummary({
      payload: {
        type: 'session.created',
        properties: { info: { sessionID: 'secret-session-id' }, text: 'raw payload' },
      },
    }),
    { type: 'session.created', hasSession: true },
  );
});

test('unwrap returns data and rejects SDK errors', () => {
  assert.deepEqual(unwrap({ data: { ok: true } }, 'health'), { ok: true });
  assert.throws(() => unwrap({ error: { message: 'bad' } }, 'health'), /health failed/);
});

test('sha256 is deterministic', () => {
  assert.equal(sha256('tsukiori'), sha256('tsukiori'));
  assert.notEqual(sha256('tsukiori'), sha256('Tsukiori'));
});