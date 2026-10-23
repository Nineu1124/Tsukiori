# T-LT-D030：抽出正式会话创建服务

实际完成：2026-10-23。前置 D029 的服务归属 ADR 已接受。

正式 `InteractiveWorkspace.createSession` 现在委托 `SessionCreationService`。服务负责选择 Runtime/Provider、检查认证和参数、创建 Git Worktree、同步 MCP、登记会话并按原顺序发出 created/ready 事件。项目、配置、Git、保存和事件接口由当前 Main 宿主注入；没有新增执行链或迁入 Daemon。共用类型与选择策略已从工作区大文件移出。

Windows / Node 24.11.1：桌面 TypeScript 编译通过；会话创建、MCP Worktree 和 Thinking 合同 9/9 通过。真实临时 Git 仓库验证独立分支、目录、重启后原生 ID 与元数据；无效选择不新增会话、分支、目录或事件，MCP 绑定失败仍只清理本次创建内容。`npm run check`、`git diff --check` 通过后提交。测试使用离线 Runtime 替身，不扩大真实 Runtime 支持等级。
