# B1 Claude 原生 `stream-json` 基线 Spike

- 日期：2026-08-09
- 平台：Windows Native x64
- Runtime：Claude Code `2.1.226`
- 接口：官方 CLI `--print --output-format stream-json`
- 结论：PARTIAL PASS（完成 B1 原生基线，不代表完整 B1）
- Fixture：`tests/fixtures/claude/fake-claude-cli.mjs`
- 能力矩阵：`tests/fixtures/claude/b1-native-result.json`
- 决策：`docs/adr/0004-claude-native-stream-json-foundation.md`

## 目标

把 T5.7 的 Desktop 内联 Claude Bridge 替换为独立、可测试的 Runtime Adapter 基线，并验证：

- Detect、版本兼容和本机认证状态；
- 本机登录与 API Provider 的 Secret/数据出口边界；
- Text、Thinking、Tool、Result 和未知事件映射；
- Resume、中断、异常退出和缺少 Result 的终态；
- Desktop Provider/Runtime 选择和 UI 状态。
- `can_use_tool` 请求进入 Attention Center 后的一次性允许、拒绝与中断失效。

## 本机证据

执行：

```powershell
claude --version
claude --help
claude auth status --help
```

观察结果：

- 版本输出：`2.1.226 (Claude Code)`；
- `--help` 包含 `stream-json`、`--resume`、`--fork-session`、`--include-hook-events`、`--forward-subagent-text`、`--mcp-config`、Skills 和 `--json-schema`；
- `auth status --json` 的脱敏投影为 `loggedIn=true`、`authMethod=oauth_token`、`apiProvider=firstParty`；未读取或记录账号、邮箱、Token、Cookie 或 Keychain 内容。

## 实现结果

### B1-C1 独立 Adapter 与版本锁

- 新增 `packages/adapter-claude`；
- Desktop 通过 workspace 依赖使用 Adapter，旧内联客户端已删除；
- `2.1.226` 为当前唯一完整验证版本；
- 更旧版本拒绝，更高版本标为 `unverified_newer` 并默认拒绝启动。

结果：通过。

### B1-C2 认证和 Provider 边界

- Provider Registry 新增不可删除的 `provider:claude-native`；
- Native 模式清除 Provider API 环境变量，使用 Claude Code 本机认证；
- API Provider 模式只注入选中的 Key，并通过 `--bare` 禁用隐式 OAuth/Keychain 与环境自定义；
- UI 的 Provider 列表和 Runtime 状态显示本机登录、API Provider 和认证来源；
- 未登录选择 Native Provider 时在创建 Worktree 前明确失败。

结果：通过。

### B1-C3 Rich Event 与未知事件

- `system/init` → Session 元数据；
- Partial Message → Thinking/Text Delta；
- Tool Use/Result → Started/Completed/Failed；
- Thinking 使用可折叠 Rich Block；同一 `toolUseId` 的 Started/Completed/Failed 在 UI 原位更新；
- Message、Thinking、Tool 与 Turn 事件在用户启用对话持久化时写入本机 Transcript，并可在重启后重放；
- Result → Completed/Failed Turn；
- Hook/Subagent 输出保留为独立事件；
- 未知、非法 JSON 和超限行转为有界警告或脱敏 Native Event；
- Partial 与完整 Assistant Message 同时出现时不会重复 Text/Tool。

结果：通过。

### B1-C4 终止与恢复基线

- Resume 使用固定 Runtime Session UUID；
- 中断生成 `interrupted` 终态；
- 非零退出、Spawn Error 和无 Result 正常退出生成 `failed` 终态；
- Stderr 中的 Bearer/`sk-` Secret 在进入 Workspace 前脱敏。

结果：通过。事件补发和进程重启后的 Runtime Session 对账尚未完成；Session Fork 与宿主 Checkpoint/Rewind 已另行形成 Fixture 合同。

### B1-C5 Structured I/O 权限基线

