# G3 阶段 3 Gate 报告

- Gate：G3
- 评估日期：2026-08-02
- 平台：Windows x64
- 结论：通过，OpenCode Windows Alpha 可以交付试用
- 自动化 Gate：`tests/gates/g3.test.mjs`
- 脱敏证据：`tests/fixtures/gates/g3-evidence.json`

## 总结

G3 的五个 Checkpoint 均已独立验证。T3.1 至 T3.4 已完成并分别通过 Windows CI；一次全新的本机真实 Provider Probe 使用 OpenCode 1.18.4 和 `dpsk/deepseek-v4-flash`，在临时隔离 Worktree 中完成真实模型请求、一次 `interceptable` 权限决策、Runtime 文件修改、Diff、Stage、Commit、Archive 和安全清理。主工作区未被修改，临时 Worktree 清理成功，Prompt、文件内容、模型输出和凭据未写入数据库或仓库。

Gate 同时组合验证 Runtime、Daemon、GUI 三类崩溃行为；API Key、Native Event、Runtime 日志、Prompt 与源码脱敏；以及未验证能力继续为 `unknown`。公开 Windows CI 新增 OpenCode Adapter、Alpha E2E 和 G3 Gate，继续不持有 Provider 凭据。

## 输入任务与 CI

| 任务 | 提交 | Windows CI |
| --- | --- | --- |
| T3.1 Runtime 生命周期与 Provider | `da6253bacedd68dc116f84f7dcdf11369c50082f` | 30740203032：success |
| T3.2 Session/SSE | `9ebf9981902a21adc247b88342ec108add467b55` | 30741049721：success |
| T3.3 Permission/Recovery | `c7d2f77e44d8ececc0ff0df5e03d5fa53ad847ba` | 30742068920：success |
| T3.4 Windows Alpha | `b6bd5888db14778fb3704195aed6c850357629fe` | 30743349404：success |

T3.4 CI：<https://github.com/Nineu1124/Tsukiori/actions/runs/30743349404>

## G3-C1 T3.1 至 T3.4 全部完成

Gate 解析架构源文档，要求 T3.1、T3.2、T3.3、T3.4 节内不存在未完成 Checkpoint，并逐个验证四个完成提交是当前 HEAD 的祖先。Fixture 中四个 Windows CI 均为 `success`。

结果：通过。

## G3-C2 真实 DeepSeek、权限、Diff、Commit 和归档闭环

执行命令：

```powershell
$env:TSUKIORI_G3_PROBE_PROMPT='<ephemeral bounded probe instruction>'
npm run probe:gate3
```

`TSUKIORI_G3_PROBE_PROMPT` 只存在于当前进程环境，不写入脚本、Fixture、数据库或 Git。Probe 执行：

1. 新建临时 Git Repository、SQLite、Project 和 Worktree Root；
2. 发现 OpenCode `1.18.4`，兼容性为 `supported`；
3. 在独立 Worktree 启动密码保护的 loopback Server；
4. 选择 `dpsk/deepseek-v4-flash`，数据出口 `api.deepseek.com`；
5. 发起真实 Turn，处理 1 次 `allow_once` Runtime 权限；
6. 验证 Runtime 只在绑定 Worktree 创建预期文件，主工作区无变化；
7. Review Status/Staged Diff，结构化 Stage 和 Commit；
8. 停止 Runtime，Archive Session，并安全删除 clean Worktree。

脱敏输出：Provider Request 完成、Permission Decision Count 为 1、Runtime 修改为 true、主工作区修改为 false、Diff/Commit/Archive 为 true、Cleanup State 为 `succeeded`、持久化 Prompt/源码为 false、包含凭据为 false。

结果：通过。

## G3-C3 Runtime、Daemon、GUI 崩溃恢复

- Runtime：T3.3 强杀一个 OpenCode Server；对应 Session 为 `stopped/interrupted_runtime`，另一 Handle 保持健康，不会把不可用 Session 显示为运行中。
- Daemon：G0 独立强杀评估确认无数据破坏；重启后必须基于 Process Fingerprint 对孤儿 Runtime 做 reconcile，禁止重放高风险动作。G2 的 Durable Operation 又验证 Git 外部动作不重放且未提交代码保留。
- GUI：真实 Electron `forcefullyCrashRenderer()` 后独立 Daemon 和 Runtime 仍存活；新 UI 客户端从 SQLite/Daemon Snapshot 恢复 Attention 和 Pending Permission。

“通过”表示每类故障都有已观察、保守且不丢数据的恢复行为；不把未执行的 in-flight Turn 自动恢复升级为 supported。

结果：通过。

## G3-C4 API Key、Native Event 和日志脱敏

- 真实 Provider 凭据只由本机 OpenCode 配置管理；命令行、Fixture、数据库和公开 CI 均无 Key。
- Session Bridge 持久化规范化事件与有界脱敏 Payload，不提交原始 SSE Event。
- Runtime stdout/stderr 仅记录 byte count/状态，不保存原始日志。
- Prompt 只在调用时传给 Runtime，Host Turn 持久化 `persistedText:false`。
- Alpha Fixture、Gate Fixture、T3.1–T3.4 Fixture 和恢复 Fixture 全部经过秘密扫描与 Gate 正则检查。

结果：通过。

## G3-C5 未验证能力保持 unknown 或不可操作

继续保持 `unknown`：

- `in_flight_turn_crash_recovery`
- `event_replay`
- Provider 内部传输的 Host Enforcement

Windows Alpha 隐藏 Merge、Claude、ACP、WSL、macOS、Linux 操作入口。`unknown` 不会被 UI 或 Adapter Contract 伪装为 supported。

结果：通过。

## 公开 CI

`.github/workflows/windows-ci.yml` 在既有无凭据测试后新增：

```text
npm run test:opencode-adapter
npm run test:alpha
npm run test:gate3
```

这些测试全部使用 Fake OpenCode 或脱敏 Fixture，不要求用户 Provider 凭据。真实 G3 Probe 只在本机显式运行。

## 失败与修正

G3 恢复测试第一版错误地对包含预期 `false` 的安全字段使用 `every(Boolean)`，导致 `runtimeUnavailableShownAsRunning:false` 被误判为 Gate 失败。测试改为逐字段验证预期语义；未降低恢复或安全标准，随后 5/5 通过。

## 验证命令

```powershell
npm run probe:gate3
npm run test:gate3
npm run test:opencode-adapter
npm run test:alpha
npm run test:host
npm run typecheck
npm run check
git diff --check
```

## 最终验证结果

- 真实 DeepSeek Alpha Probe：1/1 通过；1 次权限决策；Cleanup `succeeded`。
- G3 Gate：5/5 通过。
- 新增 CI 相关本地回归：32/32 通过。
- TypeScript build/typecheck：27/27 任务通过；Workspace Build 16/16 包通过。
- Checkpoint 校验：27 tasks、6 gates、3 backlog，状态 `valid`。
- Secret Scan：193 个文件，状态 `clean`。
- `git diff --check`：通过。

## Gate 决策

- G3：通过。
- 允许下一任务：T4.4。
- 仍禁止：把 Worktree 描述为安全沙箱；在公开 CI 使用 Provider Key；持久化 Prompt/源码/原始 Runtime Event；展示未实现的 Merge、Claude、ACP 或跨平台入口；把 in-flight Turn 恢复或 event replay 标记为 supported。