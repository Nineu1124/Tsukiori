import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import type { LocalDatabase } from '@tsukiori/database';
import type {
  HostTurn, JsonValue, PermissionAuditRecord, PermissionDecision, ProcessRecord, RuntimeAuditRecord, RuntimeCompatibility,
  RuntimeHandleRecord, RuntimeProfileRecord,
} from '@tsukiori/domain';
import { PermissionBroker } from '@tsukiori/permission-broker';
import { ExecutionEnvironmentRegistry } from '@tsukiori/project-manager';
import {
  buildProviderCatalog, data, selectProvider, verifyProvider,
  type OpenCodeProviderCatalog, type OpenCodeProviderSelection,
  type OpenCodeProviderVerification,
} from './provider.js';
import {
  OpenCodeSessionBridge,
  type OpenCodeRecoveryResult,
} from './session-bridge.js';

const START_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 30_000;
type Client = ReturnType<typeof createOpencodeClient>;
type Manifest = { runtimeVersion: string; contentType: string; sha256: string; bytes: number };

export type OpenCodeLaunchCandidate = {
  executable: string;
  prefixArgs?: string[];
  source: 'explicit' | 'environment' | 'npm-global' | 'path-executable';
};

type InternalHandle = {
  child: ChildProcess;
  client: Client;
  record: RuntimeHandleRecord;
  process: ProcessRecord;
  catalog: OpenCodeProviderCatalog;
  bridge: OpenCodeSessionBridge | null;
  cwd: string;
  expectedExit: boolean;
  closed: boolean;
  stdoutBytes: number;
  stderrBytes: number;
};

export class OpenCodeAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenCodeAdapterError';
  }
}

export class OpenCodeRuntimeHandle {
  constructor(
    readonly id: string,
    readonly profileId: string,
    readonly providers: OpenCodeProviderCatalog,
    private readonly adapter: OpenCodeRuntimeAdapter,
  ) {}

  selectProvider(providerId: string, modelId: string): OpenCodeProviderSelection {
    return this.adapter.selectProvider(this.id, providerId, modelId);
  }

  verifyProviderConnection(providerId: string, modelId: string): Promise<OpenCodeProviderVerification> {
    return this.adapter.verifyProviderConnection(this.id, providerId, modelId);
  }

  get eventReaderCount(): number {
    return this.adapter.eventReaderCount(this.id);
  }

  get eventStreamState(): string {
    return this.adapter.eventStreamState(this.id);
  }

  createSession(hostSessionId: string, providerId: string, modelId: string, title?: string): Promise<string> {
    return this.adapter.createSession(this.id, hostSessionId, providerId, modelId, title);
  }

  resumeSession(hostSessionId: string): Promise<string> {
    return this.adapter.resumeSession(this.id, hostSessionId);
  }

  decidePermission(
    permissionId: string,
    connectionEpoch: string,
    decision: PermissionDecision,
  ): Promise<PermissionAuditRecord> {
    return this.adapter.decidePermission(this.id, permissionId, connectionEpoch, decision);
  }

  cancelTurn(hostSessionId: string): Promise<void> {
    return this.adapter.cancelTurn(this.id, hostSessionId);
  }

  startTurn(hostSessionId: string, text: string): Promise<HostTurn> {
    return this.adapter.startTurn(this.id, hostSessionId, text);
  }

  answerQuestion(hostSessionId: string, requestId: string, answers: readonly (readonly string[])[]): Promise<void> {
    return this.adapter.answerQuestion(this.id, hostSessionId, requestId, answers);
  }

  rejectQuestion(hostSessionId: string, requestId: string): Promise<void> {
    return this.adapter.rejectQuestion(this.id, hostSessionId, requestId);
  }

  recoverEventStream(): Promise<OpenCodeRecoveryResult> {
    return this.adapter.recoverEventStream(this.id);
  }

  stop(): Promise<void> {
    return this.adapter.stop(this.id);
  }
}

