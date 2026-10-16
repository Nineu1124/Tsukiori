import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, globSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ciGroups, runNodeSteps } from '../../scripts/run-ci-tests.mjs';

test('the first failed child stops the sequence and preserves its exit code', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tsukiori-ci-failure-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const result = runNodeSteps([
    { label: 'failure fixture', args: ['-e', 'process.exit(17)'] },
    { label: 'must not run', args: ['-e', "require('node:fs').writeFileSync('ran', 'bad')"] },
  ], { cwd: directory, stdio: 'ignore' });
  assert.equal(result, 17);
  assert.equal(existsSync(join(directory, 'ran')), false);
  assert.equal(runNodeSteps([{ label: 'success fixture', args: ['-e', 'process.exit(0)'] }], { stdio: 'ignore' }), 0);
  assert.throws(() => execFileSync(process.execPath, ['scripts/run-ci-tests.mjs', 'unknown'], { stdio: 'pipe' }), { status: 2 });
});

test('CI groups include every offline test exactly once, including Claude and the runner itself', () => {
  const expected = globSync(['tests/**/*.test.mjs', 'spikes/**/*.test.mjs']).map((path) => path.replaceAll('\\', '/')).sort();
  const actual = Object.values(ciGroups).flatMap((paths) => globSync(paths.map((path) => path + '/*.test.mjs'))).map((path) => path.replaceAll('\\', '/')).sort();
  assert.deepEqual(actual, expected);
  const workflow = readFileSync('.github/workflows/windows-ci.yml', 'utf8');
  for (const group of Object.keys(ciGroups)) assert.ok(workflow.includes('run: node scripts/run-ci-tests.mjs ' + group));
  assert.equal(workflow.includes('run: |'), false, 'native command exits must not be hidden in multi-command steps');
});
