import type { Message } from '@earendil-works/pi-ai/compat';
import { ApiRuntimeError } from './api-runtime-error.js';

// No provider tokenizer is available here. UTF-8 bytes plus framing overhead
// deliberately overestimate ordinary text; the provider remains authoritative.
export function selectApiContext(history: readonly Message[], contextWindow: number, outputTokens: number) {
  if (!Number.isSafeInteger(contextWindow) || !Number.isSafeInteger(outputTokens)
    || contextWindow <= 0 || outputTokens <= 0 || outputTokens > contextWindow) {
    throw new ApiRuntimeError('invalid_configuration');
  }
  const inputBudget = Math.max(0, contextWindow - outputTokens - 128);
  const costs = history.map((message) => Buffer.byteLength(JSON.stringify({ role: message.role, content: message.content }), 'utf8') + 16);
  const starts = history.flatMap((message, index) => message.role === 'user' ? [index] : []);
  let start = history.length;
  let estimatedTokens = 0;
  for (let i = starts.length - 1; i >= 0; i -= 1) {
    const candidate = starts[i] as number;
    const cost = costs.slice(candidate, start).reduce((sum, value) => sum + value, 0);
    if (estimatedTokens + cost > inputBudget) break;
    start = candidate;
    estimatedTokens += cost;
  }
  const rejected = history.length > 0 && start === history.length;
  return {
    messages: history.slice(start),
    summary: {
      policy: 'newest_complete_exchanges', estimator: 'utf8_bytes_plus_framing',
      contextWindow, reservedOutputTokens: outputTokens, reservedFramingTokens: 128, inputBudget,
      originalMessages: history.length, selectedMessages: history.length - start, droppedMessages: start,
      estimatedTokens, status: rejected ? 'rejected' : 'ready',
    },
  };
}
