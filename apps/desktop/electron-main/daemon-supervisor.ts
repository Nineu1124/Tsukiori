import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { createInterface, type Interface } from 'node:readline';
import {
  DAEMON_VERSION,
  HOST_PROTOCOL_VERSION,
  IPC_PROTOCOL_VERSION,
  isDaemonMessage,
  type DaemonMessage,
  type DaemonReadyMessage,
  type DaemonStatusMessage,
} from '@tsukiori/protocol';
import {
  WindowsCredentialBroker,
  type CredentialBinding,
  type SecretReference,
} from '@tsukiori/credential-broker';
import { NamedPipeClient } from './named-pipe-client.js';

const DAEMON_CREDENTIAL_BINDING: CredentialBinding = {
  runtimeType: 'daemon',
  runtimeProfileId: 'host-daemon',
  environmentVariable: 'TSUKIORI_IPC_BOOTSTRAP_TOKEN',
};

type PendingRequest = {
  resolve: (message: DaemonMessage) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

export type DaemonSupervisorOptions = {
  daemonEntry: string;
  executable?: string;
  expectedVersion?: string;
  startupTimeoutMs?: number;
  environment?: NodeJS.ProcessEnv;
  leaseFile?: string;
  exitPolicy?: 'keep' | 'stop';
  credentialBroker?: WindowsCredentialBroker;
};

type DaemonLease = {
  schemaVersion: 1;
  daemonVersion: string;
  protocolVersion: number;
  ipcProtocolVersion: number;
  instanceId: string;
  pid: number;
  pipeName: string;
  bootstrapSecretRef: SecretReference;
  createdAt: number;
};
export type DaemonSnapshot = {
  state: 'stopped' | 'running';
  daemonVersion: string | null;
  protocolVersion: number | null;
  instanceId: string | null;
  pid: number | null;
};

export class DaemonSupervisor {
  readonly #options: Required<
    Pick<DaemonSupervisorOptions, 'daemonEntry' | 'executable' | 'expectedVersion' | 'startupTimeoutMs'>
  > & { environment: NodeJS.ProcessEnv; leaseFile?: string; exitPolicy: 'keep' | 'stop' };

  #child: ChildProcessWithoutNullStreams | null = null;
  #reader: Interface | null = null;
  #ready: DaemonReadyMessage | null = null;
  #ipcClient: NamedPipeClient | null = null;
  #bootstrapToken = '';
  #bootstrapSecretRef: SecretReference | null = null;
  readonly #credentials: WindowsCredentialBroker;
  #pending = new Map<string, PendingRequest>();
  #startupResolve: ((message: DaemonReadyMessage) => void) | null = null;
  #startupReject: ((error: Error) => void) | null = null;
  #stderr = '';

  constructor(options: DaemonSupervisorOptions) {
    this.#credentials = options.credentialBroker ?? new WindowsCredentialBroker();
    this.#options = {
      daemonEntry: options.daemonEntry,
      executable: options.executable ?? process.execPath,
      expectedVersion: options.expectedVersion ?? DAEMON_VERSION,
      startupTimeoutMs: options.startupTimeoutMs ?? 15_000,
      environment: options.environment ?? {},
      ...(options.leaseFile ? { leaseFile: options.leaseFile } : {}),
      exitPolicy: options.exitPolicy ?? 'stop',
    };
  }

  snapshot(): DaemonSnapshot {
    const running = this.#ready !== null && (this.#child === null || this.#child.exitCode === null);
    return {
      state: running ? 'running' : 'stopped',
      daemonVersion: this.#ready?.daemonVersion ?? null,
      protocolVersion: this.#ready?.protocolVersion ?? null,
      instanceId: this.#ready?.instanceId ?? null,
      pid: this.#ready?.pid ?? null,
    };
  }

  async start(): Promise<DaemonSnapshot> {
    if (this.snapshot().state === 'running') {
      return this.snapshot();
    }

    if (await this.#attachFromLease()) return this.snapshot();

    this.#bootstrapToken = randomBytes(32).toString('hex');
    if (this.#options.leaseFile) {
      this.#bootstrapSecretRef = this.#credentials.store({
        secret: this.#bootstrapToken,
        binding: DAEMON_CREDENTIAL_BINDING,
      });
    }
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      ...this.#options.environment,
      TSUKIORI_IPC_BOOTSTRAP_TOKEN: this.#bootstrapToken,
      ...(this.#options.leaseFile ? {
        TSUKIORI_DAEMON_LEASE_FILE: this.#options.leaseFile,
        TSUKIORI_IPC_BOOTSTRAP_REF: this.#bootstrapSecretRef ?? '',
      } : {}),
    };
    if (
      process.versions.electron &&
      this.#options.executable === process.execPath
    ) {
      environment.ELECTRON_RUN_AS_NODE = '1';
    }

    const child = spawn(
      this.#options.executable,
      [this.#options.daemonEntry],
      {
        env: environment,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    this.#child = child;
    this.#stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      this.#stderr = (this.#stderr + chunk.toString('utf8')).slice(-4096);
    });

    this.#reader = createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });
    this.#reader.on('line', (line) => this.#onLine(line));
    child.once('exit', (code, signal) => {
      const error = new Error(
        'Daemon exited unexpectedly: code=' + code + ' signal=' + signal + ' stderr=' + this.#stderr,
      );
      this.#startupReject?.(error);
      this.#rejectPending(error);
      this.#reader?.close();
      this.#reader = null;
      this.#deleteBootstrapSecret();
      this.#child = null;
      this.#ready = null;
    });
    child.once('error', (error) => {
      this.#startupReject?.(error);
      this.#rejectPending(error);
    });

    const ready = this.#ready ?? await new Promise<DaemonReadyMessage>((resolveReady, rejectReady) => {
      this.#startupResolve = resolveReady;
      this.#startupReject = rejectReady;
      const timeout = setTimeout(() => {
        rejectReady(new Error('Timed out waiting for daemon.ready'));
      }, this.#options.startupTimeoutMs);
      const resolveWithCleanup = this.#startupResolve;
      this.#startupResolve = (message) => {
        clearTimeout(timeout);
        resolveWithCleanup(message);
      };
      const rejectWithCleanup = this.#startupReject;
      this.#startupReject = (error) => {
        clearTimeout(timeout);
        rejectWithCleanup(error);
      };
    }).catch(async (error: unknown) => {
      await this.stop(true).catch(() => undefined);
      throw error;
    });

    if (
      ready.daemonVersion !== this.#options.expectedVersion ||
      ready.protocolVersion !== HOST_PROTOCOL_VERSION ||
      ready.ipcProtocolVersion !== IPC_PROTOCOL_VERSION
    ) {
      await this.stop(true);
      throw new Error(
        'Daemon version mismatch: expected ' +
          this.#options.expectedVersion +
          ' protocol ' +
          HOST_PROTOCOL_VERSION +
          ', received ' +
          ready.daemonVersion +
          ' protocol ' +
          ready.protocolVersion,
      );
    }

    this.#ready = ready;
    try {
      await this.reconnectIpc(0, 0);
    } catch (error) {
      await this.stop(true).catch(() => undefined);
      throw error;
    }
    return this.snapshot();
  }

  async reconnectIpc(lastStreamSequence: number, knownSnapshotVersion: number) {
    const ready = this.#ready;
    if (!ready || !this.#bootstrapToken) {
      throw new Error('Daemon IPC identity is unavailable');
    }
    this.#ipcClient?.close();
    const client = new NamedPipeClient({
      pipeName: ready.pipeName,
      daemonInstanceId: ready.instanceId,
      protocolVersion: ready.ipcProtocolVersion,
      bootstrapToken: this.#bootstrapToken,
    });
    await client.connect();
    this.#ipcClient = client;
    return client.subscribe(lastStreamSequence, knownSnapshotVersion);
  }

  async probe(): Promise<DaemonStatusMessage> {
    if (!this.#child && this.#ipcClient && this.#ready) {
      const result = await this.#ipcClient.request('daemon.ping', {}) as Record<string, unknown>;
      if (result.daemonInstanceId !== this.#ready.instanceId || result.pid !== this.#ready.pid
        || result.protocolVersion !== HOST_PROTOCOL_VERSION) {
        throw new Error('Daemon identity changed during attached probe');
      }
      return {
        type: 'daemon.status',
        requestId: 'ipc-probe',
        protocolVersion: HOST_PROTOCOL_VERSION,
        daemonVersion: this.#ready.daemonVersion,
        instanceId: this.#ready.instanceId,
        pid: this.#ready.pid,
      };
    }
    const message = await this.#request({
      type: 'daemon.probe',
      requestId: randomUUID(),
    });
    if (message.type !== 'daemon.status') {
      throw new Error('Unexpected probe response: ' + message.type);
    }
    if (
      message.daemonVersion !== this.#options.expectedVersion ||
      message.protocolVersion !== HOST_PROTOCOL_VERSION ||
      message.instanceId !== this.#ready?.instanceId
    ) {
      throw new Error('Daemon identity changed during probe');
    }
    return message;
  }

  async stop(force = false): Promise<void> {
    const child = this.#child;
    const ready = this.#ready;
    const ipcClient = this.#ipcClient;
    if (ipcClient && ready) {
      try {
        if (!force) {
          const result = await ipcClient.request('daemon.shutdown', {
            expectedVersion: this.#options.expectedVersion,
          }) as Record<string, unknown>;
          if (result.accepted !== true || result.daemonInstanceId !== ready.instanceId) {
            throw new Error('Daemon rejected authenticated shutdown');
          }
          await this.#waitForProcessExit(ready.pid);
        } else if (this.#isProcessAlive(ready.pid)) {
          process.kill(ready.pid, 'SIGTERM');
          await this.#waitForProcessExit(ready.pid);
        }
      } finally {
        this.#reset();
      }
      return;
    }
    this.#ipcClient?.close();
    this.#ipcClient = null;
    if (!child || child.exitCode !== null) {
      this.#reset();
      return;
    }

    if (!force && this.#ready) {
      const requestId = randomUUID();
      const response = await this.#request({
        type: 'daemon.shutdown',
        requestId,
        expectedVersion: this.#options.expectedVersion,
      });
      if (response.type !== 'daemon.stopping') {
        throw new Error('Unexpected shutdown response: ' + response.type);
      }
    } else {
      child.kill('SIGTERM');
    }

    let stopTimeout: NodeJS.Timeout | null = null;
    try {
      await Promise.race([
        new Promise<void>((resolveExit) => {
          if (child.exitCode !== null) resolveExit();
          else child.once('exit', () => resolveExit());
        }),
        new Promise<void>((_, rejectTimeout) => {
          stopTimeout = setTimeout(
            () => rejectTimeout(new Error('Timed out stopping daemon')),
            10_000,
          );
        }),
      ]);
    } catch (error) {
      child.kill('SIGKILL');
      throw error;
    } finally {
      if (stopTimeout) clearTimeout(stopTimeout);
    }
    this.#reset();
  }

  async release(policy: 'keep' | 'stop' = this.#options.exitPolicy): Promise<void> {
    if (policy === 'stop') {
      await this.stop();
      return;
    }
    this.#ipcClient?.close();
    this.#ipcClient = null;
    this.#reader?.close();
    this.#reader = null;
    if (this.#child) {
      this.#child.stdin.end();
      this.#child.stdout.destroy();
      this.#child.stderr.destroy();
      this.#child.unref();
    }
    this.#child = null;
    this.#ready = null;
    this.#bootstrapToken = '';
    this.#bootstrapSecretRef = null;
  }

  async #attachFromLease(): Promise<boolean> {
    const leaseFile = this.#options.leaseFile;
    if (!leaseFile || !existsSync(leaseFile)) return false;
    let lease: DaemonLease;
    try {
      lease = this.#parseLease(JSON.parse(readFileSync(leaseFile, 'utf8')));
    } catch {
      unlinkSync(leaseFile);
      return false;
    }
    if (!this.#isProcessAlive(lease.pid)) {
      try { this.#credentials.delete(lease.bootstrapSecretRef); } catch { /* stale reference remains fail-closed */ }
      unlinkSync(leaseFile);
      return false;
    }
    if (lease.daemonVersion !== this.#options.expectedVersion
      || lease.protocolVersion !== HOST_PROTOCOL_VERSION
      || lease.ipcProtocolVersion !== IPC_PROTOCOL_VERSION) {
      throw new Error('Running Daemon lease is incompatible; refusing duplicate start');
    }
    const client = await this.#credentials.use(
      lease.bootstrapSecretRef,
      DAEMON_CREDENTIAL_BINDING,
      async (secret) => {
        this.#bootstrapToken = secret;
        const candidate = new NamedPipeClient({
          pipeName: lease.pipeName,
          daemonInstanceId: lease.instanceId,
          protocolVersion: lease.ipcProtocolVersion,
          bootstrapToken: secret,
        });
        try {
          await candidate.connect();
          const ping = await candidate.request('daemon.ping', {}) as Record<string, unknown>;
          if (ping.daemonInstanceId !== lease.instanceId || ping.pid !== lease.pid
            || ping.protocolVersion !== HOST_PROTOCOL_VERSION) {
            throw new Error('Running Daemon lease identity mismatch');
          }
          return candidate;
        } catch (error) {
          candidate.close();
          throw new Error('Running Daemon could not be safely authenticated; refusing duplicate start', {
            cause: error,
          });
        }
      },
    );
    this.#bootstrapSecretRef = lease.bootstrapSecretRef;
    this.#ready = {
      type: 'daemon.ready',
      protocolVersion: HOST_PROTOCOL_VERSION,
      daemonVersion: DAEMON_VERSION,
      instanceId: lease.instanceId,
      pid: lease.pid,
      pipeName: lease.pipeName,
      ipcProtocolVersion: IPC_PROTOCOL_VERSION,
    };
    this.#ipcClient = client;
    return true;
  }

  #parseLease(value: unknown): DaemonLease {
    if (!value || typeof value !== 'object') throw new Error('Invalid Daemon lease');
    const item = value as Record<string, unknown>;
    if (item.schemaVersion !== 1 || typeof item.daemonVersion !== 'string'
      || typeof item.protocolVersion !== 'number' || typeof item.ipcProtocolVersion !== 'number'
      || typeof item.instanceId !== 'string' || typeof item.pid !== 'number'
      || !Number.isInteger(item.pid) || item.pid <= 0 || typeof item.pipeName !== 'string'
      || typeof item.bootstrapSecretRef !== 'string'
      || !/^secretref:[a-f0-9-]{36}$/.test(item.bootstrapSecretRef)
      || typeof item.createdAt !== 'number') {
      throw new Error('Invalid Daemon lease');
    }
    return item as unknown as DaemonLease;
  }

  #deleteBootstrapSecret(): void {
    const reference = this.#bootstrapSecretRef;
    this.#bootstrapSecretRef = null;
    if (!reference) return;
    try { this.#credentials.delete(reference); } catch { /* stale OS entry is safer than deleting another reference */ }
  }

  #isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async #waitForProcessExit(pid: number): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (this.#isProcessAlive(pid)) {
      if (Date.now() >= deadline) throw new Error('Timed out waiting for Daemon process exit');
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
  }

  #onLine(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    if (!isDaemonMessage(value)) {
      return;
    }

    if (value.type === 'daemon.ready') {
      this.#ready = value;
      this.#startupResolve?.(value);
      this.#startupResolve = null;
      this.#startupReject = null;
      return;
    }

    const requestId = value.requestId;
    if (!requestId) {
      return;
    }
    const pending = this.#pending.get(requestId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    this.#pending.delete(requestId);
    pending.resolve(value);
  }

  async #request(message: {
    type: 'daemon.probe';
    requestId: string;
  } | {
    type: 'daemon.shutdown';
    requestId: string;
    expectedVersion: string;
  }): Promise<DaemonMessage> {
    const child = this.#child;
    if (!child || child.exitCode !== null) {
      throw new Error('Daemon is not running');
    }

    const response = new Promise<DaemonMessage>((resolveMessage, rejectMessage) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(message.requestId);
        rejectMessage(new Error('Timed out waiting for ' + message.type));
      }, 10_000);
      this.#pending.set(message.requestId, {
        resolve: resolveMessage,
        reject: rejectMessage,
        timeout,
      });
    });
    child.stdin.write(JSON.stringify(message) + '\n');
    return response;
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #reset(): void {
    this.#ipcClient?.close();
    this.#ipcClient = null;
    this.#deleteBootstrapSecret();
    this.#bootstrapToken = '';
    this.#reader?.close();
    this.#reader = null;
    this.#child = null;
    this.#ready = null;
    this.#startupResolve = null;
    this.#startupReject = null;
  }
}
