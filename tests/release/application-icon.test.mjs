import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const desktop = join(root, 'apps', 'desktop');

test('the user-supplied 1024 square PNG is the deterministic application icon source', async () => {
  const source = await readFile(join(desktop, 'assets', 'icon-source.png'));
  assert.deepEqual([...source.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(source.readUInt32BE(16), 1024);
  assert.equal(source.readUInt32BE(20), 1024);
  assert.equal(createHash('sha256').update(source).digest('hex'), '037cbb05e1ebc3ad73f313630bf0954a22c3b9711c11042a8e493966fa723748');
  const generator = await readFile(join(desktop, 'scripts', 'generate-icon.py'), 'utf8');
  assert.match(generator, /assets" \/ "icon-source\.png/);
  assert.doesNotMatch(generator, /ImageDraw|draw\./);
});

test('the generated ICO contains every Windows shell size and is wired into app and installer', async () => {
  const ico = await readFile(join(desktop, 'build', 'icon.ico'));
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  const count = ico.readUInt16LE(4);
  assert.equal(count, 7);
  const sizes = [];
  for (let index = 0; index < count; index += 1) {
    const offset = 6 + index * 16;
    const width = ico[offset] === 0 ? 256 : ico[offset];
    const height = ico[offset + 1] === 0 ? 256 : ico[offset + 1];
    assert.equal(width, height);
    sizes.push(width);
  }
  assert.deepEqual(sizes.sort((left, right) => left - right), [16, 24, 32, 48, 64, 128, 256]);

  const builder = await readFile(join(desktop, 'electron-builder.config.cjs'), 'utf8');
  const main = await readFile(join(desktop, 'electron-main', 'main.ts'), 'utf8');
  assert.match(builder, /icon:\s*'build\/icon\.ico'/);
  assert.match(main, /icon:\s*resolve\(currentDirectory, '\.\.', 'build', 'icon\.png'\)/);
});
