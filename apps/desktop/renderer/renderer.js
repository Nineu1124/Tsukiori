const status = document.querySelector('#status');
const daemonDot = document.querySelector('#daemon-dot');
const version = document.querySelector('#version');
const attentionList = document.querySelector('#attention-list');
const attentionCount = document.querySelector('#attention-count');
const permissionList = document.querySelector('#permission-list');
const toolList = document.querySelector('#tool-list');
const runtimeList = document.querySelector('#runtime-list');
const alphaWorkflow = document.querySelector('#alpha-workflow');
const v1GitWorkflow = document.querySelector('#v1-git-workflow');
const diagnosticBundle = document.querySelector('#diagnostic-bundle');

function setField(root, name, value) {
  const target = root.querySelector('[data-field="' + name + '"]');
  if (target) target.textContent = String(value ?? '—');
}

function renderPermission(permission) {
  const template = document.querySelector('#permission-card-template');
  const card = template.content.firstElementChild.cloneNode(true);
  setField(card, 'title', permission.title);
  setField(card, 'description', permission.description);
  setField(card, 'category', permission.category);
  setField(card, 'risk', permission.risk);
  setField(card, 'scope', permission.scope);
  setField(card, 'enforcement', permission.enforcementLevel);
  const [deny, allow] = card.querySelectorAll('.permission-actions button');
  deny.addEventListener('click', () => runAction(deny, () => window.tsukiori.workspace.decidePermission(
    permission.id, permission.connectionEpoch, 'deny_once',
  )));
  allow.addEventListener('click', () => runAction(allow, () => window.tsukiori.workspace.decidePermission(
    permission.id, permission.connectionEpoch, 'allow_once',
  )));
  permissionList.append(card);
}

function renderTool(tool) {
  const template = document.querySelector('#tool-card-template');
  const card = template.content.firstElementChild.cloneNode(true);
  setField(card, 'title', tool.title);
  setField(card, 'summary', tool.summary);
  toolList.append(card);
}

function renderNativeCapability(list, capability) {
  const item = document.createElement('li');
  item.className = 'native-capability support-' + capability.supportLevel;
  item.dataset.capability = String(capability.id ?? 'unknown');

  const heading = document.createElement('div');
  const label = document.createElement('strong');
  label.textContent = String(capability.label ?? capability.id ?? 'Unknown capability');
  const support = document.createElement('span');
  support.className = 'support-level';
  support.dataset.field = 'supportLevel';
  support.textContent = String(capability.supportLevel ?? 'unknown');
  heading.append(label, support);

  const detail = document.createElement('small');
  detail.textContent = String(capability.summary ?? '—');
  const boundary = document.createElement('small');
  boundary.className = 'capability-boundary';
  boundary.dataset.field = 'enforcement';
  boundary.textContent = String(capability.scope ?? 'runtime_native')
    + ' · enforcement=' + String(capability.enforcementLevel ?? 'unknown');

  item.append(heading, detail, boundary);
  list.append(item);
}

function appendOption(select, value, label) {
  const option = document.createElement('option');
  option.value = String(value);
  option.textContent = String(label);
  select.append(option);
}

function renderProviderSelection(card, runtime) {
  const providers = runtime.providers ?? [];
  if (providers.length === 0) return;
  const panel = card.querySelector('[data-field="providerPanel"]');
  const providerSelect = card.querySelector('[data-field="providerSelect"]');
  const modelSelect = card.querySelector('[data-field="modelSelect"]');
  const destination = card.querySelector('[data-field="destinationHost"]');
  const requestState = card.querySelector('[data-field="modelRequestState"]');
  panel.hidden = false;
  panel.dataset.modelRequestStarted = 'false';

  for (const provider of providers) {
    appendOption(providerSelect, provider.id, provider.name ?? provider.id);
  }
  const updateProvider = () => {
    const provider = providers.find((item) => item.id === providerSelect.value) ?? providers[0];
    modelSelect.textContent = '';
    for (const model of provider?.models ?? []) {
      appendOption(modelSelect, model.id, model.name ?? model.id);
    }
    destination.textContent = String(provider?.destinationHost ?? 'unknown');
    panel.dataset.providerId = String(provider?.id ?? 'unknown');
    panel.dataset.destinationHost = String(provider?.destinationHost ?? 'unknown');
    panel.dataset.modelId = String(modelSelect.value || 'unknown');
    requestState.textContent = '模型请求尚未启动';
  };
  providerSelect.addEventListener('change', updateProvider);
  modelSelect.addEventListener('change', () => {
    panel.dataset.modelId = String(modelSelect.value || 'unknown');
  });
  updateProvider();
}

