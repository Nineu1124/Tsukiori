# T-DSH-10 Runtime 环境隔离报告

验证日期：2026-08-13

平台：Windows x64

范围：Claude Code 与 Codex app-server 的正式子进程启动环境

## 结论

Claude Adapter 与 Desktop Codex Client 现在共用 `runtime-core` 的 Provider 环境隔离策略。每次 `spawn` 都从宿主环境副本中删除完整 Provider 变量集合，再按 Runtime Allowlist 写入当前 Session 的显式变量；未知 Addition 会直接拒绝，而不是透传。

本任务没有使用 `credential-broker.spawnWithSecret()` 作为完成证据，因为正式交互路径并不调用它。验证覆盖的是 Claude `startTurn` / `probeClaudeAuth` 和 Codex `app-server` 的实际启动函数。

## T-DSH-10-C1 共享策略

- [x] 统一清除 Anthropic、Claude 派生模型、OpenAI、Azure OpenAI、DeepSeek、OpenRouter、Bedrock 和 Vertex 选择变量。
- [x] Claude Provider 模式只允许 Anthropic/Claude 映射；Native 模式不允许任何 Provider Addition。
- [x] Codex 只允许当前产品已支持的 `OPENAI_API_KEY`；Base URL 与 Model 仍由受约束的 Codex config 参数传入。
- [x] 空值、超长值、换行/NUL 和非 Allowlist Key 均在 spawn 前拒绝。

## T-DSH-10-C2 实际子进程

- [x] Fake Claude CLI 记录键名而非值，证明 Native 子进程无 Provider Key，Provider 子进程只有选中 Key。
- [x] Claude 首次失败后以另一认证变量重试，两个并行 Turn 分别只看到自己的选中变量。
- [x] 两个并行 Codex app-server 子进程在宿主环境被污染时仍只看到各自 `OPENAI_API_KEY`，且 Fixture 仅记录匹配布尔值。

## T-DSH-10-C3 切换、恢复与安全边界

- [x] 每次新进程都重新从清理后的环境构造，不复用或修改上一 Session 的环境对象。
- [x] Claude Resume/Fork 和失败重试走同一 `startTurn` 清理路径；Codex 重连走同一 `start()` 清理路径。
- [x] 测试日志不保存 Key 值、Provider 请求、响应、Prompt 正文或用户路径。
- [x] `NO_COLOR=1` 与 `GIT_TERMINAL_PROMPT=0` 在两种 Runtime 中强制保持。

## 验证命令

```powershell
pnpm run build
node --test tests/runtime/runtime-environment.test.mjs
node --test tests/interactive/codex-app-server-environment.test.mjs
node --test tests/claude-adapter/claude-lifecycle.test.mjs
npm run test:runtime
npm run test:claude-adapter
npm run test:interactive
npm run test:security
npm run check
```

结果：共享策略 3/3、Codex 实际子进程 1/1、Claude Lifecycle 10/10 通过；完整 Runtime 13/13、Claude Adapter 12/12、Interactive 43/43、Security 6/6 通过。Checkpoint 校验保持 30 个 V1 任务、6 个 Gate、3 个后续任务池有效；秘密扫描 438 个文件，状态 clean。

## 产物

- `packages/runtime-core/src/runtime-environment.ts`
- `packages/adapter-claude/src/client.ts`
- `apps/desktop/electron-main/codex-app-server-client.ts`
- `tests/runtime/runtime-environment.test.mjs`
- `tests/interactive/codex-app-server-environment.test.mjs`
- `tests/claude-adapter/claude-lifecycle.test.mjs`
