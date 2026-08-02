import { randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

export type ClaudeLaunch = {
  executable: string;
  version: string;
  source: 'npm-global' | 'winget' | 'path-executable';
};

export type ClaudeTurnOptions = {
  cwd: string;
  sessionId: string;
  resume: boolean;
  prompt: string;
  model: string;
  permissionMode: 'plan' | 'acceptEdits' | 'dontAsk';
  environment?: Readonly<Record<string, string>>;
  onEvent: (type: string, payload: Record<string, unknown>) => void;
  onExit: (error: string | null) => void;
};

export function discoverClaudeLaunch(): ClaudeLaunch {
  const candidates: Array<{ executable: string; source: ClaudeLaunch['source'] }> = [];
  if (process.env.APPDATA) {
    candidates.push({
      executable: join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
      source: 'npm-global',
    });
  }
  const pathExecutable = firstWhere('claude.exe');
  if (pathExecutable) candidates.push({ executable: pathExecutable, source: 'path-executable' });
  if (process.env.LOCALAPPDATA) {
    const wingetRoot = join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages');
    const found = firstWhere('claude.exe', wingetRoot);
    if (found) candidates.push({ executable: found, source: 'winget' });
  }
  for (const candidate of candidates) {
    if (!existsSync(candidate.executable)) continue;
    const result = spawnSync(candidate.executable, ['--version'], {
      encoding: 'utf8', windowsHide: true, shell: false, timeout: 10_000,
      maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = result.stdout ?? '';
    const version = result.status === 0 && /Claude Code/i.test(output)
      ? output.match(/(\d+\.\d+\.\d+)/)?.[1]
      : undefined;
    if (version) return { ...candidate, version };
  }
  throw new Error('未发现 Anthropic Claude Code；可安装官方 Claude Code 后重新探测');
}

export class ClaudeCodeClient {
  readonly #launch: ClaudeLaunch;
  #turns = new Map<string, ChildProcessWithoutNullStreams>();

  constructor(launch: ClaudeLaunch) {
    this.#launch = launch;
  }

  startTurn(options: ClaudeTurnOptions): string {
    const turnId = 'claude-turn:' + randomUUID();
    const args = [
      '--print', '--output-format', 'stream-json', '--include-partial-messages',
      '--permission-mode', options.permissionMode, '--model', safeModel(options.model),
      ...(options.resume ? ['--resume', options.sessionId] : ['--session-id', options.sessionId]),
    ];
    const environment = cleanProviderEnvironment(options.environment);
    const child = spawn(this.#launch.executable, args, {
      cwd: options.cwd, env: environment, stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true, shell: false,
    });
    this.#turns.set(turnId, child);
    let stderr = '';
    let receivedDelta = false;
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-2_000); });
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
      const message = parse(line);
      if (!message) return;
      if (message.type === 'stream_event') {
        const event = object(message.event);
        const delta = object(event.delta);
        if (event.type === 'content_block_delta' && delta.type === 'text_delta' && typeof delta.text === 'string') {
          receivedDelta = true;
          options.onEvent('assistant.delta', { text: delta.text });
        }
        const block = object(event.content_block);
        if (event.type === 'content_block_start' && block.type === 'tool_use') {
          options.onEvent('tool.event', { phase: 'started', tool: String(block.name ?? 'tool'), summary: String(block.name ?? 'tool') });
        }
        return;
      }
      if (message.type === 'assistant' && !receivedDelta) {
        for (const block of contentBlocks(message)) {
          if (block.type === 'text' && typeof block.text === 'string') options.onEvent('assistant.delta', { text: block.text });
          if (block.type === 'tool_use') options.onEvent('tool.event', {
            phase: 'started', tool: String(block.name ?? 'tool'), summary: String(block.name ?? 'tool'),
          });
        }
      }
      if (message.type === 'result') {
        options.onEvent('turn.completed', {
          status: message.is_error === true ? 'failed' : 'completed',
          costUsd: numberOrZero(message.total_cost_usd),
          durationMs: numberOrZero(message.duration_ms),
        });
      }
    });
    child.once('error', (error) => options.onExit(error.message));
    child.once('exit', (code) => {
      this.#turns.delete(turnId);
      const error = code === 0 ? null : safeError(stderr || `Claude Code 已退出（${code ?? 'signal'}）`);
      options.onExit(error);
    });
    child.stdin.end(options.prompt);
    options.onEvent('turn.started', { turnId });
    return turnId;
  }

  interrupt(turnId: string): void {
    const child = this.#turns.get(turnId);
    if (!child) throw new Error('当前没有可中断的 Claude Turn');
    child.kill('SIGTERM');
  }

  async stop(): Promise<void> {
    const children = [...this.#turns.values()];
    for (const child of children) child.kill('SIGTERM');
    await Promise.allSettled(children.map((child) => new Promise<void>((resolveExit) => {
      if (child.exitCode !== null) return resolveExit();
      child.once('exit', () => resolveExit());
      setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); resolveExit(); }, 2_000).unref();
    })));
    this.#turns.clear();
  }
}

function firstWhere(executable: string, root?: string): string | null {
  if (root) {
    const result = spawnSync('where.exe', ['/R', root, executable], {
      encoding: 'utf8', windowsHide: true, shell: false, timeout: 5_000,
      maxBuffer: 256 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return result.status === 0 ? (result.stdout ?? '').split(/\r?\n/).find(Boolean)?.trim() ?? null : null;
  }
  const result = spawnSync('where.exe', [executable], {
    encoding: 'utf8', windowsHide: true, shell: false, timeout: 5_000,
    maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return result.status === 0 ? (result.stdout ?? '').split(/\r?\n/).find(Boolean)?.trim() ?? null : null;
}

function cleanProviderEnvironment(additions?: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of [
    'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL',
    'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY',
  ]) delete environment[key];
  Object.assign(environment, additions ?? {}, { NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0' });
  return environment;
}

function contentBlocks(message: Record<string, unknown>): Record<string, unknown>[] {
  const nested = object(message.message);
  return Array.isArray(nested.content) ? nested.content.map(object) : [];
}

function parse(line: string): Record<string, unknown> | null {
  if (Buffer.byteLength(line, 'utf8') > 256 * 1024) return null;
  try {
    const value = JSON.parse(line) as unknown;
    return object(value);
  } catch { return null; }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function safeModel(value: string): string {
  const model = String(value ?? '').trim();
  if (!model || model.length > 128 || /[\r\n\0]/.test(model)) throw new Error('Claude Model 无效');
  return model;
}

function safeError(value: string): string {
  return value.replace(/sk-[A-Za-z0-9_-]+|Bearer\s+\S+/gi, '[REDACTED]').slice(0, 2_000);
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
