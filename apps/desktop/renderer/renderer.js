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
  projects: [], sessions: [], teams: [], runtimes: [], providers: [], recentEvents: [], permissions: [],
  settings: {}, usage: {}, activeProjectId: null, activeSessionId: null, assistantDraft: null,
  eventCursor: 0, versions: {}, selectedProviderId: null, attachments: [], terminalSessionId: null,
  filePreviewContent: '', nativeCapabilities: null,
};

function activeProject() { return state.projects.find((item) => item.id === state.activeProjectId); }
function activeSession() { return state.sessions.find((item) => item.id === state.activeSessionId); }
function providerById(id) { return state.providers.find((item) => item.id === id); }
function runtimeByType(type) { return state.runtimes.find((item) => item.type === type); }
function isCompatible(runtime, provider) { return runtime === 'codex' ? ['chatgpt','openai','openai-compatible'].includes(provider.kind) : ['anthropic','deepseek','anthropic-compatible'].includes(provider.kind); }

async function reloadSnapshot() {
  const snapshot = await window.tsukiori.workspace.snapshot();
  for (const key of ['projects','sessions','teams','runtimes','providers','recentEvents','permissions','settings','usage']) state[key] = snapshot[key] ?? state[key];
  state.eventCursor = Math.max(state.eventCursor, snapshot.eventCursor ?? 0);
  if (!state.projects.some((item) => item.id === state.activeProjectId)) state.activeProjectId = state.projects[0]?.id ?? null;
  if (!state.sessions.some((item) => item.id === state.activeSessionId && !item.archivedAt)) state.activeSessionId = state.sessions.find((item) => item.projectId === state.activeProjectId && !item.archivedAt)?.id ?? null;
  applyAppearance(); renderAll();
}

function renderAll() {
  renderNavigation(); renderMain(); renderRuntimeQuickSwitch(); renderComposerSelectors(); renderPermissions(); renderTeams(); renderSettingsData();
}

function renderNavigation() {
  const projects = byId('project-list'); clear(projects);
  for (const project of state.projects) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'rail-item' + (project.id === state.activeProjectId ? ' active' : '');
    const icon = document.createElement('i'); icon.textContent = '▱'; const name = document.createElement('span'); name.textContent = project.name; const branch = document.createElement('small'); branch.textContent = project.branch;
    button.append(icon,name,branch); button.addEventListener('click', () => { state.activeProjectId = project.id; state.activeSessionId = state.sessions.find((item) => item.projectId === project.id && !item.archivedAt)?.id ?? null; renderAll(); }); projects.append(button);
  }
  if (!state.projects.length) projects.append(emptyText('尚未添加项目'));
  const sessions = byId('session-list'); clear(sessions);
  const query = byId('history-query')?.value.trim().toLowerCase() ?? '';
  for (const session of state.sessions.filter((item) => item.projectId === state.activeProjectId && !item.archivedAt && (!query || item.name.toLowerCase().includes(query))).sort((a,b) => Number(b.pinned)-Number(a.pinned) || b.updatedAt - a.updatedAt)) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'rail-item' + (session.id === state.activeSessionId ? ' active' : '');
    const icon = document.createElement('i'); icon.textContent = session.pinned ? '★' : session.runtimeType === 'claude' ? '◈' : '◫'; const name = document.createElement('span'); name.textContent = session.name; const time = document.createElement('small'); time.textContent = relativeTime(session.updatedAt ?? session.createdAt);
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
  const projectSessions = state.sessions.filter((item) => item.projectId === project.id && !item.archivedAt);
  setText('metric-worktrees', projectSessions.length); setText('metric-running', projectSessions.filter((item) => item.status === 'running').length); setText('metric-attention', state.permissions.length);
  const dashboard = byId('dashboard-sessions'); clear(dashboard);
  for (const item of projectSessions.slice(0,5)) { const row = document.createElement('button'); row.className = 'rail-item'; row.type = 'button'; row.append(Object.assign(document.createElement('i'),{textContent:item.runtimeType === 'claude' ? 'C' : 'X'}),Object.assign(document.createElement('span'),{textContent:item.name}),Object.assign(document.createElement('small'),{textContent:item.status})); row.addEventListener('click',()=>{state.activeSessionId=item.id;renderAll();}); dashboard.append(row); }
  const runtimeDashboard = byId('dashboard-runtimes'); clear(runtimeDashboard); for (const runtime of state.runtimes) runtimeDashboard.append(runtimeRow(runtime));
  if (!session) return;
  const runtime = runtimeByType(session.runtimeType); const provider = providerById(session.providerId);
  setText('interactive-title', session.name); setText('interactive-eyebrow', project.name + ' / ' + session.branch); setText('runtime-badge', runtime?.name ?? session.runtimeType); setText('provider-badge', provider?.name ?? session.providerId); setText('session-context-path', session.worktreePath); setText('interactive-version', 'Protocol ' + (state.versions.protocol ?? '—'));
  for(const id of ['session-pin','session-favorite']){const button=byId(id);button.textContent=session.pinned?'★':'☆';button.setAttribute('aria-pressed',String(Boolean(session.pinned)));}
  renderConversation(session.id); byId('interrupt-turn').disabled = session.status !== 'running'; setText('turn-status', statusLabel(session.status));
  void ensureTerminal(session.id);
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
function messageNode(kind,label,text) { const node=document.createElement('article');node.className='chat-message '+kind;const meta=document.createElement('div');meta.className='message-meta';meta.textContent=label;const body=document.createElement('div');body.className='message-body';body.dataset.raw=String(text??'');renderMarkdownBody(body,body.dataset.raw);node.append(meta,body);return node; }

