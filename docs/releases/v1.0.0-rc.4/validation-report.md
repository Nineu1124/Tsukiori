# Tsukiori v1.0.0-rc.4 验证报告

验证日期：2026-08-03  
平台：Windows 10 x64  
Desktop / Daemon：1.0.0-rc.4

## 本版变更

- 新增 PowerShell + user32/GDI Computer Use Helper，提供前台指纹、截图、鼠标移动/点击、Unicode 键盘输入和白名单快捷键。
- 新增 `ComputerUseManager`：owner/session 锁、2 秒切换窗口、5 分钟租约、前台变化拒绝、30 秒单次审批和临时截图清理。
- Preload 固定增加六个 Computer Use 方法；右侧工作面板增加截图、鼠标、键盘和快捷键入口，危险动作均需确认。
- Named Pipe Host 在兼容测试省略启动时间参数时从父进程探测 .NET UTC ticks，继续保留 PID/启动时间身份检查，避免宿主 5 秒后误退出。

## 自动化测试

- TypeScript：20 个 workspace package 通过。
- Computer Use：4/4 通过，包含真实 Windows Helper capability/foreground 探测和 Fake Helper 安全边界。
- UI：10/10 通过，包含 Computer Use 固定 Preload、确认流程、非沙箱提示和视觉规则。
- IPC：5/5 通过，包含 CurrentUserOnly、重连、旧实例、错误参数和错误 JSON。
- Interactive：18/18；Security：6/6；Host：9/9；Release Candidate：4/4；G0–G5 与 Local V1 Ready：全部通过。
- 全量无凭据回归：`test:contract`、`test:gate0`、`test:database`、`test:runtime`、`test:permission`、`test:ui`、`test:project`、`test:worktree`、`test:workspace`、`test:git`、`test:recovery`、`test:observability`、`test:release`、`test:release-candidate`、`test:dual-runtime`、`test:alpha`、`test:gate1`、`test:gate2`、`test:gate3`、`test:gate4` 均通过。
- Checkpoint 校验：30 个任务、6 个 Gate、3 个后续任务池有效；秘密扫描 clean。

## Windows 安装生命周期

- `scripts/verify-windows-release-candidate.ps1`：安装、Packaged Smoke、升级、卸载、重装、最终卸载全部通过。
- 最终安装器：219866609 bytes。
- 安装器 SHA-256：`43308e00b9970fa7563d62a9c1b4ebd3e251f67f828dacdfd08f7256374d437e`。
- Blockmap SHA-256：`89fff1fdfbf1ea74777cadd6b7f18dea2923208d14080f8b8381bde24dfcc504`。
- Authenticode：NotSigned，符合个人本地发行策略；Ed25519 清单使用 Windows Credential Manager 中的私钥签名，仓库仅包含公钥。

## 未纳入本版的能力

Computer Use 尚未作为 Runtime 自动可调用的 MCP 工具；远程 H5、IM 集成、桌面宠物、Skill Marketplace 和完整 Claude 原生 Adapter 继续保持后续任务，不计入 Local V1 完成率。
