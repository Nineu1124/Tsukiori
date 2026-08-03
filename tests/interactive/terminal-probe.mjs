import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { TerminalManager } = await import(
  new URL('../../apps/desktop/dist/electron-main/terminal-manager.js', import.meta.url)
);

const directory = mkdtempSync(join(tmpdir(), 'tsukiori-terminal-probe-'));
let markerObserved = false;
let startedInWorktree = false;
let exitSent = false;
const manager = new TerminalManager((event) => {
  if (event.type === 'terminal.started') startedInWorktree = event.payload.cwd === directory;
  if (event.type === 'terminal.output' && String(event.payload.data).includes('TSUKIORI_PTY_OK')) {
    markerObserved = true;
    if (!exitSent) { exitSent = true; manager.write('session:terminal', 'exit\r'); }
  }
  if (event.type === 'terminal.exited') {
    rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
    process.stdout.write(JSON.stringify({ markerObserved, startedInWorktree, exitCode: event.payload.exitCode }));
    process.exit(markerObserved && startedInWorktree && event.payload.exitCode === 0 ? 0 : 1);
  }
});
manager.start('session:terminal', directory, 80, 20);
setTimeout(() => manager.write('session:terminal', "Write-Output 'TSUKIORI_PTY_OK'\r"), 250);
setTimeout(() => process.exit(2), 15_000).unref();
