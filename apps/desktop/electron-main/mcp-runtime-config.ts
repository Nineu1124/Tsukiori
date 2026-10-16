import { createHash } from 'node:crypto';
import type { McpServerRecord } from './workspace-capabilities.js';

// Keep host-managed entries separate from names in the user's native config.toml.
export function codexMcpName(record: Pick<McpServerRecord, 'id'>): string {
  return 'tsukiori_' + createHash('sha256').update(record.id).digest('hex').slice(0, 24);
}

export function codexMcpArgs(records: readonly McpServerRecord[]): string[] {
  const args: string[] = [];
  for (const record of records.filter((item) => item.enabled)) {
    if (record.transport === 'sse') throw new Error('Codex 尚未验证 SSE MCP，请改用 HTTP 或停用该条目');
    const fields = record.transport === 'stdio'
      ? { command: record.command, args: record.args, env_vars: record.envKeys }
      : { url: record.url };
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) throw new Error('MCP 启动配置不完整');
      args.push('-c', `mcp_servers.${codexMcpName(record)}.${key}=${JSON.stringify(value)}`);
    }
  }
  return args;
}
