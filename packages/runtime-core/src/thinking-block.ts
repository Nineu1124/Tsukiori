import { createHash, type Hash } from 'node:crypto';

export type ThinkingBlockIndex = string | number;
export type ThinkingBlockEventType =
  | 'assistant.thinking.started'
  | 'assistant.thinking.delta'
  | 'assistant.thinking.completed';

export type ThinkingBlockEvent = {
  type: ThinkingBlockEventType;
  payload: Record<string, unknown>;
};

export type ThinkingBlockProjectionResult = {
  status: 'accepted' | 'rejected';
  reason?: 'invalid_index' | 'duplicate_start' | 'already_completed' | 'active_limit' | 'block_limit';
  events: ThinkingBlockEvent[];
};

export type ThinkingBlockMetadata = {
  schemaVersion: 1;
  blockId: string;
  index: ThinkingBlockIndex;
  status: 'active' | 'completed' | 'incomplete';
  chunkCount: number;
  totalBytes: number;
  capturedBytes: number;
  truncated: boolean;
  contentPersisted: false;
  contentSha256?: string;
  completionReason?: string;
};

type ActiveBlock = {
  blockId: string;
  index: ThinkingBlockIndex;
  hash: Hash;
  preview: string;
  chunkCount: number;
  totalBytes: number;
  truncated: boolean;
};

export class ThinkingBlockProjector {
  readonly #maxCapturedBytes: number;
  readonly #maxActiveBlocks: number;
  readonly #maxBlocks: number;
  #active = new Map<string, ActiveBlock>();
  #completed = new Set<string>();
  #startedCount = 0;

  constructor(options: { maxCapturedBytes?: number; maxActiveBlocks?: number; maxBlocks?: number } = {}) {
    this.#maxCapturedBytes = boundedInteger(options.maxCapturedBytes ?? 32 * 1024, 1, 256 * 1024);
    this.#maxActiveBlocks = boundedInteger(options.maxActiveBlocks ?? 32, 1, 256);
    this.#maxBlocks = boundedInteger(options.maxBlocks ?? 256, 1, 4_096);
    if (this.#maxBlocks < this.#maxActiveBlocks) throw new Error('Thinking block total bound must cover active bound');
  }

  ingest(type: ThinkingBlockEventType, payload: Record<string, unknown>): ThinkingBlockProjectionResult {
    let index = thinkingIndex(payload.blockId ?? payload.index);
    if (index === null && type !== 'assistant.thinking.started' && this.#active.size === 1) {
      index = this.#active.values().next().value?.index ?? null;
    }
    if (index === null) return { status: 'rejected', reason: 'invalid_index', events: [] };
    const blockId = String(index);
    if (type === 'assistant.thinking.started') return this.#start(index, blockId, false);
    if (type === 'assistant.thinking.delta') {
      let started: ThinkingBlockEvent[] = [];
      if (!this.#active.has(blockId)) {
        const result = this.#start(index, blockId, true);
        if (result.status === 'rejected') return result;
        started = result.events;
      }
      const block = this.#active.get(blockId) as ActiveBlock;
      const text = typeof payload.text === 'string' ? payload.text : '';
      const bytes = Buffer.byteLength(text, 'utf8');
      block.hash.update(text);
      block.chunkCount += 1;
      block.totalBytes += bytes;
      const remaining = Math.max(0, this.#maxCapturedBytes - Buffer.byteLength(block.preview, 'utf8'));
      if (remaining > 0) block.preview += utf8Prefix(text, remaining);
      block.truncated = block.totalBytes > Buffer.byteLength(block.preview, 'utf8');
      return {
        status: 'accepted',
        events: [...started, {
          type,
          payload: {
            ...payload,
            schemaVersion: 1,
            blockId,
            index,
            chunkIndex: block.chunkCount - 1,
            totalBytes: block.totalBytes,
            capturedBytes: Buffer.byteLength(block.preview, 'utf8'),
            truncated: block.truncated,
          },
        }],
      };
    }
    return this.#complete(index, blockId, 'completed');
  }

  finalizeAll(reason: string): ThinkingBlockEvent[] {
    const events: ThinkingBlockEvent[] = [];
    for (const block of [...this.#active.values()]) {
      const result = this.#complete(block.index, block.blockId, reason);
      events.push(...result.events);
    }
    return events;
  }

  snapshot(): ThinkingBlockMetadata[] {
    return [...this.#active.values()].map((block) => this.#metadata(block, 'active'));
  }

  preview(index: ThinkingBlockIndex): string | null {
    return this.#active.get(String(index))?.preview ?? null;
  }

  #start(index: ThinkingBlockIndex, blockId: string, synthetic: boolean): ThinkingBlockProjectionResult {
    if (this.#completed.has(blockId)) return { status: 'rejected', reason: 'already_completed', events: [] };
    if (this.#active.has(blockId)) return { status: 'rejected', reason: 'duplicate_start', events: [] };
    if (this.#startedCount >= this.#maxBlocks) return { status: 'rejected', reason: 'block_limit', events: [] };
    if (this.#active.size >= this.#maxActiveBlocks) return { status: 'rejected', reason: 'active_limit', events: [] };
    this.#active.set(blockId, {
      blockId, index, hash: createHash('sha256'), preview: '', chunkCount: 0, totalBytes: 0, truncated: false,
    });
    this.#startedCount += 1;
    return {
      status: 'accepted',
      events: [{
        type: 'assistant.thinking.started',
        payload: { schemaVersion: 1, blockId, index, syntheticStart: synthetic, contentPersisted: false },
      }],
    };
  }

  #complete(index: ThinkingBlockIndex, blockId: string, reason: string): ThinkingBlockProjectionResult {
    const block = this.#active.get(blockId);
    if (!block) {
      return { status: 'rejected', reason: this.#completed.has(blockId) ? 'already_completed' : 'invalid_index', events: [] };
    }
    this.#active.delete(blockId);
    this.#completed.add(blockId);
    const status = reason === 'completed' ? 'completed' : 'incomplete';
    return {
      status: 'accepted',
      events: [{
        type: 'assistant.thinking.completed',
        payload: {
          ...this.#metadata(block, status),
          contentSha256: block.hash.digest('hex'),
          completionReason: safeReason(reason),
        },
      }],
    };
  }

  #metadata(block: ActiveBlock, status: ThinkingBlockMetadata['status']): ThinkingBlockMetadata {
    return {
      schemaVersion: 1,
      blockId: block.blockId,
      index: block.index,
      status,
      chunkCount: block.chunkCount,
      totalBytes: block.totalBytes,
      capturedBytes: Buffer.byteLength(block.preview, 'utf8'),
      truncated: block.truncated,
      contentPersisted: false,
    };
  }
}

function thinkingIndex(value: unknown): ThinkingBlockIndex | null {
  if (Number.isSafeInteger(value) && Number(value) >= 0) return Number(value);
  if (typeof value !== 'string') return null;
  const clean = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(clean) ? clean : null;
}

function utf8Prefix(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let prefix = '';
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > maxBytes) break;
    prefix += character;
    bytes += size;
  }
  return prefix;
}

function boundedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error('Invalid Thinking block bound');
  return value;
}

function safeReason(value: string): string {
  const reason = value.trim().toLowerCase();
  return /^[a-z0-9_.-]{1,80}$/.test(reason) ? reason : 'unknown';
}
