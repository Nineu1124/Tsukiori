# Tsukiori

Tsukiori 是一个本地优先的多 Agent 工作台。项目文件、会话数据和运行记录保存在本机；模型请求由用户选择的 Runtime 直接发送到对应 Provider。

当前状态：阶段 0（关键技术 Spike）。尚无可发布版本。

完整架构与实施清单见 [本地多Agent工作台_完整架构与实施方案.md](./本地多Agent工作台_完整架构与实施方案.md)。

## 阶段 0

- T0.1：OpenCode 协议 Spike
- T0.2：Codex app-server Spike
- T0.3：Windows 本机控制面 Spike
- T0.4：ADR 与 Adapter Contract 基线
- G0：阶段 0 Gate

## 安全边界

- 不提交 API Key、认证文件、完整 Prompt、用户源码或未脱敏 Runtime 事件。
- Worktree 是代码隔离机制，不是安全沙箱。
- 真实 Provider 测试只在本机执行，公开 CI 不保存用户凭据。

## License

[MIT](./LICENSE)
