import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { appendTranscriptLine, readTranscriptLines, replaceTranscript, TRANSCRIPT_RECORD_BYTES } from '../../apps/desktop/dist/electron-main/transcript-store.js';
import { historyFixture, send } from './history-fixture.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'tsukiori-journal-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, path: join(dir, 'conversation.jsonl') };
}

test('segments preserve ordered records beyond both former size limits', (t) => {
  const f = fixture(t);
  for (let i = 0; i < 20; i++) appendTranscriptLine(f.path, JSON.stringify({ id: i, text: '中'.repeat(160_000) }) + '\n');
  const lines = [...readTranscriptLines(f.path)];
  assert.equal(lines.length, 20);
  assert.deepEqual(lines.map((line) => JSON.parse(line).id), Array.from({ length: 20 }, (_, i) => i));
  assert.equal(lines.every((line) => JSON.parse(line).text.length === 160_000), true);
  assert.equal(readdirSync(f.dir).filter((name) => name.includes('.segment-')).length >= 2, true);
});

test('legacy logs without final newline rotate and checkpoint replacement retires future segments', (t) => {
  const f = fixture(t);
  writeFileSync(f.path, '{"id":0}');
  appendTranscriptLine(f.path, '{"id":1}\n', 100);
  appendTranscriptLine(f.path, '{"id":2}\n', 20);
  assert.deepEqual([...readTranscriptLines(f.path)].map(JSON.parse), [{ id: 0 }, { id: 1 }, { id: 2 }]);
  const before = readdirSync(f.dir);
  replaceTranscript(f.path, '{"id":0}\n');
  appendTranscriptLine(f.path, '{"id":3}\n', 10);
  assert.deepEqual([...readTranscriptLines(f.path)].map(JSON.parse), [{ id: 0 }, { id: 3 }]);
  assert.equal(before.every((name) => readdirSync(f.dir).includes(name)), true);
});

test('invalid index, missing segment and oversized records fail without exposing file content', (t) => {
  const f = fixture(t);
  const original = '{"id":0}\n';
  writeFileSync(f.path, original);
  assert.throws(() => appendTranscriptLine(f.path, 'x'.repeat(TRANSCRIPT_RECORD_BYTES) + '\n'), /会话记录/);
  assert.equal(readFileSync(f.path, 'utf8'), original);
  for (const segment of ['../private-fixture', 'conversation.jsonl.segment-00000000-0000-4000-8000-000000000000.jsonl']) {
    writeFileSync(`${f.path}.index.json`, JSON.stringify({ version: 1, segments: [segment] }));
    assert.throws(() => [...readTranscriptLines(f.path)], /会话记录/);
    assert.throws(() => appendTranscriptLine(f.path, '{"id":1}\n'), /会话记录/);
    assert.equal(readFileSync(f.path, 'utf8'), original);
  }
});

test('a failed index publish preserves the previous visible log', (t) => {
  const f = fixture(t);
  appendTranscriptLine(f.path, '{"id":0}\n', 10);
  appendTranscriptLine(f.path, '{"id":1}\n', 10);
  const before = readFileSync(`${f.path}.index.json`, 'utf8');
  const rename = fs.renameSync;
  const fault = t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === `${f.path}.index.json`) throw Object.assign(new Error('fixture failure'), { code: 'EIO' });
    return rename(from, to);
  });
  syncBuiltinESMExports();
  try { assert.throws(() => appendTranscriptLine(f.path, '{"id":2}\n', 10), /会话记录/); }
  finally { fault.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(readFileSync(`${f.path}.index.json`, 'utf8'), before);
  assert.deepEqual([...readTranscriptLines(f.path)].map(JSON.parse), [{ id: 0 }, { id: 1 }]);
});

test('workspace reports write failure and remembers incomplete history across restart', async (t) => {
  const f = await historyFixture(t);
  const path = join(f.userDataPath, 'transcripts', createHash('sha256').update(f.session.id).digest('hex') + '.jsonl');
  mkdirSync(`${path}.index.json`);
  await assert.rejects(send(f.workspace, f.session.id, 'unsaved fixture'), /会话记录/);
  assert.equal(f.histories.length, 0);
  assert.equal(f.emitted.some((event) => event.type === 'runtime.warning' && event.payload.category === 'transcript_write_failed'), true);
  assert.equal(f.workspace.snapshot().sessions[0].transcriptIncomplete, true);
  await f.workspace.shutdown();
  rmSync(`${path}.index.json`, { recursive: true });
  const restarted = f.open();
  await assert.rejects(send(restarted, f.session.id, 'must not use incomplete history'), /会话记录不完整/);
});
