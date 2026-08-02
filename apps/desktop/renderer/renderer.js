const byId = (id) => document.querySelector('#' + id);
const setText = (id, value) => { const target = byId(id); if (target) target.textContent = String(value ?? '—'); };
const clear = (target) => { if (target) target.textContent = ''; };

function operationError(result) {
  if (result?.ok === false) throw new Error(result.message ?? result.code ?? '操作失败');
  return result;
}

function appendOption(select, value, label, selected = false) {
  const option = document.createElement('option');
  option.value = String(value); option.textContent = String(label); option.selected = selected;
  select.append(option);
}

function setField(root, name, value) {
  const target = root.querySelector('[data-field="' + name + '"]');
  if (target) target.textContent = String(value ?? '—');
}

function renderPermission(permission, container = byId('permission-list')) {
  const card = byId('permission-card-template').content.firstElementChild.cloneNode(true);
  for (const [field, value] of Object.entries({ title: permission.title, description: permission.description, category: permission.category, risk: permission.risk, scope: permission.scope, enforcement: permission.enforcementLevel })) setField(card, field, value);
  const [deny, allow] = card.querySelectorAll('.permission-actions button');
  deny.addEventListener('click', () => window.tsukiori.workspace.decidePermission(permission.id, permission.connectionEpoch, 'deny_once'));
  allow.addEventListener('click', () => window.tsukiori.workspace.decidePermission(permission.id, permission.connectionEpoch, 'allow_once'));
  container.append(card);
}

function renderTool(tool) {
  const card = byId('tool-card-template').content.firstElementChild.cloneNode(true);
  setField(card, 'title', tool.title); setField(card, 'summary', tool.summary); byId('tool-list').append(card);
}

function renderNativeCapability(list, capability) {
  const item = document.createElement('li');
  item.className = 'native-capability support-' + capability.supportLevel;
  item.dataset.capability = String(capability.id ?? 'unknown');
  const support = document.createElement('span'); support.dataset.field = 'supportLevel'; support.textContent = String(capability.supportLevel ?? 'unknown');
  const boundary = document.createElement('span'); boundary.dataset.field = 'enforcement'; boundary.textContent = String(capability.scope ?? 'runtime_native') + ' · enforcement=' + String(capability.enforcementLevel ?? 'unknown');
  item.append(String(capability.label ?? capability.id ?? 'unknown') + ' ', support, boundary); list.append(item);
}

function renderRuntime(runtime) {
  const card = byId('runtime-card-template').content.firstElementChild.cloneNode(true);
  for (const [field, value] of Object.entries({ runtimeType: runtime.runtimeType, version: runtime.version, state: runtime.state, authSource: runtime.authenticated ? runtime.authSource : '未登录', compatibility: runtime.compatibility })) setField(card, field, value);
  const capabilities = card.querySelector('[data-field="nativeCapabilities"]');
  for (const capability of runtime.nativeCapabilities ?? []) renderNativeCapability(capabilities, capability);
  if (runtime.providers?.length) {
    const panel = card.querySelector('[data-field="providerPanel"]');
    const providerSelect = card.querySelector('[data-field="providerSelect"]');
    const modelSelect = card.querySelector('[data-field="modelSelect"]');
    panel.hidden = false; panel.dataset.modelRequestStarted = 'false';
    for (const provider of runtime.providers) appendOption(providerSelect, provider.id, provider.name ?? provider.id);
    const update = () => {
      const provider = runtime.providers.find((item) => item.id === providerSelect.value) ?? runtime.providers[0];
      clear(modelSelect); for (const model of provider.models ?? []) appendOption(modelSelect, model.id, model.name ?? model.id);
      panel.dataset.providerId = String(provider.id); panel.dataset.destinationHost = String(provider.destinationHost); panel.dataset.modelId = String(modelSelect.value);
      setField(panel, 'destinationHost', provider.destinationHost); setField(panel, 'modelRequestState', '模型请求尚未启动');
    };
    providerSelect.addEventListener('change', update); modelSelect.addEventListener('change', () => { panel.dataset.modelId = modelSelect.value; }); update();
  }
  byId('runtime-list').append(card);
}

function renderAlphaWorkflow(workflow) {
  if (!workflow) return;
  const root = byId('alpha-workflow'); root.hidden = false;
  setField(root, 'phase', workflow.phase); setField(root, 'project', workflow.project.name); setField(root, 'worktree', workflow.binding.branch); setField(root, 'runtime', workflow.runtime.model); setField(root, 'alphaDestination', workflow.runtime.destinationHost); setField(root, 'diffPreview', workflow.diff.content);
  const list = root.querySelector('[data-field="changedFiles"]');
  for (const file of workflow.files ?? []) { const item = document.createElement('li'); const input = document.createElement('input'); input.type = 'checkbox'; input.checked = file.selected; input.dataset.path = file.path; item.append(input, file.path); list.append(item); }
  for (const action of ['stage','commit','archive','safeCleanup']) root.querySelector('[data-action="' + action + '"]').addEventListener('click', async () => {
    if (action === 'stage') await window.tsukiori.workspace.stage([...list.querySelectorAll('input:checked')].map((input) => input.dataset.path));
    if (action === 'commit') await window.tsukiori.workspace.commit(root.querySelector('[data-field="commitSubject"]').value);
    if (action === 'archive') await window.tsukiori.workspace.archive('retain');
    if (action === 'safeCleanup') await window.tsukiori.workspace.archive('run');
  });
}

