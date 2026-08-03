import { randomUUID } from 'node:crypto';
import { WindowsCredentialBroker, type SecretReference } from '@tsukiori/credential-broker';

export type ProviderKind =
  | 'chatgpt'
  | 'openai'
  | 'anthropic'
  | 'deepseek'
  | 'openai-compatible'
  | 'anthropic-compatible';

export type ProviderConfig = {
  id: string;
  name: string;
  kind: ProviderKind;
  apiFormat: 'openai' | 'anthropic' | 'chatgpt';
  baseUrl: string;
  models: string[];
  secretRef?: SecretReference;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastTest?: { ok: boolean; latencyMs: number; category: string; testedAt: number };
};

export type ProviderView = Omit<ProviderConfig, 'secretRef'> & { hasSecret: boolean };

export type ProviderInput = {
  id?: string;
  name: string;
  kind: ProviderKind;
  baseUrl?: string;
  models?: readonly string[];
  apiKey?: string;
  enabled?: boolean;
};

const defaults: Record<ProviderKind, Pick<ProviderConfig, 'apiFormat' | 'baseUrl' | 'models'>> = {
  chatgpt: { apiFormat: 'chatgpt', baseUrl: 'https://chatgpt.com/backend-api', models: ['auto'] },
  openai: { apiFormat: 'openai', baseUrl: 'https://api.openai.com', models: ['gpt-5.4', 'gpt-5.4-mini'] },
  anthropic: { apiFormat: 'anthropic', baseUrl: 'https://api.anthropic.com', models: ['claude-sonnet-4-6', 'claude-opus-4-6'] },
  deepseek: { apiFormat: 'anthropic', baseUrl: 'https://api.deepseek.com/anthropic', models: ['deepseek-v4-pro', 'deepseek-v4-flash'] },
  'openai-compatible': { apiFormat: 'openai', baseUrl: '', models: [] },
  'anthropic-compatible': { apiFormat: 'anthropic', baseUrl: '', models: [] },
};

export function builtInProviders(now = Date.now()): ProviderConfig[] {
  return [
    createBuiltIn('provider:chatgpt', 'ChatGPT 登录', 'chatgpt', now),
    createBuiltIn('provider:openai', 'OpenAI API', 'openai', now),
    createBuiltIn('provider:anthropic', 'Anthropic API', 'anthropic', now),
    createBuiltIn('provider:deepseek', 'DeepSeek', 'deepseek', now),
  ];
}

export class ProviderRegistry {
  readonly #credentials: WindowsCredentialBroker;
  readonly #persist: (providers: ProviderConfig[]) => void;
  #providers: ProviderConfig[];

