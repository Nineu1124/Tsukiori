import { randomUUID, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { spawn as spawnProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';

export type ComputerUseSupportLevel = 'supported' | 'experimental' | 'unsupported' | 'unknown';
export type ComputerUseAction =
  | { type: 'screenshot' }
  | { type: 'mouse_move'; x: number; y: number }
  | { type: 'mouse_click'; x: number; y: number; button?: 'left' | 'right' | 'middle'; clicks?: 1 | 2 }
  | { type: 'keyboard_type'; text: string }
  | { type: 'key_combo'; keys: string[] };

export type ComputerUseTarget = {
  pid: number;
  name: string;
  startTime: number;
  titleHash: string;
};

export type ComputerUseStatus = {
  supportLevel: ComputerUseSupportLevel;
  enforcementLevel: 'interceptable' | 'unknown';
  locked: boolean;
  target?: ComputerUseTarget;
  expiresAt?: number;
  foreground?: ComputerUseTarget;
  message: string;
};

export type ComputerUseActionResult = {
  action: ComputerUseAction['type'];
  target: ComputerUseTarget;
  screenshot?: { dataUrl: string; width: number; height: number; bytes: number };
};

type HelperRequest = Record<string, unknown> & { command: string };
type HelperResponse = {
  ok?: boolean;
  code?: string;
  message?: string;
  pid?: number;
  path?: string;
  startTime?: number;
  title?: string;
  rect?: { left: number; top: number; right: number; bottom: number };
  screen?: { left: number; top: number; width: number; height: number };
  width?: number;
  height?: number;
};

type HelperInvoker = (request: HelperRequest) => Promise<HelperResponse>;
type Clock = () => number;

type Lock = {
  ownerId: string;
  sessionId: string;
  target: InternalTarget;
  expiresAt: number;
};

type Approval = {
  ownerId: string;
  action: ComputerUseAction;
  expiresAt: number;
};

type InternalTarget = ComputerUseTarget & { path: string };

const LOCK_TTL_MS = 5 * 60_000;
const APPROVAL_TTL_MS = 30_000;
const MAX_TEXT_LENGTH = 4_096;
const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;
const KEY_CODES: Readonly<Record<string, number>> = Object.freeze({
  BACKSPACE: 0x08, TAB: 0x09, ENTER: 0x0d, SHIFT: 0x10, CTRL: 0x11, ALT: 0x12,
  ESC: 0x1b, SPACE: 0x20, PAGEUP: 0x21, PAGEDOWN: 0x22, END: 0x23, HOME: 0x24,
  LEFT: 0x25, UP: 0x26, RIGHT: 0x27, DOWN: 0x28, INSERT: 0x2d, DELETE: 0x2e,
  META: 0x5b, F1: 0x70, F2: 0x71, F3: 0x72, F4: 0x73, F5: 0x74, F6: 0x75,
  F7: 0x76, F8: 0x77, F9: 0x78, F10: 0x79, F11: 0x7a, F12: 0x7b,
});

export class ComputerUseManager {
  readonly #helperPath: string;
  readonly #screenshotRoot: string;
  readonly #platform: NodeJS.Platform;
  readonly #invokeHelper: HelperInvoker;
  readonly #now: Clock;
  #lock: Lock | undefined;
  readonly #approvals = new Map<string, Approval>();

  constructor(options: {
    helperPath: string;
    userDataPath: string;
    platform?: NodeJS.Platform;
    invokeHelper?: HelperInvoker;
    now?: Clock;
  }) {
    this.#helperPath = resolve(options.helperPath);
    this.#screenshotRoot = resolve(options.userDataPath, 'computer-use', 'screenshots');
    this.#platform = options.platform ?? process.platform;
    this.#invokeHelper = options.invokeHelper ?? ((request) => invokePowerShell(this.#helperPath, request));
    this.#now = options.now ?? Date.now;
  }

  async status(ownerId?: string): Promise<ComputerUseStatus> {
    const base = this.#baseStatus();
    if (base.supportLevel === 'unsupported') return base;
    if (base.supportLevel === 'unknown') return base;
    this.#expire();
    let foreground: InternalTarget | undefined;
    try { foreground = await this.#foreground(); } catch { /* status remains useful without foreground access */ }
    const result: ComputerUseStatus = {
      ...base,
      locked: Boolean(this.#lock && (!ownerId || this.#lock.ownerId === ownerId)),
      ...(this.#lock && (!ownerId || this.#lock.ownerId === ownerId) ? {
        target: publicTarget(this.#lock.target), expiresAt: this.#lock.expiresAt,
      } : {}),
      ...(foreground ? { foreground: publicTarget(foreground) } : {}),
      message: this.#lock ? '已锁定前台应用；每个动作仍需单次确认' : '未锁定前台应用',
    };
    return result;
  }

  async foreground(): Promise<ComputerUseTarget> {
    this.#assertSupported();
    return publicTarget(await this.#foreground());
  }

  async acquire(ownerId: string, sessionId: string): Promise<ComputerUseStatus> {
    this.#assertSupported();
    assertIdentity(ownerId, 'ownerId');
    assertIdentity(sessionId, 'sessionId');
    this.#expire();
    if (this.#lock && this.#lock.ownerId !== ownerId) throw new Error('Computer Use 已被另一个窗口锁定');
    const target = await this.#foreground(2_000);
    assertAllowedTarget(target.path);
    this.#lock = { ownerId, sessionId, target, expiresAt: this.#now() + LOCK_TTL_MS };
    this.#approvals.clear();
    return this.status(ownerId);
  }

  release(ownerId: string): ComputerUseStatus {
    this.#assertSupported();
    if (this.#lock && this.#lock.ownerId !== ownerId) throw new Error('Computer Use 锁定者不匹配');
    this.#lock = undefined;
    this.#approvals.clear();
    return this.#baseStatus('已释放前台应用锁');
  }

  requestAction(ownerId: string, action: ComputerUseAction): { approvalId: string; action: ComputerUseAction; expiresAt: number; target: ComputerUseTarget } {
    this.#assertSupported();
    const lock = this.#requireLock(ownerId);
    validateAction(action);
    const approvalId = 'computer-approval:' + randomUUID();
    const expiresAt = this.#now() + APPROVAL_TTL_MS;
    this.#approvals.set(approvalId, { ownerId, action, expiresAt });
    return { approvalId, action, expiresAt, target: publicTarget(lock.target) };
  }

  async approveAction(ownerId: string, approvalId: string): Promise<ComputerUseActionResult> {
    this.#assertSupported();
    assertIdentity(ownerId, 'ownerId');
    assertIdentity(approvalId, 'approvalId');
    this.#expire();
    const approval = this.#approvals.get(approvalId);
    if (!approval || approval.ownerId !== ownerId) throw new Error('Computer Use 操作审批不存在或已过期');
    this.#approvals.delete(approvalId);
    const lock = this.#requireLock(ownerId);
    const current = await this.#foreground();
    assertSameTarget(lock.target, current);
    const result = await this.#execute(approval.action, current);
    if (this.#lock) this.#lock.expiresAt = this.#now() + LOCK_TTL_MS;
    return result;
  }

  shutdown(): void {
    this.#lock = undefined;
    this.#approvals.clear();
    if (existsSync(this.#screenshotRoot)) {
      try { rmSync(this.#screenshotRoot, { recursive: true, force: true }); } catch { /* best effort cleanup */ }
    }
  }

  #baseStatus(message = 'Computer Use 已实现，但不是 OS 安全沙箱'): ComputerUseStatus {
    if (this.#platform !== 'win32') return { supportLevel: 'unsupported', enforcementLevel: 'unknown', locked: false, message: '当前平台不是 Windows' };
    if (!existsSync(this.#helperPath)) return { supportLevel: 'unknown', enforcementLevel: 'unknown', locked: false, message: 'Windows Helper 未打包' };
    return { supportLevel: 'supported', enforcementLevel: 'interceptable', locked: Boolean(this.#lock), message };
  }

  #assertSupported(): void {
    const status = this.#baseStatus();
    if (status.supportLevel !== 'supported') throw new Error(status.message);
  }

  #expire(): void {
    const now = this.#now();
    if (this.#lock && this.#lock.expiresAt <= now) this.#lock = undefined;
    for (const [id, approval] of this.#approvals) if (approval.expiresAt <= now) this.#approvals.delete(id);
  }

  #requireLock(ownerId: string): Lock {
    assertIdentity(ownerId, 'ownerId');
    this.#expire();
    if (!this.#lock) throw new Error('请先锁定前台应用');
    if (this.#lock.ownerId !== ownerId) throw new Error('Computer Use 锁定者不匹配');
    return this.#lock;
  }

  async #foreground(delayMs = 0): Promise<InternalTarget> {
    const response = await this.#invoke({ command: 'foreground', ...(delayMs > 0 ? { delayMs } : {}) });
    assertHelperOk(response);
    const pid = finiteInteger(response.pid, 'foreground pid');
    const path = typeof response.path === 'string' ? resolve(response.path) : '';
    const startTime = finiteInteger(response.startTime, 'foreground startTime');
    if (pid <= 0 || !path || startTime <= 0) throw new Error('无法确认前台应用身份');
    const title = typeof response.title === 'string' ? response.title : '';
    return { pid, path, startTime, titleHash: createHash('sha256').update(title).digest('hex').slice(0, 16), name: basename(path) };
  }

  async #execute(action: ComputerUseAction, target: InternalTarget): Promise<ComputerUseActionResult> {
    const beforeAction = await this.#foreground();
    assertSameTarget(target, beforeAction);
    if (action.type === 'screenshot') {
      mkdirSync(this.#screenshotRoot, { recursive: true });
      const path = resolve(this.#screenshotRoot, `${this.#now()}-${randomUUID()}.png`);
      try {
        const response = await this.#invoke({ command: 'screenshot', path });
        assertHelperOk(response);
        const bytes = readFileSync(path);
        if (bytes.byteLength === 0 || bytes.byteLength > MAX_SCREENSHOT_BYTES) throw new Error('截图大小超出限制');
        const width = finiteInteger(response.width, 'screenshot width');
        const height = finiteInteger(response.height, 'screenshot height');
        return { action: action.type, target: publicTarget(target), screenshot: { dataUrl: 'data:image/png;base64,' + bytes.toString('base64'), width, height, bytes: bytes.byteLength } };
      } finally {
        try { rmSync(path, { force: true }); } catch { /* best effort */ }
        try { rmSync(this.#screenshotRoot, { recursive: true, force: true }); } catch { /* best effort */ }
      }
    }
    if (action.type === 'mouse_move' || action.type === 'mouse_click') {
      const screen = await this.#screen();
      if (action.x < screen.left || action.y < screen.top || action.x >= screen.left + screen.width || action.y >= screen.top + screen.height) throw new Error('鼠标坐标超出当前屏幕范围');
      if (action.type === 'mouse_move') await this.#run({ command: 'mouse_move', x: action.x, y: action.y });
      else await this.#run({ command: 'mouse_click', button: action.button ?? 'left', clicks: action.clicks ?? 1, x: action.x, y: action.y });
      return { action: action.type, target: publicTarget(target) };
    }
    if (action.type === 'keyboard_type') {
      await this.#run({ command: 'keyboard_type', text: action.text });
      return { action: action.type, target: publicTarget(target) };
    }
    const keys = action.keys.map((key) => KEY_CODES[key.toUpperCase()] ?? charKeyCode(key));
    if (keys.some((key) => key === null)) throw new Error('包含不支持的快捷键');
    await this.#run({ command: 'key_combo', keys: keys as number[] });
    return { action: action.type, target: publicTarget(target) };
  }

  async #screen(): Promise<{ left: number; top: number; width: number; height: number }> {
    const response = await this.#invoke({ command: 'foreground' });
    assertHelperOk(response);
    const screen = response.screen;
    if (!screen || ![screen.left, screen.top, screen.width, screen.height].every(Number.isFinite) || screen.width <= 0 || screen.height <= 0) throw new Error('无法确认屏幕范围');
    return screen;
  }

  async #run(request: HelperRequest): Promise<void> {
    const response = await this.#invoke(request);
    assertHelperOk(response);
  }

  async #invoke(request: HelperRequest): Promise<HelperResponse> {
    const response = await this.#invokeHelper(request);
    if (!response || typeof response !== 'object') throw new Error('Windows Helper 响应无效');
    return response;
  }
}

function publicTarget(target: InternalTarget): ComputerUseTarget {
  return { pid: target.pid, name: target.name, startTime: target.startTime, titleHash: target.titleHash };
}

function assertHelperOk(response: HelperResponse): void {
  if (response.ok !== true) throw new Error(response.message || response.code || 'Windows Helper 操作失败');
}

function finiteInteger(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(label + ' 无效');
  return number;
}

function assertIdentity(value: string, label: string): void {
  if (!value || value.length > 256 || /[\u0000\r\n]/.test(value)) throw new Error(label + ' 无效');
}

function assertAllowedTarget(path: string): void {
  const normalized = resolve(path).toLowerCase();
  if (!normalized.endsWith('.exe')) throw new Error('前台应用不是可执行文件');
  const denied = ['\\powershell.exe', '\\pwsh.exe', '\\cmd.exe', '\\conhost.exe', '\\windowsterminal.exe'];
  if (denied.some((suffix) => normalized.endsWith(suffix))) throw new Error('不允许锁定 Shell 或终端宿主');
  if (normalized === resolve(process.execPath).toLowerCase()) throw new Error('不允许控制 Tsukiori 自身');
}

function assertSameTarget(expected: InternalTarget, actual: InternalTarget): void {
  if (expected.pid !== actual.pid || expected.startTime !== actual.startTime || expected.path.toLowerCase() !== actual.path.toLowerCase()) throw new Error('前台应用已变化，请重新锁定');
}

function validateAction(action: ComputerUseAction): void {
  if (!action || typeof action !== 'object') throw new Error('Computer Use 操作格式无效');
  if (action.type === 'screenshot') return;
  if (action.type === 'mouse_move' || action.type === 'mouse_click') {
    if (!Number.isSafeInteger(action.x) || !Number.isSafeInteger(action.y)) throw new Error('鼠标坐标必须是整数');
    if (action.type === 'mouse_click') {
      if (action.button !== undefined && !['left', 'right', 'middle'].includes(action.button)) throw new Error('鼠标按键无效');
      if (action.clicks !== undefined && action.clicks !== 1 && action.clicks !== 2) throw new Error('点击次数无效');
    }
    return;
  }
  if (action.type === 'keyboard_type') {
    if (typeof action.text !== 'string' || action.text.length === 0 || action.text.length > MAX_TEXT_LENGTH || /[\u0000]/.test(action.text)) throw new Error('键盘输入为空或超出限制');
    return;
  }
  if (action.type === 'key_combo') {
    if (!Array.isArray(action.keys) || action.keys.length < 1 || action.keys.length > 4 || action.keys.some((key) => typeof key !== 'string' || !/^[A-Za-z0-9_]+$/.test(key))) throw new Error('快捷键格式无效');
    return;
  }
  throw new Error('Computer Use 操作不支持');
}

function charKeyCode(value: string): number | null {
  if (!/^[A-Za-z0-9]$/.test(value)) return null;
  return value.toUpperCase().charCodeAt(0);
}

async function invokePowerShell(helperPath: string, request: HelperRequest): Promise<HelperResponse> {
  if (process.platform !== 'win32') throw new Error('Computer Use 仅支持 Windows');
  if (!existsSync(helperPath)) throw new Error('Windows Helper 未找到');
  const child = spawnProcess('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helperPath,
  ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let size = 0;
  child.stdout.on('data', (chunk: Buffer) => { size += chunk.byteLength; if (size <= 2 * 1024 * 1024) stdout.push(chunk); });
  child.stderr.on('data', (chunk: Buffer) => { if (Buffer.concat(stderr).byteLength <= 64 * 1024) stderr.push(chunk); });
  child.stdin.end(JSON.stringify(request));
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise, rejectPromise) => {
    child.once('error', rejectPromise);
    child.once('close', (code, signal) => resolvePromise({ code, signal }));
  });
  if (size > 2 * 1024 * 1024) throw new Error('Windows Helper 输出过大');
  const raw = Buffer.concat(stdout).toString('utf8').trim();
  if (!raw) throw new Error(Buffer.concat(stderr).toString('utf8').trim() || `Windows Helper 退出（${result.code ?? result.signal ?? 'unknown'}）`);
  try { return JSON.parse(raw) as HelperResponse; } catch { throw new Error('Windows Helper 返回的 JSON 无效'); }
}
