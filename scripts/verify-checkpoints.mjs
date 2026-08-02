import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const documentPath = fileURLToPath(
  new URL('../本地多Agent工作台_完整架构与实施方案.md', import.meta.url),
);
const text = readFileSync(documentPath, 'utf8');
const errors = [];

function section(startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker);
  if (start < 0 || end <= start) {
    errors.push('Missing or invalid section boundary: ' + startMarker);
    return '';
  }
  return text.slice(start, end);
}

const chapter32 = section('# 32. 实施 TODO 与里程碑', '# 33. 测试体系');
const chapter37 = section('# 37. 可发布 Local V1 验收标准', '# 38. 主要风险与应对');

const headingPattern = /^### (T\d+\.\d+|G\d+|B\d+)\s+.+$/gm;
const headings = [...chapter32.matchAll(headingPattern)];
const ids = headings.map((match) => match[1]);
const idSet = new Set(ids);

if (ids.length !== idSet.size) {
  errors.push('Task, Gate, or backlog identifiers are duplicated');
}

const expected = { task: 27, gate: 6, backlog: 3 };
const counts = {
  task: ids.filter((id) => id.startsWith('T')).length,
  gate: ids.filter((id) => id.startsWith('G')).length,
  backlog: ids.filter((id) => id.startsWith('B')).length,
};

for (const key of Object.keys(expected)) {
  if (counts[key] !== expected[key]) {
    errors.push('Expected ' + expected[key] + ' ' + key + ' entries, found ' + counts[key]);
  }
}

const order = new Map(ids.map((id, index) => [id, index]));

for (let index = 0; index < headings.length; index += 1) {
  const match = headings[index];
  const id = match[1];
  const end = index + 1 < headings.length ? headings[index + 1].index : chapter32.length;
  const block = chapter32.slice(match.index, end);
  const parent = block.match(/^- \[([ xX])\] .+$/m);
  const children = [...block.matchAll(/^  - \[([ xX])\] .+$/gm)];

  if (!parent) {
    errors.push(id + ' has no top-level checkbox');
  }
  if (!block.includes('Checkpoints：')) {
    errors.push(id + ' has no Checkpoints section');
  }
  if (children.length === 0) {
    errors.push(id + ' has no child Checkpoint');
  }

  const parentChecked = parent && parent[1].toLowerCase() === 'x';
  const allChildrenChecked =
    children.length > 0 && children.every((child) => child[1].toLowerCase() === 'x');
  if (parentChecked && !allChildrenChecked) {
    errors.push(id + ' is checked while one or more child Checkpoints are incomplete');
  }

  if (!id.startsWith('B')) {
    const dependencyLine = block.match(/^- 前置依赖：(.+)$/m);
    if (!dependencyLine) {
      errors.push(id + ' has no dependency declaration');
      continue;
    }

    const dependencies = [
      ...dependencyLine[1].matchAll(/(?<![\w.])(T\d+\.\d+|G\d+)(?![\w.])/g),
    ].map((dependency) => dependency[1]);

    for (const dependency of dependencies) {
      if (!idSet.has(dependency)) {
        errors.push(id + ' references missing dependency ' + dependency);
      } else if (order.get(dependency) >= order.get(id)) {
        errors.push(id + ' references non-prior dependency ' + dependency);
      }
    }
  }
}

const acceptanceStart = chapter37.indexOf('## 37.1');
if (acceptanceStart < 0) {
  errors.push('V1 acceptance sections are missing');
} else {
  const acceptanceLines = chapter37
    .slice(acceptanceStart)
    .split(/\r?\n/)
    .filter((line) => /^- \[[ xX]\] /.test(line));

  if (acceptanceLines.length < 50) {
    errors.push('Expected at least 50 mapped V1 acceptance checks');
  }
  for (const line of acceptanceLines) {
    if (!/^- \[[ xX]\] \[(T\d+\.\d+|G\d+)/.test(line)) {
      errors.push('Acceptance item has no task mapping: ' + line);
    }
  }
}

let fence = null;
let fenceLine = 0;
text.split(/\r?\n/).forEach((line, index) => {
  const match = line.match(/^\s*((?:\x60){3,}|~{3,})/);
  if (!match) {
    return;
  }
  const token = match[1];
  if (fence === null) {
    fence = token;
    fenceLine = index + 1;
  } else if (fence[0] === token[0] && token.length >= fence.length) {
    fence = null;
    fenceLine = 0;
  }
});

if (fence !== null) {
  errors.push('Unclosed Markdown fence opened at line ' + fenceLine);
}
if (text.includes('\u0000')) {
  errors.push('Architecture document contains a NUL byte');
}
if (!text.trimEnd().endsWith('**文档结束。**')) {
  errors.push('Architecture document ending marker is missing');
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error('ERROR: ' + error);
  }
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      tasks: counts.task,
      gates: counts.gate,
      backlog: counts.backlog,
      status: 'valid',
    },
    null,
    2,
  ),
);
