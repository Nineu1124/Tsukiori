const descriptions = {
  authentication_failed: 'Runtime 认证失败，请检查登录状态和凭据。',
  timeout: 'Runtime 请求超时，请检查进程状态。',
  interrupted: 'Runtime 请求已中断。',
  runtime_error: 'Runtime 执行失败，请检查进程和服务状态。',
} as const;

export function runtimeFailure(error: unknown): { category: keyof typeof descriptions; message: string } {
  const texts: string[] = [];
  const seen = new Set<object>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > 3) return;
    if (typeof value === 'string') { texts.push(value.slice(0, 4_096)); return; }
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    const row = value as Record<string, unknown>;
    for (const key of ['name', 'code', 'message', 'error', 'cause', 'stderr']) visit(row[key], depth + 1);
  };
  try { visit(error, 0); } catch { /* 不把异常属性或原始正文带出边界。 */ }
  const text = texts.join(' ');
  const category = /abort|interrupt|中断/i.test(text) ? 'interrupted'
    : /timeout|timed.out|超时/i.test(text) ? 'timeout'
    : /401|403|auth|api.key|认证/i.test(text) ? 'authentication_failed' : 'runtime_error';
  return { category, message: descriptions[category] };
}
