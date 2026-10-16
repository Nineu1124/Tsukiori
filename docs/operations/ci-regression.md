# 离线回归入口

Windows CI 先执行 npm run check、完整 build 和 typecheck，再调用 `node scripts/run-ci-tests.mjs <分组>`。构建只做一次，不在每个测试组前重复启动构建图。分组直接运行已构建产物，首次本地验证也必须先构建。

| 分组 | 范围 |
| --- | --- |
| core | 合同、数据库、事件、权限、诊断、CI 工具与会话快照 |
| host | Electron、Daemon、命名管道和合成凭据；串行执行文件 |
| adapters | Codex/OpenCode/Windows 协议夹具、Adapter 与双 Runtime 故障 |
| claude | Claude Adapter 的发现、认证隔离、权限、恢复与 MCP |
| workspace | 项目、Worktree、Git、Alpha 流程和恢复 |
| desktop | UI、交互工作区、Computer Use；通过后执行真实 UI 交互探测 |
| release | 发布清单、图标与候选版本合同 |
| gates | G0–G5 顺序执行，最后运行 v1-ready；任一步失败即停止 |

每个 Actions 步骤只有一条命令，Node 执行器保留首个失败子进程的非零退出码；不自动重试失败用例。Windows 宿主组采用单文件并发，其余组上限为 4。输出包含实际耗时，便于后续根据数据调整。整个作业上限为 20 分钟，包含依赖安装及最后的候选安装包验证余量；没有修改单个故障用例的等待时间。

本地可按下面顺序运行，避免 PowerShell 的后续成功命令掩盖前面的退出码：

```powershell
npm run build
if ($LASTEXITCODE -ne 0) { throw '构建失败' }
npm run typecheck
if ($LASTEXITCODE -ne 0) { throw '类型检查失败' }
foreach ($group in @('core', 'host', 'adapters', 'claude', 'workspace', 'desktop', 'release', 'gates')) {
  node scripts/run-ci-tests.mjs $group
  if ($LASTEXITCODE -ne 0) { throw "回归失败：$group" }
}
```

凭据合同创建并清理随机测试条目，不需要真实 Provider Key。受限沙箱可能禁止 Credential Manager；应在正常 Windows 用户权限下验证，不要删掉断言。安装包生命周期仍由 CI 最后独立步骤执行，本地测试组不会安装产品。