- 启动参数加入 `--input-format stream-json --permission-prompt-tool stdio`，Prompt 作为 `SDKUserMessage` 写入并保持 stdin 到 Result；
- `control_request/can_use_tool` 经过 request ID、tool use ID、Turn 与 connection epoch 关联后进入统一 Attention Center；
- `allow_once` 返回原始 `updatedInput`，`deny_once` 返回明确拒绝消息，`cancel_turn` 先拒绝再中断；
- 重复响应、未知/过期 request ID、Runtime Cancel、Turn Result、中断和进程退出都会使请求失效；
- 原始 Tool Input 只保留在当前 Adapter Turn 内存，UI 只显示脱敏、限长 Scope。

结果：Fixture 与跨层合同通过。由于 `--permission-prompt-tool` 未出现在公开 Help，且尚未归档一次真实 Claude CLI 的无副作用工具审批 E2E，能力矩阵继续保守标为 `degraded`。

### B1-C6 Search、Fork 与显式 Retry 基线

- History Search 从仅匹配 Session 名称扩展为本机 Session 元数据与 Transcript 搜索，查询结果最多 50 条，不建立新的云索引；
- Claude Fork 使用 `--resume <source> --fork-session`，首个 Turn 从 `session.started` 采用 Runtime 返回的新 Session ID；
- Fork 从源 Worktree 当前 HEAD 建立独立分支，并在存在未提交/未跟踪变更时 fail closed，避免“对话已分叉、代码未分叉”的假 Fork；
- Fork 历史重写为目标 Tsukiori Session Event，不直接复制带源 Session ID 的 Transcript 行；
- Retry 仍是显式用户动作，并在再次发送前提示可能重复工具副作用，不在崩溃恢复时自动重放 Prompt。

结果：Adapter、Desktop、临时 Git Worktree 与 UI 合同通过。真实 Claude CLI Fork E2E 尚未归档，因此能力矩阵标为 `degraded`。

### B1-C7 Checkpoint/Rewind 基线

- Checkpoint manifest 同时记录 Claude Runtime Session/Assistant Message 锚点、本地 Transcript 哈希、Git HEAD、真实 Index Tree 和包含未跟踪非忽略文件的 Worktree Tree；
- 回退前自动建立可反向恢复的 Recovery Checkpoint，恢复目标代码和 Transcript 后复算 Index/Worktree Tree；
- 回退不移动分支 HEAD，也不自动重放 Prompt；下一 Turn 使用 `--resume <source> --resume-session-at <message> --fork-session` 派生新 Runtime Session；
- 超限文件、无完整 Turn/Message 锚点、运行中 Session、损坏 manifest/ref/hash 和未解决冲突均 fail closed；
- Renderer 在执行前显示变化路径与将移除的 Transcript 事件数量，并明确 HEAD 不移动及 Recovery Checkpoint 语义。

结果：服务级 Git/Transcript 恢复、Adapter 参数、Desktop 跨层与 UI 合同通过。真实 Claude CLI 的 Message 级恢复、进程在回退中途强杀和统一 Durable Operation 尚未归档，因此能力矩阵标为 `degraded`。详见 ADR-0005 与 `docs/spikes/S2-checkpoint-rewind.md`。

### B1-C8 MCP/Skills 健康与作用域投影

- 本地 MCP Registry 的 User / Project / Local Scope 按项目过滤，Project/Local 配置必须绑定 Project；
- Codex Session 通过 `skills/list` 和 `mcpServerStatus/list` 与当前 Worktree 的本地扫描结果对账，区分 `observed`、`not_observed` 和 `unknown`；
- Runtime 只观察到、但宿主 Registry 未配置的 MCP/Skill 单独显示为 `runtime_only`；MCP 原生响应不提供 Scope 时明确显示 `runtime_effective_scope_unknown`；
- Claude `system/init` 只能证明 MCP 数量，无法证明具体名称、健康和 Skills，因此全部保持 `unknown`，不从目录或配置反推已生效。

结果：Workspace、Desktop IPC/UI 与跨项目作用域测试通过。Claude MCP 名称/Skill 枚举、OAuth 交互、重连和显式 API Provider 作用域仍未完成，因此组合能力继续标为 `degraded`。详见 `docs/spikes/S2-mcp-skills-health.md`。

### B1-C9 Subagent Activity 安全投影

