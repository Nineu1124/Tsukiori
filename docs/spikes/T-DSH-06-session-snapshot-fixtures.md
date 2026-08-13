# T-DSH-06 固定 Session Fixture 与回放报告

验证日期：2026-08-13

平台：Windows x64

范围：`runtime-core/EventNormalizer` 的离线、确定性 Session 事件回放

## 结论

建立了版本化 `runtime-session-snapshots.v1.json`。生成器只使用固定的合成输入，不调用 DeepSeek、Claude、OpenAI 或其他外部 Provider；生成结果经过字节级比对、场景级 SHA-256 和敏感内容拒绝规则验证。

## T-DSH-06-C1 场景覆盖

- [x] `normal-conversation`：消息开始、文本增量和消息完成。
- [x] `permission-roundtrip`：权限请求、一次允许和消息完成。
- [x] `thinking-forward-compatibility`：当前未进入统一合同的 Thinking 事件被保留为脱敏 `native.event`，没有伪装成已支持能力。
- [x] `tool-lifecycle`：工具开始、进度、完成和消息完成。

证据：`tests/fixtures/session/runtime-session-snapshots.v1.json`、`tests/runtime/session-snapshot.test.mjs`。

## T-DSH-06-C2 确定性与回放

- [x] Runtime Handle、Session、Turn、Runtime Event、时间戳和输入顺序均为固定合成值。
- [x] 非确定性的宿主 `eventId` 与 `receivedAt` 在 Snapshot 边界被替换为稳定值。
- [x] 每个场景保存预期事件 SHA-256；`--check` 对已发布 Fixture 与重新生成内容执行字节级比较。

验证命令：

```powershell
pnpm run test:snapshot:record
pnpm run test:snapshot
```

结果：3 项测试通过，0 失败；4 个场景均通过 Fixture 新鲜度和事件哈希校验。

## T-DSH-06-C3 数据与安全边界

- [x] Fixture 标记 `externalProviderCalls=false`、`containsCredentials=false`、`containsUserPrompt=false`。
- [x] 生成阶段拒绝 API Key、Bearer Token、私钥头和 Windows 用户目录路径。
- [x] 测试再次扫描发布后的 JSON，不依赖生成器自证。

Fixture 只包含合成的 assistant 响应、权限类别和工具状态；不包含用户源码、真实 Prompt、认证信息、Runtime 原始日志或机器专属路径。

## T-DSH-06-C4 CI

- [x] Windows CI 在 `test:runtime` 后执行 `npm run test:snapshot`。
- [x] CI 只运行构建、Fixture 新鲜度检查与离线回放，不更新 Fixture，也不需要 Provider 凭据。

## 产物

- `scripts/session-fixture-snapshots.mjs`
- `tests/fixtures/session/runtime-session-snapshots.v1.json`
- `tests/runtime/session-snapshot.test.mjs`
- `docs/roadmap/deepseek-harness-integration.md`
