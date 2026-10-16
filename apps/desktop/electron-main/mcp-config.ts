import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';

export function readMcpObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    if (!statSync(path).isFile() || statSync(path).size > 512 * 1024) throw new Error();
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isObject(value)) throw new Error();
    return value;
  } catch { throw new Error('MCP 配置无法读取或格式无效，原文件已保留'); }
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function mcpFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function mergeMcpConfig(existing: Record<string, unknown>, desired: Record<string, unknown>, owned: Record<string, unknown>) {
  if (existing.mcpServers !== undefined && !isObject(existing.mcpServers)) throw new Error('MCP 服务器配置必须是对象');
  const servers = { ...(existing.mcpServers as Record<string, unknown> | undefined) };
  for (const name of Object.keys(owned)) {
    if (!Object.hasOwn(desired, name)) delete servers[name];
  }
  return {
    config: { ...existing, mcpServers: { ...servers, ...desired } },
    owned: Object.fromEntries(Object.entries(desired).map(([name, value]) => [name, mcpFingerprint(value)])),
  };
}
