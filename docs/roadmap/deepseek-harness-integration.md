# DeepSeek Harness 后续集成路线图

本路线图属于 G5 之后的增量优化，不改变 Local V1 的完成率或既有 Gate 状态。实施遵循“先固定证据，再扩展语义”的顺序；所有未经过真实 Runtime 或脱敏 Fixture 验证的能力继续标记为 `unknown`。

## 已有基线

- IPC 已通过 `lastStreamSequence` 与 `knownSnapshotVersion` 支持断线后的增量补发，并已有重连测试，因此原提案 T-DSH-03 不再重复实施。
- SubAgent、Thinking、Recovery 和 Provider 已有部分实现；后续任务只补齐可验证缺口，不以平行数据模型覆盖现有合同。

### DSH-06 固定 Session Fixture 与回放

- [x] 建立确定性、无凭据、可离线回放的 Session Snapshot Fixture
- 前置依赖：G5
- 交付物：Fixture 生成器、版本化 JSON Fixture、回放测试、实施报告
- Checkpoints：
  - [x] 对话、Permission、Thinking 前向兼容与 Tool 生命周期均有固定输入和预期事件
  - [x] 连续生成结果字节级一致，且每个场景的预期事件有稳定 SHA-256
  - [x] Fixture 不包含 Provider 请求、凭据、用户 Prompt 或机器专属用户路径
  - [x] Windows CI 以只读检查模式验证 Fixture 未过期并完成回放

### DSH-07 Provider 验证审计

- [x] 为 Provider 验证增加可追踪但不含秘密的审计闭环
- 前置依赖：DSH-06
- 交付物：Provider 验证审计事件、持久化/查询测试、实施报告
- Checkpoints：
  - [x] 成功和失败验证均记录 Provider 标识、结果、错误分类和已有 `lastTest.testedAt`
  - [x] 审计记录不包含 API Key、认证头、完整请求/响应或用户 Prompt
  - [x] 审计写入失败不伪造 Provider 验证成功，且有可观察的降级结果

### DSH-09 不确定操作详情与恢复入口

- [x] 在 Attention Center 展示不确定 Durable Operation 的安全详情和恢复动作
- 前置依赖：DSH-07
- 交付物：白名单详情投影、恢复入口、UI/跨层测试、实施报告
- Checkpoints：
  - [x] 只展示 operationId、operationType、reason 等允许字段，不暴露原始 requestPayload
  - [x] 用户可从详情执行明确的重试、放弃或进入诊断动作，结果可观察
  - [x] 非法字段、过期操作和恢复失败均有拒绝/错误状态

### DSH-10 Runtime 环境隔离

- [ ] 对 Claude 与 Codex 的真实启动路径统一执行 Provider 环境清理
- 前置依赖：DSH-09
- 交付物：环境策略、跨 Runtime 启动测试、秘密扫描报告
- Checkpoints：
  - [ ] Claude、Codex 和子进程仅获得当前 Provider 明确允许的环境变量
  - [ ] 切换 Provider 后不会继承上一 Provider 的 API Key、Base URL、Model 或派生变量
  - [ ] 清理规则覆盖正常启动、恢复、并行 Session 和失败重试

### DSH-02 恢复事件闭环

- [ ] 统一 Daemon、Runtime 与 IPC 恢复过程的快照/事件闭环
- 前置依赖：DSH-10
- 交付物：跨 Runtime 恢复投影、恢复 Fixture、集成测试、实施报告
- Checkpoints：
  - [ ] Fake、OpenCode、Claude 与 Codex 按各自 SupportLevel 产生一致的恢复结果
  - [ ] IPC 重连区分增量补发、Snapshot Recovery 与无法恢复三种可观察状态
  - [ ] Daemon/Runtime 强退、事件缺口和重复事件均通过失败注入验证

### DSH-01 SubAgent 生命周期持久化

- [ ] 将已验证 SubAgent 生命周期投影持久化，并只把异常状态送入 Attention Center
- 前置依赖：DSH-02
- 交付物：生命周期投影、查询接口、UI/恢复测试、实施报告
- Checkpoints：
  - [ ] started、progress、completed、failed、waiting 状态可跨重启恢复且保持来源隔离
  - [ ] completed 不制造 Attention；failed、waiting 和 action-needed 才产生可处理项
  - [ ] Runtime 原始 Prompt、消息和 Transcript 路径不进入持久化投影

### DSH-04 Thinking 块完成元数据

- [ ] 为每个 Thinking 块建立有界、按索引隔离的完成元数据
- 前置依赖：DSH-01
- 交付物：Thinking 投影合同、有界聚合实现、回放/UI 测试、实施报告
- Checkpoints：
  - [ ] 并行或交错 Thinking 块不会串内容，started/delta/completed 顺序可重放
  - [ ] 内容缓冲有明确上限和截断标记，不重复持久化完整推理正文
  - [ ] 未知 Runtime 事件继续保留为脱敏 native.event，不伪装成支持

### DSH-08 Compaction 事件

- [ ] 先接入已验证的 Codex Compaction，再决定 Claude 支持等级
- 前置依赖：DSH-04
- 交付物：Codex Fixture/映射/UI；Claude Spike 结论；兼容性更新
- Checkpoints：
  - [ ] Codex `thread/compacted` 由锁定 Schema 和脱敏 Fixture 验证
  - [ ] Compaction 前后 Session/Turn 关联、统计与 UI 提示一致
  - [ ] Claude 未取得真实版本化证据前保持 `unknown`

### DSH-05 Thinking 控制 Probe

- [ ] 通过真实无敏感 Probe 确定 DeepSeek/Claude Thinking 控制接口后再提供 UI
- 前置依赖：DSH-08
- 交付物：版本化 Probe、能力矩阵、可选设置 UI、实施报告
- Checkpoints：
  - [ ] Probe 明确区分 Provider API 参数、Claude Code 环境/参数和宿主显示偏好
  - [ ] 不支持的版本显示 unsupported/unknown，不能通过猜测环境变量启用
  - [ ] 设置只在能力被验证时出现，并通过重启、切换 Provider 和回退测试
