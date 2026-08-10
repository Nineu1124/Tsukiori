# 本地多 Agent 工作台：完整架构与实施方案

> 文档版本：v1.2
> 编制日期：2026-08-02
> 文档状态：架构候选 / 关键技术 Spike 验证后进入原型开发
> 暂定代号：Local Agent Workspace（正式产品名后续确定）

---

## 目录

1. [执行摘要](#1-执行摘要)
2. [产品定义](#2-产品定义)
3. [目标与非目标](#3-目标与非目标)
4. [关键概念与边界](#4-关键概念与边界)
5. [核心设计原则](#5-核心设计原则)
6. [总体系统架构](#6-总体系统架构)
7. [进程拓扑与故障边界](#7-进程拓扑与故障边界)
8. [Runtime 接入策略](#8-runtime-接入策略)
9. [模型、Provider 与 Runtime 的关系](#9-模型provider-与-runtime-的关系)
10. [领域模型](#10-领域模型)
11. [Local Daemon 模块设计](#11-local-daemon-模块设计)
12. [Runtime Adapter 规范](#12-runtime-adapter-规范)
13. [能力发现与降级机制](#13-能力发现与降级机制)
14. [统一事件模型](#14-统一事件模型)
15. [Session 状态模型](#15-session-状态模型)
16. [项目与 Worktree 架构](#16-项目与-worktree-架构)
17. [Git、Diff、Commit 与合并](#17-gitdiffcommit-与合并)
18. [权限审批系统](#18-权限审批系统)
19. [Hooks 系统](#19-hooks-系统)
20. [MCP、Skills、Plugins 与子 Agent](#20-mcpskillsplugins-与子-agent)
21. [终端与进程管理](#21-终端与进程管理)
22. [配置、认证与凭据管理](#22-配置认证与凭据管理)
23. [数据持久化与数据库设计](#23-数据持久化与数据库设计)
24. [桌面端与 Daemon 通信协议](#24-桌面端与-daemon-通信协议)
25. [崩溃恢复与幂等设计](#25-崩溃恢复与幂等设计)
26. [安全架构与威胁模型](#26-安全架构与威胁模型)
27. [资源治理](#27-资源治理)
28. [GUI 信息架构与页面设计](#28-gui-信息架构与页面设计)
29. [核心用户流程](#29-核心用户流程)
30. [推荐技术栈](#30-推荐技术栈)
31. [Monorepo 目录结构](#31-monorepo-目录结构)
32. [实施 TODO 与里程碑](#32-实施-todo-与里程碑)
33. [测试体系](#33-测试体系)
34. [日志、监控与诊断](#34-日志监控与诊断)
35. [安装、升级与跨平台发布](#35-安装升级与跨平台发布)
36. [兼容性与版本策略](#36-兼容性与版本策略)
37. [可发布 V1 验收标准](#37-可发布-v1-验收标准)
38. [主要风险与应对](#38-主要风险与应对)
39. [后续演进路线](#39-后续演进路线)
40. [最终架构决策清单](#40-最终架构决策清单)
41. [官方资料与参考](#41-官方资料与参考)

---

# 1. 执行摘要

本项目是一款**本地控制、本地存储的多模型、多 Coding Agent Runtime 工作台**。用户可以在同一个桌面 GUI 中，同时运行和管理：

- Claude Code / Claude Agent；
- Codex；
- OpenCode；
- 其他 ACP 兼容 Agent；
- 通过 OpenCode 等通用 Runtime 使用 DeepSeek、Claude、GPT、Gemini、Kimi、Qwen、MiMo 等模型。

项目核心不是重新开发 Claude Code、Codex 或 OpenCode，而是开发一个稳定、可扩展的**本地 Agent 宿主与控制平面**：

```text
桌面 GUI
    ↓
本地 Daemon
    ↓
项目 / Session / Worktree / Git / Diff / 权限 / Hooks
    ↓
Claude、Codex、OpenCode、ACP 等 Runtime Adapter
    ↓
原生 Agent Runtime
    ↓
Claude / GPT / DeepSeek 等模型
```

本方案吸收三类产品的优点：

- 采用 Lody 类产品的“外部 Runtime 宿主、能力发现、Session 与 Worktree 管理”思路；
- 采用 Hermes IDE 的“多项目、每 Session 独立状态、Worktree 优先和高频任务切换”思路；
- 采用 cc-haha 类产品的“Renderer、Electron Main、本地 Sidecar/Daemon、Agent 子进程明确隔离”思路；
- 删除云端账户、移动端、团队协作、远程同步等非本地核心能力；
- 不复制 cc-haha 自研完整 Agent Loop 的高成本路线。

这里的“纯本地”特指：项目文件、Worktree、会话、事件、配置、审计记录和凭据引用均保存在用户本机；本项目不建设用于转发代码、Prompt 或模型响应的云端中继。模型推理由用户选择的 Runtime/Provider 直接连接 Anthropic、OpenAI、DeepSeek 等服务，或连接用户自己的本地模型服务。是否把代码发送给模型 Provider，由所选 Runtime、Provider 和用户授权决定。

最终产品的核心价值是：

1. 一个界面统一运行多个不同 Agent；
2. 多个任务可并行且相互隔离；
3. 原生 Agent 能力尽量完整保留；
4. 所有权限请求集中可见、可审计；
5. 所有代码修改可通过 Git Diff 审查；
6. Agent、GUI 或系统崩溃后尽量恢复；
7. 源码、会话和凭据不经过本项目云服务器，模型请求由 Runtime 直连用户选择的 Provider；
8. 通过全局待处理中心集中呈现“等待审批、等待输入、已完成、失败和冲突”的任务。

---

# 2. 产品定义

## 2.1 一句话定义

> 一款本地控制、本地存储的多 Coding Agent Runtime 工作台：统一管理本地项目、并行 Agent 会话、Git Worktree、工具调用、权限审批、终端和 Diff，同时保留 Claude Code、Codex、OpenCode 等 Runtime 的原生 Agent 能力；模型请求由 Runtime 直接发送到用户选择的 Provider，不经过本项目服务器。

V1 的准确产品类型是“多 Runtime、多 Session 工作台”，不是自动拆解任务和协调 Agent 团队的全自动编排器。任务依赖图、跨 Agent 交接和结果聚合属于后续版本。

## 2.2 用户最终体验

用户打开一个项目后，可以创建多个并行任务：

```text
my-project
├── Claude Agent · Claude Opus
│   ├── 任务：重构登录模块
│   ├── 状态：运行测试
│   └── Worktree：agent/claude/auth-refactor
│
├── Codex · GPT
│   ├── 任务：检查数据库并发问题
│   ├── 状态：等待网络权限
│   └── Worktree：agent/codex/db-review
│
└── OpenCode · DeepSeek
    ├── 任务：补齐前端测试
    ├── 状态：修改文件中
    └── Worktree：agent/opencode/frontend-tests
```

用户在一个 GUI 中可以：

- 同时向多个 Agent 分配任务；
- 查看实时文本、计划和工具调用；
- 审批文件写入、Shell、网络、MCP、外部目录等操作；
- 查看 Hooks 执行记录；
- 查看子 Agent 状态；
- 查看每个任务独立的 Git Diff；
- Stage、Unstage、Revert、Commit、Rebase、Merge；
- 停止、继续、恢复或归档会话；
- 查看 Token、费用、CPU、内存和进程状态；
- 继续使用各 Runtime 原有配置、MCP、Skills、Hooks、Agents 和 Plugins。

---

# 3. 目标与非目标

## 3.1 产品目标

### P0：Windows Alpha 必须实现

- 本地 Git 项目管理；
- Fake Runtime 与 OpenCode 首个真实闭环；
- 多 Session 并行；
- 每个写任务独立 Worktree；
- 实时会话、工具调用和 Runtime 权限请求透传；
- Git Status、只读 Diff 和 Commit；
- Session 持久化与基础恢复；
- 原生 Runtime 配置继承；
- 优先复用 Runtime 原生认证；
- Windows 原生执行环境；
- 全局待处理中心。

### P1：可发布 V1

- Codex `app-server` Adapter；
- Runtime 能力动态发现；
- OpenCode + Codex 两类 Runtime 的稳定并行闭环；
- 结构化权限展示与可审计决策；
- Stage/Unstage、Commit 和安全合并流程；
- Context、Token、费用与资源显示；
- 外部编辑器集成；
- Worktree 初始化脚本与安全清理；
- Windows 崩溃恢复与安装升级。

### P2：后续增强

- Claude 原生模式 Adapter 与可选 Agent SDK 模式；
- 通用 ACP Adapter；
- macOS、Linux 与 WSL 执行环境；
- 宿主 Hooks；
- 子 Agent 可视化；
- MCP 管理器；
- Session Fork；
- 自动 Review Agent；
- Agent 结果对比；
- 多 Agent 流程编排；
- 插件 SDK；
- 任务模板；
- 本地知识库和长期记忆；
- 本地局域网远程控制。

## 3.2 明确不做

V1 不做：

- 云端账户系统；
- 团队 Workspace；
- 移动端；
- 跨设备同步；
- 云端中继；
- SaaS 计费；
- GitHub App 与云端 PR 同步；
- 自研大模型；
- 自研完整通用 Agent Loop；
- 完整 IDE；
- 完整 LSP 客户端；
- 内置代码调试器；
- 实时多人协同编辑；
- 自动部署平台；
- 全自动 Agent 团队编排；
- Claude Agent SDK 深度集成；
- 通用 ACP 长尾兼容；
- 完整的 macOS/Linux 发布；
- 宿主级通用 Skills 执行引擎。

---

# 4. 关键概念与边界

## 4.1 模型不等于 Agent Runtime

```text
Claude / GPT / DeepSeek
        = 模型

Claude Code / Codex / OpenCode
        = Agent Runtime
```

模型负责：

- 推理；
- 生成文本和代码；
- 决定下一步行动。

Agent Runtime 负责：

- Agent Loop；
- 上下文管理；
- 工具定义；
- 文件读取和编辑；
- Shell 执行；
- 权限；
- Hooks；
- MCP；
- Skills；
- 子 Agent；
- Session；
- 错误恢复。

相同模型在不同 Runtime 中的行为会显著不同：

```text
OpenCode + Claude ≠ Claude Code + Claude
OpenCode + GPT    ≠ Codex + GPT
```

## 4.2 宿主 Runtime 与 Agent Runtime

本项目拥有自己的**宿主 Runtime（Local Daemon）**，但 V1 不开发自己的 Coding Agent Runtime。

宿主负责：

- 项目；
- Worktree；
- Session 元数据；
- Runtime 进程；
- 统一事件；
- 权限 UI；
- Git 和 Diff；
- 宿主 Hooks；
- 持久化；
- 崩溃恢复。

第三方 Agent Runtime 负责：

- 模型交互；
- 上下文与工具循环；
- 原生工具；
- 原生 Hooks；
- Skills、MCP 和子 Agent；
- 原生会话能力。

## 4.3 原生能力与统一能力

### 统一能力

所有 Runtime 尽可能统一展示：

- 消息；
- 计划；
- 工具调用；
- 权限请求；
- 文件变化；
- 终端；
- 子 Agent；
- 用量；
- 错误；
- Session 状态。

### 原生能力

不强行统一：

- Claude Checkpoint、Claude Hooks 细节；
- Codex Thread/Turn/Item 与 Sandbox；
- OpenCode Agents、Plugins、LSP；
- Runtime 特有 Slash Commands；
- Runtime 特有模型模式和思考强度。

统一层之外保留 `NativeEvent` 和 Runtime 专属面板。

## 4.4 本地数据与模型服务边界

### 必须只保存在本机

- 项目源文件和 Worktree；
- Session、Turn、消息、事件和审计记录；
- Git 状态、Diff 缓存和运行状态；
- Runtime 配置索引和 Secret Reference；
- 日志、诊断包和恢复数据。

### 可以按用户选择离开本机

- 发送给模型 Provider 的 Prompt、上下文和必要代码片段；
- Runtime 原生 MCP、插件或工具主动访问的外部服务数据；
- 用户明确发起的 Git Push、发布或外部 API 写操作。

上述流量必须由 Runtime 或用户配置的 Provider 直接发出，不经过本项目运营方的服务器。UI 必须展示当前 Runtime、Provider、认证来源和已知的数据出口；如果 Runtime 无法报告精确出口，显示为“由 Runtime 管理 / 宿主不可完全观测”，不得声称完全离线。

---

# 5. 核心设计原则

## 5.1 Native-first，ACP-fallback

优先使用 Runtime 官方、信息最完整的接口；ACP 用于长尾和通用兼容。

```text
Claude：原生 CLI/结构化接口或 Agent SDK；ACP 作为兼容方案
Codex：app-server
OpenCode：Server + SDK
其他：ACP
```

## 5.2 GUI、桌面主进程、Daemon、Agent 进程分离

任何一层崩溃都不应无条件拖垮全部系统。

## 5.3 宿主统一基础设施，不统一智能内核

不重复实现 Runtime 已有的 Agent Loop 和原生工具。

## 5.4 能力动态发现

不得通过大量 `if runtime === ...` 硬编码 UI。Runtime Adapter 必须报告能力。

## 5.5 未知事件不静默丢弃

统一事件之外，保留未知原生事件的类型、关联关系、协议版本和脱敏后内容，便于升级和诊断。任何 Native Event 在持久化前仍必须经过 Secret 脱敏、隐私策略和体积限制。

## 5.6 Git 是代码变化的事实来源

Agent 自述“修改了哪些文件”不能作为最终依据。Diff 必须由宿主直接读取 Git 和文件系统。

## 5.7 默认隔离，显式共享

每个可写 Session 默认独立 Worktree；只有用户明确选择时才允许共享当前目录。

## 5.8 默认最小权限

只读、写入、Shell、网络、外部目录、凭据和 MCP 分级管理。

权限 UI 不等于安全沙箱。宿主只能审批 Runtime 明确暴露的请求；未暴露的操作只能依赖 Runtime 原生 Sandbox、操作系统隔离或容器边界。每项能力必须标注实际强制执行层级。

## 5.9 事件日志优先

Session 不只保存聊天文本，而要保存结构化事件、Runtime ID、权限、工具、进程和 Git 状态。

## 5.10 不自动重放可能有副作用的操作

Runtime 崩溃后不得自动重新发送最后 Prompt，除非能证明操作未执行且重放安全。

## 5.11 执行环境显式化

Windows 原生、WSL、macOS、Linux 和容器中的路径、Git、PTY、Runtime 与进程治理不同。Project、Runtime Installation 和 Worktree 必须绑定明确的 `ExecutionEnvironment`，不得隐式跨环境拼接路径或复用进程。

---

# 6. 总体系统架构

```text
┌───────────────────────────────────────────────────────────────┐
│ Desktop Application                                           │
│ Electron + Vue 3 + TypeScript                                 │
│                                                               │
│ Projects / Sessions / Chat / Tool Timeline / Diff / Terminal  │
│ Permissions / Hooks / Subagents / Runtime Settings            │
└──────────────────────────┬────────────────────────────────────┘
                           │ Secure Electron IPC
┌──────────────────────────▼────────────────────────────────────┐
│ Electron Main                                                 │
│                                                               │
│ Window / Native Dialog / Tray / Notification / Update         │
│ Secure Preload Bridge / Daemon Bootstrap                      │
└──────────────────────────┬────────────────────────────────────┘
                           │ Named Pipe / Unix Domain Socket
┌──────────────────────────▼────────────────────────────────────┐
│ Local Agent Daemon                                            │
│                                                               │
│ Project Manager          Session Orchestrator                 │
│ Runtime Supervisor       Adapter Registry                     │
│ Worktree Manager         Git & Diff Service                   │
│ Permission Broker        Host Hook Engine                     │
│ Event Store              PTY Manager                          │
│ Credential Broker        Resource Governor                    │
│ Recovery Manager         Observability                        │
└───────────────┬────────────────┬────────────────┬──────────────┘
                │                │                │
                ▼                ▼                ▼
      ┌────────────────┐ ┌────────────────┐ ┌──────────────────┐
      │ Claude Adapter │ │ Codex Adapter  │ │ OpenCode Adapter │
      │ Native/SDK/ACP │ │ app-server     │ │ Server + SDK     │
      └───────┬────────┘ └───────┬────────┘ └────────┬─────────┘
              │                  │                   │
              ▼                  ▼                   ▼
       Claude Runtime       Codex Runtime       OpenCode Runtime
              │                  │                   │
              ▼                  ▼                   ▼
       Claude Models         GPT Models        DeepSeek/Claude/GPT

                ┌──────────────────────────────────────┐
                │ Generic ACP Adapter                  │
                │ 其他本地或远程 ACP Runtime           │
                └──────────────────────────────────────┘
```

---

# 7. 进程拓扑与故障边界

## 7.1 推荐进程树

```text
local-agent-workspace.exe
├── Electron Main
│   └── Renderer Process
│
└── local-agent-daemon
    ├── Codex app-server
    │   ├── command processes
    │   └── MCP processes
    │
    ├── Claude runtime/session process
    │   ├── command processes
    │   └── MCP processes
    │
    ├── OpenCode server
    │   ├── command processes
    │   ├── LSP processes
    │   └── MCP processes
    │
    └── User PTY processes
```

## 7.2 故障隔离规则

- Renderer 崩溃：Daemon 和 Agent 继续运行；
- Electron Main 崩溃：Daemon 根据配置继续运行或进入短暂守护期；
- Daemon 崩溃：Runtime 进程应被识别为孤儿并在重启时重新连接或安全回收；
- 单个 Runtime 崩溃：只影响对应 Runtime/Session；
- 单个命令或 MCP 子进程崩溃：不得导致整个应用退出；
- 数据库损坏：只读恢复、备份恢复或重建投影；
- Git 操作失败：保持 Worktree，不得强制删除。

## 7.3 Daemon 是否独立常驻

建议提供两种模式：

```text
默认模式：关闭 GUI 时询问是否继续运行 Agent
常驻模式：Daemon 独立驻留系统托盘/后台
```

V1 可先采用“GUI 启动 Daemon，退出时可选择保留”的策略。

---

# 8. Runtime 接入策略

## 8.1 接入矩阵

| Runtime | 首选接口 | 备用接口 | 主要用途 |
|---|---|---|---|
| Claude | 原生结构化接口 / Claude Agent SDK | ACP 或 CLI JSON | Claude 原生工具、Hooks、Skills、Subagents、MCP |
| Codex | `codex app-server` | Codex SDK | Thread、Turn、Item、Approval、Sandbox、MCP |
| OpenCode | `opencode serve` + SDK | `opencode acp` | 多 Provider、DeepSeek、Agents、Plugins、LSP、Permissions |
| 其他 Agent | ACP | 自定义 Adapter | 长尾 Runtime 扩展 |

## 8.2 Claude 接入的关键约束

Claude 需要区分两种模式：

### A. 本机原生 Runtime 模式

目标是复用用户本机已安装并已登录的 Claude 工具链，尽量保留用户现有配置和订阅使用方式。

可能的接入方式：

- 官方支持的结构化子进程模式；
- 兼容 ACP 的 Claude Runtime/Adapter；
- 稳定 JSON 输出模式；
- 后续获得正式集成许可后的深度接入。

### B. Agent SDK 模式

适合 API Key 驱动的深度集成：

- SDK 提供 Agent Loop、工具、Hooks、Subagents、MCP、权限和 Sessions；
- 但产品认证和品牌必须遵守 Anthropic 当前条款；
- 当前官方文档明确提醒，第三方产品不得默认向用户提供 claude.ai 登录或订阅额度，除非得到批准；
- 因此不能把“Agent SDK 模式”与“用户 Claude Code 订阅登录”混为一谈。

产品中应显示：

```text
Claude Runtime 模式：
○ 本机原生 Runtime
○ API Key / Agent SDK
```

## 8.3 Codex 接入

优先使用：

```bash
codex app-server
```

职责映射：

```text
Codex thread        → Host Session / Runtime Session
Codex turn          → Host Turn
Codex item          → Message / Tool / Command / File Event
Approval request    → Host Permission Request
turn completed      → Session IDLE
turn interrupted    → Session INTERRUPTED
```

禁止通过解析 Codex TUI 的彩色文本来判断工具调用。

## 8.4 OpenCode 接入

优先启动：

```bash
opencode serve --hostname 127.0.0.1 --port <random-port>
```

并设置随机密码：

```text
OPENCODE_SERVER_PASSWORD=<random-secret>
```

通过 `@opencode-ai/sdk` 或 OpenAPI 客户端控制：

- Health；
- Project；
- Session；
- Message；
- Permission；
- File；
- Diff；
- Global SSE Event；
- Agent、Provider、Model 等。

OpenCode 是 DeepSeek 等多 Provider 模型在 V1 中的主要承载 Runtime。

## 8.5 ACP Adapter

ACP Adapter 用于：

- ACP Registry Runtime；
- 用户自定义 ACP Agent；
- 后续的 Gemini CLI、Kimi、Qwen Code 或其他兼容实现。

启动配置必须结构化：

```ts
interface AcpLaunchConfig {
  executable: string;
  args: string[];
  environment: Record<string, SecretReference | string>;
  cwdMode: "project" | "worktree" | "custom";
}
```

不得直接执行任意 Shell 字符串。禁止默认支持：

- 管道；
- 重定向；
- 命令替换；
- Shell 变量展开；
- 通配符展开；
- `&&` / `||` 链。

---

# 9. 模型、Provider 与 Runtime 的关系

## 9.1 三层选择器

新建 Session 必须显示：

```text
Runtime：OpenCode
Provider：DeepSeek
Model：<Runtime 返回的模型>
```

而不是只显示“DeepSeek”。

## 9.2 推荐组合

```text
Claude 原生能力：Claude Runtime + Claude
GPT 原生能力：Codex + GPT
DeepSeek：OpenCode + DeepSeek Provider
其他 Claude/GPT：OpenCode + 对应 Provider
长尾 Agent：ACP Runtime + 对应模型
```

## 9.3 Runtime Profile

```ts
interface RuntimeProfile {
  id: string;
  name: string;
  executionEnvironmentId: string;
  runtimeType: "claude" | "codex" | "opencode" | "acp";

  executable?: string;
  args: string[];

  provider?: string;
  model?: string;
  mode?: string;

  environment: Record<string, string | SecretReference>;
  nativeConfigPath?: string;

  permissionProfileId: string;
  resourceProfileId: string;

  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}
```

---

# 10. 领域模型

## 10.1 ExecutionEnvironment

```ts
interface ExecutionEnvironment {
  id: string;
  type: "windows-native" | "wsl" | "macos" | "linux" | "container";
  displayName: string;

  homePath: string;
  pathStyle: "windows" | "posix";
  defaultShell: string;
  gitExecutable: string;

  capabilities: {
    pty: boolean;
    processGroups: boolean;
    jobObjects: boolean;
    symlinks: boolean;
  };

  createdAt: number;
  updatedAt: number;
}
```

V1 只实现 `windows-native`，但从领域模型开始保留执行环境边界。路径、Git 可执行文件、Runtime Installation、Worktree 和进程不得跨环境混用。

```ts
type WorktreeAction =
  | {
      type: "exec";
      executable: string;
      args: string[];
      environment?: Record<string, string | SecretReference>;
    }
  | {
      type: "shell";
      shell: "powershell" | "cmd" | "bash" | "zsh";
      script: string;
    };
```

## 10.2 Project

```ts
interface Project {
  id: string;
  name: string;
  executionEnvironmentId: string;
  rootPath: string;
  gitRoot: string;
  repositoryId: string;

  defaultBranch?: string;
  defaultBaseRef?: string;

  setupActions?: WorktreeAction[];
  cleanupActions?: WorktreeAction[];

  createdAt: number;
  updatedAt: number;
}
```

## 10.3 HostSession

```ts
interface HostSession {
  id: string;
  title: string;

  projectId: string;
  primaryWorkspaceBindingId?: string;

  runtimeType: string;
  runtimeProfileId: string;
  runtimeSessionId?: string;

  provider?: string;
  model?: string;
  mode?: string;

  lifecycle: "active" | "archiving" | "archived";
  activity:
    | "preparing"
    | "idle"
    | "queued"
    | "running"
    | "waiting_permission"
    | "waiting_user_input"
    | "interrupting"
    | "stopped";
  health:
    | "healthy"
    | "auth_required"
    | "incompatible_runtime"
    | "interrupted_runtime"
    | "interrupted_daemon"
    | "recovery_required"
    | "error";

  writeMode: "isolated-worktree" | "shared-workdir" | "read-only";

  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
}
```

## 10.4 HostTurn

```ts
interface HostTurn {
  id: string;
  sessionId: string;
  runtimeTurnId?: string;

  status:
    | "queued"
    | "running"
    | "waiting_permission"
    | "waiting_user_input"
    | "completed"
    | "failed"
    | "cancelled"
    | "interrupted";

  userInput: unknown;
  startedAt?: number;
  completedAt?: number;
}
```

## 10.5 Worktree

```ts
interface WorktreeRecord {
  id: string;
  projectId: string;
  ownerSessionId?: string;
  executionEnvironmentId: string;

  path: string;
  branchName: string;

  baseRef: string;
  baseCommit: string;

  status:
    | "creating"
    | "active"
    | "dirty"
    | "conflicted"
    | "merged"
    | "orphaned"
    | "removing"
    | "removed";

  createdAt: number;
  removedAt?: number;
}
```

## 10.6 ProcessRecord

```ts
interface ProcessRecord {
  id: string;
  sessionId?: string;
  runtimeHandleId?: string;
  executionEnvironmentId: string;

  processType: "daemon" | "runtime" | "pty" | "mcp" | "lsp" | "hook" | "command";
  pid: number;
  parentPid?: number;

  daemonBootId: string;
  processStartTime: number;
  processFingerprint?: string;
  spawnNonce: string;

  executable?: string;
  cwd?: string;

  status: "starting" | "running" | "stopping" | "exited" | "orphaned";
  startedAt: number;
  exitedAt?: number;
  exitCode?: number;
  signal?: string;
}
```

恢复时不得只凭 PID 判断进程归属，因为操作系统可能复用 PID。至少同时核对 `daemonBootId`、进程启动时间、可执行文件和启动时生成的 `spawnNonce`；无法确认时标记为可疑孤儿，不自动终止。

## 10.7 OperationRecord

```ts
interface OperationRecord {
  id: string;
  operationId: string;
  type: "worktree_create" | "runtime_session_create" | "permission_response" | "commit" | "merge" | "worktree_remove";
  sessionId?: string;

  status: "prepared" | "running" | "committed" | "failed" | "uncertain";
  requestPayload: unknown;
  resultPayload?: unknown;
  error?: unknown;

  createdAt: number;
  updatedAt: number;
}
```

具有副作用且需要恢复判断的宿主操作必须先落盘为 `prepared`，再执行外部动作。不能只在内存中保存 Operation ID。

---

# 11. Local Daemon 模块设计

## 11.1 Project Manager

职责：

- 注册、移除和验证本地项目；
- 绑定并验证 Execution Environment；
- 识别 Git Root 和 canonical git dir；
- 读取分支和远端；
- 发现项目配置；
- 检测当前工作区是否脏；
- 管理项目级 setup/cleanup 脚本。

## 11.2 Runtime Supervisor

职责：

- 自动发现可执行文件；
- 检测版本；
- 检测健康状态；
- 检测认证状态；
- 启动、停止、重启；
- 管理随机端口、本机身份和 Connection Epoch；
- 使用 PID、启动时间、daemonBootId 和 spawnNonce 维护进程树；
- 捕获 stdout/stderr；
- 识别异常退出；
- 空闲回收；
- 资源统计。

## 11.3 Adapter Registry

职责：

- 注册 Claude/Codex/OpenCode/ACP Adapter；
- 按 Runtime Type 选择 Adapter；
- 版本兼容判断；
- Adapter Contract 校验；
- Feature Flag；
- Protocol Migration。

## 11.4 Session Orchestrator

职责：

- 创建 Host Session；
- 创建或复用 Runtime Handle；
- 创建/恢复 Runtime Session；
- 发送用户输入；
- 消费 Runtime Event；
- 状态转换；
- 中断和取消；
- 权限等待；
- 用户输入等待；
- 归档与恢复。

## 11.5 Event Normalizer

职责：

- 将不同 Runtime 事件映射到 Host Event；
- 分配 Stream Sequence 和可选 Session Sequence；
- 先脱敏、限额，再保存 Native Payload 或 Blob Reference；
- 处理增量文本合并；
- 处理 Tool 生命周期；
- 处理重复事件；
- 处理乱序事件；
- 推送给桌面端。

## 11.6 Permission Broker

职责：

- 接收 Runtime 明确暴露的权限请求；
- 标准化风险类别和 Enforcement Level；
- 只在结构化信息充分时匹配权限规则；
- 自动允许或拒绝；
- 向 GUI 发出审批；
- 保存决策；
- 将 Host 决策转换为 Runtime 决策。

## 11.7 Worktree Manager

职责：

- 验证 Execution Environment；
- 通过 Durable Operation 创建独立分支和 Worktree；
- 运行 setup 脚本；
- 检查 dirty 状态；
- 处理冲突；
- 安全清理；
- 孤儿 Worktree 恢复。

## 11.8 Git & Diff Service

职责：

- Status；
- Diff；
- Stage/Unstage；
- Revert；
- Commit；
- Rebase；
- Merge；
- Conflict；
- Log；
- Branch；
- Worktree；
- Submodule 基础识别；
- LFS 状态提示。

## 11.9 Host Hook Engine

职责：

- 加载全局和项目 Hooks；
- 事件匹配；
- 执行命令或脚本；
- 设置超时；
- 捕获输出；
- 阻止宿主操作；
- 记录 Hook Run。

## 11.10 PTY Manager

职责：

- 创建交互终端；
- 维护 cwd；
- Resize；
- ANSI 流；
- 输入输出；
- Shell 选择；
- 重连；
- 进程树终止。

## 11.11 Credential Broker

职责：

- 保存 Secret Reference；
- 调用系统凭据库；
- 通过最小环境变量 Allowlist 向指定子进程注入 Secret；
- 在数据库、WAL、事件、Blob 和日志之前脱敏；
- 不把明文 Secret 写入 SQLite。

## 11.12 Recovery Manager

职责：

- Daemon 启动时扫描非终态 Session 和 Operation；
- 使用完整进程身份核对进程、Worktree、Git 和 Runtime Session；
- 重建正交状态投影和 Attention Inbox；
- 标记可恢复、需确认或不可恢复；
- 回收孤儿进程；
- 不自动重放高风险操作。

---

# 12. Runtime Adapter 规范

## 12.1 核心接口

Runtime 控制命令和 Runtime 事件流必须分离。Codex app-server、OpenCode SSE 等协议都可能在一次请求结束后继续发送事件，也可能在一个 Runtime Handle 中承载多个 Session。不得让多个 `send()` 迭代器竞争同一底层连接。

```ts
interface RuntimeAdapter {
  readonly runtimeType: string;
  readonly adapterVersion: string;

  detect(options?: DetectOptions): Promise<RuntimeDetection[]>;
  probe(installation: RuntimeInstallation): Promise<RuntimeProbeResult>;

  start(options: RuntimeStartOptions): Promise<RuntimeHandle>;
  stop(handle: RuntimeHandle, options?: StopOptions): Promise<void>;

  events(
    handle: RuntimeHandle,
    options?: {
      cursor?: RuntimeEventCursor;
      connectionEpoch?: string;
      signal?: AbortSignal;
    }
  ): AsyncIterable<RuntimeEvent>;

  createSession(
    handle: RuntimeHandle,
    options: RuntimeSessionCreateOptions
  ): Promise<RuntimeSession>;

  resumeSession(
    handle: RuntimeHandle,
    runtimeSessionId: string
  ): Promise<RuntimeSession>;

  forkSession?(
    handle: RuntimeHandle,
    runtimeSessionId: string,
    options?: RuntimeForkOptions
  ): Promise<RuntimeSession>;

  startTurn(
    session: RuntimeSession,
    input: RuntimeUserInput
  ): Promise<RuntimeTurn>;

  steerTurn?(
    session: RuntimeSession,
    runtimeTurnId: string,
    input: RuntimeUserInput
  ): Promise<void>;

  cancelTurn(
    session: RuntimeSession,
    runtimeTurnId?: string
  ): Promise<void>;

  respondToPermission(
    session: RuntimeSession,
    request: RuntimePermissionRequestRef,
    decision: RuntimePermissionDecision
  ): Promise<void>;

  respondToUserInput?(
    session: RuntimeSession,
    request: RuntimeUserInputRequestRef,
    input: unknown
  ): Promise<void>;

  discoverCommands?(
    session: RuntimeSession
  ): Promise<RuntimeCommand[]>;

  disposeSession(
    session: RuntimeSession
  ): Promise<void>;
}
```

## 12.2 事件通道规则

- 每个 Runtime Handle 只有一个底层事件读取器，由 Adapter 内部分发到不同 Session；
- 所有事件尽可能携带 `runtimeSessionId`、`runtimeTurnId`、`runtimeItemId`；
- 无法归属到 Session 的认证、进程和 Provider 事件保留为 Runtime Scope；
- 重连后生成新的 `connectionEpoch`，旧连接上的审批请求自动失效；
- Runtime 有原生 Cursor 时使用原生 Cursor；没有时由 Adapter 明确报告“不支持补发”，宿主通过快照和状态核对恢复；
- 事件读取必须有背压、缓冲上限和未知事件保留机制。

## 12.3 RuntimeScope

```ts
type RuntimeScope =
  | "global"
  | "project"
  | "worktree"
  | "session";
```

Adapter 自己声明推荐 Scope：

```text
Codex app-server：global 或 project
OpenCode server：默认 worktree；只有 Probe 证明可安全多目录时才允许 project
Claude：session 或 worktree
ACP：由能力和配置决定
```

## 12.4 Adapter 不得做的事

- 不得修改宿主数据库；
- 不得直接操作 GUI；
- 不得擅自创建 Worktree；
- 不得绕过 Permission Broker；
- 不得把 Permission Broker 描述成其实际不具备的安全沙箱；
- 不得把 Secret 写入日志或未脱敏 Native Event；
- 不得静默吞掉未知事件；
- 不得将 Runtime 协议异常伪装为成功。

---

# 13. 能力发现与降级机制

## 13.1 支持级别

能力不能只使用布尔值。Runtime 版本变化、实验接口和宿主无法验证的能力必须显式表达。

```ts
type SupportLevel =
  | "supported"
  | "experimental"
  | "degraded"
  | "unsupported"
  | "unknown";

interface Capability<TConstraints = Record<string, unknown>> {
  level: SupportLevel;
  source: "runtime_probe" | "adapter_static" | "user_override";
  constraints?: TConstraints;
  reason?: string;
}
```

## 13.2 统一能力对象

```ts
interface RuntimeCapabilities {
  protocolVersion?: string;

  sessions: {
    resume: Capability;
    fork: Capability;
    multiSessionPerRuntime: Capability<{ maxSessions?: number }>;
  };

  streaming: {
    text: Capability;
    toolEvents: Capability;
    toolProgress: Capability;
    eventReplay: Capability<{ cursorType?: string }>;
  };

  permissions: {
    command: Capability;
    fileWrite: Capability;
    network: Capability;
    mcp: Capability;
    inputMutation: Capability;
    enforcement:
      | "runtime_sandbox"
      | "os_sandbox"
      | "interceptable"
      | "observable_only"
      | "opaque";
  };

  interaction: {
    userInputRequest: Capability;
    plans: Capability;
    todoList: Capability;
    subagents: Capability;
  };

  native: {
    hooks: Capability;
    skills: Capability;
    plugins: Capability;
    commands: Capability;
    checkpoints: Capability;
    mcp: Capability;
    lsp: Capability;
  };

  selection: {
    model: Capability;
    provider: Capability;
    mode: Capability;
  };

  reporting: {
    usage: Capability;
    cost: Capability;
    context: Capability;
  };

  input: {
    image: Capability;
    file: Capability;
  };
}
```

## 13.3 UI 降级规则

```text
supported     → 正常显示
experimental  → 显示实验标记并受 Feature Flag 控制
degraded      → 显示限制和降级原因
unsupported   → 不显示，不模拟
unknown       → 显示“未验证”，禁止默认启用危险能力
```

权限 UI 还必须显示执行层：

```text
Runtime Sandbox / OS Sandbox → 可表述为强制边界
Interceptable                → 仅对 Runtime 主动请求的操作有效
Observable Only              → 只记录，不能阻止
Opaque                       → 宿主不可见，不得承诺统一审批
```

## 13.4 版本缓存

能力缓存键：

```text
runtimeType + executablePath + runtimeVersion + adapterVersion + executionEnvironmentId
```

Runtime 升级、执行环境变化或实验能力开关变化后必须重新 Probe。

---

# 14. 统一事件模型

## 14.1 Event Scope 与 Envelope

事件既可能属于 Session，也可能属于整个 Runtime、Project 或 Daemon。所有事件进入宿主持久化边界前必须先完成 Schema 校验、大小限制和脱敏。

```ts
type EventScope = "daemon" | "runtime" | "project" | "session" | "turn";

interface EventEnvelope<T = unknown> {
  eventId: string;
  schemaVersion: number;

  scope: EventScope;
  projectId?: string;
  runtimeHandleId?: string;
  sessionId?: string;
  turnId?: string;

  streamId: string;
  streamSequence: number;
  sessionSequence?: number;

  type: HostEventType;
  payload: T;

  runtimeType?: string;
  runtimeEventId?: string;
  runtimeSessionId?: string;
  runtimeTurnId?: string;
  connectionEpoch?: string;

  correlationId?: string;
  causationId?: string;
  operationId?: string;

  createdAt: number;
  receivedAt: number;
}
```

`streamSequence` 用于 GUI 对 Daemon 事件流断线续传；`sessionSequence` 只用于 Session 内时间线。不能要求认证变化、Runtime 退出等全局事件伪造 `sessionId`。

## 14.2 Host Event 类型

```ts
type HostEventType =
  | "environment.state_changed"
  | "runtime.state_changed"
  | "runtime.auth_changed"
  | "runtime.warning"
  | "runtime.error"
  | "runtime.exited"

  | "session.state_changed"
  | "turn.state_changed"

  | "user.message_created"
  | "assistant.message_started"
  | "assistant.text_delta"
  | "assistant.message_completed"
  | "assistant.reasoning_summary"

  | "plan.updated"
  | "todo.updated"

  | "tool.started"
  | "tool.progress"
  | "tool.completed"
  | "tool.failed"

  | "permission.requested"
  | "permission.resolved"
  | "permission.invalidated"

  | "user_input.requested"
  | "user_input.resolved"

  | "subagent.started"
  | "subagent.updated"
  | "subagent.completed"

  | "file.changed"
  | "git.state_changed"

  | "hook.started"
  | "hook.completed"
  | "hook.failed"

  | "usage.updated"
  | "context.updated"

  | "operation.state_changed"
  | "native.event";
```

## 14.3 Tool Event

```ts
interface ToolStartedPayload {
  toolCallId: string;
  toolName: string;
  title?: string;
  category?: string;
  input?: unknown;
  source: "native" | "mcp" | "host";
  serverName?: string;
  enforcementLevel?:
    | "runtime_sandbox"
    | "os_sandbox"
    | "interceptable"
    | "observable_only"
    | "opaque";
}
```

## 14.4 Native Event

```ts
interface NativeEventPayload {
  nativeType: string;
  nativeProtocolVersion?: string;

  redacted: boolean;
  truncated: boolean;
  redactionKinds?: string[];

  raw?: unknown;
  blobRef?: string;
  contentHash: string;
}
```

Native Event 默认不直接展示给普通用户。未知事件的类型、关联关系和脱敏后内容必须保留，但“原始事件”不表示可以绕过 Secret 脱敏、体积限制或隐私设置。

## 14.5 事件存储策略

- Runtime 输入首先进入内存接收缓冲；
- 在任何 SQLite、WAL、文件日志或诊断输出之前完成 Schema 校验、脱敏和大小限制；
- Tool、Permission、State、Operation 等关键事件逐条持久化；
- 文本 Delta 在短窗口内合并，最终消息块单独保存，避免 WAL 被逐 Token 写入放大；
- 大体积终端输出、Diff 和 Native Payload 写入受限 Blob Store，事件表只存引用、哈希和摘要；
- 使用 `runtimeEventId + connectionEpoch` 或 Adapter 生成的稳定键去重；
- 单 Session 日志超过阈值后滚动归档，并保存可重建投影的快照；
- 未知事件不得静默丢弃；无法持久化时写入脱敏错误摘要并标记 Session 诊断不完整。

---

# 15. Session 状态模型

单一 `HostSessionStatus` 无法同时表达“已归档、Runtime 中断、Worktree 冲突”等组合。Session 使用互相正交的状态维度。

## 15.1 Lifecycle

```text
ACTIVE → ARCHIVING → ARCHIVED
```

Lifecycle 只描述 Session 是否仍参与日常工作，不描述当前是否正在执行 Turn。

## 15.2 Activity

```text
PREPARING
  ↓
IDLE
  ↓ 用户发送消息
QUEUED
  ↓
RUNNING
  ├── WAITING_PERMISSION
  ├── WAITING_USER_INPUT
  ├── INTERRUPTING
  └── Turn 终态 → IDLE
```

默认每个 Runtime Session 同时只允许一个主 Turn。额外输入进入显式队列；只有 Runtime 明确支持 steer 时，UI 才允许把输入追加到正在运行的 Turn。

## 15.3 Health

```text
HEALTHY
AUTH_REQUIRED
INCOMPATIBLE_RUNTIME
INTERRUPTED_RUNTIME
INTERRUPTED_DAEMON
RECOVERY_REQUIRED
ERROR
```

Health 与 Activity 独立。例如 Session 可以同时为：

```text
lifecycle = ACTIVE
activity  = IDLE
health    = INTERRUPTED_RUNTIME
workspace = DIRTY
```

## 15.4 Workspace State

Worktree/Workspace 独立维护：

```text
CREATING
CLEAN
DIRTY
CONFLICTED
ORPHANED
MERGED
REMOVING
REMOVED
```

## 15.5 Session 与 Turn 分离

一次 Agent 回复完成只代表 Turn 完成：

```text
Session.activity：回到 IDLE
Turn.status：COMPLETED / FAILED / CANCELLED / INTERRUPTED
```

不得把一次 Turn 完成误判为 Session 结束，也不得用一次失败覆盖 Session 的 Lifecycle、Health 或 Workspace State。

---

# 16. 项目与 Worktree 架构

## 16.1 默认规则

> 一个独立写任务对应一个独立 Worktree。

Worktree 提供并行代码隔离，不等于安全沙箱。Project、Git、Runtime 和 Worktree 必须位于同一个 Execution Environment。

## 16.2 目录布局

应用数据默认位于用户本地数据目录：

~~~text
~/.local-agent-workspace/
├── data/
│   └── workspace.db
├── blobs/
├── logs/
├── cache/
├── runtimes/
└── sessions/
~~~

Windows 可映射到：

~~~text
%LOCALAPPDATA%\LocalAgentWorkspace\
~~~

Worktree 根目录必须可配置。默认优先选择与原仓库处于同一 Execution Environment、同一磁盘且路径较短的位置：

~~~text
<configured-worktree-root>/
└── <project-id>/
    ├── <session-id-a>/
    ├── <session-id-b>/
    └── <session-id-c>/
~~~

不得在 Windows Git、WSL Git 和容器 Git 之间复用同一个 Worktree Record。创建前检查路径长度、大小写语义、符号链接/Junction 和文件系统能力。

## 16.3 分支命名

~~~text
agent/<runtime>/<short-session-id>-<slug>
~~~

示例：

~~~text
agent/claude/a83f12-auth-refactor
agent/codex/b94122-db-review
agent/opencode/c712ab-tests
~~~

## 16.4 创建流程

~~~text
1. 验证 Project 与 Runtime 位于同一 Execution Environment
2. 验证 Git 仓库和 canonical git dir
3. 解析 base ref
4. 将 base ref 固定为 base commit SHA
5. 检查目标分支名和路径冲突
6. 写入 prepared OperationRecord
7. 创建分支和 Worktree
8. 写入 WorktreeRecord 并提交 Operation
9. 执行用户批准的项目 setup 动作
10. 检查 setup 结果、路径边界和 Git 状态
11. 将 Worktree 路径交给 Runtime
~~~

## 16.5 Setup 脚本

项目可以配置结构化命令，也可以显式配置需要 Shell 解释的脚本：

~~~yaml
worktree:
  setup:
    - type: exec
      executable: pnpm
      args: [install, --frozen-lockfile]
    - type: shell
      shell: powershell
      script: Copy-Item .env.example .env
  cleanup:
    - type: exec
      executable: pnpm
      args: [run, clean]
~~~

`exec` 使用参数数组启动；`shell` 是用户明确授权的脚本能力，必须记录 Shell 类型、脚本哈希和批准来源，不能与 Runtime 启动配置混为一谈。

要求：

- 默认需要首次批准；
- 有超时；
- 输出可查看；
- 失败时允许重试、跳过或保留 Worktree；
- 不得静默执行来自不可信仓库的脚本；
- Setup 失败时不得自动删除包含修改的 Worktree。

## 16.6 清理规则

清理前必须验证：

- 没有正在运行的 Runtime；
- 没有 PTY 占用；
- 没有未提交修改，或用户明确放弃；
- 没有未合并 Commit，或用户明确保留分支；
- 没有 merge/rebase/cherry-pick 进行中；
- Worktree 路径、canonical path、Execution Environment 与数据库一致；
- 分支是否已合并；
- 清理 Operation 已持久化。

默认策略：

~~~text
归档 Session ≠ 自动强制删除 Worktree
~~~

建议提供：

- 归档并保留 Worktree；
- 归档并在安全条件满足时清理；
- 导出 Patch/保留分支后放弃修改并清理；
- 仅停止 Runtime。

---

# 17. Git、Diff、Commit 与合并

## 17.1 Git CLI 为事实来源

第一版直接调用当前 Execution Environment 中的系统 Git，避免纯 JS Git 在以下能力上的不一致：

- Worktree；
- Submodule；
- LFS；
- Credential Helper；
- 签名提交；
- 用户 Git Hooks；
- Rebase/Merge；
- 平台凭据。

Git 可执行文件与 Project 的 Execution Environment 绑定，不得用 Windows Git 操作 WSL 仓库，反之亦然。

## 17.2 Diff 层级

### 工作区 Diff

~~~text
Working Tree vs Index
~~~

### 暂存区 Diff

~~~text
Index vs HEAD
~~~

### Session 总 Diff

~~~text
baseCommit vs Session HEAD
+
当前未提交改动
~~~

## 17.3 宿主执行的 Git 命令

典型命令：

~~~bash
git status --porcelain=v2 -z
git diff --no-ext-diff --binary
git diff --cached --no-ext-diff --binary
git diff <baseCommit>...HEAD --no-ext-diff
git ls-files --others --exclude-standard -z
git merge-base <baseCommit> HEAD
git log --format=...
~~~

所有参数通过数组传递，不拼接 Shell 字符串。Diff、二进制内容和单文件输出必须设置大小上限；超限时只显示元数据并允许用户用外部工具打开。

## 17.4 分阶段 Git 操作

### Windows Alpha

- 查看修改文件；
- 查看 Unified Diff；
- Monaco 左右 Diff；
- Commit；
- 查看 Session Commit；
- 打开外部编辑器。

### 可发布 V1

- Stage / Unstage；
- Revert 单文件（执行前创建可恢复 Patch/快照）；
- 冲突检测；
- 在临时 Integration Worktree 中 Rebase 或 Merge；
- 用户确认后更新目标分支；
- 打开外部编辑器解决冲突。

Revert 单个未暂存修改块、复杂 Cherry-pick 编辑和完整冲突编辑器后置。

## 17.5 合并策略

可发布 V1 提供：

~~~text
Fast-forward
Merge commit
Squash
Cherry-pick commits
~~~

默认流程：

~~~text
在临时 Integration Worktree 中执行 Squash 或 Merge commit
→ 运行用户选择的验证
→ 用户确认
→ 更新目标分支
~~~

宿主不得默认直接在用户主工作区执行 Merge。Git Commit、Merge、Rebase 可能触发用户 Git Hooks、签名程序、Credential Helper 或编辑器；这些都属于额外进程执行，必须可见、可取消，并使用明确的非交互策略或用户终端。

合并前检查：

- 目标工作区是否脏；
- Session 是否有未提交修改；
- 测试状态；
- 冲突；
- base branch 是否前进；
- 是否需要 Rebase；
- 目标分支是否在其他 Worktree 被占用；
- Integration Worktree 是否可以安全清理。

---

# 18. 权限审批系统

## 18.1 统一交互不等于统一强制执行

~~~text
Runtime/OS 实际安全边界
        ↓
Runtime 暴露审批请求（如果支持）
        ↓
宿主 Permission Broker 标准化与展示
        ↓
用户或宿主规则决策
        ↓
返回 Runtime
~~~

Runtime 仍然是原生工具的实际执行者；宿主不重复执行 Runtime 工具。Permission Broker 的职责是统一交互、规则匹配和审计，而不是假装可以拦截 Runtime 没有上报的操作。

每个 Runtime Profile 必须显示：

~~~text
Sandbox：Runtime / OS / 无
审批覆盖：命令 / 文件 / 网络 / MCP / 未知
宿主能力：可阻止 / 仅观察 / 不可见
~~~

## 18.2 Enforcement Level

~~~ts
type EnforcementLevel =
  | "runtime_sandbox"
  | "os_sandbox"
  | "interceptable"
  | "observable_only"
  | "opaque";
~~~

- `runtime_sandbox`：由 Runtime 自己强制限制；
- `os_sandbox`：由操作系统、容器或受控执行环境强制限制；
- `interceptable`：仅对 Runtime 主动请求宿主决策的操作有效；
- `observable_only`：宿主可以记录，但不能阻止；
- `opaque`：宿主无法可靠观察。

Worktree 只提供并行代码隔离，不属于安全沙箱。

## 18.3 权限类别

~~~ts
type PermissionCategory =
  | "file_read"
  | "file_write"
  | "file_delete"
  | "shell"
  | "network"
  | "external_directory"
  | "credential"
  | "mcp"
  | "git_push"
  | "process"
  | "clipboard"
  | "browser"
  | "other";
~~~

权限类别表示 UI 和审计分类，不代表所有 Runtime 都能在执行前暴露该类请求。

## 18.4 风险级别

~~~text
LOW      只读、项目内搜索
MEDIUM   Worktree 内写入、测试命令
HIGH     网络、删除、外部目录、Git Push
CRITICAL 凭据、系统目录、提权、破坏性命令
~~~

## 18.5 决策类型

~~~ts
type HostPermissionDecision =
  | "allow_once"
  | "allow_session"
  | "allow_project"
  | "deny_once"
  | "deny_session"
  | "cancel_turn";
~~~

如果 Runtime 只支持 Allow/Deny：

- `allow_project` 由宿主保存为自动响应规则；
- 下次只有在结构化请求和 Enforcement Level 均可验证时才自动返回 Allow；
- 不声称 Runtime 自己保存了永久规则；
- 原始命令为 Shell 字符串、请求信息不完整或来源为 `unknown` 时，不创建持久 Allow 规则。

## 18.6 权限请求结构

~~~ts
interface PermissionRequest {
  id: string;
  sessionId: string;
  turnId?: string;

  runtimeRequestId: string;
  runtimeHandleId: string;
  connectionEpoch: string;

  category: PermissionCategory;
  risk: "low" | "medium" | "high" | "critical";
  enforcementLevel: EnforcementLevel;

  title: string;
  description: string;

  command?: {
    executable?: string;
    args?: string[];
    raw?: string;
    cwd?: string;
    parsed: boolean;
  };

  paths?: string[];
  networkTargets?: string[];
  mcpServer?: string;
  mcpTool?: string;

  availableDecisions: HostPermissionDecision[];
  nativeRequest: unknown;
}
~~~

重连、Turn 结束或 Runtime 通知请求已清除时，Permission Broker 将请求标记为 `invalidated`。旧 `connectionEpoch` 上的响应不得发送给新连接。

## 18.7 Shell 权限匹配

结构化 `executable + args + cwd` 可以参与规则匹配：

~~~ts
interface ShellPermissionRule {
  executable: string;
  argumentPatterns: string[];
  cwdScope: "worktree" | "project";
  executionEnvironmentId: string;
  allowNetwork?: boolean;
}
~~~

原始 Shell 字符串不能通过跨平台的简单分词可靠还原命令语义。对 PowerShell、cmd、Bash 等原始脚本：

- 允许一次性人工审批；
- 可以按完整脚本哈希记忆；
- 不生成宽泛的参数规则；
- 不用关键词包含关系作为安全边界。

## 18.8 全局待处理中心

GUI 顶部显示所有需要用户注意的任务，而不只显示权限：

- 等待审批；
- 等待用户输入；
- 已完成待 Review；
- Runtime/认证失败；
- Worktree 冲突；
- 恢复状态不确定。

支持按项目、Runtime、风险、状态、时间、工具来源和 Session 筛选。

---

# 19. Hooks 系统

## 19.1 双层 Hooks

### Runtime 原生 Hooks

继续由各 Runtime 管理：

- Claude Hooks；
- OpenCode Plugins/Event Hooks；
- 其他 Runtime 原生生命周期机制。

宿主负责：

- 发现；
- 展示配置来源；
- 展示执行日志；
- 展示退出码；
- 展示阻止原因；
- 打开原始配置文件；
- 不把原生配置强制迁移到私有格式。

### 宿主 Hooks

跨 Runtime 通用：

```text
AppStarted
ProjectOpened
ProjectClosed

BeforeWorktreeCreate
AfterWorktreeCreate
BeforeWorktreeRemove
AfterWorktreeRemove

SessionCreated
SessionStarted
SessionIdle
SessionFailed
SessionArchived

BeforePrompt
AfterTurn

PermissionRequested
PermissionApproved
PermissionDenied

WorktreeDirty
BeforeCommit
AfterCommit
BeforeMerge
AfterMerge

RuntimeStarted
RuntimeExited
```

## 19.2 宿主 Hook 定义

```ts
interface HostHookDefinition {
  id: string;
  name: string;
  enabled: boolean;

  scope: "global" | "project" | "runtime";
  scopeId?: string;

  event: HostHookEvent;
  matcher?: Record<string, unknown>;

  action:
    | CommandHookAction
    | ScriptHookAction
    | NotificationHookAction
    | ContextHookAction;

  timeoutMs: number;
  onFailure: "continue" | "warn" | "block";
}
```

## 19.3 示例

```json
{
  "name": "提交前运行测试",
  "scope": "project",
  "event": "BeforeCommit",
  "action": {
    "type": "command",
    "executable": "pnpm",
    "args": ["test"]
  },
  "timeoutMs": 600000,
  "onFailure": "block"
}
```

## 19.4 不得虚构的能力

如果 Runtime 不暴露 `BeforeToolCall`：

- 宿主不能声称可以修改工具参数；
- 只能观察工具后事件或处理 Runtime 发出的原生审批；
- 能力矩阵必须明确标识。

---

# 20. MCP、Skills、Plugins 与子 Agent

## 20.1 原生优先

- Claude 的 MCP、Skills、Plugins、Subagents 由 Claude Runtime 管理；
- Codex 的 MCP、Skills 和 Sandbox 由 Codex 管理；
- OpenCode 的 MCP、Agents、Plugins、LSP 和 Permissions 由 OpenCode 管理。

宿主第一版不开发自己的通用 Skills 执行引擎。

## 20.2 MCP 配置层级

```text
Runtime 全局 MCP
    ↓
用户级 MCP
    ↓
项目级 MCP
    ↓
Session 临时 MCP
```

宿主可以提供统一 MCP 配置浏览器，但最终配置应由 Adapter 转换为 Runtime 支持的格式。

## 20.3 MCP 工具显示

工具卡必须显示：

```text
来源：MCP
Server：github
Tool：create_pull_request
风险：高
输入：...
状态：等待审批
```

## 20.4 Skills 与 Commands

Runtime 启动后动态发现：

- Slash Commands；
- Skills；
- Agents；
- Modes；
- Models。

GUI 可显示统一命令面板，但不得假设每个 Runtime 都有 `/compact`、`/review` 或 `/undo`。

## 20.5 子 Agent 数据模型

```ts
interface AgentNode {
  id: string;
  sessionId: string;
  parentId?: string;

  runtimeType: string;
  nativeAgentId?: string;

  name: string;
  role?: string;

  status:
    | "queued"
    | "running"
    | "waiting"
    | "completed"
    | "failed"
    | "cancelled";

  startedAt?: number;
  completedAt?: number;
}
```

只有 Runtime 明确暴露真实子 Agent 时才创建节点。

---

# 21. 终端与进程管理

## 21.1 PTY

推荐：

```text
node-pty + xterm.js
```

支持：

- PowerShell；
- cmd.exe；
- Git Bash；
- zsh；
- bash；
- fish。

## 21.2 终端类型

```text
用户终端
Runtime 终端
Hook 日志终端
Setup/Cleanup 终端
只读命令输出
```

Agent 原生工具执行产生的命令输出，优先显示 Runtime 结构化事件；只有 Runtime 明确提供 PTY 通道时才接入原生终端。

## 21.3 进程树终止

- Windows：优先使用 Job Object；备用递归进程树终止；
- macOS/Linux：Process Group；
- 子进程启动时尽量创建独立进程组；
- MCP/LSP/Hook/PTY 均登记归属；
- “停止 Session”必须说明会停止哪些进程。

## 21.4 退出策略

```text
优雅取消
→ 等待超时
→ SIGTERM / CTRL_BREAK
→ 再等待
→ 强制终止进程树
```

不得直接第一步就强杀。

---

# 22. 配置、认证与凭据管理

## 22.1 配置层级

~~~text
Runtime 默认配置
    ↓
用户全局配置
    ↓
项目配置
    ↓
Runtime Profile
    ↓
Session 临时覆盖
~~~

Session 覆盖在 Session 结束后失效。所有路径和可执行文件配置均属于某个 Execution Environment。

## 22.2 原生配置继承

### Claude

- `CLAUDE.md`；
- `.claude/`；
- 用户配置；
- Hooks；
- Skills；
- Agents；
- MCP；
- Plugins。

### Codex

- Codex 配置；
- 项目指令；
- Skills；
- MCP；
- Sandbox；
- Approval Policy。

### OpenCode

- `opencode.json`；
- Agents；
- Permissions；
- Plugins；
- MCP；
- LSP；
- Skills；
- Provider 和 Model。

V1 优先继承 Runtime 已有认证，不要求用户把现有 Token、Cookie 或账号密码迁移到宿主。

## 22.3 凭据存储

平台：

- Windows Credential Manager；
- macOS Keychain；
- Linux Secret Service/libsecret。

SQLite 中仅保存：

~~~ts
interface SecretReference {
  provider: "system-keychain";
  key: string;
}
~~~

不得保存：

- 明文 API Key；
- OAuth Refresh Token；
- Claude/OpenAI 登录 Cookie；
- Git 凭据；
- SSH 私钥。

## 22.4 子进程注入

只有 Runtime Profile 明确需要宿主管理的 API Key 时才执行注入：

- Secret 在启动前从凭据库读取；
- 从最小环境变量 Allowlist 构造子进程环境，避免无意继承宿主全部环境；
- 只向需要该 Secret 的 Runtime Handle 注入；
- 不写入命令行参数、数据库、事件或日志；
- 明确提示 Runtime 启动的子进程通常会继承这些环境变量；
- 子进程退出后删除应用层引用，但不承诺 JavaScript 运行时能够对已分配内存做可靠安全擦除；
- 导出诊断包时再次脱敏。

## 22.5 认证状态

Runtime Probe 返回：

~~~ts
type AuthState =
  | "ready"
  | "login_required"
  | "api_key_required"
  | "expired"
  | "permission_denied"
  | "unknown";
~~~

登录操作尽量由 Runtime 自己完成，宿主不收集账号密码。UI 同时显示认证来源：

~~~text
Runtime 原生登录
宿主 Keychain Secret
环境变量
未知 / Runtime 管理
~~~

---

# 23. 数据持久化与数据库设计

## 23.1 技术选择

~~~text
SQLite + Drizzle ORM
WAL 模式
定期备份
关键事件日志 + 当前状态投影 + 受限 Blob Store
~~~

所有数据保存在用户本机。任何数据进入 SQLite、WAL、Blob、日志或备份前都经过同一套脱敏和大小限制。

## 23.2 核心表

~~~text
execution_environments
projects
runtime_installations
runtime_profiles
runtime_capabilities
runtime_handles
sessions
session_turns
session_workspaces
session_events
session_messages
permission_requests
permission_rules
operations
worktrees
git_snapshots
process_records
terminal_sessions
blob_objects
hook_definitions
hook_runs
settings
schema_migrations
~~~

`session_workspaces` 将 Session 与 Worktree/只读目录关联，避免把领域模型永久锁死为严格 1:1，支持后续接管、Fork 和只读 Review。

## 23.3 session_events

~~~sql
CREATE TABLE session_events (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,

  scope TEXT NOT NULL,
  project_id TEXT,
  runtime_handle_id TEXT,
  session_id TEXT,
  turn_id TEXT,

  stream_id TEXT NOT NULL,
  stream_sequence INTEGER NOT NULL,
  session_sequence INTEGER,

  event_type TEXT NOT NULL,
  normalized_payload TEXT NOT NULL,
  native_blob_ref TEXT,

  runtime_type TEXT,
  runtime_event_id TEXT,
  connection_epoch TEXT,

  created_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,

  UNIQUE(stream_id, stream_sequence)
);
~~~

Runtime 原生事件有稳定 ID 时，增加基于 `runtime_handle_id + connection_epoch + runtime_event_id` 的唯一索引。没有稳定 ID 时由 Adapter 生成去重键。

## 23.4 permission_requests

~~~sql
CREATE TABLE permission_requests (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT,

  runtime_handle_id TEXT NOT NULL,
  runtime_request_id TEXT NOT NULL,
  connection_epoch TEXT NOT NULL,

  category TEXT NOT NULL,
  risk TEXT NOT NULL,
  enforcement_level TEXT NOT NULL,
  request_payload TEXT NOT NULL,

  status TEXT NOT NULL,
  decision TEXT,
  decision_scope TEXT,

  requested_at INTEGER NOT NULL,
  resolved_at INTEGER,

  UNIQUE(runtime_handle_id, connection_epoch, runtime_request_id)
);
~~~

`status` 至少支持 `pending/resolved/invalidated/expired`。

## 23.5 operations

`operations` 是外部副作用的恢复事实来源：

~~~text
prepared → running → committed
                  ↘ failed
                  ↘ uncertain
~~~

Worktree 创建/删除、Runtime Session 创建、权限响应、Commit 和 Merge 不能只依赖内存中的 Operation ID。

## 23.6 状态投影

事件日志不可变；当前状态通过投影表或内存模型维护：

~~~text
SessionLifecycleProjection
SessionActivityProjection
SessionHealthProjection
WorkspaceProjection
TurnProjection
ToolProjection
PermissionProjection
SubagentProjection
UsageProjection
AttentionInboxProjection
~~~

文本 Delta 不要求逐 Token 永久保存。最终消息块和关键生命周期事件必须可重建 UI；终端、Diff 和大 Native Payload 进入 Blob Store。

## 23.7 数据库备份

- 每次 Schema Migration 前备份；
- 每日或每 N 次启动备份；
- 保留最近 5～10 个版本；
- 崩溃恢复不覆盖原库；
- Blob 与数据库备份记录一致性版本；
- 提供“导出会话”和“导出诊断包”；
- 备份和诊断包使用与主库相同的脱敏规则。

---

# 24. 桌面端与 Daemon 通信协议

## 24.1 传输

推荐：

~~~text
Windows：Named Pipe
macOS/Linux：Unix Domain Socket
~~~

开发模式可使用随机本地 WebSocket。生产模式优先使用操作系统本地 IPC，不把 TCP 作为默认路径。

## 24.2 本机身份与安全握手

### 操作系统边界

- Windows Named Pipe ACL 只允许当前用户 SID；
- Unix Domain Socket 目录和 Socket 使用仅当前用户可读写权限，并校验 peer credentials；
- Daemon 使用单实例锁和随机 `daemonInstanceId`；
- 拒绝来自其他用户、完整性级别异常或协议不兼容的客户端。

### 启动和重连

首次由 Electron Main 启动 Daemon 时：

- Daemon 生成短期 challenge/高熵 Token；
- Electron Main 通过受控父子进程通道完成握手；
- Renderer 不直接读取 Token；
- Preload 只暴露封装 API。

Daemon 常驻后，GUI 重启通过“当前用户 IPC 权限 + daemonInstanceId + challenge-response”重新认证。只读 discovery 文件最多保存 Pipe/Socket 名称、PID、启动时间和实例 ID，权限仅限当前用户；不把长期明文 Token 写入普通配置文件。如平台仍需要长期 Secret，保存在系统凭据库。

## 24.3 协议风格

使用 JSON-RPC 2.0 或严格 Request/Event Envelope。

请求示例：

~~~json
{
  "jsonrpc": "2.0",
  "id": "req-123",
  "method": "session.create",
  "params": {
    "projectId": "p1",
    "runtimeProfileId": "rp1",
    "writeMode": "isolated-worktree",
    "baseRef": "main"
  }
}
~~~

事件示例：

~~~json
{
  "jsonrpc": "2.0",
  "method": "event",
  "params": {
    "scope": "session",
    "sessionId": "s1",
    "streamId": "daemon-boot-7",
    "streamSequence": 42,
    "sessionSequence": 18,
    "type": "tool.started",
    "payload": {
      "toolCallId": "t1",
      "toolName": "Bash"
    }
  }
}
~~~

所有请求都进行 Schema 校验、大小限制和 Operation ID 校验。事件发送队列有背压和上限；客户端过慢时返回快照恢复指令，而不是无限占用内存。

## 24.4 断线恢复

GUI 重连时发送：

~~~text
lastStreamSequence + knownSnapshotVersion
~~~

Daemon 优先补发缺失的全局事件；若事件已归档或 Stream ID 已变化：

- 返回当前全局快照；
- 返回各打开 Session 的投影快照；
- 再返回快照后的增量事件。

Session 时间线可以使用 `sessionSequence` 局部分页，但连接恢复以 Daemon `streamSequence` 为准。

---

# 25. 崩溃恢复与幂等设计

## 25.1 Daemon 启动恢复流程

~~~text
1. 生成新的 daemonBootId
2. 打开数据库并检查 WAL
3. 读取所有非终态 Operation 和 Session
4. 检查 Worktree 是否存在及 canonical path
5. 检查 Git 状态
6. 使用 PID + 启动时间 + executable + spawnNonce 核对 ProcessRecord
7. 检查 Runtime 连接是否可重建
8. 尝试恢复 Runtime Session
9. 使旧 connectionEpoch 上的审批请求失效
10. 重建事件投影和 Attention Inbox
11. 将不确定状态标记为 RECOVERY_REQUIRED/UNCERTAIN
12. 不自动重放最后 Prompt 或外部副作用
~~~

仅凭 PID 相同不得认定为原进程，也不得自动终止该进程。

## 25.2 Durable Operation

关键操作先写入 `OperationRecord`：

~~~ts
interface OperationEnvelope {
  operationId: string;
  sessionId?: string;
  type: string;
  payload: unknown;
}
~~~

适用于：

- 创建或删除 Worktree；
- 创建 Runtime Session；
- 响应权限；
- Commit；
- Merge/Rebase；
- 更新目标分支。

标准顺序：

~~~text
写 prepared
→ 执行前置检查
→ 写 running
→ 执行外部动作
→ 核对外部事实
→ 写 committed / failed / uncertain
~~~

恢复时以 Git、文件系统和 Runtime 的外部事实核对 Operation，而不是盲目再次执行。

## 25.3 重复权限响应

若权限已解决：

- 相同决策重复提交 → 返回已有结果；
- 冲突决策 → 返回 `ALREADY_RESOLVED`；
- 请求已失效或 Connection Epoch 不匹配 → 返回 `STALE_REQUEST`；
- 不再次调用 Runtime。

## 25.4 危险重放

禁止自动重放：

- Prompt；
- Shell 命令；
- 文件删除；
- Git Push；
- Commit、Merge、Rebase；
- 数据库迁移；
- 发布；
- 外部 API 写操作；
- MCP 写工具。

恢复后由用户选择：

~~~text
继续原 Session
新建 Session 读取当前状态后继续
仅保留 Worktree
导出 Patch 后放弃任务
~~~

---

# 26. 安全架构与威胁模型

## 26.1 主要威胁

1. 恶意仓库通过 Prompt Injection 诱导 Agent 执行危险命令；
2. Runtime 或插件读取项目外文件；
3. MCP Server 窃取凭据；
4. Shell 命令逃逸 Worktree；
5. Renderer XSS 获得 Node 权限；
6. 本地服务被同机其他用户或进程调用；
7. Native Event、日志、WAL 或诊断包泄露 API Key；
8. 恶意 Hook、Git Hook、Credential Helper 或签名程序；
9. Worktree 清理误删代码；
10. Runtime 更新导致协议变化；
11. 终端输出包含恶意控制序列；
12. Diff Viewer 渲染恶意内容；
13. PID 复用导致错误终止无关进程；
14. 用户误解“本地数据”与模型 Provider 数据出口的区别。

## 26.2 Electron 安全

必须：

~~~text
contextIsolation: true
nodeIntegration: false
sandbox: true（可行范围内）
启用严格 CSP
禁止 remote module
Preload 最小 API
校验全部 IPC 参数
限制导航和新窗口
~~~

Markdown、Mermaid、ANSI、文件名、Diff 和 Native Event 均视为不可信输入。渲染前净化，外部链接和新窗口必须走受控处理。

## 26.3 本地服务

- 优先 Named Pipe/Unix Socket；
- 使用当前用户 ACL/权限和 peer identity；
- 如使用 TCP，只绑定 `127.0.0.1`；
- 随机端口和高熵 Token；
- 严格 Origin；
- 不使用固定默认密码；
- Daemon 退出时关闭监听；
- discovery 文件不保存长期明文 Secret。

## 26.4 隔离等级

~~~ts
type IsolationProfile =
  | "runtime_native"
  | "os_sandbox"
  | "container"
  | "worktree_only"
  | "none";
~~~

UI 必须显示当前 Isolation Profile。Job Object 和 Process Group 只负责生命周期治理，不限制文件或网络；Worktree 只隔离代码目录，不阻止 Runtime 访问其他路径。

## 26.5 文件边界

宿主自己执行的文件和 Git 操作必须：

- Canonicalize；
- 处理符号链接；
- 处理 Windows Junction；
- 检查路径是否仍在允许根目录；
- 防止 `../`；
- 防止大小写差异绕过；
- 验证 Execution Environment；
- 外部目录访问单独审批。

这些检查只约束宿主操作。Runtime 子进程能否越界必须依靠 Runtime Sandbox、OS Sandbox 或容器；如果没有，能力显示为 `worktree_only`，不得宣传为安全隔离。

## 26.6 持久化前脱敏

自动匹配并替换：

- API Key；
- Bearer Token；
- Cookie；
- Authorization Header；
- SSH Key；
- 常见云凭据；
- 用户定义 Secret。

脱敏必须发生在 SQLite/WAL、Blob、Pino 日志和诊断包之前。大对象先限流再脱敏，避免通过超大 Native Payload 或终端输出耗尽内存和磁盘。

## 26.7 供应链

- 锁定依赖版本；
- 生成 SBOM；
- 安装包签名；
- 自动更新签名验证；
- Runtime 托管安装必须校验哈希；
- V1 不自动安装未知 ACP Runtime；
- 明确记录 bundled binary、native addon 和 Runtime 的来源与许可证。

---

# 27. 资源治理

## 27.1 限制项

```text
最大同时活跃 Runtime
最大同时 RUNNING Turn
单 Runtime 内存警告
总内存警告
CPU 持续高负载警告
空闲 Runtime 回收时间
最大终端缓冲
最大日志体积
最大 Session 事件数
```

## 27.2 默认建议

```text
最大并行活跃 Turn：3
最大驻留 Runtime：6
空闲回收：15～30 分钟
单 Session 终端缓冲：10～50 MB
单 Session 原始日志：100～500 MB 滚动
```

这些值应可配置，不作为安全硬限制。

## 27.3 Runtime 驻留

状态：

```text
ACTIVE
IDLE_RESIDENT
SUSPENDING
STOPPED_RESUMABLE
```

停止 Runtime 不等于删除 Session。只要 Runtime 支持恢复，用户可以以后继续。

---

# 28. GUI 信息架构与页面设计

## 28.1 全局布局

~~~text
┌──────────────────────────────────────────────────────────────────┐
│ 项目 / 当前分支 / Runtime 状态 / 待处理事项 / 新建 Session       │
├────────────────┬──────────────────────────┬──────────────────────┤
│ Projects       │ Agent Timeline           │ Inspector            │
│ Sessions       │                          │                      │
│                │ User Message             │ Plan                 │
│ Project A      │ Assistant                │ Changed Files        │
│ ├ OpenCode     │ Tool Calls               │ Diff                 │
│ ├ Codex        │ Permissions              │ Isolation / Usage    │
│ └ Claude*      │ Hook Results             │ Native Detail        │
├────────────────┴──────────────────────────┴──────────────────────┤
│ Terminal / Logs / Problems / Hooks / Processes                  │
└──────────────────────────────────────────────────────────────────┘
~~~

`Claude*` 为后续版本能力。V1 UI 不展示尚未实现的可操作入口。

## 28.2 核心页面

### Home / Projects

- 最近项目；
- Execution Environment；
- Runtime 健康和认证状态；
- 活跃 Session；
- 待处理事项；
- 快速创建任务。

### Attention Center

统一呈现：

- 等待权限；
- 等待用户输入；
- 已完成待 Review；
- Runtime/认证失败；
- Worktree 冲突；
- 恢复状态不确定。

支持风险、状态、项目、Runtime、Session 和时间筛选。Permission 规则与审计作为其中的权限子页，不再让“全局审批”成为唯一入口。

### Project Workspace

- 项目概览；
- Session 列表；
- Branch/Worktree；
- Runtime Profiles；
- Execution Environment；
- 项目 Hooks（后续）；
- 项目 MCP（后续）；
- Setup/Cleanup。

### Session

- 对话时间线；
- 工具卡；
- 权限卡；
- Plan/Todo；
- 文件变化；
- Diff；
- 子 Agent（Runtime 支持时）；
- 终端；
- Token/费用/上下文；
- Isolation Profile；
- Runtime 专属面板。

### Runtime Manager

- 自动发现；
- Execution Environment；
- 版本；
- 路径；
- 认证状态和来源；
- Runtime/Provider 数据出口；
- 能力和 Enforcement Level；
- Provider/Model；
- 启动测试；
- 更新提示；
- 原生日志。

### Settings

- 通用；
- 外观；
- Git；
- Worktree；
- 权限；
- Runtime；
- MCP；
- Hooks；
- 资源；
- 凭据；
- 日志和隐私。

## 28.3 新建 Session 对话框

~~~text
项目：[my-project]
执行环境：[Windows Native ▼]

Runtime：[OpenCode ▼]
Provider：[DeepSeek ▼]
Model：[Runtime 动态返回 ▼]
Mode：[Build / Plan / Runtime-specific ▼]

Base Branch：[main ▼]
工作目录：
● 独立 Worktree
○ 当前目录（高风险）
○ 只读分析

隔离：
Runtime Sandbox：[Runtime 返回]
宿主可审批范围：[命令 / 文件 / 网络 / 未知]
模型数据出口：[DeepSeek Provider · Runtime 直连]

权限：[标准模式 ▼]
配置：
☑ 继承 Runtime 原生配置
☑ 运行已批准的 Worktree Setup

任务：...

[创建并启动]
~~~

## 28.4 Tool Card

显示：

- Tool 名；
- 来源；
- 输入摘要；
- cwd 和 Execution Environment；
- Enforcement Level；
- 权限状态；
- 开始和结束时间；
- 退出码；
- 输出；
- 关联文件；
- Native Detail。

当能力为 `observable_only` 或 `opaque` 时，必须明确显示“宿主不能阻止”或“宿主不可完全观测”。

## 28.5 Diff Inspector

标签：

~~~text
Files | Working | Staged | Commits | Conflicts
~~~

Windows Alpha：

- 查看文件和 Diff；
- 打开外部编辑器；
- Commit。

可发布 V1 再启用：

- Stage；
- Unstage；
- 带恢复快照的 Revert；
- Integration Worktree Merge。

---

# 29. 核心用户流程

## 29.1 首次启动

~~~text
1. 启动 GUI
2. 启动或连接 Daemon
3. 建立 Windows Native Execution Environment
4. 扫描 OpenCode、Codex 和 Git
5. 显示安装、认证、能力和数据出口
6. 用户选择项目
7. 验证项目与 Runtime 的执行环境
8. Runtime Probe
9. 完成初始设置
~~~

Claude、ACP、WSL、macOS 和 Linux 在对应阶段启用后再加入扫描。

## 29.2 创建 OpenCode + DeepSeek 任务

~~~text
1. 选择项目和 Execution Environment
2. 新建 Session
3. Runtime = OpenCode
4. Provider = DeepSeek
5. Model = Runtime 返回模型
6. 展示数据出口和 Isolation Profile
7. Base = main
8. 创建 Worktree Operation
9. 启动 Worktree Scope OpenCode Server
10. 建立独立事件订阅
11. 创建 OpenCode Session
12. startTurn 发送 Prompt
13. 按 Session/Turn 关联流式事件
14. 处理 Runtime 暴露的权限请求
15. Agent 完成 Turn，Session Activity 回到 IDLE
16. 查看 Diff
17. Commit / 继续对话
~~~

## 29.3 创建 Codex 任务

~~~text
1. 检查或启动 app-server
2. 完成 initialize/initialized
3. 创建 Host Session 和 Worktree
4. 创建 Codex Thread
5. 建立 Handle 级事件读取器
6. startTurn
7. 按 Thread/Turn/Item 关联通知
8. 处理 Runtime Approval
9. Turn 完成后 Activity 回到 IDLE
~~~

## 29.4 创建 Claude 任务（后续版本）

根据 Runtime Profile：

~~~text
原生模式：启动本机 Claude Runtime/Adapter
SDK 模式：使用 API Key 初始化 Agent SDK
~~~

原生模式与 SDK 模式分别 Probe、分别显示认证来源和能力，不作为可发布 V1 的阻塞项。

## 29.5 合并任务

~~~text
1. Agent Turn 空闲
2. 刷新 Git 状态
3. 检查未提交改动并 Commit
4. 写入 Merge Operation
5. 创建临时 Integration Worktree
6. 获取目标分支最新状态
7. Rebase/Merge 并检测冲突
8. 运行用户选择的验证
9. 用户确认
10. 更新目标分支
11. 标记 Worktree 已合并
12. 安全清理 Integration Worktree
~~~

不得默认直接在用户主工作区执行 Merge。

## 29.6 Runtime 崩溃

~~~text
1. Supervisor 收到退出
2. 保存 RuntimeExited Event
3. Session.health = INTERRUPTED_RUNTIME
4. 保留 Session.lifecycle、Activity 历史和 Workspace State
5. 使旧 Connection Epoch 的审批失效
6. 核对 Runtime Session 是否可 Resume
7. Attention Center 显示恢复选项
8. 不自动重发最后 Prompt
~~~

用户可以选择：恢复原 Session、新 Session 接管、仅保留代码、导出 Patch 后放弃。

---

# 30. 推荐技术栈

## 30.1 Monorepo

- pnpm workspace；
- Turborepo；
- TypeScript strict mode；
- ESLint；
- Prettier；
- Changesets。

## 30.2 桌面端

- Electron；
- Vue 3；
- Vite；
- Pinia；
- Vue Router；
- Tailwind CSS；
- Monaco Editor / Monaco Diff Editor；
- xterm.js；
- Shiki；
- Floating UI；
- VueUse。

## 30.3 Daemon

- Node.js LTS；
- TypeScript；
- Zod；
- Pino；
- execa；
- node-pty；
- chokidar；
- proper-lockfile 或 OS 级单实例锁；
- undici；
- ws（仅开发或必要场景）。

## 30.4 数据

- SQLite；
- better-sqlite3；
- Drizzle ORM；
- WAL；
- JSON Schema/Zod Migration。

## 30.5 Git

- 系统 Git CLI；
- 参数数组执行；
- 自研有限 Git Service；
- 不把 simple-git 作为核心抽象边界，可用于低风险封装。

## 30.6 测试

- Vitest；
- Playwright；
- Electron Playwright；
- Fake Runtime；
- 临时 Git 仓库 Fixture；
- V1 使用 Windows x64 CI；后续每增加一种 Execution Environment 再加入对应平台 CI。

---

# 31. Monorepo 目录结构

```text
local-agent-workspace/
├── apps/
│   ├── desktop/
│   │   ├── electron-main/
│   │   ├── preload/
│   │   └── renderer/
│   │
│   └── daemon/
│       ├── bootstrap/
│       ├── ipc/
│       ├── services/
│       └── workers/
│
├── packages/
│   ├── protocol/
│   ├── domain/
│   ├── shared/
│   ├── database/
│   ├── event-store/
│   │
│   ├── runtime-core/
│   ├── adapter-claude/
│   ├── adapter-codex/
│   ├── adapter-opencode/
│   ├── adapter-acp/
│   │
│   ├── session-orchestrator/
│   ├── process-supervisor/
│   ├── permission-broker/
│   ├── host-hooks/
│   ├── project-manager/
│   ├── worktree-manager/
│   ├── git-service/
│   ├── terminal-service/
│   ├── credential-service/
│   ├── recovery-manager/
│   └── observability/
│
├── tests/
│   ├── fixtures/
│   │   ├── fake-runtime/
│   │   ├── fake-acp-agent/
│   │   └── git-repositories/
│   ├── contract/
│   ├── integration/
│   ├── recovery/
│   └── e2e/
│
├── tooling/
│   ├── eslint/
│   ├── typescript/
│   └── build/
│
├── pnpm-workspace.yaml
├── turbo.json
└── package.json
```

## 31.1 禁止出现的结构

避免把所有东西放入：

```text
src/services/
src/utils/
src/helpers/
```

这些目录只能放真正跨领域、边界明确的功能，否则会迅速成为无结构垃圾桶。

---

# 32. 实施 TODO 与里程碑

本章是项目实施的唯一主 TODO。架构说明、测试体系和 V1 验收标准仍分别以其他章节为准。

执行规则：

- 所有任务初始状态均为未完成；
- 每个任务都有唯一编号、前置依赖、交付物和可验证的 Checkpoints；
- 只有全部 Checkpoint 通过后，才能勾选任务本身；
- Gate 是进入下一阶段的硬门槛，关键 Spike 未通过时必须回到架构决策；
- V1 任务完成率只统计 T0.* 至 T5.*，B1 至 B3 后续任务池不计入；
- V1 Ready 还要求 G0 至 G5 和第 37 章发布检查全部通过。

## 阶段 0：关键技术 Spike

目标：验证最可能推翻架构的前提，不构建正式产品功能。

### T0.1 OpenCode 协议 Spike

- [x] 完成 OpenCode 协议与 Provider 可行性验证
- 前置依赖：无（项目起点）
- 交付物：Spike 报告、协议 Fixture、Capability/Enforcement 快照
- Checkpoints：
  - [x] Worktree Scope Server 能在指定 Windows Native 项目目录启动和停止
  - [x] SDK 控制命令与 SSE 事件可独立消费，并能关联 Session 与 Turn
  - [x] Permission、Cancel、Resume 的实际支持范围有可重复验证记录
  - [x] DeepSeek Provider 可完成一次真实请求，数据出口与认证来源可识别
  - [x] Server 崩溃后可枚举恢复信息，无法恢复的状态被明确记录

### T0.2 Codex app-server Spike

- [x] 完成 Codex app-server 协议与审批能力验证
- 前置依赖：无（可与 T0.1 并行）
- 交付物：Spike 报告、版本锁定 Schema、JSON-RPC Fixture
- Checkpoints：
  - [x] initialize/initialized 和认证状态探测可重复执行
  - [x] Thread、Turn、Item 生命周期能映射到宿主标识
  - [x] 每个 Runtime Handle 都有独立事件读取器，不发生跨 Session 争抢
  - [x] Command、File、Network Approval 的可拦截范围有实测记录
  - [x] Interrupt、Resume 以及安装版本对应 Schema Hash 均通过验证

### T0.3 Windows 本机控制面 Spike

- [x] 完成 Windows 进程、IPC、PTY 和 Git 基础能力验证
- 前置依赖：无（可与 T0.1、T0.2 并行）
- 交付物：Windows Spike 报告、最小验证程序、失败案例记录
- Checkpoints：
  - [x] Named Pipe 使用当前用户 ACL，GUI 可重连常驻 Daemon
  - [x] Job Object 能终止目标进程树且不会终止已发生 PID 复用的无关进程
  - [x] node-pty 可随 Windows x64 应用打包并完成交互命令
  - [x] 短路径 Worktree 与 Windows 原生 Git 可完成创建、状态读取和清理
  - [x] GUI、Daemon、Runtime 分别强杀后的状态均有可解释结果

### T0.4 ADR 与 Adapter Contract 基线

- [x] 固化 Spike 结论和首版 Adapter 合同
- 前置依赖：T0.1、T0.2、T0.3
- 交付物：ADR、Adapter Contract、兼容性矩阵、Contract Fixture
- Checkpoints：
  - [x] 控制命令、Handle 事件流和 Runtime Scope 事件边界已写入 ADR
  - [x] interceptable、observable_only、opaque 和 unknown 的判定规则已固化
  - [x] OpenCode 与 Codex Fixture 均能被同一 Contract Test Harness 读取
  - [x] 未验证能力均标为 unknown，未进入 Alpha 或 V1 承诺
  - [x] 任何会推翻当前架构的 Spike 失败都有明确决策结论

### G0 阶段 0 Gate

- [x] 关键技术前提已通过，可以进入宿主骨架开发
- 前置依赖：T0.1、T0.2、T0.3、T0.4
- 交付物：阶段 0 Gate 报告
- Checkpoints：
  - [x] T0.1 至 T0.4 全部完成
  - [x] 两种 Runtime 均证明控制命令与事件流可以分离
  - [x] 权限能力矩阵覆盖可拦截、仅观察、不可见和未知状态
  - [x] GUI、Daemon、Runtime 崩溃验证没有未解释的数据破坏
  - [x] ADR、Schema 和 Fixture 已进入版本控制并可在 CI 中校验

## 阶段 1：宿主骨架与 Fake Runtime

### T1.1 Monorepo 与进程边界

- [x] 建立可运行的 Monorepo 和桌面进程拓扑
- 前置依赖：G0
- 交付物：Monorepo、Electron Desktop、独立 Daemon 启动骨架
- Checkpoints：
  - [x] Desktop、Daemon、共享协议和测试包的依赖方向符合第 31 章
  - [x] Renderer 不启用 Node Integration，并通过受限 Preload API 通信
  - [x] Desktop 可启动、检测和停止指定版本的 Daemon
  - [x] Renderer 崩溃不会直接终止 Daemon

### T1.2 Named Pipe IPC 与 Daemon 生命周期

- [x] 实现本机 IPC、握手、重连和请求校验
- 前置依赖：T1.1、T0.3
- 交付物：IPC 协议实现、握手状态机、协议兼容测试
- Checkpoints：
  - [x] Named Pipe 限制为当前用户并验证 Peer Identity
  - [x] daemonInstanceId、challenge-response 和协议版本握手可验证
  - [x] GUI 断线后能重新订阅快照和增量事件
  - [x] 非法参数、旧连接和不兼容协议均被拒绝并记录

### T1.3 领域模型与 SQLite 持久化

- [x] 实现核心领域模型、数据库和状态投影
- 前置依赖：T1.1、T0.4
- 交付物：数据库 Schema、Migration、Repository 和投影层
- Checkpoints：
  - [x] ExecutionEnvironment、Project、HostSession、HostTurn、Worktree 和 ProcessRecord 可持久化
  - [x] OperationRecord、session_events、permission_requests 和 Blob 引用可持久化
  - [x] Lifecycle、Activity、Health、Workspace State 可独立投影
  - [x] Migration 可在空库和上一版测试库上重复验证
  - [x] Secret 字段不会写入 SQLite、WAL 或 Blob

### T1.4 Fake Runtime 与统一事件系统

- [x] 实现可脚本化 Fake Runtime 和事件标准化管线
- 前置依赖：T1.2、T1.3、T0.4
- 交付物：Fake Runtime、Event Normalizer、Adapter Contract Test Harness
- Checkpoints：
  - [x] 可创建多个 Session 并流式输出文本、工具调用和用户输入请求
  - [x] 可模拟重复、乱序、断线、背压、未知事件和 Runtime Scope 事件
  - [x] Connection Epoch 能阻止旧事件或旧响应改变当前状态
  - [x] 未知事件在脱敏和限额后保留，且不会阻断已知事件
  - [x] 不支持事件补发时可通过 Snapshot Recovery 恢复可解释状态

### T1.5 Permission Broker、Attention Center 与基础 UI

- [x] 实现基础权限流和待处理工作台
- 前置依赖：T1.3、T1.4
- 交付物：Permission Broker、Attention Center、Session 页面、Tool/Permission Card
- Checkpoints：
  - [x] Runtime 权限请求可显示类别、风险、范围和 Enforcement Level
  - [x] 一次允许、Session 允许、项目规则和拒绝均可审计
  - [x] Attention Center 可显示等待权限、等待输入、完成、失败和恢复不确定状态
  - [x] GUI 重启后历史和待处理事项仍可恢复
  - [x] Renderer 崩溃不影响 Daemon 或 Fake Runtime 的活动 Session

### G1 阶段 1 Gate

- [x] 宿主骨架和 Fake Runtime 已达到可集成状态
- 前置依赖：T1.1、T1.2、T1.3、T1.4、T1.5
- 交付物：阶段 1 集成测试报告
- Checkpoints：
  - [x] T1.1 至 T1.5 全部完成
  - [x] 至少三个 Fake Session 可并行运行且事件路由无串线
  - [x] 重复、乱序、断线、未知事件和旧 Epoch 场景全部通过
  - [x] GUI 重启和 Renderer 崩溃场景不丢历史与待处理事项
  - [x] IPC、数据库和 Renderer 基础安全测试通过

## 阶段 2：Project 与 Worktree

### T2.1 Execution Environment 与 Project Manager

- [x] 实现 Windows Native 环境和项目管理
- 前置依赖：G1
- 交付物：Execution Environment Registry、Project Manager、Git 探测器
- Checkpoints：
  - [x] 可添加、移除和重新探测本地 Git 项目
  - [x] Windows Native Git 路径、版本和能力可记录
  - [x] Project、Git、Runtime 与 Worktree 的环境一致性会被强制检查
  - [x] Windows/WSL 路径或可执行文件混用会被明确拒绝

### T2.2 Worktree 生命周期与 Durable Operation

- [x] 实现安全、可恢复的 Worktree 创建和清理
- 前置依赖：T2.1、T1.3
- 交付物：Worktree Manager、Durable Operation 状态机、恢复 Fixture
- Checkpoints：
  - [x] Worktree Root 可配置并经过路径边界校验
  - [x] 创建流程记录 base commit、分支、环境和 Operation 状态
  - [x] 创建或清理过程中强杀 Daemon 后进入 committed、failed 或 uncertain
  - [x] 存在未提交或未跟踪文件时默认拒绝自动删除
  - [x] 错误 PID 或失效 ProcessRecord 不会触发无关进程终止

### T2.3 Setup、Cleanup 与 Workspace Binding

- [x] 实现项目初始化、清理和 Session 工作区绑定
- 前置依赖：T2.2
- 交付物：Setup/Cleanup 执行器、Workspace Binding、审计记录
- Checkpoints：
  - [x] 结构化命令与显式授权 Shell 的执行路径能够区分
  - [x] Setup 失败会保留可诊断状态，不自动删除含代码的 Worktree
  - [x] 每个可写 Session 默认绑定独立 Worktree
  - [x] 归档后仍能定位 Session、Commit、Worktree 和清理状态

### T2.4 Git Status 与 Diff 服务

- [x] 实现以 Git CLI 为事实来源的状态和 Diff
- 前置依赖：T2.1、T2.2、T2.3
- 交付物：Git Service、Diff Service、Git 集成测试
- Checkpoints：
  - [x] 文件列表、Working Diff、Staged Diff 和 Session Commit Diff 可生成
  - [x] Rename、二进制文件、超大文件和未跟踪文件有明确降级显示
  - [x] 脏主工作区不会被 Session 操作污染
  - [x] Git 命令使用结构化参数，不通过原始 Shell 字符串拼接

### G2 阶段 2 Gate

- [x] Project、Worktree 和 Git 基础闭环已通过
- 前置依赖：T2.1、T2.2、T2.3、T2.4
- 交付物：阶段 2 Git 与恢复测试报告
- Checkpoints：
  - [x] T2.1 至 T2.4 全部完成
  - [x] 三个 Fake Session 可在三个 Worktree 并行修改且主工作区不受影响
  - [x] 创建与清理强杀恢复场景不丢失未提交代码
  - [x] 路径穿越、Junction 逃逸和跨环境混用测试通过
  - [x] Worktree 强制删除保护和 Git 边界测试通过

## 阶段 3：OpenCode Windows Alpha

### T3.1 OpenCode 发现、启动与 Provider

- [x] 实现 OpenCode Runtime 生命周期和 Provider 配置
- 前置依赖：G2、T0.1
- 交付物：OpenCode Adapter、Runtime Profile、Provider/Model 选择器
- Checkpoints：
  - [x] 可自动发现并 Probe OpenCode 路径、版本和认证来源
  - [x] 每个工作区可启动和停止独立 Worktree Scope Server
  - [x] Provider 数据出口在启动前清晰展示
  - [x] DeepSeek Provider 可完成真实会话且 API Key 不进入参数、日志或数据库

### T3.2 OpenCode Session、Turn 与 SSE

- [x] 实现 OpenCode 会话控制和事件消费
- 前置依赖：T3.1、T1.4
- 交付物：Session/Turn 映射、SSE 消费器、事件 Fixture
- Checkpoints：
  - [x] Create、Resume Session 和 Start Turn 可稳定执行
  - [x] SSE 事件可映射文本、工具、权限、完成和错误状态
  - [x] 多 Session 不争抢底层事件读取器且 Runtime Scope 事件不丢失
  - [x] 断线后可重新 Probe、恢复快照并建立新 Connection Epoch

### T3.3 OpenCode 权限、控制与恢复

- [x] 实现权限透传、Cancel、Resume 和崩溃恢复
- 前置依赖：T3.2、T1.5
- 交付物：权限映射、控制命令、恢复策略和合同测试
- Checkpoints：
  - [x] 每项权限请求显示 Runtime 实际 Enforcement Level
  - [x] Cancel 和 Resume 不依赖重放原始 Prompt
  - [x] 旧 Epoch 权限请求无法在恢复后被响应
  - [x] OpenCode Server 崩溃不会影响其他 Runtime Handle
  - [x] 不可恢复状态会显示失败或 uncertain，而不是伪装为运行中

### T3.4 OpenCode Alpha 用户闭环

- [x] 完成 OpenCode Windows Alpha UI 与 E2E
- 前置依赖：T3.2、T3.3、T2.4
- 交付物：Alpha UI、Diff/Commit/Archive 流程、E2E 报告
- Checkpoints：
  - [x] 用户可完成“项目 → Worktree → OpenCode + DeepSeek → 修改”
  - [x] Attention Center 可处理权限、输入、完成和失败事项
  - [x] 用户可 Review Diff、Commit、归档并安全清理
  - [x] Alpha 不展示尚未实现的 Merge、Claude、ACP 或跨平台可操作入口
  - [x] Windows Alpha E2E 在干净环境中可重复通过

### G3 阶段 3 Gate

- [x] OpenCode Windows Alpha 可以交付试用
- 前置依赖：T3.1、T3.2、T3.3、T3.4
- 交付物：Alpha Gate 报告、已知问题列表
- Checkpoints：
  - [x] T3.1 至 T3.4 全部完成
  - [x] DeepSeek 真实请求、权限处理、Diff、Commit 和归档闭环通过
  - [x] Runtime、Daemon、GUI 分别崩溃后的恢复行为通过
  - [x] API Key、Native Event 和日志脱敏测试通过
  - [x] 未验证能力均保持 unknown 或不可操作状态

## 阶段 4：Codex 与可发布 V1

> Codex-first 实施顺序：依据 ADR-0002，在 OpenCode 暂缓期间，T4.1 可由 G2 与 T0.2 解锁，继而按依赖执行 T4.2、T4.3。T3/G3、T4.4、T4.5 与 G4 的完成标准不变，仍保持未完成。

### T4.1 Codex app-server 生命周期与认证

- [x] 实现 Codex 发现、启动、初始化和认证探测
- 前置依赖：G2、T0.2
- 交付物：Codex Adapter、Schema 锁定流程、认证状态 UI
- Checkpoints：
  - [x] 可发现 Codex 路径、版本、认证来源和兼容性状态
  - [x] app-server initialize/initialized 可按版本 Schema 校验
  - [x] Runtime Handle 启停、异常退出和重新 Probe 可审计
  - [x] 高于 maxTestedVersion 时进入未验证版本降级策略

### T4.2 Codex Thread、Turn、Item 与 Approval

- [x] 实现 Codex 会话协议和审批事件映射
- 前置依赖：T4.1、T1.4、T1.5
- 交付物：Thread/Turn/Item 映射、Approval Broker、合同 Fixture
- Checkpoints：
  - [x] Thread、Turn、Item 可映射到 HostSession、HostTurn 和 Host Event
  - [x] Command、File、Network Approval 显示真实 Enforcement Level
  - [x] Interrupt、Resume 和旧 Epoch 失效行为通过合同测试
  - [x] 未知 Item/Event 在脱敏限额后可诊断且不阻断会话
  - [x] 多 Thread 事件不会串线或重复应用

### T4.3 Codex 原生能力展示

- [x] 展示并保留 Codex 配置、MCP、Skills 和 Sandbox 能力
- 前置依赖：T4.1、T4.2
- 交付物：Capability Probe、Runtime 专属面板、降级规则
- Checkpoints：
  - [x] MCP、Skills、Sandbox 和认证来源按 Probe 结果展示
  - [x] supported、experimental、degraded、unsupported 和 unknown 可区分
  - [x] 宿主不会覆盖或虚构 Codex 原生安全能力
  - [x] Runtime 专属能力不会被错误提升为公共 Adapter 能力

### T4.4 V1 Git 操作与 Integration Worktree Merge

- [x] 实现 V1 Review、Stage、Revert 和安全合并流程
- 前置依赖：T2.4、T3.4
- 交付物：Stage/Unstage、恢复快照 Revert、Integration Worktree Merge
- Checkpoints：
  - [x] Stage、Unstage、Commit 和 Session Commit Diff 可审计
  - [x] Revert 前创建恢复快照，失败时不会静默丢代码
  - [x] Merge 默认在 Integration Worktree 验证，不直接修改主工作区
  - [x] 冲突会进入 Attention Center，并支持打开外部编辑器处理
  - [x] Merge、Rebase、Submodule 和签名程序场景有集成测试

### T4.5 OpenCode/Codex 双 Runtime 闭环

- [x] 完成双 Runtime 并行稳定性和 V1 E2E
- 前置依赖：T3.4、T4.2、T4.3、T4.4
- 交付物：双 Runtime E2E、并发与隔离测试报告
- Checkpoints：
  - [x] 同一项目可同时运行 OpenCode 与 Codex 的独立 Session
  - [x] 两个 Runtime 使用不同 Worktree 且共享统一 Attention Center
  - [x] 两份 Diff 可分别 Review、Commit 并在 Integration Worktree 合并
  - [x] 任一 Runtime 崩溃不影响另一 Runtime 的控制与事件流
  - [x] 至少三个并行 Session 在持续测试中无事件串线和代码污染

### G4 阶段 4 Gate

- [x] 功能完整度达到可发布 V1 候选
- 前置依赖：T4.1、T4.2、T4.3、T4.4、T4.5
- 交付物：V1 功能 Gate 报告
- Checkpoints：
  - [x] T4.1 至 T4.5 全部完成
  - [x] OpenCode 与 Codex Adapter Contract Tests 全部通过
  - [x] 双 Runtime E2E、Git 集成和权限测试全部通过
  - [x] Claude、ACP、WSL、macOS 和 Linux 均未成为 V1 阻塞项
  - [x] 所有实验、降级和未知能力在 UI 中表达准确

## 阶段 5：Windows V1 稳定性

### T5.1 常驻 Daemon 与崩溃恢复

- [x] 完成 Daemon 常驻、重连、幂等和进程恢复
- 前置依赖：G4
- 交付物：Recovery Manager、重连协议、故障注入报告
- Checkpoints：
  - [x] GUI 退出后按用户策略保留或停止 Daemon，重新启动可安全握手
  - [x] Runtime、Worktree、Commit、Merge 和清理操作均有 Durable Operation 恢复结果
  - [x] 危险操作不会因重连或重启被自动重放
  - [x] ProcessRecord 完整身份可识别 PID 复用
  - [x] GUI、Daemon、Runtime 强杀矩阵全部通过且状态可解释

### T5.2 安全、权限规则与凭据

- [x] 完成 V1 安全收敛和凭据生命周期
- 前置依赖：T5.1、T4.2
- 交付物：安全测试报告、Credential Broker、权限规则审计
- Checkpoints：
  - [x] 凭据存入操作系统凭据库并仅按 Secret Reference 注入指定 Runtime
  - [x] Secret 不进入 Renderer、命令行参数、SQLite/WAL/Blob、日志或诊断包
  - [x] 原始 Shell 字符串不会生成宽泛持久 Allow 规则
  - [x] 路径穿越、Junction、IPC、XSS、ANSI、Markdown 和 MCP 注入测试通过
  - [x] observable_only、opaque 和 Worktree 隔离不会被描述成安全沙箱

### T5.3 资源治理、日志、诊断与性能

- [x] 完成资源限制、可观测性和性能基线
- 前置依赖：T5.1、T5.2
- 交付物：资源治理策略、结构化日志、诊断包、性能报告
- Checkpoints：
  - [x] Runtime、PTY、事件、Blob、Diff 和日志均有大小或资源上限
  - [x] 所有持久化 Sink 之前执行脱敏、截断和不可信内容处理
  - [x] 诊断包默认不包含源码、完整 Prompt、Raw Payload 或凭据
  - [x] 用户明确勾选敏感内容时再次脱敏并显示预计文件大小
  - [x] 三个并行 Session 的启动、流式事件和 Diff 性能达到已记录基线

### T5.4 数据迁移、安装、升级与回滚

- [x] 完成 Windows x64 发布工程
- 前置依赖：T5.1、T5.2、T5.3
- 交付物：NSIS 安装包、分级签名策略、Migration、更新与回滚流程
- Checkpoints：
  - [x] Windows x64 可完成安装、升级、卸载和重新安装
  - [x] Desktop 与 Daemon 有独立版本并在更新前检查协议兼容性
  - [x] 数据库 Migration 前自动备份，失败时保留可恢复副本
  - [x] Local V1 通过 SHA-256、Ed25519 Release Manifest 与来源验证；Verified Publisher 通道另要求 Authenticode
  - [x] 回滚应用版本时能识别并阻止不兼容数据库降级

### T5.5 V1 回归与发布候选

- [x] 生成并验证 Windows V1 Release Candidate
- 前置依赖：T5.1、T5.2、T5.3、T5.4
- 交付物：Release Candidate、兼容性矩阵、回归报告、已知问题
- Checkpoints：
  - [x] Adapter Contract、Git、Recovery、安全和 E2E 测试在 Windows x64 CI 全部通过
  - [x] OpenCode 与 Codex 支持版本、Schema Hash 和 knownIssues 已锁定
  - [x] 从上一测试版本升级到 Release Candidate 后历史和 Worktree 可恢复
  - [x] 安装、更新、崩溃恢复和回滚均在干净 Windows 环境复验
  - [x] 第 37 章每项发布检查均有测试记录或可审计证据

### T5.6 可交互产品闭环纠正

- [x] 将工程 Fixture UI 接通为可实际操作的 Codex 本地工作台
- 前置依赖：T5.5
- 交付物：交互 Workspace Controller、Codex app-server Client、真实请求 Probe、UI/E2E 测试与纠正报告
- Checkpoints：
  - [x] 普通模式可通过原生目录选择器添加本地 Git 项目并只在本机保存项目状态
  - [x] 新建 Session 时从固定 HEAD 创建独立 Git Worktree，不直接修改用户主工作区
  - [x] 可发现并启动真实 Codex app-server，创建/恢复 Thread、发送 Turn、流式显示文本并支持 Interrupt
  - [x] Command、File 与 Network Approval 可显示实际范围并由用户允许一次或拒绝
  - [x] 可查看 Worktree 文件状态和 Diff，并实际执行 Stage、Unstage 与 Commit
  - [x] Prompt 不写入 Workspace 状态文件；真实 Provider Probe 在隔离仓库完成且公开 CI 无需凭据
  - [x] 普通模式不再展示 Fake Runtime 占位会话，项目、Session、输入框和操作按钮均可观察且可测试
  - [x] 按 UI/UX V1.0 规范实现四区布局、浅色 Design Tokens、Tool 分类、输入选择器、面板折叠和减少动态效果
  - [x] Daemon 正常退出、GUI 释放和异常终止均不会遗留孤儿 Named Pipe Host，常驻策略仍可安全重连

### T5.7 设置、Provider、多 Runtime 与视觉一致性纠正

- [x] 完成设置中心、API Provider、多 Runtime 选择和 UI/UX V1.0 视觉一致性纠正
- 前置依赖：T5.6
- 交付物：Settings/Provider Registry、Windows Credential Manager 集成、Codex/Claude Code Runtime Bridge、设计稿一致的 Desktop UI、E2E/视觉验收报告
- Checkpoints：
  - [x] 设置中心包含通用、外观、账号、Agent、用量、项目、设备、GitHub、键盘快捷键、账单和关于一级分类，入口、导航、保存与错误反馈均可操作
  - [x] Provider Registry 支持 ChatGPT 登录、OpenAI、Anthropic、DeepSeek、自定义 OpenAI-compatible 与自定义 Anthropic-compatible，支持 Base URL、Model、连接测试、启用、编辑和删除
  - [x] API Key 只写入 Windows Credential Manager；本地 JSON、SQLite、日志、诊断包、配置导出和 Renderer Snapshot 只保存 `secretRef` 或 `hasSecret`，不出现明文
  - [x] Runtime Registry 至少发现 Codex app-server 与 Claude Code；Generic ACP 和未接通 Runtime 明确显示为 `unknown` 或 `unsupported`，不伪装为已支持
  - [x] 新建 Session 和输入区可选择 Runtime、Provider、Model、Execution Environment 与 Permission Mode，并把选择固定到该 Session
  - [x] Codex 可使用现有 ChatGPT 登录或 OpenAI/OpenAI-compatible Provider；Claude Code 可使用 Anthropic、DeepSeek 或 Anthropic-compatible Provider；不兼容组合在启动前阻止并解释原因
  - [x] Provider 连接测试和 Runtime Probe 只记录布尔结果、延迟与错误类别，不记录 Key、测试 Prompt、响应正文或原始事件
  - [x] `userMessage`、Agent 文本、READ、MODIFY 与 EXECUTE 事件分类正确，不再把用户消息渲染为 Tool Card
  - [x] 主工作台、右侧四入口工作面板、底部终端区和设置弹窗按《Tsukiori 完整 UI/UX 与插图视觉设计规范 V1.0》完成 1600×1000 截图验收
  - [x] 设置、Provider、Runtime、会话选择、视觉 DOM、秘密扫描和孤儿进程回归测试全部通过，公开 CI 不需要用户凭据

### T5.8 三产品优点融合与完整工作台落地

- [x] 在不复制参考项目源码、品牌和私有数据的前提下完成可交互本地多 Agent 工作台
- 前置依赖：T5.7
- 交付物：参考产品差距报告、会话与 Transcript、文件/附件、ConPTY、预览、Skills/MCP、Agent Team、应用图标、Fixture 和测试报告
- Checkpoints：
  - [x] Codex Desk、Lody 和 cc-haha 的版本、许可边界、功能模式与工程做法完成只读审计，参考文件只存在忽略的 `.tmp` 目录
  - [x] Session 支持搜索、置顶、重命名和安全归档；项目、Session、Team 与本地 Transcript 可在重启后恢复
  - [x] Worktree 文件树、路径内文本预览、文件筛选、附件复制和安全 Markdown/代码块展示可观察且有大小边界
  - [x] 每个 Session 可启动真实 Windows ConPTY，输入、输出、切换和退出均可测试，终端环境不继承 key-like 凭据
  - [x] 本地/HTTPS 预览使用受 CSP 与 sandbox 约束的 iframe，系统浏览器打开仍由 Main Process 校验 URL
  - [x] Codex Skills/MCP 按需读取且不持久化原始路径或认证内容；2–4 个 Agent Team 使用独立 Worktree 并行派发
  - [x] 更新检查、Git/GitHub 状态、Provider、Runtime、持久化策略与高风险确认设置均有真实控制面；UI 比例、13–15px 正文、全按钮微动效和减少动态效果通过可见截图验收，Windows 包使用 Tsukiori 图标
  - [x] 类型、交互、UI、安全、Host、秘密扫描、预编译 ConPTY 打包、NSIS 安装生命周期和孤儿进程回归全部通过
  - [x] 左侧项目可置顶、折叠和滚动，Agent 作业嵌套在所属项目下；跨项目搜索和新建作业入口可观察
  - [x] 右侧工作面板提供审阅、终端、浏览器、文件、侧边聊天和桌面控制六个真实入口，并支持快捷键和面板开关状态
  - [x] 侧边聊天绑定项目内独立 Session 的 Runtime、Provider 和权限策略，不复制或模拟模型响应
  - [x] 底部 ConPTY 终端支持拖动高度、键盘调整、折叠、重启和本地持久化；右侧终端入口控制同一个真实终端
  - [x] Session、Agent Team 和设置弹窗均支持取消、右上角关闭、Esc 与点击遮罩；设置保存按钮在 1600×1000 和自动化视口内完全可见且中心点可命中
  - [x] Electron 实际点击探针覆盖弹窗退出、设置保存、项目置顶、六个工作面板、左右栏折叠和终端拖动；UI、交互、安全与全量 Check 通过
  - [x] Agent Team 支持 2–4 个动态成员、独立职责/Worktree、全员或定向后续任务、真实成员状态、故障重试、全队中断、协调者结果汇总和重启后的瞬态状态收口
  - [x] Codex Motion 以本机打包样式只读测得的 120ms 控件、180ms 面板、170ms Overlay 和 260ms 进入曲线落地；删除额外扫光、弹跳和持续脉冲，保留蔚蓝档案视觉几何
  - [x] 1920×1080@100%、1366×768@125%、1280×800@150% 和 1100×720@150% 响应式矩阵通过，工作区、右侧 Overlay、设置弹窗和底部按钮无裁切或横向溢出
  - [x] 新工作台审阅面板接入真实 Integration Worktree：Merge/Rebase 隔离验证、冲突/验证失败恢复、显式 Promotion、目标竞争拒绝、恢复引用与丢弃清理均可观察，验证阶段不修改项目主工作区
  - [x] 最小化启动接入真实 BrowserWindow 生命周期，正常产品进程使用单实例锁；真实 Electron 探针验证首实例 minimized、第二实例退出并恢复原窗口，退出后无孤儿 Named Pipe Host
  - [x] 默认 Model 可随 Provider 选择并用于新 Session；当前未实现的英文界面与系统主题明确锁定，高风险确认由安全策略强制启用且不能由旧状态或 Renderer 参数关闭

### G5 阶段 5 Gate

- [x] Windows Local V1 已满足发布条件
- 前置依赖：T5.1、T5.2、T5.3、T5.4、T5.5、T5.6、T5.7、T5.8
- 交付物：最终 V1 Gate 报告和发布签字记录
- Checkpoints：
  - [x] T0.* 至 T5.* 的全部顶层任务已勾选
  - [x] G0 至 G4 已通过，且 G5 无未解决阻塞项
  - [x] 第 37.1 至 37.11 章所有 Local V1 发布检查已勾选并有证据
  - [x] 严重级别安全、数据丢失和错误进程终止问题均为零
  - [x] B1 至 B3 未计入 V1 完成率，也未被包装成已发布能力

## V1 之后任务池

后续任务只有在“启动条件”满足后才进入正式排期；它们不影响 V1 完成率或 G5。

### B1 Claude Adapter

- [ ] 在 V1 之后实现 Claude Runtime 接入
- 启动条件：G5 完成；Claude 原生协议或 Agent SDK 版本已选定并完成独立 Spike
- 预期产物：Claude Adapter、原生/SDK 模式 ADR、认证与能力矩阵
- Checkpoints：
  - [ ] 原生模式与可选 Agent SDK 模式分别 Detect、Probe 和版本锁定
  - [ ] Session、Permission、Hooks、Skills、MCP、Subagents 和 Checkpoint 能力按实测分级
  - [x] 认证来源与 Provider 数据出口在 UI 中明确区分
  - [ ] Claude Adapter 通过完整合同、恢复、安全和 E2E 测试

当前进展（2026-08-09）：`@tsukiori/adapter-claude` 已完成 Claude Code `2.1.226` 原生 `stream-json` 基线、版本锁、本机认证探测、Native/API Provider 隔离、Rich Event 映射、中断/失败收口，以及基于 Structured I/O 的一次性权限允许/拒绝与 Attention Center 跨层合同；Session/Transcript Search、受干净 Worktree 约束的 Claude Fork、显式 Retry 和宿主 Checkpoint/Rewind 也已形成 Fixture/跨层测试。Checkpoint 会保存 Git Index/Worktree Tree、Transcript 哈希和 Runtime Message 锚点，回退前建立 Recovery Checkpoint，且不移动分支 HEAD；Claude 下一 Turn 使用 `--resume-session-at` 派生新 Session。MCP/Skills 健康页现在按 Project 隔离本地 Scope，并把 Codex app-server 实际观察与宿主配置对账；Claude 只能观察 MCP 数量，具体名称/健康/Skill 继续显示 unknown。Claude Subagent 事件和 Codex collab item 已形成不含 Prompt/Message/Transcript Path 的脱敏 Activity 投影，并与宿主 Team/后台 Session 区分来源；完整控制与恢复仍未验证。基础 cc-haha 导入器已提供只读 Dry Run、Transcript/cwd/Git 验证、内容哈希幂等、批次回滚、只读导入历史和显式 Fork，不迁移凭据、设置、工具原始正文或运行中进程。详见 ADR-0004、ADR-0005、ADR-0006、`docs/spikes/B1-claude-native-stream-json.md`、`docs/spikes/S2-checkpoint-rewind.md`、`docs/spikes/S2-mcp-skills-health.md`、`docs/spikes/S2-subagent-activity.md` 与 `docs/spikes/S2-cc-haha-import.md`。隐藏权限/Fork/Message Rewind 的真实 Claude CLI 无副作用 E2E、Agent SDK 决策、Hooks/Skills/MCP/Subagent 深度语义、进程中途强杀恢复和统一 Event Store 仍未完成，因此 B1 及其组合 Checkpoint 保持未完成。

### B2 Generic ACP

- [ ] 在 V1 之后实现 Generic ACP Adapter
- 启动条件：G5 完成；目标 ACP 协议版本和首批兼容 Runtime 已确定
- 预期产物：ACP Adapter、协议 Fixture、兼容性注册表
- Checkpoints：
  - [ ] stdio、initialize 和 capability negotiation 可按协议版本验证
  - [ ] sessions、prompt、streaming、permission 和 cancellation 通过合同测试
  - [ ] registry 与 custom command 不绕过宿主权限和路径校验
  - [ ] 不支持或语义不一致的能力显示为 degraded、unsupported 或 unknown

### B3 新执行环境

- [ ] 在 V1 之后扩展 WSL、macOS 和 Linux
- 启动条件：G5 完成；目标平台优先级、CI 资源和签名发布条件已确定
- 预期产物：环境 Adapter、平台安装包、兼容性与发布矩阵
- Checkpoints：
  - [ ] 每种环境分别验证路径、Git、PTY、进程树、凭据库和 IPC
  - [ ] Worktree、Runtime Installation 和进程不会跨环境错误混用
  - [ ] 每增加一种环境都重新运行 Adapter、Git、Recovery、安全和 E2E 测试
  - [ ] 对应安装、升级、签名、回滚和诊断流程在目标平台通过

---
# 33. 测试体系

## 33.1 Adapter Contract Tests

每个 Adapter 必须通过统一合同：

- Detect；
- Probe；
- Start/Stop；
- Create/Resume Session；
- Start/Cancel Turn；
- Handle 级 Events；
- 多 Session 事件路由；
- Runtime Scope 全局事件；
- Permission/User Input；
- Connection Epoch 失效；
- 背压与缓冲上限；
- Unknown Event Preservation；
- Native Event Redaction；
- 不支持事件补发时的 Snapshot Recovery。

## 33.2 Fake Runtime

开发一个可脚本化 Fake Runtime：

~~~text
输出文本
发起工具
请求权限
请求用户输入
模拟多 Session 共用事件流
模拟 Runtime Scope 事件
模拟长任务
模拟崩溃
模拟重复事件
模拟乱序事件
模拟 Session Resume
模拟旧 Connection Epoch 响应
模拟包含 Secret 和大对象的未知事件
~~~

不能依赖真实模型完成所有测试，否则测试慢、昂贵且不稳定。

## 33.3 Git Integration Tests

覆盖：

- 干净仓库；
- 脏主工作区；
- Worktree 创建；
- 分支冲突；
- 未跟踪文件；
- 二进制和超大文件；
- Rename；
- Merge Conflict；
- Integration Worktree；
- Rebase；
- Submodule；
- Worktree 孤儿；
- Git Hook/签名程序；
- Windows 长路径和大小写；
- Windows/WSL 环境混用拒绝；
- 强制删除保护。

## 33.4 Recovery Tests

在以下节点强制杀进程：

- 创建 Worktree 中；
- Runtime 启动中；
- Tool 执行中；
- 权限等待中；
- Commit 中；
- Merge 中；
- Worktree 删除中；
- GUI 与常驻 Daemon 重连中。

验证：

- 数据不丢；
- 代码不误删；
- 状态可解释；
- Operation 进入 committed/failed/uncertain 之一；
- 不重复危险操作；
- 旧审批请求失效；
- PID 复用不会终止无关进程。

## 33.5 安全测试

- 路径穿越；
- 符号链接/Junction 逃逸；
- 恶意 IPC 参数；
- 其他本机用户连接 Named Pipe/Socket；
- Renderer XSS；
- Token 猜测；
- Native Event/WAL/Blob Secret；
- 恶意 ANSI；
- 恶意 Markdown/Mermaid；
- MCP 工具注入；
- Shell 参数注入；
- 原始 Shell 字符串错误持久授权；
- 超大事件和 Diff 资源耗尽。

## 33.6 E2E

Windows Alpha：

~~~text
添加项目
→ 创建 OpenCode Session
→ 处理 Runtime 权限
→ 修改文件
→ Attention Center
→ 查看 Diff
→ Commit
→ 归档
→ 安全清理
~~~

可发布 V1：

~~~text
同一项目创建 OpenCode 与 Codex Session
→ 两个独立 Worktree 并行运行
→ 分别完成权限/输入处理
→ Review 两份 Diff
→ Commit
→ Integration Worktree 验证与合并
~~~

---

# 34. 日志、监控与诊断

## 34.1 结构化日志

字段：

~~~text
timestamp
level
component
executionEnvironmentId
daemonBootId
runtimeHandleId
connectionEpoch
sessionId
turnId
runtimeType
runtimeSessionId
operationId
processId
message
errorCode
~~~

## 34.2 日志范围

- Electron Main；
- Daemon；
- Adapter；
- Runtime stderr（脱敏、限额）；
- Git；
- Hook；
- PTY 元数据；
- Recovery；
- Database Migration。

Runtime stdout/stderr、Native Event 和终端输出都属于不可信数据。任何 Pino sink、滚动文件或诊断包之前先执行脱敏和大小限制。

## 34.3 诊断包

包含：

- 应用版本；
- OS 和 Execution Environment；
- Runtime 版本；
- 能力与 Enforcement Level 快照；
- 脱敏日志；
- Session 正交状态；
- ProcessRecord 身份字段；
- Worktree/Git 状态；
- Operation 状态；
- Schema 版本。

默认不包含：

- 源码内容；
- 完整 Prompt；
- Native Event Raw Payload；
- API Key；
- Cookie；
- 私钥。

由用户明确勾选后才可包含会话或代码内容；导出时再次脱敏并展示预计文件大小。

---

# 35. 安装、升级与跨平台发布

## 35.1 发布顺序

可发布 V1 只承诺：

~~~text
Windows x64 · Windows Native Execution Environment
~~~

后续按验证结果扩展：

~~~text
Windows ARM64 / WSL
→ macOS Apple Silicon
→ Linux x64
→ macOS Intel / Linux ARM64
~~~

架构保持跨平台，但不以三平台同时上线阻塞 V1。每增加一种 Execution Environment，都必须重新验证 PTY、进程树、路径、Git、凭据库、IPC 和安装升级。

## 35.2 安装包

- electron-builder 或 Electron Forge；
- V1：Windows NSIS x64；
- 后续：macOS DMG；
- 后续：Linux AppImage/deb。

Daemon 应作为有独立版本和协议握手的 Sidecar 发布，而不是依赖用户系统 Node.js。

## 35.3 自动更新

必须：

- 签名验证；
- 分阶段发布；
- 可关闭自动下载；
- 更新前停止或保留 Daemon 的清晰策略；
- 常驻 Daemon 与新 GUI 的协议兼容检查；
- 数据库 Migration 前备份；
- 支持回滚应用版本时识别数据库不兼容。

## 35.4 Runtime 更新

V1 不自动升级用户 Runtime，只提示：

~~~text
检测到 Codex 新版本
当前版本：...
建议版本：...
[打开安装说明]
~~~

后续托管升级需要：

- 来源白名单；
- 版本锁定；
- 哈希校验；
- 回滚；
- 用户确认。

---

# 36. 兼容性与版本策略

## 36.1 Adapter Compatibility Matrix

~~~ts
interface RuntimeCompatibilityRule {
  runtimeType: string;
  minVersion?: string;
  maxTestedVersion?: string;
  protocolVersions: string[];
  generatedSchemaHash?: string;
  executionEnvironmentTypes: string[];
  knownIssues: string[];
}
~~~

Codex app-server 等能够生成版本对应 Schema 的 Runtime，应在合同测试中保存 Schema Hash 和 Fixture；Runtime 升级后重新生成、比较并 Probe。

## 36.2 未测试新版本

Runtime 高于 `maxTestedVersion` 时：

~~~text
允许 Detect/Probe
显示“未验证版本”
保留脱敏 Native Event
危险能力降为 unknown
禁止默认启用实验能力或持久 Allow 规则
~~~

## 36.3 Protocol Version

Daemon、Desktop 和 Adapter 均单独版本化：

~~~text
Desktop Protocol
Database Schema
Event Schema
Adapter Contract
Runtime Native Protocol
~~~

## 36.4 Feature Flags

用于：

- Claude SDK Mode；
- OpenCode LSP；
- ACP 新协议；
- Tool Input Mutation；
- Session Fork；
- Checkpoint；
- 自动 Worktree 清理；
- Integration Worktree Merge；
- 未验证 Runtime 版本。

---

# 37. 可发布 Local V1 验收标准

本章是 V1 的最终发布检查表。方括号中的任务编号表示该验收项的主要实现或验证来源；勾选时必须附测试报告、日志、截图、构建产物或审计记录之一作为证据。

## 37.0 Local V1 Ready 总门槛

- [x] [T0.*–T5.*] T0.1 至 T5.8 的全部顶层任务已完成
- [x] [G0–G5] G0 至 G5 的全部阶段 Gate 已通过
- [x] [37.1–37.11] 本章所有分类验收项均已勾选
- [x] [T5.5, T5.8] Release Candidate、兼容性矩阵、回归报告和已知问题已归档
- [x] [B1–B3] 完整 Claude Adapter、Generic ACP 和新执行环境未计入 V1 完成率，也未被包装成已发布能力

只有以上五项全部通过，版本状态才能标记为 Local V1 Ready。Verified Publisher 是未来可选发布通道，不阻塞 Local V1。

## 37.1 平台与执行环境

- [x] [T5.4] Windows x64 安装、升级和卸载可用
- [x] [T5.4] Local V1 允许未签名 NSIS，并明确显示 SmartScreen 风险；Verified Publisher 通道保持 fail closed
- [x] [T2.1] 支持 Windows Native Execution Environment
- [x] [T2.1, T2.2] Project、Git、Runtime 和 Worktree 环境一致性可验证
- [x] [T3.4, T4.5] WSL、macOS、Linux 不出现在 V1 可操作承诺中

## 37.2 Runtime

- [x] [T4.1, T5.6, T5.7] 自动发现并实际启动 Codex 与受限 Claude Code；OpenCode 保留为后续可选 Runtime
- [x] [T3.1, T4.1, T4.3, T5.2, T5.7] 显示路径、版本、认证来源、Provider 数据出口、能力支持级别和 Enforcement Level
- [x] [T5.6, T5.7] Codex 可使用现有 ChatGPT 或兼容 API Provider 完成真实 Thread 与 Turn
- [x] [T4.1] Codex 使用原生 app-server
- [x] [T3.2, T4.2] 控制命令与事件流分离
- [x] [T4.2, T4.5, T5.6] 多个 Codex Session 使用独立 app-server 事件读取器
- [x] [T3.3, T4.5, T5.1] 单个 Runtime 崩溃不影响其他 Runtime
- [x] [T3.4, T4.3, T5.6, T5.7, G4] OpenCode 与 ACP 显示为 `unknown`；Claude Code `stream-json` 接入显示为 `degraded`，完整 Claude Adapter 仍属 B1，不伪装为完整支持

## 37.3 Project / Worktree

- [x] [T2.1] 添加本地 Git 项目
- [x] [T2.3] 每个可写 Session 默认独立 Worktree
- [x] [G2, T4.5] 至少三个 Session 并行
- [x] [T2.2] 记录固定 base commit 和 Execution Environment
- [x] [T2.2] Worktree Root 可配置
- [x] [G2] 主工作区不被并行任务污染
- [x] [T2.2] 未提交代码不得被自动删除
- [x] [T2.2, T5.1] 创建或清理强杀后可通过 Durable Operation 恢复
- [x] [T2.3] 可安全归档和清理

## 37.4 Session 与待处理中心

- [x] [T1.4, T3.2, T4.2] 支持流式文本
- [x] [T1.5] 提供 Tool Card
- [x] [T1.5] 提供 Permission Card
- [x] [T1.4, T4.3] Runtime 支持时展示 Plan/Todo
- [x] [T3.3, T4.2] 支持 Cancel 或 Interrupt
- [x] [T3.3, T4.2] 支持 Resume
- [x] [T1.3, T1.4] Lifecycle、Activity、Health、Workspace State 独立展示
- [x] [T1.5] Attention Center 显示等待权限、等待输入、已完成、失败、冲突和恢复不确定状态
- [x] [T1.3, T1.5] GUI 重启后恢复历史
- [x] [T5.1] Daemon 重启后给出明确恢复状态
- [x] [T3.3, T5.1] 不自动重放 Prompt

## 37.5 原生能力

- [x] [T4.3] Codex 配置、MCP、Skills 和 Sandbox 继续生效
- [x] [T3.1, T3.3, T5.6] OpenCode 原生能力保留为已验证 Adapter 能力，但不包装成当前交互产品已接入能力
- [x] [T0.4, T4.3] 未支持、实验、降级和未知能力明确区分
- [x] [T1.4, T4.2, T5.2] 未知 Native Event 经脱敏、限额后保留
- [x] [T0.4, T4.3] Runtime 专属能力不被强行伪造成公共能力

## 37.6 权限与隔离

- [x] [T1.5, T3.3, T4.2] Shell、文件、网络和 MCP 请求按 Runtime 实际暴露范围显示
- [x] [T1.5, T3.3, T4.2] 每项请求显示 Enforcement Level
- [x] [T0.4, T5.2] observable_only 和 opaque 不显示为“已受宿主保护”
- [x] [T1.5] 一次允许、Session 允许、项目规则和拒绝均可审计
- [x] [T5.2] 原始 Shell 字符串不生成宽泛持久 Allow 规则
- [x] [T1.4, T3.3, T4.2] 旧 Connection Epoch 请求不可响应
- [x] [T5.2] Worktree 不被描述为安全沙箱

## 37.7 Git

- [x] [T2.4] 提供文件列表
- [x] [T2.4] 提供 Working Diff
- [x] [T2.4] 提供 Staged Diff
- [x] [T2.4, T4.4] 提供 Session Commit Diff
- [x] [T4.4] 支持 Stage/Unstage
- [x] [T4.4] 支持带恢复快照的 Revert
- [x] [T3.4, T4.4] 支持 Commit
- [x] [T4.4, T5.8] 支持新工作台可见的 Integration Worktree Merge/Rebase、冲突恢复与显式 Promotion
- [x] [T4.4] 提供冲突提示
- [x] [T4.4] 支持打开外部编辑器
- [x] [T4.4, T5.8] 隔离验证不修改用户主工作区；Promotion 前复验分支、HEAD 和工作区，并创建恢复引用

## 37.8 本地数据与安全

- [x] [T1.3, T5.2] 项目、会话、事件、日志、Blob、审计和恢复数据只存本机
- [x] [T3.1, T4.1] 模型请求由 Runtime 直连用户选择的 Provider，不经过本项目服务器
- [x] [T1.1, T5.2] Renderer 无 Node 权限
- [x] [T1.2, T5.2] IPC 参数校验
- [x] [T1.2, T5.2] Named Pipe 使用当前用户 ACL
- [x] [T1.2, T5.1] 常驻 Daemon 可以安全重连
- [x] [T1.3, T3.1, T5.2] Secret 不入 SQLite、WAL、Blob 或日志
- [x] [T1.4, T5.2, T5.3] Native Event 持久化前脱敏和限额
- [x] [T2.1, T2.2, T5.2] 执行路径边界与 Execution Environment 检查
- [x] [T2.4, T5.2] 不通过 Shell 字符串启动 Runtime 或执行 Git
- [x] [T5.3] 诊断包默认不包含源码、完整 Prompt 和凭据

## 37.9 可交互产品闭环

- [x] [T5.6] 普通模式可添加真实本地 Git 项目，不显示 Fake Runtime 占位数据
- [x] [T5.6] 用户可创建 Codex Session，并能看到对应独立 Worktree 路径和分支
- [x] [T5.6] 用户可输入 Prompt、发送真实 Turn、查看流式响应并中断运行中的 Turn
- [x] [T5.6] Runtime 权限请求在 Attention Center 中可由用户实际处理
- [x] [T5.6] 用户可查看真实 Git 文件状态和 Diff，并执行 Stage、Unstage 与 Commit
- [x] [T5.6] 本机真实 Codex Probe 验证 Thread、Turn、流式响应和 Worktree 隔离，公开 CI 只运行无凭据替身测试
- [x] [T5.6] 主工作区符合 UI/UX V1.0 的项目/会话、中央对话、右工作面板和底部运行日志布局
- [x] [T5.6] 正常退出与强制终止回归均确认 Named Pipe Host 被回收，常驻 Daemon 仍可重连

## 37.10 设置、Provider、多 Runtime 与视觉一致性

- [x] [T5.7, T5.8] 设置入口和十九个一级分类可访问；已支持的通用、外观与 Agent 设置可保存并在重启后恢复，未支持的语言/主题选项明确锁定
- [x] [T5.7] 用户可新增、编辑、测试、启用和删除 OpenAI、Anthropic、DeepSeek 与两类兼容 Provider
- [x] [T5.2, T5.7] API Key 仅存在 Windows Credential Manager，状态文件、数据库、日志、导出与 Renderer 均无明文
- [x] [T4.1, T5.7] Codex app-server 可按 Session 使用 ChatGPT 或兼容的 API Provider 与 Model
- [x] [T5.7] Claude Code 可被发现，并可按 Session 使用 Anthropic/DeepSeek/Anthropic-compatible Provider 与 Model
- [x] [T0.4, T5.7] Generic ACP、OpenCode 和不可用 Runtime 的支持级别真实显示，不兼容组合不会静默回退
- [x] [T5.7] 输入区 Runtime、Provider、Model、Environment 与 Permission 选择器均可操作并固定到 Session
- [x] [T5.8] 默认 Runtime、Provider、Model 与最小化启动均连接真实产品行为；单实例探针验证第二次启动恢复现有窗口
- [x] [T5.2, T5.8] 高风险确认由宿主安全策略强制启用，旧状态文件和 Renderer 参数都不能关闭
- [x] [T5.7] 用户消息、Agent 消息和 READ/MODIFY/EXECUTE Tool Card 分类通过事件回归测试
- [x] [T5.7] 1600×1000 主工作台和设置中心截图与 UI/UX V1.0 的布局、颜色、密度、几何装饰和交互入口一致
- [x] [T5.1, T5.7] 设置/Provider/Runtime 回归不会泄漏凭据或遗留 Runtime、Daemon、Named Pipe Host 子进程

## 37.11 完整工作台与三产品优点融合

- [x] [T5.8] Session 可搜索、置顶、重命名和安全归档，归档不会删除未提交 Worktree
- [x] [T5.8] 用户明确启用时，对话正文以本地 Transcript 恢复；状态文件、公开 Fixture 和仓库仍不包含 Prompt
- [x] [T5.8] Worktree 文件树、筛选、有界文本预览和路径越界拒绝均可验证
- [x] [T5.8] 文件与图片附件由 Main Process 选择并复制到当前独立 Worktree，单文件和总数量有边界
- [x] [T5.8] Agent 消息以无 HTML 注入的 Markdown、列表、引用和代码块呈现
- [x] [T0.3, T5.8] 每个 Session 的 Windows ConPTY 支持交互输入、流式输出、Resize 与退出回收
- [x] [T5.8] 本地预览由 CSP 和 iframe sandbox 约束，外部打开继续校验 HTTP/HTTPS 与内嵌认证
- [x] [T4.3, T5.8] Codex Skills 与 MCP 可按需展示，原始本地路径、Token 与认证正文不进入持久化数据
- [x] [T2.3, T4.5, T5.8] 2–4 个 Agent Team 使用独立 Session 和 Worktree 并行派发，失败状态不会静默成功
- [x] [T5.4, T5.8] 应用具有 Tsukiori Windows 图标、公开 Release 更新检查和本地 Git/GitHub 状态检测
- [x] [T5.7, T5.8] 新能力继续遵循 UI/UX V1.0 的蓝白日系科幻布局、密度、几何装饰和四区域信息架构
- [x] [T5.1, T5.2, T5.8] Terminal、Team、文件、附件和 Transcript 回归不泄漏 Credential Manager 密钥且不遗留孤儿进程

---
# 38. 主要风险与应对

## 风险 1：强行统一导致原生能力丢失

**应对：** 公共事件 + 脱敏 Native Event + Runtime 专属面板；Capability 使用支持级别而不是布尔值。

## 风险 2：Runtime API 快速变化

**应对：** Adapter 隔离、能力 Probe、生成 Schema Hash、兼容矩阵、Feature Flag、合同测试。

## 风险 3：统一权限 UI 被误认为统一安全沙箱

**应对：** 显示 Enforcement Level；明确区分 Runtime Sandbox、OS Sandbox、可拦截、仅观察和不可见；不承诺拦截 Runtime 未上报的操作。

## 风险 4：Worktree 删除丢代码

**应对：** Durable Operation、安全检查、默认不强制删除、固定 base commit、Patch/分支保留和恢复扫描。

## 风险 5：进程身份判断错误

**应对：** Windows Job Object、Process Group、daemonBootId、进程启动时间、spawnNonce；不只凭 PID 回收孤儿进程。

## 风险 6：恢复时重复执行副作用

**应对：** 不自动重放 Prompt；Operation 状态机；外部事实核对；用户确认恢复。

## 风险 7：OpenCode Server 被本机其他程序访问

**应对：** Worktree Scope、绑定本机、随机端口、随机密码、生命周期受控；不暴露到非回环地址。

## 风险 8：Native Event、终端和日志泄密或占满磁盘

**应对：** 持久化前脱敏、Blob Store、分块、滚动、压缩、限额、内容哈希和按需加载。

## 风险 9：Windows、WSL 和跨平台路径/进程语义不同

**应对：** Execution Environment 一等建模；V1 只承诺 Windows Native；每增加环境重新跑合同、Git、PTY、恢复和安装测试。

## 风险 10：产品变成完整 IDE

**应对：** V1 只做 Agent 控制台、Attention Center、终端和 Diff；代码编辑主要交给外部编辑器。

## 风险 11：多个 Adapter 让核心抽象反复变化

**应对：** 关键 Spike → Fake Runtime → OpenCode Alpha → Codex V1；Claude 和 ACP 不阻塞 V1。

## 风险 12：依赖真实模型导致测试不可控

**应对：** Fake Runtime、录制回放、协议 Fixture、Schema Diff、少量真实集成测试。

## 风险 13：常驻 Daemon 重连凭据设计不完整

**应对：** 当前用户 Pipe/Socket 权限、peer identity、daemonInstanceId、challenge-response；长期 Secret 只进系统凭据库。

## 风险 14：“纯本地”被理解为完全离线

**应对：** 明确“数据本地存储、模型 Runtime 直连 Provider”；UI 展示 Provider、认证来源和已知数据出口。

---

# 39. 后续演进路线

## 39.1 V1.1

- Claude 原生模式 Adapter；
- 可选 Claude Agent SDK 实验模式；
- Session Fork；
- Diff 评论；
- 自动测试状态；
- 更完整的 Context/Token/Cost；
- Runtime 更新提示；
- 项目模板和 Prompt Composer。

## 39.2 V1.5

- Generic ACP Adapter；
- WSL Execution Environment；
- macOS Apple Silicon；
- Linux x64；
- 更完善的 MCP 管理；
- Review Agent；
- 多个 Agent 结果对比；
- Agent 接管另一个 Worktree；
- Session 导出和导入；
- 本地搜索和会话摘要。

## 39.3 V2

- 插件 SDK；
- 多 Agent 任务依赖图；
- 跨 Agent 交接和结果聚合；
- 本地局域网控制；
- 可选 Web UI；
- 本地长期记忆；
- Agent 任务队列；
- 预算和配额策略；
- GitHub CLI 本地集成。

## 39.4 未来是否自研 Runtime

只有在以下条件同时满足后再考虑：

- 宿主产品已有稳定用户；
- 第三方 Runtime 存在明确不可解决的能力缺口；
- 团队有能力长期维护 Tool Loop、Context、Sandbox、MCP、Skills 和兼容性；
- 自研 Runtime 能产生明显差异，而不是重复造轮子。

否则继续坚持宿主路线。

---

# 40. 最终架构决策清单

| 决策 | 结论 |
|---|---|
| 产品形态 | 本地控制、本地存储的多 Runtime、多 Session Coding Agent 工作台 |
| “纯本地”定义 | 项目与工作台数据只存本机；模型请求由 Runtime 直连用户选择的 Provider |
| 是否做本项目云端 | V1 不做账户、同步、中继和远程存储 |
| 是否自研 Agent Loop | V1 不做 |
| V1 Runtime | OpenCode + Codex |
| 后续 Runtime | Claude 原生/Agent SDK + Generic ACP |
| V1 平台 | Windows x64 |
| 执行环境 | Execution Environment 一等建模；V1 为 Windows Native |
| 桌面框架 | Electron + Vue 3 |
| 核心后台 | 独立、可常驻、单独版本化的 Node.js/TypeScript Daemon |
| 本地通信 | Named Pipe / Unix Socket + 当前用户权限 + challenge-response |
| 数据库 | SQLite + WAL + Drizzle + 受限 Blob Store |
| Git | 当前 Execution Environment 的系统 Git CLI |
| 并行隔离 | 每个写 Session 独立 Worktree；Worktree 不等于安全沙箱 |
| 合并 | 临时 Integration Worktree 验证后更新目标分支 |
| Codex 接入 | app-server，控制通道与事件通道分离 |
| OpenCode 接入 | Worktree Scope Server + SDK/SSE |
| 事件设计 | Scope Event + Stream Sequence + 脱敏 Native Event |
| 能力设计 | supported/experimental/degraded/unsupported/unknown |
| 权限 | Runtime/OS 执行边界 + 宿主统一交互与审计，不虚构拦截能力 |
| 凭据 | 优先 Runtime 原生认证；宿主管理 Secret 时使用系统凭据库 |
| 恢复 | Durable Operation + 外部事实核对 + 不自动重放危险操作 |
| 进程身份 | PID + daemonBootId + 启动时间 + spawnNonce |
| Runtime 进程模型 | Adapter 声明 Scope，OpenCode 默认 Worktree Scope |
| UI | Attention Center + 公共面板 + Runtime 专属面板 |
| 测试入口 | 关键 Spike 和 Fake Runtime 优先 |
| 开发顺序 | Spike → 宿主骨架 → Worktree → OpenCode Alpha → Codex V1 → Claude/ACP/跨平台 |

## 最终一句话架构

> Electron/Vue 负责桌面 GUI，独立 Local Daemon 负责只在本机运行和存储数据的控制平面；Daemon 通过 OpenCode Server/SDK、Codex app-server 以及后续 Claude/ACP Adapter 驱动原生 Agent Runtime；控制命令与事件流分离，项目、Session、Worktree、Git Diff、Attention Center、权限审计、事件存储、进程治理和故障恢复由宿主统一管理，实际模型请求由 Runtime 直接连接用户选择的 Provider，而 Agent Loop、上下文、原生工具、Skills、MCP、Plugins 和子 Agent 继续由各 Runtime 原生实现。

---

# 41. 官方资料与参考

以下资料用于核对当前产品和协议能力。Runtime 与 SDK 更新较快，正式开发时应再次核对版本和条款。

## OpenAI Codex

- Codex App Server：<https://developers.openai.com/codex/app-server>
- Codex SDK：<https://developers.openai.com/codex/codex-sdk>
- Codex CLI：<https://developers.openai.com/codex/cli/reference>
- Codex 开源仓库：<https://github.com/openai/codex>

## Anthropic Claude

- Claude Agent SDK Overview：<https://docs.anthropic.com/en/docs/claude-code/sdk>
- Claude Agent SDK TypeScript Reference：<https://docs.anthropic.com/en/docs/claude-code/sdk/sdk-typescript>
- Claude Hooks：<https://docs.anthropic.com/en/docs/claude-code/hooks>
- Claude Subagents：<https://docs.anthropic.com/en/docs/claude-code/sub-agents>
- Claude Skills：<https://docs.anthropic.com/en/docs/claude-code/skills>

## OpenCode

- OpenCode Server：<https://opencode.ai/docs/server/>
- OpenCode SDK：<https://opencode.ai/docs/sdk/>
- OpenCode ACP：<https://opencode.ai/docs/acp/>
- OpenCode Permissions：<https://opencode.ai/docs/permissions/>
- OpenCode Agents：<https://opencode.ai/docs/agents/>
- OpenCode Plugins：<https://opencode.ai/docs/plugins/>
- OpenCode LSP：<https://opencode.ai/docs/lsp/>
- OpenCode Config：<https://opencode.ai/docs/config/>

## ACP

- ACP Introduction：<https://agentclientprotocol.com/get-started/introduction>
- ACP Architecture：<https://agentclientprotocol.com/get-started/architecture>
- ACP v1 Schema：<https://agentclientprotocol.com/protocol/v1/schema>

## 架构参考产品

- Lody Worktrees：<https://lody.ai/docs/worktrees>
- Lody CLI Runtime Types：<https://lody.ai/docs/cli-runtimes>
- Lody Local Projects：<https://lody.ai/docs/local-project>
- Lody Resource Monitoring：<https://lody.ai/docs/device-resource-monitoring>
- cc-haha Desktop Internals：<https://github.com/NanmiCoder/cc-haha/blob/main/docs/en/internals/desktop.md>
- cc-haha Install / Bundled CLI Engine：<https://github.com/NanmiCoder/cc-haha/blob/main/docs/en/start/install.md>
- Hermes IDE：<https://www.hermes-ide.com/>

---

**文档结束。**
