import { createHash } from 'node:crypto';

const variable = process.argv[2];
const expectedHash = process.argv[3];
const forbiddenVariables = process.argv.slice(4);
const value = variable ? process.env[variable] : undefined;
const actualHash = typeof value === 'string'
  ? createHash('sha256').update(value).digest('hex')
  : '';
process.stdout.write(JSON.stringify({
  match: actualHash === expectedHash,
  received: typeof value === 'string',
  forbiddenReceived: forbiddenVariables.some((name) => typeof process.env[name] === 'string'),
}));
