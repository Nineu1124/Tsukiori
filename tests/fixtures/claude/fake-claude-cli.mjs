import { appendFileSync, readFileSync } from 'node:fs';

const configPath = process.argv[2];
const args = process.argv.slice(3);
const config = JSON.parse(readFileSync(configPath, 'utf8'));

if (args.includes('--version')) {
  process.stdout.write(`${config.version ?? '2.1.226'} (Claude Code)\n`);
  process.exit(0);
}

if (args.includes('--help')) {
  process.stdout.write([
    '--output-format stream-json', '--resume', '--fork-session', '--include-hook-events',
    '--forward-subagent-text', '--mcp-config', '--disable-slash-commands', '--json-schema',
    '--permission-mode <mode> (choices: "acceptEdits", "manual", "dontAsk", "plan")',
  ].join('\n'));
  process.exit(0);
}

if (args[0] === 'auth' && args[1] === 'status') {
  process.stdout.write(JSON.stringify(config.auth ?? {
    loggedIn: true, authMethod: 'oauth_token', apiProvider: 'firstParty',
  }) + '\n');
  process.exit(0);
}

let inputBuffer = '';
let started = false;
let awaitingPermission = false;
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  inputBuffer += chunk;
  for (;;) {
    const newline = inputBuffer.indexOf('\n');
    if (newline < 0) break;
    const line = inputBuffer.slice(0, newline);
    inputBuffer = inputBuffer.slice(newline + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (!started && message.type === 'user') start(message);
    else if (awaitingPermission && message.type === 'control_response') finishPermission(message);
  }
});

function start(message) {
  started = true;
  prompt = Array.isArray(message?.message?.content)
    ? message.message.content.filter((block) => block?.type === 'text').map((block) => String(block.text ?? '')).join('')
    : '';
  appendFileSync(config.logPath, JSON.stringify({
    args,
    promptLength: prompt.length,
    inputType: message.type,
    parentToolUseId: message.parent_tool_use_id,
    apiKeyPresent: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
    providerEnvironmentKeys: [
      'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL',
      'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
      'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_EFFORT_LEVEL', 'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL',
      'AZURE_OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'OPENROUTER_API_KEY',
      'AWS_BEARER_TOKEN_BEDROCK', 'GOOGLE_APPLICATION_CREDENTIALS',
    ].filter((key) => Object.hasOwn(process.env, key)),
  }) + '\n');
  if (prompt.includes('fixture-fail')) {
    process.stderr.write('Bearer fixture-super-secret-value\n');
    process.exit(23);
  }
  if (prompt.includes('fixture-hang')) {
    setInterval(() => undefined, 1_000);
    return;
  }
  const sessionId = args.includes('--fork-session')
    ? (config.forkSessionId ?? '00000000-0000-4000-8000-000000000099')
    : valueAfter('--session-id') ?? valueAfter('--resume') ?? '00000000-0000-4000-8000-000000000000';
  emitPrelude(sessionId);
  if (prompt.includes('fixture-permission')) {
    awaitingPermission = true;
    write({
      type: 'control_request', request_id: 'permission:fixture',
      request: {
        subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 'tool:permission',
        input: { command: 'echo safe', api_key: 'must-not-reach-ui' },
        title: 'Run fixture command', description: 'Execute a harmless fixture command',
      },
    });
    return;
  }
  emitToolAndResult(sessionId, 'allow');
}

function finishPermission(message) {
  if (message?.response?.request_id !== 'permission:fixture') return;
  awaitingPermission = false;
  const behavior = message?.response?.response?.behavior;
  appendFileSync(config.logPath, JSON.stringify({
    permissionRequestId: message.response.request_id,
    permissionBehavior: behavior,
    updatedCommand: message?.response?.response?.updatedInput?.command,
  }) + '\n');
  const sessionId = args.includes('--fork-session')
    ? (config.forkSessionId ?? '00000000-0000-4000-8000-000000000099')
    : valueAfter('--session-id') ?? valueAfter('--resume') ?? '00000000-0000-4000-8000-000000000000';
  emitToolAndResult(sessionId, behavior);
}

function emitPrelude(sessionId) {
  write({
    type: 'system', subtype: 'init', session_id: sessionId, model: valueAfter('--model'),
    permissionMode: valueAfter('--permission-mode'), tools: ['Read', 'Edit'], mcp_servers: [{ name: 'fixture' }],
    claude_code_version: config.version ?? '2.1.226',
  });
  write({ type: 'stream_event', event: { type: 'message_start', message: { id: 'message:fixture' } } });
  write({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } });
  write({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'fixture thought' } } });
  write({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
  write({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } });
  write({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'fixture response' } } });
  write({ type: 'stream_event', event: { type: 'content_block_stop', index: 1 } });
}

function emitToolAndResult(sessionId, behavior) {
  if (behavior === 'deny') {
    write({ type: 'stream_event', event: { type: 'message_stop' } });
    write({ type: 'result', subtype: 'success', session_id: sessionId, is_error: false, total_cost_usd: 0, duration_ms: 3, num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 } });
    return;
  }
  write({ type: 'stream_event', event: { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tool:fixture', name: 'Read', input: { file_path: 'README.md' } } } });
  write({ type: 'stream_event', event: { type: 'content_block_stop', index: 2 } });
  write({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool:fixture', content: 'fixture result' }] } });
  write({ type: 'stream_event', event: { type: 'message_stop' } });
  write({ type: 'result', subtype: 'success', session_id: sessionId, is_error: false, total_cost_usd: 0, duration_ms: 3, num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 } });
}

function valueAfter(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function write(value) { process.stdout.write(JSON.stringify(value) + '\n'); }
