# G0 阶段 0 Gate 报告

- Gate：G0
- 评估日期：2026-08-02
- 平台：Windows x64
- 结论：通过，可以进入 T1.1 宿主骨架开发
- 证据 Fixture：`tests/fixtures/gates/g0-evidence.json`
- 自动化 Gate：`tests/gates/g0.test.mjs`

## 总结

G0 的五个 Checkpoint 均已独立验证。T0.1 至 T0.4 已完成并分别提交；OpenCode 与 Codex 都证明控制命令和 Handle 级事件读取可以分离；权限与可见性矩阵覆盖 `interceptable`、`observable_only`、`opaque` 和 `unknown`；GUI、Daemon、Runtime 三类崩溃结果均可解释，没有观察到数据破坏，也没有设计自动重放高风险操作；ADR、Contract Schema 和 Runtime Fixture 已由 T0.4 的 Windows CI 成功校验。

本 Gate 只授权开始 T1.1 的宿主骨架，不把 Stage 0 的能力证据自动升级为 Alpha 或 V1 承诺。

## 输入任务与提交

| 任务 | 提交 | 公开 CI |
| --- | --- | --- |
| T0.1 OpenCode | `8df8fe42eea7b1dcaa4222c7304650b5f47daac6` | windows-ci 30729376744：success |
| T0.2 Codex | `426c000821abc7c9a729b37bf96f9a40bcf1ea98` | windows-ci 30718273962：success |
| T0.3 Windows | `190f0264c5022d0f7ba6319cde4c5d6cbf35f515` | windows-ci 30719254807：success |
| T0.4 Adapter Contract | `05206997f601f4166f523e5435e1242beb03af2d` | windows-ci 30729649391：success |

T0.4 CI 地址：<https://github.com/Nineu1124/Tsukiori/actions/runs/30729649391>

## G0-C1 T0.1 至 T0.4 全部完成

- 架构方案中的四个顶层任务及全部子 Checkpoint 都为 `[x]`。
- 每个任务都有独立完成提交、脱敏报告、Fixture 或测试证据。
- Gate 测试逐节解析源文档，若任一 T0 章节仍包含未完成复选框则失败。
- 结果：通过。

## G0-C2 两种 Runtime 的控制与事件流分离

| Runtime | Control Plane | Handle Event Stream | 结果 |
| --- | --- | --- | --- |
| OpenCode 1.18.4 | 带认证的 HTTP SDK v2 请求 | 每个 Handle 一个独立消费的 global SSE | 通过 |
| Codex 0.146.0 | app-server JSON-RPC request/response | 每个进程一个 stdout JSONL reader，分发通知和服务端请求 | 通过 |

两个 Contract Fixture 均声明 `oneReaderPerHandle: true`。Gate 测试还要求 Control 与 Event 描述不同，并由统一合同读取。

## G0-C3 权限能力矩阵覆盖四种状态

| 状态 | 验证样本 | 产品含义 |
| --- | --- | --- |
| `interceptable` | OpenCode shell；Codex command/file write | Runtime 执行前请求宿主决定，只保证该请求可阻止 |
| `observable_only` | Codex Thread/Turn/Item 生命周期事件 | 可记录，不能作为执行阻断点 |
| `opaque` | OpenCode Provider 内部 API 传输 | 行为存在，但协议没有宿主级逐请求审批事件 |
| `unknown` | OpenCode 独立 file-write；Codex structured network | 证据不足，危险能力默认关闭且不承诺 |

Gate 测试要求四个数组都非空，并禁止把 `unknown` 隐式提升为受保护能力。

## G0-C4 崩溃恢复无未解释的数据破坏

| 强杀目标 | 观察状态 | 数据破坏 | 恢复动作 |
| --- | --- | --- | --- |
| GUI | Daemon 与 Runtime 保持运行 | 未观察到 | 重启 GUI，重新订阅快照与增量事件 |
| Daemon | Runtime 变为 orphan | 未观察到 | 重启 Daemon，核对进程指纹并执行状态协调 |
| Runtime | Daemon 保持运行，Runtime 已退出 | 未观察到 | 标记退出，使用 Adapter 的持久 Session 恢复能力 |

安全边界：

- Daemon 恢复不得自动重放高风险操作。
- OpenCode 只验证了空闲 Session 的崩溃恢复；运行中 Turn 仍为 `unknown`。
- Worktree 不被描述为安全沙箱。
- Gate Fixture 对每个场景显式记录 `dataDestructionObserved: false` 和所需恢复动作。
- 结果：通过。

## G0-C5 版本控制与 CI

Gate 自动检查以下输入已被 Git 跟踪：

- `contracts/runtime-adapter-contract.v1.schema.json`
- `docs/adr/0001-runtime-adapter-contract-baseline.md`
- OpenCode/Codex v1 Contract Fixture
- Stage 0 Compatibility Matrix

T0.4 的 `windows-ci` 已在提交 `0520699` 上成功执行冻结安装、Checkpoint/秘密扫描以及全部 credential-free contract tests。GitHub Actions 同时报告依赖 Action 的 Node.js 20 元数据弃用警告；工作流已强制使用 Node.js 24，警告不影响本次测试结论，后续应在上游 Action 提供新版运行时后更新固定 SHA。

## 验证命令与结果

```powershell
npm run test:gate0
npm run test:contract
npm run test:opencode
npm run test:codex
npm run test:windows
pnpm install --offline --frozen-lockfile
npm run check
git diff --check
```

| 测试 | 结果 |
| --- | --- |
| G0 Gate | 5/5 pass |
| Adapter Contract | 4/4 pass |
| OpenCode | 9/9 pass |
| Codex | 5/5 pass |
| Windows | 3/3 pass |
| TODO/依赖检查 | valid：27 tasks、6 gates、3 backlog |
| 秘密扫描 | clean |
| 冻结离线安装 | pass |
| Markdown/Git whitespace | pass |

## 保留的 Unknown

以下能力没有因 Gate 通过而提升：

- OpenCode in-flight Turn crash recovery；
- OpenCode/Codex Connection Epoch 旧审批失效；
- OpenCode/Codex原生事件 Replay；
- Codex Runtime Scope 全局事件；
- Codex structured network approval；
- OpenCode 独立 file-write 与 tool-network permission。

## Gate 决策

- G0：通过。
- 允许下一任务：T1.1 Monorepo 与进程边界。
- 仍禁止：在 T1.1 前引入未经计划的产品能力；把 `unknown` 写成 supported；把权限 Broker 或 Worktree 表述成安全沙箱；在公开 CI 使用真实 Provider 凭据。
