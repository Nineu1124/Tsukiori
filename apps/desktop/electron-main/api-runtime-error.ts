const messages = {
  authentication_failed: 'API 认证失败，请检查密钥和访问权限。',
  rate_limited: 'API 请求过于频繁，请稍后重试。',
  quota_exhausted: 'API 额度不足，请检查账户余额或用量限制。',
  context_window_exceeded: '对话内容超出模型上下文限制。',
  timeout: 'API 请求超时，请稍后重试。',
  aborted: 'Direct API Turn 已中断',
  network_error: 'API 连接失败，请检查网络和服务地址。',
  provider_error: 'API 请求失败，请检查服务状态后重试。',
  invalid_configuration: '所选 Provider 不能用于直接 API Runtime',
  incomplete_response: 'API Runtime 流未返回完成事件',
  tools_unavailable: '此 API Runtime 尚未启用工具执行，请改用 Codex 或 Claude Code Runtime',
} as const;

type ApiErrorCategory = keyof typeof messages;

export class ApiRuntimeError extends Error {
  constructor(readonly category: ApiErrorCategory) {
    super(messages[category]);
    this.name = category === 'aborted' ? 'AbortError' : 'ApiRuntimeError';
  }
}

export function safeApiError(error: unknown, aborted = false): ApiRuntimeError {
  if (aborted) return new ApiRuntimeError('aborted');
  if (error instanceof ApiRuntimeError) return error;
  const texts: string[] = [];
  const statuses: number[] = [];
  const seen = new Set<object>();
  let isAbort = false;
  const visit = (value: unknown, depth: number): void => {
    if (typeof value === 'string') { texts.push(value.slice(0, 8_192)); return; }
    if (!value || typeof value !== 'object' || depth > 3 || seen.has(value)) return;
    seen.add(value);
    const raw = value as Record<string, unknown>;
    if (raw.name === 'AbortError') isAbort = true;
    for (const key of ['status', 'statusCode']) {
      if (typeof raw[key] === 'number') statuses.push(raw[key]);
    }
    for (const key of ['name', 'code', 'message', 'errorMessage']) {
      if (typeof raw[key] === 'string') texts.push(raw[key].slice(0, 8_192));
    }
    for (const key of ['cause', 'error', 'response']) visit(raw[key], depth + 1);
  };
  try { visit(error, 0); } catch { return new ApiRuntimeError('provider_error'); }
  if (isAbort) return new ApiRuntimeError('aborted');
  // 正文只用于分类，不能作为消息、cause 或其他字段传出。
  const text = texts.join(' ').toLowerCase();
  let category: ApiErrorCategory = 'provider_error';
  if (statuses.some((status) => status === 401 || status === 403) || /401|403|auth|api.?key|unauthorized|forbidden/.test(text)) category = 'authentication_failed';
  else if (/quota|credit|balance/.test(text)) category = 'quota_exhausted';
  else if (statuses.includes(429) || /429|rate.?limit/.test(text)) category = 'rate_limited';
  else if (/context|too many tokens|maximum token/.test(text)) category = 'context_window_exceeded';
  else if (/timeout|timed.?out|etimedout/.test(text)) category = 'timeout';
  else if (/abort/.test(text)) category = 'aborted';
  else if (/fetch|network|connect|econn|enotfound|eai_again|dns|socket|tls/.test(text)) category = 'network_error';
  return new ApiRuntimeError(category);
}
