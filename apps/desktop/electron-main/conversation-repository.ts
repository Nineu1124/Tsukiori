import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  appendTranscriptLine, readTranscriptLines, replaceTranscript, removeTranscript,
  TranscriptStoreError, TRANSCRIPT_RECORD_BYTES,
} from './transcript-store.js';

/** 每个字符串是一条 JSON 事件；读取不带行尾，写入兼容有无末尾换行。 */
export interface ConversationRepository {
  read(sessionId: string): Iterable<string>;
  append(sessionId: string, event: string): void;
  replace(sessionId: string, events: readonly string[]): void;
  remove(sessionId: string): void;
  legacyPath(sessionId: string): string;
}

/** 分段、索引发布和恢复沿用 Transcript Store，业务只按 Session 读写。 */
export class JsonConversationRepository implements ConversationRepository {
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }

  read(sessionId: string): Iterable<string> {
    return readTranscriptLines(this.legacyPath(sessionId));
  }

  append(sessionId: string, event: string): void {
    appendTranscriptLine(this.legacyPath(sessionId), recordLine(event));
  }

  replace(sessionId: string, events: readonly string[]): void {
    replaceTranscript(this.legacyPath(sessionId), events.map(recordLine).join(''));
  }

  remove(sessionId: string): void {
    removeTranscript(this.legacyPath(sessionId));
  }

  legacyPath(sessionId: string): string {
    return join(this.root, createHash('sha256').update(sessionId).digest('hex') + '.jsonl');
  }
}

function recordLine(event: string): string {
  const line = event.replace(/\r?\n$/, '');
  if (!line || line.includes('\n') || Buffer.byteLength(line, 'utf8') + 1 > TRANSCRIPT_RECORD_BYTES) {
    throw new TranscriptStoreError();
  }
  return line + '\n';
}
