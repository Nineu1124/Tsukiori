import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repositoryRoot = process.cwd();
const secret = readFileSync(0, 'utf8').trim();
if (!secret || secret.length > 1024 || /[\r\n\0]/.test(secret)) {
  throw new Error('DeepSeek API Key input is invalid');
}

const marker = 'TSUKIORI_DEEPSEEK_CONVERSATION_OK';
const temporary = mkdtempSync(join(tmpdir(), 'tsukiori-deepseek-probe-'));
const repository = join(temporary, 'empty-repository');
const result = {
  schemaVersion: 1,
  provider: 'deepseek',
  endpoint: 'api.deepseek.com',
  model: 'deepseek-v4-pro[1m]',
  isolatedRepository: true,
  userSourceSent: false,
  apiKeyPersisted: false,
  directAnthropicApi: { ok: false, status: 0, responseReceived: false, markerReceived: false },
  claudeCode: { ok: false, responseReceived: false, markerReceived: false, turnCompleted: false, errorCategory: null, errorDetail: null },
};

try {
  execFileSync('git.exe', ['init', '--quiet', repository], { windowsHide: true });
  execFileSync('git.exe', ['-C', repository, 'config', 'user.name', 'Tsukiori Probe'], { windowsHide: true });
  execFileSync('git.exe', ['-C', repository, 'config', 'user.email', 'probe@tsukiori.invalid'], { windowsHide: true });
  writeFileSync(join(repository, 'README.md'), '# Empty DeepSeek probe repository\n', 'utf8');
  execFileSync('git.exe', ['-C', repository, 'add', 'README.md'], { windowsHide: true });
  execFileSync('git.exe', ['-C', repository, 'commit', '--quiet', '-m', 'probe fixture'], { windowsHide: true });

  const response = await fetch('https://api.deepseek.com/anthropic/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': secret,
      Authorization: 'Bearer ' + secret,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'deepseek-v4-pro',
      max_tokens: 48,
      messages: [{ role: 'user', content: `Reply with exactly ${marker}` }],
    }),
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  result.directAnthropicApi.status = response.status;
  result.directAnthropicApi.ok = response.ok;
  if (response.ok) {
    const body = await response.json();
    const content = Array.isArray(body.content) ? body.content : [];
    const responseText = content.map((item) => String(item?.text ?? '')).join('');
    result.directAnthropicApi.responseReceived = responseText.trim().length > 0;
    result.directAnthropicApi.markerReceived = responseText.includes(marker);
  } else {
    await response.body?.cancel().catch(() => undefined);
  }

  const { ClaudeCodeClient, discoverClaudeLaunch } = await import(pathToFileURL(resolve(
    repositoryRoot, 'apps', 'desktop', 'dist', 'electron-main', 'claude-code-client.js',
  )).href);
  const client = new ClaudeCodeClient(discoverClaudeLaunch());
  let assistant = '';
  let completed = false;
  let exitError = null;
  await new Promise((resolveProbe, rejectProbe) => {
    const timeout = setTimeout(() => rejectProbe(new Error('claude_code_timeout')), 90_000);
    const finish = () => {
      clearTimeout(timeout);
      resolveProbe();
    };
    client.startTurn({
      cwd: repository,
      sessionId: randomUUID(),
      resume: false,
      prompt: `Reply with exactly ${marker}. Do not use tools.`,
      model: 'deepseek-v4-pro[1m]',
      permissionMode: 'plan',
      environment: {
        ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
        ANTHROPIC_AUTH_TOKEN: secret,
        ANTHROPIC_MODEL: 'deepseek-v4-pro[1m]',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-pro[1m]',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-pro[1m]',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash',
        CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-v4-flash',
        CLAUDE_CODE_EFFORT_LEVEL: 'max',
      },
      onEvent(type, payload) {
        if (type === 'assistant.delta') assistant += String(payload.text ?? '');
        if (type === 'turn.completed') completed = payload.status === 'completed';
      },
      onExit(error) {
        exitError = error;
        finish();
      },
    });
  });
  await client.stop();
  result.claudeCode.markerReceived = assistant.includes(marker);
  result.claudeCode.responseReceived = assistant.trim().length > 0;
  result.claudeCode.turnCompleted = completed;
  result.claudeCode.ok = completed && result.claudeCode.responseReceived && !exitError;
  result.claudeCode.errorCategory = exitError ? categorize(exitError) : null;
  result.claudeCode.errorDetail = exitError ? sanitize(exitError) : null;
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  result.claudeCode.errorCategory = categorize(detail);
  result.claudeCode.errorDetail = sanitize(detail);
} finally {
  rmSync(temporary, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
}

process.stdout.write(JSON.stringify(result, null, 2) + '\n');
process.exitCode = result.directAnthropicApi.ok && result.claudeCode.ok ? 0 : 1;

function categorize(value) {
  const text = sanitize(value);
  if (/timeout/i.test(text)) return 'timeout';
  if (/401|unauthor|auth/i.test(text)) return 'authentication_failed';
  if (/429|rate/i.test(text)) return 'rate_limited';
  if (/model/i.test(text)) return 'model_error';
  return 'runtime_error';
}

function sanitize(value) {
  return String(value)
    .replace(/sk-[A-Za-z0-9_-]+|Bearer\s+\S+/gi, '[REDACTED]')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 500);
}