function renderRuntime(runtime) {
  const template = document.querySelector('#runtime-card-template');
  const card = template.content.firstElementChild.cloneNode(true);
  setField(card, 'runtimeType', runtime.runtimeType);
  setField(card, 'version', runtime.version);
  setField(card, 'state', runtime.state);
  setField(card, 'authSource', runtime.authenticated ? runtime.authSource : '未登录');
  setField(card, 'compatibility', runtime.compatibility);
  const capabilityList = card.querySelector('[data-field="nativeCapabilities"]');
  for (const capability of runtime.nativeCapabilities ?? []) {
    renderNativeCapability(capabilityList, capability);
  }
  renderProviderSelection(card, runtime);
  runtimeList.append(card);
}
async function runAction(button, operation) {
  const original = button.textContent;
  button.disabled = true;
  try {
    const result = await operation();
    button.textContent = result?.ok === false ? '不可用' : '已提交';
  } catch {
    button.textContent = '操作失败';
  } finally {
    setTimeout(() => { button.disabled = false; button.textContent = original; }, 800);
  }
}

function renderAlphaWorkflow(workflow) {
  if (!workflow) return;
  alphaWorkflow.hidden = false;
  setField(alphaWorkflow, 'phase', workflow.phase);
  setField(alphaWorkflow, 'project', workflow.project.name + ' · ' + workflow.project.environment);
  setField(alphaWorkflow, 'worktree', workflow.binding.type + ' · ' + workflow.binding.branch);
  setField(alphaWorkflow, 'runtime', workflow.runtime.version + ' · ' + workflow.runtime.model);
  setField(alphaWorkflow, 'alphaDestination', workflow.runtime.destinationHost);
  const fileList = alphaWorkflow.querySelector('[data-field="changedFiles"]');
  for (const file of workflow.files ?? []) {
    const item = document.createElement('li');
    const choice = document.createElement('input');
    choice.type = 'checkbox';
    choice.checked = Boolean(file.selected);
    choice.dataset.path = String(file.path);
    const label = document.createElement('span');
    label.textContent = String(file.path) + ' · ' + String(file.state);
    item.append(choice, label);
    fileList.append(item);
  }
  setField(alphaWorkflow, 'diffPreview', workflow.diff?.content ?? 'Diff unavailable');
  const status = alphaWorkflow.querySelector('[data-field="actionStatus"]');
  const stage = alphaWorkflow.querySelector('[data-action="stage"]');
  const commit = alphaWorkflow.querySelector('[data-action="commit"]');
  const archive = alphaWorkflow.querySelector('[data-action="archive"]');
  const cleanup = alphaWorkflow.querySelector('[data-action="safeCleanup"]');
  stage.disabled = workflow.actions?.stage !== true;
  commit.disabled = workflow.actions?.commit !== true;
  cleanup.disabled = workflow.actions?.safeCleanup !== true;
  stage.addEventListener('click', () => runAction(stage, async () => {
    const paths = [...fileList.querySelectorAll('input:checked')].map((input) => input.dataset.path);
    const result = await window.tsukiori.workspace.stage(paths);
    status.textContent = result?.ok === false ? 'Stage 不可用' : 'Stage 已提交';
    return result;
  }));
  commit.addEventListener('click', () => runAction(commit, async () => {
    const subject = alphaWorkflow.querySelector('[data-field="commitSubject"]').value;
    const result = await window.tsukiori.workspace.commit(subject);
    status.textContent = result?.ok === false ? 'Commit 不可用' : 'Commit 已提交';
    return result;
  }));
  archive.addEventListener('click', () => runAction(archive, () => window.tsukiori.workspace.archive('retain')));
  cleanup.addEventListener('click', () => runAction(cleanup, () => window.tsukiori.workspace.archive('run')));
}

