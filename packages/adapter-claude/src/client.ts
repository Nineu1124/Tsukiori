import { randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  isolateRuntimeEnvironment,
  type RuntimeProviderEnvironmentKey,
} from '@tsukiori/runtime-core';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { ClaudeStreamJsonMapper } from './stream-json.js';

export const CLAUDE_MINIMUM_VERSION = '2.1.226';
export const CLAUDE_MAXIMUM_TESTED_VERSION = '2.1.226';

export type ClaudeCompatibility = 'supported' | 'unverified_newer' | 'incompatible_older';
export const CLAUDE_THINKING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ClaudeThinkingEffort = typeof CLAUDE_THINKING_EFFORTS[number];

export type ClaudeLaunch = {
  executable: string;
  prefixArgs?: string[];
  version: string;
  source: 'explicit' | 'npm-global' | 'winget' | 'path-executable';
  compatibility?: ClaudeCompatibility;
  capabilities?: string[];
};

export type ClaudeLaunchCandidate = Pick<ClaudeLaunch, 'executable' | 'prefixArgs' | 'source'>;

export type ClaudeAuthStatus = {
  authenticated: boolean;
  source: 'claude-oauth' | 'api-key' | 'external-provider' | 'unknown';
  method: string;
  provider: string;
};

export type ClaudeTurnOptions = {
  cwd: string;
  sessionId: string;
  resume: boolean;
  forkFromSessionId?: string;
  resumeSessionAt?: string;
  prompt: string;
  model: string;
  permissionMode: 'manual' | 'plan' | 'acceptEdits' | 'dontAsk';
  thinkingEffort?: ClaudeThinkingEffort;
  authMode?: 'native' | 'provider';
  environment?: Readonly<Record<string, string>>;
  onEvent: (type: string, payload: Record<string, unknown>) => void;
  onExit: (error: string | null) => void;
};

export type ClaudePermissionDecision = 'allow' | 'deny';

type PendingClaudePermission = {
  requestId: string;
  toolName: string;
  toolUseId: string;
  input: Record<string, unknown>;
};

type ActiveTurn = {
  child: ChildProcessWithoutNullStreams;
  emit: (type: string, payload: Record<string, unknown>) => void;
  mapper: ClaudeStreamJsonMapper;
  interruptRequested: boolean;
  completionReported: boolean;
  pendingPermissions: Map<string, PendingClaudePermission>;
};

export class ClaudeAdapterError extends Error {
  constructor(message: string) { super(message); this.name = 'ClaudeAdapterError'; }
}

export function discoverClaudeLaunch(options: { candidates?: readonly ClaudeLaunchCandidate[] } = {}): ClaudeLaunch {
  const candidates = options.candidates ?? defaultClaudeCandidates();
  const failures: string[] = [];
  for (const candidate of deduplicateCandidates(candidates)) {
    if (!existsSync(candidate.executable)) continue;
    const probe = probeClaudeLaunch(candidate);
    if (probe) return probe;
    failures.push(candidate.source);
  }
  throw new ClaudeAdapterError(
    failures.length > 0
      ? `发现 Claude Code 候选，但版本探测失败（${failures.join(', ')}）`
      : '未发现 Anthropic Claude Code；可安装官方 Claude Code 后重新探测',
  );
}

