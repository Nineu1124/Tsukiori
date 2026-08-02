import { cpSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'dist', 'windows');
mkdirSync(output, { recursive: true });
cpSync(resolve(root, 'windows', 'credential-store.ps1'), resolve(output, 'credential-store.ps1'));
