// This is the desktop command contract. Filesystem ownership, session existence,
// and Runtime permission checks still belong to the services that execute it.
export const WORKSPACE_COMMAND_VERSION = 1;
// Memory accepts 512 KiB and clipboard accepts 512,000 characters. JSON escaping
// can expand a character to six bytes, so the envelope must leave room for both.
export const MAX_WORKSPACE_COMMAND_BYTES = 4 * 1024 * 1024;

type Command = Record<string, unknown> & { type: string };
type Failure = { ok: false; code: string; message: string };
type Result = { ok: true; command: Command } | Failure;
type Rule = (value: unknown) => boolean;
type Fields = Readonly<Record<string, Rule>>;

const optional = (rule: Rule): Rule => (value) => value === undefined || rule(value);
const boolean: Rule = (value) => typeof value === 'boolean';
const integer = (min: number, max = Number.MAX_SAFE_INTEGER): Rule =>
  (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
const finite = (min: number, max: number): Rule =>
  (value) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const oneOf = (...values: readonly unknown[]): Rule => (value) => values.includes(value);
const text = (max: number, empty = false, multiline = false): Rule => (value) =>
  typeof value === 'string' && value.length <= max && (empty || value.trim().length > 0)
  && !(multiline ? /\0/ : /[\0\r\n]/).test(value);
const bytes = (max: number, empty = false): Rule => (value) =>
  typeof value === 'string' && (empty || value.length > 0) && !value.includes('\0') && Buffer.byteLength(value) <= max;
const id: Rule = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/.test(value);
const path: Rule = (value) => text(4096)(value) && !/^(?:[\\/]|[A-Za-z]:)/.test(value as string)
  && !(value as string).split(/[\\/]/).includes('..');
const list = (rule: Rule, max: number, min = 0): Rule =>
  (value) => Array.isArray(value) && value.length >= min && value.length <= max
    && Object.keys(value).length === value.length && value.every(rule);
const fields = (rules: Fields): Rule => (value) => isRecord(value)
  && Object.keys(value).every((key) => Object.hasOwn(rules, key))
  && Object.entries(rules).every(([key, rule]) => rule(value[key]));
const runtime = oneOf('codex', 'claude', 'api');
const permission = oneOf('manual', 'plan', 'acceptEdits', 'dontAsk');
const selection = {
  providerId: optional(id), model: optional(text(128)), permissionMode: optional(permission),
  thinkingEffort: optional(oneOf('low', 'medium', 'high', 'xhigh', 'max')),
};
const session = { sessionId: id };
const project = { projectId: id };
const integration = { ...session, integrationId: id };
const settings = fields({
  language: optional(oneOf('zh-CN')), theme: optional(oneOf('light')),
  density: optional(oneOf('comfortable', 'compact')), reduceMotion: optional(boolean),
  showThinking: optional(boolean), autoUpdate: optional(boolean), startMinimized: optional(boolean),
  defaultProjectDirectory: optional(text(1024, true)), defaultRuntime: optional(runtime),
  defaultProviderId: optional(text(128, true)), defaultModel: optional(text(128, true)),
  defaultPermissionMode: optional(permission), persistConversation: optional(boolean),
  confirmHighRisk: optional(boolean), workPanelWidth: optional(finite(260, 720)),
  terminalHeight: optional(finite(120, 560)), terminalShell: optional(oneOf('powershell', 'pwsh', 'cmd')),
});
const computerAction: Rule = (value) => {
  if (!isRecord(value)) return false;
  const common = { type: oneOf(value.type) };
  switch (value.type) {
    case 'screenshot': return fields(common)(value);
    case 'mouse_move': return fields({ ...common, x: integer(-32768, 32768), y: integer(-32768, 32768) })(value);
    case 'mouse_click': return fields({ ...common, x: integer(-32768, 32768), y: integer(-32768, 32768),
      button: optional(oneOf('left', 'right', 'middle')), clicks: optional(oneOf(1, 2)) })(value);
    case 'keyboard_type': return fields({ ...common, text: text(4096, false, true) })(value);
    case 'key_combo': return fields({ ...common, keys: list(text(32), 8, 1) })(value);
    default: return false;
  }
};

const contracts: Readonly<Record<string, Fields>> = {
  pick_project: {}, pick_cc_haha_source: {}, pick_skill_source: {}, refresh_runtimes: {},
  diagnostic_summary: {}, export_settings: {}, check_updates: {},
  computer_use_status: {}, computer_use_foreground: {}, computer_use_release: {},
  computer_use_acquire: session, computer_use_request: { action: computerAction }, computer_use_approve: { approvalId: id },
  scan_cc_haha_import: { sourcePath: text(4096) },
  import_cc_haha: { sourcePath: text(4096), sourceFingerprint: id, candidateIds: optional(list(id, 50)) },
  remove_project: project, pin_project: { ...project, pinned: boolean },
  recover_operation: { operationId: id, action: oneOf('diagnostics', 'abandon', 'retry') },
  poll_events: { afterSequence: optional(integer(0)) },
  create_session: { ...project, ...selection, runtimeType: optional(runtime) },
  fork_session: session, search_sessions: { ...project, query: text(200, true) },
  update_session_options: { ...session, ...selection },
  rename_session: { ...session, name: text(80) }, pin_session: { ...session, pinned: boolean }, archive_session: session,
  update_settings: { settings },
  save_provider: {
    id: optional(id), name: text(64),
    kind: oneOf('chatgpt', 'claude-native', 'openai', 'anthropic', 'deepseek', 'google', 'openrouter', 'xai', 'groq',
      'mistral', 'cerebras', 'together', 'zai', 'moonshot', 'minimax', 'fireworks', 'kimi', 'openai-compatible', 'anthropic-compatible'),
    apiFormat: optional(oneOf('chatgpt', 'claude-native', 'openai-completions', 'openai-responses', 'anthropic-messages',
      'google-generative-ai', 'mistral-conversations')),
    baseUrl: optional(text(4096, true)), models: optional(list(text(256), 512)),
    contextWindow: optional(integer(1)), maxTokens: optional(integer(1)),
    apiKey: optional(text(16384, true)), enabled: optional(boolean),
  },
  delete_provider: { providerId: id }, test_provider: { providerId: id }, list_provider_models: { providerId: id },
  list_mcp: { projectId: optional(id) },
  save_mcp: {
    id: optional(id), name: text(80), scope: optional(oneOf('user', 'project', 'local')), projectId: optional(id),
    transport: optional(oneOf('stdio', 'http', 'sse')), command: optional(text(1000)),
    args: optional(list(text(512, true), 64)), url: optional(text(4096)),
    envKeys: optional(list((value) => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,159}$/.test(value), 64)),
    enabled: optional(boolean),
  },
  delete_mcp: { id }, list_skills: project, skill_detail: { ...project, id },
  install_skill: { ...project, sourcePath: text(4096), name: optional(text(80)) },
  uninstall_skill: { ...project, name: text(80) }, list_memory: project,
  read_memory: { ...project, path }, save_memory: { ...project, path, content: bytes(512 * 1024, true) },
  activity: { sessionId: optional(id) }, stop_background_task: { taskId: id },
  list_scheduled_tasks: { projectId: optional(id) },
  save_scheduled_task: {
    id: optional(id), name: text(120), ...project, prompt: text(64000, false, true), intervalMinutes: optional(integer(5, 10080)),
    enabled: optional(boolean), runtimeType: optional(oneOf('codex', 'claude')),
    providerId: optional(id), model: optional(text(128)), permissionMode: optional(permission),
  },
  set_scheduled_task_enabled: { id, enabled: boolean }, delete_scheduled_task: { id }, run_scheduled_task: { id },
  export_diagnostic: { includeSensitivePreviews: optional(boolean) },
  open_worktree: session, list_files: { ...session, query: optional(text(4096, true)) },
  read_file: { ...session, path }, pick_attachments: session, codex_native: session, extension_health: session, github_status: project,
  create_team: { ...project, goal: text(8000, false, true), agents: list(fields({
    role: optional(text(80)), runtimeType: optional(runtime), providerId: optional(id), model: optional(text(128)),
  }), 4, 2) },
  team_message: { teamId: id, text: text(32000, false, true), sessionIds: optional(list(id, 4)) },
  team_retry_member: { teamId: id, ...session }, team_stop: { teamId: id },
  team_synthesize: { teamId: id, coordinatorSessionId: optional(id) },
  terminal_start: { ...session, columns: optional(integer(1, 1000)), rows: optional(integer(1, 1000)) },
  terminal_input: { ...session, data: bytes(8192) },
  terminal_resize: { ...session, columns: optional(integer(1, 1000)), rows: optional(integer(1, 1000)) }, terminal_stop: session,
  copy_text: { text: text(512000, true, true) }, open_url: { url: text(4096) },
  send_prompt: { ...session, text: text(64000, false, true) }, interrupt_turn: session,
  permission: { requestId: id, connectionEpoch: optional(integer(0)), decision: oneOf('allow_once', 'deny_once', 'cancel_turn') },
  list_checkpoints: session, create_checkpoint: { ...session, label: optional(text(200, true)) },
  preview_checkpoint: { ...session, checkpointId: id }, rewind_checkpoint: { ...session, checkpointId: id },
  git_status: session, git_diff: { ...session, path: optional(path) },
  integration_target: session, list_integrations: session,
  prepare_integration: { ...session, strategy: optional(oneOf('merge', 'rebase')), targetRef: optional(text(256)) },
  continue_interactive_integration: integration, promote_integration: integration, discard_integration: integration, open_integration: integration,
  stage: { ...session, paths: list(path, 2000, 1) }, unstage: { ...session, paths: list(path, 2000, 1) },
  commit: { ...session, subject: text(200) },
};

