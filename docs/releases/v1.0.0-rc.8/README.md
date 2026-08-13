# Tsukiori v1.0.0-rc.8

RC8 完成 DeepSeek Harness 后续路线图。它重点增强真实 Runtime 事件、恢复、安全审计和 Thinking/Compaction 呈现，不改变“文件与数据保存在本机，模型请求由所选 Runtime/Provider 发送”的本地优先边界。

## 安装

下载 `Tsukiori-1.0.0-rc.8-x64-setup.exe`。这是个人本地发行版，未购买 Authenticode 证书，Windows SmartScreen 可能显示未知发布者；请只从本仓库 Release 下载并核对 SHA-256：

```text
b53e65dc5532a55e1071846dac8f45e28098a23d9d49bb5000be4dfa8cfb024c  Tsukiori-1.0.0-rc.8-x64-setup.exe
68f83309be4c6667549abec40c09361897a7695417c48dbc71b3c0d1b818a2da  Tsukiori-1.0.0-rc.8-x64-setup.exe.blockmap
```

本地调试版位于 `D:\local_coagent\apps\desktop\release\win-unpacked\Tsukiori.exe`。

## 主要变化

- 固定四组无凭据 Session Snapshot Fixture，支持确定性回放与 CI 过期检查。
- Provider 成功、失败与审计写入降级都有不含密钥或请求正文的审计记录。
- Attention Center 为不确定 Durable Operation 提供白名单详情、重试、放弃和诊断入口。
- Claude、Codex 的正常启动、恢复、并行 Session 和失败重试统一清理上一 Provider 环境。
- Daemon、Runtime 与 IPC 恢复统一为增量补发、Snapshot Recovery 和不可恢复三种结果。
- SubAgent 生命周期按 Runtime 来源隔离持久化；只有异常、等待或需要行动的状态进入 Attention Center。
- Thinking 块按索引隔离、有界聚合并保存完成元数据，不重复持久化完整推理正文。
- Codex `thread/compacted` 与累计 Token Usage 由锁定的 0.146.0 Schema 驱动；Claude Compaction 保持 `unknown`。
- Thinking 控制分开建模 Provider API、Claude Code CLI 与宿主显示偏好；DeepSeek 跨层映射未验证，因此不显示模型 effort 控件。
- 移除猜测的 `CLAUDE_CODE_EFFORT_LEVEL` 注入；不支持或未锁定版本失败闭合。

## 已知边界

- 本机 Claude Code `2.1.228` 的只读帮助 Probe 验证了 `--effort` 接口，但完整 Runtime 兼容性上限仍是 `2.1.226`，因此该本机版本显示为 `unknown`。
- DeepSeek 官方 OpenAI/Anthropic API effort 参数已经记录，但 Claude Code `--effort` 到 DeepSeek `output_config.effort` 的映射没有可接受证据。
- Claude Compaction、Generic ACP、H5、IM、桌面宠物和远程 Skill Marketplace 仍为 `unknown` 或后续任务。
- 未签名个人发行版可能触发 SmartScreen；Verified Publisher 渠道仍要求有效 Authenticode 证书。

完整证据见 [validation-report.md](./validation-report.md)、[DSH 路线图](../../roadmap/deepseek-harness-integration.md)和 [Thinking 控制 Probe](../../spikes/T-DSH-05-thinking-control-probe.md)。
