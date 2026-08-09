# Tsukiori v1.0.0-rc.5 验证报告

验证日期：2026-08-10  
平台：Windows 10 x64  
Desktop / Daemon：1.0.0-rc.5

## 功能与 UI

- Project Pin、嵌套作业树、跨项目搜索和项目内新建 Session 通过状态持久化测试。
- 六个工作面板入口逐个经过 Electron 实际点击，Side Chat 使用真实 `sendPrompt` Session 通道。
- 工作面板宽度和终端高度的 CSS、ARIA 与本地 Snapshot 一致。
- Settings Save 修复后几何为 Dialog `98:860`、Footer `811:860`、按钮 `818:854`；`elementFromPoint` 命中按钮本身。
- Team/Session/Settings 的取消、右上角关闭、Esc 和 Backdrop 全部可退出且恢复焦点。
- 31 张设计验收截图全部重新生成。

## 自动化测试

- `pnpm run typecheck`：21 个 Workspace Package、34 个 Build/Typecheck Task 通过。
- 全量 `tests/**/*.test.mjs`：230 项通过。首次最大并发运行中 Dual Runtime 等待超时；隔离重跑 2/2 通过。
- Electron 交互探针：面板拖动、弹窗退出、设置保存、项目置顶、六工具入口、左右栏折叠和终端拖动全部通过。
- Checkpoint：30 个任务、6 个 Gate、3 个后续池有效；秘密扫描 clean。
- Named Pipe Host：正在运行的预览版有 1 个受 Daemon 管理的宿主，孤儿宿主为 0。

## Windows 安装生命周期

- `scripts/verify-windows-release-candidate.ps1`：Install、Packaged Smoke、Update、Uninstall、Reinstall、Final Uninstall 全部通过。
- 最终安装器：230,775,303 bytes。
- 安装器 SHA-256：`290a66d265a5fca6306995cc596afb3d227438b5c74a059ee89dcb56297df1f7`。
- Blockmap SHA-256：`ceb1e3f261be505b2967285406e03ddb0d0f42446f47c952247401bec3f761dc`。
- Authenticode：NotSigned，符合个人本地发行策略；Ed25519 Release Manifest 已用 Windows Credential Manager 中的私钥签名，仓库仅保存公钥。

## 安全与边界

- Renderer 继续启用 Sandbox、Context Isolation，且无 Node Integration；新增 Preload 仅包含有界的 `pinProject`。
- Side Chat 不新建第二套数据通道，不额外保存 Prompt，也不绕过 Session Permission。
- Generic ACP、远程 H5、IM、桌面宠物和 Runtime 自动调用 Computer Use MCP 未包含在 RC5，继续保持 unknown / backlog。
