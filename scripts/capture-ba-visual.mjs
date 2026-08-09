// Captures sanitized SCHALE OS restyle evidence at the 1600x1000 design baseline.
// State is seeded into a throwaway --user-data-dir so no real project path,
// session name or credential can reach the screenshots.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktopRoot = join(root, 'apps', 'desktop');
const outDir = join(root, 'docs', 'visual');
const electron = createRequire(join(desktopRoot, 'package.json'))('electron');
const userData = mkdtempSync(join(tmpdir(), 'tsukiori-ba-visual-'));

const now = Date.now();
writeFileSync(
  join(userData, 'workspace-state-v3.json'),
  JSON.stringify({
    schemaVersion: 3,
    projects: [
      { id: 'demo-project', name: 'sample-app', rootPath: 'D:\\demo\\sample-app', gitRoot: 'D:\\demo\\sample-app', branch: 'main' },
    ],
    sessions: [
      {
        id: 'demo-session-1', projectId: 'demo-project', name: 'Feature Session',
        runtimeType: 'codex', providerId: 'chatgpt-login', model: 'auto',
        environment: 'windows-native', permissionMode: 'manual',
        worktreePath: 'D:\\demo\\sample-app\\.worktrees\\feature', branch: 'feature',
        turnCount: 2, status: 'ready', createdAt: now - 900_000, updatedAt: now - 60_000,
      },
      {
        id: 'demo-session-2', projectId: 'demo-project', name: 'Review Session',
        runtimeType: 'claude', providerId: 'claude-native', model: 'auto',
        environment: 'windows-native', permissionMode: 'plan',
        worktreePath: 'D:\\demo\\sample-app\\.worktrees\\review', branch: 'review',
        turnCount: 1, status: 'ready', createdAt: now - 600_000, updatedAt: now - 30_000,
      },
    ],
    settings: {
      language: 'zh-CN', theme: 'light', density: 'comfortable', reduceMotion: false,
      autoUpdate: true, startMinimized: false, defaultProjectDirectory: 'D:\\demo',
      defaultRuntime: 'codex', defaultProviderId: 'chatgpt-login', defaultModel: 'auto',
      defaultPermissionMode: 'manual', persistConversation: true, confirmHighRisk: true,
      workPanelWidth: 360, terminalShell: 'powershell',
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
    env: { ...process.env, TSUKIORI_DAEMON_EXIT_POLICY: 'stop', TSUKIORI_NODE_EXECUTABLE: process.execPath },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  },
);
child.stderr.on('data', () => {});

try {
  mkdirSync(outDir, { recursive: true });
  const cdp = await connect((await waitForTarget(port)).webSocketDebuggerUrl);
  await cdp.send('Runtime.enable', {});
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false,
  });
  await waitFor(cdp, `!!document.querySelector('#work-panel-resizer')`);

  // Show the session surface with the demo session selected.
  await evaluate(cdp, `(() => {
    document.body.classList.add('interactive-mode');
    document.querySelector('#onboarding').hidden = true;
    document.querySelector('#project-home').hidden = true;
    document.querySelector('#active-session').hidden = false;
    document.querySelector('#interactive-title').textContent = 'Feature Session';
    document.querySelector('#interactive-eyebrow').textContent = '会话 / 独立 Worktree';
    document.querySelector('#session-context-path').textContent = 'D:\\\\demo\\\\sample-app\\\\.worktrees\\\\feature';
    document.querySelector('#runtime-badge').textContent = 'Codex';
    document.querySelector('#provider-badge').textContent = 'ChatGPT 登录';
    return true;
  })()`);
  await shoot(cdp, join(outDir, 't5.10-ba-main-workspace.png'));

  // Stream surfaces: user bubble, assistant rail, thinking block, tool cards
  // in all three READ/MODIFY/EXECUTE kinds and completed/failed phases.
  await evaluate(cdp, `(() => {
    const target = document.querySelector('#conversation');
    if (!target) return 'no_conversation';
    target.querySelectorAll('.welcome-message').forEach((n) => n.remove());
    const msg = (kind, label, text) => {
      const node = document.createElement('article');
      node.className = 'chat-message ' + kind;
      const meta = document.createElement('div');
      meta.className = 'message-meta';
      meta.textContent = label;
      const body = document.createElement('div');
      body.className = 'message-body';
      body.textContent = text;
      node.append(meta, body);
      return node;
    };
    const tool = (toolName, kind, phase, phaseLabel, summary) => {
      const node = document.createElement('article');
      node.className = 'chat-message tool';
      node.dataset.tool = toolName;
      node.dataset.toolKind = kind;
      node.dataset.phase = phase;
      const meta = document.createElement('div');
      meta.className = 'message-meta';
      const label = document.createElement('span');
      label.textContent = kind.toUpperCase() + ' · ' + toolName;
      const status = document.createElement('b');
      status.className = 'tool-phase';
      status.textContent = phaseLabel;
      meta.append(label, status);
      const body = document.createElement('div');
      body.className = 'message-body';
      body.textContent = summary;
      node.append(meta, body);
      return node;
    };
    const think = () => {
      const node = document.createElement('details');
      node.className = 'thinking-block';
      node.open = true;
      const summary = document.createElement('summary');
      const label = document.createElement('span');
      label.textContent = 'Thinking';
      const status = document.createElement('b');
      status.textContent = '完成';
      summary.append(label, status);
      const body = document.createElement('pre');
      body.className = 'thinking-body';
      body.textContent = '先确认样式层的级联顺序，再决定几何是用 clip-path 还是 transform。';
      node.append(summary, body);
      return node;
    };
    target.append(msg('user', '你', '把工作台改成 SCHALE OS 的视觉语言。'));
    target.append(think());
    target.append(msg('assistant', 'Codex', '已定位到渲染层样式表，准备追加几何与纹理层。'));
    target.append(tool('read_file', 'read', 'completed', '完成', 'apps/desktop/renderer/styles.css'));
    target.append(tool('apply_patch', 'modify', 'completed', '完成', 'apps/desktop/renderer/styles.css +289'));
    target.append(tool('shell', 'execute', 'started', '运行中', 'pnpm test:ui'));
    target.append(tool('shell', 'execute', 'failed', '失败', 'node: command not found'));
    return 'ok';
  })()`);
  await shoot(cdp, join(outDir, 't5.10-ba-conversation.png'));

  // Project dashboard: metric tiles, hero, brackets.
  await evaluate(cdp, `(() => {
    document.querySelector('#active-session').hidden = true;
    document.querySelector('#project-home').hidden = false;
    document.querySelector('#project-name').textContent = 'sample-app';
    document.querySelector('#project-path').textContent = 'D:\\\\demo\\\\sample-app';
    document.querySelector('#metric-worktrees').textContent = '2';
    document.querySelector('#metric-changes').textContent = '7';
    document.querySelector('#metric-running').textContent = '1';
    document.querySelector('#metric-attention').textContent = '0';
    return true;
  })()`);
  await shoot(cdp, join(outDir, 't5.10-ba-project-dashboard.png'));

  // Settings dialog.
  await evaluate(cdp, `(() => { document.querySelector('#settings-dialog').showModal(); return true; })()`);
  await sleep(420);
  await shoot(cdp, join(outDir, 't5.10-ba-settings-general.png'));

  // Verified geometry readout: proves clip-path/hatch actually applied.
  const geometry = await evaluate(cdp, `(() => {
    const read = (sel, prop) => {
      const node = document.querySelector(sel);
      return node ? getComputedStyle(node)[prop] : 'MISSING';
    };
    const root = getComputedStyle(document.documentElement);
    return JSON.stringify({
      newChatClip: read('.new-chat','clipPath'),
      primaryClip: read('#save-settings','clipPath'),
      cardClip: read('.settings-card','clipPath'),
      cardRadius: read('.settings-card','borderRadius'),
      railHeaderHatch: read('.rail-section-header','backgroundImage').slice(0,46),
      kickerTransform: read('.kicker','textTransform'),
      pageIndexStyle: read('.page-index','fontStyle'),
      railWidth: root.getPropertyValue('--rail-width').trim(),
      terminalHeight: root.getPropertyValue('--terminal-height').trim(),
      baCut: root.getPropertyValue('--ba-cut').trim(),
    }, null, 1);
  })()`);
  console.log(geometry);

  // Reduced-motion check: geometry must survive transform:none.
  await evaluate(cdp, `(() => { document.body.classList.add('reduce-motion'); return true; })()`);
  await sleep(120);
  const reduced = await evaluate(cdp, `(() => {
    const node = document.querySelector('.new-chat');
    const style = getComputedStyle(node);
    return JSON.stringify({ clipPath: style.clipPath, transform: style.transform });
  })()`);
  console.log('REDUCE_MOTION', reduced);

  await cdp.close();
  console.log('OK');
} finally {
  child.kill();
  try { rmSync(userData, { recursive: true, force: true }); } catch {}
}

async function shoot(cdp, file) {
  await sleep(260);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(file, Buffer.from(shot.data, 'base64'));
  console.log('captured', file);
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? 'evaluate_failed');
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
      const { port } = server.address();
      server.close(() => ok(port));
    });
  });
}

function sleep(ms) { return new Promise((ok) => setTimeout(ok, ms)); }
