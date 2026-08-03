# Tsukiori v1.0.0-rc.1

Tsukiori 的首个公开 Windows 预发行版。本版本把本地优先的多 Agent 工作台、完整设置中心、Provider/API 配置、Git/Worktree 工作流、终端与本地预览打包为可安装的 Windows x64 应用，并采用用户提供的角色图片作为应用与安装器图标。

## 下载与安装

下载 `Tsukiori-1.0.0-rc.1-x64-setup.exe` 后运行安装器。安装器支持选择安装目录，卸载时默认保留本地用户数据。

本预发行版没有商业 Authenticode 代码签名证书，因此 Windows SmartScreen 可能显示“未知发布者”。这不影响个人本地安装，但请只从 `Nineu1124/Tsukiori` 的 GitHub Release 页面下载，并在安装前核对 SHA-256。

```powershell
Get-FileHash -Algorithm SHA256 .\Tsukiori-1.0.0-rc.1-x64-setup.exe
```

预期值：

```text
e691c46a90706b5bef34fec28034673c232d21b00329d8ec8a3f8764ce9a2e86
```

Release 同时提供 `SHA256SUMS.txt`、Ed25519 签名的 `release-manifest.json` 和公钥 `tsukiori-release-2026.pub`。发布私钥只保存在发布机器的 Windows Credential Manager，没有进入仓库或 Release 资产。

## 主要能力

- 本地 Project、独立 Git Worktree、Diff、Stage/Unstage、Commit 与 Integration Worktree Merge。
- Session、Attention Center、权限审批、流式消息、本地 Transcript、文件附件和安全 Markdown。
- Codex app-server 原生接入，以及 OpenAI API、兼容 OpenAI Responses API 的自定义 Provider。
- Claude Code `stream-json` 降级接入，以及 Anthropic、DeepSeek、兼容 Anthropic Messages API 的自定义 Provider。
- API Key 通过 Windows Credential Manager 保存，不写入 SQLite、设置导出、日志或公开 Fixture。
- Windows ConPTY 终端、本地预览、Codex Skills/MCP 展示和 2–4 Agent Team。
- 完整设置中心、响应式桌面比例、按钮微动效和 Reduced Motion 支持。
- 正常退出与异常终止时回收 Daemon、Runtime 和 Named Pipe Host，防止孤儿 PowerShell 进程残留。

## 支持边界

- 平台：Windows Native x64。
- Codex `0.146.0`：`supported`。
- Claude Code `2.1.201`：`degraded`，权限仅映射 Plan、Accept Edits、Don't Ask。
- OpenCode：`unknown`，当前产品 Session 创建入口不启用。
- Generic ACP：`unknown`，仍属于后续任务池。
- Worktree 是变更隔离机制，不是安全沙箱。
- Provider 与模型是否可用取决于用户自己的 API、账号和服务端兼容性。

更完整的范围和已知问题见 [V1.0.0-rc.1-known-issues.md](../V1.0.0-rc.1-known-issues.md)。

## 发行完整性

- 安装包大小：`219793969` bytes。
- 安装包 SHA-256：`e691c46a90706b5bef34fec28034673c232d21b00329d8ec8a3f8764ce9a2e86`。
- Blockmap SHA-256：`3572580445ef38dce963e186fb2a53df00b12bcb5135f052f60bfdf1a1c54a5a`。
- Manifest：Ed25519，Key ID `tsukiori-release-2026`，Channel `candidate`。
- 数据库最大兼容 Schema：`6`。

