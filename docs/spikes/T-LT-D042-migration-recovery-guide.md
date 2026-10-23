# T-LT-D042：迁移和降级恢复步骤

- 实际完成：2026-10-23（Asia/Hong_Kong）
- 计划日期：2026-11-01；前置：D039、D040 迁移接口与 D041 故障回归
- 范围：操作文档与现有 API 的示例验证；没有新增 CLI、修改数据格式或提前切换默认存储。

## 改动

新增[工作区迁移与降级恢复](../operations/workspace-migration.md)，并从原[JSON 恢复说明](../operations/workspace-recovery.md)链接过去。指南要求关闭所有数据写入者，由用户明确选定 userData，不猜测安装目录。

PowerShell 示例直接调用 `planWorkspaceMigration`、`applyWorkspaceMigration`、`planConversationMigration`、`applyConversationMigration` 和 `WorkspaceSqliteStore`。Dry run 不打开数据库，只显示计数和源 hash；apply 需要用户输入刚核对的两个 hash，向同一库分别执行状态及会话事务，再核对完整内容 hash。inspect 重新打开库检查计数和阶段，不打印状态对象、会话正文或异常原文。

文档明确区分完整目录备份与自动迁移子目录，说明 WAL/SHM 只能在没有写入者时随主库一起备份。状态成功、会话失败属于可识别的分阶段结果；重试使用同一来源和迁移记录，不删库、不清空表。坏源文件、失败备份和过时分段保留，未知版本不得通过手改版本号或删除数据库绕过检查。

降级流程先保留当前完整数据，再恢复升级前完整快照。示例在移动前核对绝对路径和目标父目录，拒绝新旧目录互相包含；不删除当前目录的内容。新 SQLite 活动不会被转换为旧 JSON/Transcript，Git 引用、原生 Runtime 历史和系统凭据也不随用户目录快照自动回退。

## 验证

环境：Windows、PowerShell 7.6.5、Node.js v24.11.1。

```powershell
.\node_modules\.bin\tsc.cmd -p apps/desktop/tsconfig.json
& '..\tsukiori-review\D042-verify-guide.ps1'
git diff --check
```

校验脚本保存在项目外的本次工作记录目录，直接抽取指南的 7 段 PowerShell 代码执行；`Read-Host` 的回答由合成路径和 dry run 的 hash 提供。只使用随机临时目录中的 1 个项目、2 个会话、4 条事件，不访问用户实际数据或 Provider。

结果：

- 7 段示例均执行成功。首次完整备份与源文件清单、SHA-256 一致。
- Dry run 前后文件清单和字节校验值相同，未创建 SQLite。
- apply 返回 `verified`，两个阶段均为 `applied`，原 JSON/Transcript 字节未变。
- 第二次 apply 的两个阶段均为 `already_applied`；inspect 仍为 1 个项目、2 个会话、4 条事件和 2 条迁移记录。
- 迁移后完整备份校验通过。按降级示例恢复旧快照后，旧源文件逐字节一致，新数据库完整保留在独立目录中，没有混入恢复后的旧数据。
- 输出中没有合成的私有消息标记。编译及 `git diff --check` 通过。

Node.js 输出了 SQLite 实验性模块提示，没有测试失败。此次验证覆盖离线命令和文件恢复；没有运行真实安装包、模拟硬件断电或验证所有实际 Runtime 的恢复能力。正文已保留这些界限。