export function probeClaudeLaunch(candidate: ClaudeLaunchCandidate): ClaudeLaunch | null {
  const versionResult = spawnSync(candidate.executable, [...(candidate.prefixArgs ?? []), '--version'], {
    encoding: 'utf8', windowsHide: true, shell: false, timeout: 10_000,
    maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = `${versionResult.stdout ?? ''}\n${versionResult.stderr ?? ''}`;
  const version = versionResult.status === 0 && /Claude Code/i.test(output)
    ? output.match(/(\d+\.\d+\.\d+)/)?.[1]
    : undefined;
  if (!version) return null;
  const help = spawnSync(candidate.executable, [...(candidate.prefixArgs ?? []), '--help'], {
    encoding: 'utf8', windowsHide: true, shell: false, timeout: 10_000,
    maxBuffer: 256 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const helpText = help.status === 0 ? String(help.stdout ?? '') : '';
  const capabilityMarkers: ReadonlyArray<readonly [string, string]> = [
    ['stream-json', '--output-format'],
    ['session-resume', '--resume'],
    ['session-fork', '--fork-session'],
    ['hook-events', '--include-hook-events'],
    ['subagent-forwarding', '--forward-subagent-text'],
    ['mcp-config', '--mcp-config'],
    ['skills', '--disable-slash-commands'],
    ['structured-output', '--json-schema'],
    ['manual-permission-mode', '"manual"'],
  ];
  const capabilities = capabilityMarkers
    .filter(([, marker]) => helpText.includes(marker))
    .map(([name]) => name);
  if (helpText.includes('--effort <level>')
    && CLAUDE_THINKING_EFFORTS.every((level) => helpText.includes(level))) {
    capabilities.push('effort-control');
  }
  return {
    ...candidate,
    version,
    compatibility: compatibility(version),
    capabilities,
  };
}

export function probeClaudeAuth(launch: ClaudeLaunch): ClaudeAuthStatus {
  const result = spawnSync(launch.executable, [...(launch.prefixArgs ?? []), 'auth', 'status', '--json'], {
    encoding: 'utf8', windowsHide: true, shell: false, timeout: 10_000,
    maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    env: cleanProviderEnvironment(undefined, 'native'),
  });
  if (result.status !== 0) return { authenticated: false, source: 'unknown', method: 'none', provider: 'unknown' };
  try {
    const value = JSON.parse(result.stdout ?? '{}') as Record<string, unknown>;
    const authenticated = value.loggedIn === true;
    const method = safeMetadata(value.authMethod);
    const provider = safeMetadata(value.apiProvider);
    const source = method.includes('oauth')
      ? 'claude-oauth'
      : method.includes('api') ? 'api-key'
        : provider && provider !== 'firstParty' ? 'external-provider' : 'unknown';
    return { authenticated, source, method: method || 'unknown', provider: provider || 'unknown' };
  } catch {
    return { authenticated: false, source: 'unknown', method: 'invalid_response', provider: 'unknown' };
  }
}

export class ClaudeCodeClient {
  readonly #launch: ClaudeLaunch;
  readonly #allowUnverified: boolean;
  readonly #turns = new Map<string, ActiveTurn>();

  constructor(launch: ClaudeLaunch, options: { allowUnverified?: boolean } = {}) {
    this.#launch = launch;
    this.#allowUnverified = options.allowUnverified ?? false;
  }

  startTurn(options: ClaudeTurnOptions): string {
    const launchCompatibility = this.#launch.compatibility ?? compatibility(this.#launch.version);
    if (launchCompatibility !== 'supported' && !this.#allowUnverified) {
      throw new ClaudeAdapterError(`Claude Code ${this.#launch.version} compatibility is ${launchCompatibility}`);
    }
    const turnId = 'claude-turn:' + randomUUID();
    const connectionEpoch = 'claude-epoch:' + randomUUID();
    let runtimeSequence = 0;
    const emit = (type: string, payload: Record<string, unknown>): void => {
      runtimeSequence += 1;
      options.onEvent(type, {
        connectionEpoch,
        runtimeSequence,
        runtimeSessionId: options.sessionId,
        runtimeTurnId: turnId,
        ...payload,
      });
    };
    const capabilities = new Set(this.#launch.capabilities ?? []);
    const thinkingEffort = options.thinkingEffort === undefined
      ? undefined
      : safeThinkingEffort(options.thinkingEffort);
    if (thinkingEffort && !capabilities.has('effort-control')) {
      throw new ClaudeAdapterError(`Claude Code ${this.#launch.version} 未验证 --effort 控制能力`);
    }
    const authMode = options.authMode ?? 'provider';
    const args = [
      ...(this.#launch.prefixArgs ?? []),
      '--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json',
      '--permission-prompt-tool', 'stdio', '--include-partial-messages',
      ...(capabilities.has('hook-events') ? ['--include-hook-events'] : []),
      ...(capabilities.has('subagent-forwarding') ? ['--forward-subagent-text'] : []),
      ...(authMode === 'provider' ? ['--bare'] : []),
      ...(thinkingEffort ? ['--effort', thinkingEffort] : []),
      '--permission-mode', options.permissionMode, '--model', safeModel(options.model),
      ...(options.forkFromSessionId
        ? [
            '--resume', safeSessionId(options.forkFromSessionId), '--fork-session',
            ...(options.resumeSessionAt ? ['--resume-session-at', requiredControlId(options.resumeSessionAt)] : []),
          ]
        : options.resume ? ['--resume', safeSessionId(options.sessionId)] : ['--session-id', safeSessionId(options.sessionId)]),
    ];
    const child = spawn(this.#launch.executable, args, {
      cwd: options.cwd,
      env: cleanProviderEnvironment(options.environment, authMode),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
    const active: ActiveTurn = {
      child,
      emit,
      mapper: new ClaudeStreamJsonMapper(),
      interruptRequested: false,
      completionReported: false,
      pendingPermissions: new Map(),
    };
    this.#turns.set(turnId, active);
    let stderr = '';
    let exitReported = false;
    const complete = (status: 'failed' | 'interrupted', error?: string): void => {
      if (active.completionReported || active.mapper.sawResult) return;
      active.completionReported = true;
      emit('turn.completed', { status, ...(error ? { error } : {}) });
    };
    const reportExit = (error: string | null): void => {
      if (exitReported) return;
      exitReported = true;
      options.onExit(error);
    };
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4_000);
    });
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
      const control = parseControlLine(line);
      if (control?.type === 'permission') {
        const request = control.permission;
        if (active.pendingPermissions.has(request.requestId)) {
          emit('runtime.warning', { reason: 'duplicate_permission_request', requestId: request.requestId });
          return;
        }
        const inputBytes = Buffer.byteLength(JSON.stringify(request.input), 'utf8');
        if (inputBytes > 64 * 1024) {
          writeControlResponse(active, request, 'deny', '权限请求参数超过 Tsukiori 的 64 KiB 安全上限');
          emit('runtime.warning', { reason: 'permission_input_too_large', requestId: request.requestId, inputBytes });
          return;
        }
        active.pendingPermissions.set(request.requestId, request);
        emit('permission.requested', {
          requestId: request.requestId,
          toolUseId: request.toolUseId,
          tool: request.toolName,
          title: control.title || `${request.toolName} 请求权限`,
          description: control.description || control.decisionReason || 'Claude Code 请求执行工具',
          blockedPath: control.blockedPath,
          input: safePermissionInput(request.input),
        });
        return;
      }
      if (control?.type === 'cancel') {
        const pending = active.pendingPermissions.get(control.requestId);
        if (pending) {
          active.pendingPermissions.delete(control.requestId);
          emit('permission.invalidated', { requestId: control.requestId, reason: 'runtime_cancelled' });
        }
        return;
      }
      for (const event of active.mapper.mapLine(line)) {
        if (event.type === 'turn.completed') {
          active.completionReported = true;
          invalidatePermissions(active, 'turn_completed');
          if (!child.stdin.destroyed) child.stdin.end();
        }
        emit(event.type, event.payload);
      }
    });
    child.once('error', (error) => {
      const safe = safeError(error.message);
      complete('failed', safe);
      reportExit(safe);
    });
    child.once('exit', (code, signal) => {
      this.#turns.delete(turnId);
      invalidatePermissions(active, active.interruptRequested ? 'turn_interrupted' : 'runtime_exited');
      if (active.interruptRequested) {
        complete('interrupted');
        reportExit(null);
        return;
      }
      if (code !== 0) {
        const safe = safeError(stderr || `Claude Code 已退出（${code ?? signal ?? 'unknown'}）`);
        complete('failed', safe);
        reportExit(safe);
        return;
      }
      if (!active.mapper.sawResult) {
        const safe = 'Claude Code 已退出，但没有返回 Turn 结果';
        complete('failed', safe);
        reportExit(safe);
        return;
      }
      reportExit(null);
    });
    emit('turn.started', {
      turnId, authMode, resumed: options.resume || Boolean(options.forkFromSessionId),
      ...(options.forkFromSessionId ? { forkedFromRuntimeSessionId: options.forkFromSessionId } : {}),
      ...(options.resumeSessionAt ? { resumedAtRuntimeMessageId: options.resumeSessionAt } : {}),
    });
    child.stdin.on('error', (error) => {
      if (!active.completionReported && !active.interruptRequested) {
        emit('runtime.warning', { reason: 'stdin_write_failed', message: safeError(error.message) });
      }
    });
    child.stdin.write(JSON.stringify({
      type: 'user',
      ...(!options.forkFromSessionId ? { session_id: safeSessionId(options.sessionId) } : {}),
      parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'text', text: options.prompt }] },
    }) + '\n');
    return turnId;
  }

  respondToPermission(turnId: string, requestId: string, decision: ClaudePermissionDecision): void {
    const active = this.#turns.get(turnId);
    if (!active) throw new ClaudeAdapterError('Claude Turn 已结束，权限请求已失效');
    const pending = active.pendingPermissions.get(requestId);
    if (!pending) throw new ClaudeAdapterError('Claude 权限请求不存在、已处理或已失效');
    active.pendingPermissions.delete(requestId);
    writeControlResponse(
      active,
      pending,
      decision,
      decision === 'deny' ? '用户在 Tsukiori 中拒绝了此工具请求' : undefined,
    );
  }

  interrupt(turnId: string): void {
    const active = this.#turns.get(turnId);
    if (!active) throw new ClaudeAdapterError('当前没有可中断的 Claude Turn');
    active.interruptRequested = true;
    invalidatePermissions(active, 'turn_interrupted');
    active.child.kill('SIGTERM');
  }

  async stop(): Promise<void> {
    const activeTurns = [...this.#turns.values()];
    for (const active of activeTurns) {
      active.interruptRequested = true;
      invalidatePermissions(active, 'runtime_stopped');
      active.child.kill('SIGTERM');
    }
    await Promise.allSettled(activeTurns.map((active) => new Promise<void>((resolveExit) => {
      if (active.child.exitCode !== null) return resolveExit();
      active.child.once('exit', () => resolveExit());
      setTimeout(() => {
        if (active.child.exitCode === null) active.child.kill('SIGKILL');
        resolveExit();
      }, 2_000).unref();
    })));
    this.#turns.clear();
  }
}