function renderV1GitWorkflow(v1Git) {
  if (!v1Git?.available) return;
  v1GitWorkflow.hidden = false;
  setField(v1GitWorkflow, 'recoverySnapshot', v1Git.recoverySnapshot);
  setField(v1GitWorkflow, 'integrationLocation', v1Git.integrationLocation);
  setField(v1GitWorkflow, 'targetRef', v1Git.targetRef);
  setField(v1GitWorkflow, 'integrationStrategy', v1Git.strategy);
  const status = v1GitWorkflow.querySelector('[data-field="v1ActionStatus"]');
  const selectedPaths = () => [...alphaWorkflow.querySelectorAll('[data-field="changedFiles"] input:checked')]
    .map((input) => input.dataset.path);
  const bind = (name, operation) => {
    const button = v1GitWorkflow.querySelector('[data-v1-action="' + name + '"]');
    button.addEventListener('click', () => runAction(button, async () => {
      const result = await operation();
      status.textContent = result?.ok === false ? '操作不可用' : '请求已提交';
      return result;
    }));
  };
  bind('unstage', () => window.tsukiori.workspace.unstage(selectedPaths()));
  bind('revert', () => window.tsukiori.workspace.revert(selectedPaths()));
  bind('integrate', () => window.tsukiori.workspace.integrate(
    v1Git.sourceSessionId, v1Git.targetRef, v1Git.strategy,
  ));
  bind('continue', () => window.tsukiori.workspace.continueIntegration(v1Git.conflictOperationId));
  bind('external-editor', () => window.tsukiori.workspace.openExternalEditor(v1Git.conflictOperationId));
}

function renderAttention(item) {
  const card = document.createElement('article');
  card.className = 'attention-item ' + item.kind;
  const label = document.createElement('span');
  label.className = 'attention-kind';
  label.textContent = item.kind.replaceAll('_', ' ');
  const title = document.createElement('strong');
  title.textContent = item.title;
  card.append(label, title);
  if (item.kind === 'waiting_input') {
    const input = document.createElement('input');
    input.maxLength = 512;
    input.placeholder = '输入回答';
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '提交输入';
    button.addEventListener('click', () => runAction(button, () => window.tsukiori.workspace.answerInput(
      item.sourceRef, [[input.value]],
    )));
    card.append(input, button);
  }
  if (item.kind === 'completed') {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Review Diff';
    button.addEventListener('click', () => alphaWorkflow.scrollIntoView({ block: 'start' }));
    card.append(button);
  }
  attentionList.append(card);
}

function renderDiagnosticBundle(diagnostics) {
  if (!diagnostics?.available) return;
  diagnosticBundle.hidden = false;
  const checkbox = diagnosticBundle.querySelector('[data-field="includeSensitivePreviews"]');
  const estimated = diagnosticBundle.querySelector('[data-field="diagnosticEstimatedBytes"]');
  const button = diagnosticBundle.querySelector('[data-action="exportDiagnostic"]');
  const output = diagnosticBundle.querySelector('[data-field="diagnosticStatus"]');
  const update = () => {
    estimated.textContent = String(checkbox.checked
      ? diagnostics.sensitiveEstimatedBytes
      : diagnostics.defaultEstimatedBytes);
  };
  checkbox.addEventListener('change', update);
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const result = await window.tsukiori.workspace.exportDiagnostic(checkbox.checked);
      output.textContent = result?.ok === false ? '导出不可用' : '诊断包已生成';
    } catch {
      output.textContent = '诊断包导出失败';
    } finally {
      button.disabled = false;
    }
  });
  update();
}

const interactiveState = {
  projects: [], sessions: [], runtimes: [], recentEvents: [], permissions: [],
  activeProjectId: null, activeSessionId: null, assistantDraft: null, eventCursor: 0,
};

function interactiveElement(id) {
  return document.querySelector('#' + id);
}

function operationError(result) {
  if (result?.ok === false) throw new Error(result.message ?? result.code ?? '操作失败');
  return result;
}

async function reloadInteractiveSnapshot() {
  const snapshot = await window.tsukiori.workspace.snapshot();
  interactiveState.projects = snapshot.projects ?? [];
  interactiveState.sessions = snapshot.sessions ?? [];
  interactiveState.runtimes = snapshot.runtimes ?? [];
  interactiveState.recentEvents = snapshot.recentEvents ?? [];
  interactiveState.permissions = snapshot.permissions ?? [];
  interactiveState.eventCursor = Math.max(interactiveState.eventCursor, snapshot.eventCursor ?? 0);
  if (!interactiveState.projects.some((item) => item.id === interactiveState.activeProjectId)) {
    interactiveState.activeProjectId = interactiveState.projects[0]?.id ?? null;
  }
  if (!interactiveState.sessions.some((item) => item.id === interactiveState.activeSessionId)) {
    interactiveState.activeSessionId = interactiveState.sessions
      .find((item) => item.projectId === interactiveState.activeProjectId)?.id ?? null;
  }
  renderInteractive();
}

