import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const release = await import(pathToFileURL(join(root, 'packages', 'release-manager', 'dist', 'index.js')).href);
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const artifact = Buffer.from('sanitized Tsukiori NSIS fixture');

function unsigned(overrides = {}) {
  return {
    schemaVersion: 1,
    desktop: {
      version: '1.0.0-rc.1', hostProtocolVersion: 2, ipcProtocolVersion: 3,
      daemonProtocol: { minimum: 2, maximum: 2 }, maximumDatabaseSchema: 6,
    },
    daemon: { version: '1.1.0', hostProtocolVersion: 2, ipcProtocolVersion: 3 },
    artifact: {
      fileName: 'Tsukiori-1.0.0-rc.1-x64-setup.exe', byteLength: artifact.byteLength,
      sha256: release.sha256(artifact), authenticodeRequired: true,
    },
    source: {
      channel: 'candidate',
      downloadUrl: 'https://github.com/Nineu1124/Tsukiori/releases/download/v1.0.0-rc.1/Tsukiori-1.0.0-rc.1-x64-setup.exe',
    },
    createdAt: '2026-08-02T00:00:00.000Z',
    ...overrides,
  };
}

function verify(manifest, bytes = artifact, policy = {}) {
  return release.verifyReleaseManifest({
    manifest, artifact: bytes, publicKey,
    policy: {
      allowedOrigins: ['https://github.com'], allowedChannels: ['candidate'],
      trustedKeyIds: ['fixture-2026'], currentDatabaseSchema: 6,
      ...policy,
    },
  });
}

test('independent Desktop and Daemon versions are accepted only when protocols are compatible', () => {
  const manifest = release.signReleaseManifest(unsigned(), 'fixture-2026', privateKey);
  assert.deepEqual(verify(manifest), {
    desktopVersion: '1.0.0-rc.1', daemonVersion: '1.1.0', rollbackAllowed: true,
  });
  assert.throws(() => release.assertDesktopDaemonCompatibility(unsigned({
    daemon: { version: '1.1.0', hostProtocolVersion: 4, ipcProtocolVersion: 3 },
  })), /incompatible/);
});

test('source, detached signature, artifact hash, channel, and signing key fail closed', () => {
  const manifest = release.signReleaseManifest(unsigned(), 'fixture-2026', privateKey);
  assert.throws(() => verify(manifest, Buffer.from('tampered')), /hash or length/);
  assert.throws(() => verify({
    ...manifest,
    source: { ...manifest.source, downloadUrl: 'https://example.invalid/update.exe' },
  }), /signature/);
  assert.throws(() => verify(manifest, artifact, { trustedKeyIds: ['other-key'] }), /not trusted/);
  assert.throws(() => verify(manifest, artifact, { allowedChannels: ['stable'] }), /source or channel/);
  const untrustedSource = release.signReleaseManifest(unsigned({
    source: {
      channel: 'candidate',
      downloadUrl: 'https://example.invalid/Tsukiori-1.0.0-rc.1-x64-setup.exe',
    },
  }), 'fixture-2026', privateKey);
  assert.throws(() => verify(untrustedSource), /source or channel/);
});

test('rollback is blocked when the installed database is newer than the target application', () => {
  const manifest = release.signReleaseManifest(unsigned(), 'fixture-2026', privateKey);
  assert.throws(() => verify(manifest, artifact, { currentDatabaseSchema: 7 }), /cannot read/);
});

test('Windows release engineering declares x64 assisted NSIS, unpacked helpers, and fail-closed signing', () => {
  const desktopPackage = JSON.parse(readFileSync(join(root, 'apps', 'desktop', 'package.json'), 'utf8'));
  const config = readFileSync(join(root, 'apps', 'desktop', 'electron-builder.config.cjs'), 'utf8');
  const main = readFileSync(join(root, 'apps', 'desktop', 'electron-main', 'main.ts'), 'utf8');
  assert.match(desktopPackage.scripts['package:win'], /--config electron-builder\.config\.cjs --win nsis --x64/);
  assert.match(desktopPackage.scripts['package:win:release'], /TSUKIORI_REQUIRE_CODE_SIGNING=1/);
  assert.match(config, /oneClick: false/);
  assert.match(config, /allowToChangeInstallationDirectory: true/);
  assert.match(config, /deleteAppDataOnUninstall: false/);
  assert.match(config, /forceCodeSigning: requireSigning/);
  assert.match(config, /credential-broker\/dist\/windows/);
  assert.match(config, /dist\/daemon\/windows/);
  assert.match(main, /app\.isPackaged/);
  assert.match(main, /app\.getAppPath\(\), 'dist', 'daemon'/);
});
test('Windows publisher trust requires a valid signature and allow-listed thumbprint', () => {
  assert.doesNotThrow(() => release.assertWindowsArtifactTrust({
    signatureStatus: 'Valid', signerThumbprint: 'AA BB CC', trustedThumbprints: ['AABBCC'],
  }));
  assert.throws(() => release.assertWindowsArtifactTrust({
    signatureStatus: 'NotSigned', signerThumbprint: null, trustedThumbprints: ['AABBCC'],
  }), /trusted publisher/);
});