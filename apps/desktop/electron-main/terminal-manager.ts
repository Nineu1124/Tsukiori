import { spawn, type IPty } from 'node-pty';

type TerminalSession = {
  pty: IPty;
  sessionId: string;
  exited: Promise<void>;
  resolveExit: () => void;
};

export type TerminalEvent = {
  sessionId: string;
  type: 'terminal.started' | 'terminal.output' | 'terminal.exited';
  payload: Record<string, unknown>;
};

export class TerminalManager {
  readonly #sessions = new Map<string, TerminalSession>();
  readonly #emit: (event: TerminalEvent) => void;

  constructor(emit: (event: TerminalEvent) => void) {
    this.#emit = emit;
  }

  start(sessionId: string, cwd: string, columns = 120, rows = 28, shell: 'powershell' | 'pwsh' | 'cmd' = 'powershell'): void {
    if (this.#sessions.has(sessionId)) return;
    const shellConfig = terminalShell(shell);
    const pty = spawn(shellConfig.executable, shellConfig.args, {
      name: 'xterm-256color',
      cwd,
      cols: clamp(columns, 40, 300),
      rows: clamp(rows, 8, 120),
      env: cleanEnvironment(),
      useConpty: true,
    });
    let resolveExit = (): void => undefined;
    const exited = new Promise<void>((resolve) => { resolveExit = resolve; });
    this.#sessions.set(sessionId, { pty, sessionId, exited, resolveExit });
    pty.onData((data) => {
      this.#emit({
        sessionId,
        type: 'terminal.output',
        payload: { data: bound(data, 32_768) },
      });
    });
    pty.onExit(({ exitCode, signal }) => {
      this.#sessions.delete(sessionId);
      resolveExit();
      this.#emit({ sessionId, type: 'terminal.exited', payload: { exitCode, signal } });
    });
    this.#emit({ sessionId, type: 'terminal.started', payload: { shell: shellConfig.label, cwd } });
  }

  write(sessionId: string, data: string): void {
    const terminal = this.#sessions.get(sessionId);
    if (!terminal) throw new Error('终端尚未启动');
    if (!data || Buffer.byteLength(data) > 8_192 || data.includes('\0')) throw new Error('终端输入无效');
    terminal.pty.write(data);
  }

  resize(sessionId: string, columns: number, rows: number): void {
    const terminal = this.#sessions.get(sessionId);
    if (!terminal) return;
    terminal.pty.resize(clamp(columns, 40, 300), clamp(rows, 8, 120));
  }

  async stop(sessionId: string): Promise<void> {
    const terminal = this.#sessions.get(sessionId);
    if (!terminal) return;
    terminal.pty.write('exit\r');
    await Promise.race([terminal.exited, delay(750)]);
    if (this.#sessions.get(sessionId) === terminal) {
      terminal.pty.kill();
      await Promise.race([terminal.exited, delay(500)]);
      this.#sessions.delete(sessionId);
      terminal.resolveExit();
    }
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.#sessions.keys()].map((sessionId) => this.stop(sessionId)));
  }
}

function terminalShell(value: 'powershell' | 'pwsh' | 'cmd'): { executable: string; args: string[]; label: string } {
  if (value === 'pwsh') return { executable: 'pwsh.exe', args: ['-NoLogo', '-NoProfile'], label: 'PowerShell 7' };
  if (value === 'cmd') return { executable: 'cmd.exe', args: ['/Q'], label: 'Command Prompt' };
  return { executable: 'powershell.exe', args: ['-NoLogo', '-NoProfile'], label: 'Windows PowerShell' };
}

function cleanEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string' && !/(TOKEN|SECRET|PASSWORD|API_KEY|AUTH)/i.test(key)) environment[key] = value;
  }
  environment.TERM = 'xterm-256color';
  environment.NO_COLOR = '0';
  environment.GIT_TERMINAL_PROMPT = '0';
  return environment;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.trunc(Number.isFinite(value) ? value : minimum)));
}

function bound(value: string, maximum: number): string {
  return value.length <= maximum ? value : value.slice(0, maximum);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
