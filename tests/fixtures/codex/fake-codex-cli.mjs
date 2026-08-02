import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const configPath = process.argv[2];
if (!configPath) process.exit(2);
const config = JSON.parse(readFileSync(configPath, 'utf8'));
if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli ' + config.version + '\n');
  process.exit(0);
}
if (!process.argv.includes('app-server')) process.exit(3);

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    const result = config.invalidInitialize
      ? { userAgent: 'fake-codex/' + config.version }
      : {
          codexHome: 'C:\\fixture\\codex-home',
          platformFamily: 'windows',
          platformOs: 'windows',
          userAgent: 'fake-codex/' + config.version,
        };
    process.stdout.write(JSON.stringify({ id: message.id, result }) + '\n');
    return;
  }
  if (message.method === 'account/read') {
    const account = config.accountType === null ? null : {
      type: config.accountType ?? 'chatgpt',
      email: 'private-account@example.invalid',
      planType: 'fixture-plan',
    };
    process.stdout.write(JSON.stringify({
      id: message.id,
      result: { account, requiresOpenaiAuth: config.requiresOpenaiAuth ?? true },
    }) + '\n');
    return;
  }
  if (message.method === 'fixture/crash') {
    process.exit(config.crashCode ?? 23);
  }
});
input.on('close', () => process.exit(0));
