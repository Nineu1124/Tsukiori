import { randomUUID } from 'node:crypto';
import { WindowsCredentialBroker, type SecretReference } from '@tsukiori/credential-broker';
import type { ProviderVerificationAuditSink } from './provider-verification-audit.js';
import { providerCatalogModels, verifyApiProvider } from './api-runtime.js';

export type ProviderKind =
  | 'chatgpt'
  | 'claude-native'
  | 'openai'
  | 'anthropic'
  | 'deepseek'
  | 'google'
  | 'openrouter'
  | 'xai'
  | 'groq'
  | 'mistral'
  | 'cerebras'
  | 'together'
  | 'zai'
  | 'moonshot'
  | 'minimax'
  | 'fireworks'
  | 'kimi'
  | 'openai-compatible'
  | 'anthropic-compatible';

export type ApiProtocol =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'google-generative-ai'
  | 'mistral-conversations';

export type ProviderApiFormat = ApiProtocol | 'chatgpt' | 'claude-native';

export type ProviderConfig = {
  id: string;
  name: string;
  kind: ProviderKind;
  apiFormat: ProviderApiFormat;
  baseUrl: string;
  models: string[];
  contextWindow: number;
  maxTokens: number;
  secretRef?: SecretReference;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastTest?: {
    ok: boolean;
    latencyMs: number;
    category: string;
    testedAt: number;
    auditStatus?: 'recorded' | 'degraded' | 'not_configured';
    auditCategory?: 'audit_write_failed';
  };
};

export type ProviderView = Omit<ProviderConfig, 'secretRef'> & { hasSecret: boolean };

export type ProviderInput = {
  id?: string;
  name: string;
  kind: ProviderKind;
  apiFormat?: ApiProtocol;
  baseUrl?: string;
  models?: readonly string[];
  contextWindow?: number;
  maxTokens?: number;
  apiKey?: string;
  enabled?: boolean;
};

const defaults: Record<ProviderKind, Pick<ProviderConfig, 'apiFormat' | 'baseUrl' | 'models' | 'contextWindow' | 'maxTokens'>> = {
  chatgpt: { apiFormat: 'chatgpt', baseUrl: 'https://chatgpt.com/backend-api', models: ['auto'], contextWindow: 128_000, maxTokens: 16_384 },
  'claude-native': { apiFormat: 'claude-native', baseUrl: '', models: ['sonnet', 'opus'], contextWindow: 200_000, maxTokens: 32_768 },
  openai: { apiFormat: 'openai-responses', baseUrl: 'https://api.openai.com', models: ['gpt-5.4', 'gpt-5.4-mini'], contextWindow: 1_000_000, maxTokens: 128_000 },
  anthropic: { apiFormat: 'anthropic-messages', baseUrl: 'https://api.anthropic.com', models: ['claude-sonnet-4-6', 'claude-opus-4-6'], contextWindow: 200_000, maxTokens: 64_000 },
  deepseek: { apiFormat: 'openai-completions', baseUrl: 'https://api.deepseek.com', models: ['deepseek-v4-pro', 'deepseek-v4-flash'], contextWindow: 1_000_000, maxTokens: 256_000 },
  google: { apiFormat: 'google-generative-ai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', models: ['gemini-3.1-pro-preview', 'gemini-3.5-flash'], contextWindow: 1_000_000, maxTokens: 65_536 },
  openrouter: { apiFormat: 'openai-completions', baseUrl: 'https://openrouter.ai/api/v1', models: ['openrouter/auto', 'openrouter/free'], contextWindow: 262_144, maxTokens: 32_768 },
  xai: { apiFormat: 'openai-completions', baseUrl: 'https://api.x.ai/v1', models: ['grok-4.3', 'grok-build-0.1'], contextWindow: 256_000, maxTokens: 32_768 },
  groq: { apiFormat: 'openai-completions', baseUrl: 'https://api.groq.com/openai/v1', models: ['openai/gpt-oss-120b', 'qwen/qwen3-32b'], contextWindow: 131_072, maxTokens: 32_768 },
  mistral: { apiFormat: 'mistral-conversations', baseUrl: 'https://api.mistral.ai', models: ['codestral-latest', 'mistral-large-latest'], contextWindow: 262_144, maxTokens: 32_768 },
  cerebras: { apiFormat: 'openai-completions', baseUrl: 'https://api.cerebras.ai/v1', models: ['gpt-oss-120b', 'zai-glm-4.7'], contextWindow: 131_072, maxTokens: 32_768 },
  together: { apiFormat: 'openai-completions', baseUrl: 'https://api.together.ai/v1', models: ['deepseek-ai/DeepSeek-V4-Pro', 'openai/gpt-oss-120b'], contextWindow: 262_144, maxTokens: 32_768 },
  zai: { apiFormat: 'openai-completions', baseUrl: 'https://api.z.ai/api/coding/paas/v4', models: ['glm-5.2', 'glm-5-turbo'], contextWindow: 200_000, maxTokens: 32_768 },
  moonshot: { apiFormat: 'openai-completions', baseUrl: 'https://api.moonshot.ai/v1', models: ['kimi-k2.7-code', 'kimi-k2.6'], contextWindow: 262_144, maxTokens: 32_768 },
  minimax: { apiFormat: 'anthropic-messages', baseUrl: 'https://api.minimax.io/anthropic', models: ['MiniMax-M2.7', 'MiniMax-M3'], contextWindow: 204_800, maxTokens: 32_768 },
  fireworks: { apiFormat: 'openai-completions', baseUrl: 'https://api.fireworks.ai/inference/v1', models: ['accounts/fireworks/models/deepseek-v4-pro', 'accounts/fireworks/models/kimi-k2p7-code'], contextWindow: 262_144, maxTokens: 32_768 },
  kimi: { apiFormat: 'anthropic-messages', baseUrl: 'https://api.kimi.com/coding', models: ['kimi-for-coding', 'kimi-for-coding-highspeed'], contextWindow: 262_144, maxTokens: 32_768 },
  'openai-compatible': { apiFormat: 'openai-completions', baseUrl: '', models: [], contextWindow: 131_072, maxTokens: 8_192 },
  'anthropic-compatible': { apiFormat: 'anthropic-messages', baseUrl: '', models: [], contextWindow: 131_072, maxTokens: 8_192 },
};

