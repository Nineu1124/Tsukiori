import { createHmac, randomUUID } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';
import {
  IPC_MAX_MESSAGE_BYTES,
  isIpcAuthenticated,
  isIpcChallenge,
  isIpcError,
  type IpcAuthenticated,
  type SubscriptionResult,
} from '@tsukiori/protocol';

type Waiter = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

export type NamedPipeClientOptions = {
  pipeName: string;
  daemonInstanceId: string;
  protocolVersion: number;
  bootstrapToken: string;
  timeoutMs?: number;
};

export class NamedPipeClient {
  readonly #options: NamedPipeClientOptions & { timeoutMs: number };
  #socket: Socket | null = null;
  #buffer = '';
  #messages: unknown[] = [];
  #waiters: Waiter[] = [];
  #authenticated: IpcAuthenticated | null = null;

  constructor(options: NamedPipeClientOptions) {
    if (options.bootstrapToken.length < 32) {
      throw new Error('bootstrapToken must contain at least 32 characters');
    }
    this.#options = {
      ...options,
      timeoutMs: options.timeoutMs ?? 10_000,
    };
  }

  get connectionEpoch(): string | null {
    return this.#authenticated?.connectionEpoch ?? null;
  }

  async connect(): Promise<IpcAuthenticated> {
    if (this.#socket) {
      throw new Error('Named Pipe client is already connected');
    }
    const path = '\\\\.\\pipe\\' + this.#options.pipeName;
    const socket = await this.#openSocket(path);
    this.#socket = socket;
    socket.setNoDelay(true);
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.#consume(chunk));
    socket.on('error', (error) => this.#rejectWaiters(error));
    socket.on('close', () => {
      this.#rejectWaiters(new Error('Named Pipe connection closed'));
      this.#socket = null;
      this.#authenticated = null;
    });



    const challenge = await this.#next();
    if (!isIpcChallenge(challenge)) {
      throw new Error('Invalid IPC challenge');
    }
    if (challenge.daemonInstanceId !== this.#options.daemonInstanceId) {
      throw new Error('Daemon instance mismatch in challenge');
    }

    const proof = createHmac('sha256', this.#options.bootstrapToken)
      .update(
        challenge.challenge +
          '|' +
          challenge.daemonInstanceId +
          '|' +
          this.#options.protocolVersion,
      )
      .digest('hex');
    this.#write({
      type: 'ipc.authenticate',
      daemonInstanceId: this.#options.daemonInstanceId,
      protocolVersion: this.#options.protocolVersion,
      proof,
    });

    const authenticated = await this.#next();
    if (isIpcError(authenticated)) {
      throw new Error('IPC authentication rejected: ' + authenticated.code);
    }
    if (!isIpcAuthenticated(authenticated)) {
      throw new Error('Invalid IPC authenticated response');
    }
    this.#authenticated = authenticated;
    return authenticated;
  }

  async subscribe(
    lastStreamSequence: number,
    knownSnapshotVersion: number,
  ): Promise<SubscriptionResult> {
    const response = await this.request('stream.subscribe', {
      lastStreamSequence,
      knownSnapshotVersion,
    });
    return response as SubscriptionResult;
  }

  async request(method: string, params: unknown): Promise<unknown> {
    if (!this.#authenticated) {
      throw new Error('Named Pipe client is not authenticated');
    }
    const id = randomUUID();
    this.#write({
      jsonrpc: '2.0',
      id,
      method,
      params,
    });
    const response = await this.#next();
    if (!response || typeof response !== 'object') {
      throw new Error('Invalid JSON-RPC response');
    }
    const item = response as Record<string, unknown>;
    if (item.id !== id) {
      throw new Error('Mismatched JSON-RPC response id');
    }
    if (item.error) {
      const error = item.error as Record<string, unknown>;
      throw new Error('IPC request rejected: ' + String(error.code));
    }
    return item.result;
  }

  close(): void {
    this.#socket?.destroy();
    this.#socket = null;
    this.#authenticated = null;
  }


  async #openSocket(path: string): Promise<Socket> {
    const deadline = Date.now() + this.#options.timeoutMs;
    for (;;) {
      const socket = createConnection({ path });
      try {
        await new Promise<void>((resolveConnect, rejectConnect) => {
          socket.once('connect', resolveConnect);
          socket.once('error', rejectConnect);
        });
        return socket;
      } catch (error: unknown) {
        socket.destroy();
        const code = (error as NodeJS.ErrnoException).code;
        if (
          Date.now() >= deadline ||
          (code !== 'ENOENT' && code !== 'ECONNREFUSED' && code !== 'EPIPE')
        ) {
          throw error;
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      }
    }
  }
  #write(value: unknown): void {
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized, 'utf8') > IPC_MAX_MESSAGE_BYTES) {
      throw new Error('IPC message exceeds size limit');
    }
    this.#socket?.write(serialized + '\n');
  }

  #consume(chunk: string): void {
    this.#buffer += chunk;
    if (Buffer.byteLength(this.#buffer, 'utf8') > IPC_MAX_MESSAGE_BYTES * 2) {
      this.close();
      this.#rejectWaiters(new Error('IPC receive buffer exceeded limit'));
      return;
    }
    for (;;) {
      const newline = this.#buffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        this.close();
        this.#rejectWaiters(new Error('Invalid JSON from Named Pipe'));
        return;
      }
      const waiter = this.#waiters.shift();
      if (waiter) {
        clearTimeout(waiter.timeout);
        waiter.resolve(value);
      } else {
        this.#messages.push(value);
      }
    }
  }

  #next(): Promise<unknown> {
    const queued = this.#messages.shift();
    if (queued !== undefined) {
      return Promise.resolve(queued);
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const index = this.#waiters.findIndex((candidate) => candidate.resolve === resolve);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(new Error('Timed out waiting for Named Pipe message'));
      }, this.#options.timeoutMs);
      this.#waiters.push({ resolve, reject, timeout });
    });
  }

  #rejectWaiters(error: Error): void {
    for (const waiter of this.#waiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    this.#waiters = [];
  }
}
