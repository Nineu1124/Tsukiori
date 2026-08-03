import { app, BrowserWindow, clipboard, dialog, ipcMain, screen, shell, type OpenDialogOptions } from 'electron';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DAEMON_VERSION, HOST_PROTOCOL_VERSION } from '@tsukiori/protocol';
import { FakeRuntimeAdapter } from '@tsukiori/adapter-fake';
import { DaemonSupervisor } from './daemon-supervisor.js';
import { InteractiveWorkspace } from './interactive-workspace.js';
import { TerminalManager } from './terminal-manager.js';
import { ComputerUseManager, type ComputerUseAction } from './computer-use-manager.js';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const daemonEntry = app.isPackaged
  ? resolve(app.getAppPath(), 'dist', 'daemon', 'main.js')
  : resolve(currentDirectory, '..', '..', '..', 'daemon', 'dist', 'main.js');
const preloadEntry = resolve(currentDirectory, '..', 'preload', 'index.cjs');
const rendererEntry = resolve(currentDirectory, '..', 'renderer', 'index.html');
const smokeMode = process.env.TSUKIORI_DESKTOP_SMOKE === '1';
const captureDesktopPath = process.env.TSUKIORI_DESKTOP_CAPTURE_PATH;
const captureDesktopView = process.env.TSUKIORI_DESKTOP_CAPTURE_VIEW;
const captureSanitized = process.env.TSUKIORI_DESKTOP_CAPTURE_SANITIZED === '1';
const daemonExitPolicy = process.env.TSUKIORI_DAEMON_EXIT_POLICY === 'keep' ? 'keep' : 'stop';
const daemonLeaseFile = resolve(app.getPath('userData'), 'daemon-lease-v1.json');
const helperFileName = 'computer-use-helper.ps1';
const packagedComputerUseHelper = resolve(process.resourcesPath, 'app.asar.unpacked', 'dist', 'windows', helperFileName);
const sourceComputerUseHelper = resolve(currentDirectory, 'windows', helperFileName);
const compiledComputerUseHelper = resolve(currentDirectory, '..', 'windows', helperFileName);
const computerUseHelperPath = app.isPackaged
  ? packagedComputerUseHelper
  : existsSync(sourceComputerUseHelper) ? sourceComputerUseHelper : compiledComputerUseHelper;

const supervisor = new DaemonSupervisor({
  daemonEntry,
  executable: process.env.TSUKIORI_NODE_EXECUTABLE ?? process.execPath,
  expectedVersion: DAEMON_VERSION,
  leaseFile: daemonLeaseFile,
  exitPolicy: daemonExitPolicy,
});

