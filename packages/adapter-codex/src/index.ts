import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { LocalDatabase } from '@tsukiori/database';
import type {
  JsonValue, ProcessRecord, RuntimeAuditRecord, RuntimeAuthSource,
  RuntimeCompatibility, RuntimeHandleRecord, RuntimeProfileRecord,
} from '@tsukiori/domain';
import { ExecutionEnvironmentRegistry } from '@tsukiori/project-manager';
import {
  probeCodexNativeCapabilities,
  type CodexNativeCapabilitySnapshot,
} from './capability-probe.js';
import { CodexSessionBridge } from './protocol-bridge.js';

const REQUEST_TIMEOUT_MS = 15_000;

export class CodexAdapterError extends Error {
  constructor(message: string) { super(message); this.name = 'CodexAdapterError'; }
}

export type CodexLaunchCandidate = {
  executable: string;
  prefixArgs?: string[];
  source: 'explicit' | 'npm-global' | 'path-executable';
};

type SchemaManifest = {
  codexVersion: string;
  experimental: boolean;
  sha256: string;
  bytes: number;
};

type SchemaBundle = {
  definitions?: Record<string, unknown> & { v2?: Record<string, unknown> };
};

type PendingRequest = {
  method: string;
  timer: ReturnType<typeof setTimeout>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type InternalHandle = {
  child: ChildProcessWithoutNullStreams;
  record: RuntimeHandleRecord;
  process: ProcessRecord;
  pending: Map<number, PendingRequest>;
  nextId: number;
  expectedExit: boolean;
  closed: boolean;
};

export type CodexAuthProjection = {
  authenticated: boolean;
  source: RuntimeAuthSource;
  requiresOpenaiAuth: boolean;
};

export class CodexRuntimeHandle {
  constructor(
    readonly id: string,
    readonly profileId: string,
    readonly auth: CodexAuthProjection,
    private readonly adapter: CodexRuntimeAdapter,
  ) {}

  request(method: string, params: JsonValue = {}): Promise<unknown> {
    return this.adapter.request(this.id, method, params);
  }

  probeCapabilities(cwd: string): Promise<CodexNativeCapabilitySnapshot> {
    return this.adapter.probeCapabilities(this.id, cwd);
  }

  stop(): Promise<void> { return this.adapter.stop(this.id); }
}

class VersionedSchemaLock {
  readonly manifest: SchemaManifest;
  readonly schema: SchemaBundle;
  readonly hash: string;
  readonly valid: boolean;

  constructor(manifestPath: string, schemaPath: string) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as SchemaManifest;
    const bytes = readFileSync(schemaPath);
    const hash = createHash('sha256').update(bytes).digest('hex');
    this.manifest = manifest;
    this.schema = JSON.parse(bytes.toString('utf8')) as SchemaBundle;
    this.hash = hash;
    this.valid = manifest.experimental === false && manifest.sha256 === hash && manifest.bytes === bytes.byteLength;
  }

  get version(): string {
    const match = this.manifest.codexVersion.match(/(\d+\.\d+\.\d+)/);
    if (!match?.[1]) throw new CodexAdapterError('Schema manifest Codex version is invalid');
    return match[1];
  }

  validateInitialize(value: unknown): asserts value is Record<string, unknown> {
    this.#validateDefinition(this.schema.definitions?.InitializeResponse, value, 'InitializeResponse');
  }

  validateAccount(value: unknown): asserts value is Record<string, unknown> {
    this.#validateDefinition(this.schema.definitions?.v2?.GetAccountResponse, value, 'GetAccountResponse');
  }

  #validateDefinition(definition: unknown, value: unknown, name: string): void {
    if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
      throw new CodexAdapterError('Locked Schema definition is missing: ' + name);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new CodexAdapterError(name + ' failed locked Schema validation');
    }
    const schema = definition as { required?: unknown; properties?: unknown };
    const object = value as Record<string, unknown>;
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const field of required) {
      if (typeof field !== 'string' || !Object.hasOwn(object, field)) {
        throw new CodexAdapterError(name + ' failed locked Schema validation');
      }
    }
    if (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) return;
    for (const [field, property] of Object.entries(schema.properties)) {
      if (!Object.hasOwn(object, field) || !property || typeof property !== 'object' || Array.isArray(property)) continue;
      const expected = this.#propertyType(property as Record<string, unknown>);
      if (typeof expected === 'string' && object[field] !== null && typeof object[field] !== expected) {
        throw new CodexAdapterError(name + ' failed locked Schema validation');
      }
    }
  }
  #propertyType(property: Record<string, unknown>): unknown {
    if (typeof property.type === 'string') return property.type;
    if (!Array.isArray(property.allOf)) return undefined;
    for (const item of property.allOf) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const ref = (item as Record<string, unknown>).$ref;
      if (typeof ref !== 'string' || !ref.startsWith('#/')) continue;
      let value: unknown = this.schema;
      for (const segment of ref.slice(2).split('/')) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) { value = undefined; break; }
        value = (value as Record<string, unknown>)[segment.replaceAll('~1', '/').replaceAll('~0', '~')];
      }
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const type = (value as Record<string, unknown>).type;
        if (typeof type === 'string') return type;
      }
    }
    return undefined;
  }}