function renderInteractive() {
  renderInteractiveNavigation();
  renderInteractiveRuntime();
  renderInteractiveProject();
  renderInteractivePermissions();
}

function renderInteractiveNavigation() {
  const projectList = interactiveElement('project-list');
  const sessionList = interactiveElement('session-list');
  projectList.textContent = '';
  sessionList.textContent = '';
  for (const project of interactiveState.projects) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'rail-item' + (project.id === interactiveState.activeProjectId ? ' active' : '');
    const title = document.createElement('strong');
    title.textContent = project.name;
    const detail = document.createElement('small');
    detail.textContent = project.branch + ' · local';
    button.append(title, detail);
    button.addEventListener('click', () => {
      interactiveState.activeProjectId = project.id;
      const firstSession = interactiveState.sessions.find((item) => item.projectId === project.id);
      interactiveState.activeSessionId = firstSession?.id ?? null;
      interactiveState.assistantDraft = null;
      renderInteractive();
    });
    projectList.append(button);
  }
  const sessions = interactiveState.sessions
    .filter((item) => item.projectId === interactiveState.activeProjectId);
  interactiveElement('rail-new-session').disabled = !interactiveState.activeProjectId;
  for (const session of sessions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'session-row' + (session.id === interactiveState.activeSessionId ? ' active' : '');
    const presence = document.createElement('span');
    presence.className = 'presence ' + (session.status === 'error' ? 'failed' : 'running');
    const text = document.createElement('span');
    const title = document.createElement('strong');
    title.textContent = session.name;
    const detail = document.createElement('small');
    detail.textContent = 'Codex · ' + session.status;
    text.append(title, detail);
    button.append(presence, text);
    button.addEventListener('click', () => {
      interactiveState.activeSessionId = session.id;
      interactiveState.assistantDraft = null;
      renderInteractive();
    });
    sessionList.append(button);
  }
  if (interactiveState.projects.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'rail-empty';
    empty.textContent = '尚未添加项目';
    projectList.append(empty);
  }
}

function renderInteractiveRuntime() {
  const overview = interactiveElement('runtime-overview');
  overview.textContent = '';
  for (const runtime of interactiveState.runtimes) {
    const card = document.createElement('article');
    card.className = 'runtime-summary ' + (runtime.available ? 'available' : 'unavailable');
    const title = document.createElement('strong');
    title.textContent = 'Codex ' + runtime.version;
    const detail = document.createElement('span');
    detail.textContent = runtime.available
      ? (runtime.authenticated ? '已连接 · ' + runtime.authSource : '已发现 · 创建 Session 时验证登录')
      : (runtime.error ?? '未发现');
    card.append(title, detail);
    overview.append(card);
    interactiveElement('runtime-badge').textContent = runtime.available ? 'Codex ' + runtime.version : 'Codex unavailable';
  }
}

function renderInteractiveProject() {
  const project = interactiveState.projects.find((item) => item.id === interactiveState.activeProjectId);
  const session = interactiveState.sessions.find((item) => item.id === interactiveState.activeSessionId);
  interactiveElement('onboarding').hidden = Boolean(project);
  interactiveElement('project-home').hidden = !project || Boolean(session);
  interactiveElement('active-session').hidden = !session;
  if (!project) {
    interactiveElement('interactive-title').textContent = '选择一个本地 Git 项目';
    return;
  }
  interactiveElement('project-name').textContent = project.name;
  interactiveElement('project-path').textContent = project.gitRoot;
  interactiveElement('interactive-title').textContent = session ? session.name : project.name;
  interactiveElement('interactive-eyebrow').textContent = session
    ? 'SESSION / ' + project.name.toUpperCase()
    : 'PROJECT / ' + project.name.toUpperCase();
  if (!session) {
    interactiveElement('worktree-path').textContent = '选择会话后查看变更';
    interactiveElement('session-context-path').textContent = '';
    return;
  }
  interactiveElement('worktree-path').textContent = session.branch + ' · ' + session.worktreePath;
  interactiveElement('session-context-path').textContent = session.branch + ' · ' + session.worktreePath;
  interactiveElement('turn-status').textContent = session.lastError ?? session.status;
  const running = ['running', 'waiting_permission', 'starting'].includes(session.status);
  interactiveElement('send-prompt').disabled = running;
  interactiveElement('interrupt-turn').disabled = session.status !== 'running';
  renderConversation(session.id);
  void refreshGit();
}

