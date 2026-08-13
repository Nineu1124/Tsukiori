import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderKind } from './provider-registry.js';

export type ProviderVerificationAuditRecord = {
  schemaVersion: 1;
  id: string;
  action: 'provider_verify';
  providerId: string;
  providerKind: ProviderKind;
  outcome: 'succeeded' | 'failed';
  category: string;
  latencyMs: number;
  testedAt: number;
};

export type ProviderVerificationAuditSink = (record: ProviderVerificationAuditRecord) => void;

const maximumRecords = 500;
const maximumFileBytes = 2 * 1024 * 1024;

export class ProviderVerificationAuditStore {
  readonly #path: string;

  constructor(userDataPath: string) {
    mkdirSync(userDataPath, { recursive: true });
    this.#path = join(userDataPath, 'provider-verification-audit-v1.json');
  }

  record(value: ProviderVerificationAuditRecord): void {
    const rows = [...this.list(), sanitizeRecord(value)].slice(-maximumRecords);
    const temporary = this.#path + '.' + randomUUID() + '.tmp';
    try {
      writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, records: rows }, null, 2), {
        encoding: 'utf8',
        mode: 0o600,
      });
      renameSync(temporary, this.#path);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  }

  list(): ProviderVerificationAuditRecord[] {
    if (!existsSync(this.#path)) return [];
    if (statSync(this.#path).size > maximumFileBytes) throw new Error('provider_audit_file_too_large');
    let value: unknown;
    try { value = JSON.parse(readFileSync(this.#path, 'utf8')); }
    catch { throw new Error('provider_audit_file_corrupt'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('provider_audit_file_corrupt');
    const root = value as Record<string, unknown>;
    if (root.schemaVersion !== 1 || !Array.isArray(root.records)) throw new Error('provider_audit_file_corrupt');
    return root.records.slice(-maximumRecords).map((record) => sanitizeRecord(record));
  }
}

function sanitizeRecord(value: unknown): ProviderVerificationAuditRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('provider_audit_record_invalid');
  const record = value as Record<string, unknown>;
  const providerKind = parseProviderKind(record.providerKind);
  const outcome = record.outcome === 'succeeded' ? 'succeeded' : record.outcome === 'failed' ? 'failed' : null;
  if (record.schemaVersion !== 1 || record.action !== 'provider_verify' || !outcome) {
    throw new Error('provider_audit_record_invalid');
  }
  return {
    schemaVersion: 1,
    id: safeIdentifier(record.id),
    action: 'provider_verify',
    providerId: safeIdentifier(record.providerId),
    providerKind,
    outcome,
    category: safeCategory(record.category),
    latencyMs: boundedInteger(record.latencyMs, 0, 60_000),
    testedAt: boundedInteger(record.testedAt, 1, Number.MAX_SAFE_INTEGER),
  };
}

function parseProviderKind(value: unknown): ProviderKind {
  if (value === 'chatgpt' || value === 'claude-native' || value === 'openai' || value === 'anthropic'
    || value === 'deepseek' || value === 'openai-compatible' || value === 'anthropic-compatible') return value;
  throw new Error('provider_audit_record_invalid');
}

function safeIdentifier(value: unknown): string {
  const result = String(value ?? '');
  if (!result || result.length > 160 || !/^[A-Za-z0-9:_-]+$/.test(result)) {
    throw new Error('provider_audit_record_invalid');
  }
  return result;
}

function safeCategory(value: unknown): string {
  const result = String(value ?? 'unknown').toLowerCase();
  return /^[a-z0-9_-]{1,64}$/.test(result) ? result : 'unknown';
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new Error('provider_audit_record_invalid');
  }
  return result;
}
