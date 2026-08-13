import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { ClaudeStreamJsonMapper } = await import(
  pathToFileURL(join(root, 'packages/adapter-claude/dist/index.js')).href
);

test('stream-json mapper projects rich Claude blocks without duplicating streamed text or tools', () => {
  const mapper = new ClaudeStreamJsonMapper();
  const events = [
    ...map(mapper, { type: 'system', subtype: 'init', session_id: 'session-1', model: 'sonnet', tools: ['Read'], mcp_servers: [{}] }),
    ...map(mapper, { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } } }),
    ...map(mapper, { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'reasoning' } } }),
    ...map(mapper, { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }),
    ...map(mapper, { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'hello' } } }),
    ...map(mapper, { type: 'stream_event', event: { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'README.md' } } } }),
    ...map(mapper, { type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }, { type: 'tool_use', id: 'tool-1', name: 'Read' }] } }),
    ...map(mapper, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'done' }] } }),
    ...map(mapper, { type: 'result', subtype: 'success', is_error: false, session_id: 'session-1', duration_ms: 10, total_cost_usd: 0 }),
  ];
  assert.equal(events.filter((event) => event.type === 'assistant.delta').length, 1);
  assert.equal(events.filter((event) => event.type === 'assistant.thinking.delta').length, 1);
  assert.equal(events.find((event) => event.type === 'assistant.thinking.delta').payload.index, 0);
  assert.equal(events.filter((event) => event.type === 'assistant.thinking.completed').length, 1);
  assert.deepEqual(events.filter((event) => event.type === 'tool.event').map((event) => event.payload.phase), ['started', 'completed']);
  assert.deepEqual(events.filter((event) => event.type === 'tool.event').map((event) => event.payload.tool), ['Read', 'Read']);
  assert.equal(events.at(-1).type, 'turn.completed');
  assert.equal(events.at(-1).payload.status, 'completed');
  assert.equal(mapper.sawResult, true);
});

test('invalid, oversized, unknown, and secret-bearing messages remain bounded and redacted', () => {
  const mapper = new ClaudeStreamJsonMapper({ maxLineBytes: 128, maxPayloadBytes: 128 });
  assert.equal(mapper.mapLine('{bad json')[0].payload.reason, 'invalid_json');
  assert.equal(mapper.mapLine(JSON.stringify({ type: 'unknown', data: 'x'.repeat(256) }))[0].payload.reason, 'line_too_large');
  const safe = new ClaudeStreamJsonMapper().mapLine(JSON.stringify({
    type: 'future_event', api_key: 'secret-value', message: 'Bearer fixture-super-secret-value',
  }))[0];
  assert.equal(safe.type, 'native.event');
  assert.doesNotMatch(JSON.stringify(safe), /secret-value|fixture-super-secret-value/);
  assert.match(JSON.stringify(safe), /REDACTED/);

  const subagent = new ClaudeStreamJsonMapper().mapLine(JSON.stringify({
    type: 'subagent_start', agent_id: 'agent-safe', parent_tool_use_id: 'tool-parent', status: 'running',
    prompt: 'must-not-enter-activity', transcript_path: 'C:\\private\\transcript.jsonl',
    message: { text: 'must-not-enter-activity' },
  }))[0];
  assert.equal(subagent.type, 'subagent.event');
  assert.deepEqual(subagent.payload, {
    schemaVersion: 1, runtimeEventType: 'subagent_start', runtimeSubagentId: 'agent-safe',
    parentToolUseId: 'tool-parent', status: 'running',
  });
  assert.doesNotMatch(JSON.stringify(subagent), /must-not-enter|private|transcript_path|prompt/);
});

function map(mapper, value) { return mapper.mapLine(JSON.stringify(value)); }