function renderConversation(sessionId) {
  const conversation = interactiveElement('conversation');
  conversation.textContent = '';
  const events = interactiveState.recentEvents.filter((event) => event.sessionId === sessionId);
  if (events.length === 0) {
    const welcome = document.createElement('article');
    welcome.className = 'welcome-message';
    const kicker = document.createElement('p');
    kicker.className = 'card-kicker';
    kicker.textContent = 'SESSION';
    const heading = document.createElement('h2');
    heading.textContent = '开始一个真实任务';
    const detail = document.createElement('p');
    detail.textContent = 'Prompt 将发送给 Codex；文件操作发生在该 Session 的隔离 Worktree。';
    welcome.append(kicker, heading, detail);
    conversation.append(welcome);
    return;
  }
  let assistant = null;
  for (const event of events) {
    if (event.type === 'assistant.delta') {
      if (!assistant) {
        assistant = messageNode('assistant', 'Codex', '');
        conversation.append(assistant.card);
      }
      assistant.body.textContent += String(event.payload.text ?? '');
      continue;
    }
    assistant = null;
    appendInteractiveEvent(conversation, event, false);
  }
}

function messageNode(kind, label, text) {
  const card = document.createElement('article');
  card.className = 'chat-message ' + kind;
  const meta = document.createElement('div');
  meta.className = 'message-meta';
  meta.textContent = label;
  const body = document.createElement('div');
  body.className = 'message-body';
  body.textContent = text;
  card.append(meta, body);
  return { card, body };
}

function appendInteractiveEvent(target, event, scroll = true) {
  if (event.type === 'user.message') {
    target.append(messageNode('user', 'You', String(event.payload.text ?? '')).card);
  } else if (event.type === 'tool.event') {
    const tool = String(event.payload.tool ?? 'Tool');
    const summary = String(event.payload.summary ?? '');
    const toolKind = classifyToolEvent(tool, summary);
    const node = messageNode('tool', toolKind.toUpperCase() + ' · ' + tool, summary);
    node.card.dataset.phase = String(event.payload.phase ?? '');
    node.card.dataset.toolKind = toolKind;
    target.append(node.card);
  } else if (event.type === 'runtime.error') {
    target.append(messageNode('error', 'Runtime error', String(event.payload.message ?? 'Unknown error')).card);
  } else if (event.type === 'turn.completed') {
    const statusNode = document.createElement('div');
    statusNode.className = 'turn-divider';
    statusNode.textContent = 'Turn ' + String(event.payload.status ?? 'completed');
    target.append(statusNode);
  } else if (event.type === 'git.committed') {
    const statusNode = document.createElement('div');
    statusNode.className = 'turn-divider';
    statusNode.textContent = 'Committed ' + String(event.payload.sha ?? '').slice(0, 8);
    target.append(statusNode);
  }
  if (scroll) target.scrollTop = target.scrollHeight;
}

function classifyToolEvent(tool, summary) {
  const value = (tool + ' ' + summary).toLowerCase();
  if (/write|edit|patch|create|delete|move|stage|commit/.test(value)) return 'modify';
  if (/exec|shell|command|terminal|process|run/.test(value)) return 'execute';
  return 'read';
}

function appendTerminalEvent(event) {
  const output = interactiveElement('terminal-output');
  if (!output) return;
  let line = '';
  if (event.type === 'tool.event') {
    const kind = classifyToolEvent(String(event.payload.tool ?? ''), String(event.payload.summary ?? ''));
    line = '[' + kind.toUpperCase() + '] ' + String(event.payload.tool ?? 'Tool') + ' · ' + String(event.payload.summary ?? '');
  } else if (event.type === 'turn.started') {
    line = '[TURN] started';
  } else if (event.type === 'turn.completed') {
    line = '[TURN] ' + String(event.payload.status ?? 'completed');
  } else if (event.type === 'permission.requested') {
    line = '[PERMISSION] waiting for a local decision';
  } else if (event.type === 'permission.resolved') {
    line = '[PERMISSION] resolved';
  } else if (event.type === 'runtime.error') {
    line = '[ERROR] ' + String(event.payload.message ?? 'Unknown Runtime error');
  } else if (event.type === 'git.committed') {
    line = '[GIT] committed ' + String(event.payload.sha ?? '').slice(0, 8);
  }
  if (!line) return;
  const current = output.textContent ?? '';
  output.textContent = (current.length > 12_000 ? current.slice(-8_000) : current) + '\n' + line;
  output.scrollTop = output.scrollHeight;
}