function renderV1GitWorkflow(value) {
  if (!value?.available) return;
  const root = byId('v1-git-workflow'); root.hidden = false;
  for (const [field, data] of Object.entries({ recoverySnapshot: value.recoverySnapshot, integrationLocation: value.integrationLocation, targetRef: value.targetRef, integrationStrategy: value.strategy })) setField(root, field, data);
  const calls = {
    unstage: () => window.tsukiori.workspace.unstage([]), revert: () => window.tsukiori.workspace.revert([]),
    integrate: () => window.tsukiori.workspace.integrate(value.sourceSessionId, value.targetRef, value.strategy),
    continue: () => window.tsukiori.workspace.continueIntegration(value.conflictOperationId),
    'external-editor': () => window.tsukiori.workspace.openExternalEditor(value.conflictOperationId),
  };
  for (const [name, call] of Object.entries(calls)) root.querySelector('[data-v1-action="' + name + '"]').addEventListener('click', call);
}

function renderDiagnosticBundle(value) {
  if (!value?.available) return;
  const root = byId('diagnostic-bundle'); root.hidden = false;
  const checkbox = root.querySelector('input'); const estimated = root.querySelector('[data-field="diagnosticEstimatedBytes"]');
  const update = () => { estimated.textContent = String(checkbox.checked ? value.sensitiveEstimatedBytes : value.defaultEstimatedBytes); };
  checkbox.addEventListener('change', update); root.querySelector('button').addEventListener('click', () => window.tsukiori.workspace.exportDiagnostic(checkbox.checked)); update();
}

const state = {
  projects: [], sessions: [], runtimes: [], providers: [], recentEvents: [], permissions: [],
  settings: {}, usage: {}, activeProjectId: null, activeSessionId: null, assistantDraft: null,
  eventCursor: 0, versions: {}, selectedProviderId: null,
};

function activeProject() { return state.projects.find((item) => item.id === state.activeProjectId); }
function activeSession() { return state.sessions.find((item) => item.id === state.activeSessionId); }
function providerById(id) { return state.providers.find((item) => item.id === id); }
function runtimeByType(type) { return state.runtimes.find((item) => item.type === type); }
function isCompatible(runtime, provider) { return runtime === 'codex' ? ['chatgpt','openai','openai-compatible'].includes(provider.kind) : ['anthropic','deepseek','anthropic-compatible'].includes(provider.kind); }

async function reloadSnapshot() {
  const snapshot = await window.tsukiori.workspace.snapshot();
  for (const key of ['projects','sessions','runtimes','providers','recentEvents','permissions','settings','usage']) state[key] = snapshot[key] ?? state[key];
  state.eventCursor = Math.max(state.eventCursor, snapshot.eventCursor ?? 0);
  if (!state.projects.some((item) => item.id === state.activeProjectId)) state.activeProjectId = state.projects[0]?.id ?? null;
  if (!state.sessions.some((item) => item.id === state.activeSessionId)) state.activeSessionId = state.sessions.find((item) => item.projectId === state.activeProjectId)?.id ?? null;
  applyAppearance(); renderAll();
}

function renderAll() {
  renderNavigation(); renderMain(); renderRuntimeQuickSwitch(); renderComposerSelectors(); renderPermissions(); renderSettingsData();
}

function renderNavigation() {
  const projects = byId('project-list'); clear(projects);
  for (const project of state.projects) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'rail-item' + (project.id === state.activeProjectId ? ' active' : '');
    const icon = document.createElement('i'); icon.textContent = '▱'; const name = document.createElement('span'); name.textContent = project.name; const branch = document.createElement('small'); branch.textContent = project.branch;
    button.append(icon,name,branch); button.addEventListener('click', () => { state.activeProjectId = project.id; state.activeSessionId = state.sessions.find((item) => item.projectId === project.id)?.id ?? null; renderAll(); }); projects.append(button);
  }
  if (!state.projects.length) projects.append(emptyText('尚未添加项目'));
  const sessions = byId('session-list'); clear(sessions);
  for (const session of state.sessions.filter((item) => item.projectId === state.activeProjectId).sort((a,b) => b.createdAt - a.createdAt)) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'rail-item' + (session.id === state.activeSessionId ? ' active' : '');
    const icon = document.createElement('i'); icon.textContent = session.runtimeType === 'claude' ? '◈' : '◫'; const name = document.createElement('span'); name.textContent = session.name; const time = document.createElement('small'); time.textContent = relativeTime(session.createdAt);
    button.append(icon,name,time); button.addEventListener('click', () => { state.activeSessionId = session.id; renderAll(); void refreshGit(); }); sessions.append(button);
  }
  if (!sessions.children.length) sessions.append(emptyText('暂无会话'));
  byId('rail-attention-dot').hidden = state.permissions.length === 0;
}