type ParsedControlLine =
  | {
      type: 'permission';
      permission: PendingClaudePermission;
      title?: string;
      description?: string;
      decisionReason?: string;
      blockedPath?: string;
    }
  | { type: 'cancel'; requestId: string };

function parseControlLine(line: string): ParsedControlLine | null {
  if (Buffer.byteLength(line, 'utf8') > 256 * 1024) return null;
  let value: unknown;
  try { value = JSON.parse(line) as unknown; } catch { return null; }
  if (!isRecord(value)) return null;
  if (value.type === 'control_cancel_request') {
    const requestId = safeControlId(value.request_id);
    return requestId ? { type: 'cancel', requestId } : null;
  }
  if (value.type !== 'control_request') return null;
  const request = isRecord(value.request) ? value.request : null;
  if (!request || request.subtype !== 'can_use_tool' || !isRecord(request.input)) return null;
  const requestId = safeControlId(value.request_id);
  const toolUseId = safeControlId(request.tool_use_id);
  const toolName = safeToolName(request.tool_name);
  if (!requestId || !toolUseId || !toolName) return null;
  return {
    type: 'permission',
    permission: { requestId, toolUseId, toolName, input: request.input },
    ...optionalControlText('title', request.title, 256),
    ...optionalControlText('description', request.description, 1_000),
    ...optionalControlText('decisionReason', request.decision_reason, 1_000),
    ...optionalControlText('blockedPath', request.blocked_path, 2_000),
  };
}

