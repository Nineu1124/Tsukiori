import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { toPlainTextPresentation } from '@tsukiori/runtime-core';

export type ResourceKind = 'runtime' | 'pty' | 'event' | 'blob' | 'diff' | 'log';
export type ResourceBudget = { concurrent?: number; maxBytes?: number; queue?: number };
export type ResourceLease = { id: string; kind: 'runtime' | 'pty'; ownerId: string; cancel: () => void };

export const V1_RESOURCE_BUDGETS: Readonly<Record<ResourceKind, ResourceBudget>> = Object.freeze({
  runtime: { concurrent: 3 },
  pty: { concurrent: 8 },
  event: { maxBytes: 64 * 1024, queue: 1024 },
  blob: { maxBytes: 10 * 1024 * 1024 },
  diff: { maxBytes: 2 * 1024 * 1024 },
  log: { maxBytes: 16 * 1024, queue: 256 },
});

export class ResourceLimitError extends Error {
  constructor(readonly kind: ResourceKind, readonly code: 'concurrency' | 'bytes' | 'queue') {
    super(`Resource limit exceeded: ${kind}/${code}`);
    this.name = 'ResourceLimitError';
  }
}

export class ResourceGovernor {
  readonly #budgets: Readonly<Record<ResourceKind, ResourceBudget>>;
  readonly #leases = new Map<string, ResourceLease>();
  readonly #queues = new Map<ResourceKind, number>();

  constructor(budgets: Readonly<Record<ResourceKind, ResourceBudget>> = V1_RESOURCE_BUDGETS) {
    this.#budgets = budgets;
  }