function renderMain() {
  const project = activeProject(); const session = activeSession();
  byId('onboarding').hidden = Boolean(project); byId('project-home').hidden = !project || Boolean(session); byId('active-session').hidden = !session;
  if (!project) { renderRuntimeOverview(); return; }
  setText('project-name', project.name); setText('project-path', project.gitRoot); document.querySelector('.project-branch').textContent = project.branch;
  const projectSessions = state.sessions.filter((item) => item.projectId === project.id);
  setText('metric-worktrees', projectSessions.length); setText('metric-running', projectSessions.filter((item) => item.status === 'running').length); setText('metric-attention', state.permissions.length);
  const dashboard = byId('dashboard-sessions'); clear(dashboard);
  for (const item of projectSessions.slice(0,5)) { const row = document.createElement('button'); row.className = 'rail-item'; row.type = 'button'; row.append(Object.assign(document.createElement('i'),{textContent:item.runtimeType === 'claude' ? 'C' : 'X'}),Object.assign(document.createElement('span'),{textContent:item.name}),Object.assign(document.createElement('small'),{textContent:item.status})); row.addEventListener('click',()=>{state.activeSessionId=item.id;renderAll();}); dashboard.append(row); }
  const runtimeDashboard = byId('dashboard-runtimes'); clear(runtimeDashboard); for (const runtime of state.runtimes) runtimeDashboard.append(runtimeRow(runtime));
  if (!session) return;
  const runtime = runtimeByType(session.runtimeType); const provider = providerById(session.providerId);
  setText('interactive-title', session.name); setText('interactive-eyebrow', project.name + ' / ' + session.branch); setText('runtime-badge', runtime?.name ?? session.runtimeType); setText('provider-badge', provider?.name ?? session.providerId); setText('session-context-path', session.worktreePath); setText('interactive-version', 'Protocol ' + (state.versions.protocol ?? '—'));
  renderConversation(session.id); byId('interrupt-turn').disabled = session.status !== 'running'; setText('turn-status', statusLabel(session.status));
}

function renderRuntimeOverview() { const root = byId('runtime-overview'); clear(root); for (const runtime of state.runtimes) root.append(runtimeRow(runtime)); }
function runtimeRow(runtime) { const row = document.createElement('div'); row.className = 'runtime-summary ' + (runtime.available ? 'available' : 'unavailable'); const strong = document.createElement('strong'); strong.textContent = runtime.name; const span = document.createElement('span'); span.textContent = runtime.available ? runtime.version + ' · ' + runtime.supportLevel : runtime.error; row.append(strong,span); return row; }

function renderRuntimeQuickSwitch() { const session = activeSession(); const runtime = runtimeByType(session?.runtimeType ?? state.settings.defaultRuntime ?? 'codex'); const button = byId('runtime-quick-switch'); button.querySelector('strong').textContent = runtime?.name ?? '选择 Runtime'; button.querySelector('small').textContent = runtime?.available ? runtime.version + ' · ' + runtime.supportLevel : '不可用'; const orb = button.querySelector('.runtime-orb'); orb.textContent = runtime?.type === 'claude' ? 'A' : 'C'; orb.className = 'runtime-orb ' + (runtime?.type === 'claude' ? 'claude' : 'codex'); }

function renderConversation(sessionId) {
  const target = byId('conversation'); clear(target); target.append(welcomeNode());
  for (const event of state.recentEvents.filter((item) => item.sessionId === sessionId)) appendEvent(target,event,false);
  target.scrollTop = target.scrollHeight;
}

function welcomeNode() { const node = document.createElement('article'); node.className='welcome-message'; const mark=document.createElement('span');mark.textContent='✣';const box=document.createElement('div');const strong=document.createElement('strong');strong.textContent='会话已准备';const p=document.createElement('p');p.textContent='消息、Tool 与权限事件会按时间显示。';box.append(strong,p);node.append(mark,box);return node; }
function messageNode(kind,label,text) { const node=document.createElement('article');node.className='chat-message '+kind;const meta=document.createElement('div');meta.className='message-meta';meta.textContent=label;const body=document.createElement('div');body.className='message-body';body.textContent=String(text??'');node.append(meta,body);return node; }

function appendEvent(target,event,scroll=true) {
  if (event.type === 'user.message') { target.append(messageNode('user','你',event.payload.text)); state.assistantDraft=null; }
  else if (event.type === 'assistant.delta') {
    if (!state.assistantDraft || !target.contains(state.assistantDraft)) { state.assistantDraft=messageNode('assistant',activeSession()?.runtimeType==='claude'?'Claude Code':'Codex',''); target.append(state.assistantDraft); }
    state.assistantDraft.querySelector('.message-body').textContent += String(event.payload.text??'');
  } else if (event.type === 'tool.event') { const kind=classifyToolEvent(String(event.payload.tool??''),String(event.payload.summary??''));const node=messageNode('tool',kind.toUpperCase()+' · '+String(event.payload.tool??'TOOL'),event.payload.summary);node.dataset.toolKind=kind;target.append(node); }
  else if (event.type === 'turn.completed') { const divider=document.createElement('div');divider.className='turn-divider';divider.textContent=event.payload.status==='failed'?'Turn failed':'Turn completed';target.append(divider);state.assistantDraft=null; }
  else if (event.type === 'runtime.error') { target.append(messageNode('error','Runtime error',event.payload.message)); state.assistantDraft=null; }
  if (scroll) target.scrollTop=target.scrollHeight;
}