function writeControlResponse(
  active: ActiveTurn,
  pending: PendingClaudePermission,
  decision: ClaudePermissionDecision,
  message?: string,
): void {
  if (active.child.stdin.destroyed || active.child.stdin.writableEnded) {
    throw new ClaudeAdapterError('Claude stdin 已关闭，权限请求已失效');
  }
  const response = decision === 'allow'
    ? { behavior: 'allow', updatedInput: pending.input }
    : { behavior: 'deny', message: message ?? '用户拒绝了此工具请求' };
  active.child.stdin.write(JSON.stringify({
    type: 'control_response',
    response: { subtype: 'success', request_id: pending.requestId, response },
  }) + '\n');
}

function invalidatePermissions(active: ActiveTurn, reason: string): void {
  for (const requestId of active.pendingPermissions.keys()) {
    active.emit('permission.invalidated', { requestId, reason });
  }
  active.pendingPermissions.clear();
}

function safePermissionInput(input: Record<string, unknown>): Record<string, unknown> {
  const sensitiveKey = /(^|[_-])(api[_-]?key|secret|token|password|cookie|authorization|private[_-]?key)([_-]|$)/i;
  const sensitiveValue = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----|\bBearer\s+\S+|\bsk-[A-Za-z0-9_-]{12,}/gi;
  const visit = (value: unknown, depth: number): unknown => {
    if (typeof value === 'string') return value.replace(sensitiveValue, '[REDACTED]').slice(0, 8_000);
    if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (depth >= 8) return '[MAX_DEPTH]';
    if (Array.isArray(value)) return value.slice(0, 64).map((item) => visit(item, depth + 1));
    if (!isRecord(value)) return '[UNSUPPORTED]';
    return Object.fromEntries(Object.entries(value).slice(0, 64).map(([key, item]) => [
      key,
      sensitiveKey.test(key) ? '[REDACTED]' : visit(item, depth + 1),
    ]));
  };
  return visit(input, 0) as Record<string, unknown>;
}

