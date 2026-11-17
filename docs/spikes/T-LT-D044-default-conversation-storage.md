# T-LT-D044：正式消息历史使用统一存储

实际完成：2026-11-17（Asia/Hong_Kong）。正式工作区为 SQLite 状态 Repository 装配共用同一连接的 `SqliteConversationRepository`。完整 API 消息、显示事件、分支、搜索和 Checkpoint 通过既有会话接口读取与替换，不再追加旧 JSONL。显式注入的兼容 Repository 仍支持旧 Transcript。

首次使用历史存储时，沿用 D040 的全部会话校验、字节备份、事务导入和完成标记。缺少必需历史时停止初始化并保留状态阶段；恢复旧源后可继续。激活后旧文件改变不覆盖新事件。关闭保存仍只保留内存消息；坏行或写入失败持续标记历史不完整并拒绝继续。

切换发现 cc-haha 的文件系统时间戳可能带小数毫秒，现统一规范为整数毫秒，不放宽存储身份和时间校验。视觉捕获的临时数据补充合成历史，使正式迁移校验继续生效。

Windows / Node.js 24.16.0 / pnpm 11.9.0：

- 桌面构建及类型检查通过。
- `node --test --test-concurrency=4 tests/interactive/*.test.mjs`：230/230。
- 新增正式默认入口验证约 900 KiB 完整模型消息、旧源保留、只导入一次、缺源拒绝与恢复、跨会话拒绝和事务替换回滚。
- 长对话验证 1,100 个 Delta、超过 8 MiB、55 轮问答、UI 淘汰后的分支与重启；原生恢复、检查点及导入回归通过。
- 原依赖 JSON 索引目录的写失败注入改为真实 SQLite 拒写 Trigger；记录不完整状态可跨重启保留，5/5 专项通过。
- UI 静态 14/14；`node scripts/probe-ui-interactions.mjs` Schema 6 全通过，含正式 Electron 设置保存、弹窗、拖动和四档布局。
- 提交前 `npm run check`、`git diff --check`。

全部使用临时合成数据与 Runtime 替身，没有真实 Provider 请求、重打包或升级未验证能力。模型历史仍整体载入内存；资源规模验收及跨进程写入保护保留在后续任务。
