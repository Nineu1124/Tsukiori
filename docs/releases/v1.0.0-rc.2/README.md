# Tsukiori v1.0.0-rc.2

这是 Windows x64 本地优先多 Agent 工作台的第二个候选版本。文件、项目、Worktree、会话状态与凭据引用保存在本机；模型请求按用户配置发送到对应 Provider。

## 安装

下载 `Tsukiori-1.0.0-rc.2-x64-setup.exe` 并运行。当前个人发行策略不购买 Authenticode 证书，因此 Windows SmartScreen 可能显示“未知发布者”；安装包完整性由 SHA-256 和仓库内 Ed25519 签名清单提供。

```powershell
Get-FileHash -Algorithm SHA256 .\Tsukiori-1.0.0-rc.2-x64-setup.exe
```

预期 SHA-256：

```text
fe92e4532f52c6718d849f209f122d9e2b99e39f1d2c0fd88991b6aa7c81bc89
```

## 本次修复与新增

- 修复 Claude Code `stream-json` 缺少 `--verbose` 导致发送后无响应的问题。
- Turn 退出但没有 result 时显示明确错误，并支持重试；同一 Session 禁止重复并发发送。
- DeepSeek Claude Code 映射使用 V4 Pro/Flash、1M 上下文、Subagent 与 effort 环境配置。
- Provider 支持安全获取远程模型列表，API Key 继续只保存在 Windows Credential Manager。
- 右侧工作面板支持鼠标拖动、键盘调整、双击复位，并持久化 260–720 px 宽度。
- 设置中心增加 Terminal、MCP、Agents、Skills、Memory、Token、Trace 与 Diagnostics 页面。
- Terminal 可选择 Windows PowerShell、PowerShell 7 或 Command Prompt。
- Doctor 和诊断导出默认排除 Prompt、用户源码、原始事件与凭据。

## 验证

完整的脱敏测试证据见 [validation-report.md](./validation-report.md)。发布物包括安装器、blockmap、`SHA256SUMS.txt`、`release-manifest.json` 与公开验证密钥。

