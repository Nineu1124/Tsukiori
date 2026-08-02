import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';

export function parseServerUrl(line) {
  const match = line.match(/opencode server listening.*\bon\s+(https?:\/\/[^\s]+)/i);
  return match ? match[1] : null;
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function sanitizeText(value, temporaryRoot = '') {
  let result = String(value ?? '');
  const replacements = [
    [temporaryRoot, '<TEMP>'],
    [homedir(), '<HOME>'],
    [tmpdir(), '<OS_TEMP>'],
  ];
  for (const [source, replacement] of replacements) {
    if (source) {
      result = result.split(source).join(replacement);
    }
  }
  return result
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, '<REDACTED_KEY>')
    .replace(/(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{12,}/g, '<REDACTED_TOKEN>')
    .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, 'Basic <REDACTED>');
}

export function eventSummary(event) {
  const payload =
    event && typeof event === 'object' && event.payload && typeof event.payload === 'object'
      ? event.payload
      : event;
  const type =
    payload && typeof payload === 'object' && typeof payload.type === 'string'
      ? payload.type
      : 'unknown';
  const properties =
    payload && typeof payload === 'object' && payload.properties && typeof payload.properties === 'object'
      ? payload.properties
      : {};
  return {
    type,
    hasSession:
      typeof properties.sessionID === 'string' ||
      (properties.info && typeof properties.info.sessionID === 'string'),
  };
}

export function unwrap(result, label) {
  if (!result || typeof result !== 'object') {
    throw new Error(label + ' returned no structured result');
  }
  if (result.error) {
    throw new Error(label + ' failed: ' + JSON.stringify(result.error));
  }
  return result.data;
}

export async function waitFor(check, options = {}) {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const intervalMs = options.intervalMs ?? 250;
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await check();
      if (value) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  if (lastError) {
    throw lastError;
  }
  throw new Error('Timed out after ' + timeoutMs + 'ms');
}