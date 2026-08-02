import type {
  EnforcementLevel,
  JsonValue,
  RuntimeAuthSource,
  SupportLevel,
} from '@tsukiori/domain';

type RequestHandle = {
  request(method: string, params?: JsonValue): Promise<unknown>;
};

export type CodexNativeCapability = {
  id: 'configuration' | 'mcp' | 'skills' | 'sandbox' | 'authentication';
  label: string;
  supportLevel: SupportLevel;
  enforcementLevel: EnforcementLevel;
  scope: 'runtime_native';
  commitment: 'verified_runtime_probe' | 'not_committed';
  summary: string;
};

export type CodexNativeCapabilitySnapshot = {
  runtimeType: 'codex';
  runtimeVersion: string;
  authenticated: boolean;
  authSource: RuntimeAuthSource;
  probedAt: number;
  configuration: {
    supportLevel: SupportLevel;
    sandboxMode: string;
    approvalPolicy: string;
    layerCount: number;
  };
  skills: {
    supportLevel: SupportLevel;
    entryCount: number;
    enabledCount: number;
    disabledCount: number;
    errorCount: number;
    scopes: Record<string, number>;
  };
  mcp: {
    supportLevel: SupportLevel;
    serverCount: number;
    toolCount: number;
    resourceCount: number;
    resourceTemplateCount: number;
    authStatuses: Record<string, number>;
  };
  sandbox: {
    supportLevel: SupportLevel;
    readiness: string;
    configuredMode: string;
    enforcementLevel: 'unknown';
    securityClaim: 'not_inferred';
  };
  capabilities: CodexNativeCapability[];
};

type ProbeResult =
  | { status: 'fulfilled'; value: unknown }
  | { status: 'rejected' };

export async function probeCodexNativeCapabilities(
  handle: RequestHandle,
  options: {
    cwd: string;
    runtimeVersion: string;
    authenticated: boolean;
    authSource: RuntimeAuthSource;
    now?: () => number;
  },
): Promise<CodexNativeCapabilitySnapshot> {
  const [configProbe, skillsProbe, mcpProbe, sandboxProbe] = await Promise.all([
    settle(handle.request('config/read', { cwd: options.cwd, includeLayers: true })),
    settle(handle.request('skills/list', { cwds: [options.cwd], forceReload: false })),
    settle(handle.request('mcpServerStatus/list', { detail: 'toolsAndAuthOnly' })),
    settle(handle.request('windowsSandbox/readiness', null)),
  ]);

  const configuration = summarizeConfig(configProbe);
  const skills = summarizeSkills(skillsProbe);
  const mcp = summarizeMcp(mcpProbe);
  const sandbox = summarizeSandbox(sandboxProbe, configuration.sandboxMode);
  const authenticationSupport: SupportLevel =
    options.authenticated && options.authSource === 'unknown' ? 'degraded' : 'supported';

  const capabilities: CodexNativeCapability[] = [
    capability(
      'configuration',
      'Codex 配置',
      configuration.supportLevel,
      'unknown',
      'sandbox=' + configuration.sandboxMode + ' · approval=' + configuration.approvalPolicy,
    ),
    capability(
      'mcp',
      'MCP',
      mcp.supportLevel,
      'unknown',
      mcp.serverCount + ' servers · ' + mcp.toolCount + ' tools',
    ),
    capability(
      'skills',
      'Skills',
      skills.supportLevel,
      'unknown',
      skills.enabledCount + ' enabled · ' + skills.errorCount + ' errors',
    ),
    capability(
      'sandbox',
      'Sandbox',
      sandbox.supportLevel,
      'unknown',
      'readiness=' + sandbox.readiness + ' · enforcement=unverified',
    ),
    capability(
      'authentication',
      '认证来源',
      authenticationSupport,
      'unknown',
      options.authenticated ? options.authSource : 'not authenticated',
    ),
  ];

  return {
    runtimeType: 'codex',
    runtimeVersion: options.runtimeVersion,
    authenticated: options.authenticated,
    authSource: options.authSource,
    probedAt: (options.now ?? Date.now)(),
    configuration,
    skills,
    mcp,
    sandbox,
    capabilities,
  };
}

function capability(
  id: CodexNativeCapability['id'],
  label: string,
  supportLevel: SupportLevel,
  enforcementLevel: EnforcementLevel,
  summary: string,
): CodexNativeCapability {
  return {
    id,
    label,
    supportLevel,
    enforcementLevel,
    scope: 'runtime_native',
    commitment: supportLevel === 'unknown' ? 'not_committed' : 'verified_runtime_probe',
    summary,
  };
}

async function settle(promise: Promise<unknown>): Promise<ProbeResult> {
  try {
    return { status: 'fulfilled', value: await promise };
  } catch {
    return { status: 'rejected' };
  }
}

