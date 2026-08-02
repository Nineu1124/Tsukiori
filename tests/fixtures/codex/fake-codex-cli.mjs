import { readFileSync, writeFileSync } from 'node:fs';
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
let lastClientResponse = null;
let threadSerial = 0;
let turnSerial = 0;
function send(value) { process.stdout.write(JSON.stringify(value) + '\n'); }
input.on('line', (line) => {
  const message = JSON.parse(line);
  if (!message.method) {
    lastClientResponse = message;
    return;
  }
  if ((config.failCapabilityMethods ?? []).includes(message.method)) {
    process.stdout.write(JSON.stringify({
      id: message.id,
      error: { code: -32601, message: 'fixture method unavailable' },
    }) + '\n');
    return;
  }
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
  if (message.method === 'config/read') {
    process.stdout.write(JSON.stringify({
      id: message.id,
      result: {
        config: {
          sandbox_mode: config.sandboxMode ?? 'workspace-write',
          approval_policy: config.approvalPolicy ?? 'on-request',
        },
        origins: { sandbox_mode: { name: { type: 'user' }, version: 'fixture' } },
        layers: [{ name: { type: 'user' }, version: 'fixture', config: {} }],
      },
    }) + '\n');
    return;
  }
  if (message.method === 'skills/list') {
    process.stdout.write(JSON.stringify({
      id: message.id,
      result: {
        data: [{
          cwd: 'C:\\fixture',
          errors: Array.from({ length: config.skillErrors ?? 0 }, (_, index) => ({
            path: 'C:\\fixture\\skill-' + index,
            message: 'fixture parse error',
          })),
          skills: [
            {
              name: 'fixture-enabled',
              description: 'sanitized fixture',
              enabled: true,
              path: 'C:\\fixture\\enabled\\SKILL.md',
              scope: 'repo',
            },
            {
              name: 'fixture-disabled',
              description: 'sanitized fixture',
              enabled: false,
              path: 'C:\\fixture\\disabled\\SKILL.md',
              scope: 'user',
            },
          ],
        }],
      },
    }) + '\n');
    return;
  }
  if (message.method === 'mcpServerStatus/list') {
    const data = config.mcpServerCount === 0 ? [] : [{
      name: 'fixture-mcp',
      authStatus: config.mcpAuthStatus ?? 'oAuth',
      tools: { read_fixture: { name: 'read_fixture', inputSchema: {} } },
      resources: [],
      resourceTemplates: [],
    }];
    process.stdout.write(JSON.stringify({ id: message.id, result: { data, nextCursor: null } }) + '\n');
    return;
  }
  if (message.method === 'windowsSandbox/readiness') {
    process.stdout.write(JSON.stringify({
      id: message.id,
      result: { status: config.sandboxReadiness ?? 'ready' },
    }) + '\n');
    return;
  }
  if (message.method === 'thread/start') {
    const threadId = 'codex-thread-' + ++threadSerial;
    send({ id: message.id, result: { thread: { id: threadId } } });
    send({ method: 'thread/started', params: { thread: { id: threadId } } });
    return;
  }
  if (message.method === 'thread/resume') {
    const threadId = message.params?.threadId;
    send({ id: message.id, result: { thread: { id: threadId } } });
    return;
  }
  if (message.method === 'turn/start') {
    const threadId = message.params?.threadId;
    const turnId = 'codex-turn-' + ++turnSerial;
    send({ id: message.id, result: { turn: { id: turnId } } });
    setTimeout(() => {
      send({ method: 'turn/started', params: { threadId, turn: { id: turnId, status: 'inProgress' } } });
      send({ method: 'item/started', params: {
        threadId, turnId, item: { id: 'codex-item-' + turnId, type: 'agentMessage' },
      } });
      if (config.writeFixtureFile) {
        writeFileSync(config.fixtureFileName ?? 'codex-runtime.txt', 'sanitized fake Codex change\n', 'utf8');
      }
      send({ method: 'item/completed', params: {
        threadId, turnId, item: { id: 'codex-item-' + turnId, type: 'agentMessage' },
      } });
      send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } });
    }, config.turnDelayMs ?? 5);
    return;
  }
  if (message.method === 'fixture/crash') {
    process.exit(config.crashCode ?? 23);
  }
  if (message.method === 'fixture/emit-notification') {
    process.stdout.write(JSON.stringify({ id: message.id, result: { emitted: true } }) + '\n');
    process.stdout.write(JSON.stringify(message.params.notification) + '\n');
    return;
  }
  if (message.method === 'fixture/emit-server-request') {
    process.stdout.write(JSON.stringify({ id: message.id, result: { emitted: true } }) + '\n');
    process.stdout.write(JSON.stringify(message.params.request) + '\n');
    return;
  }
  if (message.method === 'fixture/read-client-response') {
    process.stdout.write(JSON.stringify({ id: message.id, result: lastClientResponse }) + '\n');
  }
});
input.on('close', () => process.exit(0));
