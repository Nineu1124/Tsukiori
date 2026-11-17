import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  appendTranscriptLine, readTranscriptLines, replaceTranscript, removeTranscript,
  TranscriptStoreError, TRANSCRIPT_RECORD_BYTES,
} from './transcript-store.js';
import { WorkspaceSqliteStore, WorkspaceStorageError } from './workspace-sqlite.js';
import { planConversationMigration, applyConversationMigration } from './workspace-conversation-migration.js';

/** 每个字符串是一条 JSON 事件；读取不带行尾，写入兼容有无末尾换行。 */
export interface ConversationRepository {
  read(sessionId: string): Iterable<string>;
  find?(sessionId: string, eventId: string): string | undefined;
  append(sessionId: string, event: string): void | 'inserted' | 'duplicate';
  replace(sessionId: string, events: readonly string[]): void;
  remove(sessionId: string): void;
  legacyPath(sessionId: string): string;
}

/** 与项目/会话共用同一库；旧 Transcript 只在首次激活时备份导入。 */
export class SqliteConversationRepository implements ConversationRepository {
  constructor(readonly userDataPath: string, readonly store: WorkspaceSqliteStore) {
    if (!store.listMigrationRuns().some((run) => run.phase === 'events' || run.phase === 'complete')) {
      const state = store.readState();
      if (!state) throw new WorkspaceStorageError('invalid_data');
      applyConversationMigration(planConversationMigration(userDataPath, state), store);
    }
  }

  read(sessionId: string): Iterable<string> { return this.store.readEvents(sessionId); }
  find(sessionId: string, eventId: string): string | undefined { return this.store.readEvent(sessionId, eventId); }
  append(sessionId: string, event: string): 'inserted' | 'duplicate' {
    return this.store.appendEvent(sessionId, recordLine(event).trimEnd());
  }
  replace(sessionId: string, events: readonly string[]): void {
    this.store.replaceEvents(sessionId, events.map((event) => recordLine(event).trimEnd()));
  }
  remove(sessionId: string): void { this.store.removeEvents(sessionId); }
  legacyPath(sessionId: string): string {
    return join(this.userDataPath, 'transcripts', createHash('sha256').update(sessionId).digest('hex') + '.jsonl');
  }
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
