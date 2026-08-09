import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const adapter = await import(pathToFileURL(join(root, 'packages/adapter-claude/dist/index.js')).href);

test('Desktop consumes the version-locked Claude Adapter contract', () => {
  assert.equal(adapter.CLAUDE_MINIMUM_VERSION, '2.1.226');
  assert.equal(adapter.CLAUDE_MAXIMUM_TESTED_VERSION, '2.1.226');
  assert.equal(typeof adapter.ClaudeCodeClient, 'function');
  assert.equal(typeof adapter.ClaudeStreamJsonMapper, 'function');
});