function acceptInteractiveEvent(event) {
  if (!event || typeof event !== 'object') return;
  interactiveState.recentEvents.push(event);
  appendTerminalEvent(event);
  if (interactiveState.recentEvents.length > 500) interactiveState.recentEvents.shift();
  const session = interactiveState.sessions.find((item) => item.id === event.sessionId);
  if (session) {
    if (event.type === 'session.ready' || event.type === 'turn.completed') session.status = 'ready';
    if (event.type === 'turn.started') session.status = 'running';
    if (event.type === 'permission.requested') session.status = 'waiting_permission';
    if (event.type === 'runtime.error') { session.status = 'error'; session.lastError = event.payload.message; }
  }
  if (event.type === 'permission.requested' || event.type === 'permission.resolved') {
    void reloadInteractiveSnapshot();
    return;
  }
  if (event.type === 'git.changed' || event.type === 'git.committed' || event.type === 'turn.completed') {
    void refreshGit();
  }
  if (event.sessionId === interactiveState.activeSessionId) {
    const conversation = interactiveElement('conversation');
    if (event.type === 'assistant.delta') {
      if (!interactiveState.assistantDraft?.card?.isConnected) {
        interactiveState.assistantDraft = messageNode('assistant', 'Codex', '');
        conversation.append(interactiveState.assistantDraft.card);
      }
      interactiveState.assistantDraft.body.textContent += String(event.payload.text ?? '');
      conversation.scrollTop = conversation.scrollHeight;
    } else {
      if (event.type !== 'tool.event') interactiveState.assistantDraft = null;
      appendInteractiveEvent(conversation, event);
    }
  }
  renderInteractiveNavigation();
  if (session?.id === interactiveState.activeSessionId) {
    interactiveElement('turn-status').textContent = session.lastError ?? session.status;
    interactiveElement('send-prompt').disabled = ['running', 'waiting_permission', 'starting'].includes(session.status);
    interactiveElement('interrupt-turn').disabled = session.status !== 'running';
  }
}

function activateWorkPanel(name) {
  for (const button of document.querySelectorAll('[data-panel-tab]')) {
    button.classList.toggle('active', button.dataset.panelTab === name);
  }
  for (const view of document.querySelectorAll('[data-panel-view]')) {
    view.hidden = view.dataset.panelView !== name;
  }
}

function renderInteractivePermissions() {
  attentionList.textContent = '';
  const active = interactiveState.permissions.filter(
    (item) => !interactiveState.activeSessionId || item.sessionId === interactiveState.activeSessionId,
  );
  for (const permission of active) {
    const template = document.querySelector('#permission-card-template');
    const card = template.content.firstElementChild.cloneNode(true);
    setField(card, 'title', permission.title);
    setField(card, 'description', permission.description);
    setField(card, 'category', permission.category);
    setField(card, 'risk', permission.risk);
    setField(card, 'scope', permission.scope);
    setField(card, 'enforcement', permission.enforcementLevel);
    const [deny, allow] = card.querySelectorAll('.permission-actions button');
    deny.addEventListener('click', () => decideInteractivePermission(permission.id, 'deny_once'));
    allow.addEventListener('click', () => decideInteractivePermission(permission.id, 'allow_once'));
    attentionList.append(card);
  }
  if (active.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = '暂无待处理事项';
    attentionList.append(empty);
  }
  attentionCount.textContent = String(active.length);
  if (active.length > 0) activateWorkPanel('permissions');
}

async function decideInteractivePermission(id, decision) {
  try {
    operationError(await window.tsukiori.workspace.decidePermission(id, 'interactive-codex', decision));
    await reloadInteractiveSnapshot();
  } catch (error) {
    interactiveElement('turn-status').textContent = error.message;
  }
}

async function pickProject() {
  const output = interactiveElement('onboarding-status');
  output.textContent = '正在读取 Git 项目…';
  try {
    const result = operationError(await window.tsukiori.workspace.pickProject());
    if (result.canceled) { output.textContent = '已取消'; return; }
    interactiveState.activeProjectId = result.project.id;
    interactiveState.activeSessionId = null;
    await reloadInteractiveSnapshot();
  } catch (error) {
    output.textContent = error.message;
  }
}

