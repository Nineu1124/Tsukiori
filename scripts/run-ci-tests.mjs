import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const ciGroups = {
  core: ['spikes/adapter-contract', 'tests/ci', 'tests/database', 'tests/runtime', 'tests/permission', 'tests/observability'],
  host: ['tests/host', 'tests/ipc', 'tests/security'],
  adapters: ['spikes/codex', 'spikes/windows', 'spikes/opencode', 'tests/codex-adapter', 'tests/opencode-adapter', 'tests/dual-runtime'],
  claude: ['tests/claude-adapter'],
  workspace: ['tests/project', 'tests/worktree', 'tests/workspace', 'tests/git', 'tests/alpha-workflow', 'tests/recovery'],
  desktop: ['tests/ui', 'tests/interactive', 'tests/computer-use'],
  release: ['tests/release', 'tests/release-candidate'],
  gates: ['tests/gates'],
};

export function ciSteps(group) {
  if (group === 'gates') return ['g0', 'g1', 'g2', 'g3', 'g4', 'g5', 'v1-ready'].map((gate) => ({
    label: gate, args: ['--test', `tests/gates/${gate}.test.mjs`],
  }));
  const steps = [{ label: group, args: ['--test', `--test-concurrency=${group === 'host' ? 1 : 4}`, ...ciGroups[group].map((path) => path + '/*.test.mjs')] }];
  if (group === 'core') steps.push({ label: 'session snapshots', args: ['scripts/session-fixture-snapshots.mjs', '--check'] });
  if (group === 'desktop') steps.push({ label: 'UI interactions', args: ['scripts/probe-ui-interactions.mjs'] });
  return steps;
}

export function runNodeSteps(steps, options = {}) {
  for (const { label, args } of steps) {
    const started = Date.now();
    const result = spawnSync(process.execPath, args, { cwd: options.cwd, stdio: options.stdio ?? 'inherit', windowsHide: true, shell: false });
    console.log(`[ci] ${label}: ${Date.now() - started} ms, exit=${result.status ?? 'unavailable'}`);
    if (result.error || result.signal || result.status !== 0) return result.status || 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const selected = process.argv.slice(2);
  if (selected.length !== 1 || !Object.hasOwn(ciGroups, selected[0])) {
    console.error('Choose one CI group: ' + Object.keys(ciGroups).join(', '));
    process.exitCode = 2;
  } else {
    const group = selected[0];
    process.exitCode = runNodeSteps(ciSteps(group));
  }
}
