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
const eventStreams = new Set();
let eventSerial = 0;
let disconnectedFirstEventStream = false;

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
function event(type, properties) {
  return { id: 'event-fixture-' + ++eventSerial, type, properties };
}
function publish(payload) {
  const envelope = JSON.stringify({ directory: process.cwd(), payload });
  for (const response of eventStreams) response.write('data: ' + envelope + '\n\n');
}
function completeSession(session) {
  session.messages = [
    { info: { id: 'message-user', role: 'user' }, parts: [] },
    { info: { id: 'message-assistant', role: 'assistant' }, parts: [] },
  ];
  publish(event('message.updated', {
    sessionID: session.id,
    info: {
      id: 'message-assistant', sessionID: session.id, role: 'assistant', finish: 'stop',
      time: { created: Date.now(), completed: Date.now() },
    },
  }));
  session.status = 'idle';
  publish(event('session.idle', { sessionID: session.id }));
}
function openEventStream(request, response) {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  response.flushHeaders();
  eventStreams.add(response);
  const close = () => eventStreams.delete(response);
  request.once('close', close);
  response.once('close', close);
  response.write('data: ' + JSON.stringify({
    directory: process.cwd(),
    payload: event('server.connected', {}),
  }) + '\n\n');
  if (config.disconnectFirstEventStream && !disconnectedFirstEventStream) {
    disconnectedFirstEventStream = true;
    setTimeout(() => response.end(), 20);
  }
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
  if (request.method === 'GET' && url.pathname === '/global/event') {
    openEventStream(request, response);
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
          id: 'dpsk', name: 'DeepSeek Fixture', source: 'config', env: [],
          api: 'https://api.deepseek.com/v1', options: {},
          models: {
            'deepseek-v4-flash': {
              id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash',
              status: 'active', experimental: false,
            },
          },
        },
        {
          id: 'offline', name: 'Offline Fixture', source: 'custom', env: [], options: {},
          models: { local: { id: 'local', name: 'Local' } },
        },
      ],
      connected: config.connectedProviders ?? ['dpsk'],
      default: { dpsk: 'deepseek-v4-flash' },
    });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/session/status') {
    send(response, 200, Object.fromEntries(
      [...sessions.entries()].map(([id, session]) => [id, { type: session.status }]),
    ));
    return;
  }
  if (request.method === 'POST' && url.pathname === '/session') {
    const input = await body(request);
    const id = 'session-fixture-' + (sessions.size + 1);
    const session = {
      id, title: input.title, input, messages: [], status: 'idle',
      promptCount: 0, pendingPermission: null,
    };
    sessions.set(id, session);
    publish(event('session.created', { sessionID: id, info: { id, title: input.title } }));
    send(response, 200, { id, title: input.title });
    return;
  }
  const sessionMatch = url.pathname.match(/^\/session\/([^/]+)$/);
  if (request.method === 'GET' && sessionMatch) {
    const session = sessions.get(sessionMatch[1]);
    if (!session) {
      send(response, 404, { error: 'missing' });
      return;
    }
    send(response, 200, { id: session.id, title: session.title });
    return;
  }
  if (request.method === 'DELETE' && sessionMatch) {
    const existed = sessions.delete(sessionMatch[1]);
    if (existed) publish(event('session.deleted', { sessionID: sessionMatch[1] }));
    send(response, 200, existed);
    return;
  }
  const abortMatch = url.pathname.match(/^\/session\/([^/]+)\/abort$/);
  if (request.method === 'POST' && abortMatch) {
    const session = sessions.get(abortMatch[1]);
    if (!session) {
      send(response, 404, { error: 'missing' });
      return;
    }
    session.status = 'idle';
    session.pendingPermission = null;
    publish(event('session.idle', { sessionID: session.id }));
    send(response, 200, true);
    return;
  }
  const permissionReplyMatch = url.pathname.match(/^\/permission\/([^/]+)\/reply$/);
  if (request.method === 'POST' && permissionReplyMatch) {
    const input = await body(request);
    const session = [...sessions.values()].find(
      (item) => item.pendingPermission === permissionReplyMatch[1],
    );
    if (!session) {
      send(response, 404, { error: 'missing' });
      return;
    }
    publish(event('permission.replied', {
      sessionID: session.id,
      requestID: permissionReplyMatch[1],
      reply: input.reply ?? 'reject',
    }));
    session.pendingPermission = null;
    completeSession(session);
    send(response, 200, true);
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
    session.promptCount += 1;
    session.status = 'busy';
    publish(event('session.status', { sessionID: session.id, status: { type: 'busy' } }));
    if (config.crashOnMarkedSession && String(session.title).includes('CRASH')) {
      setImmediate(() => process.exit(23));
      return;
    }
    if (config.emitSessionError) {
      session.status = 'idle';
      publish(event('session.error', {
        sessionID: session.id,
        error: { name: 'FixtureError', message: '<sanitized>' },
      }));
      send(response, 204, '');
      return;
    }
    publish(event('message.updated', {
      sessionID: session.id,
      info: { id: 'message-assistant-' + eventSerial, sessionID: session.id, role: 'assistant', time: { created: Date.now() } },
    }));
    publish(event('message.part.delta', {
      sessionID: session.id, messageID: 'message-assistant', partID: 'part-text', field: 'text', delta: 'fixture-delta',
    }));
    publish(event('message.part.updated', {
      sessionID: session.id, time: Date.now(),
      part: { id: 'part-tool', sessionID: session.id, messageID: 'message-assistant', type: 'tool', tool: 'fixture', state: { status: 'pending' } },
    }));
    publish(event('message.part.updated', {
      sessionID: session.id, time: Date.now(),
      part: { id: 'part-tool', sessionID: session.id, messageID: 'message-assistant', type: 'tool', tool: 'fixture', state: { status: 'completed' } },
    }));
    if (config.holdFirstTurn && session.promptCount === 1) {
      send(response, 204, '');
      return;
    }
    if (config.emitPermissionFlow || config.holdPermission) {
      session.pendingPermission = 'permission-fixture-' + session.id;
      publish(event('permission.asked', {
        id: session.pendingPermission,
        sessionID: session.id,
        permission: 'bash',
        patterns: ['<sanitized>'],
        metadata: {},
        always: [],
      }));
      if (config.holdPermission) {
        send(response, 204, '');
        return;
      }
      publish(event('permission.replied', {
        sessionID: session.id,
        requestID: session.pendingPermission,
        reply: 'once',
      }));
      session.pendingPermission = null;
    }
    session.lastPromptShape = {
      providerID: input.model?.providerID,
      modelID: input.model?.modelID,
      partCount: Array.isArray(input.parts) ? input.parts.length : 0,
    };
    completeSession(session);
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
  process.stdout.write('opencode server listening on http://127.0.0.1:' + address.port + '\n');
});
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    for (const response of eventStreams) response.end();
    eventStreams.clear();
    server.close(() => process.exit(0));
  });
}