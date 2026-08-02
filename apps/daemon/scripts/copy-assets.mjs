import { cp, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = resolve(packageRoot, 'dist', 'windows');

await mkdir(outputDirectory, { recursive: true });
await cp(
  resolve(packageRoot, 'windows', 'named-pipe-host.ps1'),
  resolve(outputDirectory, 'named-pipe-host.ps1'),
);
