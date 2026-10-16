# T-LT-D019：按 Runtime 接入 MCP

实际完成：2026-10-16。Windows / Node 24.11.1；离线 Codex 合同版本 0.146.0、Claude 2.1.226；本机 Codex 配置解析探测 0.162.0。

Codex 的正式启动入口把启用的登记转换成 `-c mcp_servers.<name>.<field>=<TOML>`，传入 stdio 的 command、args、env_vars 或 HTTP 的 url。不改写用户原生 config.toml，也不替换整个 mcp_servers。生成名称采用 `tsukiori_` 加登记 ID 的摘要，健康面板按同一名称关联。该前缀保留给宿主管理，用户原生配置应避免使用；显示名称仍保留用户填写的名称。SSE 没有已验证合同，启动前明确拒绝。

Claude 显式收到实际 Worktree 的 `.mcp.json` 路径，包括 Provider 的 bare 模式；未探测到 mcp-config 能力时拒绝启动。未添加 strict-mcp-config，原生配置的加载与权限仍由 Claude 决定。环境变量只登记名字，既有 Provider 环境隔离不变。

验证命令：

- `tsc -p packages/adapter-claude/tsconfig.json` 和 `tsc -p apps/desktop/tsconfig.json` 通过。
- `node --test tests/interactive/mcp-runtime-config.test.mjs tests/claude-adapter/*.test.mjs`：16/16。
- `node --test --test-name-pattern "session lifecycle|parallel Codex" tests/interactive/codex-app-server-environment.test.mjs tests/interactive/interactive-workspace.test.mjs`：2/2，含子进程 argv、Claude 文件读取、Codex 健康关联。
- 本机 `codex -c ... mcp get <fixture-name> --json`：路径、引号参数、env_vars 完整往返；未启动服务器，未发送 Provider 请求。
- `npm run check`、`git diff --check` 通过后提交。

回归初次发现健康测试仍返回旧显示名称，已改为从实际启动参数返回 Runtime 名称，保留 observed/not_observed 断言。离线合同及解析器通过不代表真实 MCP 连接、OAuth 或工具调用已验收；未知项继续显示 unknown。本机较新版本的解析探测不提升整套 Adapter 的兼容等级。

依据：[Codex MCP 配置](https://learn.chatgpt.com/docs/extend/mcp)、[Codex 启动覆盖参数](https://learn.chatgpt.com/docs/config-file/config-advanced)、[Claude CLI 参数](https://code.claude.com/docs/en/cli-reference)，核对于实际完成日。
