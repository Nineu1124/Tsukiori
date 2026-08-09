// Captures the complete Tsukiori V1.1 visual design surface from a sanitized
// throwaway Electron profile. No real project path, prompt, credential, or
// Runtime event is read while these design artifacts are produced.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktopRoot = join(root, 'apps', 'desktop');
const outDir = join(root, 'docs', 'design', 'v1.1', 'screens');
const settingsOutDir = join(outDir, 'settings');
const electron = createRequire(join(desktopRoot, 'package.json'))('electron');
const userData = mkdtempSync(join(tmpdir(), 'tsukiori-design-v11-'));
const now = Date.now();

mkdirSync(settingsOutDir, { recursive: true });
writeFileSync(
  join(userData, 'workspace-state-v3.json'),
  JSON.stringify({
    schemaVersion: 3,
    projects: [
      {
        id: 'design-project',
        name: 'sample-app',
        rootPath: 'D:\\demo\\sample-app',
        gitRoot: 'D:\\demo\\sample-app',
        branch: 'main',
      },
    ],
    sessions: [
      {
        id: 'design-session-codex',
        projectId: 'design-project',
        name: 'Feature Session',
        runtimeType: 'codex',
        providerId: 'chatgpt-login',
        model: 'auto',
        environment: 'windows-native',
        permissionMode: 'manual',
        worktreePath: 'D:\\demo\\sample-app\\.worktrees\\feature',
        branch: 'feature',
        turnCount: 4,
        status: 'ready',
        createdAt: now - 1_200_000,
        updatedAt: now - 75_000,
      },
      {
        id: 'design-session-claude',
        projectId: 'design-project',
        name: 'Review Session',
        runtimeType: 'claude',
        providerId: 'claude-native',
        model: 'auto',
        environment: 'windows-native',
        permissionMode: 'plan',
        worktreePath: 'D:\\demo\\sample-app\\.worktrees\\review',
        branch: 'review',
        turnCount: 2,
        status: 'ready',
        createdAt: now - 900_000,
        updatedAt: now - 40_000,
      },
    ],
    settings: {
      language: 'zh-CN',
      theme: 'light',
      density: 'comfortable',
      reduceMotion: false,
      autoUpdate: true,
      startMinimized: false,
      defaultProjectDirectory: 'D:\\demo',
      defaultRuntime: 'codex',
      defaultProviderId: 'chatgpt-login',
      defaultModel: 'auto',
      defaultPermissionMode: 'manual',
      persistConversation: true,
      confirmHighRisk: true,
      workPanelWidth: 360,
      terminalShell: 'powershell',
    },
    providers: [],
    teams: [],
  }),
  'utf8',
);

