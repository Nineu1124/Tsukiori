# S2 Subagent Activity 投影

- 日期：2026-08-09
- 结论：PARTIAL PASS
- 范围：可见性与脱敏投影；不包含完整编排/控制

## 已验证

- Claude Adapter 把 Subagent Runtime 事件映射为有界摘要，只保留 Runtime/Task/Subagent ID、父 Tool Use ID、名称与状态。
- Codex `collabAgentToolCall` 把 receiver thread 和 agent state 投影为 `subagent.event`。
- Prompt、Message、Transcript Path 和 Raw Payload 不进入 Activity 或本机 Transcript。
- Desktop Activity 区分 Runtime 原生 Subagent、Tsukiori Team Subagent 与后台 Session。
- Claude mapper、Codex Workspace 跨层和 UI 文本合同通过。

## 未验证

- Runtime 重连后的父子树对账；
- 子 Agent 的宿主取消、暂停、恢复和重试；
- 多层嵌套、乱序与进程强杀恢复；
- 真实 Claude/Codex 端到端兼容性。

因此该能力保持 `degraded`，不能描述成完整 Subagent 管理器。
