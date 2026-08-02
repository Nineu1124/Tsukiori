# ADR-0001：Runtime Adapter Contract v1 基线

- 状态：Accepted
- 决策日期：2026-08-02
- 对应任务：T0.4
- 依赖证据：OpenCode 1.18.4、Codex app-server 0.146.0、Windows x64 控制面 Spike
- Contract Schema：`contracts/runtime-adapter-contract.v1.schema.json`

## 背景

Tsukiori 必须同时承载协议、进程模型和权限语义不同的 Runtime。Stage 0 已证明 OpenCode 与 Codex 都能完成真实 Turn，但也证明“字段存在”“事件可见”和“宿主可以阻止”是三件不同的事。若 Adapter 将它们压缩为布尔值，UI 会把未验证或不可阻止的行为错误描述成安全保证。

本 ADR 冻结首版 Adapter 证据合同。它只描述已经观测到的能力与边界，不是 Alpha 或 V1 功能承诺。

## 决策

### 1. Control Plane 与 Handle Event Stream 分离

每个 Runtime Handle 必须有两个逻辑通道：

- **Control Plane**：Detect、Probe、Start/Stop、Create/Resume Session、Start/Cancel Turn、RespondToPermission 等有明确请求结果的命令。
- **Handle Event Stream**：每个 Handle 恰好一个底层读取器，持续消费 Runtime 通知、服务端请求和状态事件，再由 Adapter 按 Runtime 原生标识分发。
- 任一控制命令完成，不代表相关事件已经全部到达。
- 多个 Session 不得各自争抢同一个 SSE、stdout 或 socket 读取源。
- Adapter 对外暴露的事件流必须支持取消、缓冲上限和错误终止；背压与重放仍未验证时保持 `unknown`。

OpenCode 的 Control Plane 是带认证的 HTTP SDK v2 请求，Handle Event Stream 是独立的全局 SSE。Codex 的 Control Plane 是 app-server JSON-RPC 请求/响应，Handle Event Stream 是每个进程唯一的 stdout JSONL 读取器，其中同时分发通知和 Runtime 发起的审批请求。

### 2. Runtime Scope 事件不伪造 Session

统一事件进入宿主前使用以下边界：

```ts
type EventScope = "daemon" | "runtime" | "project" | "session" | "turn";

interface EventEnvelope<T = unknown> {
  eventId: string;
  schemaVersion: 1;
  scope: EventScope;
  runtimeHandleId?: string;
  sessionId?: string;
  turnId?: string;
  streamId: string;
  streamSequence: number;
  type: string;
  payload: T;
  runtimeType?: string;
  runtimeEventId?: string;
  runtimeSessionId?: string;
  runtimeTurnId?: string;
  connectionEpoch?: string;
  createdAt: number;
  receivedAt: number;
}
```

认证、Provider、进程、心跳和目录等无法归属到 Session 的事件使用 **Runtime Scope** 或 Project Scope，禁止为了复用 Session 时间线而伪造 `sessionId`。OpenCode 已观察到此类全局事件；Codex 本轮未注入无 Session 的认证或 Provider 事件，因此其 Runtime Scope 事件能力保持 `unknown`。

重连必须生成新的 `connectionEpoch`，旧连接上的待审批引用必须失效。Stage 0 只验证了进程替换与恢复，没有验证旧审批失效，因此两个 Runtime 的该能力都保持 `unknown`。

### 3. SupportLevel 与 EnforcementLevel 分开

```ts
type SupportLevel =
  | "supported"
  | "experimental"
  | "degraded"
  | "unsupported"
  | "unknown";

type EnforcementLevel =
  | "runtime_sandbox"
  | "os_sandbox"
  | "interceptable"
  | "observable_only"
  | "opaque"
  | "unknown";
```

判定规则：

| 值 | 必须满足的证据 | UI/产品规则 |
| --- | --- | --- |
| `interceptable` | 真实 Runtime 请求宿主在执行前做决定，且拒绝可阻止该次操作 | 只表述为“该请求可阻止”，不得扩大成 OS 沙箱 |
| `observable_only` | 真实事件在操作发生前后可稳定观测，但宿主没有阻止点 | 显示“仅观察，不能阻止” |
| `opaque` | 已验证该行为存在，同时协议没有可靠事件或决策点 | 显示“宿主不可见”，禁止统一审批承诺 |
| `unknown` | 没有足够运行时证据，或只看到 Schema/配置字段 | 显示“未验证”，危险能力默认关闭，不进入 Alpha/V1 承诺 |

`opaque` 是已知的不可见边界；`unknown` 是证据不足。二者不得互换。Worktree 仅提供代码隔离，不属于任何 EnforcementLevel 的安全沙箱。

任何 SupportLevel 或 EnforcementLevel 为 `unknown` 的能力，在 Contract Fixture 中必须使用 `commitment: "not_committed"`。用户覆盖可以改变运行配置，但不能把证据等级自动提升为 `supported`。

### 4. v1 证据合同

每个 Runtime Contract Fixture 必须包含：

- Runtime 类型、版本、协议和推荐 Runtime Scope；
- 原始 Capability Matrix 的仓库相对路径与 SHA-256；
- Spike 报告路径；
- Control Plane、Handle Event Stream、单读取器约束；
- Runtime Scope、Connection Epoch、Event Replay 的独立能力记录；
- 能力的 SupportLevel、EnforcementLevel、Commitment 和脱敏证据；
- 显式 unknown 清单与已知问题。

