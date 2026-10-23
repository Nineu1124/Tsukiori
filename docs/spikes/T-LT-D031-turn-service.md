# T-LT-D031：统一 Turn 发送与取消编排

实际完成：2026-10-23。正式 `sendPrompt` 与 `interrupt` 委托 `WorkspaceTurnService`，集中处理输入、运行状态、Codex 恢复后启动、API 历史副本与取消信号、Claude 环境/分支/权限及失败收尾。现有事件回调和服务共用同一组活动句柄，未另建 Runtime 或状态副本。

Windows / Node 24.11.1：桌面 TypeScript 编译通过；新 Turn 服务、Codex resume/lifecycle 与 MCP reload 共 14/14 通过。覆盖初始化期间并发发送拒绝、API 中断与下一轮完整历史、重启恢复后按原 thread/turn 中断、恢复失败不发 Turn、MCP 切换保留线程，以及无效输入不进入 Runtime。验证包含实际 stdio RPC 离线服务，不使用真实 Provider。

`npm run check`、`git diff --check` 通过后提交。活动执行者仍位于 Main，后台进程迁移另行实施。
