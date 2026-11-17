# T-LT-D048：按 Worktree 串行执行 Git 审查变更

实际完成：2026-11-17（Asia/Hong_Kong）。Stage、Unstage、Commit 通过异步 GitExecutor 执行，并与状态/Diff 读取共用规范化 Worktree FIFO。Junction、大小写别名归入同一队列；不同 Worktree 可独立执行。一次 Commit 的执行与 HEAD 核验属于同一队列项，Main IPC 等待真实结果，不提前返回成功。

每个操作有独立 ID、queued/running/终态及 not_started/known/unknown 结果。排队取消立即返回且不执行；已启动写操作取消或失败保守报告 unknown，界面消息要求先检查 Git 状态。IPC 返回关联 ID 与结果，不输出参数或 stderr，不自动重试。每树最多 64 项，退出时取消队列及子进程并等待清理。

同步旧 Git helper 拒绝与活动队列竞争；Checkpoint 创建/预览与 Integration 入口增加同树检查，跨 Runtime await 的 Checkpoint 回退持有同一队列。异步上下文按操作 ID 归属，旧回调不能继承下一操作的执行权限。

Windows / Node.js 24.16.0 / pnpm 11.9.0：

- 桌面构建通过；队列、执行器、正式命令与来源边界联合 22/22；补充旧异步上下文回归后队列组 7/7。
- 正式工作区、Checkpoint 与 Integration 联合 29/29。
- 同树及 Junction FIFO、另一 Worktree 继续运行、队列取消不执行、活动子进程取消、shutdown 拒绝后续请求通过。
- 正式 Main 并发收到 Stage→Unstage→Stage→Commit 后得到同序操作与干净状态；取消 IPC 明确返回 operationId/outcome。
- 提交前 `npm run check`、`git diff --check`。

队列及操作投影目前在内存，不是 Durable Operation，也不提供 UI 的通用单项取消按钮；AbortSignal 和退出策略可取消。旧会话创建、检查点及集成服务内部仍有同步 Git，外部终端/Runtime 自己执行的 Git 不受此队列控制。本项不将全部 Git 调用或 G-LT-02 验收提前标为完成。无真实 Provider 请求。