async function createInteractiveSession() {
  const button = interactiveElement('new-session');
  const projectId = interactiveState.activeProjectId;
  if (!projectId) return;
  button.disabled = true;
  button.textContent = '正在创建 Worktree 和 Codex Thread…';
  try {
    const result = operationError(await window.tsukiori.workspace.createSession(projectId));
    interactiveState.activeSessionId = result.session.id;
    await reloadInteractiveSnapshot();
  } catch (error) {
    interactiveElement('onboarding-status').textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = '＋ 新建 Codex Session';
  }
}

async function sendInteractivePrompt(event) {
  event.preventDefault();
  const sessionId = interactiveState.activeSessionId;
  const input = interactiveElement('prompt-input');
  const text = input.value.trim();
  if (!sessionId || !text) return;
  interactiveElement('send-prompt').disabled = true;
  interactiveElement('turn-status').textContent = 'Submitting…';
  try {
    operationError(await window.tsukiori.workspace.sendPrompt(sessionId, text));
    input.value = '';
  } catch (error) {
    interactiveElement('turn-status').textContent = error.message;
    interactiveElement('send-prompt').disabled = false;
  }
}

async function refreshGit() {
  const sessionId = interactiveState.activeSessionId;
  if (!sessionId) return;
  try {
    const result = operationError(await window.tsukiori.workspace.gitStatus(sessionId));
    const files = result.git.files ?? [];
    const container = interactiveElement('git-files');
    container.textContent = '';
    for (const file of files) {
      const label = document.createElement('label');
      label.className = 'git-file';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.dataset.path = file.path;
      const statusText = document.createElement('span');
      statusText.className = 'git-file-status';
      statusText.textContent = file.status;
      const pathText = document.createElement('span');
      pathText.textContent = file.path;
      label.append(checkbox, statusText, pathText);
      label.addEventListener('click', () => { void loadGitDiff(file.path); });
      container.append(label);
    }
    if (files.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty-state';
      empty.textContent = 'Worktree 干净';
      container.append(empty);
    }
    interactiveElement('git-status').textContent = files.length + ' changed file(s)';
  } catch (error) {
    interactiveElement('git-status').textContent = error.message;
  }
}

async function loadGitDiff(path) {
  const sessionId = interactiveState.activeSessionId;
  if (!sessionId) return;
  try {
    const result = operationError(await window.tsukiori.workspace.gitDiff(sessionId, path));
    interactiveElement('git-diff').textContent = result.diff || '无可显示 Diff（可能是未跟踪文件）';
  } catch (error) {
    interactiveElement('git-diff').textContent = error.message;
  }
}

function selectedGitPaths() {
  return [...interactiveElement('git-files').querySelectorAll('input:checked')]
    .map((input) => input.dataset.path).filter(Boolean);
}

async function mutateGit(kind) {
  const sessionId = interactiveState.activeSessionId;
  if (!sessionId) return;
  try {
    if (kind === 'stage') operationError(await window.tsukiori.workspace.stage(sessionId, selectedGitPaths()));
    else operationError(await window.tsukiori.workspace.unstage(sessionId, selectedGitPaths()));
    await refreshGit();
  } catch (error) {
    interactiveElement('git-status').textContent = error.message;
  }
}

async function commitInteractiveFiles() {
  const sessionId = interactiveState.activeSessionId;
  if (!sessionId) return;
  try {
    const input = interactiveElement('commit-subject');
    const result = operationError(await window.tsukiori.workspace.commit(sessionId, input.value));
    input.value = '';
    interactiveElement('git-status').textContent = 'Committed ' + result.sha.slice(0, 8);
    await refreshGit();
  } catch (error) {
    interactiveElement('git-status').textContent = error.message;
  }
}