const workspaceSnapshot = smokeMode ? {
  permissions: [{
    id: 'smoke-permission', title: '运行 Git 状态检查', description: '无破坏的结构化命令探测',
    category: 'shell', risk: 'low', scope: 'git status', enforcementLevel: 'interceptable',
  }],
  attention: [
    { id: 'smoke-attention-permission', kind: 'waiting_permission', status: 'open',
      title: '等待权限确认', sourceRef: 'smoke-permission',
      actions: [{ id: 'allow_once', label: '允许一次' }, { id: 'deny_once', label: '拒绝' }] },
    { id: 'smoke-attention-input', kind: 'waiting_input', status: 'open',
      title: '等待用户输入', sourceRef: 'question-smoke',
      actions: [{ id: 'answer_input', label: '提交输入' }] },
    { id: 'smoke-attention-completed', kind: 'completed', status: 'open',
      title: '上一轮已完成', sourceRef: 'turn-complete',
      actions: [{ id: 'review_diff', label: 'Review Diff' }] },
    { id: 'smoke-attention-failed', kind: 'failed', status: 'open',
      title: '失败事项示例', sourceRef: 'turn-failed', actions: [] },
  ],
  tools: [{ id: 'smoke-tool', title: 'Shell', summary: 'git status' }],
  runtimes: [{
    id: 'runtime-codex', runtimeType: 'codex', version: '0.146.0', state: 'ready',
    authenticated: true, authSource: 'chatgpt', requiresOpenaiAuth: true, compatibility: 'supported',
    nativeCapabilities: [
      { id: 'configuration', label: 'Codex 配置', supportLevel: 'supported',
        enforcementLevel: 'unknown', scope: 'runtime_native', summary: 'sandbox=workspace-write' },
      { id: 'mcp', label: 'MCP', supportLevel: 'experimental',
        enforcementLevel: 'unknown', scope: 'runtime_native', summary: 'experimental presentation fixture' },
      { id: 'skills', label: 'Skills', supportLevel: 'degraded',
        enforcementLevel: 'unknown', scope: 'runtime_native', summary: '1 parse error' },
      { id: 'sandbox', label: 'Sandbox', supportLevel: 'unsupported',
        enforcementLevel: 'unknown', scope: 'runtime_native', summary: 'readiness method unavailable' },
      { id: 'authentication', label: '认证来源', supportLevel: 'unknown',
        enforcementLevel: 'unknown', scope: 'runtime_native', summary: 'not verified' },
    ],
  }, {
    id: 'runtime-opencode', runtimeType: 'opencode', version: '1.18.4', state: 'ready',
    authenticated: true, authSource: 'apikey', compatibility: 'supported',
    providers: [{
      id: 'dpsk', name: 'DeepSeek', connected: true, destinationHost: 'api.deepseek.com',
      models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }],
    }],
    nativeCapabilities: [],
  }],
  workflow: {
    phase: 'review',
    project: { name: 'Local workspace', environment: 'Windows Native' },
    binding: { type: 'isolated-worktree', branch: 'agent/opencode/alpha' },
    runtime: { type: 'opencode', version: '1.18.4', provider: 'DeepSeek', model: 'deepseek-v4-flash',
      destinationHost: 'api.deepseek.com' },
    files: [{ path: 'alpha-runtime.txt', state: 'untracked', selected: true }],
    diff: { scope: 'working', content: '+ sanitized fake Runtime change' },
    actions: { stage: true, commit: true, archive: true, safeCleanup: false },
  },
  v1Git: {
    available: true,
    sourceSessionId: 'smoke-session',
    targetRef: 'main',
    strategy: 'merge',
    recoverySnapshot: 'required',
    integrationLocation: 'temporary-worktree',
    promotion: 'explicit-required',
    conflictOperationId: 'operation:smoke-conflict',
  },
  diagnostics: { available: true, defaultEstimatedBytes: 8192, sensitiveEstimatedBytes: 12288 },
} : { permissions: [], attention: [], tools: [], runtimes: [], workflow: null, v1Git: null, diagnostics: null };
let quitting = false;
let smokeCommandCount = 0;
let interactiveWorkspace: InteractiveWorkspace | null = null;
const terminalManager = new TerminalManager((event) => {
  interactiveWorkspace?.publishLocalEvent(event.sessionId, event.type, event.payload);
});
const computerUse = new ComputerUseManager({
  helperPath: computerUseHelperPath,
  userDataPath: app.getPath('userData'),
});

function createWindow(): BrowserWindow {
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.min(1600, Math.max(1040, workArea.width - 32));
  const height = Math.min(1000, Math.max(720, workArea.height - 32));
  const window = new BrowserWindow({
    width,
    height,
    minWidth: 1040,
    minHeight: 720,
    show: !smokeMode,
    backgroundColor: '#f5fbff',
    autoHideMenuBar: true,
    icon: resolve(currentDirectory, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: preloadEntry,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      devTools: false,
    },
  });
  window.center();

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) {
      event.preventDefault();
    }
  });
  void window.loadFile(rendererEntry);
  return window;
}