  acquire(kind: 'runtime' | 'pty', ownerId: string, cancel: () => void): ResourceLease {
    if (!ownerId.trim()) throw new Error('Resource owner is required');
    const concurrent = this.#budgets[kind].concurrent ?? 0;
    const active = [...this.#leases.values()].filter((lease) => lease.kind === kind).length;
    if (active >= concurrent) throw new ResourceLimitError(kind, 'concurrency');
    const lease: ResourceLease = { id: `lease:${randomUUID()}`, kind, ownerId, cancel };
    this.#leases.set(lease.id, lease);
    return lease;
  }

  release(leaseId: string): boolean {
    return this.#leases.delete(leaseId);
  }

  cancelAll(kind?: 'runtime' | 'pty'): number {
    const selected = [...this.#leases.values()].filter((lease) => !kind || lease.kind === kind);
    for (const lease of selected) {
      try { lease.cancel(); } finally { this.#leases.delete(lease.id); }
    }
    return selected.length;
  }

  assertBytes(kind: Exclude<ResourceKind, 'runtime' | 'pty'>, value: Uint8Array | string): number {
    const bytes = typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : value.byteLength;
    if (bytes > (this.#budgets[kind].maxBytes ?? 0)) throw new ResourceLimitError(kind, 'bytes');
    return bytes;
  }

  enqueue(kind: 'event' | 'log'): number {
    const next = (this.#queues.get(kind) ?? 0) + 1;
    if (next > (this.#budgets[kind].queue ?? 0)) throw new ResourceLimitError(kind, 'queue');
    this.#queues.set(kind, next);
    return next;
  }

  dequeue(kind: 'event' | 'log'): number {
    const next = Math.max(0, (this.#queues.get(kind) ?? 0) - 1);
    this.#queues.set(kind, next);
    return next;
  }

  snapshot(): { activeRuntime: number; activePty: number; eventQueue: number; logQueue: number } {
    const leases = [...this.#leases.values()];
    return {
      activeRuntime: leases.filter((lease) => lease.kind === 'runtime').length,
      activePty: leases.filter((lease) => lease.kind === 'pty').length,
      eventQueue: this.#queues.get('event') ?? 0,
      logQueue: this.#queues.get('log') ?? 0,
    };
  }
}

export type StructuredLogRecord = {
  schemaVersion: 1;
  at: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  event: string;
  fields: Record<string, unknown>;
};

const secretKey = /(^|[_-])(api[_-]?key|secret|token|password|cookie|authorization|private[_-]?key)([_-]|$)/i;
const secretValue = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+\/-]{8,}|\bsk-[A-Za-z0-9_-]{12,}/gi;

export class StructuredLogger {
  readonly #records: StructuredLogRecord[] = [];
  readonly #knownSecrets: readonly string[];
  readonly #sink: ((line: string) => void) | undefined;
  readonly #maxEntries: number;
  readonly #maxBytes: number;
  dropped = 0;

  constructor(options: {
    knownSecrets?: readonly string[];
    sink?: (line: string) => void;
    maxEntries?: number;
    maxBytes?: number;
  } = {}) {
    this.#knownSecrets = options.knownSecrets ?? [];
    this.#sink = options.sink;
    this.#maxEntries = options.maxEntries ?? 256;
    this.#maxBytes = options.maxBytes ?? 16 * 1024;
  }

  log(level: StructuredLogRecord['level'], event: string, fields: Record<string, unknown>, at = Date.now()): void {
    if (!/^[a-z0-9_.-]{1,80}$/.test(event)) throw new Error('Structured log event is invalid');
    const record: StructuredLogRecord = {
      schemaVersion: 1,
      at,
      level,
      event,
      fields: this.#sanitize(fields) as Record<string, unknown>,
    };
    let line = JSON.stringify(record);
    if (Buffer.byteLength(line, 'utf8') > this.#maxBytes) {
      record.fields = {
        truncated: true,
        contentHash: createHash('sha256').update(line).digest('hex'),
        preview: toPlainTextPresentation(line, Math.max(64, this.#maxBytes - 512)).text,
      };
      line = JSON.stringify(record);
    }
    if (this.#records.length >= this.#maxEntries) {
      this.#records.shift();
      this.dropped += 1;
    }
    this.#records.push(record);
    this.#sink?.(line);
  }

  snapshot(): { records: StructuredLogRecord[]; dropped: number } {
    return { records: structuredClone(this.#records), dropped: this.dropped };
  }

  #sanitize(value: unknown, key = '', seen = new Set<object>()): unknown {
    if (secretKey.test(key)) return '<redacted>';
    if (typeof value === 'string') {
      let output = value.replace(secretValue, '<redacted>');
      for (const secret of this.#knownSecrets) if (secret.length >= 4) output = output.replaceAll(secret, '<redacted>');
      return toPlainTextPresentation(output).text;
    }
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value !== 'object') return '<unsupported>';
    if (seen.has(value)) return '<cycle>';
    seen.add(value);
    const result = Array.isArray(value)
      ? value.map((item) => this.#sanitize(item, '', seen))
      : Object.fromEntries(Object.entries(value).map(([name, item]) => [name, this.#sanitize(item, name, seen)]));
    seen.delete(value);
    return result;
  }
}

export type DiagnosticOptions = {
  includeSensitivePreviews: boolean;
  sensitive?: { prompt?: string; source?: string; rawPayload?: unknown };
};

export class DiagnosticBundleBuilder {
  readonly #knownSecrets: readonly string[];

  constructor(options: { knownSecrets?: readonly string[] } = {}) {
    this.#knownSecrets = options.knownSecrets ?? [];
  }

  estimate(input: {
    versions: Record<string, string>;
    metrics: Record<string, number>;
    logs: ReturnType<StructuredLogger['snapshot']>;
    options: DiagnosticOptions;
  }): { estimatedBytes: number; includesSensitivePreviews: boolean } {
    const body = this.#body(input);
    return {
      estimatedBytes: Buffer.byteLength(JSON.stringify(body), 'utf8'),
      includesSensitivePreviews: input.options.includeSensitivePreviews,
    };
  }

  build(outputPath: string, input: {
    versions: Record<string, string>;
    metrics: Record<string, number>;
    logs: ReturnType<StructuredLogger['snapshot']>;
    options: DiagnosticOptions;
  }): { path: string; byteLength: number; estimatedBytes: number } {
    const path = resolve(outputPath);
    if (!path.endsWith('.json.gz')) throw new Error('Diagnostic bundle must use .json.gz');
    const body = this.#body(input);
    const serialized = Buffer.from(JSON.stringify(body), 'utf8');
    const compressed = gzipSync(serialized, { level: 9 });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, compressed, { mode: 0o600 });
    return { path, byteLength: compressed.byteLength, estimatedBytes: serialized.byteLength };
  }

  #body(input: {
    versions: Record<string, string>;
    metrics: Record<string, number>;
    logs: ReturnType<StructuredLogger['snapshot']>;
    options: DiagnosticOptions;
  }): Record<string, unknown> {
    const sanitizer = new StructuredLogger({
      knownSecrets: this.#knownSecrets,
      maxEntries: 1,
      maxBytes: 256 * 1024,
    });
    sanitizer.log('info', 'diagnostic.bundle_input', {
      versions: input.versions,
      metrics: input.metrics,
      logs: input.logs,
    }, 0);
    const safe = sanitizer.snapshot().records[0]?.fields ?? {};
    const base: Record<string, unknown> = {
      schemaVersion: 1,
      generatedAt: '<timestamp>',
      versions: safe.versions ?? {},
      metrics: safe.metrics ?? {},
      logs: safe.logs ?? { records: [], dropped: 0 },
      exclusions: ['source', 'complete_prompt', 'raw_payload', 'credentials', 'auth_store'],
      sensitivePreviewsIncluded: input.options.includeSensitivePreviews,
    };
    if (input.options.includeSensitivePreviews) {
      const logger = new StructuredLogger({ knownSecrets: this.#knownSecrets, maxEntries: 8, maxBytes: 4096 });
      logger.log('info', 'diagnostic.sensitive_preview', {
        prompt: input.options.sensitive?.prompt ?? '',
        source: input.options.sensitive?.source ?? '',
        rawPayload: input.options.sensitive?.rawPayload ?? null,
      }, 0);
      base.sensitivePreviews = logger.snapshot().records[0]?.fields ?? {};
    }
    return base;
  }
}
