# T-DSH-08 Codex Compaction 事件报告

验证日期：2026-08-14

平台：Windows x64

证据基线：Codex app-server `0.146.0` 非实验 JSON Schema，SHA-256 `776ab888b2e673311a4c53ed086d66b061dcfdc8ca595b4cf43220c2b3d04368`

## 结论

Tsukiori 现在只对已锁定的 Codex `thread/compacted` 与 `thread/tokenUsage/updated` 建立公共投影。投影在接收时校验 Runtime Thread/Turn 身份，用确定性 `compactionId` 关联压缩通知与后续累计用量；会话时间线显示压缩发生时观察到的累计 Token 与后续累计 Token，用量页显示 Codex 累计 Token 与 Compaction 次数。事件写入本机 Transcript 后可在重启和 Checkpoint 回退后重建统计。

`tokenUsage.total` 只按 Schema 语义作为累计用量展示。Tsukiori 不把它解释为当前上下文大小，也不据此推断压缩释放量或成本。

Claude Code `2.1.201` 现有版本化证据没有等价原生 Compaction 通知，因此兼容性 Fixture 明确保持 `unknown`；宿主没有从通用消息、Thinking 或 Token 数猜测压缩发生。

## T-DSH-08-C1 锁定 Schema 与脱敏 Fixture

- [x] `ContextCompactedNotification` 的必填字段为 `threadId`、`turnId`，且通知方法为 `thread/compacted`。
- [x] `ThreadTokenUsageUpdatedNotification` 的必填字段为 `threadId`、`turnId`、`tokenUsage`。
- [x] Fixture 与 Schema Hash、Runtime 版本绑定，不含 API Key、认证、Prompt、消息、Transcript 或源码。
- [x] Schema 同时包含新版 `contextCompaction` Item；当前只承诺本任务有 Fixture 覆盖的通知映射，不猜测额外字段。

## T-DSH-08-C2 Session/Turn、统计与 UI 一致性

- [x] 通知 Thread 与 Session Thread 不一致或通知 Turn 与活动 Turn 不一致时 fail closed，保存脱敏 `native.event`。
- [x] `context.compacted` 保存压缩发生时观察到的累计 Token、稳定 ID、Thread、Turn、序号和 `awaiting_usage` 状态。
- [x] 随后的 `context.compaction.updated` 复用同一 ID，保存用量通知 Turn、同 Turn/后续 Turn 关联和后续累计用量，不宣称压缩收益。
- [x] Runtime Core 拒绝负数、非安全整数和不完整 Token Usage，Pending 与每 Session Compaction 总数均有硬边界。
- [x] Renderer 按稳定 ID 更新同一条 Compaction 卡片；重放不会生成互不关联的重复提示。
- [x] Snapshot 的 Token/Compaction 统计从本地 Transcript 投影重建，未依赖 Provider 账单估算。

## T-DSH-08-C3 Claude 证据边界

- [x] 兼容性 Fixture 将 Codex `0.146.0` 标记 `supported`。
- [x] Claude Code `2.1.201` 标记 `unknown`，理由为没有版本化原生事件证据。
- [x] 没有为 Claude 添加环境变量、CLI 参数或虚构 UI 开关。

## 验证命令

```powershell
pnpm run build
npm run test:runtime
npm run test:interactive
npm run test:ui
npm run test:snapshot
npm run test:security
npm run check
```

结果：全部命令通过。Runtime 测试覆盖 Schema/Hash、身份关联、前后用量、恢复与 fail-closed；Interactive 测试覆盖真实宿主事件顺序、持久化统计；UI/Snapshot/Security 回归保持通过。Checkpoint 校验有效，秘密扫描 clean。

## 产物

- `packages/runtime-core/src/codex-compaction.ts`
- `apps/desktop/electron-main/interactive-workspace.ts`
- `apps/desktop/renderer/index.html`
- `apps/desktop/renderer/renderer.js`
- `apps/desktop/renderer/styles.css`
- `tests/fixtures/codex/0.146.0/compaction.sanitized.json`
- `tests/runtime/codex-compaction.test.mjs`
- `tests/interactive/interactive-workspace.test.mjs`
- `tests/ui/basic-ui.test.mjs`