function summarizeConfig(probe: ProbeResult): CodexNativeCapabilitySnapshot['configuration'] {
  if (probe.status === 'rejected') {
    return {
      supportLevel: 'unknown',
      sandboxMode: 'unknown',
      approvalPolicy: 'unknown',
      layerCount: 0,
    };
  }
  const response = object(probe.value);
  const config = objectOrNull(response.config);
  if (!config || !objectOrNull(response.origins)) {
    return {
      supportLevel: 'degraded',
      sandboxMode: 'unknown',
      approvalPolicy: 'unknown',
      layerCount: 0,
    };
  }
  return {
    supportLevel: 'supported',
    sandboxMode: scalar(config.sandbox_mode),
    approvalPolicy: scalar(config.approval_policy),
    layerCount: Array.isArray(response.layers) ? response.layers.length : 0,
  };
}

function summarizeSkills(probe: ProbeResult): CodexNativeCapabilitySnapshot['skills'] {
  const empty = {
    entryCount: 0,
    enabledCount: 0,
    disabledCount: 0,
    errorCount: 0,
    scopes: {} as Record<string, number>,
  };
  if (probe.status === 'rejected') return { supportLevel: 'unknown', ...empty };
  const response = object(probe.value);
  if (!Array.isArray(response.data)) return { supportLevel: 'degraded', ...empty };

  let entryCount = 0;
  let enabledCount = 0;
  let disabledCount = 0;
  let errorCount = 0;
  const scopes: Record<string, number> = {};
  for (const entryValue of response.data) {
    const entry = object(entryValue);
    if (!Array.isArray(entry.skills) || !Array.isArray(entry.errors)) {
      return { supportLevel: 'degraded', ...empty };
    }
    entryCount += 1;
    errorCount += entry.errors.length;
    for (const skillValue of entry.skills) {
      const skill = object(skillValue);
      if (skill.enabled === true) enabledCount += 1;
      else disabledCount += 1;
      const scope = typeof skill.scope === 'string' ? skill.scope : 'unknown';
      scopes[scope] = (scopes[scope] ?? 0) + 1;
    }
  }
  return {
    supportLevel: errorCount > 0 ? 'degraded' : 'supported',
    entryCount,
    enabledCount,
    disabledCount,
    errorCount,
    scopes,
  };
}

function summarizeMcp(probe: ProbeResult): CodexNativeCapabilitySnapshot['mcp'] {
  const empty = {
    serverCount: 0,
    toolCount: 0,
    resourceCount: 0,
    resourceTemplateCount: 0,
    authStatuses: {} as Record<string, number>,
  };
  if (probe.status === 'rejected') return { supportLevel: 'unknown', ...empty };
  const response = object(probe.value);
  if (!Array.isArray(response.data)) return { supportLevel: 'degraded', ...empty };

  let toolCount = 0;
  let resourceCount = 0;
  let resourceTemplateCount = 0;
  const authStatuses: Record<string, number> = {};
  for (const serverValue of response.data) {
    const server = object(serverValue);
    if (!objectOrNull(server.tools) || !Array.isArray(server.resources) || !Array.isArray(server.resourceTemplates)) {
      return { supportLevel: 'degraded', ...empty };
    }
    toolCount += Object.keys(server.tools as Record<string, unknown>).length;
    resourceCount += server.resources.length;
    resourceTemplateCount += server.resourceTemplates.length;
    const authStatus = typeof server.authStatus === 'string' ? server.authStatus : 'unknown';
    authStatuses[authStatus] = (authStatuses[authStatus] ?? 0) + 1;
  }
  return {
    supportLevel: 'supported',
    serverCount: response.data.length,
    toolCount,
    resourceCount,
    resourceTemplateCount,
    authStatuses,
  };
}

function summarizeSandbox(
  probe: ProbeResult,
  configuredMode: string,
): CodexNativeCapabilitySnapshot['sandbox'] {
  if (probe.status === 'rejected') {
    return {
      supportLevel: 'unknown',
      readiness: 'unknown',
      configuredMode,
      enforcementLevel: 'unknown',
      securityClaim: 'not_inferred',
    };
  }
  const response = object(probe.value);
  const readiness = typeof response.status === 'string' ? response.status : 'unknown';
  const supportLevel: SupportLevel = readiness === 'ready'
    ? 'supported'
    : readiness === 'notConfigured' || readiness === 'updateRequired'
      ? 'degraded'
      : 'degraded';
  return {
    supportLevel,
    readiness,
    configuredMode,
    enforcementLevel: 'unknown',
    securityClaim: 'not_inferred',
  };
}

function scalar(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return 'default';
  return 'configured';
}

function object(value: unknown): Record<string, unknown> {
  return objectOrNull(value) ?? {};
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}