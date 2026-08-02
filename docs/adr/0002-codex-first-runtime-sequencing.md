# ADR-0002：Codex-first Runtime 实施顺序

- 状态：Accepted
- 日期：2026-08-02
- 决策范围：阶段 3/4 实施顺序，不改变 V1 Gate 完成标准

## 背景

用户明确要求暂时忽略 OpenCode，并继续完成可独立推进的 Codex 本地工作台。原计划让 T4.1 依赖 G3；G3 又要求 T3.1–T3.4 的 OpenCode Alpha 全部完成。该顺序依赖会阻止已经由 T0.2 验证的 Codex app-server 工作，尽管 Codex Adapter 的生命周期、协议和认证并不依赖 OpenCode Adapter。

OpenAI 官方 Codex App Server 文档将 `codex app-server` 定义为富客户端深度集成接口，覆盖认证、会话历史、审批和流式事件；Schema 由当前 Codex CLI 版本生成，连接按 `initialize` → `initialized` 建立。认证状态可通过 `account/read` 和 `account/updated.authMode` 探测。

官方来源：

- <https://learn.chatgpt.com/docs/app-server.md>
- <https://learn.chatgpt.com/docs/auth.md>
- <https://github.com/openai/codex/tree/main/codex-rs/app-server>

## 决策

1. T4.1 的前置依赖从 `G3、T0.2` 调整为 `G2、T0.2`。
2. T4.2 和 T4.3 保持原依赖，因此可在 T4.1 后按序实施 Codex 协议与原生能力。
3. T3.1–T3.4 和 G3 保持未完成，不因 Codex 证据而勾选。
4. T4.4 仍依赖 T3.4；T4.5 仍要求 OpenCode/Codex 双 Runtime；G4 仍要求 T4.1–T4.5 全部完成。
5. 这项调整不降低 V1 Ready 标准，不把单 Runtime 候选描述成双 Runtime V1。

## 结果

- 可以立即实现和验证 Codex T4.1–T4.3。
- OpenCode、双 Runtime、T4.4、T4.5、G4 与后续 G4 依赖任务继续保持阻塞。
- 所有未由当前 Codex 版本和真实运行证据验证的能力继续标记 `unknown`。

## 约束

- Codex 版本、Schema Hash 和兼容策略必须绑定。
- 不读取或提交 `auth.json`、keyring 内容、access token 或 API key。
- 认证探测只记录认证类型、是否需要认证和可公开的能力状态。
- 公开 CI 只重放脱敏 Fixture，不依赖真实登录。
