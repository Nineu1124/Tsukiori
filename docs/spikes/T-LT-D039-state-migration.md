# T-LT-D039：项目、会话和设置的离线迁移

实际完成：2026-10-23。`planWorkspaceMigration` 只读取固定版本文件和相邻数据清单，不打开数据库、不修复源文件；优先选择 v3/v2/v1，坏主文件只接受有效的同版本备份，未来版本拒绝回退。输出计数、源文件哈希和状态哈希，保留项目、会话、团队及原生 Runtime ID 和凭据引用。

`applyWorkspaceMigration` 先逐字节备份及校验，再在同一事务写状态和迁移记录。计划过期或被修改拒绝执行；同源重复执行返回已完成，保留迁移后活动；目标已有另一套状态则拒绝覆盖。Transcript、MCP、Schedule、Checkpoint、导入和其他领域的清单明确标为原地保留，不假报已迁入 SQLite。

Windows / Node 24.11.1：桌面编译通过，状态迁移 8/8 项通过；包含 dry run 零写入、版本选择、关联及引用保留、主备恢复、空首次启动、源变化/计划篡改拒绝、备份验证、事务失败和重复执行。后续故障组合另由 D041 记录。

执行：`node --test tests/interactive/workspace-state-migration.test.mjs`、`npm run check`、`git diff --check`。当前源哈希复查不等于跨进程写锁，实际迁移前仍须关闭应用及其他写入方。