function classifyToolEvent(tool,summary) {
  const value=(tool+' '+summary).toLowerCase();
  if (/shell|command|exec|bash|powershell|terminal/.test(value)) return 'execute';
  if (/write|edit|patch|modify|filechange/.test(value)) return 'modify';
  return 'read';
}

function appendTerminalEvent(event) { if (!['turn.started','turn.completed','tool.event','runtime.error','permission.requested'].includes(event.type)) return; const output=byId('terminal-output'); const kind=event.type==='tool.event'?classifyToolEvent(String(event.payload.tool??''),String(event.payload.summary??'')):event.type; output.textContent += '\n['+new Date(event.createdAt).toLocaleTimeString()+'] '+kind+' '+String(event.payload.summary??event.payload.message??event.payload.status??''); output.scrollTop=output.scrollHeight; }
function acceptEvent(event) { state.recentEvents.push(event); if (state.recentEvents.length>300) state.recentEvents.splice(0,state.recentEvents.length-300); appendTerminalEvent(event); if (event.sessionId===state.activeSessionId) appendEvent(byId('conversation'),event); if (event.type==='permission.requested'||event.type==='permission.resolved') void reloadSnapshot(); if (event.type==='turn.started'||event.type==='turn.completed'||event.type==='runtime.error') void reloadSnapshot(); }

function compatibleProviders(runtime) { return state.providers.filter((provider)=>provider.enabled!==false&&isCompatible(runtime,provider)); }
function fillRuntime(select,value) { clear(select); for (const runtime of state.runtimes.filter((item)=>['codex','claude'].includes(item.type))) appendOption(select,runtime.type,runtime.name+(runtime.available?'':'（不可用）'),runtime.type===value); }
function fillProvider(select,runtime,value) { clear(select); for (const provider of compatibleProviders(runtime)) appendOption(select,provider.id,provider.name+(provider.hasSecret||provider.kind==='chatgpt'?'':' · 需 API Key'),provider.id===value); }
function fillModels(select,providerId,value) { clear(select); const provider=providerById(providerId); for (const model of provider?.models??[]) appendOption(select,model,model,model===value); if (!select.children.length) appendOption(select,'auto','Auto',true); }
function fillPermissions(select,runtime,value) { clear(select); const items=runtime==='claude'?[['plan','Plan · 只读计划'],['acceptEdits','接受文件编辑'],['dontAsk','不询问（失败即停）']]:[['manual','每次询问']]; for(const [id,label] of items)appendOption(select,id,label,id===value); }

function renderComposerSelectors() {
  const session=activeSession(); const runtime=session?.runtimeType??state.settings.defaultRuntime??'codex'; const providerId=session?.providerId??compatibleProviders(runtime)[0]?.id;
  fillRuntime(byId('runtime-select'),runtime);fillProvider(byId('provider-select'),runtime,providerId);fillModels(byId('model-select'),providerId,session?.model);fillPermissions(byId('permission-select'),runtime,session?.permissionMode);
}

function openSessionDialog(runtime) { if(!activeProject()){setText('onboarding-status','请先添加本地 Git 项目');return;} const selected=runtime??activeSession()?.runtimeType??state.settings.defaultRuntime??'codex'; fillRuntime(byId('create-runtime'),selected); updateCreateProvider(); byId('session-dialog').showModal(); }
function updateCreateProvider() { const runtime=byId('create-runtime').value; fillProvider(byId('create-provider'),runtime,state.settings.defaultProviderId); updateCreateModel(); fillPermissions(byId('create-permission'),runtime,runtime==='claude'?'plan':'manual'); }
function updateCreateModel() { fillModels(byId('create-model'),byId('create-provider').value,state.settings.defaultModel); }

async function createSession(event) {
  event.preventDefault(); if(event.submitter?.value==='cancel'){byId('session-dialog').close();return;}
  const project=activeProject(); if(!project)return; setText('create-session-status','正在创建独立 Worktree…');
  try { const result=operationError(await window.tsukiori.workspace.createSession(project.id,{runtimeType:byId('create-runtime').value,providerId:byId('create-provider').value,model:byId('create-model').value,permissionMode:byId('create-permission').value})); state.activeSessionId=result.session.id; byId('session-dialog').close(); await reloadSnapshot(); }
  catch(error){setText('create-session-status',error.message);}
}

