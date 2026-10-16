# T-LT-D020：已有会话的 MCP 更新

实际完成：2026-10-16，Windows / Node 24.11.1，Codex 0.146.0 与 Claude 2.1.226 离线合同。

Codex 客户端保存本次启动使用的 MCP 配置摘要。保存成功后，运行中的 Turn 保留原进程；健康结果返回 pending_next_turn 并说明生效时机。下一轮或空闲时查询能力会先停止旧进程、加载新配置、恢复原 Thread，再执行请求。删除条目同样生效；仅更新时间等无关变化不触发重启。初始化锁继续防止重复启动，旧客户端回调不能删除新客户端。

配置写入失败不改变摘要或现有客户端；重新加载失败不启动 Turn、不更换 Thread，错误脱敏并允许再次恢复。Claude 每轮启动独立进程，通过同一路径读取最新文件，沿用原 session id。

验证：桌面 TypeScript 编译通过；`node --test tests/interactive/mcp-reload.test.mjs tests/interactive/codex-resume.test.mjs tests/interactive/codex-lifecycle.test.mjs` 10/10；`node --test tests/claude-adapter/claude-lifecycle.test.mjs` 14/14。覆盖运行中更新、删除、冲突回滚、恢复失败重试、原会话身份、并发初始化及子进程重新读取配置。`npm run check`、`git diff --check` 通过后提交。

这里验证宿主重载合同，不把配置已加载等同于服务器已连接。外部直接改写 Codex 原生 config.toml 的热加载不在宿主管理范围；Claude 未提供逐服务器观测时仍返回 unknown。
