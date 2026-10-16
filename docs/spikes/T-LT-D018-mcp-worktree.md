# T-LT-D018：会话目录配置同步

实际完成：2026-10-16；Windows，Node 24.11.1。

MCP 更新覆盖项目与现有非只读 Runtime Worktree；新会话和分支在登记前绑定配置。应用内用户范围作用于所有项目，项目和 local 范围只作用于绑定项目。Direct API 不启用工具循环，因此不生成 MCP 文件。新 Worktree 可以继承已提交受管条目的所有权，不接管独立条目；绑定失败清理本次新建 Worktree 和分支。

验证：桌面本地 TypeScript 编译通过；MCP、Worktree 与能力测试 24/24。正式会话创建及客户端启动回调核对实际 cwd 文件，覆盖已有会话、新会话、提交过的配置继承、删除范围及创建失败清理。提交前运行 `npm run check`、`git diff --check`。

此项证明配置位于真实工作目录，不把文件存在等同于 Runtime 已加载。Codex/Claude 各自的加载格式与参数由 D019 接续。独立项目文件按 Git Worktree 的版本继承，未提交的独立配置不自动复制。
