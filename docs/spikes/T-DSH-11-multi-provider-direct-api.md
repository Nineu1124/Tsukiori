# T-DSH-11 多 Provider Direct API Runtime 报告

日期：2026-08-14
范围：Desktop Provider Registry、Direct API Runtime、Interactive Workspace、设置 UI 与 Credential Boundary

## 结论

Tsukiori 新增第三种可执行 Runtime：`Direct API`。它参考 DeepSeek Harness 的分层方式，把 Provider Route、模型目录、请求期冻结配置和统一流事件放在独立边界内；实现使用锁定依赖 `@earendil-works/pi-ai@0.82.1`，没有复制 DSH 源码或持久化结构。

Direct API 当前支持文本对话、Thinking 流、Abort、Session 本地历史、Fork/Checkpoint/Rewind、Token/费用估算投影和错误分类。API 返回工具调用时会失败闭合，提示改用 Codex 或 Claude Code；因此其 SupportLevel 保持 `degraded`，不会把未实现的 Agent Tool Loop 伪装成可用。

## T-DSH-11-C1 Provider 与协议目录

- [x] 内置 Provider：OpenAI、Anthropic、DeepSeek、Google Gemini、OpenRouter、xAI、Groq、Mistral、Cerebras、Together、Z.ai、Moonshot/Kimi、MiniMax、Fireworks、Kimi For Coding。
- [x] 自定义端点：OpenAI-compatible 可选 `openai-completions` 或 `openai-responses`；Anthropic-compatible 固定 `anthropic-messages`。
- [x] 每项配置保存精确 `apiFormat`、HTTPS Base URL、Model、Context Window 与 Max Tokens；不安全 URL、空模型和容量倒置会被拒绝。
- [x] 内置目录来自版本锁定的 pi-ai Catalog；未列入目录的自定义模型使用保守的 text-only、non-reasoning 能力声明。

## T-DSH-11-C2 Direct API Session

- [x] `ApiRuntimeClient` 将供应商流映射为 `turn.started`、`assistant.delta`、Thinking、Usage、Message Completed 与 Turn Completed。
- [x] 完成消息以白名单结构写入本地 Transcript，用于下一 Turn、Fork 和恢复；不保存诊断正文或 Tool 参数。
- [x] 每个活动 Turn 有独立 `AbortController`；Shutdown 会中断全部 Direct API Turn。
- [x] 工具调用只产生脱敏 `native.event`，完成消息含 Tool Call 时拒绝继续，避免无授权执行。

## T-DSH-11-C3 凭据与数据出口

- [x] API Key 写入 Windows Credential Manager，状态只保存 `secretref`，Renderer 只看到 `hasSecret`。
- [x] 新增内部绑定名 `TSUKIORI_PROVIDER_API_KEY`，Credential Broker 在任何子进程启动前清理该变量以及其他 Provider Key。
- [x] 请求密钥只在 Main Process 的绑定回调中短暂可见，不进入事件 payload、状态、Transcript、诊断或公开 Fixture。
- [x] 设置页明确提示模型数据发送到所选 Provider，连接测试不保存响应正文。

本任务没有使用聊天中出现过的密钥，也没有执行带用户凭据的真实 Provider 请求。各账号的认证、额度、地区和当前模型可用性仍需用户在设置页使用已轮换的新密钥逐项验证；验证结果只保存布尔值、延迟和错误类别。

## T-DSH-11-C4 验证证据

以下测试均使用临时 Git 仓库、确定性流 Fixture 和非真实凭据：

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck` | 21 packages / 34 tasks 通过 |
| `pnpm test:interactive` | 54/54 通过，包括 Direct API 流、Abort、工具拒绝、Provider Registry 与 Workspace Session |
| `pnpm test:ui` | 14/14 通过，包括 17 类 API Provider、三 Runtime 与协议/容量控件 |
| `pnpm test:security` | 6/6 通过；通用 Provider Key 在非目标子进程环境中被清理 |
| `pnpm test:host` | 10/10 通过；锁定的 pi-ai 依赖纳入应用包边界 |
| `pnpm test:release` | 9/9 通过 |
| `pnpm --filter @tsukiori/desktop package:win` | Windows x64 NSIS 与 `win-unpacked` 构建成功 |
| ASAR 只读依赖检查 | pi-ai、OpenAI、Anthropic、Google 与 Mistral SDK 均存在于生产包 |
| `npm run check` | 30 个 V1 任务、6 个 Gate、3 个后续任务池有效；464 个文件秘密扫描 clean |

最终 Git SHA 以本任务完成提交为准。

## 已知边界

- Direct API 当前是对话 Runtime，不执行 MCP、Skills、Computer Use 或供应商 Tool Call。
- 内置 Catalog 是锁定版本快照，不代表供应商账号当前一定拥有对应模型权限。
- 费用字段是 SDK 根据模型目录提供的估算，最终费用以 Provider 账单为准。
- 真实 Provider E2E 必须使用用户在本机重新配置的有效密钥，不能进入公开 CI。
