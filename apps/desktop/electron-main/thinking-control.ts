import { CLAUDE_THINKING_EFFORTS, type ClaudeThinkingEffort } from '@tsukiori/adapter-claude';
import type { ProviderKind } from './provider-registry.js';

export type ThinkingSupportLevel = 'supported' | 'unsupported' | 'unknown';

export type ThinkingControlRuntime = {
  type: string;
  available: boolean;
  version: string;
  supportLevel: string;
  capabilities: readonly string[];
};

export type ThinkingControlMatrix = {
  runtimeType: string;
  providerKind: ProviderKind;
  claudeCli: {
    supportLevel: ThinkingSupportLevel;
    argument: '--effort';
    values: readonly ClaudeThinkingEffort[];
    reason: string;
  };
  providerApi: {
    supportLevel: ThinkingSupportLevel;
    protocol: 'anthropic' | 'openai' | 'unknown';
    parameter: 'output_config.effort' | 'reasoning_effort' | 'unknown';
    reason: string;
  };
  crossLayerMapping: {
    supportLevel: ThinkingSupportLevel;
    reason: string;
  };
  modelEffort: {
    supportLevel: ThinkingSupportLevel;
    values: readonly ClaudeThinkingEffort[];
    reason: string;
  };
  hostDisplay: {
    supportLevel: 'supported';
    affectsModel: false;
    reason: string;
  };
};

export function resolveThinkingControl(
  runtime: ThinkingControlRuntime | undefined,
  providerKind: ProviderKind,
): ThinkingControlMatrix {
  const isClaude = runtime?.type === 'claude';
  const runtimeVerified = isClaude && runtime.available
    && (runtime.supportLevel === 'supported' || runtime.supportLevel === 'degraded');
  const cliVerified = Boolean(runtimeVerified && runtime?.capabilities.includes('effort-control'));
  const providerApi = providerApiCapability(providerKind);

  const claudeCli: ThinkingControlMatrix['claudeCli'] = cliVerified
    ? {
        supportLevel: 'supported', argument: '--effort', values: CLAUDE_THINKING_EFFORTS,
        reason: `Claude Code ${runtime?.version} 的帮助文本已验证 --effort 与允许值`,
      }
    : {
        supportLevel: isClaude && runtime?.available ? 'unsupported' : 'unknown',
        argument: '--effort', values: [],
        reason: !isClaude ? '当前 Runtime 不是 Claude Code'
          : runtime?.available ? '当前已锁定版本未声明 effort-control 能力'
            : 'Claude Code 版本或兼容性尚未验证',
      };

  const nativeClaude = providerKind === 'claude-native';
  const crossLayerMapping: ThinkingControlMatrix['crossLayerMapping'] = nativeClaude && cliVerified
    ? { supportLevel: 'supported', reason: 'Claude Code 本机登录直接使用已验证 CLI 参数' }
    : {
        supportLevel: providerKind === 'deepseek' ? 'unknown' : 'unsupported',
        reason: providerKind === 'deepseek'
          ? 'Claude Code --effort 到 DeepSeek output_config.effort 的映射尚无可接受的请求证据'
          : '当前 Provider 未建立 CLI effort 的版本化映射证据',
      };

  const modelEffort: ThinkingControlMatrix['modelEffort'] = nativeClaude && cliVerified
    ? {
        supportLevel: 'supported', values: CLAUDE_THINKING_EFFORTS,
        reason: '仅为 Claude 本机登录暴露已验证的 Claude Code --effort 控制',
      }
    : {
        supportLevel: providerKind === 'deepseek' || !runtime?.available ? 'unknown' : 'unsupported', values: [],
        reason: providerKind === 'deepseek'
          ? 'DeepSeek 官方 API 参数已知，但当前 Claude Code 转发映射未知，使用 Provider 默认值'
          : claudeCli.reason,
      };

  return {
    runtimeType: runtime?.type ?? 'unknown', providerKind,
    claudeCli, providerApi, crossLayerMapping, modelEffort,
    hostDisplay: {
      supportLevel: 'supported', affectsModel: false,
      reason: '只控制本机 Thinking 正文显示，不改变 Runtime 或 Provider 请求',
    },
  };
}

export function validatedThinkingEffort(
  value: unknown,
  matrix: ThinkingControlMatrix,
): ClaudeThinkingEffort | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (matrix.modelEffort.supportLevel !== 'supported') {
    throw new Error(`Thinking effort ${matrix.modelEffort.supportLevel}：${matrix.modelEffort.reason}`);
  }
  if (!CLAUDE_THINKING_EFFORTS.includes(value as ClaudeThinkingEffort)) {
    throw new Error('Thinking effort 必须为 low、medium、high、xhigh 或 max');
  }
  return value as ClaudeThinkingEffort;
}

function providerApiCapability(providerKind: ProviderKind): ThinkingControlMatrix['providerApi'] {
  if (providerKind === 'deepseek') return {
    supportLevel: 'supported', protocol: 'anthropic', parameter: 'output_config.effort',
    reason: 'DeepSeek Anthropic API 文档验证 output_config 仅支持 effort',
  };
  if (providerKind === 'claude-native') return {
    supportLevel: 'unsupported', protocol: 'unknown', parameter: 'unknown',
    reason: '本机登录由 Claude Code 管理，不是宿主直接 Provider API 请求',
  };
  return {
    supportLevel: 'unknown', protocol: providerKind.includes('anthropic') ? 'anthropic' : 'unknown',
    parameter: 'unknown', reason: '该 Provider 尚无本任务锁定的 Thinking API 参数证据',
  };
}
