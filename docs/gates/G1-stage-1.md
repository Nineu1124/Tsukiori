# G1 阶段 1 Gate 报告

- Gate：G1
- 评估日期：2026-08-02
- 平台：Windows x64
- 结论：通过，可以进入 T2.1 Project 与 Worktree 开发
- 证据 Fixture：`tests/fixtures/gates/g1-evidence.json`
- 自动化 Gate：`tests/gates/g1.test.mjs`

## 总结

G1 的五个 Checkpoint 均已独立验证。T1.1 至 T1.5 分别完成宿主边界、本机 IPC、SQLite、Fake Runtime 事件系统和 Permission/Attention 工作台；三个 Fake Session 通过同一 Handle reader 运行且无串线；重复、乱序、断线、未知事件和旧 Epoch 全部通过；SQLite 重开恢复历史与 pending 权限，真实 Electron Renderer 崩溃不影响独立 Daemon 或活动 Fake Session；IPC、数据库和 Renderer 的基础安全测试全部通过。

本 Gate 只授权进入 T2.1，不把 Fake Runtime 结果升级为 Codex/OpenCode 支持声明，也不把 Worktree 或 Permission Broker 描述为安全沙箱。

## 输入任务与提交

| 任务 | 提交 | Windows CI |
| --- | --- | --- |
| T1.1 Monorepo/进程边界 | `b6cdea3bc7b1588c21d4dfad27af47a32b49a7c0` | 30730459610：success |
| T1.2 本机 IPC | `a20f90aa79f6749bf0743f40f2c3a234771c5447` | 30731608697：success |
| T1.3 SQLite | `5a75326b72692f813ba65d22824d595647c582ff` | 30732385385：success |
| T1.4 Fake Runtime | `305a1fd9f7c1d742805cee4bce645a9d009219e5` | 30732763749：success |
| T1.5 Permission/Attention | `066e1cfd82d1e0b38f145c2eb8e355b24f923d33` | 30733399052：success |

T1.5 CI：<https://github.com/Nineu1124/Tsukiori/actions/runs/30733399052>

## G1-C1 T1.1 至 T1.5 全部完成

Gate 测试逐节解析架构源文档。每个任务必须存在至少一个 `[x]`，且任务节内不能保留 `[ ]`。五个任务各自有完成提交、实施报告与自动化证据。

结果：通过。

## G1-C2 三个 Fake Session 无串线

复用 Adapter Contract Harness，在一个 `FakeRuntimeAdapter` Handle 和一个事件 reader 上创建三个 Session；每个 Session 产生六个事件。Gate 验证共 18 个 Session Event、三个唯一 Session ID，并由 Harness 逐 Session 验证事件类型与 sessionSequence 1～6。

结果：通过。

## G1-C3 故障与协议边缘

Gate 同时读取 T1.4 Fixture 和自身 Fixture，要求两者覆盖：

- duplicate；
- out_of_order；
- disconnect；
- unknown_event；
- stale_connection_epoch。

专项 Runtime 测试还覆盖 backpressure 与 runtime_scope_event，未知事件在限额与脱敏后不会阻断后续已知事件。

结果：通过。

## G1-C4 GUI 重启与 Renderer 崩溃恢复

- Permission 测试关闭并重新打开同一 SQLite 文件，新的 Broker/UI 客户端恢复完整 Attention 历史和 pending 权限。
- Epoch 变化使旧请求 invalidated，旧响应不能改变新连接。
- 真实 Electron smoke 在权限、Tool、Attention 卡片可观察后强杀 Renderer。
- 强杀后 Daemon 可继续 probe，Fake Session 保持 `running/healthy`。

结果：通过。

## G1-C5 基础安全

- IPC：CurrentUserOnly Named Pipe、同 SID peer 校验、HMAC challenge-response、协议/实例/epoch 校验。
- 数据库：所有 JSON/Blob Sink 经过 SecretGuard，SQLite/WAL/Blob 负例不写入测试秘密。
- Renderer：`nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`、`webSecurity: true`；Preload 只有固定 invoke API；不使用 `innerHTML`、`eval` 或事件透传。
- CI：T1.1～T1.5 的 Windows CI 均为 success，公开 CI 不需要 Provider 凭据。

结果：通过。

## 失败与修正记录

1. G1 首次运行时安全测试读取了不存在的 `ipc.security.currentUserOnly`，而 T1.2 正式 Fixture 的实际结构是 `transport.aclMode`、`peerProcessIdVerified` 与 `peerUserSidVerified`。Gate 改为同时断言 `aclMode === current_user_only`、peer PID 已验证和 peer SID 已验证；没有降低安全标准，修正后全套重跑。
## 验证命令与结果

```powershell
pnpm run build
pnpm run typecheck
npm run test:host
npm run test:ipc
npm run test:database
npm run test:runtime
npm run test:permission
npm run test:ui
npm run test:gate1
npm run check
git diff --check
```

| 测试 | 结果 |
| --- | --- |
| G1 Gate | 5/5 pass |
| Host/Electron | 6/6 pass |
| IPC | 5/5 pass |
| Database | 5/5 pass |
| Runtime | 7/7 pass |
| Permission | 6/6 pass |
| UI | 1/1 pass |
| Workspace typecheck | 9/9 packages pass |
| TODO/依赖检查 | valid：27 tasks、6 gates、3 backlog |
| 秘密扫描 | clean |

## Gate 决策

- G1：通过。
- 允许下一任务：T2.1 Execution Environment 与 Project Manager。
- 仍禁止：跳过 T2 的 durable operation/worktree Gate；把 Fake Runtime 证据写成真实 Runtime 支持；在公开 CI 使用凭据；让 Renderer 绕过固定 IPC 或 Broker。