# T-DSH-09 不确定操作详情与恢复入口报告

验证日期：2026-08-13

平台：Windows x64

范围：RecoveryManager 的 uncertain Durable Operation、Attention 安全投影和桌面恢复卡

## 结论

不确定操作现在拥有诊断、放弃和受约束重试三类动作。Renderer 只消费 RecoveryManager Attention 中的白名单投影；`requestPayload`、`resultPayload` 和错误原文不会进入恢复卡。原操作永远不会被自动重放，重试只能请求注入的操作处理器创建新操作。

当前阶段完成的是 Recovery/Attention/Preload/UI 合同和真实 Electron Smoke 闭环；正式 Daemon、Runtime、IPC 恢复流将在后续 DSH-02 接入该合同。在接入前，普通 Interactive Snapshot 不会伪造不存在的 Recovery Attention。

## T-DSH-09-C1 安全详情

- [x] 恢复卡只显示 `operationId`、`operationType`、`reason` 和 `autoReplay=false` 边界说明。
- [x] Operation ID、Operation Type 和动作均经过本地 Allowlist；所有内容用 `textContent` 构建。
- [x] Renderer 与 Preload 中不存在 `requestPayload` 访问；Recovery 回调只收到 ID、类型和可选 Session ID。

## T-DSH-09-C2 恢复动作

- [x] `diagnostics` 返回安全事实且不改变 Operation 状态。
- [x] `abandon` 把 uncertain Operation 持久化为 failed，并以 `recovery_abandoned_by_user` 收口 Attention。
- [x] `retry` 不重放原请求；只有注入处理器明确接受时，原 Operation 才以 `superseded_by_manual_retry` 收口。
- [x] `permission_response` 禁止重试，避免向失效 Runtime 重发一次性决定。

## T-DSH-09-C3 异常与可观察性

- [x] 不存在、已处理和非法动作返回拒绝或错误，不会改变持久化状态。
- [x] 重试处理器缺失、拒绝或抛错均保持 uncertain，供用户继续诊断/放弃。
- [x] UI 显示动作状态和安全原因；非诊断动作完成后禁用同一卡片的其他按钮。
- [x] Electron Smoke 验证 Recovery 卡字段、三个动作按钮和 Preload/IPC 诊断结果。

## 验证命令

```powershell
pnpm --filter @tsukiori/recovery-manager build
node --test tests/recovery/recovery-manager.test.mjs
npm run test:ui
npm run test:host
npm run check
```

结果：Recovery 4/4、UI 14/14、Host 9/9 通过。Checkpoint 校验保持 30 个 V1 任务、6 个 Gate、3 个后续任务池有效；秘密扫描 434 个文件，状态 clean。

## 产物

- `packages/recovery-manager/src/index.ts`
- `apps/desktop/electron-main/main.ts`
- `apps/desktop/preload/index.cjs`
- `apps/desktop/renderer/renderer.js`
- `apps/desktop/renderer/styles.css`
- `tests/recovery/recovery-manager.test.mjs`
- `tests/host/electron-smoke.test.mjs`
- `tests/ui/basic-ui.test.mjs`
