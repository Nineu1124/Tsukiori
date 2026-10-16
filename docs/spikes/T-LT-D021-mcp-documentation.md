# T-LT-D021：MCP 使用说明

实际完成：2026-10-16。新增 operations/mcp-configuration.md 并从 README 链接，核对 WorkspaceCapabilities 的选择、合并与所有权逻辑，以及 InteractiveWorkspace 的实际启动和重载路径。

说明 User/Project/Local 与项目根目录、Worktree、原生配置的关系，明确 Local 当前不具有私有原生配置层。给出冲突处理、回滚失败保留证据、文件上限、环境隔离、未知健康状态和未支持项，避免把文件存在等同于连接成功。原始 S2 报告作为历史证据保留。

验证：逐项对照 D015–D020 的实现和验收记录；检查本文新增本地链接均存在。`npm run check` 和 `git diff --check` 通过后提交。仅文档改动，无新增运行测试或真实凭据操作。
