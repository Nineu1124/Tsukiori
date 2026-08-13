# T-DSH-07 Provider 验证审计报告

验证日期：2026-08-13

平台：Windows x64

范围：交互工作台的 API Provider、ChatGPT 登录和 Claude 本机登录验证

## 结论

Provider 验证现在通过可注入的白名单 Sink 写入本地审计 Store。审计与 `ProviderConfig.lastTest` 使用同一个 `testedAt`，没有新增 RuntimeProfile 或重复 Provider 配置模型。Store 采用用户数据目录下的原子 JSON 文件，只保留最近 500 条、上限 2 MiB。

## T-DSH-07-C1 成功与失败

- [x] 成功验证记录 `providerId`、`providerKind`、`outcome=succeeded`、分类、延迟和 `testedAt`。
- [x] HTTP/网络/认证失败与缺少凭据记录 `outcome=failed` 和稳定错误分类。
- [x] ChatGPT 使用临时 Codex `account/read`，Claude Native 使用本机认证 Probe；Registry 本身不会把未验证的 Runtime 登录写成成功。

证据：`tests/interactive/provider-registry.test.mjs`、`tests/interactive/interactive-workspace.test.mjs`。

## T-DSH-07-C2 安全投影

- [x] Store 只序列化 Schema 明确允许的 9 个字段，传入对象中的额外字段会被丢弃。
- [x] `providerId`、类型、分类、整数范围和记录版本都经过读取/写入双向校验。
- [x] 审计不保存 Provider 名称、Base URL、Model、API Key、认证头、请求、响应或用户 Prompt。
- [x] 文件以用户私有模式创建；内容异常或超过 2 MiB 时拒绝继续读取/覆盖。

## T-DSH-07-C3 审计降级

- [x] 审计写入失败不会把 Provider 连通结果改写为失败，也不会把失败验证伪装成成功。
- [x] `lastTest.auditStatus=degraded` 与 `auditCategory=audit_write_failed` 会持久化到 Provider 安全状态。
- [x] 设置中心在已选 Provider 状态中显示“审计写入降级”，不显示原始磁盘错误正文。

## 验证命令

```powershell
pnpm --filter @tsukiori/desktop build
node --test tests/interactive/provider-registry.test.mjs
node --test tests/interactive/interactive-workspace.test.mjs
npm run test:interactive
npm run test:ui
npm run check
```

结果：Provider Registry/Store 8/8 通过；InteractiveWorkspace 专项 17/17 通过；完整 Interactive 42/42、UI 14/14 通过。Checkpoint 校验保持 30 个 V1 任务、6 个 Gate、3 个后续任务池有效；秘密扫描 433 个文件，状态 clean。

## 产物

- `apps/desktop/electron-main/provider-verification-audit.ts`
- `apps/desktop/electron-main/provider-registry.ts`
- `apps/desktop/electron-main/interactive-workspace.ts`
- `apps/desktop/renderer/renderer.js`
- `tests/interactive/provider-registry.test.mjs`
- `tests/interactive/interactive-workspace.test.mjs`