export class OpenCodeRuntimeAdapter {
  readonly #database: LocalDatabase;
  readonly #environments: ExecutionEnvironmentRegistry;
  readonly #environmentId: string;
  readonly #permissions: PermissionBroker;
  readonly #manifest: Manifest;
  readonly #minimumSupportedVersion: string;
  readonly #maximumTestedVersion: string;
  readonly #candidates: () => readonly OpenCodeLaunchCandidate[];
  readonly #now: () => number;
  readonly #id: () => string;
  readonly #daemonBootId: string;
  readonly #handles = new Map<string, InternalHandle>();

  constructor(
    database: LocalDatabase,
    environments: ExecutionEnvironmentRegistry,
    options: {
      executionEnvironmentId: string;
      openApiManifestPath: string;
      minimumSupportedVersion?: string;
      maximumTestedVersion?: string;
      candidates?: () => readonly OpenCodeLaunchCandidate[];
      now?: () => number;
      id?: () => string;
      daemonBootId?: string;
      permissionBroker?: PermissionBroker;
    },
  ) {
    this.#database = database;
    this.#environments = environments;
    this.#environmentId = options.executionEnvironmentId;
    if (environments.get(options.executionEnvironmentId).type !== 'windows-native') {
      throw new OpenCodeAdapterError('T3.1 supports Windows Native only');
    }
    this.#manifest = JSON.parse(readFileSync(options.openApiManifestPath, 'utf8')) as Manifest;
    this.#minimumSupportedVersion = options.minimumSupportedVersion ?? this.#manifest.runtimeVersion;
    this.#maximumTestedVersion = options.maximumTestedVersion ?? this.#manifest.runtimeVersion;
    this.#candidates = options.candidates ?? defaultOpenCodeCandidates;
    this.#now = options.now ?? Date.now;
    this.#id = options.id ?? randomUUID;
    this.#permissions = options.permissionBroker ?? new PermissionBroker(database, {
      now: this.#now,
      id: this.#id,
    });
    this.#daemonBootId = options.daemonBootId ?? 'daemon:' + randomUUID();
  }

  probe(): RuntimeProfileRecord {
    return this.#probe('probe');
  }

  reProbe(profileId: string): RuntimeProfileRecord {
    const existing = this.#database.readRuntimeProfile(profileId);
    if (!existing) throw new OpenCodeAdapterError('Runtime Profile not found');
    return this.#probe('reprobe', existing);
  }

  async start(profileId: string, cwdValue: string): Promise<OpenCodeRuntimeHandle> {
    const profile = this.#database.readRuntimeProfile(profileId);
    if (!profile) throw new OpenCodeAdapterError('Runtime Profile not found');
    if (profile.compatibility !== 'supported') {
      this.#audit('start', 'degraded', { compatibility: profile.compatibility }, profile.id);
      throw new OpenCodeAdapterError('OpenCode Runtime compatibility is ' + profile.compatibility);
    }
    if (this.#environments.get(profile.executionEnvironmentId).id !== this.#environmentId) {
      throw new OpenCodeAdapterError('Runtime Profile environment mismatch');
    }
    const cwd = realpathSync.native(resolve(cwdValue));
    const at = this.#now();
    const handleId = 'runtime-handle:' + this.#id();
    const username = 'tsukiori';
    const password = randomBytes(32).toString('base64url');
    const authorization = 'Basic ' + Buffer.from(username + ':' + password).toString('base64');
    const child = spawn(profile.executablePath, [
      ...profile.launchPrefix, 'serve', '--hostname=127.0.0.1', '--port=0', '--log-level=WARN',
    ], {
      cwd,
      env: {
        ...process.env,
        NO_COLOR: '1',
        GIT_TERMINAL_PROMPT: '0',
        OPENCODE_SERVER_USERNAME: username,
        OPENCODE_SERVER_PASSWORD: password,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
    if (!child.stdout || !child.stderr || child.pid === undefined) {
      child.kill();
      throw new OpenCodeAdapterError('OpenCode Server stdio was not created');
    }
    const record: RuntimeHandleRecord = {
      id: handleId,
      profileId: profile.id,
      executionEnvironmentId: profile.executionEnvironmentId,
      connectionEpoch: 'opencode-epoch:' + this.#id(),
      state: 'starting',
      pid: child.pid,
      startedAt: at,
      updatedAt: at,
    };
    const processRecord: ProcessRecord = {
      id: 'process:' + this.#id(),
      runtimeHandleId: handleId,
      executionEnvironmentId: profile.executionEnvironmentId,
      processType: 'runtime',
      pid: child.pid,
      daemonBootId: this.#daemonBootId,
      processStartTime: at,
      processFingerprint: this.#hash(profile.executablePath + '\0' + profile.discoveredVersion),
      spawnNonce: this.#id(),
      executable: profile.executablePath,
      cwd,
      status: 'starting',
      startedAt: at,
    };
    const internal: InternalHandle = {
      child,
      client: createOpencodeClient(),
      record,
      process: processRecord,
      catalog: {
        runtimeType: 'opencode',
        runtimeVersion: profile.discoveredVersion ?? 'unknown',
        workspacePathVerified: false,
        vcsDetected: false,
        providers: [],
        providersTruncated: false,
      },
      bridge: null,
      cwd,
      expectedExit: false,
      closed: false,
      stdoutBytes: 0,
      stderrBytes: 0,
    };
    this.#handles.set(handleId, internal);
    this.#database.saveRuntimeHandle(record);
    this.#database.saveProcess(processRecord);
    this.#audit('start', 'started', { scope: 'worktree', loopbackOnly: true }, profile.id, handleId);
    this.#attach(internal);

    try {
      const serverUrl = await this.#waitForServerUrl(internal);
      internal.client = createOpencodeClient({
        baseUrl: serverUrl,
        directory: cwd,
        headers: { Authorization: authorization },
        throwOnError: false,
        fetch: boundedFetch,
      });
      await this.#validateOpenApi(serverUrl, authorization, profile.id, handleId);
      const health = object(data(await internal.client.global.health(), 'global.health'));
      if (health.healthy !== true || health.version !== profile.discoveredVersion) {
        throw new OpenCodeAdapterError('OpenCode health/version response mismatch');
      }
      const pathInfo = object(data(
        await internal.client.path.get({ directory: cwd }),
        'path.get',
      ));
      if (typeof pathInfo.directory !== 'string' || !samePath(pathInfo.directory, cwd)) {
        throw new OpenCodeAdapterError('OpenCode Server escaped the requested Worktree scope');
      }
      const vcs = data(await internal.client.vcs.get({ directory: cwd }), 'vcs.get');
      const providers = data(
        await internal.client.provider.list({ directory: cwd }),
        'provider.list',
      );
      internal.catalog = buildProviderCatalog(
        profile.discoveredVersion ?? this.#manifest.runtimeVersion,
        true,
        Boolean(vcs),
        providers,
      );
      internal.record = {
        ...internal.record,
        state: 'ready',
        userAgent: 'opencode/' + profile.discoveredVersion,
        platformFamily: 'windows',
        platformOs: 'windows',
        updatedAt: this.#now(),
      };
      internal.process = { ...internal.process, status: 'running' };
      this.#database.saveRuntimeHandle(internal.record);
      this.#database.saveProcess(internal.process);
      internal.bridge = new OpenCodeSessionBridge(
        this.#database,
        this.#permissions,
        internal.client,
        internal.record,
        internal.cwd,
        { now: this.#now, id: this.#id },
      );
      await internal.bridge.startEventReader();
      const connected = internal.catalog.providers.filter((item) => item.connected);
      this.#database.saveRuntimeProfile({
        ...profile,
        authenticated: profile.authenticated || connected.length > 0,
        authSource: profile.authenticated ? profile.authSource : connected.length > 0 ? 'unknown' : 'none',
        updatedAt: this.#now(),
      });
      this.#audit('provider_probe', 'succeeded', {
        connectedProviderCount: connected.length,
        destinations: connected.map((item) => ({
          providerId: item.id,
          destinationHost: item.destinationHost,
          credentialSource: item.credentialSource,
        })),
      }, profile.id, handleId);
      this.#audit('start', 'succeeded', {
        state: 'ready',
        workspacePathVerified: true,
        providerCount: internal.catalog.providers.length,
      }, profile.id, handleId);
      return new OpenCodeRuntimeHandle(handleId, profile.id, internal.catalog, this);
    } catch (error) {
      await this.#failStart(internal);
      throw error;
    }
  }

  selectProvider(handleId: string, providerId: string, modelId: string): OpenCodeProviderSelection {
    try {
      return selectProvider(this.#ready(handleId).catalog, providerId, modelId);
    } catch (error) {
      throw new OpenCodeAdapterError(error instanceof Error ? error.message : 'Provider selection failed');
    }
  }

  async verifyProviderConnection(
    handleId: string,
    providerId: string,
    modelId: string,
  ): Promise<OpenCodeProviderVerification> {
    const internal = this.#ready(handleId);
    const selection = this.selectProvider(handleId, providerId, modelId);
    try {
      const result = await verifyProvider(internal.client, internal.cwd, selection);
      this.#audit('provider_verify', 'succeeded', {
        providerId,
        modelId,
        destinationHost: selection.destinationHost,
        messageCount: result.messageCount,
        persistedPromptOrOutput: false,
      }, internal.record.profileId, handleId);
      return result;
    } catch (error) {
      this.#audit('provider_verify', 'failed', {
        providerId,
        modelId,
        destinationHost: selection.destinationHost,
        code: 'provider_verification_failed',
      }, internal.record.profileId, handleId);
      throw new OpenCodeAdapterError('Provider verification failed');
    }
  }

  eventReaderCount(handleId: string): number {
    return this.#bridge(handleId).eventReaderCount;
  }

  eventStreamState(handleId: string): string {
    return this.#bridge(handleId).eventStreamState;
  }

  async createSession(
    handleId: string,
    hostSessionId: string,
    providerId: string,
    modelId: string,
    title?: string,
  ): Promise<string> {
    const selection = this.selectProvider(handleId, providerId, modelId);
    return this.#bridge(handleId).createSession(hostSessionId, selection, title);
  }

  resumeSession(handleId: string, hostSessionId: string): Promise<string> {
    return this.#bridge(handleId).resumeSession(hostSessionId);
  }

  decidePermission(
    handleId: string,
    permissionId: string,
    connectionEpoch: string,
    decision: PermissionDecision,
  ): Promise<PermissionAuditRecord> {
    return this.#bridge(handleId).decidePermission(permissionId, connectionEpoch, decision);
  }

  cancelTurn(handleId: string, hostSessionId: string): Promise<void> {
    return this.#bridge(handleId).cancelTurn(hostSessionId);
  }

  startTurn(handleId: string, hostSessionId: string, text: string): Promise<HostTurn> {
    return this.#bridge(handleId).startTurn(hostSessionId, text);
  }

  answerQuestion(
    handleId: string,
    hostSessionId: string,
    requestId: string,
    answers: readonly (readonly string[])[],
  ): Promise<void> {
    return this.#bridge(handleId).answerQuestion(hostSessionId, requestId, answers);
  }

  rejectQuestion(handleId: string, hostSessionId: string, requestId: string): Promise<void> {
    return this.#bridge(handleId).rejectQuestion(hostSessionId, requestId);
  }

  async recoverEventStream(handleId: string): Promise<OpenCodeRecoveryResult> {
    const internal = this.#ready(handleId);
    const profile = this.reProbe(internal.record.profileId);
    if (profile.compatibility !== 'supported') {
      throw new OpenCodeAdapterError('OpenCode recovery compatibility is ' + profile.compatibility);
    }
    const connectionEpoch = 'opencode-epoch:' + this.#id();
    internal.record = { ...internal.record, connectionEpoch, updatedAt: this.#now() };
    this.#database.saveRuntimeHandle(internal.record);
    return this.#bridge(handleId).recoverConnection(connectionEpoch);
  }

  async stop(handleId: string): Promise<void> {
    const internal = this.#handles.get(handleId);
    if (!internal || internal.closed) return;
    internal.expectedExit = true;
    internal.record = {
      ...internal.record,
      state: 'stopping',
      expectedExit: true,
      updatedAt: this.#now(),
    };
    internal.process = { ...internal.process, status: 'stopping' };
    this.#database.saveRuntimeHandle(internal.record);
    this.#database.saveProcess(internal.process);
    this.#audit('stop', 'started', { state: 'stopping' }, internal.record.profileId, handleId);
    await internal.bridge?.stopEventReader();
    const exited = new Promise<void>((resolveExit) => internal.child.once('exit', () => resolveExit()));
    internal.child.kill('SIGTERM');
    const timer = setTimeout(() => internal.child.kill('SIGKILL'), 3_000);
    await exited;
    clearTimeout(timer);
    this.#audit('stop', 'succeeded', { state: 'stopped' }, internal.record.profileId, handleId);
  }

  #probe(action: 'probe' | 'reprobe', existing?: RuntimeProfileRecord): RuntimeProfileRecord {
    const candidate = this.#discover();
    const version = this.#version(candidate);
    const compatibility = this.#compatibility(version);
    const authentication = this.#authentication(candidate);
    const at = this.#now();
    const id = existing?.id ?? 'runtime-profile:opencode:' + this.#hash(
      this.#environmentId + '\0' + candidate.executable + '\0' + (candidate.prefixArgs ?? []).join('\0'),
    ).slice(7, 31);
    const profile: RuntimeProfileRecord = {
      id,
      runtimeType: 'opencode',
      executionEnvironmentId: this.#environmentId,
      executablePath: candidate.executable,
      launchPrefix: [...(candidate.prefixArgs ?? [])],
      discoverySource: candidate.source,
      discoveredVersion: version,
      minimumSupportedVersion: this.#minimumSupportedVersion,
      maximumTestedVersion: this.#maximumTestedVersion,
      schemaVersion: this.#manifest.runtimeVersion,
      schemaHash: 'sha256:' + this.#manifest.sha256,
      compatibility,
      authenticated: authentication.credentialCount > 0,
      authSource: authentication.credentialCount > 0 ? 'apikey' : 'none',
      probedAt: at,
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
    };
    this.#database.saveRuntimeProfile(profile);
    this.#audit('discover', 'succeeded', {
      source: candidate.source,
      version,
      executableFingerprint: this.#hash(candidate.executable),
    }, profile.id);
    this.#audit('auth_probe', 'succeeded', {
      authenticated: profile.authenticated,
      credentialCount: authentication.credentialCount,
      rawOutputPersisted: false,
    }, profile.id);
    this.#audit(action, compatibility === 'supported' ? 'succeeded' : 'degraded', {
      version,
      compatibility,
      minimumSupportedVersion: this.#minimumSupportedVersion,
      maximumTestedVersion: this.#maximumTestedVersion,
    }, profile.id);
    return profile;
  }

  #discover(): OpenCodeLaunchCandidate {
    for (const candidate of this.#candidates()) {
      const executable = resolve(candidate.executable);
      if (!existsSync(executable)) continue;
      const canonical = realpathSync.native(executable);
      const result = spawnSync(canonical, [...(candidate.prefixArgs ?? []), '--version'], {
        encoding: 'utf8',
        windowsHide: true,
        shell: false,
        timeout: 10_000,
        maxBuffer: 64 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (!result.error && result.status === 0 && /\d+\.\d+\.\d+/.test(result.stdout ?? '')) {
        return { ...candidate, executable: canonical };
      }
    }
    this.#audit('discover', 'failed', { code: 'opencode_not_found' });
    throw new OpenCodeAdapterError('OpenCode executable was not discovered');
  }

  #version(candidate: OpenCodeLaunchCandidate): string {
    const result = spawnSync(candidate.executable, [...(candidate.prefixArgs ?? []), '--version'], {
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const match = (result.stdout ?? '').match(/(\d+\.\d+\.\d+)/);
    if (result.status !== 0 || !match?.[1]) throw new OpenCodeAdapterError('OpenCode version probe failed');
    return match[1];
  }

  #authentication(candidate: OpenCodeLaunchCandidate): { credentialCount: number } {
    const result = spawnSync(candidate.executable, [
      ...(candidate.prefixArgs ?? []), 'auth', 'list', '--pure', '--log-level', 'ERROR',
    ], {
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
    });
    if (result.status !== 0) return { credentialCount: 0 };
    const match = stripAnsi(result.stdout ?? '').match(/(\d+)\s+credentials?/i);
    return { credentialCount: match?.[1] ? Number(match[1]) : 0 };
  }

  #compatibility(version: string): RuntimeCompatibility {
    if (compareSemver(version, this.#minimumSupportedVersion) < 0) return 'incompatible_older';
    if (compareSemver(version, this.#maximumTestedVersion) > 0) return 'unverified_newer';
    if (version !== this.#manifest.runtimeVersion) return 'schema_mismatch';
    return 'supported';
  }

  async #validateOpenApi(
    serverUrl: string,
    authorization: string,
    profileId: string,
    handleId: string,
  ): Promise<void> {
    const response = await fetch(new URL('/doc', serverUrl), {
      headers: { Authorization: authorization },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new OpenCodeAdapterError('OpenCode OpenAPI request failed');
    const body = await response.text();
    const contentType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
    const hash = createHash('sha256').update(body).digest('hex');
    const bytes = Buffer.byteLength(body);
    const valid = contentType === this.#manifest.contentType
      && hash === this.#manifest.sha256
      && bytes === this.#manifest.bytes;
    this.#audit('schema_lock', valid ? 'succeeded' : 'failed', {
      runtimeVersion: this.#manifest.runtimeVersion,
      contentType,
      sha256: hash,
      bytes,
    }, profileId, handleId);
    if (!valid) throw new OpenCodeAdapterError('OpenCode OpenAPI lock mismatch');
  }

  #attach(internal: InternalHandle): void {
    internal.child.stdout?.on('data', (chunk: Buffer) => { internal.stdoutBytes += chunk.byteLength; });
    internal.child.stderr?.on('data', (chunk: Buffer) => { internal.stderrBytes += chunk.byteLength; });
    internal.child.once('exit', (code, signal) => {
      internal.closed = true;
      const at = this.#now();
      const preserveFailure = this.#database.readRuntimeHandle(internal.record.id)?.state === 'failed';
      internal.record = {
        ...internal.record,
        state: preserveFailure ? 'failed' : internal.expectedExit ? 'stopped' : 'exited',
        updatedAt: at,
        exitedAt: at,
        ...(code === null ? {} : { exitCode: code }),
        expectedExit: internal.expectedExit,
      };
      internal.process = {
        ...internal.process,
        status: 'exited',
        exitedAt: at,
        ...(code === null ? {} : { exitCode: code }),
        ...(signal === null ? {} : { signal }),
      };
      this.#database.saveRuntimeHandle(internal.record);
      this.#database.saveProcess(internal.process);
      internal.bridge?.runtimeExited(internal.expectedExit);
      this.#audit('exit', internal.expectedExit ? 'succeeded' : 'failed', {
        expected: internal.expectedExit,
        exitCode: code,
        signal,
        stdoutBytes: internal.stdoutBytes,
        stderrBytes: internal.stderrBytes,
        rawOutputPersisted: false,
      }, internal.record.profileId, internal.record.id);
    });
  }

  #waitForServerUrl(internal: InternalHandle): Promise<string> {
    return new Promise((resolveUrl, rejectUrl) => {
      let buffer = '';
      let settled = false;
      const consume = (chunk: Buffer) => {
        buffer = (buffer + chunk.toString()).slice(-64 * 1024);
        for (const line of buffer.split(/\r?\n/)) {
          const url = parseServerUrl(line);
          if (url) finish(null, url);
        }
      };
      const exited = (code: number | null) => finish(
        new OpenCodeAdapterError('OpenCode exited during startup: ' + code),
      );
      const failed = () => finish(new OpenCodeAdapterError('OpenCode failed during startup'));
      const finish = (error: Error | null, url?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        internal.child.stdout?.off('data', consume);
        internal.child.stderr?.off('data', consume);
        internal.child.off('exit', exited);
        internal.child.off('error', failed);
        if (error) rejectUrl(error);
        else resolveUrl(url as string);
      };
      const timer = setTimeout(
        () => finish(new OpenCodeAdapterError('Timed out waiting for OpenCode Server startup')),
        START_TIMEOUT_MS,
      );
      internal.child.stdout?.on('data', consume);
      internal.child.stderr?.on('data', consume);
      internal.child.once('exit', exited);
      internal.child.once('error', failed);
    });
  }

  async #failStart(internal: InternalHandle): Promise<void> {
    internal.expectedExit = true;
    await internal.bridge?.stopEventReader();
    internal.record = { ...internal.record, state: 'failed', updatedAt: this.#now() };
    internal.process = { ...internal.process, status: 'stopping' };
    this.#database.saveRuntimeHandle(internal.record);
    this.#database.saveProcess(internal.process);
    this.#audit('start', 'failed', { code: 'server_probe_failed' }, internal.record.profileId, internal.record.id);
    if (internal.child.exitCode === null) {
      const exited = new Promise<void>((resolveExit) => internal.child.once('exit', () => resolveExit()));
      internal.child.kill('SIGKILL');
      await exited;
    }
  }

  #bridge(handleId: string): OpenCodeSessionBridge {
    const internal = this.#ready(handleId);
    if (!internal.bridge) throw new OpenCodeAdapterError('OpenCode Session Bridge is unavailable');
    return internal.bridge;
  }

  #ready(handleId: string): InternalHandle {
    const internal = this.#handles.get(handleId);
    if (!internal || internal.closed || internal.record.state !== 'ready') {
      throw new OpenCodeAdapterError('OpenCode Runtime Handle is not ready');
    }
    return internal;
  }

  #audit(
    action: RuntimeAuditRecord['action'],
    outcome: RuntimeAuditRecord['outcome'],
    detail: JsonValue,
    profileId?: string,
    handleId?: string,
  ): void {
    this.#database.saveRuntimeAudit({
      id: 'runtime-audit:' + this.#id(),
      runtimeType: 'opencode',
      ...(profileId ? { profileId } : {}),
      ...(handleId ? { handleId } : {}),
      action,
      outcome,
      detail,
      createdAt: this.#now(),
    });
  }

  #hash(value: string): string {
    return 'sha256:' + createHash('sha256').update(value).digest('hex');
  }
}

