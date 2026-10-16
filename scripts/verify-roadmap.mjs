import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const calendar = fileURLToPath(new URL('../docs/roadmap/daily-commit-calendar.md', import.meta.url));
const dayMs = 86_400_000;
const iso = (value) => new Date(value).toISOString().slice(0, 10);

export function validateRoadmap(text, readReport = (path) => readFileSync(resolve(dirname(calendar), path), 'utf8')) {
  const errors = [];
  const window = text.match(/执行窗口：\*\*(\d{4}-\d{2}-\d{2}) 至 (\d{4}-\d{2}-\d{2})\*\*/);
  const start = window ? Date.parse(window[1] + 'T00:00:00Z') : NaN;
  if (!window || !Number.isFinite(start) || iso(start) !== window[1]
    || iso(start + 167 * dayMs) !== window[2] || new Date(start).getUTCDay() !== 1) errors.push('执行窗口必须从周一开始，连续 168 天');
  const headings = [...text.matchAll(/^## 阶段 (\d+)：[^\r\n]+/gm)];
  if (headings.length !== 6) errors.push('必须有六个阶段');
  const rows = [];
  const dependencies = new Map();
  for (const [index, heading] of headings.entries()) {
    const phase = index + 1;
    if (Number(heading[1]) !== phase) errors.push('阶段编号不连续');
    const block = text.slice(heading.index, headings[index + 1]?.index ?? text.length);
    const dependency = block.match(/^依赖：([^\r\n]+)/m)?.[1];
    const required = phase === 1 ? undefined : `G-LT-0${phase - 1}`;
    if (!dependency || (required && !dependency.includes('`' + required + '`'))) errors.push(`阶段 ${phase} 缺少前一 Gate 依赖`);
    const declared = [...(dependency ?? '').matchAll(/G-LT-\d+/g)].map((match) => match[0]);
    if (JSON.stringify(declared) !== JSON.stringify(required ? [required] : [])) errors.push(`阶段 ${phase} 依赖不是唯一的前一 Gate`);
    dependencies.set(phase, required);
    let count = 0;
    for (const line of block.split(/\r?\n/).filter((line) => /^\| \[/.test(line))) {
      const match = line.match(/^\| \[([ xX])\] (T-LT-D\d{3}|G-LT-\d{2}) \| (\d{4}-\d{2}-\d{2})（周([一二三四五六日])） · W(\d{2}) \| `([^`]+)` \|([^|]+)\|$/);
      if (!match) { errors.push(`阶段 ${phase} 有无效任务行`); continue; }
      const [, checked, id, date, weekday, week, title, acceptance] = match;
      rows.push({ checked: checked.toLowerCase() === 'x', id, date, weekday, week: Number(week), title, acceptance, phase });
      count += 1;
    }
    if (count !== 28) errors.push(`阶段 ${phase} 应有 27 个任务和 1 个 Gate`);
  }
  if (rows.length !== 168) errors.push('计划必须有 168 行');
  const byId = new Map(rows.map((row) => [row.id, row]));
  if (byId.size !== rows.length) errors.push('任务 ID 重复');
  const expectedIds = new Set(Array.from({ length: 168 }, (_, index) => (index + 1) % 28 === 0
    ? `G-LT-0${(index + 1) / 28}` : `T-LT-D${String(index + 1).padStart(3, '0')}`));
  for (const id of expectedIds) if (!byId.has(id)) errors.push(`缺少任务 ${id}`);
  for (const [index, row] of rows.entries()) {
    if (!expectedIds.has(row.id)) errors.push(`未知任务 ${row.id}`);
    if (Number.isFinite(start) && row.date !== iso(start + index * dayMs)) errors.push(`${row.id} 日期不连续`);
    const date = Date.parse(row.date + 'T00:00:00Z');
    if (!Number.isFinite(date) || iso(date) !== row.date || row.weekday !== '日一二三四五六'[new Date(date).getUTCDay()]) errors.push(`${row.id} 日期或星期错误`);
    if (row.week !== Math.floor(index / 7) + 1) errors.push(`${row.id} 周次错误`);
    if (!row.title.includes('(' + row.id + '):')) errors.push(`${row.id} 提交标题缺少自身 ID`);
    const isGate = row.id.startsWith('G-');
    if (isGate ? row.id !== `G-LT-0${row.phase}` || (index + 1) % 28 !== 0
      : Math.ceil(Number(row.id.slice(-3)) / 28) !== row.phase) errors.push(`${row.id} 阶段或 Gate 位置错误`);
    const prerequisite = dependencies.get(row.phase);
    if (row.checked && prerequisite && !byId.get(prerequisite)?.checked) errors.push(`${row.id} 完成前必须通过 ${prerequisite}`);
    if (isGate && row.checked && rows.some((item) => item.phase === row.phase && item.id !== row.id && !item.checked)) errors.push(`${row.id} 存在未完成的前置任务`);
    if (!row.checked) continue;
    const reportPath = row.acceptance.match(/\[验收记录\]\(([^)]+)\)/)?.[1];
    if (!reportPath || !/^\.\.\/(spikes|adr)\/[A-Za-z0-9_-]+\.md$/.test(reportPath)
      || !reportPath.split('/').at(-1).startsWith(row.id + '-')) {
      errors.push(`${row.id} 缺少有效验收记录链接`);
      continue;
    }
    try {
      const report = readReport(reportPath);
      if (!report.includes(row.id) || !/20\d{2}-\d{2}-\d{2}/.test(report)) errors.push(`${row.id} 报告缺少任务 ID 或日期`);
      const actualDate = row.acceptance.match(/实际 (\d{4}-\d{2}-\d{2}) 完成/)?.[1];
      if (actualDate && !report.includes(actualDate)) errors.push(`${row.id} 实际日期与报告不一致`);
    } catch { errors.push(`${row.id} 验收报告无法读取`); }
  }
  return { errors, tasks: rows.filter((row) => row.id.startsWith('T-')).length,
    gates: rows.filter((row) => row.id.startsWith('G-')).length, completed: rows.filter((row) => row.checked).length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = validateRoadmap(readFileSync(calendar, 'utf8'));
  console.log(JSON.stringify({ ...result, status: result.errors.length ? 'invalid' : 'valid' }, null, 2));
  if (result.errors.length) process.exitCode = 1;
}
