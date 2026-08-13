# T-DSH-05 Thinking 控制 Probe

日期：2026-08-14
状态：完成；DeepSeek 经 Claude Code 的 effort 映射仍为 `unknown`

## 结论

Tsukiori 将三类能力分开处理，不再把同名的“Thinking”设置视为同一层能力：

1. **Provider API 参数**：DeepSeek 官方 OpenAI 格式支持 `thinking.type` 与 `reasoning_effort`；Anthropic 格式支持 `thinking`，且 `output_config` 只支持 `effort`。
2. **Claude Code Runtime 参数**：本机 Claude Code `2.1.228` 的真实、只读帮助 Probe 验证了 `--effort <level>`，声明值为 `low / medium / high / xhigh / max`。
3. **宿主显示偏好**：`showThinking` 只控制本机 Thinking 正文是否显示，不修改 Runtime 参数、Provider 请求或已持久化 Transcript。

当前 Tsukiori 的 DeepSeek 路径是 Claude Code CLI 转发。没有可接受的证据证明 `--effort` 会被转换成 DeepSeek Anthropic API 的 `output_config.effort`，因此 DeepSeek 的模型 effort 控件保持隐藏并显示 `unknown` 说明。只有已锁定且发现 `effort-control` 的 Claude Runtime 配合 `claude-native` Provider 时，模型 effort 选择器才出现。

## 版本化证据

- Probe：`scripts/probe-thinking-control.mjs`
- Fixture：`tests/fixtures/thinking-control/claude-code-2.1.228-deepseek-v4.json`
- 能力策略：`apps/desktop/electron-main/thinking-control.ts`
- DeepSeek Chat Completions：<https://api-docs.deepseek.com/api/create-chat-completion/>
- DeepSeek Anthropic API：<https://api-docs.deepseek.com/guides/anthropic_api/>

本机 Probe 命令：

```powershell
node scripts/probe-thinking-control.mjs
```

脱敏结果：

```text
runtimeVersion=2.1.228
probe=version-and-help-only
helpSha256=71ad650f59e08ae40ede14c534db4f49d8590ee5a4f92f6da2882d3a5560fea6
helpBytes=16890
effortArgument=true
advertisedEfforts=low,medium,high,xhigh,max
networkUsed=false
modelRequestStarted=false
credentialRead=false
promptProvided=false
userSourceRead=false
```

Probe 只执行 `--version` 和 `--help`，不读取凭据，不传 Prompt，不读用户源码，不发起模型或网络请求，也不持久化 Runtime 输出。

## 证据边界与失败记录

曾尝试用 `127.0.0.1` 请求捕获器观察 Claude Code 到 Provider 的请求形状，但捕获器没有收到请求，无法证明流量被限制到本地端点。该结果不被接受为映射证据；没有保存原始输出、Prompt 或认证数据，也未据此启用任何能力。按照失败闭合原则：

- Claude Code `--effort` 接口：按发现的 CLI 能力判定；
- DeepSeek 直接 API 参数：按官方文档判定；
- Claude Code `--effort` → DeepSeek `output_config.effort`：`unknown`；
- 不再使用或允许 Provider 注入猜测的 `CLAUDE_CODE_EFFORT_LEVEL`。

本机安装的 Claude Code `2.1.228` 高于当前完整 Runtime 兼容性上限 `2.1.226`，所以本机产品仍将该 Runtime 标为 `unknown` 并隐藏模型 effort 设置。帮助 Probe 只证明接口存在，不自动提升整个 Runtime 的兼容性等级。

## 实现与回退行为

- Adapter 只在发现 `effort-control` 时生成精确的 `--effort <value>` 参数；否则同步拒绝请求。
- `ClaudeThinkingEffort` 只接受五个声明值；非法值失败闭合。
- DeepSeek Provider 环境不再注入 `CLAUDE_CODE_EFFORT_LEVEL`。
- Session 创建、首次 Turn 前更新、Fork、Checkpoint 回退与重启恢复共享同一策略。
- 从 Claude Native 切换到 DeepSeek 或其他无映射 Provider 时，已选 effort 被清除；显式要求 unsupported/unknown 值会被拒绝。
- `showThinking=false` 仅给 `body` 添加 `hide-thinking` 并隐藏 `.thinking-body`；摘要、事件和本地 Transcript 不变。

## 验证

```powershell
pnpm --filter @tsukiori/adapter-claude build
pnpm --filter @tsukiori/desktop build
node --test tests/interactive/thinking-control.test.mjs tests/claude-adapter/claude-lifecycle.test.mjs tests/interactive/provider-registry.test.mjs tests/interactive/interactive-workspace.test.mjs tests/ui/basic-ui.test.mjs
```

结果：53/53 通过。覆盖：

- CLI 参数发现、精确参数生成、缺能力拒绝；
- Provider API / CLI / Host Display 三层能力矩阵；
- DeepSeek 映射维持 `unknown`；
- Provider 切换清理、重启恢复、Checkpoint 回退保持；
- Thinking 正文显示偏好持久化；
- UI 只在 `modelEffort.supportLevel === supported` 时展示选择器；
- Provider 环境中不存在猜测的 effort 变量。

提交前完整回归结果：

```text
TypeScript / Turbo: 34/34 tasks, 21 packages
Runtime:            23/23
Claude Adapter:     14/14
Interactive:        50/50
UI:                 14/14
Security:            6/6
Snapshot:            3/3
Checkpoint verifier: 30 tasks, 6 gates, 3 backlog, valid
Secret scan:         456 files, clean
```

首轮 Runtime 回归发现旧测试仍尝试把 `CLAUDE_CODE_EFFORT_LEVEL` 当成允许注入项。测试已改为验证继承值会被清除、显式注入会被拒绝；随后完整回归通过。

## 安全检查

- Fixture 不含 API Key、认证头、Prompt、用户源码、机器用户名或原始 Runtime 输出。
- Renderer 没有增加 Node API、动态 HTML 注入或直接网络访问。
- DeepSeek API Key 仍只通过 Windows Credential Manager 的现有边界使用。
- 宿主显示偏好不能改变模型推理，避免将视觉状态误报成 Provider 能力。
