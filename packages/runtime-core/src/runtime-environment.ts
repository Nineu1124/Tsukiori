export const RUNTIME_PROVIDER_ENVIRONMENT_KEYS = Object.freeze([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_EFFORT_LEVEL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'OPENAI_ORG_ID',
  'OPENAI_ORGANIZATION',
  'OPENAI_PROJECT',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_ENDPOINT',
  'AZURE_OPENAI_DEPLOYMENT',
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_BASE_URL',
  'DEEPSEEK_MODEL',
  'OPENROUTER_API_KEY',
  'OPENROUTER_BASE_URL',
  'OPENROUTER_MODEL',
  'AWS_BEARER_TOKEN_BEDROCK',
  'GOOGLE_APPLICATION_CREDENTIALS',
] as const);

export type RuntimeProviderEnvironmentKey = typeof RUNTIME_PROVIDER_ENVIRONMENT_KEYS[number];

export function isolateRuntimeEnvironment(
  base: Readonly<NodeJS.ProcessEnv>,
  additions: Readonly<Record<string, string>> | undefined,
  allowedAdditions: readonly RuntimeProviderEnvironmentKey[],
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...base };
  for (const key of RUNTIME_PROVIDER_ENVIRONMENT_KEYS) delete environment[key];
  const allowed = new Set<string>(allowedAdditions);
  for (const [key, value] of Object.entries(additions ?? {})) {
    if (!allowed.has(key)) throw new Error('runtime_provider_environment_key_not_allowed:' + key);
    if (!value || value.length > 8_192 || /[\r\n\0]/.test(value)) {
      throw new Error('runtime_provider_environment_value_invalid:' + key);
    }
    environment[key] = value;
  }
  environment.NO_COLOR = '1';
  environment.GIT_TERMINAL_PROMPT = '0';
  return environment;
}
