import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('Renderer is sandboxed and receives only the fixed Preload API', async () => {
  const main = await readFile(
    join(repositoryRoot, 'apps', 'desktop', 'electron-main', 'main.ts'),
    'utf8',
  );
  const preload = await readFile(
    join(repositoryRoot, 'apps', 'desktop', 'preload', 'index.cjs'),
    'utf8',
  );

  assert.match(main, /nodeIntegration:\s*false/);
  assert.match(main, /contextIsolation:\s*true/);
  assert.match(main, /sandbox:\s*true/);
  assert.match(main, /webSecurity:\s*true/);
  assert.match(main, /setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/);

  assert.match(preload, /contextBridge\.exposeInMainWorld\('tsukiori'/);
  assert.match(preload, /ipcRenderer\.invoke\('host:versions'\)/);
  assert.match(preload, /ipcRenderer\.invoke\('daemon:status'\)/);
  assert.doesNotMatch(preload, /ipcRenderer\.(send|sendSync|on|once)\(/);
  assert.doesNotMatch(preload, /child_process|node:fs|node:net/);
});
