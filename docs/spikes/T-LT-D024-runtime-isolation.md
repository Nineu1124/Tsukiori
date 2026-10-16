# T-LT-D024：故障成员与正常成员隔离

实际完成：2026-10-16。Windows / Node 24.11.1，OpenCode 1.18.4、Codex 0.146.0 离线合同。

扩大验收到崩溃后两个 Codex 成员分别完成新的 Turn，核验精确 Runtime Turn ID、健康状态、事件增量，以及故障成员保持 stopped/interrupted_runtime 且不再产生会话事件。逐条核对 session_events 的 session_id 与 runtime_handle_id，失败 Attention 只能属于崩溃成员。

新断言发现真实缺陷：Codex 的未绑定通知按 runtime_session_id 全库回查，两个独立进程返回相同 Thread ID 时，第二个进程提前到达的通知会落到第一个会话。OpenCode 也有同类回查。因此本项范围包含修复：两套 Bridge 只使用本 Handle 在 start/create/resume 时明确建立的映射；未知 ID 保持缓冲，绑定后重放。恢复仍需显式 resume，不再凭全局 ID 推测归属。

OpenCode 两进程测试特意保留相同原生 Session ID，并核验每条事件的 Handle，防止通过修改夹具 ID 隐藏问题。双 Runtime 测试最初查询误用了宿主 Turn ID，已更正为 Session ID 与原生 Turn ID 组合；随后暴露上述跨 Handle 事件，修复后通过。

验证：两套 Adapter TypeScript 编译通过；`node --test tests/dual-runtime/*.test.mjs tests/codex-adapter/*.test.mjs tests/opencode-adapter/*.test.mjs` 35/35；新增同 ID 所有权断言后单独重跑 OpenCode 崩溃用例 1/1。`npm run check`、`git diff --check` 通过后提交。测试无真实 Provider 请求，既有恢复、审批和事件去重断言保留。
