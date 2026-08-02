import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(desktopRoot, '..', '..');
const daemonSource = resolve(repositoryRoot, 'apps', 'daemon', 'dist');
const daemonTarget = resolve(desktopRoot, 'dist', 'daemon');

await rm(daemonTarget, { recursive: true, force: true });
await mkdir(daemonTarget, { recursive: true });
await cp(daemonSource, daemonTarget, { recursive: true });