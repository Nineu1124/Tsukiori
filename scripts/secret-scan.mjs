import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';

const forbiddenNames = new Set([
  '.env',
  'auth.json',
  'id_rsa',
  'id_ed25519',
]);

const patterns = [
  ['OpenAI or DeepSeek-style key', /sk-[A-Za-z0-9_-]{20,}/],
  ['Anthropic key', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['GitHub token', /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/],
  ['AWS access key', /AKIA[0-9A-Z]{16}/],
  ['private key block', new RegExp('-----BEGIN ' + '(?:RSA |EC |OPENSSH )?PRIVATE KEY-----')],
];

let output;
try {
  output = execFileSync(
    'git',
    ['ls-files', '-co', '--exclude-standard', '-z'],
    { encoding: 'utf8' },
  );
} catch (error) {
  console.error('ERROR: secret scan requires a Git working tree');
  process.exit(1);
}

const files = [...new Set(output.split('\u0000').filter(Boolean))];
const findings = [];

for (const file of files) {
  const name = basename(file).toLowerCase();
  if (
    forbiddenNames.has(name) ||
    (name.startsWith('.env.') && name !== '.env.example')
  ) {
    findings.push(file + ': forbidden credential filename');
    continue;
  }

  let stat;
  try {
    stat = statSync(file);
  } catch {
    continue;
  }
  if (!stat.isFile() || stat.size > 2 * 1024 * 1024) {
    continue;
  }

  const content = readFileSync(file);
  if (content.includes(0)) {
    continue;
  }
  const value = content.toString('utf8');
  for (const [label, pattern] of patterns) {
    if (pattern.test(value)) {
      findings.push(file + ': possible ' + label);
    }
  }
}

if (findings.length > 0) {
  for (const finding of findings) {
    console.error('ERROR: ' + finding);
  }
  process.exit(1);
}

console.log(JSON.stringify({ scannedFiles: files.length, status: 'clean' }, null, 2));
