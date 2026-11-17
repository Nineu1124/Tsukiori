# Git 队列、取消与结果核对

适用范围：合入 T-LT-D047–D049 的源码构建。工作区仍由 Electron Main 托管；Daemon 业务与 Durable Operation 恢复尚未接通。

## 哪些操作进入队列

| 操作 | 当前执行方式 |
| --- | --- |
| 状态与 Working Diff | 异步 Git 子进程；同一次状态与 Diff Stat 读取属于同一队列项 |
| Stage、Unstage、Commit | 每个规范化 Worktree 的异步 FIFO；Commit 与最终 HEAD 核验不被其他队列项插入 |
| Checkpoint 回退 | Runtime 恢复协调期间持有同树队列；其检查点服务内部仍有同步 Git |
| Checkpoint 创建/预览、Integration | 原服务仍有同步部分；同树有队列任务时拒绝竞争，需等待后重试 |
| 会话创建、Fork 等旧 Git helper | 保留原行为，同树存在不属于当前操作的队列时返回 busy |
| 终端或 Runtime 自行执行的 Git | 不进入应用队列；应用不能保证它们与 GUI 操作串行 |

路径按真实目录及 Windows 大小写规范化，Junction 别名共享队列；不同 Worktree 可独立推进。Worktree 仍是代码隔离机制，不是安全沙箱。队列不负责跨进程排他，也不会阻止外部编辑器或 Agent 修改文件。

## 状态和结果含义

已接受的队列项产生 `operationId`；入队前的参数错误、预先取消等拒绝不一定生成 ID。当前状态投影通过 `git.operation` 事件提供，不包含命令参数、文件正文或原始 stderr。

| 状态 | outcome | 如何理解 |
| --- | --- | --- |
| queued | not_started | 正在等待同树前项；尚未调用执行函数 |
| running | 写入为 unknown，读取为 known | 写入的最终副作用尚未确认；读取不修改 Git 状态 |
| succeeded | known | 执行完成并收到成功结果；Commit 已核对 HEAD |
| 排队时 cancelled | not_started | 取消立即答复，该项不会执行 |
| 已启动写入后 failed/cancelled | unknown | 可能已有暂存、提交或 Hook 副作用，失败不能解释为全部回滚 |
| 读取 failed/cancelled | known | 未返回完整读取结果；执行器不会把截断输出当作成功 |

Main 等待实际完成后答复。Git 错误返回 `git_failed`、`git_timeout`、`git_output_limit`、`git_cancelled`、`git_unavailable`、`git_busy` 或 `git_queue_full`，在适用时附带 `operationId` 和 `outcome`。结果未知时，现有界面消息会要求先检查 Git 状态；通用的单项取消按钮尚未提供。

队列不自动重试失败项。之后独立提交的操作仍按队列处理；若操作之间存在业务依赖，应等待前一项成功后再提交下一项。取消一项不代表前一项已经完成，内部槽位随清理释放。

## 超时、输出与退出

- 每个异步 Git 子进程最多运行 30 秒，总 stdout/stderr 最多 4 MiB；界面的 Working Diff 另限 128,000 字符。
- 每个 Worktree 的队列容量为 64 项，包含运行项。满队列明确拒绝新项。
- 执行器不使用 Shell，关闭 fsmonitor，Diff 禁用外部 Diff 和 textconv。错误消息不回显 stderr 或取消原因。
- 内部 AbortSignal 与应用退出可取消任务。退出先停止接收队列项，取消待处理及活动任务，并等待执行器和 Runtime 清理。
- 终止 Git 父进程不等于撤销已执行的 Hook 或文件变更；不能据此宣称整个进程树或所有副作用已回滚。
- 队列与状态事件目前保存在内存，有界事件缓存可能淘汰旧记录。应用强退后不会自动重放 Git 请求，也不能仅凭重启后的空队列判断上次是否执行。

## 结果未知时怎样核对

先等待仍在运行的任务结束，再在对应 Session Worktree 查看文件状态、Working Diff、Staged Diff 和最新提交。提交不确定时，核对当前 HEAD、提交主题和文件内容，确认结果后再决定下一步；不要直接重复 Commit 或将“取消”当作撤销。

只读排查示例，先把目录替换为当前会话的真实 Worktree：

```powershell
$sessionWorktree = 'D:\Projects\example\.worktrees\session'
git -C $sessionWorktree status --porcelain=v1 --untracked-files=all
git -C $sessionWorktree diff --no-ext-diff --no-textconv
git -C $sessionWorktree diff --cached --no-ext-diff --no-textconv
git -C $sessionWorktree log -1 --format='%H %s'
```

这里不提供自动 Reset、Clean 或重复写入步骤。涉及 Checkpoint 或 Integration 时，保留已有恢复引用、检查点与集成记录；数据备份见[工作区恢复说明](./workspace-recovery.md)。

实现与证据：[异步读取](../spikes/T-LT-D047-async-git-reads.md)、[Worktree 队列](../spikes/T-LT-D048-git-worktree-queue.md)、[GitExecutor](../../apps/desktop/electron-main/git-executor.ts)、[GitWorktreeQueue](../../apps/desktop/electron-main/git-worktree-queue.ts)。本说明没有将旧同步链路、后台恢复或 G-LT-02 提前验收。