async function updateActiveOptions() {
  const session=activeSession(); if(!session)return;
  try { operationError(await window.tsukiori.workspace.updateSessionOptions(session.id,{providerId:byId('provider-select').value,model:byId('model-select').value,permissionMode:byId('permission-select').value})); await reloadSnapshot(); }
  catch(error){setText('turn-status',error.message);await reloadSnapshot();}
}

async function pickProject() { try { const result=operationError(await window.tsukiori.workspace.pickProject()); if(result.canceled)return; state.activeProjectId=result.project.id; state.activeSessionId=null; await reloadSnapshot(); }catch(error){setText('onboarding-status',error.message);} }
async function sendPrompt(event) { event.preventDefault(); const session=activeSession(); const input=byId('prompt-input'); if(!session||!input.value.trim())return; const text=input.value; input.value=''; setText('turn-status','正在发送…'); try{operationError(await window.tsukiori.workspace.sendPrompt(session.id,text));}catch(error){input.value=text;setText('turn-status',error.message);} }

function renderPermissions() { const root=byId('attention-list'); clear(root); for(const permission of state.permissions)renderPermission(permission,root); if(!root.children.length)root.append(emptyText('暂无待处理事项'));setText('attention-count',state.permissions.length); }

function activateWorkPanel(name) { byId('work-panel-home').hidden=Boolean(name); for(const view of document.querySelectorAll('[data-panel-view]'))view.hidden=view.dataset.panelView!==name; if(name==='changes'||name==='files')void refreshGit(); }
async function refreshGit() { const session=activeSession(); if(!session)return; try{const result=operationError(await window.tsukiori.workspace.gitStatus(session.id));setText('worktree-path',result.git.worktreePath);renderGitFiles(result.git.files??[]);setText('metric-changes',(result.git.files??[]).length);}catch(error){setText('git-status',error.message);} }
function renderGitFiles(files) { const root=byId('git-files'),panel=byId('panel-file-list');clear(root);clear(panel);for(const file of files){const label=document.createElement('label');label.className='git-file';const input=document.createElement('input');input.type='checkbox';input.dataset.path=file.path;const status=document.createElement('span');status.className='git-file-status';status.textContent=file.status;const path=document.createElement('span');path.textContent=file.path;label.append(input,status,path);label.addEventListener('click',()=>void loadDiff(file.path));root.append(label);const copy=document.createElement('div');copy.className='panel-file';copy.append(Object.assign(document.createElement('span'),{textContent:'▧'}),Object.assign(document.createElement('span'),{textContent:file.path}),Object.assign(document.createElement('small'),{textContent:file.status}));panel.append(copy);}if(!files.length){root.append(emptyText('暂无改动'));panel.append(emptyText('Worktree 暂无变更'));} }
async function loadDiff(path){const session=activeSession();if(!session)return;try{const result=operationError(await window.tsukiori.workspace.gitDiff(session.id,path));setText('git-diff',result.diff||'该文件没有 Working Diff');}catch(error){setText('git-diff',error.message);} }
function selectedPaths(){return[...byId('git-files').querySelectorAll('input:checked')].map((input)=>input.dataset.path);}
async function mutateGit(kind){const session=activeSession();if(!session)return;try{operationError(await window.tsukiori.workspace[kind](session.id,selectedPaths()));await refreshGit();}catch(error){setText('git-status',error.message);} }
async function commitFiles(){const session=activeSession();if(!session)return;try{const result=operationError(await window.tsukiori.workspace.commit(session.id,byId('commit-subject').value));setText('git-status','已提交 '+result.sha.slice(0,8));byId('commit-subject').value='';await refreshGit();}catch(error){setText('git-status',error.message);} }

