# S2 Checkpoint/Rewind 实施与验证报告

- 日期：2026-08-09
- 平台：Windows Native x64
- Runtime：Codex app-server `0.146.0`、Claude Code `2.1.226`
- 结论：PARTIAL PASS（本地一致性闭环完成；真实 Runtime 与强杀矩阵待验证）
- 决策：`docs/adr/0005-conversation-checkpoint-rewind.md`

## 已交付范围

- 版本化 Checkpoint manifest 与独立 Git ref；
- HEAD、真实 Index Tree、包含未跟踪非忽略文件的 Worktree Tree；
- 本地 Transcript 副本、事件数与 SHA-256；
- Codex Thread/Turn 和 Claude Session/Assistant Message 锚点；
- Preview、用户确认、自动 Recovery Checkpoint、恢复后 Tree/Transcript 校验；
- Desktop IPC/Preload 固定接口与 Changes 面板操作入口；
- Codex `thread/fork` 与 Claude `--resume-session-at --fork-session` 的跨层续接。

## Fail-closed 条件

- Session 正在运行、等待权限或尚无完整 Turn；
- 对话持久化关闭，或 Transcript 损坏/超限；
- Git 存在未解决冲突、对象/ref 不匹配或变更文件超过 256 MiB；
- Runtime 锚点缺失；
- manifest 身份、对象 ID、路径、事件计数或哈希无效；
- 恢复后 Index/Worktree Tree 复算不一致。

## 自动验证结果

定向验证：25 项通过，0 失败。其中服务级恢复测试覆盖 Recovery Checkpoint 的反向回退；Desktop 测试分别覆盖 Codex 和 Claude 的代码、Transcript、Runtime 历史一致性；UI 测试覆盖 Preview/确认和 Preload 白名单。

完整验证命令：

```powershell
pnpm run build
pnpm run typecheck
node --test tests/claude-adapter/*.test.mjs tests/interactive/*.test.mjs tests/ui/*.test.mjs
npm run check
git diff --check
```

最终通过数量以本次完整验证输出为准，不在文档中预先宣称。

## 当前可接受停点

用户可以为已完成 Turn 的 Codex/Claude Session 创建本地 Checkpoint，预览后把代码、暂存区和对话回到目标状态，并从 Runtime 的目标 Turn/Message 派生新历史；分支 HEAD 保持不变，失败时保留自动 Recovery Checkpoint。

此停点不承诺跨设备备份、ignored 文件恢复、进程在回退阶段间强杀后的自动续事务，或未经过真实 CLI E2E 的 Claude Message Rewind。

## 后续工作

1. 对真实 Codex/Claude Runtime 做无副作用 Rewind E2E，并归档脱敏证据；
2. 把 Rewind 写入 Durable Operation 日志，注入每个阶段的进程强杀并自动对账；
3. 设计统一 Event Store 后再替换当前 JSONL Transcript，不在本阶段引入双写真相源；
4. 增加 Checkpoint 保留/清理策略和空间占用可视化。
