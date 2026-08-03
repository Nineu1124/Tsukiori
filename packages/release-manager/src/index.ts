import { createHash, sign as signBytes, verify as verifyBytes, type KeyLike } from 'node:crypto';

export type ReleaseChannel = 'stable' | 'candidate';
export type UnsignedReleaseManifest = {
  schemaVersion: 1;
  desktop: {
    version: string;
    hostProtocolVersion: number;
    ipcProtocolVersion: number;
    daemonProtocol: { minimum: number; maximum: number };
    maximumDatabaseSchema: number;
  };
  daemon: { version: string; hostProtocolVersion: number; ipcProtocolVersion: number };
  artifact: {
    fileName: string;
    byteLength: number;
    sha256: string;
    authenticodeRequired: boolean;
  };
  source: { channel: ReleaseChannel; downloadUrl: string };
  createdAt: string;
};
export type ReleaseManifest = UnsignedReleaseManifest & {
  signature: { algorithm: 'Ed25519'; keyId: string; value: string };
};
export type ReleasePolicy = {
  allowedOrigins: readonly string[];
  allowedChannels: readonly ReleaseChannel[];
  trustedKeyIds: readonly string[];
  currentDatabaseSchema: number;
};

export class ReleaseVerificationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ReleaseVerificationError';
  }
}

function assertVersion(value: string, field: string): void {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)) {
    throw new ReleaseVerificationError('invalid_version', `${field} is not a supported semantic version`);
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (!value || typeof value !== 'object') {
    throw new ReleaseVerificationError('invalid_manifest', 'Manifest is not canonicalizable');
  }
  return '{' + Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item))
    .join(',') + '}';
}

function payload(manifest: ReleaseManifest | UnsignedReleaseManifest): Buffer {
  const { signature: _signature, ...unsigned } = manifest as ReleaseManifest;
  return Buffer.from(canonical(unsigned), 'utf8');
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function signReleaseManifest(
  manifest: UnsignedReleaseManifest,
  keyId: string,
  privateKey: KeyLike,
): ReleaseManifest {
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(keyId)) {
    throw new ReleaseVerificationError('invalid_key_id', 'Signing key id is invalid');
  }
  validateShape(manifest);
  return {
    ...structuredClone(manifest),
    signature: {
      algorithm: 'Ed25519',
      keyId,
      value: signBytes(null, payload(manifest), privateKey).toString('base64'),
    },
  };
}

export function assertDesktopDaemonCompatibility(manifest: UnsignedReleaseManifest): void {
  const minimum = manifest.desktop.daemonProtocol.minimum;
  const maximum = manifest.desktop.daemonProtocol.maximum;
  if (minimum > maximum || manifest.daemon.hostProtocolVersion < minimum
    || manifest.daemon.hostProtocolVersion > maximum
    || manifest.desktop.ipcProtocolVersion !== manifest.daemon.ipcProtocolVersion) {
    throw new ReleaseVerificationError('incompatible_daemon', 'Desktop and Daemon protocols are incompatible');
  }
}

export function verifyReleaseManifest(input: {
  manifest: ReleaseManifest;
  artifact: Uint8Array;
  publicKey: KeyLike;
  policy: ReleasePolicy;
}): { desktopVersion: string; daemonVersion: string; rollbackAllowed: true } {
  const { manifest, artifact, publicKey, policy } = input;
  validateShape(manifest);
  assertDesktopDaemonCompatibility(manifest);
  if (!policy.trustedKeyIds.includes(manifest.signature.keyId)) {
    throw new ReleaseVerificationError('untrusted_key', 'Release signing key is not trusted');
  }
  if (!verifyBytes(null, payload(manifest), publicKey, Buffer.from(manifest.signature.value, 'base64'))) {
    throw new ReleaseVerificationError('invalid_signature', 'Release manifest signature is invalid');
  }
  const url = new URL(manifest.source.downloadUrl);
  if (url.protocol !== 'https:' || url.username || url.password
    || !policy.allowedOrigins.includes(url.origin)
    || !policy.allowedChannels.includes(manifest.source.channel)) {
    throw new ReleaseVerificationError('untrusted_source', 'Release source or channel is not trusted');
  }
  const sourceName = decodeURIComponent(url.pathname.split('/').at(-1) ?? '');
  if (sourceName !== manifest.artifact.fileName) {
    throw new ReleaseVerificationError('artifact_name_mismatch', 'Release URL does not match artifact name');
  }
  if (artifact.byteLength !== manifest.artifact.byteLength || sha256(artifact) !== manifest.artifact.sha256) {
    throw new ReleaseVerificationError('artifact_mismatch', 'Release artifact hash or length is invalid');
  }
  if (policy.currentDatabaseSchema > manifest.desktop.maximumDatabaseSchema) {
    throw new ReleaseVerificationError(
      'database_downgrade_blocked',
      'Target application cannot read the current database schema',
    );
  }
  return {
    desktopVersion: manifest.desktop.version,
    daemonVersion: manifest.daemon.version,
    rollbackAllowed: true,
  };
}

export function assertWindowsArtifactTrust(input: {
  signatureStatus: string;
  signerThumbprint: string | null;
  trustedThumbprints: readonly string[];
}): void {
  const thumbprint = input.signerThumbprint?.replaceAll(' ', '').toUpperCase() ?? '';
  const trusted = input.trustedThumbprints.map((item) => item.replaceAll(' ', '').toUpperCase());
  if (input.signatureStatus !== 'Valid' || !thumbprint || !trusted.includes(thumbprint)) {
    throw new ReleaseVerificationError(
      'invalid_authenticode',
      'Windows artifact is not signed by a trusted publisher',
    );
  }
}

function validateShape(manifest: UnsignedReleaseManifest | ReleaseManifest): void {
  if (manifest.schemaVersion !== 1) {
    throw new ReleaseVerificationError('invalid_manifest', 'Unsupported release manifest schema');
  }
  assertVersion(manifest.desktop.version, 'Desktop version');
  assertVersion(manifest.daemon.version, 'Daemon version');
  for (const value of [
    manifest.desktop.hostProtocolVersion,
    manifest.desktop.ipcProtocolVersion,
    manifest.desktop.daemonProtocol.minimum,
    manifest.desktop.daemonProtocol.maximum,
    manifest.desktop.maximumDatabaseSchema,
    manifest.daemon.hostProtocolVersion,
    manifest.daemon.ipcProtocolVersion,
    manifest.artifact.byteLength,
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ReleaseVerificationError('invalid_manifest', 'Release manifest contains an invalid integer');
    }
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(manifest.artifact.fileName)
    || !/^[a-f0-9]{64}$/.test(manifest.artifact.sha256)
    || typeof manifest.artifact.authenticodeRequired !== 'boolean'
    || !['stable', 'candidate'].includes(manifest.source.channel)
    || Number.isNaN(Date.parse(manifest.createdAt))) {
    throw new ReleaseVerificationError('invalid_manifest', 'Release manifest fields are invalid');
  }
  if ('signature' in manifest && (manifest.signature.algorithm !== 'Ed25519'
    || !/^[a-z0-9][a-z0-9._-]{2,63}$/.test(manifest.signature.keyId)
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(manifest.signature.value))) {
    throw new ReleaseVerificationError('invalid_signature', 'Release signature envelope is invalid');
  }
}
