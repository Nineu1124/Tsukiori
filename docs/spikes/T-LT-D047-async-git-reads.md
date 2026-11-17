# T-LT-D047：异步读取 Git 状态与 Diff

实际完成：2026-11-17（Asia/Hong_Kong）。正式 `git_status`、`git_diff` IPC 等待 `GitExecutor` 的异步子进程结果；不再通过 Main 的 `spawnSync` 读取这两项。状态结果及路径校验保持原合同，Diff 显示仍限 128,000 字符。

执行器不使用 Shell，关闭 fsmonitor 外部调用，Diff 禁用 ext-diff/textconv。总 stdout/stderr 最多 4 MiB、执行最多 30 秒；超过限制拒绝整次读取，不将截断结果当作成功。错误只返回类别及固定消息，不回显 stderr、参数或取消原因。AbortSignal 与工作区 shutdown 会终止读取并等待子进程关闭。

Windows / Node.js 24.16.0 / pnpm 11.9.0：

- 桌面构建通过。
- `git-executor`、正式命令及来源边界联合 16/16；正式 Git 审查与提交专项 1/1。
- 慢子进程期间，真实 Main 命令回调仍能处理 poll_events；Git 读取完成后返回预期文件及 Diff。
- 真实 Git Worktree 的修改结果、路径穿越拒绝、stderr 脱敏、不可执行程序、输出上限、超时、活动/预先取消及退出后拒绝新任务通过。
- 提交前 `npm run check`、`git diff --check`。

本项只切换状态和 Diff 读取。会话创建、检查点、集成等旧 Git 调用仍有同步部分，不能将本项当作全部 Git 链路均已异步；写队列、取消归因及其范围由 D048/D049 说明。无真实 Provider 调用。