const port = await availablePort();
const child = spawn(
  electron,
  [desktopRoot, `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`],
  {
    cwd: root,
    env: {
      ...process.env,
      TSUKIORI_DAEMON_EXIT_POLICY: 'stop',
      TSUKIORI_NODE_EXECUTABLE: process.execPath,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  },
);
child.stderr.on('data', () => {});

try {
  const cdp = await connect((await waitForTarget(port)).webSocketDebuggerUrl);
  await cdp.send('Runtime.enable', {});
  await cdp.send('Page.enable', {});
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1600,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await waitFor(cdp, `!!document.querySelector('#work-panel-resizer')`);

  await setWorkspace(cdp, 'onboarding');
  await shoot(cdp, join(outDir, '01-onboarding.png'));

  await setWorkspace(cdp, 'project');
  await shoot(cdp, join(outDir, '02-project-dashboard.png'));

  await setWorkspace(cdp, 'session');
  await evaluate(cdp, `(() => {
    const target = document.querySelector('#conversation');
    target.innerHTML = '<article class="welcome-message"><span>✣</span><div><strong>会话已准备</strong><p>选择 Runtime、Provider 与 Model，然后输入任务。</p></div></article>';
    return true;
  })()`);
  await shoot(cdp, join(outDir, '03-session-ready.png'));

  await addConversationFixture(cdp);
  await shoot(cdp, join(outDir, '04-session-conversation.png'));

  await activatePanel(cdp, null);
  await shoot(cdp, join(outDir, '05-work-panel-home.png'));

  await activatePanel(cdp, 'chat');
  await evaluate(cdp, `(() => {
    document.querySelector('#team-list').innerHTML = '<article class="team-card"><strong>Refactor Team</strong><small>Lead · Reviewer · Test Agent</small></article>';
    document.querySelector('#attention-list').innerHTML = '<article class="permission-card"><h3>允许一次：运行测试</h3><p>pnpm test:ui · 当前 Session Worktree</p><div class="permission-actions"><button>拒绝</button><button>允许一次</button></div></article><article class="attention-item completed">Review Agent 已完成检查</article>';
    document.querySelector('#attention-count').textContent = '2';
    return true;
  })()`);
  await shoot(cdp, join(outDir, '06-work-panel-attention.png'));

  await activatePanel(cdp, 'files');
  await evaluate(cdp, `(() => {
    document.querySelector('#worktree-path').textContent = ['D:','demo','sample-app','.worktrees','feature'].join(String.fromCharCode(92));
    document.querySelector('#panel-file-list').innerHTML = '<div class="panel-file"><span>▧</span><span>apps/desktop/renderer/styles.css</span><b>M</b></div><div class="panel-file"><span>▧</span><span>apps/desktop/renderer/renderer.js</span><b>M</b></div><div class="panel-file"><span>▧</span><span>tests/ui/basic-ui.test.mjs</span><b>A</b></div>';
    document.querySelector('#file-preview-name').textContent = 'styles.css';
    document.querySelector('#file-preview').textContent = ':root {\\n  --tsukiori-primary: #249ce8;\\n  --ba-ink: #14243d;\\n}';
    return true;
  })()`);
  await shoot(cdp, join(outDir, '07-work-panel-files.png'));

  await activatePanel(cdp, 'review');
  await evaluate(cdp, `(() => {
    document.querySelector('#git-files').innerHTML = '<label class="git-file"><input type="checkbox" checked><span>apps/desktop/renderer/styles.css</span><b class="git-file-status">M</b></label><label class="git-file"><input type="checkbox" checked><span>docs/design/v1.1/README.md</span><b class="git-file-status">A</b></label>';
    document.querySelector('#git-diff').textContent = 'diff --git a/styles.css b/styles.css\\n+ .empty-workspace {\\n+   background-image: url(onboarding-hero.png);\\n+ }';
    document.querySelector('#checkpoint-list').innerHTML = '<article class="checkpoint-row"><div><strong>Before UI pass</strong><small>2 files · clean index · recoverable</small></div><button>回退</button></article><article class="checkpoint-row recovery"><div><strong>Recovery point</strong><small>自动创建 · 2 分钟前</small></div><button>查看</button></article>';
    return true;
  })()`);
  await shoot(cdp, join(outDir, '08-work-panel-changes.png'));

  await activatePanel(cdp, 'browser');
  await evaluate(cdp, `(() => {
    document.querySelector('#browser-url').value = 'http://localhost:3000';
    document.querySelector('#browser-status').textContent = '本地预览 · 已隔离';
    document.querySelector('#browser-preview').srcdoc = '<!doctype html><body style="margin:0;font-family:Segoe UI;background:#edf7fd;color:#14243d;display:grid;place-items:center;height:100vh"><main style="padding:42px;border:1px solid #62b9ee;background:white"><b>LOCAL PREVIEW</b><p>sample-app · localhost:3000</p></main></body>';
    return true;
  })()`);
  await shoot(cdp, join(outDir, '09-work-panel-browser.png'));

  await activatePanel(cdp, 'computer');
  await evaluate(cdp, `(() => {
    document.querySelector('#computer-support-level').textContent = 'supported';
    document.querySelector('#computer-target').textContent = '目标：sample-app.exe · 当前用户会话 · 已验证';
    document.querySelector('#computer-status').textContent = '锁定将在 04:57 后过期；每个动作仍需单独授权。';
    document.querySelector('#computer-controls').hidden = false;
    document.querySelector('#computer-screenshot-frame').hidden = false;
    document.querySelector('#computer-screenshot-image').src = './assets/generated/v1.1/capability-hub.png';
    return true;
  })()`);
  await shoot(cdp, join(outDir, '10-work-panel-computer-use.png'));

  await captureDialog(cdp, 'session-dialog', join(outDir, '11-dialog-new-session.png'));
  await captureDialog(cdp, 'team-dialog', join(outDir, '12-dialog-agent-team.png'));

  await evaluate(cdp, `(() => {
    for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
    document.querySelector('#settings-dialog').showModal();
    return true;
  })()`);

  const settingsPages = [
    'general', 'appearance', 'account', 'agent', 'terminal', 'mcp', 'agents',
    'skills', 'memory', 'scheduled', 'usage', 'trace', 'diagnostics', 'projects',
    'devices', 'github', 'shortcuts', 'billing', 'about',
  ];
  for (let index = 0; index < settingsPages.length; index += 1) {
    const page = settingsPages[index];
    await evaluate(cdp, `(() => {
      const button = document.querySelector('[data-settings-page="${page}"]');
      if (!button) throw new Error('settings_page_missing:${page}');
      button.click();
      document.querySelector('.settings-content').scrollTop = 0;
      return true;
    })()`);
    await sleep(260);
    await decorateSettingsPage(cdp, page);
    const number = String(index + 1).padStart(2, '0');
    await shoot(cdp, join(settingsOutDir, `${number}-${page}.png`));
  }

  await evaluate(cdp, `(() => { document.querySelector('#settings-dialog').close(); return true; })()`);
  await cdp.close();
  console.log(`captured ${12 + settingsPages.length} complete design screens`);
} finally {
  child.kill();
  try { rmSync(userData, { recursive: true, force: true }); } catch {}
}

async function setWorkspace(cdp, mode) {
  await evaluate(cdp, `(() => {
    document.body.classList.add('interactive-mode');
    const shell = document.querySelector('.app-shell');
    shell.classList.remove('left-collapsed','right-collapsed','terminal-collapsed');
    document.querySelector('#onboarding').hidden = ${mode !== 'onboarding'};
    document.querySelector('#project-home').hidden = ${mode !== 'project'};
    document.querySelector('#active-session').hidden = ${mode !== 'session'};
    document.querySelector('#project-name').textContent = 'sample-app';
    document.querySelector('#project-path').textContent = ['D:','demo','sample-app'].join(String.fromCharCode(92));
    document.querySelector('#metric-worktrees').textContent = '3';
    document.querySelector('#metric-changes').textContent = '5';
    document.querySelector('#metric-running').textContent = '2';
    document.querySelector('#metric-attention').textContent = '1';
    document.querySelector('#interactive-title').textContent = 'Feature Session';
    document.querySelector('#interactive-eyebrow').textContent = '会话 / 独立 Worktree';
    document.querySelector('#session-context-path').textContent = ['D:','demo','sample-app','.worktrees','feature'].join(String.fromCharCode(92));
    document.querySelector('#runtime-badge').textContent = 'Codex';
    document.querySelector('#provider-badge').textContent = 'ChatGPT 登录';
    return true;
  })()`);
  await sleep(260);
}

async function addConversationFixture(cdp) {
  await evaluate(cdp, `(() => {
    const target = document.querySelector('#conversation');
    target.innerHTML = '<article class="chat-message user"><div class="message-meta">你</div><div class="message-body">检查项目结构，实现 Provider 与多 Agent 协作。</div></article><details class="thinking-block" open><summary><span>THINKING</span><b>完成</b></summary><pre class="thinking-body">先读取 Adapter Contract，再核对权限和 Worktree 边界。</pre></details><article class="chat-message assistant"><div class="message-meta">CODEX</div><div class="message-body">已完成结构检查，正在并行验证 Runtime 与 UI。</div></article><article class="chat-message tool" data-tool="read_file" data-tool-kind="read" data-phase="completed"><div class="message-meta"><span>READ · READ_FILE</span><b class="tool-phase">完成</b></div><div class="message-body">apps/desktop/renderer/styles.css</div></article><article class="chat-message tool" data-tool="apply_patch" data-tool-kind="modify" data-phase="completed"><div class="message-meta"><span>MODIFY · APPLY_PATCH</span><b class="tool-phase">完成</b></div><div class="message-body">接入 V1.1 生成视觉资产</div></article><article class="chat-message tool" data-tool="shell" data-tool-kind="execute" data-phase="started"><div class="message-meta"><span>EXECUTE · TEST</span><b class="tool-phase">运行中</b></div><div class="message-body">pnpm test:ui</div></article>';
    target.scrollTop = 0;
    return true;
  })()`);
  await sleep(260);
}

async function activatePanel(cdp, name) {
  await evaluate(cdp, `(() => {
    document.querySelector('.app-shell').classList.remove('right-collapsed');
    const target = ${name === null ? "document.querySelector('#work-panel-back')" : `document.querySelector('[data-panel-tab="${name}"]')`};
    if (target) target.click();
    document.querySelector('#attention-center').scrollTop = 0;
    return true;
  })()`);
  await sleep(260);
}

async function captureDialog(cdp, id, file) {
  await evaluate(cdp, `(() => {
    for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
    document.querySelector('#${id}').showModal();
    return true;
  })()`);
  await shoot(cdp, file);
  await evaluate(cdp, `(() => { document.querySelector('#${id}').close(); return true; })()`);
}

async function decorateSettingsPage(cdp, page) {
  const fixture = {
    agent: `
      document.querySelector('#provider-settings-list').innerHTML = '<article class="mcp-server-row"><div><strong>ChatGPT 登录</strong><small>Codex · OAuth · 就绪</small></div><b>默认</b></article><article class="mcp-server-row"><div><strong>DeepSeek</strong><small>API · Credential Manager · 2 Models</small></div><b>可用</b></article>';
      document.querySelector('#settings-runtime-list').innerHTML = '<article class="capability-list-item"><div><strong>Codex</strong><small>0.144.6 · supported · ChatGPT</small></div><b>就绪</b></article><article class="capability-list-item"><div><strong>Claude Code</strong><small>2.1.226 · native stream-json</small></div><b>就绪</b></article><article class="capability-list-item"><div><strong>OpenCode</strong><small>协议已验证 · Provider 待配置</small></div><b>unknown</b></article>';
      document.querySelector('#native-capability-list').innerHTML = '<article class="capability-list-item"><div><strong>Skills / MCP 健康</strong><small>5 Skills · 2 MCP · Scope 已核对</small></div><b>healthy</b></article>';`,
    mcp: `document.querySelector('#mcp-settings-list').innerHTML = '<article class="mcp-server-row"><div><strong>filesystem-local</strong><small>project · stdio · Runtime present</small></div><div><b>healthy</b><button>编辑</button></div></article><article class="mcp-server-row"><div><strong>docs-search</strong><small>user · HTTP · 认证值未写入状态</small></div><div><b>healthy</b><button>编辑</button></div></article>';`,
    agents: `document.querySelector('#agent-settings-summary').innerHTML = '<article><span>Agent Team</span><strong>1</strong></article><article><span>SubAgent</span><strong>3</strong></article><article><span>后台任务</span><strong>1</strong></article>'; document.querySelector('#agent-activity-list').innerHTML = '<article class="capability-list-item"><div><strong>UI Review Agent</strong><small>Runtime 原生 · parent design-session-codex</small></div><b>running</b></article><article class="capability-list-item"><div><strong>Test Agent</strong><small>Tsukiori Team · 00:42</small></div><b>completed</b></article>';`,
    skills: `document.querySelector('#skill-settings-list').innerHTML = '<article class="skill-server-row"><div><strong>design-system</strong><small>project · 6 files · reviewed · UI 设计规范</small></div><div><b>healthy</b><button>详情</button></div></article><article class="skill-server-row"><div><strong>release-check</strong><small>user · 4 files · reviewed · 发布验证</small></div><div><b>healthy</b><button>详情</button></div></article>';`,
    memory: `document.querySelector('#memory-settings-list').innerHTML = '<article class="memory-file-row"><div><strong>MEMORY.md</strong><small>1.2 KB · 刚刚更新</small></div><button>打开</button></article><article class="memory-file-row"><div><strong>.codex/memory/ui.md</strong><small>840 B · 本地</small></div><button>打开</button></article>'; document.querySelector('#memory-path').value = 'MEMORY.md'; document.querySelector('#memory-content').value = '# Tsukiori UI\\n\\n- 蓝白学院科技感\\n- 深海军蓝导航\\n- 青色技术线与黄色行动色';`,
    scheduled: `document.querySelector('#scheduled-task-list').innerHTML = '<article class="mcp-server-row"><div><strong>Nightly UI Regression</strong><small>每 1440 分钟 · 已启用 · 下次 02:00</small></div><div><button>停用</button><button>立即运行</button></div></article><article class="mcp-server-row"><div><strong>Weekly Dependency Audit</strong><small>每 10080 分钟 · 已停用</small></div><div><button>启用</button></div></article>';`,
    usage: `document.querySelector('#usage-turns').textContent = '128'; document.querySelector('#usage-sessions').textContent = '14'; document.querySelector('#usage-bars').innerHTML = '<div class="usage-bar"><span>Codex</span><i style="--value:100%"></i><b>84</b></div><div class="usage-bar"><span>Claude</span><i style="--value:52%"></i><b>44</b></div>';`,
    trace: `document.querySelector('#trace-summary').innerHTML = '<article><span>事件</span><strong>42</strong></article><article><span>运行中</span><strong>1</strong></article><article><span>失败</span><strong>0</strong></article>'; document.querySelector('#trace-settings-list').innerHTML = '<article class="trace-row"><b>turn.started</b><span>Codex · 00:42</span></article><article class="trace-row"><b>tool.completed</b><span>apply_patch · 00:39</span></article><article class="trace-row"><b>subagent.completed</b><span>Test Agent · 00:18</span></article>';`,
    diagnostics: `document.querySelector('#diagnostic-settings-summary').innerHTML = '<article><span>Runtime</span><strong>3/4</strong></article><article><span>Provider</span><strong>2/2</strong></article><article><span>Session</span><strong>healthy</strong></article>'; document.querySelector('#diagnostic-settings-detail').textContent = 'Doctor ready\\nCredential boundary: pass\\nNamed Pipe cleanup: pass\\nSensitive payload export: excluded';`,
    devices: `document.querySelector('#device-runtime-list').innerHTML = '<article class="capability-list-item"><div><strong>Windows Native</strong><small>当前用户 · x64 · Credential Manager</small></div><b>connected</b></article><article class="capability-list-item"><div><strong>ConPTY</strong><small>PowerShell 7 · node-pty</small></div><b>supported</b></article>';`,
    github: `document.querySelector('#github-status').textContent = 'Git 用户：Nineu1124\\n分支：main\\n远程：github.com/Nineu1124/Tsukiori\\ngh 登录：已登录';`,
  }[page];
  if (!fixture) return;
  await evaluate(cdp, `(() => { ${fixture} return true; })()`);
  await sleep(140);
}

async function shoot(cdp, file) {
  await sleep(260);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(file, Buffer.from(shot.data, 'base64'));
  console.log('captured', file);
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'evaluate_failed');
  }
  return result.result.value;
}

async function waitFor(cdp, expression) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { if (await evaluate(cdp, expression)) return; } catch {}
    if (Date.now() > deadline) throw new Error('renderer_not_ready');
    await sleep(400);
  }
}

async function waitForTarget(port) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
      if (page) return page;
    } catch {}
    if (Date.now() > deadline) throw new Error('target_not_found');
    await sleep(400);
  }
}

async function connect(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let id = 0;
  await new Promise((ok, fail) => {
    socket.addEventListener('open', ok, { once: true });
    socket.addEventListener('error', () => fail(new Error('ws_failed')), { once: true });
  });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.fail(new Error(message.error.message));
    else entry.ok(message.result);
  });
  return {
    send(method, params) {
      id += 1;
      const current = id;
      return new Promise((ok, fail) => {
        pending.set(current, { ok, fail });
        socket.send(JSON.stringify({ id: current, method, params }));
      });
    },
    close() { socket.close(); },
  };
}

function availablePort() {
  return new Promise((ok, fail) => {
    const server = createServer();
    server.on('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const { port: freePort } = server.address();
      server.close(() => ok(freePort));
    });
  });
}

function sleep(ms) {
  return new Promise((ok) => setTimeout(ok, ms));
}
