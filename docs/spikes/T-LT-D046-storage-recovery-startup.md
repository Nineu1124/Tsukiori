# T-LT-D046：显示迁移与存储失败状态

实际完成：2026-11-17（Asia/Hong_Kong）。Main 正式启动使用 `openWorkspaceWithRecovery`。状态源、迁移、历史导入及 SQLite 初始化失败统一生成只含允许字段的阶段/原因投影；不会输出原异常正文、SQL 或对话。失败时在创建工作台窗口前显示恢复对话框，提供重试、打开数据目录和退出。

打开目录不会自动再次执行迁移；用户显式重试后才重建工作区服务。目录打开失败仍保留恢复状态，提示手动访问。原文件、已有备份及已提交阶段保留，不创建虚假空工作区，也不删除或改写不兼容数据。正常启动和原有备份恢复提示保持可用。

Windows / Node.js 24.16.0 / pnpm 11.9.0：

- 桌面构建通过；startup、默认历史存储、正式命令及来源边界联合 18/18。
- `node --test tests/host/workspace-startup-smoke.test.mjs`：1/1。真实 Electron 导入正式 Main，用合成坏 JSON 触发恢复；只替换原生对话框的答复以自动选择退出，观察到三个真实按钮配置、正确阶段和原因、工作台窗口数 0、源字节不变且未创建 SQLite。
- 测试覆盖恢复后显式重试、打开目录不写数据、目录打开失败以及异常正文不进入诊断。
- `node scripts/probe-ui-interactions.mjs`：Schema 6 全通过，正式成功启动与设置、弹窗、拖动及布局保持正常。
- 提交前 `npm run check`、`git diff --check`。

初次专项回归的一处测试错误地预期底层 JSON 错误阶段；正式路径先经过迁移器，现精确检查 `state_migration/source_invalid`。只使用临时目录及替身，没有真实 Provider 请求。原生对话框的视觉排版没有另行人工验收；后续 Daemon 写入所有权由 D050 及阶段 3 处理。