export function builtInProviders(now = Date.now()): ProviderConfig[] {
  return [
    createBuiltIn('provider:chatgpt', 'ChatGPT 登录', 'chatgpt', now),
    createBuiltIn('provider:claude-native', 'Claude 本机登录', 'claude-native', now),
    createBuiltIn('provider:openai', 'OpenAI API', 'openai', now),
    createBuiltIn('provider:anthropic', 'Anthropic API', 'anthropic', now),
    createBuiltIn('provider:deepseek', 'DeepSeek', 'deepseek', now),
  ];
}

export class ProviderRegistry {
  readonly #credentials: WindowsCredentialBroker;
  readonly #persist: (providers: ProviderConfig[]) => void;
  readonly #audit: ProviderVerificationAuditSink | undefined;
  readonly #verify: typeof verifyApiProvider;
  readonly #now: () => number;
  readonly #id: () => string;
  #providers: ProviderConfig[];

  constructor(options: {
    providers?: readonly ProviderConfig[];
    credentials?: WindowsCredentialBroker;
    persist: (providers: ProviderConfig[]) => void;
    audit?: ProviderVerificationAuditSink;
    verify?: typeof verifyApiProvider;
    now?: () => number;
    id?: () => string;
  }) {
    this.#credentials = options.credentials ?? new WindowsCredentialBroker();
    this.#persist = options.persist;
    this.#audit = options.audit;
    this.#verify = options.verify ?? verifyApiProvider;
    this.#now = options.now ?? Date.now;
    this.#id = options.id ?? randomUUID;
    this.#providers = mergeBuiltIns(options.providers ?? []);
  }

  list(): ProviderView[] {
    return this.#providers.map(({ secretRef, ...provider }) => ({ ...provider, hasSecret: Boolean(secretRef) }));
  }

  raw(): ProviderConfig[] {
    return this.#providers.map((provider) => ({ ...provider, models: [...provider.models] }));
  }

  get(id: string): ProviderConfig {
    const provider = this.#providers.find((item) => item.id === id);
    if (!provider) throw new Error('Provider 不存在');
    return provider;
  }