function bindInteractiveUi() {
  interactiveElement('add-project').addEventListener('click', pickProject);
  interactiveElement('onboarding-add-project').addEventListener('click', pickProject);
  interactiveElement('refresh-runtimes').addEventListener('click', async () => {
    try {
      operationError(await window.tsukiori.workspace.refreshRuntimes());
      await reloadInteractiveSnapshot();
    } catch (error) { interactiveElement('onboarding-status').textContent = error.message; }
  });
  interactiveElement('new-session').addEventListener('click', createInteractiveSession);
  interactiveElement('rail-new-session').addEventListener('click', createInteractiveSession);
  interactiveElement('prompt-form').addEventListener('submit', sendInteractivePrompt);
  interactiveElement('prompt-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      interactiveElement('prompt-form').requestSubmit();
    }
  });
  interactiveElement('interrupt-turn').addEventListener('click', async () => {
    try { operationError(await window.tsukiori.workspace.interruptTurn(interactiveState.activeSessionId)); }
    catch (error) { interactiveElement('turn-status').textContent = error.message; }
  });
  interactiveElement('refresh-git').addEventListener('click', refreshGit);
  interactiveElement('stage-files').addEventListener('click', () => mutateGit('stage'));
  interactiveElement('unstage-files').addEventListener('click', () => mutateGit('unstage'));
  interactiveElement('commit-files').addEventListener('click', commitInteractiveFiles);
  interactiveElement('clear-terminal').addEventListener('click', () => {
    interactiveElement('terminal-output').textContent = '显示已清空。新的 Runtime 与工具事件会继续出现。';
  });
  for (const button of document.querySelectorAll('[data-panel-tab]')) {
    button.addEventListener('click', () => activateWorkPanel(button.dataset.panelTab));
  }
  const shell = document.querySelector('.app-shell');
  interactiveElement('toggle-left-panel').addEventListener('click', () => shell.classList.toggle('left-collapsed'));
  interactiveElement('toggle-right-panel').addEventListener('click', () => shell.classList.toggle('right-collapsed'));
  interactiveElement('toggle-terminal').addEventListener('click', () => shell.classList.toggle('terminal-collapsed'));
  const poll = async () => {
    try {
      const result = operationError(await window.tsukiori.workspace.pollEvents(interactiveState.eventCursor));
      for (const event of result.events ?? []) acceptInteractiveEvent(event);
      interactiveState.eventCursor = Math.max(interactiveState.eventCursor, result.cursor ?? 0);
    } catch {
      // A later poll or Daemon status refresh can recover the event cursor.
    }
  };
  setInterval(poll, 250);
}

function initializeInteractive(snapshot, versions) {
  document.body.classList.add('interactive-mode');
  interactiveElement('legacy-session').hidden = true;
  interactiveElement('legacy-workspace').hidden = true;
  interactiveElement('interactive-navigation').hidden = false;
  interactiveElement('interactive-workspace').hidden = false;
  interactiveElement('interactive-version').textContent = 'Protocol ' + versions.protocol;
  interactiveState.projects = snapshot.projects ?? [];
  interactiveState.sessions = snapshot.sessions ?? [];
  interactiveState.runtimes = snapshot.runtimes ?? [];
  interactiveState.recentEvents = snapshot.recentEvents ?? [];
  interactiveState.permissions = snapshot.permissions ?? [];
  interactiveState.eventCursor = snapshot.eventCursor ?? 0;
  interactiveState.activeProjectId = interactiveState.projects[0]?.id ?? null;
  interactiveState.activeSessionId = interactiveState.sessions
    .find((item) => item.projectId === interactiveState.activeProjectId)?.id ?? null;
  bindInteractiveUi();
  renderInteractive();
}

try {
  const [daemon, versions, snapshot] = await Promise.all([
    window.tsukiori.daemon.status(),
    window.tsukiori.versions(),
    window.tsukiori.workspace.snapshot(),
  ]);
  status.textContent = 'Daemon ' + daemon.daemonVersion + ' · ' + daemon.state;
  daemonDot.classList.add('healthy');
  if (snapshot?.mode === 'interactive') {
    initializeInteractive(snapshot, versions);
  } else {
    version.textContent = 'Protocol ' + versions.protocol;
    renderAlphaWorkflow(snapshot.workflow);
    renderV1GitWorkflow(snapshot.v1Git);
    renderDiagnosticBundle(snapshot.diagnostics);
    for (const tool of snapshot.tools) renderTool(tool);
    for (const runtime of snapshot.runtimes) renderRuntime(runtime);
    for (const permission of snapshot.permissions) renderPermission(permission);
    const openAttention = snapshot.attention.filter((item) => item.status === 'open');
    if (openAttention.length > 0) attentionList.textContent = '';
    for (const item of openAttention) renderAttention(item);
    attentionCount.textContent = String(openAttention.length);
  }
} catch {
  status.textContent = 'Daemon 不可用';
  daemonDot.classList.add('failed');
}