export const workspaceCommandTypes = Object.freeze(Object.keys(contracts));

export function validateWorkspaceCommand(value: unknown, options: { smoke?: boolean } = {}): Result {
  // Validate the value before JSON.stringify: Electron structured clone can carry
  // cycles, BigInt and non-JSON objects, none of which is a command envelope.
  try {
    if (!safeJson(value)) return failure('invalid_command', '命令格式无效');
  } catch { return failure('invalid_command', '命令格式无效'); }
  if (!isRecord(value) || typeof value.type !== 'string' || !value.type) return failure('invalid_command', '命令缺少类型');
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_WORKSPACE_COMMAND_BYTES) return failure('command_too_large', '命令超过大小限制');
  if (value.protocolVersion !== undefined && value.protocolVersion !== WORKSPACE_COMMAND_VERSION) {
    return failure('unsupported_command_version', 'Workspace 命令版本不兼容');
  }
  if (!options.smoke) {
    if (!Object.hasOwn(contracts, value.type)) return failure('unknown_command', 'Workspace 不支持该命令');
    if (!fields({ type: oneOf(value.type), protocolVersion: optional(oneOf(WORKSPACE_COMMAND_VERSION)), ...contracts[value.type] })(value)) {
      return failure('invalid_command', '命令参数无效');
    }
    if (value.type === 'save_mcp' && (
      ((value.scope === 'project' || value.scope === 'local') && !value.projectId)
      || ((value.transport ?? 'stdio') === 'stdio' ? !value.command : !value.url)
    )) return failure('invalid_command', 'MCP 参数不完整');
  }
  return { ok: true, command: value as Command };
}

