import { randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { writeFileAtomicSync } from './atomic-file.js';

export const TRANSCRIPT_SEGMENT_BYTES = 4 * 1024 * 1024;
export const TRANSCRIPT_RECORD_BYTES = 16 * 1024 * 1024;
const INDEX_BYTES = 1024 * 1024;

export class TranscriptStoreError extends Error {
  constructor() { super('会话记录无法完整读取或保存，请检查磁盘、权限和备份。'); this.name = 'TranscriptStoreError'; }
}

function files(path: string): string[] {
  const index = `${path}.index.json`;
  if (!existsSync(index)) return existsSync(path) ? [path] : [];
  if (statSync(index).size > INDEX_BYTES) throw new TranscriptStoreError();
  const value = JSON.parse(readFileSync(index, 'utf8')) as { version?: unknown; segments?: unknown };
  if (value?.version !== 1 || !Array.isArray(value.segments) || !value.segments.length) throw new TranscriptStoreError();
  const names = value.segments as unknown[];
  if (new Set(names).size !== names.length || names.some((name) => typeof name !== 'string'
    || (name !== basename(path) && !(name.startsWith(`${basename(path)}.segment-`)
      && /^[a-f0-9-]{36}\.jsonl$/.test(name.slice(`${basename(path)}.segment-`.length)))))) throw new TranscriptStoreError();
  const result = (names as string[]).map((name) => join(dirname(path), name));
  if (result.some((file) => !existsSync(file))) throw new TranscriptStoreError();
  return result;
}

function saveIndex(path: string, segments: string[]): void {
  const content = JSON.stringify({ version: 1, segments: segments.map((file) => basename(file)) });
  if (Buffer.byteLength(content) > INDEX_BYTES) throw new TranscriptStoreError();
  writeFileAtomicSync(`${path}.index.json`, content);
}

function newSegment(path: string, content: string): string {
  const segment = `${path}.segment-${randomUUID()}.jsonl`;
  writeFileSync(segment, content, { encoding: 'utf8', flag: 'wx', mode: 0o600, flush: true });
  return segment;
}

export function appendTranscriptLine(path: string, line: string, segmentBytes = TRANSCRIPT_SEGMENT_BYTES): void {
  try {
    const bytes = Buffer.byteLength(line, 'utf8');
    if (bytes > TRANSCRIPT_RECORD_BYTES || !line.endsWith('\n') || line.slice(0, -1).includes('\n')
      || !Number.isSafeInteger(segmentBytes) || segmentBytes <= 0) throw new TranscriptStoreError();
    const segments = files(path);
    const active = segments.at(-1) ?? path;
    const size = existsSync(active) ? statSync(active).size : 0;
    if (size > 0 && size + bytes > segmentBytes) {
      const segment = newSegment(path, line);
      // Publish the new segment only after its content is written. Until then,
      // the previous index (or legacy file) is still the complete visible log.
      saveIndex(path, [...segments, segment]);
      return;
    }
    if (size > 0) {
      const fd = openSync(active, 'r');
      const tail = Buffer.alloc(1);
      try { readSync(fd, tail, 0, 1, size - 1); } finally { closeSync(fd); }
      if (tail[0] !== 10) appendFileSync(active, '\n');
    }
    appendFileSync(active, line, { encoding: 'utf8', mode: 0o600 });
  } catch { throw new TranscriptStoreError(); }
}

export function* readTranscriptLines(path: string): Generator<string> {
  try {
    for (const segment of files(path)) {
      const fd = openSync(segment, 'r');
      const decoder = new StringDecoder('utf8');
      const buffer = Buffer.alloc(64 * 1024);
      let pending = '';
      try {
        let count: number;
        while ((count = readSync(fd, buffer)) > 0) {
          pending += decoder.write(buffer.subarray(0, count));
          let newline: number;
          while ((newline = pending.indexOf('\n')) >= 0) {
            const line = pending.slice(0, newline).replace(/\r$/, '');
            if (Buffer.byteLength(line) + 1 > TRANSCRIPT_RECORD_BYTES) throw new TranscriptStoreError();
            if (line) yield line;
            pending = pending.slice(newline + 1);
          }
          if (Buffer.byteLength(pending) > TRANSCRIPT_RECORD_BYTES) throw new TranscriptStoreError();
        }
        pending += decoder.end();
        if (pending.trim()) yield pending;
      } finally { closeSync(fd); }
    }
  } catch { throw new TranscriptStoreError(); }
}

export function replaceTranscript(path: string, content: string): void {
  try {
    if (!existsSync(`${path}.index.json`)) {
      writeFileAtomicSync(path, content);
      return;
    }
    // Keep retired segments for recovery; a single atomic index switch ensures
    // later appends and restarts cannot replay the removed future conversation.
    const segment = newSegment(path, content);
    saveIndex(path, [segment]);
  } catch { throw new TranscriptStoreError(); }
}

export function removeTranscript(path: string): void {
  for (const file of files(path)) rmSync(file, { force: true });
  rmSync(`${path}.index.json`, { force: true });
  rmSync(path, { force: true });
}
