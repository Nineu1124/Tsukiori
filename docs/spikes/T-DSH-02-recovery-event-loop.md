# T-DSH-02 恢复事件闭环报告

验证日期：2026-08-14

平台：Windows x64

范围：Daemon Named Pipe、Desktop Supervisor 与 Runtime Recovery Projection

## 结论

Daemon/IPC 恢复现在使用带事实的判别联合，明确区分 `incremental_replay`、`snapshot_recovery` 和 `unrecoverable`。Desktop Supervisor 保存最近一次订阅结果，并通过既有 `daemon:status` 边界公开恢复模式与脱敏事实；常驻 Daemon 被新 GUI 附着时也会重新认证、重新订阅和记录恢复结果。

Runtime 能力继续按证据分级：Fake 与 OpenCode 已验证 Snapshot Recovery，结果为 `degraded`；Claude 与 Codex 尚无版本化 Runtime 恢复证据，结果保持 `unknown`/`unrecoverable`。本任务没有把未知能力提升为支持，也没有自动重放原始 Runtime 内容。

## T-DSH-02-C1 跨 Runtime 恢复投影

- [x] Fake 与 OpenCode 返回 `snapshot_recovery`、`degraded`、Replay `unsupported`、Snapshot `supported`。
- [x] Claude 与 Codex 返回 `unrecoverable`、`unknown`，Replay/Snapshot 均保持 `unknown`。
- [x] EventNormalizer 只允许已验证 Runtime 生成公共恢复事件；对 Claude/Codex 的 Snapshot 请求 fail closed。
- [x] 公共投影只包含 SupportLevel、原因和游标事实，不保存 Prompt、Transcript 或 Provider 响应。

## T-DSH-02-C2 IPC 三态闭环

- [x] 游标连续且 Snapshot 版本一致时返回增量补发，并要求事件从请求游标后严格连续到最新序号。
- [x] Snapshot 版本变化或保留窗口出现缺口时返回 Snapshot Recovery，并携带可验证原因。
- [x] 既无法补发、又没有可用 Snapshot 时返回显式 `unrecoverable`，不返回伪造状态。
- [x] 客户端验证模式/状态组合、Snapshot 版本、单调序列、请求游标和最终序号；不一致响应直接拒绝。
- [x] `daemon:status` 返回 Supervisor 最近一次 `recoveryMode` 与 `recovery` 事实，渲染层仍只能通过固定 Preload API 读取。

## T-DSH-02-C3 失败注入与恢复

- [x] Named Pipe Host 支持事件保留缺口、Snapshot 不可用、重复事件和乱序事件的确定性注入。
- [x] 重复/乱序响应在 Desktop Client 投影前被拒绝，无法污染已知状态。
- [x] Daemon 正常启动、GUI 释放后常驻再附着、认证停止、版本不兼容和进程退出均由 Host 生命周期测试覆盖。
- [x] Runtime Harness 覆盖 disconnect、crash、duplicate、out-of-order、backpressure、stale epoch 与未知事件。

## 安全边界

- `autoReplay` 固定为 `false`；恢复事实不能触发未经用户确认的内容重放或写操作。
- 恢复原因使用受限标识符，事件与 Snapshot 仍通过既有协议结构验证。
- Claude/Codex 的恢复语义在取得真实、版本化、脱敏 Fixture 前保持 `unknown`。
- Fixture 与审计不包含 Token、API Key、完整 Prompt、用户源码或机器专属路径。

## 验证命令

```powershell
pnpm run build
npm run test:host
npm run test:ipc
npm run test:runtime
npm run test:recovery
npm run test:opencode-adapter
npm run check
```

结果：全部命令通过。IPC 覆盖三种恢复状态、事件缺口、Snapshot 不可用、重复/乱序和无效游标；Host 覆盖进程强退与常驻重连；Runtime/Recovery 覆盖跨 Runtime 能力矩阵及失败注入。Checkpoint 校验与秘密扫描保持 clean。

## 产物

- `packages/protocol/src/ipc.ts`
- `apps/daemon/windows/named-pipe-host.ps1`
- `apps/desktop/electron-main/named-pipe-client.ts`
- `apps/desktop/electron-main/daemon-supervisor.ts`
- `apps/desktop/electron-main/main.ts`
- `packages/runtime-core/src/recovery-projection.ts`
- `tests/ipc/named-pipe.test.mjs`
- `tests/host/daemon-lifecycle.test.mjs`
- `tests/runtime/recovery-projection.test.mjs`
