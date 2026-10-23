import type { RuntimeType, PermissionMode } from './workspace-types.js';
import type { ProviderConfig, ProviderKind } from './provider-registry.js';

export function assertProviderCompatibility(runtime: RuntimeType, kind: ProviderKind): void {
  const allowed: ProviderKind[] = runtime === 'codex'
    ? ['chatgpt', 'openai', 'openai-compatible']
    : runtime === 'claude'
      ? ['claude-native', 'anthropic', 'deepseek', 'anthropic-compatible']
      : ['openai', 'anthropic', 'deepseek', 'google', 'openrouter', 'xai', 'groq', 'mistral',
          'cerebras', 'together', 'zai', 'moonshot', 'minimax', 'fireworks', 'kimi',
          'openai-compatible', 'anthropic-compatible'];
  if (!allowed.includes(kind)) {
    const name = runtime === 'codex' ? 'Codex' : runtime === 'claude' ? 'Claude Code' : 'Direct API';
    throw new Error(`${name} 不支持 ${kind} Provider`);
  }
}

export function compatibleDefaultProvider(runtime: RuntimeType, preferred: string): string {
  if (runtime === 'codex') return preferred.startsWith('provider:') ? preferred : 'provider:chatgpt';
  if (runtime === 'claude') return ['provider:claude-native', 'provider:anthropic', 'provider:deepseek'].includes(preferred)
    ? preferred : 'provider:claude-native';
  return !['provider:chatgpt', 'provider:claude-native'].includes(preferred) ? preferred : 'provider:openai';
}

export function defaultPermission(runtime: RuntimeType): PermissionMode { return runtime === 'claude' ? 'plan' : 'manual'; }

export function permissionMode(value: string): PermissionMode {
  if (['manual', 'plan', 'acceptEdits', 'dontAsk'].includes(value)) return value as PermissionMode;
  throw new Error('Permission Mode 无效');
}

export function providerNeedsSecret(provider: ProviderConfig): boolean {
  return provider.kind !== 'chatgpt' && provider.kind !== 'claude-native';
}

export function safeModel(value: string): string {
  const model = String(value ?? '').trim();
  if (!model || model.length > 128 || /[\r\n\0]/.test(model)) throw new Error('Model 无效');
  return model;
}