统一 Harness 必须读取 OpenCode 和 Codex 的同一结构，核对源矩阵 Hash、Runtime 版本、能力名称和等级，并拒绝：

- 未知枚举值；
- 重复能力名；
- 源矩阵与 Contract Fixture 不一致；
- `unknown` 被标为 Stage 0 承诺；
- 证据路径逃逸仓库；
- 缺失的报告或能力矩阵。

## 兼容性基线

| Runtime | 已验证版本 | 推荐 Scope | Control Plane | Handle Event Stream |
| --- | --- | --- | --- | --- |
| OpenCode | 1.18.4 | worktree | HTTP SDK v2 | global SSE |
| Codex | 0.146.0 | project | app-server JSON-RPC | stdout JSONL 单读取器 |

权限和可见性矩阵保存在 `tests/fixtures/adapter-contract/v1/compatibility-matrix.json`。其中：

- OpenCode shell 和 Codex command/file change 为 `interceptable`；
- Codex 生命周期事件为 `observable_only`；
- OpenCode Provider 内部 API 传输存在，但没有宿主级逐请求审批事件，因此为 `opaque`；
- OpenCode 独立 file-write 审批、Codex structured network approval 等未实测能力为 `unknown`。

此矩阵覆盖的是 Stage 0 知识状态，不代表 V1 已实现对应 UI 或 Broker。

## Spike 失败与决策

| 来源 | 观察到的失败或限制 | 决策 | 是否推翻架构 |
| --- | --- | --- | --- |
| OpenCode 1.18.4 | Permission 配置要求对象；同步 Prompt 采样等待过久；空闲状态可能缺失；SSE 必须显式关闭 | Adapter 使用版本化配置映射、异步 Turn、快照+事件核对和显式流清理 | 否 |
| OpenCode 1.18.4 | 只验证了空闲 Session 的 Server 崩溃恢复 | 运行中 Turn 恢复保持 `unknown`，不得自动重放高风险操作 | 否 |
| Codex 0.142.5 | 当前模型服务拒绝旧客户端 | Probe 必须同时锁定 Runtime 版本与 Schema Hash；基线提升到 0.146.0 | 否 |
| Codex 0.146.0 | WebSocket sampling 超时并回退 HTTPS | 传输降级作为诊断状态，不伪装成 Turn 失败 | 否 |
| Codex 0.146.0 | 未观察到 structured network approval | 能力保持 `unknown`，不从 Schema 字段推导 supported | 否 |
| Windows Named Pipe | `NamedPipeServerStreamAcl.Create` 路径在本机被拒绝 | 使用并验证 `CurrentUserOnly` 的实际 ACL；生产实现必须复查 Peer Identity | 否 |
| Windows PID reuse | 未强制制造真实 OS PID 复用 | 生产控制面必须比较 PID、创建时间和可执行文件指纹；Stage 0 使用 stale fingerprint 注入 | 否 |
| node-pty | 一次性 PowerShell `-Command` 在 ConPTY 下不能可靠退出 | 打包验收使用交互式读写和显式退出，不以一次性命令作为唯一探测 | 否 |

没有发现需要放弃“本地 Daemon + Runtime Adapter + Worktree”总体架构的失败。上述限制均被转化为版本探测、保守降级或明确恢复规则，没有通过降低 Checkpoint 标准来绕过。

## 被拒绝的方案

- 一个布尔 `supported` 同时表示协议存在、事件可见和宿主可阻止：无法表达真实安全边界。
- 每个 Session 独立读取底层事件源：会造成跨 Session 争抢和丢事件。
- 所有事件强制带 Session ID：会污染 Runtime Scope 事件并破坏恢复语义。
- 依据 Schema 字段或 Provider 清单直接承诺能力：缺少真实运行证据。
- 把 Worktree 描述成沙箱：它不能阻止网络、外部目录或进程行为。
- 未验证崩溃恢复时自动重放 Turn：可能重复执行高风险副作用。

## Checkpoint 与验证

- T0.4-C1：Control Plane、Handle Event Stream、Runtime Scope 和 EventEnvelope 已冻结。
- T0.4-C2：`interceptable`、`observable_only`、`opaque`、`unknown` 的证据规则已冻结。
- T0.4-C3：同一 Contract Test Harness 读取 OpenCode 与 Codex Fixture，并核对源矩阵 Hash。
- T0.4-C4：所有未验证项使用 `unknown` + `not_committed`。
- T0.4-C5：T0.1 至 T0.3 的失败和架构结论已逐项记录。

验证命令：

```powershell
npm run test:contract
npm run test:opencode
npm run test:codex
npm run test:windows
npm run check
```

## 后果

- T1 起所有正式 Adapter 必须输出 v1 Contract 所需信息，后续协议变更通过新 Schema 版本演进。
- 运行时升级、执行环境变化或 Adapter 版本变化必须重新 Probe，不复用旧证据结论。
- Stage 0 Contract Fixture 可进入公开 CI；真实 Provider 凭据、原始事件和 Prompt 仍只保留在本机私有路径。
- G0 可以基于机器可读矩阵验证控制/事件分离和四类执行知识状态，但仍须独立执行恢复与安全 Gate。