const settingsMeta={general:['通用','启动行为、语言、更新与默认工作方式'],appearance:['外观','主题、界面密度与动态效果'],account:['账号','本地身份与 Runtime 授权状态'],agent:['Agent','Runtime、Provider、模型与 API Key'],usage:['用量','本机 Session 与 Turn 统计'],projects:['项目','项目默认规则与本地工作区'],devices:['设备','本机 Runtime 与执行环境'],github:['GitHub','本地 Git 与远程凭据边界'],shortcuts:['键盘快捷键','全局与工作区快捷键'],billing:['账单','Provider 直接结算说明'],about:['关于','版本、开源组件与诊断导出']};
function openSettings(page='general'){byId('settings-dialog').showModal();showSettingsPage(page);renderSettingsData();}
function showSettingsPage(page){for(const button of byId('settings-nav').querySelectorAll('button'))button.classList.toggle('active',button.dataset.settingsPage===page);for(const view of document.querySelectorAll('[data-settings-view]'))view.hidden=view.dataset.settingsView!==page;setText('settings-title',settingsMeta[page][0]);setText('settings-subtitle',settingsMeta[page][1]);}
function renderSettingsData(){const s=state.settings??{};byId('setting-language').value=s.language??'zh-CN';byId('setting-auto-update').checked=s.autoUpdate!==false;byId('setting-start-minimized').checked=s.startMinimized===true;byId('setting-theme').value=s.theme??'light';byId('setting-density').value=s.density??'comfortable';byId('setting-reduce-motion').checked=s.reduceMotion===true;fillRuntime(byId('setting-default-runtime'),s.defaultRuntime??'codex');fillProvider(byId('setting-default-provider'),byId('setting-default-runtime').value,s.defaultProviderId);renderProviderList();renderSettingsRuntimes();renderSettingsProjects();renderUsage();setText('about-version','Desktop '+(state.versions.desktop??'—')+' · Protocol '+(state.versions.protocol??'—'));}
function renderProviderList(){const root=byId('provider-settings-list');clear(root);for(const provider of state.providers){const button=document.createElement('button');button.type='button';button.className='provider-list-item'+(provider.id===state.selectedProviderId?' active':'');const icon=document.createElement('span');icon.className='provider-icon';icon.textContent=provider.name.slice(0,1).toUpperCase();const text=document.createElement('span');const strong=document.createElement('strong');strong.textContent=provider.name;const small=document.createElement('small');small.textContent=provider.kind+' · '+(provider.hasSecret||provider.kind==='chatgpt'?'已配置':'需要 API Key');text.append(strong,small);const status=document.createElement('b');status.textContent=provider.lastTest?.ok?'已连接':'›';button.append(icon,text,status);button.addEventListener('click',()=>selectProviderEditor(provider.id));root.append(button);}if(!state.selectedProviderId&&state.providers[0])selectProviderEditor(state.providers[0].id,false);}
function selectProviderEditor(id,rerender=true){state.selectedProviderId=id;const p=providerById(id);if(!p)return;byId('provider-id').value=p.id;byId('provider-name').value=p.name;if(p.kind==='chatgpt'&&![...byId('provider-kind').options].some((option)=>option.value==='chatgpt'))appendOption(byId('provider-kind'),'chatgpt','ChatGPT 登录');byId('provider-kind').value=p.kind;byId('provider-base-url').value=p.baseUrl;byId('provider-models').value=(p.models??[]).join(', ');byId('provider-api-key').value='';byId('provider-api-key').placeholder=p.hasSecret?'已保存，留空则保持不变':'输入 API Key';byId('delete-provider').disabled=p.kind==='chatgpt';setText('provider-editor-title',p.name);setText('provider-editor-status',p.lastTest?`${p.lastTest.ok?'连接成功':'连接失败'} · ${p.lastTest.latencyMs} ms · ${p.lastTest.category}`:'');if(rerender)renderProviderList();}
function newProvider(){state.selectedProviderId=null;byId('provider-id').value='';byId('provider-name').value='自定义 Provider';byId('provider-kind').value='openai-compatible';byId('provider-base-url').value='https://';byId('provider-models').value='';byId('provider-api-key').value='';byId('delete-provider').disabled=true;setText('provider-editor-title','添加 Provider');setText('provider-editor-status','');}
async function saveProvider(){try{const models=byId('provider-models').value.split(',').map((v)=>v.trim()).filter(Boolean);const result=operationError(await window.tsukiori.workspace.saveProvider({id:byId('provider-id').value||undefined,name:byId('provider-name').value,kind:byId('provider-kind').value,baseUrl:byId('provider-base-url').value,models,apiKey:byId('provider-api-key').value||undefined,enabled:true}));state.selectedProviderId=result.provider.id;setText('provider-editor-status','已安全保存');await reloadSnapshot();}catch(error){setText('provider-editor-status',error.message);} }
async function testProvider(){const id=byId('provider-id').value;if(!id){setText('provider-editor-status','请先保存 Provider');return;}setText('provider-editor-status','正在测试连接…');try{const result=operationError(await window.tsukiori.workspace.testProvider(id));setText('provider-editor-status',`${result.test.ok?'连接成功':'连接失败'} · ${result.test.latencyMs} ms · ${result.test.category}`);await reloadSnapshot();}catch(error){setText('provider-editor-status',error.message);} }
async function deleteProvider(){const id=byId('provider-id').value;if(!id)return;try{operationError(await window.tsukiori.workspace.deleteProvider(id));state.selectedProviderId=null;newProvider();await reloadSnapshot();}catch(error){setText('provider-editor-status',error.message);} }
function renderSettingsRuntimes(){for(const id of ['settings-runtime-list','device-runtime-list']){const root=byId(id);if(!root)continue;clear(root);for(const runtime of state.runtimes){const row=document.createElement('div');row.className='settings-runtime-item';const orb=document.createElement('span');orb.className='runtime-orb '+(runtime.type==='claude'?'claude':'codex');orb.textContent=runtime.type.slice(0,1).toUpperCase();const box=document.createElement('div');box.append(Object.assign(document.createElement('strong'),{textContent:runtime.name}),Object.assign(document.createElement('small'),{textContent:runtime.version+' · '+runtime.source}));const level=document.createElement('b');level.textContent=runtime.available?runtime.supportLevel:'不可用';row.append(orb,box,level);root.append(row);}}}
function renderSettingsProjects(){const root=byId('settings-project-list');clear(root);for(const project of state.projects){const row=document.createElement('div');row.className='setting-row';const box=document.createElement('span');box.append(Object.assign(document.createElement('strong'),{textContent:project.name}),Object.assign(document.createElement('small'),{textContent:project.gitRoot}));row.append(box,Object.assign(document.createElement('span'),{textContent:project.branch}));root.append(row);}if(!state.projects.length)root.append(emptyText('尚未添加项目'));}
function renderUsage(){setText('usage-turns',state.usage.turnCount??0);setText('usage-sessions',state.usage.sessionCount??0);const root=byId('usage-bars');clear(root);const values=Object.entries(state.usage.byRuntime??{});const max=Math.max(1,...values.map(([,v])=>v));for(const [runtime,count]of values){const row=document.createElement('div');row.className='usage-bar';const label=document.createElement('span');label.textContent=runtime;const bar=document.createElement('i');bar.style.setProperty('--value',Math.round(count/max*100)+'%');const value=document.createElement('b');value.textContent=String(count);row.append(label,bar,value);root.append(row);}if(!values.length)root.append(emptyText('暂无用量数据'));}
async function saveSettings(){try{const result=operationError(await window.tsukiori.workspace.updateSettings({language:byId('setting-language').value,autoUpdate:byId('setting-auto-update').checked,startMinimized:byId('setting-start-minimized').checked,theme:byId('setting-theme').value,density:byId('setting-density').value,reduceMotion:byId('setting-reduce-motion').checked,defaultRuntime:byId('setting-default-runtime').value,defaultProviderId:byId('setting-default-provider').value}));state.settings=result.settings;applyAppearance();setText('settings-save-status','已保存到本机');}catch(error){setText('settings-save-status',error.message);} }
function applyAppearance(){document.body.classList.toggle('density-compact',state.settings.density==='compact');document.body.classList.toggle('reduce-motion',state.settings.reduceMotion===true);}

