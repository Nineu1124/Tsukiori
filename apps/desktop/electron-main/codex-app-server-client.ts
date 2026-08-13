import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  isolateRuntimeEnvironment,
  type RuntimeProviderEnvironmentKey,
} from '@tsukiori/runtime-core';

export type CodexLaunch = {
  executable: string;
  prefixArgs: string[];
  version: string;
  source: 'private-spike-runtime' | 'npm-global' | 'path-executable';
};

export type CodexApproval = {
  requestId: string | number;
  method: string;
  params: Record<string, unknown>;
};

export type CodexClientOptions = {
  cwd: string;
  launch: CodexLaunch;
  environment?: Readonly<Record<string, string>>;
  configArgs?: readonly string[];
  model?: string;
  onNotification: (method: string, params: Record<string, unknown>) => void;
  onApproval: (approval: CodexApproval) => Promise<unknown>;
  onExit: (error: string | null) => void;
};

type PendingRequest = {
  method: string;
  timer: NodeJS.Timeout;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

function runVersion(executable: string, args: readonly string[]): string | null {
  const result = spawnSync(executable, [...args, '--version'], {
    encoding: 'utf8', windowsHide: true, shell: false, timeout: 10_000,
    maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0 || result.error) return null;
  return (result.stdout ?? '').match(/(\d+\.\d+\.\d+)/)?.[1] ?? null;
}

function firstWhere(executable: string): string | null {
  const result = spawnSync('where.exe', [executable], {
    encoding: 'utf8', windowsHide: true, shell: false, timeout: 5_000,
    maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return result.status === 0
    ? (result.stdout ?? '').split(/\r?\n/).map((value) => value.trim()).find(Boolean) ?? null
    : null;
}

export function discoverCodexLaunch(): CodexLaunch {
  const currentDirectory = dirname(fileURLToPath(import.meta.url));
  const repositoryRoot = resolve(currentDirectory, '..', '..', '..', '..');
  const nodeExecutable = process.env.TSUKIORI_NODE_EXECUTABLE ?? firstWhere('node.exe');
  const candidates: Array<Omit<CodexLaunch, 'version'>> = [];
  const explicitEntry = process.env.TSUKIORI_CODEX_ENTRY;
  const privateEntry = join(
    repositoryRoot, 'artifacts', 'private', 't0.2', 'runtime',
    'node_modules', '@openai', 'codex', 'bin', 'codex.js',
  );
  const globalEntry = process.env.APPDATA
    ? join(process.env.APPDATA, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
    : '';
  if (nodeExecutable && explicitEntry && existsSync(explicitEntry)) {
    candidates.push({ executable: nodeExecutable, prefixArgs: [explicitEntry], source: 'path-executable' });
  }
  if (nodeExecutable && existsSync(privateEntry)) {
    candidates.push({ executable: nodeExecutable, prefixArgs: [privateEntry], source: 'private-spike-runtime' });
  }
  if (nodeExecutable && globalEntry && existsSync(globalEntry)) {
    candidates.push({ executable: nodeExecutable, prefixArgs: [globalEntry], source: 'npm-global' });
  }
  const codexExecutable = firstWhere('codex.exe');
  if (codexExecutable && existsSync(codexExecutable)) {
    candidates.push({ executable: codexExecutable, prefixArgs: [], source: 'path-executable' });
  }
  for (const candidate of candidates) {
    const version = runVersion(candidate.executable, candidate.prefixArgs);
    if (version) return { ...candidate, version };
  }
  throw new Error('未发现可启动的 Codex CLI；请先安装 Codex 或设置 TSUKIORI_CODEX_ENTRY');
}

export class CodexAppServerClient {
  readonly #options: CodexClientOptions;
  #child: ChildProcessWithoutNullStreams | null = null;
  #pending = new Map<number, PendingRequest>();
  #nextId = 1;
  #stopping = false;
  #stderr = '';

  constructor(options: CodexClientOptions) {
    this.#options = options;
  }

  async start(): Promise<{ authenticated: boolean; authSource: string }> {
    if (this.#child) throw new Error('Codex app-server 已启动');
    const child = spawn(
      this.#options.launch.executable,
      [...this.#options.launch.prefixArgs, 'app-server', ...(this.#options.configArgs ?? [])],
      {
        cwd: this.#options.cwd,
        env: cleanProviderEnvironment(this.#options.environment),
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false,
      },
    );
    this.#child = child;
    child.stderr.on('data', (chunk: Buffer) => {
      this.#stderr = (this.#stderr + chunk.toString('utf8')).slice(-2048);
    });
    createInterface({ input: child.stdout, crlfDelay: Infinity })
      .on('line', (line) => this.#acceptLine(line));
    child.once('error', (error) => this.#fail(error));
    child.once('exit', (code) => {
      const error = this.#stopping ? null : `Codex app-server 已退出（${code ?? 'signal'}）`;
      this.#fail(new Error(error ?? 'Codex stopped'));
      this.#options.onExit(error);
      this.#child = null;
    });
    await this.request('initialize', {
      clientInfo: { name: 'tsukiori', title: 'Tsukiori', version: '1.0.0-rc.7' },
    });
    this.notify('initialized', {});
    const account = object(await this.request('account/read', { refreshToken: false }));
    const accountValue = object(account.account);
    return {
      authenticated: Object.keys(accountValue).length > 0,
      authSource: String(accountValue.type ?? (account.requiresOpenaiAuth === true ? 'required' : 'unknown')),
    };
  }

  async startThread(cwd: string): Promise<string> {
    const response = object(await this.request('thread/start', {
      cwd, sandbox: 'workspace-write', approvalPolicy: 'on-request',
      approvalsReviewer: 'user', ephemeral: false,
      ...(this.#options.model ? { model: this.#options.model } : {}),
    }, 60_000));
    const id = object(response.thread).id;
    if (typeof id !== 'string') throw new Error('Codex thread/start 未返回 Thread ID');
    return id;
  }

  async resumeThread(threadId: string): Promise<string> {
    const response = object(await this.request('thread/resume', { threadId }, 60_000));
    const id = object(response.thread).id;
    if (typeof id !== 'string') throw new Error('Codex thread/resume 未返回 Thread ID');
    return id;
  }

  async forkThread(threadId: string, lastTurnId: string): Promise<string> {
    const response = object(await this.request('thread/fork', {
      threadId, lastTurnId, ephemeral: false,
    }, 60_000));
    const id = object(response.thread).id;
    if (typeof id !== 'string') throw new Error('Codex thread/fork 未返回 Thread ID');
    return id;
  }

  async startTurn(threadId: string, text: string): Promise<string> {
    const response = object(await this.request('turn/start', {
      threadId, input: [{ type: 'text', text }],
    }, 60_000));
    const id = object(response.turn).id;
    if (typeof id !== 'string') throw new Error('Codex turn/start 未返回 Turn ID');
    return id;
  }

  async interrupt(threadId: string, turnId: string): Promise<void> {
    await this.request('turn/interrupt', { threadId, turnId });
  }

  request(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    const child = this.#child;
    if (!child || child.stdin.destroyed) return Promise.reject(new Error('Codex app-server 未运行'));
    const id = this.#nextId++;
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        rejectRequest(new Error(method + ' 请求超时'));
      }, timeoutMs);
      this.#pending.set(id, { method, timer, resolve: resolveRequest, reject: rejectRequest });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.#child || this.#child.stdin.destroyed) return;
    this.#child.stdin.write(JSON.stringify({ method, params }) + '\n');
  }

  async stop(): Promise<void> {
    const child = this.#child;
    if (!child) return;
    this.#stopping = true;
    child.stdin.end();
    await Promise.race([
      new Promise<void>((resolveExit) => child.once('exit', () => resolveExit())),
      new Promise<void>((resolveTimeout) => setTimeout(() => {
        if (child.exitCode === null) child.kill();
        resolveTimeout();
      }, 2_000)),
    ]);
    this.#child = null;
  }

  #acceptLine(line: string): void {
    let message: Record<string, unknown>;
    try { message = JSON.parse(line) as Record<string, unknown>; }
    catch { return; }
    const method = typeof message.method === 'string' ? message.method : null;
    if (Object.hasOwn(message, 'id') && !method) {
      const id = Number(message.id);
      const pending = this.#pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(id);
      if (message.error) pending.reject(new Error(pending.method + ' 失败'));
      else pending.resolve(message.result);
      return;
    }
    if (!method) return;
    const params = object(message.params);
    if (Object.hasOwn(message, 'id')) {
      void this.#options.onApproval({ requestId: String(message.id), method, params })
        .then((result) => this.#write({ id: message.id, result }))
        .catch(() => this.#write({ id: message.id, error: { code: -32000, message: 'rejected' } }));
      return;
    }
    this.#options.onNotification(method, params);
  }

  #write(message: Record<string, unknown>): void {
    if (!this.#child || this.#child.stdin.destroyed) return;
    this.#child.stdin.write(JSON.stringify(message) + '\n');
  }

  #fail(error: Error): void {
    const detail = this.#stderr ? `${error.message}: ${this.#stderr}` : error.message;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(detail));
    }
    this.#pending.clear();
  }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function cleanProviderEnvironment(additions?: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  return buildCodexRuntimeEnvironment(additions);
}

export function buildCodexRuntimeEnvironment(
  additions?: Readonly<Record<string, string>>,
  base: Readonly<NodeJS.ProcessEnv> = process.env,
): NodeJS.ProcessEnv {
  return isolateRuntimeEnvironment(base, additions, codexProviderEnvironmentKeys);
}

const codexProviderEnvironmentKeys: readonly RuntimeProviderEnvironmentKey[] = ['OPENAI_API_KEY'];
