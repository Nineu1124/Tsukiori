import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { FakeRuntimeAdapter } = await import(
  pathToFileURL(join(root, 'packages/adapter-fake/dist/index.js')).href,
);
const thresholds = JSON.parse(readFileSync(
  join(root, 'tests/fixtures/observability/t5.3-result.json'),
  'utf8',
)).performanceThresholdMs;

function git(cwd, args) {
  return execFileSync('git.exe', ['-C', cwd, ...args], {
    encoding: 'utf8', windowsHide: true, shell: false,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
  });
}

test('three parallel Sessions meet startup, 3000-event streaming, and Diff baselines', (t) => {
  const startupAt = performance.now();
  const adapters = [0, 1, 2].map(() => new FakeRuntimeAdapter());
  const sessions = adapters.map((adapter) => adapter.createSession());
  const startupMs = performance.now() - startupAt;

  const steps = Array.from({ length: 1000 }, (_, index) => ({
    kind: 'event', nativeType: index === 0 ? 'message.started' : 'text.delta',
    payload: { text: 'bounded-' + index },
  }));
  const streamingAt = performance.now();
  for (let index = 0; index < 3; index += 1) adapters[index].runScript(sessions[index], steps);
  const streamingMs = performance.now() - streamingAt;
  assert.deepEqual(adapters.map((adapter) => adapter.events.length), [1000, 1000, 1000]);

  const directory = mkdtempSync(join(tmpdir(), 'tsukiori-performance-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repositories = [0, 1, 2].map((id) => {
    const path = join(directory, 'session-' + id);
    execFileSync('git.exe', ['init', path], { windowsHide: true, stdio: 'ignore' });
    git(path, ['config', 'user.name', 'Tsukiori Fixture']);
    git(path, ['config', 'user.email', 'fixture@example.invalid']);
    writeFileSync(join(path, 'file.txt'), 'base\n');
    git(path, ['add', '--', 'file.txt']);
    git(path, ['commit', '--no-gpg-sign', '--no-verify', '-m', 'fixture']);
    writeFileSync(join(path, 'file.txt'), 'base\nchange-' + id + '\n');
    return path;
  });
  const diffAt = performance.now();
  const diffs = repositories.map((path) => git(path, ['diff', '--no-ext-diff', '--no-color']));
  const diffMs = performance.now() - diffAt;
  assert.equal(diffs.every((value) => value.includes('+change-')), true);

  const observed = { startupMs, streamingMs, diffMs };
  process.stdout.write('T5.3_PERFORMANCE ' + JSON.stringify(observed) + '\n');
  assert.ok(startupMs <= thresholds.threeSessionStartup, JSON.stringify(observed));
  assert.ok(streamingMs <= thresholds.threeSessionStreaming3000Events, JSON.stringify(observed));
  assert.ok(diffMs <= thresholds.threeSessionDiff, JSON.stringify(observed));
});
