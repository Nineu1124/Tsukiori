# T-DSH-01 SubAgent 生命周期持久化报告

验证日期：2026-08-14

平台：Windows x64

范围：Codex/Claude 脱敏 `subagent.event`、InteractiveWorkspace、Agent Activity 与 Attention Center

## 结论

InteractiveWorkspace 现在把现有 `subagent.event` 合同投影到独立、有界、原子写入的本地状态文件。投影只保存 Runtime/Session 来源、受限标识符、父级引用、角色、五态生命周期和源事件顺序；它不依赖“保存对话”设置，也不保存原始 Runtime Prompt、消息、Transcript 路径或 Native Payload。

Agent Activity 与 Attention Center 共用这一个持久化投影：正常生命周期继续显示在 Activity；只有 `failed`、`waiting` 和 `action_needed` 产生 Attention。进入 `completed` 后对应 Attention 自动消失。用户可从异常卡片回到所属 Session，Renderer 不把它伪装为权限请求。

## T-DSH-01-C1 五态、重启与来源隔离

- [x] `started`、`progress`、`completed`、`failed`、`waiting` 由统一状态机投影；未知状态不猜测、不落盘。
- [x] 同一 Runtime/Session/SubAgent 只接受更新的时间与源序号，旧事件不会倒退当前状态。
- [x] 投影文件重新打开后恢复相同记录和 Attention；旧 Transcript 只用于一次安全 reconcile。
- [x] 主键同时包含 Runtime 类型、Session 和 Runtime SubAgent ID；不同 Runtime 的同名 Agent 不串线。
- [x] 状态文件最多 2,000 条、2 MiB，并通过临时文件替换写入。

## T-DSH-01-C2 Attention 语义

- [x] `started`、`progress` 与 `completed` 不创建 Attention。
- [x] `failed` 创建 `subagent_failed`，普通等待创建 `subagent_waiting`，需要用户操作创建 `subagent_action_needed`。
- [x] Attention Payload 仅包含 Runtime 类型、SubAgent ID、父引用、角色、状态、原因和更新时间。
- [x] Interactive Renderer 同时显示 Permission 与 SubAgent Attention，并提供“查看 Session”入口。
- [x] 实时 `subagent.event` 会刷新 Snapshot；应用重启后从相同投影恢复。

## T-DSH-01-C3 隐私与拒绝边界

- [x] `prompt`、`message`、`transcript_path` 等未列入投影 Schema，即使出现在输入 Payload 也不会写入。
- [x] Runtime/Session/Agent/父级 ID 必须符合受限标识符；含空格、换行、路径文本或异常字符的 ID 被拒绝。
- [x] 角色字段受字符集与长度限制；不合格内容降级为固定 `Runtime Subagent`。
- [x] 文件中的记录 ID 必须等于来源三元组的 SHA-256 派生 ID，篡改或无效文件 fail closed。

## 验证命令

```powershell
pnpm run build
npm run test:interactive
npm run test:ui
npm run test:claude-adapter
npm run test:security
npm run check
```

结果：全部命令通过。投影单元测试覆盖五态、乱序、跨 Runtime 同名来源隔离、跨重启恢复、三类 Attention、无效文件与敏感字段拒绝；Interactive/UI 回归覆盖生产接线和可处理入口。Checkpoint 校验与秘密扫描保持 clean。

## 产物

- `apps/desktop/electron-main/subagent-projection-store.ts`
- `apps/desktop/electron-main/interactive-workspace.ts`
- `apps/desktop/renderer/renderer.js`
- `tests/interactive/subagent-projection-store.test.mjs`
- `tests/interactive/interactive-workspace.test.mjs`
- `tests/ui/basic-ui.test.mjs`
