import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
} from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releaseVersion = json(join(repositoryRoot, 'apps', 'desktop', 'package.json')).version;
const releaseTag = `v${releaseVersion}`;
const artifactName = `Tsukiori-${releaseVersion}-x64-setup.exe`;
const blockmapName = `${artifactName}.blockmap`;
const keyId = 'tsukiori-release-2026';
const releaseDirectory = join(repositoryRoot, 'apps', 'desktop', 'release');
const evidenceDirectory = join(repositoryRoot, 'docs', 'releases', releaseTag);
const privateDirectory = join(repositoryRoot, 'artifacts', 'private', 'release-signing');
const referencePath = join(privateDirectory, `${keyId}.reference.json`);
const publicKeyPath = join(repositoryRoot, 'docs', 'releases', 'keys', `${keyId}.pub`);
const manifestPath = join(evidenceDirectory, 'release-manifest.json');
const checksumPath = join(evidenceDirectory, 'SHA256SUMS.txt');
const binding = {
  runtimeType: 'release',
  runtimeProfileId: keyId,
  environmentVariable: 'TSUKIORI_RELEASE_SIGNING_KEY',
};

function json(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function reference() {
  const value = json(referencePath);
  if (value.schemaVersion !== 1 || value.keyId !== keyId
    || !/^secretref:[a-f0-9-]{36}$/.test(value.reference)) {
    throw new Error('Local release signing reference is invalid');
  }
  return value.reference;
}

function publicKeyPem(key) {
  const publicKey = key.type === 'public' ? key : createPublicKey(key);
  return publicKey.export({ format: 'pem', type: 'spki' });
}

async function modules() {
  const broker = await import(pathToFileURL(
    join(repositoryRoot, 'packages', 'credential-broker', 'dist', 'index.js'),
  ));
  const release = await import(pathToFileURL(
    join(repositoryRoot, 'packages', 'release-manager', 'dist', 'index.js'),
  ));
  return { broker, release };
}

async function bootstrapKey(WindowsCredentialBroker) {
  const broker = new WindowsCredentialBroker();
  try {
    readFileSync(referencePath);
    readFileSync(publicKeyPath);
    return { created: false, reference: reference() };
  } catch {
    try {
      broker.delete(reference());
    } catch {
      // No complete local reference exists yet.
    }
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const secret = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
    const storedReference = broker.store({ secret, binding });
    mkdirSync(privateDirectory, { recursive: true });
    mkdirSync(dirname(publicKeyPath), { recursive: true });
    writeFileSync(referencePath, JSON.stringify({
      schemaVersion: 1,
      keyId,
      reference: storedReference,
      credentialStore: 'windows_credential_manager',
    }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    writeFileSync(publicKeyPath, publicKeyPem(publicKey), { encoding: 'utf8' });
    return { created: true, reference: storedReference };
  }
}

async function main() {
  const { broker: brokerModule, release } = await modules();
  const key = await bootstrapKey(brokerModule.WindowsCredentialBroker);
  const broker = new brokerModule.WindowsCredentialBroker();
  const artifactPath = join(releaseDirectory, artifactName);
  const blockmapPath = join(releaseDirectory, blockmapName);
  const artifact = readFileSync(artifactPath);
  const blockmap = readFileSync(blockmapPath);
  const compatibility = json(join(
    repositoryRoot, 'tests', 'fixtures', 'release', `${releaseTag}-compatibility.json`,
  ));
  const unsigned = {
    schemaVersion: 1,
    desktop: {
      version: compatibility.desktop.version,
      hostProtocolVersion: compatibility.desktop.hostProtocolVersion,
      ipcProtocolVersion: compatibility.desktop.ipcProtocolVersion,
      daemonProtocol: { minimum: 1, maximum: 1 },
      maximumDatabaseSchema: compatibility.desktop.maximumDatabaseSchema,
    },
    daemon: {
      version: compatibility.daemon.version,
      hostProtocolVersion: compatibility.daemon.hostProtocolVersion,
      ipcProtocolVersion: compatibility.daemon.ipcProtocolVersion,
    },
    artifact: {
      fileName: artifactName,
      byteLength: artifact.byteLength,
      sha256: release.sha256(artifact),
      authenticodeRequired: false,
    },
    source: {
      channel: 'candidate',
      downloadUrl: `https://github.com/Nineu1124/Tsukiori/releases/download/${releaseTag}/${artifactName}`,
    },
    createdAt: new Date().toISOString(),
  };

  const manifest = broker.use(key.reference, binding, (secret) => {
    const privateKey = createPrivateKey({
      key: Buffer.from(secret, 'base64'),
      format: 'der',
      type: 'pkcs8',
    });
    const expectedPublicKey = readFileSync(publicKeyPath, 'utf8').trim();
    if (publicKeyPem(privateKey).trim() !== expectedPublicKey) {
      throw new Error('Credential Manager signing key does not match the committed public key');
    }
    return release.signReleaseManifest(unsigned, keyId, privateKey);
  });

  release.verifyReleaseManifest({
    manifest,
    artifact,
    publicKey: readFileSync(publicKeyPath),
    policy: {
      allowedOrigins: ['https://github.com'],
      allowedChannels: ['candidate'],
      trustedKeyIds: [keyId],
      currentDatabaseSchema: compatibility.desktop.maximumDatabaseSchema,
    },
  });

  mkdirSync(evidenceDirectory, { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  writeFileSync(checksumPath, [
    `${release.sha256(artifact)}  ${artifactName}`,
    `${release.sha256(blockmap)}  ${blockmapName}`,
    '',
  ].join('\n'), 'utf8');

  process.stdout.write(JSON.stringify({
    releaseVersion,
    releaseTag,
    artifactName,
    artifactBytes: artifact.byteLength,
    artifactSha256: release.sha256(artifact),
    blockmapSha256: release.sha256(blockmap),
    keyId,
    keyCreated: key.created,
    credentialStore: 'windows_credential_manager',
    privateKeyPersistedInRepository: false,
    publicKeyPath: publicKeyPath.slice(repositoryRoot.length + 1),
    manifestPath: manifestPath.slice(repositoryRoot.length + 1),
    checksumPath: checksumPath.slice(repositoryRoot.length + 1),
    verified: true,
  }, null, 2) + '\n');
}

await main();
