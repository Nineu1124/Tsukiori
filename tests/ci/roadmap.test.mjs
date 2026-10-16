import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { validateRoadmap } from '../../scripts/verify-roadmap.mjs';

const source = readFileSync('docs/roadmap/daily-commit-calendar.md', 'utf8');
// Mutations start with every row pending, independent of future completion dates.
const pending = source.replaceAll('| [x]', '| [ ]');
const complete = (text, id) => text.replace(`| [ ] ${id} |`, `| [x] ${id} |`);

test('the actual roadmap has 162 tasks, six gates and readable completion reports', () => {
  const result = validateRoadmap(source);
  assert.deepEqual(result.errors, []);
  assert.equal(result.tasks, 162);
  assert.equal(result.gates, 6);
});

for (const [name, mutate, expected] of [
  ['duplicate ID', (s) => s.replaceAll('T-LT-D002', 'T-LT-D001'), /ID 重复/],
  ['missing row', (s) => s.split('\n').filter((line) => !line.startsWith('| [ ] T-LT-D003 |')).join('\n'), /168 行/],
  ['calendar gap', (s) => s.replace('2026-09-22（周二）', '2026-09-23（周三）'), /日期不连续/],
  ['wrong weekday', (s) => s.replace('2026-09-21（周一）', '2026-09-21（周日）'), /星期错误/],
  ['wrong week', (s) => s.replace('· W01 |', '· W02 |'), /周次错误/],
  ['wrong title', (s) => s.replace('(T-LT-D001):', '(T-LT-D002):'), /提交标题/],
  ['wrong dependency', (s) => s.replace('依赖：`G-LT-01`', '依赖：`G-LT-03`'), /依赖/],
  ['premature gate', (s) => complete(s, 'G-LT-01'), /未完成的前置任务/],
  ['crossing a pending gate', (s) => complete(s, 'T-LT-D029'), /必须通过 G-LT-01/],
  ['missing evidence link', (s) => complete(s, 'T-LT-D001').replace(/\[验收记录\]\([^)]+\)/, ''), /缺少有效验收记录/],
  ['unsafe evidence path', (s) => complete(s, 'T-LT-D001').replace('../spikes/T-LT-D001-atomic-workspace-state.md', '../../private.md'), /缺少有效验收记录/],
]) {
  test(`roadmap validation rejects ${name}`, () => assert.match(validateRoadmap(mutate(pending)).errors.join('\n'), expected));
}

test('a checked task fails when its report is missing or belongs to another task', () => {
  const checked = complete(pending, 'T-LT-D001');
  assert.match(validateRoadmap(checked, () => { throw new Error('missing'); }).errors.join('\n'), /无法读取/);
  assert.match(validateRoadmap(checked, () => 'T-LT-D999 2026-09-21').errors.join('\n'), /报告缺少/);
});

test('independent tasks may be rescheduled within a phase without breaking date continuity', () => {
  const swapped = pending.replaceAll('T-LT-D001', 'T-LT-D999').replaceAll('T-LT-D002', 'T-LT-D001').replaceAll('T-LT-D999', 'T-LT-D002');
  assert.deepEqual(validateRoadmap(swapped).errors, []);
});

test('a completed phase unlocks the next phase only after its Gate is checked', () => {
  const withEvidence = pending.split('\n').map((line) => {
    const id = line.match(/^\| \[ \] (T-LT-D\d{3}|G-LT-\d{2}) \|/)?.[1];
    if (!id || !(id === 'G-LT-01' || id === 'T-LT-D029' || (id.startsWith('T-') && Number(id.slice(-3)) <= 27))) return line;
    return line.replace('| [ ]', '| [x]').replace(/\|$/, ` [验收记录](../spikes/${id}-fixture.md) |`);
  }).join('\n');
  assert.deepEqual(validateRoadmap(withEvidence, () => withEvidence).errors, []);
  assert.match(validateRoadmap(withEvidence.replace('| [x] G-LT-01', '| [ ] G-LT-01'), () => withEvidence).errors.join('\n'), /必须通过 G-LT-01/);
});
