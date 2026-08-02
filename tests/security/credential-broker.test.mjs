import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { WindowsCredentialBroker } = await import(
  pathToFileURL(join(root, 'packages/credential-broker/dist/index.js')).href,
);
const { LocalDatabase, PersistenceBoundaryError } = await import(
  pathToFileURL(join(root, 'packages/database/dist/index.js')).href,
);
const published = JSON.parse(readFileSync(
  join(root, 'tests/fixtures/security/t5.2-result.json'), 'utf8',
));

const binding = {
  runtimeType: 'deepseek',
  runtimeProfileId: 'profile-security-fixture',
  environmentVariable: 'DEEPSEEK_API_KEY',
};

function diskText(directory) {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(join(entry.parentPath, entry.name)))
    .filter((value) => !value.includes(0))
    .map((value) => value.toString('utf8'))
    .join('\n');
}

test('published security fixture declares OS storage, bound injection, and no persisted secret', () => {
  assert.equal(published.credentialStore, 'windows_credential_manager');
  assert.equal(published.commandLineReceivesSecret, false);
  assert.equal(published.rendererReceivesSecret, false);
  assert.equal(published.persistenceReceivesSecret, false);
  assert.equal(published.containsCredentials, false);
  const preload = readFileSync(join(root, 'apps/desktop/preload/index.cjs'), 'utf8');
  const renderer = readFileSync(join(root, 'apps/desktop/renderer/renderer.js'), 'utf8');
  assert.doesNotMatch(preload + renderer, /API_KEY|bootstrapSecretRef|credential-broker|secretref:/i);
  assert.doesNotMatch(JSON.stringify(published), /Bearer\s+|-----BEGIN|sk-[A-Za-z0-9]/);
});

test('Windows Credential Manager stores an opaque reference and injects only into the bound Runtime environment', (t) => {
  const broker = new WindowsCredentialBroker();
  const marker = 'fixture-provider-credential-' + randomUUID();
  const reference = broker.store({ secret: marker, binding });
  t.after(() => broker.delete(reference));
  assert.match(reference, /^secretref:[a-f0-9-]{36}$/);
  assert.throws(() => broker.use(reference, { ...binding, runtimeProfileId: 'other-profile' }, () => undefined), /binding mismatch/);
  let observed;
  const expectedHash = createHash('sha256').update(marker).digest('hex');
  const result = broker.spawnWithSecret({
    reference,
    binding,
    executable: process.execPath,
    args: [
      join(root, 'tests/fixtures/security/credential-child.mjs'),
      binding.environmentVariable,
      expectedHash,
      'OPENAI_API_KEY',
    ],
    environment: { OPENAI_API_KEY: 'other-provider-fixture-secret' },
    observeInvocation: (value) => { observed = value; },
  });
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), { match: true, received: true, forbiddenReceived: false });
  assert.doesNotMatch(JSON.stringify(observed), new RegExp(marker));
  assert.doesNotMatch(JSON.stringify(observed.args), /fixture-provider-credential/);
  assert.deepEqual(observed.environmentKeys, [binding.environmentVariable]);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(marker));
});

test('known Secret is rejected before SQLite, WAL, Blob, log, or diagnostic persistence', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tsukiori-security-persistence-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const marker = 'fixture-known-secret-' + randomUUID();
  const database = new LocalDatabase({
    filePath: join(directory, 'state.db'), blobRoot: join(directory, 'blobs'), knownSecrets: [marker],
  });
  assert.throws(() => database.saveOperation({
    id: 'record', operationId: 'operation', type: 'runtime_session_create', status: 'prepared',
    requestPayload: { value: marker }, createdAt: 1, updatedAt: 1,
  }), PersistenceBoundaryError);
  assert.throws(() => database.putBlob(Buffer.from(marker), 'text/plain'), PersistenceBoundaryError);
  database.close();
  assert.doesNotMatch(diskText(directory), new RegExp(marker));
});
