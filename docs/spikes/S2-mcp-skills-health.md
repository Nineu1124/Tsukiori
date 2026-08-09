# S2 MCP/Skills 健康与真实作用域报告

- 日期：2026-08-09
- 平台：Windows Native x64
- Runtime：Codex app-server `0.146.0`、Claude Code `2.1.226`
- 结论：PARTIAL PASS（Codex 可对账；Claude 保守降级）

## 问题

“配置文件存在”不能证明 Runtime 已加载 MCP/Skill。此前 Tsukiori 同时有本地 CRUD、项目目录扫描和 Codex 原生清单，但三者没有对账；Local MCP 还会在查询其他项目时被误列出。

## 已实现

- User MCP 对所有项目可见；Project/Local MCP 必须绑定 Project，且只在对应项目查询中出现；
- 健康检查只在用户请求时运行，不把原始路径、Command、URL、Tool Schema 或认证内容写入 Renderer State/Transcript；
- Codex 使用当前 Session Worktree 调用 `skills/list` 与 `mcpServerStatus/list`，按规范化名称和宿主记录对账；
- 状态区分 `healthy`、`attention`、`unavailable`、`disabled`、`unknown`；可见性区分 `observed`、`not_observed`、`unknown`；
- Runtime-only 能力单独显示，避免把 Codex 自己的 User/Managed 配置误认成 Tsukiori 项目配置；
- MCP 响应没有 Scope 字段时显示 `runtime_effective_scope_unknown`，不从文件位置猜测；
- Claude 仅使用 `system/init.mcp_servers.length` 作为数量证据，名称、认证、健康和 Skills 均保持 unknown。

## 验证

- `tests/interactive/workspace-capabilities.test.mjs`：跨项目 Local 隔离、未绑定 Scope 拒绝、持久化无 Secret；
- `tests/interactive/interactive-workspace.test.mjs`：配置 MCP、Runtime-only/匹配 Skill、Codex 观察与未观察状态；
- `tests/ui/basic-ui.test.mjs`：固定 Preload 方法、健康/真实作用域文案和无 Node/HTML 注入回归。

## 未完成

- Claude MCP 名称与 Skills 的可靠枚举协议；
- Codex/Claude 的 MCP OAuth 登录、启动失败通知、重连与显式 Reload 流程；
- User/Project/Local 配置到每个 Runtime 原生配置层的写入合同与回滚；
- API Provider `--bare` 模式的显式 MCP/Skills 白名单；
- 真实 MCP Server 的离线、超时、认证过期和 Tool Schema 变更 E2E。

因此本功能是健康/作用域可见性闭环，不宣称 Tsukiori 已成为统一 MCP 配置器。
