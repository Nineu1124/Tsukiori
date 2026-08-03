import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const releaseRoot = join(root, 'docs', 'releases', 'v1.0.0-rc.1');

function canonical(value) {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item))
    .join(',') + '}';
}

test('the public candidate manifest is signed by the committed Ed25519 release key', async () => {
  const manifest = JSON.parse(await readFile(join(releaseRoot, 'release-manifest.json'), 'utf8'));
  const publicPem = await readFile(join(root, 'docs', 'releases', 'keys', 'tsukiori-release-2026.pub'));
  const publicKey = createPublicKey(publicPem);
  assert.equal(publicKey.asymmetricKeyType, 'ed25519');
  assert.equal(manifest.signature.algorithm, 'Ed25519');
  assert.equal(manifest.signature.keyId, 'tsukiori-release-2026');
  const { signature, ...unsigned } = manifest;
  assert.equal(verify(
    null,
    Buffer.from(canonical(unsigned), 'utf8'),
    publicKey,
    Buffer.from(signature.value, 'base64'),
  ), true);
  assert.equal(manifest.source.channel, 'candidate');
  assert.equal(manifest.artifact.authenticodeRequired, false);
  assert.equal(new URL(manifest.source.downloadUrl).origin, 'https://github.com');
  assert.equal(manifest.desktop.maximumDatabaseSchema, 6);
});

test('published checksums map the installer and blockmap without private signing material', async () => {
  const manifestText = await readFile(join(releaseRoot, 'release-manifest.json'), 'utf8');
  const checksums = await readFile(join(releaseRoot, 'SHA256SUMS.txt'), 'utf8');
  const publicKey = await readFile(join(root, 'docs', 'releases', 'keys', 'tsukiori-release-2026.pub'), 'utf8');
  const script = await readFile(join(root, 'scripts', 'prepare-github-release.mjs'), 'utf8');
  const manifest = JSON.parse(manifestText);
  assert.match(checksums, new RegExp(`^${manifest.artifact.sha256}  ${manifest.artifact.fileName}`, 'm'));
  assert.match(checksums, /^[a-f0-9]{64}  Tsukiori-1\.0\.0-rc\.1-x64-setup\.exe\.blockmap$/m);
  assert.match(publicKey, /^-----BEGIN PUBLIC KEY-----/);
  assert.doesNotMatch(manifestText + checksums + publicKey, /PRIVATE KEY|secretref:/);
  assert.match(script, /credentialStore: 'windows_credential_manager'/);
  assert.match(script, /privateKeyPersistedInRepository: false/);
});
