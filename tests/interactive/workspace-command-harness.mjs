import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createWorkspaceCommandHandler } from '../../apps/desktop/dist/electron-main/workspace-command.js';

// Evaluate the registered production IPC callback, replacing Electron objects.
// This exercises Main's actual dispatch without starting Electron or a Provider.
const main = readFileSync(new URL('../../apps/desktop/dist/electron-main/main.js', import.meta.url), 'utf8');
const start = main.indexOf("ipcMain.handle('workspace:command',");
const end = main.indexOf("ipcMain.handle('daemon:status',", start);
assert.ok(start >= 0 && end > start, 'production Workspace IPC registration must exist');
const registration = main.slice(start, end);

export function commandHarness(workspace = {}, dependencies = {}) {
  const rendererEntry = resolve('apps/desktop/renderer/index.html');
  const sender = { id: 41, mainFrame: { url: pathToFileURL(rendererEntry).href } };
  const event = { sender, senderFrame: sender.mainFrame };
  let handler;
  const context = {
    createWorkspaceCommandHandler, pathToFileURL, rendererEntry,
    mainWindow: { isDestroyed: () => false, webContents: sender },
    smokeMode: false, interactiveWorkspace: workspace,
    ipcMain: { handle(channel, value) { assert.equal(channel, 'workspace:command'); handler = value; } },
    object: (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {},
    ...dependencies,
  };
  runInNewContext(registration, context, { filename: 'production-workspace-ipc.js' });
  return { sender, event, context, invoke: (command, source = event) => handler(source, command) };
}
