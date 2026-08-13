import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const explicit = valueAfter('--claude');
const appData = process.env.APPDATA ?? '';
const defaultExecutable = join(appData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
const executable = explicit ?? defaultExecutable;
if (!existsSync(executable)) throw new Error('Claude Code executable not found; pass --claude <path>');

const versionOutput = probeText(['--version'], 64 * 1024);
const version = versionOutput.match(/(\d+\.\d+\.\d+)/)?.[1];
if (!version) throw new Error('Claude Code version probe failed');
const help = probeText(['--help'], 256 * 1024);
const advertisedEfforts = ['low', 'medium', 'high', 'xhigh', 'max'].filter((level) => help.includes(level));

const result = {
  schemaVersion: 1,
  runtime: 'claude-code',
  runtimeVersion: version,
  probe: 'version-and-help-only',
  helpSha256: createHash('sha256').update(help).digest('hex'),
  helpBytes: Buffer.byteLength(help, 'utf8'),
  cli: {
    effortArgument: help.includes('--effort <level>'),
    advertisedEfforts,
  },
  boundaries: {
    providerApiRequestShape: 'not_probed',
    claudeToProviderEffortMapping: 'unknown',
    modelRequestStarted: false,
    networkUsed: false,
  },
  security: {
    credentialRead: false,
    promptProvided: false,
    userSourceRead: false,
    runtimeOutputPersisted: false,
  },
};
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
if (!result.cli.effortArgument || !['high', 'max'].every((level) => advertisedEfforts.includes(level))) process.exitCode = 1;

function probeText(args, maxBuffer) {
  const result = spawnSync(executable, args, {
    encoding: 'utf8', windowsHide: true, shell: false, timeout: 10_000,
    maxBuffer, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) throw new Error(`Claude Code ${args.join(' ')} probe failed`);
  return String(result.stdout ?? '') + String(result.stderr ?? '');
}

function valueAfter(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