export function defaultOpenCodeCandidates(): OpenCodeLaunchCandidate[] {
  const candidates: OpenCodeLaunchCandidate[] = [];
  if (process.env.OPENCODE_BIN) {
    candidates.push({ executable: process.env.OPENCODE_BIN, source: 'environment' });
  }
  if (process.env.APPDATA) {
    const native = join(process.env.APPDATA, 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
    if (existsSync(native)) candidates.push({ executable: native, source: 'npm-global' });
  }
  const where = spawnSync(
    join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'where.exe'),
    ['opencode.exe'],
    {
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
      timeout: 5_000,
      maxBuffer: 64 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  if (where.status === 0) {
    for (const path of (where.stdout ?? '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
      candidates.push({ executable: path, source: 'path-executable' });
    }
  }
  return candidates;
}

function parseServerUrl(line: string): string | null {
  const match = line.match(/opencode server listening.*\bon\s+(https?:\/\/[^\s]+)/i);
  if (!match?.[1]) return null;
  const url = new URL(match[1]);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) {
    throw new OpenCodeAdapterError('OpenCode Server did not bind to loopback');
  }
  return url.href;
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => resolve(value).replaceAll('/', '\\').toLowerCase();
  return normalize(left) === normalize(right);
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function compareSemver(left: string, right: string): number {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return Math.sign(delta);
  }
  return 0;
}

function boundedFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const signals = [AbortSignal.timeout(REQUEST_TIMEOUT_MS)];
  if (init?.signal) signals.push(init.signal);
  if (input instanceof Request && input.signal) signals.push(input.signal);
  return fetch(input, { ...init, signal: AbortSignal.any(signals) });
}

export * from './provider.js';
export * from './session-bridge.js';