- Claude Subagent 事件只保留 schema、Runtime Event/Task/Subagent ID、父 Tool Use ID、名称和状态；Prompt、Message、Transcript Path 与 Raw Payload 在 Adapter 边界丢弃；
- Codex `collabAgentToolCall` 从 receiver thread 和 agent state 生成同样有界的 `subagent.event`，不转发 prompt/message；
- Desktop Activity 同时呈现 Runtime 原生 Subagent、Tsukiori Agent Team 和后台 Session，明确区分来源，不把观测事件伪装为宿主控制能力；
- `subagent.event` 可随本机 Transcript 恢复，但完整父子树、重连对账、取消/恢复和真实 Runtime E2E 尚未验证。

结果：Claude mapper、Codex 跨层 Activity 与 UI 合同通过，支持级别保持 `degraded`。详见 `docs/spikes/S2-subagent-activity.md`。

### S2-C10 cc-haha 基础历史导入

- 用户选择 cc-haha/Claude 配置根目录或 `projects` 目录后，先执行只读 Dry Run；
- 不从有损目录名反解项目，必须读取每条 Transcript 的 `cwd` 并用结构化 Git 命令验证真实 Git 根目录；
- Transcript 以 SHA-256 和 Source Fingerprint 防止 Dry Run 后变更，Manifest 按内容哈希实现幂等；
- 只转换 User/Assistant Text、Thinking 和脱敏 Tool 状态；不复制 OAuth、API Key、Cookie、Keychain、工具原始参数/结果正文、IM 登录态或运行中进程；
- 每个导入 Session 创建独立 Git Worktree，历史强制只读；Prompt、附件、Terminal、Git 写操作和 Rewind 在 Main Process 拒绝，只有显式 Claude Fork 可产生可写 Session；
- 单批失败回滚已创建 Session、Transcript、Worktree、分支及新增项目状态。

结果：服务级、Workspace 跨层、幂等、源文件不变、变更拒绝、只读保护、Fork 和 UI 合同通过。这只是基础历史迁移，不代表 cc-haha 全部用户数据或 Runtime 状态迁移。详见 ADR-0006 与 `docs/spikes/S2-cc-haha-import.md`。

## 自动测试

```powershell
pnpm run build
node --test tests/claude-adapter/*.test.mjs
node --test tests/claude-adapter/*.test.mjs tests/interactive/*.test.mjs tests/ui/*.test.mjs
pnpm run typecheck
npm run check
git diff --check
```

覆盖范围：

- Fake CLI Detect/Help/Auth/Start/Resume/Interrupt/Fail；
- Native 模式不会继承 API Key；
- Provider 模式使用 `--bare` 且只得到选中 Key；
- Structured stdin 用户消息、stdio 权限 allow/deny、重复响应拒绝与中断失效；
- Claude 权限卡进入 Attention Center、状态流转和关联决策回传；
- Session/Transcript Search、Claude Fork 的源/目标 Runtime ID、干净 Worktree 约束与显式 Retry；
- Git/Transcript Checkpoint、自动 Recovery Checkpoint、Claude Message 锚点与 `resume-session-at` 派生；
- MCP/Skills 的项目作用域隔离、Codex Runtime 对账与 Claude unknown 降级；
- Claude/Codex Subagent 事件的脱敏 Activity 投影；
- cc-haha Transcript 的只读 Dry Run、内容哈希幂等、批次回滚、只读历史与显式 Fork；
- Rich Event 映射、去重、未知事件、超限和脱敏；
- Desktop Native 登录成功、未登录拒绝、API Provider Secret 外置；
- Provider/Runtime UI 回归。

## 尚未完成

- Agent SDK 模式的独立 Spike 与认证/分发决策；
- 锁定版本 Permission Broker 的真实 Claude CLI 无副作用 E2E 与升级兼容性证据；
- Hooks 的宿主控制和审计语义；
- Skills/MCP 的显式作用域配置与健康检查；
- Subagent 完整父子树、控制、取消/恢复和重连对账；
- Checkpoint/Rewind 的真实 Claude CLI E2E、进程中途强杀恢复和统一 Event Store 持久化；
- 使用脱敏真实项目完成一次无副作用 E2E（公开 CI 继续只用 Fixture）。

因此 B1 父任务和其余 Checkpoint 保持未勾选。