  save(input: ProviderInput): ProviderView {
    const kind = providerKind(input.kind);
    const existing = input.id ? this.#providers.find((item) => item.id === input.id) : undefined;
    if (input.id && !existing) throw new Error('Provider 不存在');
    const id = existing?.id ?? 'provider:' + randomUUID();
    const name = cleanName(input.name);
    const preset = defaults[kind];
    const baseUrl = normalizeBaseUrl(input.baseUrl ?? existing?.baseUrl ?? preset.baseUrl, kind);
    const apiFormat = providerApiFormat(input.apiFormat ?? existing?.apiFormat, kind);
    const requestedModels = input.models ?? existing?.models ?? preset.models;
    const models = normalizeModels(requestedModels.length > 0 ? requestedModels : preset.models);
    if (kind !== 'chatgpt' && models.length === 0) throw new Error('至少配置一个 Model');
    const contextWindow = capacity(input.contextWindow ?? existing?.contextWindow ?? preset.contextWindow, 'Context Window');
    const maxTokens = capacity(input.maxTokens ?? existing?.maxTokens ?? preset.maxTokens, 'Max Tokens');
    if (maxTokens > contextWindow) throw new Error('Max Tokens 不能大于 Context Window');
    const at = this.#now();
    let secretRef = existing?.secretRef;
    const apiKey = input.apiKey?.trim();
    if (kind !== 'chatgpt' && kind !== 'claude-native' && apiKey) {
      secretRef = this.#credentials.store({
        secret: apiKey,
        ...(secretRef ? { reference: secretRef } : {}),
        binding: credentialBinding(id, kind),
      });
    }
    const provider: ProviderConfig = {
      id, name, kind, apiFormat, baseUrl, models, contextWindow, maxTokens,
      ...(secretRef ? { secretRef } : {}),
      enabled: input.enabled ?? existing?.enabled ?? true,
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
      ...(existing?.lastTest ? { lastTest: existing.lastTest } : {}),
    };
    if (existing) this.#providers = this.#providers.map((item) => item.id === id ? provider : item);
    else this.#providers.push(provider);
    this.#flush();
    return this.view(provider);
  }

  delete(id: string): void {
    if (id === 'provider:chatgpt' || id === 'provider:claude-native') throw new Error('Runtime 登录项不能删除');
    const provider = this.get(id);
    if (provider.secretRef) this.#credentials.delete(provider.secretRef);
    if (id.startsWith('provider:') && ['provider:openai', 'provider:anthropic', 'provider:deepseek'].includes(id)) {
      const reset = createBuiltIn(id, provider.name, provider.kind, provider.createdAt);
      this.#providers = this.#providers.map((item) => item.id === id ? reset : item);
    } else {
      this.#providers = this.#providers.filter((item) => item.id !== id);
    }
    this.#flush();
  }

  async test(id: string): Promise<{ ok: boolean; latencyMs: number; category: string }> {
    const provider = this.get(id);
    if (provider.kind === 'chatgpt' || provider.kind === 'claude-native') {
      return this.#completeTest(provider, { ok: false, latencyMs: 0, category: 'runtime_probe_required' });
    }
    if (!provider.secretRef) {
      return this.#completeTest(provider, { ok: false, latencyMs: 0, category: 'credential_required' });
    }
    const started = this.#now();
    let result: { ok: boolean; latencyMs: number; category: string };
    try {
      result = await this.withSecret(provider.id, async (secret) => {
        const verified = await this.#verify(provider, secret);
        return { ...verified, latencyMs: this.#now() - started };
      });
    } catch (error) {
      result = { ok: false, latencyMs: this.#now() - started, category: errorCategory(error) };
    }
    return this.#completeTest(provider, result);
  }

  recordTest(id: string, result: { ok: boolean; latencyMs: number; category: string }): void {
    const provider = this.get(id);
    this.#completeTest(provider, result);
  }

  async listModels(id: string): Promise<{ models: string[]; source: 'catalog' | 'remote' | 'configured' }> {
    const provider = this.get(id);
    const catalog = providerCatalogModels(provider.kind);
    if (catalog.length > 0) {
      return { models: normalizeModels(catalog.map((model) => model.id)), source: 'catalog' };
    }
    if (provider.kind === 'chatgpt' || provider.kind === 'claude-native' || provider.kind === 'anthropic-compatible') {
      return { models: [...provider.models], source: 'configured' };
    }
    if (!provider.secretRef) throw new Error('请先保存 API Key');
    return await this.withEnvironment(provider.id, async (environment) => {
      const token = environment.OPENAI_API_KEY ?? environment.ANTHROPIC_AUTH_TOKEN;
      if (!token) throw new Error('credential_unavailable');
      const endpoint = provider.baseUrl.replace(/\/+$/, '') + '/models';
      const response = await fetch(endpoint, {
        headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
        redirect: 'error', signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(httpCategory(response.status));
      }
      const length = Number(response.headers.get('content-length') ?? 0);
      if (length > 1024 * 1024) throw new Error('model_response_too_large');
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > 1024 * 1024) throw new Error('model_response_too_large');
      const value = JSON.parse(text) as Record<string, unknown>;
      const data = Array.isArray(value.data) ? value.data : [];
      const models = normalizeModels(data.map((item) => String((item as Record<string, unknown>)?.id ?? '')));
      if (models.length === 0) throw new Error('model_list_empty');
      return { models, source: 'remote' };
    });
  }

  withEnvironment<T>(id: string, consumer: (environment: Record<string, string>) => T, selectedModel?: string): T {
    const provider = this.get(id);
    const environment: Record<string, string> = {};
    if (provider.kind === 'claude-native') return consumer(environment);
    if (provider.apiFormat === 'anthropic-messages' || provider.kind === 'deepseek') {
      environment.ANTHROPIC_BASE_URL = provider.kind === 'deepseek'
        ? provider.baseUrl.replace(/\/+$/, '') + '/anthropic'
        : provider.baseUrl;
      environment.ANTHROPIC_MODEL = selectedModel ?? provider.models[0] ?? '';
    }
    if (provider.kind === 'deepseek') {
      const pro = deepSeekClaudeModel(selectedModel ?? provider.models.find((model) => model.includes('pro')) ?? 'deepseek-v4-pro');
      const flash = provider.models.find((model) => model.includes('flash')) ?? 'deepseek-v4-flash';
      environment.ANTHROPIC_MODEL = pro;
      environment.ANTHROPIC_DEFAULT_OPUS_MODEL = pro;
      environment.ANTHROPIC_DEFAULT_SONNET_MODEL = pro;
      environment.ANTHROPIC_DEFAULT_HAIKU_MODEL = flash;
      environment.CLAUDE_CODE_SUBAGENT_MODEL = flash;
    }
    if (!provider.secretRef) return consumer(environment);
    const binding = credentialBinding(provider.id, provider.kind);
    return this.#credentials.use(provider.secretRef, binding, (secret) => {
      environment[binding.environmentVariable] = secret;
      return consumer(environment);
    });
  }

  withSecret<T>(id: string, consumer: (secret: string) => T): T {
    const provider = this.get(id);
    if (!provider.secretRef) throw new Error('所选 Provider 尚未保存 API Key');
    return this.#credentials.use(provider.secretRef, credentialBinding(provider.id, provider.kind), consumer);
  }

  private view(provider: ProviderConfig): ProviderView {
    const { secretRef, ...safe } = provider;
    return { ...safe, hasSecret: Boolean(secretRef) };
  }

  #flush(): void {
    this.#persist(this.raw());
  }

  #completeTest(
    provider: ProviderConfig,
    input: { ok: boolean; latencyMs: number; category: string },
  ): { ok: boolean; latencyMs: number; category: string } {
    const result = {
      ok: input.ok === true,
      latencyMs: Math.max(0, Math.min(60_000, Math.round(Number(input.latencyMs) || 0))),
      category: auditCategory(input.category),
    };
    const testedAt = this.#now();
    let auditStatus: 'recorded' | 'degraded' | 'not_configured' = this.#audit ? 'recorded' : 'not_configured';
    let auditFailure = false;
    if (this.#audit) {
      try {
        this.#audit({
          schemaVersion: 1,
          id: 'provider-audit:' + this.#id(),
          action: 'provider_verify',
          providerId: provider.id,
          providerKind: provider.kind,
          outcome: result.ok ? 'succeeded' : 'failed',
          category: result.category,
          latencyMs: result.latencyMs,
          testedAt,
        });
      } catch {
        auditStatus = 'degraded';
        auditFailure = true;
      }
    }
    provider.lastTest = {
      ...result,
      testedAt,
      auditStatus,
      ...(auditFailure ? { auditCategory: 'audit_write_failed' as const } : {}),
    };
    provider.updatedAt = testedAt;
    this.#flush();
    return result;
  }
}

