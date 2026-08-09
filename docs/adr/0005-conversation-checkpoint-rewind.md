# ADR-0005：会话 Checkpoint/Rewind 一致性边界

- 状态：Accepted
- 日期：2026-08-09
- 观察版本：Codex app-server `0.146.0`、Claude Code `2.1.226`、Windows Git
- 决策范围：本地 Desktop Session 的代码与对话回退；不代表完整 Durable Recovery

## 背景

仅保存 Git Commit 不能表达暂存区、未暂存修改、未跟踪文件和对话位置；仅复制 Transcript 又会造成 Runtime 历史与代码状态分离。自动重放 Prompt 还可能重复文件写入、Shell、网络或外部系统副作用。

因此，一个可交付的 Checkpoint 必须同时锚定代码、宿主 Transcript 和 Runtime 原生历史，并且失败时保留人工恢复落点。

## 决策

1. 每个 Checkpoint 保存版本化 manifest、本地 Transcript 副本与专用 Git ref。manifest 记录当前 HEAD、真实 Index Tree、完整 Worktree Tree、Transcript 事件数/哈希、Turn 数，以及 Runtime Session + Turn/Message 锚点。
2. Worktree Tree 包含 tracked 与未跟踪非忽略文件；忽略文件和外部链接目标不作为用户源码快照。存在未解决冲突、Transcript 无法解析或变更文件超过 256 MiB 时拒绝创建。
3. Rewind 不移动当前分支 HEAD。服务使用目标 Worktree Tree 恢复文件，再单独恢复目标 Index Tree，并复算两棵 Tree 验证；Transcript 使用本地原子替换并校验 SHA-256。
4. 每次 Rewind 在任何破坏性 Git 操作前自动创建 Recovery Checkpoint。恢复失败时返回其 ID，不删除恢复点，也不伪装成功。
5. Codex 在代码回退前调用 `thread/fork`，以目标 Checkpoint 的 `lastTurnId` 派生新 Thread；源 Thread 不被改写。
6. Claude 在代码/Transcript 回退后，把目标 Runtime Session/Assistant Message 保存为待续锚点；下一 Turn 使用 `--resume <source> --resume-session-at <message> --fork-session`，并采用 Runtime 返回的新 Session ID。
7. 不自动重放 Prompt。Checkpoint 只允许在启用本地 Transcript、Session 空闲且至少有一个完整 Runtime 锚点时创建或回退。
8. Renderer 必须先 Preview，显示变化路径数和将移除的对话事件数，明确说明 HEAD 不移动且会先创建 Recovery Checkpoint。

## 未采用方案

### `git stash` 作为 Checkpoint

拒绝。Stash 不能稳定表达宿主 Transcript 与 Runtime 锚点，且 Index/未跟踪文件语义依赖参数，难以形成可验证 manifest。

### `git reset --hard` 或移动分支 HEAD

拒绝。会改写用户当前分支语义，并把“回到工作状态”混成“改写提交历史”。

### 只恢复本地 Transcript

拒绝。Runtime 仍停在未来历史，下一轮上下文和代码会分叉。

### 崩溃后自动重放最后 Prompt

拒绝。无法证明 Tool 副作用可幂等重放。

## 安全、兼容性与限制

- Checkpoint 数据只保存在本机 userData 和仓库 `refs/tsukiori/checkpoints/*`；Renderer 不接触文件系统或 Git 命令。
- manifest ID、Runtime ID、对象 ID、ref、路径、Transcript 身份和哈希均在使用前校验；Git 以结构化参数启动，不经过 Shell。
- 当前实现不是跨设备备份，不保存 ignored 构建产物，也不替代 Git Commit。
- Codex `thread/fork` 已由 Desktop 跨层合同覆盖；Claude `resume-session-at` 已由锁定版本的 Adapter/Fake CLI 覆盖。真实 Claude CLI Message Rewind、真实 Codex 会话回退和回退事务中途强杀仍需独立 E2E/故障注入。
- Runtime 派生发生在宿主回退事务边界附近；进程在阶段间终止时尚无 Durable Operation 日志自动对账，恢复点是当前人工恢复保证。

## 验证

- `tests/interactive/checkpoint-service.test.mjs`：HEAD、Index、Worktree、未跟踪文件、Transcript、恢复点反向回退和大小上限；
- `tests/interactive/interactive-workspace.test.mjs`：Codex `thread/fork`、Claude Message 锚点、代码/对话回退与新 Runtime Session 采用；
- `tests/claude-adapter/claude-lifecycle.test.mjs`：`--resume-session-at` 与 `--fork-session` 参数合同；
- `tests/ui/basic-ui.test.mjs`：Preview、确认文案和固定 Preload API。
