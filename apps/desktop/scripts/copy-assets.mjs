import { cp, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = resolve(packageRoot, 'dist');

await mkdir(outputRoot, { recursive: true });
await Promise.all([
  cp(resolve(packageRoot, 'preload'), resolve(outputRoot, 'preload'), {
    recursive: true,
  }),
  cp(resolve(packageRoot, 'renderer'), resolve(outputRoot, 'renderer'), {
    recursive: true,
  }),
]);
