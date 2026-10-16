# T-LT-D015：保留已有 MCP 配置

实际完成：2026-10-16。Windows，Node 24.11.1。

项目同步改为合并 mcpServers，保留独立服务器及其他顶层字段。用户目录记录按目标路径隔离的管理条目，重启后删除配置也不会删掉独立条目。损坏 JSON、数组、非对象服务器配置均拒绝覆盖。

验证：本地 TypeScript 编译器 `tsc -p apps/desktop/tsconfig.json` 通过；MCP 与 WorkspaceCapabilities 测试 9/9。首次 `npm run build` 在包管理器子进程停滞，已中止，改用仓库锁定的本地编译器；没有把中止的全仓构建计为通过。提交前执行 `npm run check`、`git diff --check`。

同名冲突与跨文件事务分别在 D016、D017 接续，本项不宣称已覆盖这两种失败。
