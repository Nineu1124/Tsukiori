# ADR-0004：Claude 原生 `stream-json` Adapter 基线

- 状态：Accepted
- 日期：2026-08-09
- 观察版本：Claude Code `2.1.226`
- 决策范围：B1 的原生 Runtime 基线；不宣告 B1 完成

## 背景

V1 已在 Desktop Main Process 内提供受限 Claude Code `--print --output-format stream-json` Bridge，但该实现与 UI 生命周期耦合，只有源码字符串断言，没有独立的版本锁、认证探测、Rich Event 合同、未知事件保留、失败收口或中断测试。

迁移决策报告把 Provider/Auth Contract、完整 Claude Adapter 和 Rich Chat Events 列为 S1 的首要范围。架构事实源同时要求 Claude 区分两种认证和数据出口：

1. 使用用户本机 Claude Code 登录的原生 Runtime；
2. 使用用户显式配置 API Key 的 Provider 模式。

本机 `claude --help` 和 `claude auth status --help` 证明 `2.1.226` 提供 `stream-json`、Session Resume/Fork、Hook Event、Subagent Text Forwarding、MCP 配置、Skills、结构化输出和 JSON 认证状态。公开 Help 没有列出宿主双向权限协议；对参考源码中 `controlSchemas.ts`、`sessionRunner.ts` 与 stdio permission callback 的审计进一步确认，锁定版本还接受隐藏的 `--permission-prompt-tool stdio`，并通过 `control_request/can_use_tool` 与 `control_response` 交换一次性决策。

## 决策

1. 新增独立 workspace 包 `@tsukiori/adapter-claude`，Desktop 不再拥有一份私有 Claude 解析器。
2. 当前原生协议锁定 Claude Code `2.1.226`：旧版本为 `incompatible_older`，更新版本为 `unverified_newer`，默认拒绝启动，直到 Fixture 与真实 Probe 更新。
3. 本机登录模式在启动前清除 Provider API 环境变量，再使用 Claude Code 自己的 OAuth/Keychain 状态；宿主只记录 `loggedIn`、认证方法类别和 Provider 类别，不读取身份或 Token。
4. API Provider 模式只注入用户选中的凭据，并传入 `--bare`，避免静默借用本机 OAuth、Keychain、Hooks、Plugins、LSP 或项目自动发现配置。
5. `stream-json` 映射 Text、Thinking、Tool Start/Result、Usage、Session 和 Turn 结果；未知、畸形和超限消息转为有界、脱敏事件，不静默吞掉。
6. 进程异常退出、缺少 Result 和用户中断都必须生成终态 `turn.completed`，避免 Session 永久停留在 Running。
7. Claude stdin 改为 `stream-json` 用户消息并保持到 Turn Result；`can_use_tool` 进入统一 Attention Center，允许/拒绝回包必须同时命中 connection epoch、Turn 和 request ID，重复、过期、取消与中断请求不可再次响应。
8. 权限工具输入只在 Adapter 当前 Turn 内存中保留；Renderer 只接收脱敏、限长摘要，Secret、Prompt 与权限原始输入不进入 Workspace State 或 Transcript。
9. Claude 整体支持级别继续显示 `degraded`。认证与 Provider 边界、Rich Event、锁定版本的权限 Broker、宿主 Checkpoint/Rewind，以及脱敏 Subagent Activity 投影已形成 Fixture 合同；Hooks 控制、Skills/MCP 作用域、完整 Subagent 编排、进程级恢复与无副作用真实 CLI E2E 仍属于 B1 后续工作。

## 能力结论

| 能力 | 当前等级 | 说明 |
|---|---|---|
| Detect/Version Lock | supported | 绑定 `2.1.226`，新版本默认 fail closed |
| Native Auth Probe | supported | 只投影脱敏状态，不读取 Token 或账号 |
| API Provider Isolation | supported | 只注入选中 Secret，使用 `--bare` |
| Session Start/Resume | supported | UUID Session ID；首 Turn/Resume 分离 |
| Text/Thinking/Tool/Result | supported | 有无 Partial Message 均避免重复 Text/Tool |
| Cancel/Process Failure | supported | Interrupted/Failed 均形成 Turn 终态 |
| Unknown Event | degraded | 已脱敏、有界并暴露；尚未进入统一持久化 Event Store |
| Permission | degraded | `2.1.226` stdio 双向审批已通过源码审计、Adapter 与 Desktop Fixture；真实 CLI 无副作用 E2E 尚未归档，且协议未出现在公开 Help |
| Hooks | degraded | 可观察 Hook Event，尚无宿主 Hook 控制合同 |
| Skills/MCP | degraded | 宿主可扫描项目配置并显示真实 Scope；Codex 可与 app-server 实际清单对账，Claude stream-json 只报告 MCP 数量，名称/健康/Skill 清单保持 unknown；API `--bare` 模式尚未接显式作用域配置 |
| Subagents | degraded | Claude 结构化事件与 Codex collab item 已投影脱敏 Runtime ID、父工具 ID、名称和状态，并与 Team Activity 分栏显示；Prompt、Message、Transcript Path 不进入投影，完整父子树、控制和恢复仍未验证 |
| Fork | degraded | `--resume <source> --fork-session` 已通过源码审计、Adapter/Desktop Fixture；真实 CLI E2E 尚未归档 |
| Checkpoint | degraded | 宿主已原子保存 Transcript、Git Index/Worktree Tree 和 Runtime Message 锚点；下一 Turn 使用 `--resume-session-at` 派生新 Session，真实 Claude CLI E2E 与进程级事务恢复仍待归档 |

## 未采用方案

### 继续保留 Desktop 内联 Bridge

拒绝。它无法作为 Desktop/CLI/未来 Daemon 的共同 Runtime 边界，也无法独立做版本、恢复和安全测试。

### 仅为权限立即采用 Agent SDK

暂缓。锁定版本的 CLI Structured I/O 已能完成一次性权限决策；SDK 对 Hooks、Subagents、MCP 和 Checkpoint 的增益仍需单独验证版本、分发体积、API Key 认证、第三方产品条款和与本机订阅登录的边界，不能仅因权限需求把 SDK 与本机登录混成同一模式。

### 对任意新 Claude Code 版本继续启动

拒绝。CLI JSON 不是版本化 Schema 包；更新版本只能先显示为 `unverified_newer`，不能把未实测行为标为 supported。

## 安全与兼容性后果

- Renderer 仍然没有 Node 权限，认证探测与进程启动都在 Main Process/Adapter 边界内。
- API Key 继续只存在 Credential Manager 和目标子进程环境，不进入 Workspace State、事件 Fixture 或 Renderer Snapshot。
- Native 模式不会继承宿主进程里的 Provider API Key。
- 权限输入中的常见 Secret 字段与 Bearer/API Key 值在进入 Renderer 前脱敏；允许决策的原始 `updatedInput` 只沿当前子进程 stdin 返回。
- 隐藏 CLI 选项属于版本锁的一部分；高于 `2.1.226` 的版本在重新审计与回归前默认拒绝启动。
- 公开测试使用 Fake CLI，不调用真实模型或提交真实 Transcript。
- 版本升级需要同时更新测试 Fixture、能力矩阵、ADR/Spike 证据和最大验证版本。