type Source = { mainFrame: { url: string } };
type InvokeEvent = { sender: Source; senderFrame: { url: string } | null };

export function createWorkspaceCommandHandler<Event extends InvokeEvent>(
  options: { rendererUrl: string; source: () => Source | null; smoke?: boolean },
  execute: (event: Event, command: Command) => Promise<unknown>,
): (event: Event, value: unknown) => Promise<unknown> {
  return async (event, value) => {
    const source = options.source();
    if (!source || event.sender !== source || event.senderFrame !== source.mainFrame || event.senderFrame.url !== options.rendererUrl) {
      return failure('untrusted_command_source', 'Workspace 命令来源无效');
    }
    const result = validateWorkspaceCommand(value, options);
    return result.ok ? execute(event, result.command) : result;
  };
}

function failure(code: string, message: string): Failure { return { ok: false, code, message }; }
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function safeJson(value: unknown): boolean {
  let nodes = 0;
  let rawBytes = 0;
  const ancestors = new Set<object>();
  const visit = (item: unknown, depth: number): boolean => {
    if (++nodes > 12000 || depth > 8) return false;
    if (typeof item === 'string') { rawBytes += Buffer.byteLength(item); return rawBytes <= MAX_WORKSPACE_COMMAND_BYTES; }
    if (item === undefined || item === null || typeof item === 'boolean') return true;
    if (typeof item === 'number') return Number.isFinite(item);
    if (!Array.isArray(item) && !isRecord(item)) return false;
    if (ancestors.has(item)) return false;
    ancestors.add(item);
    const properties = Object.getOwnPropertyDescriptors(item);
    if (Array.isArray(item) && (Object.keys(properties).length !== item.length + 1
      || Object.keys(properties).some((key) => key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key)))) return false;
    if (Object.getOwnPropertySymbols(item).length) return false;
    for (const [key, descriptor] of Object.entries(properties)) {
      if (Array.isArray(item) && key === 'length') continue;
      rawBytes += Buffer.byteLength(key);
      if (rawBytes > MAX_WORKSPACE_COMMAND_BYTES || !Object.hasOwn(descriptor, 'value') || !visit(descriptor.value, depth + 1)) return false;
    }
    ancestors.delete(item);
    return true;
  };
  return visit(value, 0);
}
