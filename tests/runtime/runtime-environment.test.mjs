import assert from 'node:assert/strict';
import test from 'node:test';

const { RUNTIME_PROVIDER_ENVIRONMENT_KEYS, isolateRuntimeEnvironment } = await import(
  new URL('../../packages/runtime-core/dist/index.js', import.meta.url)
);
const { buildClaudeRuntimeEnvironment } = await import(
  new URL('../../packages/adapter-claude/dist/index.js', import.meta.url)
);
const { buildCodexRuntimeEnvironment } = await import(
  new URL('../../apps/desktop/dist/electron-main/codex-app-server-client.js', import.meta.url)
);

const contaminated = Object.fromEntries(RUNTIME_PROVIDER_ENVIRONMENT_KEYS.map((key) => [key, 'stale-' + key]));
contaminated.PATH = 'fixture-path';
contaminated.TSUKIORI_SAFE_MARKER = 'preserved';

test('shared Runtime environment policy removes every inherited Provider selector', () => {
  const environment = isolateRuntimeEnvironment(contaminated, { OPENAI_API_KEY: 'selected-codex-key' }, ['OPENAI_API_KEY']);
  assert.equal(environment.OPENAI_API_KEY, 'selected-codex-key');
  for (const key of RUNTIME_PROVIDER_ENVIRONMENT_KEYS) {
    if (key !== 'OPENAI_API_KEY') assert.equal(Object.hasOwn(environment, key), false, key);
  }
  assert.equal(environment.TSUKIORI_SAFE_MARKER, 'preserved');
  assert.equal(environment.NO_COLOR, '1');
  assert.equal(environment.GIT_TERMINAL_PROMPT, '0');
});

test('Claude native and Provider launches isolate inherited and previous Provider state', () => {
  const native = buildClaudeRuntimeEnvironment({ ANTHROPIC_API_KEY: 'must-not-enter-native' }, 'native', contaminated);
  assert.deepEqual(RUNTIME_PROVIDER_ENVIRONMENT_KEYS.filter((key) => Object.hasOwn(native, key)), []);
  const provider = buildClaudeRuntimeEnvironment({
    ANTHROPIC_AUTH_TOKEN: 'selected-deepseek-key',
    ANTHROPIC_BASE_URL: 'https://api.deepseek.example.invalid/anthropic',
    ANTHROPIC_MODEL: 'deepseek-fixture[1m]',
    CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-fixture-flash',
  }, 'provider', contaminated);
  assert.deepEqual(RUNTIME_PROVIDER_ENVIRONMENT_KEYS.filter((key) => Object.hasOwn(provider, key)), [
    'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL',
    'CLAUDE_CODE_SUBAGENT_MODEL',
  ]);
  assert.equal(Object.hasOwn(provider, 'CLAUDE_CODE_EFFORT_LEVEL'), false);
  assert.equal(Object.hasOwn(provider, 'OPENAI_API_KEY'), false);
  assert.throws(
    () => buildClaudeRuntimeEnvironment({ CLAUDE_CODE_EFFORT_LEVEL: 'max' }, 'provider', contaminated),
    /runtime_provider_environment_key_not_allowed:CLAUDE_CODE_EFFORT_LEVEL/,
  );
});

test('Codex launch accepts only its selected key and rejects unexpected additions', () => {
  const environment = buildCodexRuntimeEnvironment({ OPENAI_API_KEY: 'selected-openai-key' }, contaminated);
  assert.deepEqual(RUNTIME_PROVIDER_ENVIRONMENT_KEYS.filter((key) => Object.hasOwn(environment, key)), ['OPENAI_API_KEY']);
  assert.throws(
    () => buildCodexRuntimeEnvironment({ ANTHROPIC_API_KEY: 'cross-runtime-key' }, contaminated),
    /runtime_provider_environment_key_not_allowed:ANTHROPIC_API_KEY/,
  );
  assert.throws(
    () => buildClaudeRuntimeEnvironment({ OPENAI_API_KEY: 'cross-runtime-key' }, 'provider', contaminated),
    /runtime_provider_environment_key_not_allowed:OPENAI_API_KEY/,
  );
});
