# G4 阶段 4 Gate 报告

- Gate：G4
- 评估日期：2026-08-02
- 平台：Windows x64
- 结论：通过，功能完整度达到 Windows V1 候选门槛
- 自动化 Gate：`tests/gates/g4.test.mjs`
- 脱敏证据：`tests/fixtures/gates/g4-evidence.json`

## 总结

G4 的五个 Checkpoint 均已独立验证。T4.1 至 T4.5 已完成并分别通过 Windows CI；OpenCode 与 Codex Adapter Contract v1、双 Runtime E2E、Git Integration、Permission 和原生能力展示测试均通过。Claude Adapter、Generic ACP、WSL、macOS 和 Linux 保持在 B1–B3 后续任务池，不阻塞 Windows V1。

所有能力状态继续使用 `supported`、`experimental`、`degraded`、`unsupported` 或 `unknown` 明确表达；未验证能力不可操作，不会被 UI 描述为已支持。公开 CI 只运行 Fake Runtime 和脱敏 Fixture，不需要 Provider 凭据。

## 输入任务与 CI

| 任务 | 提交 | Windows CI |
| --- | --- | --- |
| T4.1 Codex app-server 生命周期 | `dc0844d7be28a8ccc720d8cfe0f4863a629e8c78` | 30737300161：success |
| T4.2 Thread/Turn/Item | `23bc6f500ac1712532cc2c657cbdf4560a5bebd9` | 30738211668：success |
| T4.3 Approval、MCP 与 Skills | `78d105c616fe8017883a5313be6223c957d64da8` | 30738914336：success |
| T4.4 Git 与 Integration Worktree | `58d28fd995b853fc1497e65e0ed160ac5a998260` | 30744733940：success |
| T4.5 双 Runtime 并行验证 | `eb371637479ac270dc2c9d59c809a9bb83165096` | 30745162905：success |

## G4-C1 T4.1 至 T4.5 全部完成

Gate 解析架构源文档，要求 T4.1 至 T4.5 节内不存在未完成 Checkpoint，并验证五个完成提交均为当前 HEAD 的祖先。Fixture 记录的五次 Windows CI 结论均为 `success`。

结果：通过。

## G4-C2 OpenCode 与 Codex Adapter Contract Tests

OpenCode 和 Codex 均通过 Adapter Contract v1 的生命周期、Session、Turn、事件、权限、停止和能力状态检查；Runtime 特有行为通过显式 SupportLevel 表达，不把推测能力升级为 supported。

验证命令：

```powershell
npm run test:contract
```

结果：通过。

## G4-C3 双 Runtime E2E、Git 集成和权限

- 同一 Project 中并行运行一个 OpenCode Session 和两个 Codex Session，连续五轮未出现事件串线或 Worktree 代码污染。
- OpenCode 与 Codex 的 Diff 分别 Review、Stage 和 Commit；两份变更只在临时 Integration Worktree 中串联合并，主工作区不被修改。
- Runtime 权限通过共享 Attention Center 到达并保留来源引用；`allow_once` 不升级为持久策略。
- 第六轮注入 OpenCode 崩溃后，Codex Runtime 仍保持健康。

验证命令：

```powershell
npm run test:dual-runtime
npm run test:git
npm run test:permission
```

结果：通过。

## G4-C4 后续任务池不阻塞 V1

Claude Adapter、Generic ACP、WSL、macOS 和 Linux 均保留在 B1–B3，并有启动条件、预期产物和 Checkpoint。这些能力不计入 Windows V1 完成率，当前 UI 不提供虚假的可操作入口。

结果：通过。

## G4-C5 能力状态表达准确

UI 和能力矩阵统一展示 `supported`、`experimental`、`degraded`、`unsupported` 与 `unknown`。实验能力包含风险提示，降级能力显示缺失项，unsupported/unknown 均不可触发；MCP 与 Skills 只读展示来自规范化 Snapshot。

验证命令：

```powershell
npm run test:ui
npm run test:gate4
```

结果：通过。

## 安全边界

- Worktree 是代码隔离，不是安全沙箱。
- Prompt、用户源码、原始 Runtime Event、凭据和认证存储不写入 Fixture 或仓库。
- Git Revert 先创建可恢复 Snapshot；Integration Merge/Rebase 不直接修改主工作区，也不自动 Promotion。
- 外部编辑器、Hook、Signing 和 Git Editor 使用显式、非交互且可审计的调用边界。
- 未验证行为维持 `unknown`，不得因通过 Gate 而推断支持。

## 公开 CI

Windows CI 新增 `npm run test:gate4`，并继续执行 Adapter Contract、双 Runtime、Git、Permission、UI、Checkpoint 和秘密扫描。全部测试仅使用 Fake Runtime 或脱敏 Fixture，不持有用户 API Key。

## 验证命令

```powershell
pnpm run build
pnpm run typecheck
npm run test:contract
npm run test:dual-runtime
npm run test:git
npm run test:permission
npm run test:ui
npm run test:gate4
npm run check
git diff --check
```

## 最终验证结果

- G4 Gate：5/5 通过。
- T4.1–T4.5 Windows CI：5/5 success。
- Workspace Build：16/16 包通过；TypeScript typecheck：27/27 任务通过。
- Adapter Contract：4/4；双 Runtime：2/2；Git Integration：14/14；Permission：6/6；UI：3/3。
- Checkpoint 校验：27 tasks、6 gates、3 backlog，状态 `valid`。
- Secret Scan：203 个文件，状态 `clean`；`git diff --check`：通过。

## Gate 决策

- G4：通过。
- 允许下一任务：T5.1。
- 仍禁止：把 Worktree 描述为安全沙箱；持久化 Prompt/源码/原始 Runtime Event；在公开 CI 使用 Provider Key；把 B1–B3 或未验证 Runtime 行为标记为 supported。
