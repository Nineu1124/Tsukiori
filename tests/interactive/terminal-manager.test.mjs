import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const probe = join(dirname(fileURLToPath(import.meta.url)), 'terminal-probe.mjs');

test('interactive ConPTY runs inside the selected Worktree and exits without an orphan', () => {
  const result = JSON.parse(execFileSync(process.execPath, [probe], {
    encoding: 'utf8', windowsHide: true, timeout: 20_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim());
  assert.equal(result.markerObserved, true);
  assert.equal(result.startedInWorktree, true);
  assert.equal(result.exitCode, 0);
});