export class CodexRuntimeAdapter {
  readonly #database: LocalDatabase;
  readonly #environments: ExecutionEnvironmentRegistry;
  readonly #environmentId: string;
  readonly #schema: VersionedSchemaLock;
  readonly #minimumSupportedVersion: string;
  readonly #maximumTestedVersion: string;
  readonly #candidates: () => readonly CodexLaunchCandidate[];
  readonly #now: () => number;
  readonly #id: () => string;
  readonly #daemonBootId: string;
  readonly #handles = new Map<string, InternalHandle>();
  readonly #bridges = new Map<string, CodexSessionBridge>();

  constructor(
    database: LocalDatabase,
    environments: ExecutionEnvironmentRegistry,
    options: {
      executionEnvironmentId: string;
      schemaManifestPath: string;
      schemaBundlePath: string;
      minimumSupportedVersion?: string;
      maximumTestedVersion?: string;
      candidates?: () => readonly CodexLaunchCandidate[];
      now?: () => number;
      id?: () => string;
      daemonBootId?: string;
    },
  ) {
    this.#database = database;
    this.#environments = environments;
    this.#environmentId = options.executionEnvironmentId;
    const environment = environments.get(options.executionEnvironmentId);
    if (environment.type !== 'windows-native') throw new CodexAdapterError('T4.1 supports Windows Native only');
    this.#schema = new VersionedSchemaLock(options.schemaManifestPath, options.schemaBundlePath);
    this.#minimumSupportedVersion = options.minimumSupportedVersion ?? this.#schema.version;
    this.#maximumTestedVersion = options.maximumTestedVersion ?? this.#schema.version;
    this.#candidates = options.candidates ?? defaultCodexCandidates;
    this.#now = options.now ?? Date.now;
    this.#id = options.id ?? randomUUID;
    this.#daemonBootId = options.daemonBootId ?? 'daemon:' + randomUUID();
  }

  probe(): RuntimeProfileRecord {
    return this.#probe('probe');
  }

  reProbe(profileId: string): RuntimeProfileRecord {
    const existing = this.#database.readRuntimeProfile(profileId);
    if (!existing) throw new CodexAdapterError('Runtime Profile not found');
    return this.#probe('reprobe', existing);
  }

