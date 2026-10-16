# T-LT-D029：正式服务归属与迁移顺序

实际完成：2026-10-16；计划日期：2026-10-19。前置 G-LT-01 已通过。本项交付 [ADR-0007](../adr/0007-workspace-ownership-and-daemon-migration.md)，不在文档提交中启动进程迁移。

对照正式 Preload、Main 的非 smokeMode 分支、InteractiveWorkspace 构造/发送/保存/退出路径、Daemon main 与 Named Pipe Host，确认正式状态和 Runtime 仍主要属于 Main。ADR 列出当前调用链、资源与数据所有者，明确 Daemon 可连通与业务归属的区别。

决策采用先抽取服务、统一 Repository 和数据迁移、异步 Git/单写入保护，再经 G-LT-02 迁入 Daemon 的顺序；将 owner epoch、排他交接、凭据引用、原生历史边界和降级恢复作为后续实现约束，逐段映射 D030–D083。未把独立包测试或保留 Daemon 进程当成正式后台会话已完成。

迁移基线收尾：G-LT-01 的 [Actions 运行](https://github.com/Nineu1124/Tsukiori/actions/runs/38846325654)已通过工作区组，随后暴露 cc-haha 导入测试的同类路径断言问题。Windows 临时目录可能使用 8.3 短名，导入器返回规范长路径，仅转小写仍无法比较。将预期仓库路径先经 `realpathSync.native` 规范化，保留只读扫描、敏感内容过滤、哈希幂等、Dry Run 后变更拒绝及损坏 Manifest 拒绝的原有验证；生产导入逻辑不变。

验证环境沿用 G-LT-01 的 Windows / Node 24.11.1。逐条核对 ADR 中的源码路径及符号，新增相对文档/源码链接均可读；`node --test tests/interactive/cc-haha-importer.test.mjs`：3/3 通过。`npm run check`、`git diff --check` 通过后提交。产品 TypeScript 未改动，既有完整本地回归基线仍见 G-LT-01；修正后远端全套结果以本提交 Actions 为准，不将旧失败运行记为通过。