async function runSmoke(window: BrowserWindow): Promise<void> {
  const fakeRuntime = new FakeRuntimeAdapter();
  const fakeSession = fakeRuntime.createSession();
  fakeRuntime.runScript(fakeSession, [{ kind: 'event', nativeType: 'message.started', payload: { sanitized: true } }]);
  await new Promise<void>((resolveLoad, rejectLoad) => {
    window.webContents.once('did-finish-load', () => resolveLoad());
    window.webContents.once('did-fail-load', (_event, code, description) => {
      rejectLoad(new Error('Renderer failed to load: ' + code + ' ' + description));
    });
  });

  const rendererState = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    let attempts = 0;
    const timer = setInterval(() => {
      const permissionCards = document.querySelectorAll('.permission-card').length;
      if (permissionCards > 0) {
        clearInterval(timer);
        resolve({
          permissionCards,
          toolCards: document.querySelectorAll('.tool-card').length,
          attentionItems: document.querySelectorAll('.attention-item').length,
          permissionCategory: document.querySelector('[data-field="category"]')?.textContent,
          enforcementLevel: document.querySelector('.permission-card [data-field="enforcement"]')?.textContent,
          runtimeCards: document.querySelectorAll('.runtime-card').length,
          runtimeAuthSource: document.querySelector('.runtime-card [data-field="authSource"]')?.textContent,
          runtimeCompatibility: document.querySelector('.runtime-card [data-field="compatibility"]')?.textContent,
          nativeCapabilityRows: document.querySelectorAll('.native-capability').length,
          nativeCapabilityLevels: [...document.querySelectorAll('.native-capability [data-field="supportLevel"]')]
            .map((element) => element.textContent),
          nativeCapabilityScopes: [...document.querySelectorAll('.native-capability [data-field="enforcement"]')]
            .map((element) => element.textContent?.split(' · ')[0]),
          sandboxEnforcement: document.querySelector(
            '.native-capability[data-capability="sandbox"] [data-field="enforcement"]',
          )?.textContent,
          openCodeProvider: document.querySelector(
            '.provider-panel[data-provider-id="dpsk"] [data-field="providerSelect"]',
          )?.value,
          openCodeModel: document.querySelector(
            '.provider-panel[data-provider-id="dpsk"] [data-field="modelSelect"]',
          )?.value,
          openCodeDestination: document.querySelector(
            '.provider-panel[data-provider-id="dpsk"] [data-field="destinationHost"]',
          )?.textContent,
          modelRequestStarted: document.querySelector(
            '.provider-panel[data-provider-id="dpsk"]',
          )?.dataset.modelRequestStarted,
          modelRequestState: document.querySelector(
            '.provider-panel[data-provider-id="dpsk"] [data-field="modelRequestState"]',
          )?.textContent,
          alphaVisible: document.querySelector('#alpha-workflow')?.hidden === false,
          alphaPhase: document.querySelector('#alpha-workflow [data-field="phase"]')?.textContent,
          alphaDestination: document.querySelector('#alpha-workflow [data-field="alphaDestination"]')?.textContent,
          workflowSteps: document.querySelectorAll('#alpha-workflow [data-step]').length,
          changedFiles: document.querySelectorAll('#alpha-workflow [data-field="changedFiles"] li').length,
          alphaActionNames: [...document.querySelectorAll('#alpha-workflow [data-action]')]
            .map((element) => element.dataset.action),
          attentionKinds: [...document.querySelectorAll('.attention-item')]
            .map((element) => [...element.classList].find((name) => name !== 'attention-item')),
          prohibitedActionCount: document.querySelectorAll(
            '[data-action="merge"],[data-runtime="claude"],[data-runtime="acp"],[data-platform]',
          ).length,
          v1GitVisible: document.querySelector('#v1-git-workflow')?.hidden === false,
          v1GitActions: [...document.querySelectorAll('#v1-git-workflow [data-v1-action]')]
            .map((element) => element.dataset.v1Action),
          recoverySnapshot: document.querySelector('#v1-git-workflow [data-field="recoverySnapshot"]')?.textContent,
          integrationLocation: document.querySelector('#v1-git-workflow [data-field="integrationLocation"]')?.textContent,
        });
      } else if (++attempts >= 40) {
        clearInterval(timer);
        reject(new Error('Renderer workspace snapshot did not become visible'));
      }
    }, 50);
  })`, true) as Record<string, unknown>;
  const alphaCommandResult = await window.webContents.executeJavaScript(
    `window.tsukiori.workspace.stage(['alpha-runtime.txt'])`,
    true,
  ) as Record<string, unknown>;
  const integrationCommandResult = await window.webContents.executeJavaScript(
    `window.tsukiori.workspace.integrate('smoke-session', 'main', 'merge')`,
    true,
  ) as Record<string, unknown>;
  const editorCommandResult = await window.webContents.executeJavaScript(
    `window.tsukiori.workspace.openExternalEditor('operation:smoke-conflict')`,
    true,
  ) as Record<string, unknown>;
  const crash = new Promise<Electron.RenderProcessGoneDetails>((resolveCrash) => {
    window.webContents.once('render-process-gone', (_event, details) => resolveCrash(details));
  });
  window.webContents.forcefullyCrashRenderer();
  const details = await crash;
  const status = await supervisor.probe();

  process.stdout.write(
    'TSUKIORI_DESKTOP_SMOKE_RESULT ' +
      JSON.stringify({
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        rendererGoneReason: details.reason,
        daemonAliveAfterRendererCrash: supervisor.snapshot().state === 'running',
        fakeRuntimeAliveAfterRendererCrash: fakeSession.activity === 'running' && fakeSession.health === 'healthy',
        fakeRuntimeEventCount: fakeRuntime.events.length,
        rendererState,
        alphaCommandResult,
        integrationCommandResult,
        editorCommandResult,
        smokeCommandCount,
        daemonVersion: status.daemonVersion,
        protocolVersion: status.protocolVersion,
      }) +
      '\n',
  );

  await supervisor.stop();
  quitting = true;
  app.quit();
}

ipcMain.handle('host:versions', () => ({
  desktop: app.getVersion(),
  daemon: DAEMON_VERSION,
  protocol: HOST_PROTOCOL_VERSION,
}));

ipcMain.handle('workspace:snapshot', () => smokeMode ? workspaceSnapshot : interactiveWorkspace?.snapshot());
ipcMain.handle('workspace:command', async (event, value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, code: 'invalid_command', message: '命令格式无效' };
  }
  const command = value as Record<string, unknown>;
  if (typeof command.type !== 'string' || Buffer.byteLength(JSON.stringify(command)) > 128 * 1024) {
    return { ok: false, code: 'invalid_command', message: '命令过大或缺少类型' };
  }
  if (smokeMode) {
    const allowed = new Set([
      'stage', 'unstage', 'revert', 'commit', 'archive', 'permission', 'answer_input',
      'integrate', 'continue_integration', 'open_external_editor', 'export_diagnostic',
      'computer_use_status', 'computer_use_foreground', 'computer_use_acquire',
      'computer_use_release', 'computer_use_request', 'computer_use_approve',
    ]);
    if (!allowed.has(command.type)) return { ok: false, code: 'invalid_command' };
    smokeCommandCount += 1;
    if (command.type === 'computer_use_status') return {
      ok: true,
      computerUse: {
        supportLevel: 'supported', enforcementLevel: 'interceptable', locked: false,
        message: 'Smoke Fixture：Computer Use 需要显式锁定和逐次确认',
      },
    };
    if (command.type === 'computer_use_foreground') return {
      ok: true,
      foreground: { pid: 4242, name: 'fixture-app.exe', startTime: 1, titleHash: 'fixture-title' },
    };
    return { ok: true, command: command.type, sequence: smokeCommandCount };
  }
  const workspace = interactiveWorkspace;
  if (!workspace) return { ok: false, code: 'workspace_unavailable', message: 'Workspace 尚未初始化' };
  try {
    const ownerId = String(event.sender.id);
    if (command.type === 'computer_use_status') return {
      ok: true,
      computerUse: await computerUse.status(ownerId),
    };
    if (command.type === 'computer_use_foreground') return {
      ok: true,
      foreground: await computerUse.foreground(),
    };
    if (command.type === 'computer_use_acquire') {
      const sessionId = String(command.sessionId ?? '');
      workspace.sessionWorktree(sessionId);
      return { ok: true, computerUse: await computerUse.acquire(ownerId, sessionId) };
    }
    if (command.type === 'computer_use_release') return { ok: true, computerUse: computerUse.release(ownerId) };
    if (command.type === 'computer_use_request') return {
      ok: true,
      approval: computerUse.requestAction(ownerId, object(command.action) as unknown as ComputerUseAction),
    };
    if (command.type === 'computer_use_approve') return {
      ok: true,
      result: await computerUse.approveAction(ownerId, String(command.approvalId ?? '')),
    };
    if (command.type === 'pick_project') {
      const owner = BrowserWindow.fromWebContents(event.sender);
      const options: OpenDialogOptions = { title: '选择本地 Git 项目', properties: ['openDirectory'] };
      const selection = owner
        ? await dialog.showOpenDialog(owner, options)
        : await dialog.showOpenDialog(options);
      if (selection.canceled || !selection.filePaths[0]) return { ok: true, canceled: true };
      return { ok: true, project: workspace.addProject(selection.filePaths[0]) };
    }
    if (command.type === 'remove_project') {
      workspace.removeProject(String(command.projectId ?? ''));
      return { ok: true };
    }
    if (command.type === 'refresh_runtimes') return { ok: true, runtime: workspace.refreshRuntimes() };
    if (command.type === 'poll_events') return {
      ok: true,
      ...workspace.pollEvents(Number(command.afterSequence ?? 0)),
    };
    if (command.type === 'create_session') {
      return { ok: true, session: await workspace.createSession(String(command.projectId ?? ''), {
        ...(typeof command.runtimeType === 'string' ? { runtimeType: command.runtimeType as 'codex' | 'claude' } : {}),
        ...(typeof command.providerId === 'string' ? { providerId: command.providerId } : {}),
        ...(typeof command.model === 'string' ? { model: command.model } : {}),
        ...(typeof command.permissionMode === 'string' ? { permissionMode: command.permissionMode as 'manual' | 'plan' | 'acceptEdits' | 'dontAsk' } : {}),
      }) };
    }
    if (command.type === 'update_session_options') return {
      ok: true,
      session: await workspace.updateSessionOptions(String(command.sessionId ?? ''), {
        ...(typeof command.providerId === 'string' ? { providerId: command.providerId } : {}),
        ...(typeof command.model === 'string' ? { model: command.model } : {}),
        ...(typeof command.permissionMode === 'string' ? { permissionMode: command.permissionMode } : {}),
      }),
    };
    if (command.type === 'rename_session') return {
      ok: true, session: workspace.renameSession(String(command.sessionId ?? ''), String(command.name ?? '')),
    };
    if (command.type === 'pin_session') return {
      ok: true, session: workspace.pinSession(String(command.sessionId ?? ''), command.pinned === true),
    };
    if (command.type === 'archive_session') return {
      ok: true, session: workspace.archiveSession(String(command.sessionId ?? '')),
    };
    if (command.type === 'update_settings') return {
      ok: true,
      settings: workspace.updateSettings(object(command.settings)),
    };
    if (command.type === 'save_provider') return {
      ok: true,
      provider: workspace.saveProvider({
        ...(typeof command.id === 'string' ? { id: command.id } : {}),
        name: String(command.name ?? ''),
        kind: String(command.kind ?? '') as 'chatgpt' | 'openai' | 'anthropic' | 'deepseek' | 'openai-compatible' | 'anthropic-compatible',
        ...(typeof command.baseUrl === 'string' ? { baseUrl: command.baseUrl } : {}),
        ...(Array.isArray(command.models) ? { models: command.models.map(String) } : {}),
        ...(typeof command.apiKey === 'string' ? { apiKey: command.apiKey } : {}),
        ...(typeof command.enabled === 'boolean' ? { enabled: command.enabled } : {}),
      }),
    };
    if (command.type === 'delete_provider') {
      workspace.deleteProvider(String(command.providerId ?? ''));
      return { ok: true };
    }
    if (command.type === 'test_provider') return {
      ok: true,
      test: await workspace.testProvider(String(command.providerId ?? '')),
    };
    if (command.type === 'list_provider_models') return {
      ok: true,
      ...(await workspace.listProviderModels(String(command.providerId ?? ''))),
    };
    if (command.type === 'list_mcp') return { ok: true, servers: workspace.listMcp(typeof command.projectId === 'string' ? command.projectId : undefined) };
    if (command.type === 'save_mcp') return {
      ok: true,
      server: workspace.saveMcp({
        ...(typeof command.id === 'string' ? { id: command.id } : {}),
        name: String(command.name ?? ''),
        scope: String(command.scope ?? 'user') as 'user' | 'project' | 'local',
        ...(typeof command.projectId === 'string' ? { projectId: command.projectId } : {}),
        transport: String(command.transport ?? 'stdio') as 'stdio' | 'http' | 'sse',
        ...(typeof command.command === 'string' ? { command: command.command } : {}),
        args: Array.isArray(command.args) ? command.args.map(String) : [],
        ...(typeof command.url === 'string' ? { url: command.url } : {}),
        envKeys: Array.isArray(command.envKeys) ? command.envKeys.map(String) : [],
        enabled: command.enabled !== false,
      }),
    };
    if (command.type === 'delete_mcp') { workspace.deleteMcp(String(command.id ?? '')); return { ok: true }; }
    if (command.type === 'list_skills') return { ok: true, skills: workspace.listSkills(String(command.projectId ?? '')) };
    if (command.type === 'skill_detail') return { ok: true, skill: workspace.skillDetail(String(command.projectId ?? ''), String(command.id ?? '')) };
    if (command.type === 'pick_skill_source') {
      const owner = BrowserWindow.fromWebContents(event.sender);
      const selection = owner
        ? await dialog.showOpenDialog(owner, { title: '选择本地 Skill 文件夹', properties: ['openDirectory'] })
        : await dialog.showOpenDialog({ title: '选择本地 Skill 文件夹', properties: ['openDirectory'] });
      return selection.canceled || !selection.filePaths[0] ? { ok: true, canceled: true } : { ok: true, sourcePath: selection.filePaths[0] };
    }
    if (command.type === 'install_skill') return { ok: true, skill: workspace.installSkill(String(command.projectId ?? ''), String(command.sourcePath ?? ''), typeof command.name === 'string' ? command.name : undefined) };
    if (command.type === 'uninstall_skill') { workspace.uninstallSkill(String(command.projectId ?? ''), String(command.name ?? '')); return { ok: true }; }
    if (command.type === 'list_memory') return { ok: true, files: workspace.listMemory(String(command.projectId ?? '')) };
    if (command.type === 'read_memory') return { ok: true, file: workspace.readMemory(String(command.projectId ?? ''), String(command.path ?? '')) };
    if (command.type === 'save_memory') return { ok: true, file: workspace.saveMemory(String(command.projectId ?? ''), String(command.path ?? ''), String(command.content ?? '')) };
    if (command.type === 'activity') return { ok: true, activity: workspace.activity(typeof command.sessionId === 'string' ? command.sessionId : undefined) };
    if (command.type === 'stop_background_task') { await workspace.stopBackgroundTask(String(command.taskId ?? '')); return { ok: true }; }
    if (command.type === 'list_scheduled_tasks') return { ok: true, tasks: workspace.listScheduledTasks(typeof command.projectId === 'string' ? command.projectId : undefined) };
    if (command.type === 'save_scheduled_task') return {
      ok: true,
      task: workspace.saveScheduledTask({
        ...(typeof command.id === 'string' ? { id: command.id } : {}),
        name: String(command.name ?? ''), projectId: String(command.projectId ?? ''), prompt: String(command.prompt ?? ''), intervalMinutes: Number(command.intervalMinutes ?? 60),
        enabled: command.enabled === true,
        ...(command.runtimeType === 'claude' || command.runtimeType === 'codex' ? { runtimeType: command.runtimeType } : {}),
        ...(typeof command.providerId === 'string' ? { providerId: command.providerId } : {}),
        ...(typeof command.model === 'string' ? { model: command.model } : {}),
        ...(typeof command.permissionMode === 'string' ? { permissionMode: command.permissionMode as 'manual' | 'plan' | 'acceptEdits' | 'dontAsk' } : {}),
      }),
    };
    if (command.type === 'set_scheduled_task_enabled') return { ok: true, task: workspace.setScheduledTaskEnabled(String(command.id ?? ''), command.enabled === true) };
    if (command.type === 'delete_scheduled_task') { workspace.deleteScheduledTask(String(command.id ?? '')); return { ok: true }; }
    if (command.type === 'run_scheduled_task') return { ok: true, task: await workspace.runScheduledTask(String(command.id ?? '')) };
    if (command.type === 'diagnostic_summary') return { ok: true, diagnostic: workspace.diagnosticSummary() };
    if (command.type === 'export_diagnostic') {
      const owner = BrowserWindow.fromWebContents(event.sender);
      const selection = owner
        ? await dialog.showSaveDialog(owner, { title: '导出脱敏诊断包', defaultPath: 'tsukiori-diagnostic.json', filters: [{ name: 'JSON', extensions: ['json'] }] })
        : await dialog.showSaveDialog({ title: '导出脱敏诊断包', defaultPath: 'tsukiori-diagnostic.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
      if (selection.canceled || !selection.filePath) return { ok: true, canceled: true };
      writeFileSync(selection.filePath, JSON.stringify(workspace.diagnosticSummary(), null, 2), { encoding: 'utf8', mode: 0o600 });
      return { ok: true, exported: true };
    }
    if (command.type === 'export_settings') {
      const owner = BrowserWindow.fromWebContents(event.sender);
      const selection = owner
        ? await dialog.showSaveDialog(owner, { title: '导出脱敏设置', defaultPath: 'tsukiori-settings.json', filters: [{ name: 'JSON', extensions: ['json'] }] })
        : await dialog.showSaveDialog({ title: '导出脱敏设置', defaultPath: 'tsukiori-settings.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
      if (selection.canceled || !selection.filePath) return { ok: true, canceled: true };
      writeFileSync(selection.filePath, workspace.exportSanitizedSettings(), { encoding: 'utf8', mode: 0o600 });
      return { ok: true, exported: true };
    }
    if (command.type === 'open_worktree') {
      const snapshot = workspace.snapshot();
      const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions as Array<Record<string, unknown>> : [];
      const session = sessions.find((item) => item.id === String(command.sessionId ?? ''));
      if (!session || typeof session.worktreePath !== 'string') throw new Error('Session Worktree 不存在');
      const failure = await shell.openPath(session.worktreePath);
      if (failure) throw new Error('无法打开 Worktree');
      return { ok: true };
    }
    if (command.type === 'list_files') return {
      ok: true,
      files: workspace.listFiles(String(command.sessionId ?? ''), typeof command.query === 'string' ? command.query : ''),
    };
    if (command.type === 'read_file') return {
      ok: true,
      file: workspace.readTextFile(String(command.sessionId ?? ''), String(command.path ?? '')),
    };
    if (command.type === 'pick_attachments') {
      const sessionId = String(command.sessionId ?? '');
      workspace.sessionWorktree(sessionId);
      const owner = BrowserWindow.fromWebContents(event.sender);
      const options: OpenDialogOptions = {
        title: '添加到 Session Worktree', properties: ['openFile', 'multiSelections'],
        filters: [
          { name: '常用文件', extensions: ['md', 'txt', 'json', 'yaml', 'yml', 'toml', 'csv', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'pdf'] },
          { name: '全部文件', extensions: ['*'] },
        ],
      };
      const selection = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
      if (selection.canceled) return { ok: true, canceled: true, attachments: [] };
      return { ok: true, attachments: workspace.attachFiles(sessionId, selection.filePaths) };
    }
    if (command.type === 'codex_native') return {
      ok: true,
      native: await workspace.codexNativeCapabilities(String(command.sessionId ?? '')),
    };
    if (command.type === 'github_status') return {
      ok: true, status: workspace.githubStatus(String(command.projectId ?? '')),
    };
    if (command.type === 'check_updates') {
      const response = await fetch('https://api.github.com/repos/Nineu1124/Tsukiori/releases/latest', {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Tsukiori/' + app.getVersion() },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(response.status === 404 ? '尚未发布公开 Release' : `更新检查失败（HTTP ${response.status}）`);
      const release = object(await response.json());
      const latest = String(release.tag_name ?? '').replace(/^v/i, '');
      const url = String(release.html_url ?? '');
      if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(latest) || !url.startsWith('https://github.com/')) throw new Error('Release 元数据无效');
      return { ok: true, update: { current: app.getVersion(), latest, available: compareVersions(latest, app.getVersion()) > 0, url } };
    }
    if (command.type === 'create_team') return {
      ok: true,
      team: await workspace.createTeam(
        String(command.projectId ?? ''), String(command.goal ?? ''),
        Array.isArray(command.agents) ? command.agents.map(object) : [],
      ),
    };
    if (command.type === 'terminal_start') {
      const sessionId = String(command.sessionId ?? '');
      terminalManager.start(sessionId, workspace.sessionWorktree(sessionId), Number(command.columns ?? 120), Number(command.rows ?? 28), workspace.terminalShell());
      return { ok: true };
    }
    if (command.type === 'terminal_input') {
      terminalManager.write(String(command.sessionId ?? ''), String(command.data ?? ''));
      return { ok: true };
    }
    if (command.type === 'terminal_resize') {
      terminalManager.resize(String(command.sessionId ?? ''), Number(command.columns ?? 120), Number(command.rows ?? 28));
      return { ok: true };
    }
    if (command.type === 'terminal_stop') {
      await terminalManager.stop(String(command.sessionId ?? ''));
      return { ok: true };
    }
    if (command.type === 'copy_text') {
      const text = String(command.text ?? '');
      if (text.length > 512_000 || text.includes('\0')) throw new Error('复制内容无效');
      clipboard.writeText(text);
      return { ok: true };
    }
    if (command.type === 'open_url') {
      const url = new URL(String(command.url ?? ''));
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('只允许无内嵌认证的 HTTP/HTTPS 地址');
      await shell.openExternal(url.toString(), { activate: true });
      return { ok: true };
    }
    if (command.type === 'send_prompt') {
      return { ok: true, ...(await workspace.sendPrompt(
        String(command.sessionId ?? ''), String(command.text ?? ''),
      )) };
    }
    if (command.type === 'interrupt_turn') {
      await workspace.interrupt(String(command.sessionId ?? ''));
      return { ok: true };
    }
    if (command.type === 'permission') {
      const decision = String(command.decision ?? '');
      if (!['allow_once', 'deny_once', 'cancel_turn'].includes(decision)) throw new Error('权限决策无效');
      workspace.decidePermission(
        String(command.requestId ?? ''),
        decision as 'allow_once' | 'deny_once' | 'cancel_turn',
      );
      return { ok: true };
    }
    if (command.type === 'git_status') return { ok: true, git: workspace.gitStatus(String(command.sessionId ?? '')) };
    if (command.type === 'git_diff') return {
      ok: true,
      diff: workspace.gitDiff(
        String(command.sessionId ?? ''),
        typeof command.path === 'string' ? command.path : undefined,
      ),
    };
    if (command.type === 'stage' || command.type === 'unstage') {
      const paths = Array.isArray(command.paths) ? command.paths.map(String) : [];
      if (command.type === 'stage') workspace.stage(String(command.sessionId ?? ''), paths);
      else workspace.unstage(String(command.sessionId ?? ''), paths);
      return { ok: true };
    }
    if (command.type === 'commit') {
      return { ok: true, sha: workspace.commit(String(command.sessionId ?? ''), String(command.subject ?? '')) };
    }
    return { ok: false, code: 'unsupported_command', message: '该操作尚未接入真实 Workspace' };
  } catch (error) {
    return { ok: false, code: 'command_failed', message: error instanceof Error ? error.message : String(error) };
  }
});
ipcMain.handle('daemon:status', async () => {
  const status = await supervisor.probe();
  return {
    state: 'running',
    daemonVersion: status.daemonVersion,
    protocolVersion: status.protocolVersion,
    instanceId: status.instanceId,
  };
});

app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  void Promise.allSettled([
    supervisor.release(),
    interactiveWorkspace?.shutdown() ?? Promise.resolve(),
    terminalManager.shutdown(),
    Promise.resolve(computerUse.shutdown()),
  ]).finally(() => app.quit());
});

app.whenReady()
  .then(async () => {
    await supervisor.start();
    const window = createWindow();
    if (!smokeMode) {
      interactiveWorkspace = new InteractiveWorkspace({
        userDataPath: app.getPath('userData'),
        emit: () => undefined,
      });
    }
    if (captureDesktopPath) {
      window.webContents.once('did-finish-load', () => {
        setTimeout(() => {
          void (async () => {
            await window.webContents.executeJavaScript("document.body.classList.add('reduce-motion')", true);
            if (captureDesktopView === 'compact') {
              window.setSize(1040, 720);
              window.center();
              await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
            }
            if (captureDesktopView?.startsWith('settings')) {
              await window.webContents.executeJavaScript("document.querySelector('#settings-dialog')?.showModal()", true);
              await new Promise((resolveDelay) => setTimeout(resolveDelay, 350));
              const settingsPage = captureDesktopView.slice('settings-'.length);
              if (settingsPage && settingsPage !== captureDesktopView) {
                await window.webContents.executeJavaScript(
                  `document.querySelector('[data-settings-page=${JSON.stringify(settingsPage)}]')?.click()`,
                  true,
                );
                await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
              }
            }
            if (captureDesktopView === 'team') {
              await window.webContents.executeJavaScript("document.querySelector('#new-team')?.click(); if(!document.querySelector('#team-dialog')?.open) document.querySelector('#team-dialog')?.showModal()", true);
              await new Promise((resolveDelay) => setTimeout(resolveDelay, 350));
            }
            if (captureDesktopView === 'files') {
              await window.webContents.executeJavaScript("document.querySelector('[data-panel-tab=files]')?.click()", true);
              await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
            }
            if (captureSanitized) {
              await window.webContents.executeJavaScript(`(() => {
                const path = document.querySelector('#session-context-path');
                if (path) path.textContent = 'D:\\\\Projects\\\\tsukiori-academy\\\\.tsukiori\\\\session-a1b2c3d4';
                const title = document.querySelector('#interactive-title');
                if (title) title.textContent = '实现登录接口与权限校验';
                const eyebrow = document.querySelector('#interactive-eyebrow');
                if (eyebrow) eyebrow.textContent = 'tsukiori-academy / agent/auth-jwt';
              })()`, true);
            }
            const captureDiagnostic = await window.webContents.executeJavaScript(`({
              captureView: ${JSON.stringify(captureDesktopView ?? null)},
              bodyClass: document.body.className,
              viewport: [innerWidth, innerHeight, devicePixelRatio],
              shell: (() => { const e=document.querySelector('.app-shell'); const r=e?.getBoundingClientRect(); return [r?.x,r?.y,r?.width,r?.height,getComputedStyle(e).display,getComputedStyle(e).gridTemplateColumns]; })(),
              rail: (() => { const e=document.querySelector('.session-rail'); const r=e?.getBoundingClientRect(); return [r?.x,r?.y,r?.width,r?.height,getComputedStyle(e).display,getComputedStyle(e).visibility]; })(),
              workspace: (() => { const e=document.querySelector('.workspace'); const r=e?.getBoundingClientRect(); return [r?.x,r?.y,r?.width,r?.height,getComputedStyle(e).display,getComputedStyle(e).visibility]; })(),
              status: document.querySelector('#status')?.textContent,
              settingsOpen: document.querySelector('#settings-dialog')?.open,
              teamOpen: document.querySelector('#team-dialog')?.open,
              settingsBox: (() => { const e=document.querySelector('#settings-dialog'); const r=e?.getBoundingClientRect(); return [r?.x,r?.y,r?.width,r?.height,getComputedStyle(e).display,getComputedStyle(e).opacity,getComputedStyle(e).transform]; })(),
            })`, true);
            process.stdout.write('TSUKIORI_CAPTURE_DIAGNOSTIC ' + JSON.stringify(captureDiagnostic) + '\n');
            const image = await window.webContents.capturePage();
            writeFileSync(captureDesktopPath, image.toPNG());
            await Promise.allSettled([
              supervisor.release('stop'),
              interactiveWorkspace?.shutdown() ?? Promise.resolve(),
            ]);
            quitting = true;
            app.quit();
          })();
        }, 2_000).unref();
      });
    }
    if (smokeMode) {
      await runSmoke(window);
    }
  })
  .catch(async (error: unknown) => {
    process.stderr.write(String(error) + '\n');
    await supervisor.stop(true).catch(() => undefined);
    app.exit(1);
  });

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function compareVersions(left: string, right: string): number {
  const a = left.replace(/^v/i, '').split(/[.+-]/).slice(0, 3).map((part) => Number(part) || 0);
  const b = right.replace(/^v/i, '').split(/[.+-]/).slice(0, 3).map((part) => Number(part) || 0);
  for (let index = 0; index < 3; index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}
