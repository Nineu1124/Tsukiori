const status = document.querySelector('#status');
const daemonDot = document.querySelector('#daemon-dot');
const version = document.querySelector('#version');
const attentionList = document.querySelector('#attention-list');
const attentionCount = document.querySelector('#attention-count');
const permissionList = document.querySelector('#permission-list');
const toolList = document.querySelector('#tool-list');
const runtimeList = document.querySelector('#runtime-list');

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
function renderAttention(item) {
  const card = document.createElement('article');
  card.className = 'attention-item ' + item.kind;
  const label = document.createElement('span');
  label.className = 'attention-kind';
  label.textContent = item.kind.replaceAll('_', ' ');
  const title = document.createElement('strong');
  title.textContent = item.title;
  card.append(label, title);
  attentionList.append(card);
}

try {
  const [daemon, versions, snapshot] = await Promise.all([
    window.tsukiori.daemon.status(),
    window.tsukiori.versions(),
    window.tsukiori.workspace.snapshot(),
  ]);
  status.textContent = 'Daemon ' + daemon.daemonVersion + ' · ' + daemon.state;
  daemonDot.classList.add('healthy');
  version.textContent = 'Protocol ' + versions.protocol;
  for (const tool of snapshot.tools) renderTool(tool);
  for (const runtime of snapshot.runtimes) renderRuntime(runtime);
  for (const permission of snapshot.permissions) renderPermission(permission);
  const openAttention = snapshot.attention.filter((item) => item.status === 'open');
  if (openAttention.length > 0) attentionList.textContent = '';
  for (const item of openAttention) renderAttention(item);
  attentionCount.textContent = String(openAttention.length);
} catch {
  status.textContent = 'Daemon 不可用';
  daemonDot.classList.add('failed');
}