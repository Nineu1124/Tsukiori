# T-LT-D043：切换正式项目与会话存储

实际完成：2026-11-17（Asia/Hong_Kong）。正式 `InteractiveWorkspace` 默认使用 `SqliteWorkspaceRepository`，由现有 `WorkspaceSqliteStore` 保存项目、会话、团队和同一聚合中的设置、Provider 引用；Main 的真实装配入口无需另开执行链路。注入 Repository 的合同仍保留。

首次启动先验证旧 JSON，沿用 D039 的备份及事务导入。损坏旧文件不会创建新库；有效库激活后不再读取或更新旧 JSON，库损坏也不会回退覆盖旧状态。初始化后续服务失败及正常退出会关闭自有数据库。旧文件、迁移备份保留，SQLite 文件加入 Git 忽略规则。历史在本任务中仍使用 JSON Transcript，切换由 D044 验收。

验证环境：Windows / Node.js 24.16.0 / pnpm 11.9.0，冻结锁文件安装。

- `pnpm run build`：21/21；`pnpm run typecheck`：34/34。
- `node --test --test-concurrency=4 tests/interactive/*.test.mjs`：227/227，包括默认正式入口的项目/会话保存与重启、旧 JSON 字节保留、一次性导入、激活后拒用过时 JSON、坏源与坏库拒绝。
- `node --test tests/ui/*.test.mjs tests/host/package-boundary.test.mjs`：16/16。
- 初次回归发现一项测试依赖旧 JSON 缩进；改为检查三个设置字段实际值，单项复验及完整交互回归均通过。JSON 原子替换故障组显式注入兼容适配器，继续验证旧文件行为，不作为新库入口证明。
- 提交前执行 `npm run check`、`git diff --check`。

全部使用临时合成数据和 Runtime 替身，未读取实际用户目录或调用 Provider。单写入方保护、默认历史切换与 Daemon 归属仍由后续任务验收。
