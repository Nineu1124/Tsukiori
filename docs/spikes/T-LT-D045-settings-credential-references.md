# T-LT-D045：统一设置与凭据引用的提交边界

实际完成：2026-11-17（Asia/Hong_Kong）。设置与 Provider 元数据由 D043 的同一 SQLite 聚合保存，原状态 JSON 不再更新。本项补齐配置提交失败的内存一致性：先持久化候选状态，成功后才切换设置和 Registry，避免界面继续使用未落盘的新配置。

密钥轮换先在系统凭据库创建新引用，SQLite 提交成功后再清理旧引用；提交失败清理新引用，原引用仍可用。删除先保存配置再清理凭据。配置、Renderer 及导出仅保存/展示所需元数据，秘密不进入 SQLite/WAL。公开 Provider 投影及查询返回副本，延迟完成的验证不能覆盖更新后的 Provider。

Windows / Node.js 24.16.0 / pnpm 11.9.0：

- 桌面构建通过。
- `node --test --test-concurrency=4 tests/interactive/workspace-configuration.test.mjs tests/interactive/provider-registry.test.mjs tests/interactive/api-history.test.mjs tests/interactive/workspace-turn-service.test.mjs tests/interactive/workspace-repository.test.mjs`：25/25。
- 真实临时 SQLite Trigger 拒绝配置事务时，设置/Provider 的内存和磁盘均保留原值；轮换失败后实际发出的替身 API 请求仍使用旧凭据；成功后使用新引用，并经重启核验。
- 创建/删除失败、返回对象修改、延迟验证覆盖、数据库/WAL 明文秘密扫描均通过。
- 提交前 `npm run check`、`git diff --check`。

合成凭据由内存替身保存，未联系 Provider、未修改用户真实凭据。SQLite 与系统凭据库不构成断电原子事务：异常可能留下未引用条目；清理失败不能将已提交配置误报为未提交。MCP 托管配置、调度与导入清单仍按既有所有权文件管理，不宣称这些外围域已统一迁移。