  constructor(options: {
    providers?: readonly ProviderConfig[];
    credentials?: WindowsCredentialBroker;
    persist: (providers: ProviderConfig[]) => void;
  }) {
    this.#credentials = options.credentials ?? new WindowsCredentialBroker();
    this.#persist = options.persist;
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
    const models = normalizeModels(input.models ?? existing?.models ?? preset.models);
    if (kind !== 'chatgpt' && models.length === 0) throw new Error('至少配置一个 Model');
    const at = Date.now();
    let secretRef = existing?.secretRef;
    const apiKey = input.apiKey?.trim();
    if (kind !== 'chatgpt' && apiKey) {
      secretRef = this.#credentials.store({
        secret: apiKey,
        ...(secretRef ? { reference: secretRef } : {}),
        binding: credentialBinding(id, kind),
      });
    }
    const provider: ProviderConfig = {
      id, name, kind, apiFormat: preset.apiFormat, baseUrl, models,
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
    if (id === 'provider:chatgpt') throw new Error('ChatGPT 登录项不能删除');
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
    if (provider.kind === 'chatgpt') return { ok: true, latencyMs: 0, category: 'runtime_auth' };
    if (!provider.secretRef) throw new Error('请先保存 API Key');
    const started = Date.now();
    let result: { ok: boolean; latencyMs: number; category: string };
    try {
      result = await this.withEnvironment(provider.id, async (environment) => {
        const token = environment.OPENAI_API_KEY ?? environment.ANTHROPIC_API_KEY ?? environment.ANTHROPIC_AUTH_TOKEN;
        if (!token) throw new Error('credential_unavailable');
        const endpoint = provider.apiFormat === 'openai' ? provider.baseUrl + '/v1/models' : provider.baseUrl + '/v1/messages';
        const headers: Record<string, string> = provider.apiFormat === 'openai'
          ? { Authorization: 'Bearer ' + token }
          : { 'x-api-key': token, Authorization: 'Bearer ' + token, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
        const response = await fetch(endpoint, {
          method: provider.apiFormat === 'openai' ? 'GET' : 'POST', headers,
          ...(provider.apiFormat === 'anthropic' ? { body: JSON.stringify({ model: provider.models[0], max_tokens: 1, messages: [{ role: 'user', content: 'Reply OK.' }] }) } : {}),
          redirect: 'error', signal: AbortSignal.timeout(20_000),
        });
        await response.body?.cancel().catch(() => undefined);
        return {
          ok: response.ok,
          latencyMs: Date.now() - started,
          category: response.ok ? 'connected' : httpCategory(response.status),
        };
      });
    } catch (error) {
      result = { ok: false, latencyMs: Date.now() - started, category: errorCategory(error) };
    }
    provider.lastTest = { ...result, testedAt: Date.now() };
    provider.updatedAt = Date.now();
    this.#flush();
    return result;
  }

  async listModels(id: string): Promise<{ models: string[]; source: 'remote' | 'configured' }> {
    const provider = this.get(id);
    if (provider.kind === 'chatgpt' || provider.kind === 'anthropic' || provider.kind === 'anthropic-compatible') {
      return { models: [...provider.models], source: 'configured' };
    }
    if (!provider.secretRef) throw new Error('请先保存 API Key');
    return await this.withEnvironment(provider.id, async (environment) => {
      const token = environment.OPENAI_API_KEY ?? environment.ANTHROPIC_AUTH_TOKEN;
      if (!token) throw new Error('credential_unavailable');
      const endpoint = provider.kind === 'deepseek'
        ? 'https://api.deepseek.com/models'
        : provider.baseUrl + '/v1/models';
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
    if (provider.apiFormat === 'anthropic') {
      environment.ANTHROPIC_BASE_URL = provider.baseUrl;
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
      environment.CLAUDE_CODE_EFFORT_LEVEL = 'max';
    }
    if (!provider.secretRef) return consumer(environment);
    const binding = credentialBinding(provider.id, provider.kind);
    return this.#credentials.use(provider.secretRef, binding, (secret) => {
      environment[binding.environmentVariable] = secret;
      return consumer(environment);
    });
  }

  private view(provider: ProviderConfig): ProviderView {
    const { secretRef, ...safe } = provider;
    return { ...safe, hasSecret: Boolean(secretRef) };
  }

  #flush(): void {
    this.#persist(this.raw());
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
  return {
    ...provider,
    name: cleanName(provider.name),
    kind,
    apiFormat: defaults[kind].apiFormat,
    baseUrl: normalizeBaseUrl(provider.baseUrl, kind),
    models: normalizeModels(provider.models),
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
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Base URL 无效'); }
  if (url.username || url.password || url.hash || url.search) throw new Error('Base URL 不能包含认证、查询或片段');
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('远程 Provider 必须使用 HTTPS');
  return url.toString().replace(/\/$/, '');
}

function normalizeModels(values: readonly string[]): string[] {
  const models = [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
  if (models.length > 32 || models.some((value) => value.length > 128 || /[\r\n\0]/.test(value))) {
    throw new Error('Model 列表无效');
  }
  return models;
}

function credentialBinding(id: string, kind: ProviderKind) {
  return {
    runtimeType: 'provider', runtimeProfileId: id,
    environmentVariable: kind === 'openai' || kind === 'openai-compatible'
      ? 'OPENAI_API_KEY'
      : kind === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'ANTHROPIC_AUTH_TOKEN',
  } as const;
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
