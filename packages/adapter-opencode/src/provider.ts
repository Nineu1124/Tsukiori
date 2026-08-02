import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import type { SupportLevel } from '@tsukiori/domain';

const MAX_PROVIDERS = 256;
const MAX_MODELS_PER_PROVIDER = 512;
type OpenCodeClient = ReturnType<typeof createOpencodeClient>;

export type OpenCodeModelOption = {
  id: string;
  name: string;
  status: 'alpha' | 'beta' | 'deprecated' | 'active' | 'unknown';
  experimental: boolean;
};

export type OpenCodeProviderOption = {
  id: string;
  name: string;
  connected: boolean;
  credentialSource: 'config' | 'environment' | 'custom' | 'runtime_managed' | 'unknown';
  destinationHost: string;
  supportLevel: SupportLevel;
  models: OpenCodeModelOption[];
  modelsTruncated: boolean;
};

export type OpenCodeProviderCatalog = {
  runtimeType: 'opencode';
  runtimeVersion: string;
  workspacePathVerified: boolean;
  vcsDetected: boolean;
  providers: OpenCodeProviderOption[];
  providersTruncated: boolean;
};

export type OpenCodeProviderSelection = {
  providerId: string;
  modelId: string;
  providerName: string;
  modelName: string;
  destinationHost: string;
  credentialSource: OpenCodeProviderOption['credentialSource'];
  supportLevel: SupportLevel;
};

export type OpenCodeProviderVerification = {
  providerId: string;
  modelId: string;
  destinationHost: string;
  completed: boolean;
  messageCount: number;
  containsCredentials: false;
};

export function buildProviderCatalog(
  runtimeVersion: string,
  workspacePathVerified: boolean,
  vcsDetected: boolean,
  value: unknown,
): OpenCodeProviderCatalog {
  const response = object(value);
  const all = Array.isArray(response.all) ? response.all : [];
  const connected = new Set(
    Array.isArray(response.connected)
      ? response.connected.filter((item): item is string => typeof item === 'string')
      : [],
  );
  const credentialSources: Record<string, OpenCodeProviderOption['credentialSource']> = {
    config: 'config', env: 'environment', custom: 'custom', api: 'runtime_managed',
  };
  const providers = all.slice(0, MAX_PROVIDERS).flatMap((providerValue) => {
    const provider = object(providerValue);
    if (typeof provider.id !== 'string') return [];
    const rawModels = Object.entries(object(provider.models));
    const models = rawModels.slice(0, MAX_MODELS_PER_PROVIDER).map(([id, modelValue]) => {
      const model = object(modelValue);
      const status = typeof model.status === 'string'
        && ['alpha', 'beta', 'deprecated', 'active'].includes(model.status)
        ? model.status as OpenCodeModelOption['status']
        : 'unknown';
      return {
        id,
        name: typeof model.name === 'string' ? model.name : id,
        status,
        experimental: model.experimental === true,
      };
    });
    const endpoint = typeof provider.api === 'string'
      ? provider.api
      : typeof object(provider.options).baseURL === 'string'
        ? String(object(provider.options).baseURL)
        : '';
    const destinationHost = endpointHost(endpoint) ?? 'unknown';
    const isConnected = connected.has(provider.id);
    return [{
      id: provider.id,
      name: typeof provider.name === 'string' ? provider.name : provider.id,
      connected: isConnected,
      credentialSource: typeof provider.source === 'string'
        ? credentialSources[provider.source] ?? 'unknown'
        : 'unknown',
      destinationHost,
      supportLevel: isConnected && destinationHost !== 'unknown'
        ? 'supported'
        : isConnected ? 'degraded' : 'unsupported',
      models,
      modelsTruncated: rawModels.length > MAX_MODELS_PER_PROVIDER,
    } satisfies OpenCodeProviderOption];
  });
  return {
    runtimeType: 'opencode',
    runtimeVersion,
    workspacePathVerified,
    vcsDetected,
    providers,
    providersTruncated: all.length > MAX_PROVIDERS,
  };
}

export function selectProvider(
  catalog: OpenCodeProviderCatalog,
  providerId: string,
  modelId: string,
): OpenCodeProviderSelection {
  const provider = catalog.providers.find((item) => item.id === providerId);
  if (!provider) throw new Error('OpenCode Provider is not listed');
  if (!provider.connected) throw new Error('OpenCode Provider is not connected');
  const model = provider.models.find((item) => item.id === modelId);
  if (!model) throw new Error('OpenCode Model is not listed');
  return {
    providerId,
    modelId,
    providerName: provider.name,
    modelName: model.name,
    destinationHost: provider.destinationHost,
    credentialSource: provider.credentialSource,
    supportLevel: provider.supportLevel,
  };
}

export async function verifyProvider(
  client: OpenCodeClient,
  directory: string,
  selection: OpenCodeProviderSelection,
  timeoutMs = 120_000,
): Promise<OpenCodeProviderVerification> {
  let sessionId: string | undefined;
  try {
    const session = data(await client.session.create({
      directory,
      title: 'Tsukiori Provider Verification',
      model: { providerID: selection.providerId, id: selection.modelId },
      permission: [
        { permission: 'external_directory', pattern: '*', action: 'deny' },
        { permission: 'bash', pattern: '*', action: 'deny' },
        { permission: 'edit', pattern: '*', action: 'deny' },
      ],
    }), 'session.create(provider verification)');
    const sessionObject = object(session);
    if (typeof sessionObject.id !== 'string') throw new Error('Provider verification Session ID is missing');
    sessionId = sessionObject.id;
    const promptResult = await client.session.promptAsync({
      directory,
      sessionID: sessionId,
      model: { providerID: selection.providerId, modelID: selection.modelId },
      parts: [{
        type: 'text',
        text: ['Reply with exactly', 'TSUKIORI_PROVIDER_OK.', 'Do not use tools.'].join(' '),
      }],
    });
    if (promptResult.error) throw new Error('Provider verification prompt failed');
    const messages = await waitForMessages(client, directory, sessionId, timeoutMs);
    return {
      providerId: selection.providerId,
      modelId: selection.modelId,
      destinationHost: selection.destinationHost,
      completed: true,
      messageCount: messages.length,
      containsCredentials: false,
    };
  } finally {
    if (sessionId) {
      try {
        await client.session.delete({ directory, sessionID: sessionId });
      } catch {
        // Best effort cleanup; no Host Session is created by a Provider probe.
      }
    }
  }
}

export function data(result: unknown, label: string): unknown {
  const response = object(result);
  if (Object.keys(response).length === 0) throw new Error(label + ' returned no structured result');
  if (response.error) throw new Error(label + ' failed');
  return response.data;
}

async function waitForMessages(
  client: OpenCodeClient,
  directory: string,
  sessionId: string,
  timeoutMs: number,
): Promise<unknown[]> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const messages = data(
      await client.session.messages({ directory, sessionID: sessionId }),
      'session.messages(provider verification)',
    );
    if (Array.isArray(messages) && messages.length >= 2) return messages;
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error('Provider verification timed out');
}

function endpointHost(value: string): string | null {
  if (!value) return null;
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}