export function deepSeekClaudeModel(value: string): string {
  const model = String(value ?? '').trim();
  return model.includes('pro') && !model.endsWith('[1m]') ? model + '[1m]' : model;
}

function createBuiltIn(id: string, name: string, kind: ProviderKind, now: number): ProviderConfig {
  return { id, name, kind, ...defaults[kind], enabled: true, createdAt: now, updatedAt: now };
}

function mergeBuiltIns(providers: readonly ProviderConfig[]): ProviderConfig[] {
  const merged = providers.map((provider) => validatePersisted(provider));
  for (const builtIn of builtInProviders()) {
    if (!merged.some((item) => item.id === builtIn.id)) merged.push(builtIn);
  }
  return merged;
}

function validatePersisted(provider: ProviderConfig): ProviderConfig {
  const kind = providerKind(provider.kind);
  const preset = defaults[kind];
  const contextWindow = capacity(provider.contextWindow ?? preset.contextWindow, 'Context Window');
  const maxTokens = Math.min(capacity(provider.maxTokens ?? preset.maxTokens, 'Max Tokens'), contextWindow);
  return {
    ...provider,
    name: cleanName(provider.name),
    kind,
    apiFormat: providerApiFormat(provider.apiFormat, kind),
    baseUrl: normalizeBaseUrl(provider.baseUrl, kind),
    models: normalizeModels(provider.models),
    contextWindow,
    maxTokens,
    enabled: provider.enabled !== false,
  };
}

