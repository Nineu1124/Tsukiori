import assert from 'node:assert/strict';
import test from 'node:test';
import { selectApiContext } from '../../apps/desktop/dist/electron-main/api-context-budget.js';
import { ApiRuntimeClient } from '../../apps/desktop/dist/electron-main/api-runtime.js';
import { assistant } from './history-fixture.mjs';

const user = (content) => ({ role: 'user', content, timestamp: 1 });

test('budget keeps a contiguous suffix of whole exchanges without changing stored messages', () => {
  const history = [user('old '.repeat(300)), assistant('older answer'), user('middle'), assistant('middle answer'), user('latest')];
  const before = structuredClone(history);
  const result = selectApiContext(history, 1_000, 200);
  assert.deepEqual(result.messages, history.slice(2));
  assert.deepEqual(history, before);
  assert.equal(result.summary.droppedMessages, 2);
  assert.equal(result.summary.estimatedTokens <= result.summary.inputBudget, true);
  assert.equal(result.messages[0].role, 'user');
  assert.equal(result.messages.at(-1).content, 'latest');
});

test('budget counts Unicode bytes, rejects oversized latest messages, and validates capacities', () => {
  const ascii = selectApiContext([user('a'.repeat(100))], 1_000, 100);
  const chinese = selectApiContext([user('中'.repeat(100))], 1_000, 100);
  assert.equal(chinese.summary.estimatedTokens - ascii.summary.estimatedTokens, 200);
  assert.equal(selectApiContext([user('中'.repeat(400))], 1_000, 100).summary.status, 'rejected');
  for (const capacity of [NaN, Infinity, 0, -1, 1.5]) {
    assert.throws(() => selectApiContext([], capacity, 1), { category: 'invalid_configuration' });
  }
  assert.equal(selectApiContext([assistant(), user('latest')], 1_000, 100).summary.droppedMessages, 1);
});

test('runtime emits content-free budget evidence before refusing an oversized request', async () => {
  let calls = 0;
  const events = [];
  const client = new ApiRuntimeClient({ stream() { calls += 1; throw new Error('must not call'); } });
  await assert.rejects(client.runTurn({ turnId: 'budget-fixture',
    provider: { id: 'fixture', kind: 'openai-compatible', apiFormat: 'openai-completions', baseUrl: 'https://example.invalid',
      contextWindow: 1_000, maxTokens: 100, models: ['fixture'] },
    modelId: 'fixture', apiKey: 'fixture-secret', history: [user('private-body '.repeat(300))],
    signal: new AbortController().signal,
    callbacks: { onEvent: (type, payload) => events.push({ type, payload }) },
  }), { category: 'context_window_exceeded' });
  assert.equal(calls, 0);
  assert.equal(events[0].type, 'context.budget');
  assert.equal(events[0].payload.status, 'rejected');
  assert.doesNotMatch(JSON.stringify(events), /private-body|fixture-secret/);
});