  async start(profileId: string, cwd: string): Promise<CodexRuntimeHandle> {
    const profile = this.#database.readRuntimeProfile(profileId);
    if (!profile) throw new CodexAdapterError('Runtime Profile not found');
    if (profile.compatibility !== 'supported') {
      this.#audit('start', 'degraded', { compatibility: profile.compatibility }, profile.id);
      throw new CodexAdapterError('Codex Runtime compatibility is ' + profile.compatibility);
    }
    const environment = this.#environments.get(profile.executionEnvironmentId);
    if (environment.id !== this.#environmentId) throw new CodexAdapterError('Runtime Profile environment mismatch');
    const at = this.#now();
    const handleId = 'runtime-handle:' + this.#id();
    const connectionEpoch = 'codex-epoch:' + this.#id();
    const child = spawn(profile.executablePath, [...profile.launchPrefix, 'app-server'], {
      cwd, env: { ...process.env, NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0' },
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false,
    });
    if (!child.stdin || !child.stdout || !child.stderr || child.pid === undefined) {
      child.kill();
      throw new CodexAdapterError('Codex app-server stdio was not created');
    }
    const record: RuntimeHandleRecord = {
      id: handleId, profileId: profile.id, executionEnvironmentId: profile.executionEnvironmentId,
      connectionEpoch, state: 'starting', pid: child.pid, startedAt: at, updatedAt: at,
    };
    const processRecord: ProcessRecord = {
      id: 'process:' + this.#id(), runtimeHandleId: handleId,
      executionEnvironmentId: profile.executionEnvironmentId, processType: 'runtime', pid: child.pid,
      daemonBootId: this.#daemonBootId, processStartTime: at,
      processFingerprint: this.#hash(profile.executablePath + '\0' + (profile.discoveredVersion ?? 'unknown')),
      spawnNonce: this.#id(), executable: profile.executablePath, cwd, status: 'starting', startedAt: at,
    };
    const internal: InternalHandle = {
      child, record, process: processRecord, pending: new Map(), nextId: 1, expectedExit: false, closed: false,
    };
    this.#handles.set(handleId, internal);
    this.#database.saveRuntimeHandle(record);
    this.#database.saveProcess(processRecord);
    this.#audit('start', 'started', { compatibility: profile.compatibility }, profile.id, handleId);
    this.#attach(internal);
    try {
      const initialized = await this.#request(internal, 'initialize', {
        clientInfo: { name: 'tsukiori', title: 'Tsukiori', version: '0.1.0' },
      });
      this.#schema.validateInitialize(initialized);
      this.#notify(internal, 'initialized', {});
      const init = initialized as Record<string, unknown>;
      internal.record = {
        ...internal.record, state: 'ready', userAgent: String(init.userAgent),
        platformFamily: String(init.platformFamily), platformOs: String(init.platformOs), updatedAt: this.#now(),
      };
      this.#database.saveRuntimeHandle(internal.record);
      this.#audit('initialize', 'succeeded', {
        schemaVersion: this.#schema.version, platformFamily: String(init.platformFamily), platformOs: String(init.platformOs),
      }, profile.id, handleId);
      const account = await this.#request(internal, 'account/read', { refreshToken: false });
      this.#schema.validateAccount(account);
      const auth = this.#auth(account as Record<string, unknown>);
      this.#database.saveRuntimeProfile({
        ...profile, authenticated: auth.authenticated, authSource: auth.source,
        requiresOpenaiAuth: auth.requiresOpenaiAuth, updatedAt: this.#now(),
      });
      internal.process = { ...internal.process, status: 'running' };
      this.#database.saveProcess(internal.process);
      this.#audit('auth_probe', 'succeeded', {
        authenticated: auth.authenticated, authSource: auth.source,
        requiresOpenaiAuth: auth.requiresOpenaiAuth,
      }, profile.id, handleId);
      this.#audit('start', 'succeeded', { state: 'ready' }, profile.id, handleId);
      return new CodexRuntimeHandle(handleId, profile.id, auth, this);
    } catch (error) {
      const failedAt = this.#now();
      internal.record = { ...internal.record, state: 'failed', updatedAt: failedAt };
      internal.process = { ...internal.process, status: 'exited', exitedAt: failedAt };
      this.#database.saveRuntimeHandle(internal.record);
      this.#database.saveProcess(internal.process);
      this.#audit('start', 'failed', { code: 'initialize_or_auth_failed' }, profile.id, handleId);
      internal.expectedExit = true;
      if (child.exitCode === null) {
        const exited = new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
        child.kill();
        await exited;
      }
      throw error;
    }
  }

  request(handleId: string, method: string, params: JsonValue = {}): Promise<unknown> {
    const internal = this.#handles.get(handleId);
    if (!internal || internal.closed || internal.record.state !== 'ready') {
      throw new CodexAdapterError('Runtime Handle is not ready');
    }
    return this.#request(internal, method, params);
  }

  async probeCapabilities(handleId: string, cwd: string): Promise<CodexNativeCapabilitySnapshot> {
    const internal = this.#handles.get(handleId);
    if (!internal || internal.closed || internal.record.state !== 'ready') {
      throw new CodexAdapterError('Runtime Handle is not ready');
    }
    const profile = this.#database.readRuntimeProfile(internal.record.profileId);
    if (!profile || !profile.discoveredVersion) {
      throw new CodexAdapterError('Runtime Profile version is unavailable');
    }
    const snapshot = await probeCodexNativeCapabilities({
      request: (method, params) => this.#request(internal, method, params === undefined ? {} : params),
    }, {
      cwd,
      runtimeVersion: profile.discoveredVersion,
      authenticated: profile.authenticated,
      authSource: profile.authSource,
      now: this.#now,
    });
    this.#audit('capability_probe', 'succeeded', {
      capabilityCount: snapshot.capabilities.length,
      supportLevels: snapshot.capabilities.map((item) => item.supportLevel),
      sandboxEnforcement: snapshot.sandbox.enforcementLevel,
    }, profile.id, handleId);
    return snapshot;
  }

  bindProtocolBridge(handleId: string, bridge: CodexSessionBridge): void {
    const internal = this.#handles.get(handleId);
    if (!internal || internal.closed || internal.record.state !== 'ready') {
      throw new CodexAdapterError('Runtime Handle is not ready');
    }
    if (bridge.handleId !== handleId || bridge.connectionEpoch !== internal.record.connectionEpoch) {
      throw new CodexAdapterError('Codex protocol bridge Handle or connection Epoch mismatch');
    }
    if (bridge.eventReaderCount !== 1) {
      throw new CodexAdapterError('Codex protocol bridge must declare exactly one event reader');
    }
    this.#bridges.set(handleId, bridge);
  }

  async stop(handleId: string): Promise<void> {
    const internal = this.#handles.get(handleId);
    if (!internal || internal.closed) return;
    internal.expectedExit = true;
    internal.record = { ...internal.record, state: 'stopping', expectedExit: true, updatedAt: this.#now() };
    internal.process = { ...internal.process, status: 'stopping' };
    this.#database.saveRuntimeHandle(internal.record);
    this.#database.saveProcess(internal.process);
    this.#audit('stop', 'started', { state: 'stopping' }, internal.record.profileId, handleId);
    const exited = new Promise<void>((resolveExit) => internal.child.once('exit', () => resolveExit()));
    internal.child.stdin.end();
    const timer = setTimeout(() => internal.child.kill(), 2_000);
    await exited;
    clearTimeout(timer);
    this.#audit('stop', 'succeeded', { state: 'stopped' }, internal.record.profileId, handleId);
  }

  #probe(action: 'probe' | 'reprobe', existing?: RuntimeProfileRecord): RuntimeProfileRecord {
    const candidate = this.#discover();
    const version = this.#version(candidate);
    const compatibility = this.#compatibility(version);
    const at = this.#now();
    const id = existing?.id ?? 'runtime-profile:codex:' + this.#hash(
      this.#environmentId + '\0' + candidate.executable + '\0' + candidate.prefixArgs?.join('\0'),
    ).slice(7, 31);
    const profile: RuntimeProfileRecord = {
      id, runtimeType: 'codex', executionEnvironmentId: this.#environmentId,
      executablePath: candidate.executable, launchPrefix: [...(candidate.prefixArgs ?? [])],
      discoverySource: candidate.source, discoveredVersion: version,
      minimumSupportedVersion: this.#minimumSupportedVersion, maximumTestedVersion: this.#maximumTestedVersion,
      schemaVersion: this.#schema.version, schemaHash: 'sha256:' + this.#schema.hash, compatibility,
      authenticated: existing?.authenticated ?? false, authSource: existing?.authSource ?? 'unknown',
      ...(existing?.requiresOpenaiAuth === undefined ? {} : { requiresOpenaiAuth: existing.requiresOpenaiAuth }),
      probedAt: at, createdAt: existing?.createdAt ?? at, updatedAt: at,
    };
    this.#database.saveRuntimeProfile(profile);
    this.#audit('discover', 'succeeded', {
      source: candidate.source, version, executableFingerprint: this.#hash(candidate.executable),
    }, profile.id);
    this.#audit('schema_lock', this.#schema.valid ? 'succeeded' : 'failed', {
      schemaVersion: this.#schema.version, schemaHash: profile.schemaHash,
    }, profile.id);
    this.#audit(action, compatibility === 'supported' ? 'succeeded' : 'degraded', {
      version, compatibility, minimumSupportedVersion: this.#minimumSupportedVersion,
      maximumTestedVersion: this.#maximumTestedVersion,
    }, profile.id);
    return profile;
  }

  #discover(): CodexLaunchCandidate {
    for (const candidate of this.#candidates()) {
      const executable = resolve(candidate.executable);
      if (!existsSync(executable)) continue;
      const canonical = realpathSync.native(executable);
      const result = spawnSync(canonical, [...(candidate.prefixArgs ?? []), '--version'], {
        encoding: 'utf8', windowsHide: true, shell: false, timeout: 10_000,
        maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (!result.error && result.status === 0 && /\d+\.\d+\.\d+/.test(result.stdout ?? '')) {
        return { ...candidate, executable: canonical };
      }
    }
    this.#audit('discover', 'failed', { code: 'codex_not_found' });
    throw new CodexAdapterError('Codex executable was not discovered');
  }

  #version(candidate: CodexLaunchCandidate): string {
    const result = spawnSync(candidate.executable, [...(candidate.prefixArgs ?? []), '--version'], {
      encoding: 'utf8', windowsHide: true, shell: false, timeout: 10_000,
      maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const match = (result.stdout ?? '').match(/(\d+\.\d+\.\d+)/);
    if (result.status !== 0 || !match?.[1]) throw new CodexAdapterError('Codex version probe failed');
    return match[1];
  }

  #compatibility(version: string): RuntimeCompatibility {
    if (!this.#schema.valid) return 'schema_mismatch';
    if (compareSemver(version, this.#minimumSupportedVersion) < 0) return 'incompatible_older';
    if (compareSemver(version, this.#maximumTestedVersion) > 0) return 'unverified_newer';
    if (version !== this.#schema.version) return 'schema_mismatch';
    return 'supported';
  }

  #attach(internal: InternalHandle): void {
    let stderrBytes = 0;
    internal.child.stderr.on('data', (chunk: Buffer) => { stderrBytes += chunk.byteLength; });
    createInterface({ input: internal.child.stdout, crlfDelay: Infinity }).on('line', (line) => {
      let message: Record<string, unknown>;
      try { message = JSON.parse(line) as Record<string, unknown>; }
      catch { this.#failPending(internal, new CodexAdapterError('Codex emitted invalid JSONL')); return; }
      const method = typeof message.method === 'string' ? message.method : undefined;
      if (Object.hasOwn(message, 'id') && !method) {
        const id = Number(message.id);
        const pending = internal.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        internal.pending.delete(id);
        if (message.error) pending.reject(new CodexAdapterError(pending.method + ' failed'));
        else pending.resolve(message.result);
        return;
      }
      const bridge = this.#bridges.get(internal.record.id);
      if (!bridge || !method) return;
      if (Object.hasOwn(message, 'id')) {
        void bridge.handleServerRequest(String(message.id), method, message.params)
          .then((result) => this.#write(internal, { id: message.id as JsonValue, result }))
          .catch(() => this.#write(internal, {
            id: message.id as JsonValue,
            error: { code: -32000, message: 'rejected' },
          }));
        return;
      }
      bridge.acceptNotification(method, message.params);
    });
    internal.child.once('error', (error) => this.#failPending(internal, error));
    internal.child.once('exit', (code) => {
      internal.closed = true;
      this.#bridges.get(internal.record.id)?.invalidateEpoch(
        internal.expectedExit ? 'runtime_stopped' : 'runtime_exited',
      );
      this.#bridges.delete(internal.record.id);
      this.#failPending(internal, new CodexAdapterError('Codex app-server exited'));
      const at = this.#now();
      const existing = this.#database.readRuntimeHandle(internal.record.id);
      const preserveFailure = existing?.state === 'failed';
      internal.record = {
        ...internal.record, state: preserveFailure ? 'failed' : internal.expectedExit ? 'stopped' : 'exited',
        updatedAt: at, exitedAt: at, ...(code === null ? {} : { exitCode: code }), expectedExit: internal.expectedExit,
      };
      internal.process = {
        ...internal.process, status: 'exited', exitedAt: at,
        ...(code === null ? {} : { exitCode: code }),
      };
      this.#database.saveRuntimeHandle(internal.record);
      this.#database.saveProcess(internal.process);
      this.#audit('exit', internal.expectedExit ? 'succeeded' : 'failed', {
        expected: internal.expectedExit, exitCode: code, stderrBytes,
      }, internal.record.profileId, internal.record.id);
    });
  }

  #request(internal: InternalHandle, method: string, params: JsonValue): Promise<unknown> {
    if (internal.closed) return Promise.reject(new CodexAdapterError('Runtime Handle is closed'));
    const id = internal.nextId++;
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        internal.pending.delete(id);
        rejectRequest(new CodexAdapterError(method + ' timed out'));
      }, REQUEST_TIMEOUT_MS);
      internal.pending.set(id, { method, timer, resolve: resolveRequest, reject: rejectRequest });
      internal.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  #notify(internal: InternalHandle, method: string, params: JsonValue): void {
    this.#write(internal, { method, params });
  }

  #write(internal: InternalHandle, message: Record<string, JsonValue>): void {
    if (internal.closed || internal.child.stdin.destroyed) return;
    internal.child.stdin.write(JSON.stringify(message) + '\n');
  }

  #failPending(internal: InternalHandle, error: Error): void {
    for (const pending of internal.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    internal.pending.clear();
  }

  #auth(value: Record<string, unknown>): CodexAuthProjection {
    const account = value.account;
    const requiresOpenaiAuth = value.requiresOpenaiAuth === true;
    if (!account || typeof account !== 'object' || Array.isArray(account)) {
      return { authenticated: false, source: 'none', requiresOpenaiAuth };
    }
    const type = String((account as Record<string, unknown>).type ?? 'unknown');
    const sources: Record<string, RuntimeAuthSource> = {
      chatgpt: 'chatgpt', apiKey: 'apikey', chatgptAuthTokens: 'chatgpt_external_tokens',
      amazonBedrock: 'amazon_bedrock', personalAccessToken: 'access_token', agentIdentity: 'access_token',
    };
    return { authenticated: true, source: sources[type] ?? 'unknown', requiresOpenaiAuth };
  }

  #audit(
    action: RuntimeAuditRecord['action'], outcome: RuntimeAuditRecord['outcome'], detail: JsonValue,
    profileId?: string, handleId?: string,
  ): void {
    this.#database.saveRuntimeAudit({
      id: 'runtime-audit:' + this.#id(), runtimeType: 'codex',
      ...(profileId ? { profileId } : {}), ...(handleId ? { handleId } : {}),
      action, outcome, detail, createdAt: this.#now(),
    });
  }

  #hash(value: string): string { return 'sha256:' + createHash('sha256').update(value).digest('hex'); }
}

export function defaultCodexCandidates(): CodexLaunchCandidate[] {
  const candidates: CodexLaunchCandidate[] = [];
  if (process.env.APPDATA) {
    const entry = join(process.env.APPDATA, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (existsSync(entry)) candidates.push({ executable: process.execPath, prefixArgs: [entry], source: 'npm-global' });
  }
  const where = spawnSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'where.exe'), ['codex.exe'], {
    encoding: 'utf8', windowsHide: true, shell: false, timeout: 5_000,
    maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (where.status === 0) {
    for (const path of (where.stdout ?? '').split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
      candidates.push({ executable: path, source: 'path-executable' });
    }
  }
  return candidates;
}

export * from './capability-probe.js';
export * from './protocol-bridge.js';

function compareSemver(left: string, right: string): number {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return Math.sign(delta);
  }
  return 0;
}
