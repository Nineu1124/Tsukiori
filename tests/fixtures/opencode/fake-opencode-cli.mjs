import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const configPath = process.argv[2];
if (!configPath) process.exit(2);
const config = JSON.parse(readFileSync(configPath, 'utf8'));

if (process.argv.includes('--version')) {
  process.stdout.write('opencode ' + config.version + '\n');
  process.exit(0);
}
if (process.argv.includes('auth') && process.argv.includes('list')) {
  process.stdout.write('Credentials\n' + (config.credentialCount ?? 1) + ' credentials\n');
  process.exit(0);
}
if (!process.argv.includes('serve')) process.exit(3);

const sessions = new Map();
function send(response, status, value, contentType = 'application/json') {
  response.writeHead(status, { 'content-type': contentType });
  response.end(typeof value === 'string' ? value : JSON.stringify(value));
}
async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function authorized(request) {
  const expected = 'Basic ' + Buffer.from(
    (process.env.OPENCODE_SERVER_USERNAME ?? 'opencode')
      + ':' + (process.env.OPENCODE_SERVER_PASSWORD ?? ''),
  ).toString('base64');
  return request.headers.authorization === expected;
}

const server = createServer(async (request, response) => {
  if (!authorized(request)) {
    send(response, 401, { error: 'unauthorized' });
    return;
  }
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (request.method === 'GET' && url.pathname === '/doc') {
    send(response, 200, config.docBody, config.docContentType ?? 'application/json');
    return;
  }
  if (request.method === 'GET' && url.pathname === '/global/health') {
    send(response, 200, { healthy: true, version: config.version });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/path') {
    send(response, 200, {
      directory: config.wrongWorkspace ?? url.searchParams.get('directory'),
    });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/vcs') {
    send(response, 200, { branch: 'fixture', worktree: true });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/provider') {
    send(response, 200, {
      all: [
        {
          id: 'dpsk',
          name: 'DeepSeek Fixture',
          source: 'config',
          env: [],
          api: 'https://api.deepseek.com/v1',
          options: {},
          models: {
            'deepseek-v4-flash': {
              id: 'deepseek-v4-flash',
              name: 'DeepSeek V4 Flash',
              status: 'active',
              experimental: false,
            },
          },
        },
        {
          id: 'offline',
          name: 'Offline Fixture',
          source: 'custom',
          env: [],
          options: {},
          models: { local: { id: 'local', name: 'Local' } },
        },
      ],
      connected: config.connectedProviders ?? ['dpsk'],
      default: { dpsk: 'deepseek-v4-flash' },
    });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/session') {
    const input = await body(request);
    const id = 'session-fixture-' + (sessions.size + 1);
    sessions.set(id, { input, messages: [] });
    send(response, 200, { id, title: input.title });
    return;
  }
  const sessionMatch = url.pathname.match(/^\/session\/([^/]+)$/);
  if (request.method === 'DELETE' && sessionMatch) {
    send(response, 200, sessions.delete(sessionMatch[1]));
    return;
  }
  const promptMatch = url.pathname.match(/^\/session\/([^/]+)\/prompt_async$/);
  if (request.method === 'POST' && promptMatch) {
    const input = await body(request);
    const session = sessions.get(promptMatch[1]);
    if (!session) {
      send(response, 404, { error: 'missing' });
      return;
    }
    session.messages = [
      { info: { id: 'message-user', role: 'user' }, parts: [] },
      { info: { id: 'message-assistant', role: 'assistant' }, parts: [] },
    ];
    session.lastPromptShape = {
      providerID: input.model?.providerID,
      modelID: input.model?.modelID,
      partCount: Array.isArray(input.parts) ? input.parts.length : 0,
    };
    send(response, 204, '');
    return;
  }
  const messagesMatch = url.pathname.match(/^\/session\/([^/]+)\/message$/);
  if (request.method === 'GET' && messagesMatch) {
    send(response, 200, sessions.get(messagesMatch[1])?.messages ?? []);
    return;
  }
  send(response, 404, { error: 'not found' });
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  process.stdout.write(
    'opencode server listening on http://127.0.0.1:' + address.port + '\n',
  );
});
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}