function providerKind(value: string): ProviderKind {
  if (!Object.hasOwn(defaults, value)) throw new Error('Provider 类型无效');
  return value as ProviderKind;
}

function cleanName(value: string): string {
  const name = String(value ?? '').trim();
  if (!name || name.length > 64 || /[\r\n\0]/.test(name)) throw new Error('Provider 名称无效');
  return name;
}

function normalizeBaseUrl(value: string, kind: ProviderKind): string {
  if (kind === 'chatgpt') return defaults.chatgpt.baseUrl;
  if (kind === 'claude-native') return '';
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Base URL 无效'); }
  if (url.username || url.password || url.hash || url.search) throw new Error('Base URL 不能包含认证、查询或片段');
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('远程 Provider 必须使用 HTTPS');
  const normalized = url.toString().replace(/\/$/, '');
  return kind === 'deepseek' ? normalized.replace(/\/anthropic$/, '') : normalized;
}

function normalizeModels(values: readonly string[]): string[] {
  const models = [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
  if (models.length > 512 || models.some((value) => value.length > 256 || /[\r\n\0]/.test(value))) {
    throw new Error('Model 列表无效');
  }
  return models;
}

function credentialBinding(id: string, kind: ProviderKind) {
  if (kind === 'claude-native') throw new Error('Claude 本机登录不使用宿主凭据');
  return {
    runtimeType: 'provider', runtimeProfileId: id,
    environmentVariable: kind === 'openai' || kind === 'openai-compatible'
      ? 'OPENAI_API_KEY'
      : kind === 'anthropic' ? 'ANTHROPIC_API_KEY'
        : kind === 'deepseek' || kind === 'anthropic-compatible' ? 'ANTHROPIC_AUTH_TOKEN'
          : 'TSUKIORI_PROVIDER_API_KEY',
  } as const;
}

function providerApiFormat(value: unknown, kind: ProviderKind): ProviderApiFormat {
  const preset = defaults[kind].apiFormat;
  if (kind !== 'openai-compatible') return preset;
  if (value === 'openai' || value === 'openai-completions') return 'openai-completions';
  if (value === 'openai-responses') return value;
  return preset;
}

function capacity(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > 4_000_000) throw new Error(`${label} 无效`);
  return number;
}

function httpCategory(status: number): string {
  if (status === 401 || status === 403) return 'authentication_failed';
  if (status === 404) return 'endpoint_not_supported';
  if (status === 429) return 'rate_limited';
  return status >= 500 ? 'provider_unavailable' : 'http_' + status;
}

function errorCategory(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout';
  return 'network_error';
}

function auditCategory(value: unknown): string {
  const category = String(value ?? 'unknown').toLowerCase();
  return /^[a-z0-9_-]{1,64}$/.test(category) ? category : 'unknown';
}
