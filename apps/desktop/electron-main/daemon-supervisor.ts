import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import {
  DAEMON_VERSION,
  HOST_PROTOCOL_VERSION,
  isDaemonMessage,
  type DaemonMessage,
  type DaemonReadyMessage,
  type DaemonStatusMessage,
} from '@tsukiori/protocol';

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
  > & { environment: NodeJS.ProcessEnv };

  #child: ChildProcessWithoutNullStreams | null = null;
  #reader: Interface | null = null;
  #ready: DaemonReadyMessage | null = null;
  #pending = new Map<string, PendingRequest>();
  #startupResolve: ((message: DaemonReadyMessage) => void) | null = null;
  #startupReject: ((error: Error) => void) | null = null;
  #stderr = '';

  constructor(options: DaemonSupervisorOptions) {
    this.#options = {
      daemonEntry: options.daemonEntry,
      executable: options.executable ?? process.execPath,
      expectedVersion: options.expectedVersion ?? DAEMON_VERSION,
      startupTimeoutMs: options.startupTimeoutMs ?? 15_000,
      environment: options.environment ?? {},
    };
  }

  snapshot(): DaemonSnapshot {
    const running = this.#child !== null && this.#child.exitCode === null && this.#ready !== null;
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

    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      ...this.#options.environment,
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
      ready.protocolVersion !== HOST_PROTOCOL_VERSION
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
    return this.snapshot();
  }

  async probe(): Promise<DaemonStatusMessage> {
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

    await Promise.race([
      new Promise<void>((resolveExit) => child.once('exit', () => resolveExit())),
      new Promise<void>((_, rejectTimeout) =>
        setTimeout(() => rejectTimeout(new Error('Timed out stopping daemon')), 10_000),
      ),
    ]).catch((error: unknown) => {
      child.kill('SIGKILL');
      throw error;
    });
    this.#reset();
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
    this.#reader?.close();
    this.#reader = null;
    this.#child = null;
    this.#ready = null;
    this.#startupResolve = null;
    this.#startupReject = null;
  }
}