function bindUi(){
  byId('add-project').addEventListener('click',pickProject);byId('onboarding-add-project').addEventListener('click',pickProject);byId('settings-add-project').addEventListener('click',pickProject);
  byId('refresh-runtimes').addEventListener('click',async()=>{try{operationError(await window.tsukiori.workspace.refreshRuntimes());await reloadSnapshot();}catch(error){setText('onboarding-status',error.message);}});byId('settings-refresh-runtimes').addEventListener('click',()=>byId('refresh-runtimes').click());
  for(const id of ['rail-new-session','new-session','dashboard-new-session','header-new-session'])byId(id).addEventListener('click',()=>openSessionDialog());
  byId('session-back').addEventListener('click',()=>{state.activeSessionId=null;renderAll();});
  byId('runtime-quick-switch').addEventListener('click',()=>openSessionDialog(activeSession()?.runtimeType==='claude'?'codex':'claude'));
  byId('session-create-form').addEventListener('submit',createSession);byId('create-runtime').addEventListener('change',updateCreateProvider);byId('create-provider').addEventListener('change',updateCreateModel);
  byId('prompt-form').addEventListener('submit',sendPrompt);byId('prompt-input').addEventListener('keydown',(event)=>{if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();byId('prompt-form').requestSubmit();}});
  byId('runtime-select').addEventListener('change',()=>{if(byId('runtime-select').value!==activeSession()?.runtimeType)openSessionDialog(byId('runtime-select').value);});byId('provider-select').addEventListener('change',()=>{fillModels(byId('model-select'),byId('provider-select').value);void updateActiveOptions();});byId('model-select').addEventListener('change',updateActiveOptions);byId('permission-select').addEventListener('change',updateActiveOptions);
  byId('interrupt-turn').addEventListener('click',async()=>{try{operationError(await window.tsukiori.workspace.interruptTurn(state.activeSessionId));}catch(error){setText('turn-status',error.message);}});
  byId('clear-terminal').addEventListener('click',()=>setText('terminal-output','PS > 显示已清空。'));byId('terminal-collapse').addEventListener('click',()=>document.querySelector('.app-shell').classList.toggle('terminal-collapsed'));
  byId('toggle-left-panel').addEventListener('click',()=>document.querySelector('.app-shell').classList.toggle('left-collapsed'));byId('toggle-right-panel').addEventListener('click',()=>document.querySelector('.app-shell').classList.toggle('right-collapsed'));byId('toggle-terminal').addEventListener('click',()=>document.querySelector('.app-shell').classList.toggle('terminal-collapsed'));
  for(const button of document.querySelectorAll('[data-panel-tab]'))button.addEventListener('click',()=>activateWorkPanel(button.dataset.panelTab));byId('work-panel-back').addEventListener('click',()=>activateWorkPanel(null));byId('work-panel-close').addEventListener('click',()=>document.querySelector('.app-shell').classList.add('right-collapsed'));byId('header-work-panel').addEventListener('click',()=>document.querySelector('.app-shell').classList.toggle('right-collapsed'));byId('rail-files').addEventListener('click',()=>activateWorkPanel('files'));byId('rail-attention').addEventListener('click',()=>activateWorkPanel('chat'));
  byId('refresh-git').addEventListener('click',refreshGit);byId('stage-files').addEventListener('click',()=>mutateGit('stage'));byId('unstage-files').addEventListener('click',()=>mutateGit('unstage'));byId('commit-files').addEventListener('click',commitFiles);byId('open-worktree').addEventListener('click',async()=>{try{operationError(await window.tsukiori.workspace.openWorktree(state.activeSessionId));}catch(error){setText('worktree-path',error.message);}});byId('open-browser-url').addEventListener('click',async()=>{try{operationError(await window.tsukiori.workspace.openUrl(byId('browser-url').value));setText('browser-status','已在系统浏览器打开');}catch(error){setText('browser-status',error.message);}});
  byId('open-settings').addEventListener('click',()=>openSettings());byId('close-settings').addEventListener('click',()=>byId('settings-dialog').close());for(const button of byId('settings-nav').querySelectorAll('button'))button.addEventListener('click',()=>showSettingsPage(button.dataset.settingsPage));byId('save-settings').addEventListener('click',saveSettings);byId('setting-default-runtime').addEventListener('change',()=>fillProvider(byId('setting-default-provider'),byId('setting-default-runtime').value));
  byId('new-provider').addEventListener('click',newProvider);byId('save-provider').addEventListener('click',saveProvider);byId('test-provider').addEventListener('click',testProvider);byId('delete-provider').addEventListener('click',deleteProvider);byId('provider-kind').addEventListener('change',()=>{const presets={openai:'https://api.openai.com',anthropic:'https://api.anthropic.com',deepseek:'https://api.deepseek.com/anthropic','openai-compatible':'https://','anthropic-compatible':'https://'};byId('provider-base-url').value=presets[byId('provider-kind').value];});
  byId('export-settings').addEventListener('click',async()=>{try{const result=operationError(await window.tsukiori.workspace.exportSettings());setText('export-settings-status',result.canceled?'已取消':'已导出（不含密钥）');}catch(error){setText('export-settings-status',error.message);}});
  byId('report-bug').addEventListener('click',()=>window.tsukiori.workspace.openUrl('https://github.com/Nineu1124/Tsukiori/issues'));
  byId('copy-github-help').addEventListener('click',()=>{const project=activeProject();setText('github-status',project?`本地项目：${project.name}\n分支：${project.branch}\n路径：仅保存在本机`:'尚未选择项目');});
  document.addEventListener('keydown',(event)=>{if(event.ctrlKey&&event.key===','){event.preventDefault();openSettings();}if(event.ctrlKey&&event.key.toLowerCase()==='j'){event.preventDefault();document.querySelector('.app-shell').classList.toggle('terminal-collapsed');}});
  const poll=async()=>{try{const result=operationError(await window.tsukiori.workspace.pollEvents(state.eventCursor));for(const event of result.events??[])acceptEvent(event);state.eventCursor=Math.max(state.eventCursor,result.cursor??0);}catch{}};setInterval(poll,250);
}

