# T-LT-D013：长对话重启与分支回归

实际完成：2026-09-28。Windows；Node 24.11.1；沿用锁文件依赖。

四项新回归覆盖：1,100 条 Delta、超过 8 MiB 的分段日志；55 轮、110 条完整消息；关闭保存后重启只包含新消息；损坏行阻止继续；会话分支重启仍继承源历史。大日志的内存消息和重启消息逐条比较，Checkpoint 超过 8 MiB 时明确拒绝。

首轮新增测试 3/4，通过失败用例发现 Direct API Fork 仍复制 UI 缓冲，导致源消息被淘汰后分支没有前文。调整本项范围：API Fork 从独立模型历史重建完整用户、助手事件并保存；不完整记录禁止 Fork。Claude Fork 的 Runtime 原生恢复路径保持原有语义。

扩大回归首轮 140/141。失败是旧团队测试替身未实现 D011 所需的 resumeThread；补齐方法并断言恢复到原成员 Thread，没有放宽团队重试、取消或状态断言。

构建 `npm run build` 21/21、`npm run typecheck` 34/34。最终回归命令：`node --test --test-concurrency=4 tests/interactive/*.test.mjs tests/claude-adapter/*.test.mjs tests/security/*.test.mjs`。提交前执行 `npm run check`、`git diff --check`。没有执行真实 Provider 或安装包测试。

最终结果：141/141 通过，约 92 秒。新增长对话及分支回归、团队重试回归均通过。
