# G2 阶段 2 Gate 报告

- Gate：G2
- 评估日期：2026-08-02
- 平台：Windows x64
- 结论：通过，可以进入阶段 3 Runtime Adapter 开发
- 证据 Fixture：`tests/fixtures/gates/g2-evidence.json`
- 自动化 Gate：`tests/gates/g2.test.mjs`

## 总结

G2 的五个 Checkpoint 均已独立验证。T2.1 至 T2.4 已完成 Execution Environment/Project、Durable Worktree、Setup/Cleanup/Binding 和 Git Status/Diff；三个真实 Host Session 分别绑定三个 Worktree，并由三个 Fake Runtime Session 并行驱动修改，主工作区保持干净；创建与 dirty cleanup 强杀恢复不会重放外部动作，也不丢失未提交代码；路径穿越、Junction、Windows/WSL 跨环境、dirty 删除和 Git path 逃逸均被拒绝。

Gate 只授权进入 Runtime Adapter 阶段，不把 Fake Runtime 证据升级为真实 OpenCode/Codex 能力，也不把 Worktree 描述为安全沙箱。

## 输入任务与提交

| 任务 | 提交 | Windows CI |
| --- | --- | --- |
| T2.1 Project Manager | `9affecad2f1f66a023fe70b37c995f0c950dded4` | 30733980535：success |
| T2.2 Worktree/Durable Operation | `07940c38af29d06448882d5eb8e3d4b4241541b1` | 30734388929：success |
| T2.3 Setup/Cleanup/Binding | `182eabec33e7cbe58ca54c25b2e70004d0263f60` | 30735030702：success |
| T2.4 Git Status/Diff | `cdcb504f0f0f0050fba23d735361105ef4ecc1c4` | 30735413041：success |

T2.4 CI：<https://github.com/Nineu1124/Tsukiori/actions/runs/30735413041>

## G2-C1 T2.1 至 T2.4 全部完成

Gate 逐节解析架构源文档。每个任务必须存在 `[x]`，并且任务节内不能残留 `[ ]`。Fixture 保存四个完成提交和对应 Windows CI success 结果，Gate 验证每个 SHA 都是当前 HEAD 的祖先。

结果：通过。

## G2-C2 三个 Fake Session/Worktree 并行闭环

同一 Project 下创建三个 Host Session、三个 Fake Runtime Session 和三个 Workspace Binding。并发流程为：

1. Fake Runtime 发出 `message.started`；
2. 各自在独立 Worktree 写入唯一文件；
3. Fake Runtime 发出 `message.completed`；
4. GitDiffService 从各自 Binding 查询 Status。

Gate 验证三个 Worktree ID 和 canonical path 均唯一；每个 Worktree 只出现自己的文件；三个 Fake Session 均回到 idle；主工作区 Git Status 为空且不存在任何 Session-only 文件。

结果：通过。

## G2-C3 创建与清理强杀恢复

- create 在 `git worktree add` 已完成后注入 Daemon crash；恢复通过真实 Git/文件系统事实将 Operation 终结为 `committed`，不重放 create。
- 在恢复的 Worktree 写入未提交代码，再在 remove 进入 `running` 后注入 Daemon crash；恢复观察 Worktree 仍注册且存在，将 remove 终结为 `failed`，不重放 remove。
- 再次普通 remove 被 dirty/untracked 保护拒绝，逐字节读取确认未提交文件仍完整。

结果：通过。

## G2-C4 路径、Junction 与跨环境安全

Gate 使用真实 Windows 文件系统和 Git 验证：

- `directoryName=..` 在执行 Git 前拒绝；
- Worktree Root 内的项目目录 Junction 指向 Root 外时，经 realpath 检测并拒绝；
- Windows Project 绑定 WSL runtime environment 时抛出 EnvironmentBoundaryError；
- GitDiffService 对 `..\\outside.txt` 在调用 Git 前拒绝；
- Binding path、Worktree owner、Project 和 Environment 仍由服务逐项核对。

结果：通过。

## G2-C5 强制删除保护与 Git 边界

Gate 在已绑定 Worktree 写入未跟踪文件后调用默认 remove。T2.2 的 porcelain v2 dirty 检查拒绝删除，文件和 Worktree 均保留。GitDiffService 只能以 Session ID 解析绑定 cwd，不能把主工作区或任意路径作为查询根；文件参数均位于 `--` 后。

结果：通过。

## 失败与修正记录

1. 首轮 Gate 的跨环境负例正确抛出 `EnvironmentBoundaryError: runtime environment ... does not match ...`，测试却匹配旧的 `same Execution Environment` 措辞，导致 Junction 段未继续。断言改为匹配当前稳定错误语义 `does not match` 后，完整边界测试通过；安全标准没有降低。

## 验证命令与结果

```powershell
pnpm run build
pnpm run typecheck
npm run test:project
npm run test:worktree
npm run test:workspace
npm run test:git
npm run test:gate2
npm run check
git diff --check
```

| 测试 | 结果 |
| --- | --- |
| G2 Gate | 5/5 pass |
| Project | 6/6 pass |
| Worktree | 6/6 pass |
| Workspace | 9/9 pass |
| Git/Diff | 6/6 pass |
| Workspace typecheck | 20/20 tasks pass（13 packages） |
| TODO/依赖检查 | valid：27 tasks、6 gates、3 backlog |
| 秘密扫描 | clean |

## Gate 决策

- G2：通过。
- 允许下一任务：按当前执行策略进入 T3/T4 Runtime Adapter 工作；OpenCode 如继续忽略，则不得将 T0.1/T3 的 unknown 能力标记为 supported。
- 仍禁止：绕过 Worktree dirty/proc safety；混用 Windows/WSL Git；持久化 Diff/用户源码；把 Fake Runtime 证据写成真实 Runtime 支持。
