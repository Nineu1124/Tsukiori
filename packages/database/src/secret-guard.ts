import { Buffer } from 'node:buffer';

const forbiddenKey = /(^|[_-])(api[_-]?key|secret|token|password|passwd|cookie|authorization|private[_-]?key)([_-]|$)/i;
const credentialPatterns = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}={0,2}\b/i,
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
];

export class PersistenceBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PersistenceBoundaryError';
  }
}

export class SecretGuard {
  readonly #knownSecrets: readonly string[];
  readonly #maxJsonBytes: number;
  readonly #maxBlobBytes: number;

  constructor(options: {
    knownSecrets?: readonly string[];
    maxJsonBytes?: number;
    maxBlobBytes?: number;
  } = {}) {
    this.#knownSecrets = (options.knownSecrets ?? []).filter((value) => value.length >= 4);
    this.#maxJsonBytes = options.maxJsonBytes ?? 256 * 1024;
    this.#maxBlobBytes = options.maxBlobBytes ?? 10 * 1024 * 1024;
  }

  serializeJson(value: unknown): string {
    this.#inspect(value, '$', new Set<object>());
    let serialized: string;
    try {
      serialized = JSON.stringify(value);
    } catch {
      throw new PersistenceBoundaryError('Value is not JSON serializable');
    }
    if (serialized === undefined) {
      throw new PersistenceBoundaryError('Value is not JSON serializable');
    }
    if (Buffer.byteLength(serialized, 'utf8') > this.#maxJsonBytes) {
      throw new PersistenceBoundaryError('JSON payload exceeds persistence limit');
    }
    this.assertText(serialized);
    return serialized;
  }

  assertBlob(data: Uint8Array): void {
    if (data.byteLength > this.#maxBlobBytes) {
      throw new PersistenceBoundaryError('Blob exceeds persistence limit');
    }
    this.assertText(Buffer.from(data).toString('utf8'));
  }

  assertText(text: string): void {
    for (const pattern of credentialPatterns) {
      if (pattern.test(text)) {
        throw new PersistenceBoundaryError('Credential-like content rejected before persistence');
      }
    }
    for (const secret of this.#knownSecrets) {
      if (text.includes(secret)) {
        throw new PersistenceBoundaryError('Known secret rejected before persistence');
      }
    }
  }

  #inspect(value: unknown, path: string, seen: Set<object>): void {
    if (value === null || typeof value === 'boolean' || typeof value === 'number') return;
    if (typeof value === 'string') {
      this.assertText(value);
      return;
    }
    if (typeof value !== 'object') {
      throw new PersistenceBoundaryError('Unsupported value at ' + path);
    }
    if (seen.has(value)) {
      throw new PersistenceBoundaryError('Cyclic value rejected at ' + path);
    }
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((item, index) => this.#inspect(item, path + '[' + index + ']', seen));
    } else {
      for (const [key, item] of Object.entries(value)) {
        if (forbiddenKey.test(key)) {
          throw new PersistenceBoundaryError('Secret field rejected at ' + path + '.' + key);
        }
        this.#inspect(item, path + '.' + key, seen);
      }
    }
    seen.delete(value);
  }
}