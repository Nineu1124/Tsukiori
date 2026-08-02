import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import type { BlobObjectRecord } from '@tsukiori/domain';
import { SecretGuard } from './secret-guard.js';

export class RestrictedBlobStore {
  readonly #root: string;
  readonly #guard: SecretGuard;

  constructor(root: string, guard: SecretGuard) {
    this.#root = resolve(root);
    this.#guard = guard;
    mkdirSync(this.#root, { recursive: true });
  }

  put(data: Uint8Array, mediaType: string, createdAt = Date.now()): BlobObjectRecord {
    this.#guard.assertBlob(data);
    this.#guard.assertText(mediaType);
    const contentHash = createHash('sha256').update(data).digest('hex');
    const relativePath = contentHash.slice(0, 2) + '/' + contentHash + '.blob';
    const destination = resolve(this.#root, relativePath);
    if (!destination.startsWith(this.#root + sep)) {
      throw new Error('Blob destination escaped store root');
    }
    mkdirSync(dirname(destination), { recursive: true });
    if (!existsSync(destination)) {
      const temporary = destination + '.' + randomUUID() + '.tmp';
      writeFileSync(temporary, data, { flag: 'wx' });
      try {
        renameSync(temporary, destination);
      } catch (error: unknown) {
        if (!existsSync(destination)) throw error;
        rmSync(temporary, { force: true });
      }
    }
    return {
      id: 'blob:' + contentHash,
      contentHash,
      relativePath,
      byteLength: data.byteLength,
      mediaType,
      createdAt,
    };
  }
}