function renderMarkdownBody(root,text){
  clear(root);const lines=String(text??'').split(/\r?\n/);let index=0;
  while(index<lines.length){const line=lines[index];
    if(line.startsWith('```')){const language=line.slice(3).trim();const code=[];index+=1;while(index<lines.length&&!lines[index].startsWith('```'))code.push(lines[index++]);if(index<lines.length)index+=1;const pre=document.createElement('pre');const codeNode=document.createElement('code');codeNode.textContent=code.join('\n');if(language)codeNode.dataset.language=language;pre.append(codeNode);root.append(pre);continue;}
    const heading=line.match(/^(#{1,3})\s+(.+)$/);if(heading){const node=document.createElement('h'+heading[1].length);appendInline(node,heading[2]);root.append(node);index+=1;continue;}
    if(/^[-*]\s+/.test(line)){const list=document.createElement('ul');while(index<lines.length&&/^[-*]\s+/.test(lines[index])){const item=document.createElement('li');appendInline(item,lines[index].replace(/^[-*]\s+/,''));list.append(item);index+=1;}root.append(list);continue;}
    if(/^\d+\.\s+/.test(line)){const list=document.createElement('ol');while(index<lines.length&&/^\d+\.\s+/.test(lines[index])){const item=document.createElement('li');appendInline(item,lines[index].replace(/^\d+\.\s+/,''));list.append(item);index+=1;}root.append(list);continue;}
    if(line.startsWith('> ')){const quote=document.createElement('blockquote');appendInline(quote,line.slice(2));root.append(quote);index+=1;continue;}
    if(!line.trim()){index+=1;continue;}const paragraph=document.createElement('p');const parts=[line];index+=1;while(index<lines.length&&lines[index].trim()&&!/^(#{1,3})\s+|^```|^[-*]\s+|^\d+\.\s+|^> /.test(lines[index]))parts.push(lines[index++]);appendInline(paragraph,parts.join('\n'));root.append(paragraph);
  }
}

function appendInline(root,text){const pattern=/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g;let cursor=0;for(const match of String(text).matchAll(pattern)){if(match.index>cursor)root.append(document.createTextNode(text.slice(cursor,match.index)));const token=match[0];if(token.startsWith('`')){const code=document.createElement('code');code.textContent=token.slice(1,-1);root.append(code);}else if(token.startsWith('**')){const strong=document.createElement('strong');strong.textContent=token.slice(2,-2);root.append(strong);}else{const parsed=token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);const anchor=document.createElement('a');anchor.textContent=parsed?.[1]??token;try{const url=new URL(parsed?.[2]??'');if(['http:','https:'].includes(url.protocol)){anchor.href=url.toString();anchor.target='_blank';anchor.rel='noreferrer';}else anchor.removeAttribute('href');}catch{anchor.removeAttribute('href');}root.append(anchor);}cursor=(match.index??0)+token.length;}if(cursor<text.length)root.append(document.createTextNode(text.slice(cursor)));}

function stripAnsi(value){return value.replace(/[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g,'').slice(-200000);}

function appendEvent(target,event,scroll=true) {
  if (event.type === 'user.message') { target.append(messageNode('user','你',event.payload.text)); state.assistantDraft=null; }
  else if (event.type === 'assistant.delta') {
    if (!state.assistantDraft || !target.contains(state.assistantDraft)) { state.assistantDraft=messageNode('assistant',activeSession()?.runtimeType==='claude'?'Claude Code':'Codex',''); target.append(state.assistantDraft); }
    const body=state.assistantDraft.querySelector('.message-body');body.dataset.raw=(body.dataset.raw??'')+String(event.payload.text??'');renderMarkdownBody(body,body.dataset.raw);
  } else if (event.type === 'tool.event') { const kind=classifyToolEvent(String(event.payload.tool??''),String(event.payload.summary??''));const node=messageNode('tool',kind.toUpperCase()+' · '+String(event.payload.tool??'TOOL'),event.payload.summary);node.dataset.toolKind=kind;target.append(node); }
  else if (event.type === 'attachment.added') { target.append(messageNode('tool','ATTACHMENT',(event.payload.files??[]).map((file)=>file.path).join('\n'))); }
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

function appendTerminalEvent(event) { const output=byId('terminal-output'); if(event.type==='terminal.output'){output.textContent+=stripAnsi(String(event.payload.data??''));if(output.textContent.length>500000)output.textContent=output.textContent.slice(-500000);output.scrollTop=output.scrollHeight;return;}if(event.type==='terminal.started'){output.textContent=`PowerShell · ${event.payload.cwd}\n`;return;}if(event.type==='terminal.exited'){output.textContent+=`\n[terminal exited ${event.payload.exitCode}]`;return;}if (!['turn.started','turn.completed','tool.event','runtime.error','permission.requested'].includes(event.type)) return; const kind=event.type==='tool.event'?classifyToolEvent(String(event.payload.tool??''),String(event.payload.summary??'')):event.type; output.textContent += '\n['+new Date(event.createdAt).toLocaleTimeString()+'] '+kind+' '+String(event.payload.summary??event.payload.message??event.payload.status??''); output.scrollTop=output.scrollHeight; }
function acceptEvent(event) { state.recentEvents.push(event); if (state.recentEvents.length>300) state.recentEvents.splice(0,state.recentEvents.length-300); appendTerminalEvent(event); if (event.sessionId===state.activeSessionId&&!event.type.startsWith('terminal.')) appendEvent(byId('conversation'),event); if (event.type==='permission.requested'||event.type==='permission.resolved') void reloadSnapshot(); if (event.type==='turn.started'||event.type==='turn.completed'||event.type==='runtime.error'||event.type==='team.started'||event.type==='team.completed') void reloadSnapshot(); }

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
async function sendPrompt(event) { event.preventDefault(); const session=activeSession(); const input=byId('prompt-input'); if(!session||!input.value.trim())return; const original=input.value;const refs=state.attachments.map((item)=>item.path);const text=refs.length?original+'\n\n本次任务附件（均已复制到当前 Worktree）：\n'+refs.map((path)=>'- '+path).join('\n'):original; input.value=''; setText('turn-status','正在发送…'); try{operationError(await window.tsukiori.workspace.sendPrompt(session.id,text));state.attachments=[];renderAttachments();}catch(error){input.value=original;setText('turn-status',error.message);} }

function renderPermissions() { const root=byId('attention-list'); clear(root); for(const permission of state.permissions)renderPermission(permission,root); if(!root.children.length)root.append(emptyText('暂无待处理事项'));setText('attention-count',state.permissions.length); }

function renderTeams(){const root=byId('team-list');if(!root)return;clear(root);for(const team of state.teams.filter((item)=>item.projectId===state.activeProjectId).sort((a,b)=>b.updatedAt-a.updatedAt)){const row=document.createElement('article');row.className='team-row';const strong=document.createElement('strong');strong.textContent=team.name;const small=document.createElement('small');small.textContent=`${team.memberSessionIds.length} Agent · ${team.status}`;row.append(strong,small);row.addEventListener('click',()=>{const first=team.memberSessionIds.find((id)=>state.sessions.some((session)=>session.id===id));if(first){state.activeSessionId=first;renderAll();}});root.append(row);} }

function openTeamDialog(){if(!activeProject()){setText('onboarding-status','请先添加本地 Git 项目');return;}for(const section of document.querySelectorAll('[data-team-agent]'))updateTeamAgent(section,true);byId('team-dialog').showModal();}
function updateTeamAgent(section,reset=false){const runtime=section.querySelector('[data-team-runtime]');const provider=section.querySelector('[data-team-provider]');const model=section.querySelector('[data-team-model]');if(reset||!runtime.children.length)fillRuntime(runtime,runtime.value||state.settings.defaultRuntime||'codex');fillProvider(provider,runtime.value,provider.value||state.settings.defaultProviderId);fillModels(model,provider.value,model.value||state.settings.defaultModel);}
async function createTeam(event){event.preventDefault();const project=activeProject();if(!project)return;const agents=[...document.querySelectorAll('[data-team-agent]')].map((section)=>({role:section.querySelector('[data-team-role]').value,runtimeType:section.querySelector('[data-team-runtime]').value,providerId:section.querySelector('[data-team-provider]').value,model:section.querySelector('[data-team-model]').value}));setText('team-create-status','正在创建独立 Worktree 并派发…');try{operationError(await window.tsukiori.workspace.createTeam(project.id,byId('team-goal').value,agents));byId('team-dialog').close();byId('team-goal').value='';await reloadSnapshot();activateWorkPanel('chat');}catch(error){setText('team-create-status',error.message);} }

async function ensureTerminal(sessionId){if(state.terminalSessionId===sessionId)return;if(state.terminalSessionId){await window.tsukiori.workspace.stopTerminal(state.terminalSessionId).catch(()=>undefined);}state.terminalSessionId=sessionId;setText('terminal-output','正在启动 PowerShell…\n');try{operationError(await window.tsukiori.workspace.startTerminal(sessionId,120,28));}catch(error){setText('terminal-output',error.message);} }
async function restartTerminal(){const session=activeSession();if(!session)return;try{if(state.terminalSessionId){await window.tsukiori.workspace.stopTerminal(state.terminalSessionId).catch(()=>undefined);state.terminalSessionId=null;}setText('terminal-output','正在重启 PowerShell…\n');await ensureTerminal(session.id);byId('terminal-input').focus();}catch(error){setText('terminal-output',error.message);} }

async function attachFiles(){const session=activeSession();if(!session)return;try{const result=operationError(await window.tsukiori.workspace.pickAttachments(session.id));if(result.canceled)return;state.attachments.push(...(result.attachments??[]));renderAttachments();await refreshFiles();}catch(error){setText('turn-status',error.message);} }
function renderAttachments(){const root=byId('composer-attachments');clear(root);for(const attachment of state.attachments){const chip=document.createElement('span');chip.className='attachment-chip';chip.textContent=attachment.path;root.append(chip);}root.hidden=state.attachments.length===0;}

async function refreshFiles(){const session=activeSession();if(!session)return;try{const result=operationError(await window.tsukiori.workspace.listFiles(session.id,byId('file-query').value));renderFileList(result.files??[]);}catch(error){setText('file-preview',error.message);} }
function renderFileList(files){const root=byId('panel-file-list');clear(root);for(const file of files){const row=document.createElement('button');row.type='button';row.className='panel-file';row.append(Object.assign(document.createElement('span'),{textContent:'▧'}),Object.assign(document.createElement('span'),{textContent:file.path}),Object.assign(document.createElement('small'),{textContent:formatBytes(file.size)}));row.addEventListener('click',()=>void loadFilePreview(file.path,row));root.append(row);}if(!files.length)root.append(emptyText('没有匹配的文件'));}
async function loadFilePreview(path,row){const session=activeSession();if(!session)return;try{const result=operationError(await window.tsukiori.workspace.readFile(session.id,path));state.filePreviewContent=result.file.content;setText('file-preview-name',result.file.path+(result.file.truncated?' · 已截断':''));setText('file-preview',result.file.content);for(const item of byId('panel-file-list').children)item.classList.toggle('active',item===row);}catch(error){state.filePreviewContent='';setText('file-preview-name',path);setText('file-preview',error.message);} }

async function loadCodexNative(){const session=activeSession();const root=byId('native-capability-list');if(!session||session.runtimeType!=='codex'){clear(root);root.append(emptyText('请选择 Codex Session'));return;}clear(root);root.append(emptyText('正在读取 Skills 与 MCP…'));try{const result=operationError(await window.tsukiori.workspace.codexNative(session.id));state.nativeCapabilities=result.native;clear(root);for(const skill of result.native.skills??[]){const item=document.createElement('article');item.className='native-capability';item.append(Object.assign(document.createElement('strong'),{textContent:'Skill · '+skill.name}),Object.assign(document.createElement('small'),{textContent:(skill.enabled?'enabled':'disabled')+' · '+skill.scope+' · '+skill.description}));root.append(item);}for(const server of result.native.servers??[]){const item=document.createElement('article');item.className='native-capability';item.append(Object.assign(document.createElement('strong'),{textContent:'MCP · '+server.name}),Object.assign(document.createElement('small'),{textContent:`${server.authStatus} · ${server.toolCount} tools · ${server.resourceCount} resources`}));root.append(item);}if(!root.children.length)root.append(emptyText('当前 Session 未发现 Skills 或 MCP'));}catch(error){clear(root);root.append(emptyText(error.message));} }

async function renameActiveSession(){const session=activeSession();if(!session)return;const name=window.prompt('新的 Session 名称',session.name);if(name===null)return;try{operationError(await window.tsukiori.workspace.renameSession(session.id,name));await reloadSnapshot();}catch(error){setText('turn-status',error.message);} }
async function pinActiveSession(){const session=activeSession();if(!session)return;try{operationError(await window.tsukiori.workspace.pinSession(session.id,!session.pinned));await reloadSnapshot();}catch(error){setText('turn-status',error.message);} }
async function archiveActiveSession(){const session=activeSession();if(!session)return;if(!window.confirm('归档此 Session？独立 Worktree 会保留，不会删除未提交代码。'))return;try{if(state.terminalSessionId===session.id){await window.tsukiori.workspace.stopTerminal(session.id);state.terminalSessionId=null;}operationError(await window.tsukiori.workspace.archiveSession(session.id));state.activeSessionId=null;await reloadSnapshot();}catch(error){setText('turn-status',error.message);} }

function activateWorkPanel(name) { byId('work-panel-home').hidden=Boolean(name); for(const view of document.querySelectorAll('[data-panel-view]'))view.hidden=view.dataset.panelView!==name; if(name==='changes')void refreshGit();if(name==='files')void refreshFiles(); }
async function refreshGit() { const session=activeSession(); if(!session)return; try{const result=operationError(await window.tsukiori.workspace.gitStatus(session.id));setText('worktree-path',result.git.worktreePath);renderGitFiles(result.git.files??[]);setText('metric-changes',(result.git.files??[]).length);}catch(error){setText('git-status',error.message);} }
function renderGitFiles(files) { const root=byId('git-files');clear(root);for(const file of files){const label=document.createElement('label');label.className='git-file';const input=document.createElement('input');input.type='checkbox';input.dataset.path=file.path;const status=document.createElement('span');status.className='git-file-status';status.textContent=file.status;const path=document.createElement('span');path.textContent=file.path;label.append(input,status,path);label.addEventListener('click',()=>void loadDiff(file.path));root.append(label);}if(!files.length)root.append(emptyText('暂无改动')); }
async function loadDiff(path){const session=activeSession();if(!session)return;try{const result=operationError(await window.tsukiori.workspace.gitDiff(session.id,path));setText('git-diff',result.diff||'该文件没有 Working Diff');}catch(error){setText('git-diff',error.message);} }
function selectedPaths(){return[...byId('git-files').querySelectorAll('input:checked')].map((input)=>input.dataset.path);}
async function mutateGit(kind){const session=activeSession();if(!session)return;try{operationError(await window.tsukiori.workspace[kind](session.id,selectedPaths()));await refreshGit();}catch(error){setText('git-status',error.message);} }
async function commitFiles(){const session=activeSession();if(!session)return;try{const result=operationError(await window.tsukiori.workspace.commit(session.id,byId('commit-subject').value));setText('git-status','已提交 '+result.sha.slice(0,8));byId('commit-subject').value='';await refreshGit();}catch(error){setText('git-status',error.message);} }

const settingsMeta={general:['通用','启动行为、语言、更新与默认工作方式'],appearance:['外观','主题、界面密度与动态效果'],account:['账号','本地身份与 Runtime 授权状态'],agent:['Agent','Runtime、Provider、模型与 API Key'],usage:['用量','本机 Session 与 Turn 统计'],projects:['项目','项目默认规则与本地工作区'],devices:['设备','本机 Runtime 与执行环境'],github:['GitHub','本地 Git 与远程凭据边界'],shortcuts:['键盘快捷键','全局与工作区快捷键'],billing:['账单','Provider 直接结算说明'],about:['关于','版本、开源组件与诊断导出']};
function openSettings(page='general'){byId('settings-dialog').showModal();showSettingsPage(page);renderSettingsData();}
function showSettingsPage(page){for(const button of byId('settings-nav').querySelectorAll('button'))button.classList.toggle('active',button.dataset.settingsPage===page);for(const view of document.querySelectorAll('[data-settings-view]'))view.hidden=view.dataset.settingsView!==page;setText('settings-title',settingsMeta[page][0]);setText('settings-subtitle',settingsMeta[page][1]);}
function renderSettingsData(){const s=state.settings??{};byId('setting-language').value=s.language??'zh-CN';byId('setting-auto-update').checked=s.autoUpdate!==false;byId('setting-start-minimized').checked=s.startMinimized===true;byId('setting-persist-conversation').checked=s.persistConversation!==false;byId('setting-confirm-high-risk').checked=s.confirmHighRisk!==false;byId('setting-theme').value=s.theme??'light';byId('setting-density').value=s.density??'comfortable';byId('setting-reduce-motion').checked=s.reduceMotion===true;fillRuntime(byId('setting-default-runtime'),s.defaultRuntime??'codex');fillProvider(byId('setting-default-provider'),byId('setting-default-runtime').value,s.defaultProviderId);renderProviderList();renderSettingsRuntimes();renderSettingsProjects();renderUsage();setText('about-version','Desktop '+(state.versions.desktop??'—')+' · Protocol '+(state.versions.protocol??'—'));}
function renderProviderList(){const root=byId('provider-settings-list');clear(root);for(const provider of state.providers){const button=document.createElement('button');button.type='button';button.className='provider-list-item'+(provider.id===state.selectedProviderId?' active':'');const icon=document.createElement('span');icon.className='provider-icon';icon.textContent=provider.name.slice(0,1).toUpperCase();const text=document.createElement('span');const strong=document.createElement('strong');strong.textContent=provider.name;const small=document.createElement('small');small.textContent=provider.kind+' · '+(provider.hasSecret||provider.kind==='chatgpt'?'已配置':'需要 API Key');text.append(strong,small);const status=document.createElement('b');status.textContent=provider.lastTest?.ok?'已连接':'›';button.append(icon,text,status);button.addEventListener('click',()=>selectProviderEditor(provider.id));root.append(button);}if(!state.selectedProviderId&&state.providers[0])selectProviderEditor(state.providers[0].id,false);}
function selectProviderEditor(id,rerender=true){state.selectedProviderId=id;const p=providerById(id);if(!p)return;byId('provider-id').value=p.id;byId('provider-name').value=p.name;if(p.kind==='chatgpt'&&![...byId('provider-kind').options].some((option)=>option.value==='chatgpt'))appendOption(byId('provider-kind'),'chatgpt','ChatGPT 登录');byId('provider-kind').value=p.kind;byId('provider-base-url').value=p.baseUrl;byId('provider-models').value=(p.models??[]).join(', ');byId('provider-api-key').value='';byId('provider-api-key').placeholder=p.hasSecret?'已保存，留空则保持不变':'输入 API Key';byId('delete-provider').disabled=p.kind==='chatgpt';setText('provider-editor-title',p.name);setText('provider-editor-status',p.lastTest?`${p.lastTest.ok?'连接成功':'连接失败'} · ${p.lastTest.latencyMs} ms · ${p.lastTest.category}`:'');if(rerender)renderProviderList();}
function newProvider(){state.selectedProviderId=null;byId('provider-id').value='';byId('provider-name').value='自定义 Provider';byId('provider-kind').value='openai-compatible';byId('provider-base-url').value='https://';byId('provider-models').value='';byId('provider-api-key').value='';byId('delete-provider').disabled=true;setText('provider-editor-title','添加 Provider');setText('provider-editor-status','');}
async function saveProvider(){try{const models=byId('provider-models').value.split(',').map((v)=>v.trim()).filter(Boolean);const result=operationError(await window.tsukiori.workspace.saveProvider({id:byId('provider-id').value||undefined,name:byId('provider-name').value,kind:byId('provider-kind').value,baseUrl:byId('provider-base-url').value,models,apiKey:byId('provider-api-key').value||undefined,enabled:true}));state.selectedProviderId=result.provider.id;setText('provider-editor-status','已安全保存');await reloadSnapshot();}catch(error){setText('provider-editor-status',error.message);} }
async function testProvider(){const id=byId('provider-id').value;if(!id){setText('provider-editor-status','请先保存 Provider');return;}setText('provider-editor-status','正在测试连接…');try{const result=operationError(await window.tsukiori.workspace.testProvider(id));setText('provider-editor-status',`${result.test.ok?'连接成功':'连接失败'} · ${result.test.latencyMs} ms · ${result.test.category}`);await reloadSnapshot();}catch(error){setText('provider-editor-status',error.message);} }
async function deleteProvider(){const id=byId('provider-id').value;if(!id)return;try{operationError(await window.tsukiori.workspace.deleteProvider(id));state.selectedProviderId=null;newProvider();await reloadSnapshot();}catch(error){setText('provider-editor-status',error.message);} }
function renderSettingsRuntimes(){for(const id of ['settings-runtime-list','device-runtime-list']){const root=byId(id);if(!root)continue;clear(root);for(const runtime of state.runtimes){const row=document.createElement('div');row.className='settings-runtime-item';const orb=document.createElement('span');orb.className='runtime-orb '+(runtime.type==='claude'?'claude':'codex');orb.textContent=runtime.type.slice(0,1).toUpperCase();const box=document.createElement('div');box.append(Object.assign(document.createElement('strong'),{textContent:runtime.name}),Object.assign(document.createElement('small'),{textContent:runtime.version+' · '+runtime.source}));const level=document.createElement('b');level.textContent=runtime.available?runtime.supportLevel:'不可用';row.append(orb,box,level);root.append(row);}}}
function renderSettingsProjects(){const root=byId('settings-project-list');clear(root);for(const project of state.projects){const row=document.createElement('div');row.className='setting-row';const box=document.createElement('span');box.append(Object.assign(document.createElement('strong'),{textContent:project.name}),Object.assign(document.createElement('small'),{textContent:project.gitRoot}));const remove=document.createElement('button');remove.type='button';remove.textContent='移除';remove.addEventListener('click',async()=>{if(!window.confirm('从 Tsukiori 列表移除此项目？不会删除本地文件。'))return;try{operationError(await window.tsukiori.workspace.removeProject(project.id));await reloadSnapshot();}catch(error){setText('settings-save-status',error.message);}});row.append(box,remove);root.append(row);}if(!state.projects.length)root.append(emptyText('尚未添加项目'));}
function renderUsage(){setText('usage-turns',state.usage.turnCount??0);setText('usage-sessions',state.usage.sessionCount??0);const root=byId('usage-bars');clear(root);const values=Object.entries(state.usage.byRuntime??{});const max=Math.max(1,...values.map(([,v])=>v));for(const [runtime,count]of values){const row=document.createElement('div');row.className='usage-bar';const label=document.createElement('span');label.textContent=runtime;const bar=document.createElement('i');bar.style.setProperty('--value',Math.round(count/max*100)+'%');const value=document.createElement('b');value.textContent=String(count);row.append(label,bar,value);root.append(row);}if(!values.length)root.append(emptyText('暂无用量数据'));}
async function saveSettings(){try{const result=operationError(await window.tsukiori.workspace.updateSettings({language:byId('setting-language').value,autoUpdate:byId('setting-auto-update').checked,startMinimized:byId('setting-start-minimized').checked,persistConversation:byId('setting-persist-conversation').checked,confirmHighRisk:byId('setting-confirm-high-risk').checked,theme:byId('setting-theme').value,density:byId('setting-density').value,reduceMotion:byId('setting-reduce-motion').checked,defaultRuntime:byId('setting-default-runtime').value,defaultProviderId:byId('setting-default-provider').value}));state.settings=result.settings;applyAppearance();setText('settings-save-status','已保存到本机');}catch(error){setText('settings-save-status',error.message);} }
async function checkUpdates(){setText('update-status','正在检查…');try{const result=operationError(await window.tsukiori.workspace.checkUpdates());setText('update-status',result.update.available?`发现 ${result.update.latest} · 当前 ${result.update.current}`:`已是最新版本 ${result.update.current}`);}catch(error){setText('update-status',error.message);} }
function applyAppearance(){document.body.classList.toggle('density-compact',state.settings.density==='compact');document.body.classList.toggle('reduce-motion',state.settings.reduceMotion===true);}

function bindUi(){
  byId('add-project').addEventListener('click',pickProject);byId('onboarding-add-project').addEventListener('click',pickProject);byId('settings-add-project').addEventListener('click',pickProject);
  byId('workspace-settings').addEventListener('click',()=>openSettings('projects'));byId('project-filter').addEventListener('click',()=>{byId('history-query').hidden=false;byId('history-query').focus();});
  byId('refresh-runtimes').addEventListener('click',async()=>{try{operationError(await window.tsukiori.workspace.refreshRuntimes());await reloadSnapshot();}catch(error){setText('onboarding-status',error.message);}});byId('settings-refresh-runtimes').addEventListener('click',()=>byId('refresh-runtimes').click());
  for(const id of ['rail-new-session','new-session','dashboard-new-session','header-new-session'])byId(id).addEventListener('click',()=>openSessionDialog());
  byId('new-team').addEventListener('click',openTeamDialog);byId('panel-new-team').addEventListener('click',openTeamDialog);byId('team-create-form').addEventListener('submit',createTeam);for(const section of document.querySelectorAll('[data-team-agent]')){section.querySelector('[data-team-runtime]').addEventListener('change',()=>updateTeamAgent(section));section.querySelector('[data-team-provider]').addEventListener('change',()=>fillModels(section.querySelector('[data-team-model]'),section.querySelector('[data-team-provider]').value));}
  byId('session-back').addEventListener('click',()=>{state.activeSessionId=null;renderAll();});
  byId('session-rename').addEventListener('click',renameActiveSession);byId('session-pin').addEventListener('click',pinActiveSession);byId('session-favorite').addEventListener('click',pinActiveSession);byId('session-archive').addEventListener('click',archiveActiveSession);
  byId('runtime-quick-switch').addEventListener('click',()=>openSessionDialog(activeSession()?.runtimeType==='claude'?'codex':'claude'));
  byId('session-create-form').addEventListener('submit',createSession);byId('create-runtime').addEventListener('change',updateCreateProvider);byId('create-provider').addEventListener('change',updateCreateModel);
  byId('prompt-form').addEventListener('submit',sendPrompt);byId('prompt-input').addEventListener('keydown',(event)=>{if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();byId('prompt-form').requestSubmit();}});
  byId('conversation').addEventListener('click',(event)=>{const anchor=event.target.closest?.('a[href]');if(!anchor)return;event.preventDefault();void window.tsukiori.workspace.openUrl(anchor.href);});
  byId('attach-files').addEventListener('click',attachFiles);
  byId('runtime-select').addEventListener('change',()=>{if(byId('runtime-select').value!==activeSession()?.runtimeType)openSessionDialog(byId('runtime-select').value);});byId('provider-select').addEventListener('change',()=>{fillModels(byId('model-select'),byId('provider-select').value);void updateActiveOptions();});byId('model-select').addEventListener('change',updateActiveOptions);byId('permission-select').addEventListener('change',updateActiveOptions);
  byId('interrupt-turn').addEventListener('click',async()=>{try{operationError(await window.tsukiori.workspace.interruptTurn(state.activeSessionId));}catch(error){setText('turn-status',error.message);}});
  byId('clear-terminal').addEventListener('click',()=>setText('terminal-output',''));byId('terminal-collapse').addEventListener('click',()=>document.querySelector('.app-shell').classList.toggle('terminal-collapsed'));byId('terminal-tab-shell').addEventListener('click',()=>{document.querySelector('.app-shell').classList.remove('terminal-collapsed');byId('terminal-input').focus();});byId('terminal-new').addEventListener('click',restartTerminal);byId('terminal-form').addEventListener('submit',async(event)=>{event.preventDefault();const session=activeSession(),input=byId('terminal-input');if(!session||!input.value)return;try{await ensureTerminal(session.id);operationError(await window.tsukiori.workspace.terminalInput(session.id,input.value+'\r'));input.value='';}catch(error){setText('terminal-output',error.message);}});
  byId('toggle-left-panel').addEventListener('click',()=>document.querySelector('.app-shell').classList.toggle('left-collapsed'));byId('toggle-right-panel').addEventListener('click',()=>document.querySelector('.app-shell').classList.toggle('right-collapsed'));byId('toggle-terminal').addEventListener('click',()=>document.querySelector('.app-shell').classList.toggle('terminal-collapsed'));
  for(const button of document.querySelectorAll('[data-panel-tab]'))button.addEventListener('click',()=>activateWorkPanel(button.dataset.panelTab));byId('work-panel-back').addEventListener('click',()=>activateWorkPanel(null));byId('work-panel-close').addEventListener('click',()=>document.querySelector('.app-shell').classList.add('right-collapsed'));byId('header-work-panel').addEventListener('click',()=>document.querySelector('.app-shell').classList.toggle('right-collapsed'));byId('rail-files').addEventListener('click',()=>activateWorkPanel('files'));byId('rail-attention').addEventListener('click',()=>activateWorkPanel('chat'));
  byId('refresh-git').addEventListener('click',refreshGit);byId('stage-files').addEventListener('click',()=>mutateGit('stage'));byId('unstage-files').addEventListener('click',()=>mutateGit('unstage'));byId('commit-files').addEventListener('click',commitFiles);byId('open-worktree').addEventListener('click',async()=>{try{operationError(await window.tsukiori.workspace.openWorktree(state.activeSessionId));}catch(error){setText('worktree-path',error.message);}});byId('refresh-files').addEventListener('click',refreshFiles);byId('file-query').addEventListener('input',refreshFiles);byId('copy-file-content').addEventListener('click',async()=>{try{operationError(await window.tsukiori.workspace.copyText(state.filePreviewContent));setText('file-preview-name','已复制到剪贴板');}catch(error){setText('file-preview-name',error.message);}});byId('open-browser-url').addEventListener('click',()=>{try{const url=new URL(byId('browser-url').value);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('只允许无内嵌认证的 HTTP/HTTPS 地址');byId('browser-preview').src=url.toString();setText('browser-status','已载入沙箱预览');}catch(error){setText('browser-status',error.message);}});byId('open-browser-external').addEventListener('click',async()=>{try{operationError(await window.tsukiori.workspace.openUrl(byId('browser-url').value));setText('browser-status','已在系统浏览器打开');}catch(error){setText('browser-status',error.message);}});
  byId('open-settings').addEventListener('click',()=>openSettings());byId('close-settings').addEventListener('click',()=>byId('settings-dialog').close());for(const button of byId('settings-nav').querySelectorAll('button'))button.addEventListener('click',()=>showSettingsPage(button.dataset.settingsPage));byId('save-settings').addEventListener('click',saveSettings);byId('setting-default-runtime').addEventListener('change',()=>fillProvider(byId('setting-default-provider'),byId('setting-default-runtime').value));
  byId('new-provider').addEventListener('click',newProvider);byId('save-provider').addEventListener('click',saveProvider);byId('test-provider').addEventListener('click',testProvider);byId('delete-provider').addEventListener('click',deleteProvider);byId('provider-kind').addEventListener('change',()=>{const presets={openai:'https://api.openai.com',anthropic:'https://api.anthropic.com',deepseek:'https://api.deepseek.com/anthropic','openai-compatible':'https://','anthropic-compatible':'https://'};byId('provider-base-url').value=presets[byId('provider-kind').value];});
  byId('refresh-native-capabilities').addEventListener('click',loadCodexNative);byId('check-updates').addEventListener('click',checkUpdates);byId('history-search').addEventListener('click',()=>{byId('history-query').hidden=!byId('history-query').hidden;if(!byId('history-query').hidden)byId('history-query').focus();});byId('history-query').addEventListener('input',renderNavigation);
  byId('export-settings').addEventListener('click',async()=>{try{const result=operationError(await window.tsukiori.workspace.exportSettings());setText('export-settings-status',result.canceled?'已取消':'已导出（不含密钥）');}catch(error){setText('export-settings-status',error.message);}});
  byId('report-bug').addEventListener('click',()=>window.tsukiori.workspace.openUrl('https://github.com/Nineu1124/Tsukiori/issues'));
  byId('copy-github-help').addEventListener('click',async()=>{const project=activeProject();if(!project){setText('github-status','尚未选择项目');return;}try{const result=operationError(await window.tsukiori.workspace.githubStatus(project.id));setText('github-status',`Git 用户：${result.status.userName}\n分支：${result.status.branch}\n远程：${result.status.remoteHost}/${result.status.repository}\ngh 登录：${result.status.ghAuthenticated?'已登录':'未登录'}`);}catch(error){setText('github-status',error.message);}});
  document.addEventListener('keydown',(event)=>{if(event.ctrlKey&&event.key===','){event.preventDefault();openSettings();}if(event.ctrlKey&&event.key.toLowerCase()==='j'){event.preventDefault();document.querySelector('.app-shell').classList.toggle('terminal-collapsed');}});
  window.addEventListener('beforeunload',()=>{if(state.terminalSessionId)void window.tsukiori.workspace.stopTerminal(state.terminalSessionId);});
  const poll=async()=>{try{const result=operationError(await window.tsukiori.workspace.pollEvents(state.eventCursor));for(const event of result.events??[])acceptEvent(event);state.eventCursor=Math.max(state.eventCursor,result.cursor??0);}catch{}};setInterval(poll,250);
}

function emptyText(text){const p=document.createElement('p');p.className='empty-state';p.textContent=text;return p;}
function formatBytes(value){const bytes=Number(value)||0;if(bytes<1024)return bytes+' B';if(bytes<1024*1024)return (bytes/1024).toFixed(1)+' KB';return (bytes/1024/1024).toFixed(1)+' MB';}
function relativeTime(value){const minutes=Math.max(0,Math.floor((Date.now()-Number(value))/60000));return minutes<1?'刚刚':minutes<60?minutes+' 分钟':Math.floor(minutes/60)+' 小时';}
function statusLabel(value){return({ready:'Ready',running:'Running',waiting_permission:'Waiting approval',error:'Error',starting:'Starting',stopped:'Stopped'})[value]??value;}

try {
  const [daemon,versions,snapshot]=await Promise.all([window.tsukiori.daemon.status(),window.tsukiori.versions(),window.tsukiori.workspace.snapshot()]);
  setText('status','Daemon '+daemon.daemonVersion);byId('daemon-dot').classList.add('healthy');state.versions=versions;
  if(snapshot?.mode==='interactive'){
    document.body.classList.add('interactive-mode');for(const key of ['projects','sessions','teams','runtimes','providers','recentEvents','permissions','settings','usage'])state[key]=snapshot[key]??state[key];state.eventCursor=snapshot.eventCursor??0;state.activeProjectId=state.projects[0]?.id??null;state.activeSessionId=state.sessions.find((item)=>item.projectId===state.activeProjectId&&!item.archivedAt)?.id??null;bindUi();applyAppearance();renderAll();if(state.settings.autoUpdate!==false)setTimeout(()=>void checkUpdates(),1200);
  }else{
    byId('interactive-workspace').hidden=true;byId('legacy-workspace').hidden=false;setText('version','Protocol '+versions.protocol);renderAlphaWorkflow(snapshot.workflow);renderV1GitWorkflow(snapshot.v1Git);renderDiagnosticBundle(snapshot.diagnostics);for(const tool of snapshot.tools??[])renderTool(tool);for(const runtime of snapshot.runtimes??[])renderRuntime(runtime);clear(byId('attention-list'));for(const permission of snapshot.permissions??[])renderPermission(permission,byId('attention-list'));for(const item of snapshot.attention??[]){const card=document.createElement('article');card.className='attention-item '+item.kind;card.textContent=item.title;byId('attention-list').append(card);}setText('attention-count',(snapshot.attention??[]).length);
  }
}catch(error){setText('status','Daemon 不可用');byId('daemon-dot').classList.add('failed');}
