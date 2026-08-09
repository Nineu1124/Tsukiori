# Tsukiori

Tsukiori 是一个本地优先的多 Agent 工作台。项目文件、会话数据和运行记录保存在本机；模型请求由用户选择的 Runtime 直接发送到对应 Provider。

当前状态：Local V1 Windows 候选版。`v1.0.0-rc.4` 在 RC3 的完整工作台基础上增加了受会话锁和逐次审批保护的 Computer Use 本机桥接；安装包仍是个人未签名发行版。

完整架构与实施清单见 [本地多Agent工作台_完整架构与实施方案.md](./本地多Agent工作台_完整架构与实施方案.md)。

完整的蔚蓝档案启发式 UI 设计系统、ImageGen 原创资产、31 张页面稿和可重复视觉捕获流程见 [Tsukiori UI/UX 设计稿 V1.1](./docs/design/v1.1/README.md)。

## 当前能力

- pnpm Workspace + Turborepo + TypeScript strict。
- Electron Desktop 使用隔离 Renderer 和受限 Preload API。
- 独立 Daemon 支持版本化启动、探测和停止。
- Renderer 崩溃不会直接终止 Daemon。
- OpenCode、Codex 和 Windows Stage 0 证据均可在无凭据 CI 中重放。
- MCP、Skills、Memory、定时任务、Agent Team、ConPTY、文件预览和可拖拽工作面板均保存在本机。
- Windows Computer Use 通过一次性 PowerShell Helper 支持截图、鼠标和键盘动作；每次动作需要用户确认，能力标记为 `interceptable`，不是 OS 安全沙箱。

T1.2 将实现当前用户限定的 Named Pipe、握手、重连与请求校验。当前 stdin/stdout JSONL 仅是 T1.1 的 bootstrap 控制通道，不是正式 IPC。

## 本地验证

```powershell
pnpm install --frozen-lockfile
pnpm run build
pnpm run typecheck
pnpm run test:host
npm run check
```

## 安全边界

- 不提交 API Key、认证文件、完整 Prompt、用户源码或未脱敏 Runtime 事件。
- Renderer 不启用 Node Integration，只通过白名单 Preload API 通信。
- Worktree 是代码隔离机制，不是安全沙箱。
- Computer Use 只能锁定用户明确选择的前台应用；PID/启动时间/路径变化会拒绝动作，截图不会落盘保留。
- 真实 Provider 测试只在本机执行，公开 CI 不保存用户凭据。

## License

[MIT](./LICENSE)
