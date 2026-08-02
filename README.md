# Tsukiori

Tsukiori 是一个本地优先的多 Agent 工作台。项目文件、会话数据和运行记录保存在本机；模型请求由用户选择的 Runtime 直接发送到对应 Provider。

当前状态：阶段 1。Stage 0 Gate 已通过，T1.1 Monorepo 与 Electron/Daemon 进程骨架已完成；尚无可发布版本。

完整架构与实施清单见 [本地多Agent工作台_完整架构与实施方案.md](./本地多Agent工作台_完整架构与实施方案.md)。

## 当前能力

- pnpm Workspace + Turborepo + TypeScript strict。
- Electron Desktop 使用隔离 Renderer 和受限 Preload API。
- 独立 Daemon 支持版本化启动、探测和停止。
- Renderer 崩溃不会直接终止 Daemon。
- OpenCode、Codex 和 Windows Stage 0 证据均可在无凭据 CI 中重放。

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
- 真实 Provider 测试只在本机执行，公开 CI 不保存用户凭据。

## License

[MIT](./LICENSE)
