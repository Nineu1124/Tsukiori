# T-DSH-04 Thinking 块完成元数据报告

验证日期：2026-08-14

平台：Windows x64

范围：Runtime Core Thinking Projector、Claude `stream-json`、Codex app-server `0.146.0` Reasoning 通知与 Renderer

## 结论

Thinking 现在由共享 `ThinkingBlockProjector` 按块标识隔离。每个块拥有独立的 started/delta/completed 序列、Chunk 数、UTF-8 总字节数、受限捕获字节数、截断标记、SHA-256 和完成原因。完成事件只保存元数据与 Hash，不复制完整推理正文。

Claude 使用 `content_block` 索引；无 Partial Stream 的 Assistant Thinking 会生成稳定的本地块索引。Codex 只映射锁定 Schema 中已验证的 `item/reasoning/summaryPartAdded`、`summaryTextDelta` 和 `textDelta`，块 ID 同时包含 Reasoning Item、内容类型和索引。未知通知只保留方法、字段名、字节数和内容 Hash 的脱敏 `native.event`，没有提升为受支持 Thinking 事件。

## T-DSH-04-C1 按索引隔离与回放

- [x] 交错块使用独立状态、Hash、Chunk 计数和完成事件，不共享正文缓冲。
- [x] 显式 started、逐 Chunk delta、显式或 Turn 收口 completed 的顺序确定且可重放。
- [x] 只有一个活动块时可兼容缺少索引的旧 Delta；两个以上活动块时缺少索引会 fail closed。
- [x] 重复 Start、完成后事件、无效索引和活动块数量超限均返回可测试的拒绝原因。
- [x] Turn 失败、Runtime Error 或正常结束会把残留块标记为 `incomplete`，不悬挂 UI 状态。

## T-DSH-04-C2 有界内容与完成元数据

- [x] Projector 默认只捕获每块最多 32 KiB、最多同时 32 块、每 Turn 最多 256 块；上限可在测试中缩小且有硬上界。
- [x] 每个 Delta 带 `chunkIndex`、`totalBytes`、`capturedBytes` 和 `truncated`。
- [x] 每个 Completed 带 `chunkCount`、总/捕获字节、截断标记、`contentSha256`、完成原因和 `contentPersisted=false`。
- [x] Renderer 按 `blockId` 使用独立 Map，视觉缓存最多保留 64 KiB，并明确显示截断和未完整结束。
- [x] Transcript 保留原有受限 Delta 以回放可见内容；Completed 不再重复写入完整正文。

## T-DSH-04-C3 已验证映射与未知事件

- [x] Claude Thinking Delta 现在携带 `content_block` 索引；非流式 Thinking 生成完整三段生命周期。
- [x] Codex 映射依据仓库锁定的 `0.146.0` JSON Schema 字段，不猜测其他 Reasoning 通知。
- [x] Codex Reasoning Item 不再显示为普通 Tool Card。
- [x] 未识别 Codex 通知成为只含受限方法、参数键、字节数和 Hash 的 `native.event`。
- [x] Claude 未知消息继续使用既有递归脱敏、有界 `native.event`；Fake Runtime 前向兼容 Fixture 不改变支持等级。

## 验证命令

```powershell
pnpm run build
npm run test:runtime
npm run test:claude-adapter
npm run test:interactive
npm run test:ui
npm run test:snapshot
npm run test:security
npm run check
```

结果：全部命令通过。Runtime 测试覆盖交错块、乱序/歧义拒绝、UTF-8 字节上限、截断、Hash 和失败收口；Interactive 测试使用锁定 Codex Schema 字段完成双块交错回放；UI/Claude/Snapshot/Security 回归保持通过。Checkpoint 校验与秘密扫描保持 clean。

## 产物

- `packages/runtime-core/src/thinking-block.ts`
- `packages/runtime-core/src/index.ts`
- `packages/adapter-claude/src/stream-json.ts`
- `apps/desktop/electron-main/interactive-workspace.ts`
- `apps/desktop/renderer/renderer.js`
- `tests/runtime/thinking-block.test.mjs`
- `tests/claude-adapter/claude-stream-json.test.mjs`
- `tests/interactive/interactive-workspace.test.mjs`
- `tests/ui/basic-ui.test.mjs`
