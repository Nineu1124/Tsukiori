import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const rendererRoot = join(root, 'apps', 'desktop', 'renderer');

test('Session workspace includes Attention, Tool, and Permission presentation surfaces', async () => {
  const [html, script] = await Promise.all([
    readFile(join(rendererRoot, 'index.html'), 'utf8'),
    readFile(join(rendererRoot, 'renderer.js'), 'utf8'),
  ]);
  assert.match(html, /id="attention-center"/);
  assert.match(html, /id="session-timeline"/);
  assert.match(html, /id="tool-card-template"/);
  assert.match(html, /id="permission-card-template"/);
  for (const label of ['类别', '风险', '范围', 'Enforcement Level']) assert.match(html, new RegExp(label));
  assert.match(script, /window\.tsukiori\.workspace\.snapshot\(\)/);
  assert.match(script, /textContent/);
  assert.doesNotMatch(script, /innerHTML|insertAdjacentHTML|eval\(/);
});