function emptyText(text){const p=document.createElement('p');p.className='empty-state';p.textContent=text;return p;}
function relativeTime(value){const minutes=Math.max(0,Math.floor((Date.now()-Number(value))/60000));return minutes<1?'刚刚':minutes<60?minutes+' 分钟':Math.floor(minutes/60)+' 小时';}
function statusLabel(value){return({ready:'Ready',running:'Running',waiting_permission:'Waiting approval',error:'Error',starting:'Starting',stopped:'Stopped'})[value]??value;}

try {
  const [daemon,versions,snapshot]=await Promise.all([window.tsukiori.daemon.status(),window.tsukiori.versions(),window.tsukiori.workspace.snapshot()]);
  setText('status','Daemon '+daemon.daemonVersion);byId('daemon-dot').classList.add('healthy');state.versions=versions;
  if(snapshot?.mode==='interactive'){
    document.body.classList.add('interactive-mode');for(const key of ['projects','sessions','runtimes','providers','recentEvents','permissions','settings','usage'])state[key]=snapshot[key]??state[key];state.eventCursor=snapshot.eventCursor??0;state.activeProjectId=state.projects[0]?.id??null;state.activeSessionId=state.sessions.find((item)=>item.projectId===state.activeProjectId)?.id??null;bindUi();applyAppearance();renderAll();
  }else{
    byId('interactive-workspace').hidden=true;byId('legacy-workspace').hidden=false;setText('version','Protocol '+versions.protocol);renderAlphaWorkflow(snapshot.workflow);renderV1GitWorkflow(snapshot.v1Git);renderDiagnosticBundle(snapshot.diagnostics);for(const tool of snapshot.tools??[])renderTool(tool);for(const runtime of snapshot.runtimes??[])renderRuntime(runtime);clear(byId('attention-list'));for(const permission of snapshot.permissions??[])renderPermission(permission,byId('attention-list'));for(const item of snapshot.attention??[]){const card=document.createElement('article');card.className='attention-item '+item.kind;card.textContent=item.title;byId('attention-list').append(card);}setText('attention-count',(snapshot.attention??[]).length);
  }
}catch(error){setText('status','Daemon 不可用');byId('daemon-dot').classList.add('failed');}