function optionalControlText<Key extends string>(key: Key, value: unknown, length: number): Partial<Record<Key, string>> {
  if (typeof value !== 'string') return {};
  const safe = safeError(value).slice(0, length).trim();
  return safe ? { [key]: safe } as Record<Key, string> : {};
}

function safeControlId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : '';
  return id.length >= 1 && id.length <= 256 && !/[\r\n\0]/.test(id) ? id : '';
}

function requiredControlId(value: unknown): string {
  const id = safeControlId(value);
  if (!id) throw new ClaudeAdapterError('Claude Runtime Message ID 无效');
  return id;
}

function safeToolName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  return name.length >= 1 && name.length <= 128 && /^[\w:.\/-]+$/u.test(name) ? name : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function defaultClaudeCandidates(): ClaudeLaunchCandidate[] {
  const candidates: ClaudeLaunchCandidate[] = [];
  if (process.env.CLAUDE_BIN) {
    candidates.push({ executable: process.env.CLAUDE_BIN, source: 'explicit' });
  }
  if (process.env.APPDATA) {
    candidates.push({
      executable: join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
      source: 'npm-global',
    });
  }
  for (const executable of firstWhere('claude.exe')) {
    candidates.push({ executable, source: 'path-executable' });
  }
  if (process.env.LOCALAPPDATA) {
    const root = join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages');
    for (const executable of firstWhere('claude.exe', root)) {
      candidates.push({ executable, source: 'winget' });
    }
  }
  return candidates;
}

function firstWhere(executable: string, root?: string): string[] {
  const where = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'where.exe');
  const result = spawnSync(where, [...(root ? ['/R', root] : []), executable], {
    encoding: 'utf8', windowsHide: true, shell: false, timeout: 5_000,
    maxBuffer: root ? 256 * 1024 : 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return result.status === 0
    ? (result.stdout ?? '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
    : [];
}

function deduplicateCandidates(candidates: readonly ClaudeLaunchCandidate[]): ClaudeLaunchCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.executable.toLowerCase()}\0${(candidate.prefixArgs ?? []).join('\0')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function cleanProviderEnvironment(
  additions: Readonly<Record<string, string>> | undefined,
  authMode: 'native' | 'provider',
): NodeJS.ProcessEnv {
  return buildClaudeRuntimeEnvironment(additions, authMode);
}

export function buildClaudeRuntimeEnvironment(
  additions: Readonly<Record<string, string>> | undefined,
  authMode: 'native' | 'provider',
  base: Readonly<NodeJS.ProcessEnv> = process.env,
): NodeJS.ProcessEnv {
  return isolateRuntimeEnvironment(
    base,
    authMode === 'provider' ? additions : undefined,
    claudeProviderEnvironmentKeys,
  );
}

const claudeProviderEnvironmentKeys: readonly RuntimeProviderEnvironmentKey[] = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
];

function compatibility(version: string): ClaudeCompatibility {
  if (compareSemver(version, CLAUDE_MINIMUM_VERSION) < 0) return 'incompatible_older';
  if (compareSemver(version, CLAUDE_MAXIMUM_TESTED_VERSION) > 0) return 'unverified_newer';
  return 'supported';
}

function compareSemver(left: string, right: string): number {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function safeSessionId(value: string): string {
  const sessionId = String(value ?? '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)) {
    throw new ClaudeAdapterError('Claude Session ID 无效');
  }
  return sessionId;
}

function safeThinkingEffort(value: string): ClaudeThinkingEffort {
  if (!CLAUDE_THINKING_EFFORTS.includes(value as ClaudeThinkingEffort)) {
    throw new ClaudeAdapterError('Claude Thinking effort 无效');
  }
  return value as ClaudeThinkingEffort;
}

function safeModel(value: string): string {
  const model = String(value ?? '').trim();
  if (!model || model.length > 128 || /[\r\n\0]/.test(model)) throw new ClaudeAdapterError('Claude Model 无效');
  return model;
}

function safeMetadata(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return /^[a-zA-Z0-9_.-]{1,64}$/.test(text) ? text : '';
}

function safeError(value: string): string {
  return value
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi, '[REDACTED]')
    .replace(/\bBearer\s+\S+|\bsk-[A-Za-z0-9_-]+/gi, '[REDACTED]')
    .slice(0, 2_000);
}
