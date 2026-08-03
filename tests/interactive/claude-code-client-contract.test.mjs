import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Claude Code stream-json uses verbose mode and reports missing results', async () => {
  const source = await readFile(new URL('../../apps/desktop/electron-main/claude-code-client.ts', import.meta.url), 'utf8');
  assert.match(source, /'--print', '--verbose', '--output-format', 'stream-json'/);
  assert.match(source, /receivedResult/);
  assert.match(source, /没有返回 Turn 结果/);
  for (const variable of [
    'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_EFFORT_LEVEL',
  ]) assert.match(source, new RegExp(variable));
});
