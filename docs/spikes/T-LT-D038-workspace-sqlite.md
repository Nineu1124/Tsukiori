# T-LT-D038：正式工作区的 SQLite Schema

实际完成：2026-10-23。新增 `WorkspaceSqliteStore`，定义项目、会话、团队及成员、Provider 引用、设置、完整事件和迁移记录。Schema/application ID、严格表、外键、唯一 ID、JSON 身份及跨项目关联均有校验；状态更新保留存活会话的历史，事务失败不留下半套关联。数据库使用 WAL 与 FULL 同步，未知版本、外来库和损坏库拒绝打开。

采用运行时自带的 `node:sqlite`。现有 `packages/database` 是独立领域原型，字段及生命周期与正式工作区不一致；本项通过 D036/D037 接口提供正式实现，不把原型测试当成正式入口已切换的证据，也不增加第二套活动状态。默认入口切换仍由 D043/D044 验收。

配置拒绝凭据值，只接受既有 secretRef。会话正文遵循上游事件归一化与脱敏合同，底层只验证 JSON、大小、身份和版本；不会凭字符串形状误删教程、已脱敏字段或模型签名。旧无版本事件及 v1 可读，未来版本拒绝。事务同步执行，在调用前拒绝原生 async，并在类型层排除 PromiseLike；返回 thenable 同样回滚。

Windows / Node 24.11.1：桌面编译及 SQLite 13/13 测试通过。联合状态迁移、历史迁移、故障恢复、状态适配器共 50/50 通过。真实 Electron Main 43.2.0 / Node 24.18.0 / SQLite 3.53.1 完成状态及事件写入、关闭重开核验；未调用 Provider。原生 async 被拒绝后等待下一轮事件循环，确认没有延迟写入。

命令：桌面 `tsc`；`node --test tests/interactive/workspace-sqlite.test.mjs` 及上述迁移测试；`npm run check`、`git diff --check`。跨进程数据实例写锁仍属于 D050，不由 SQLite 事务代替。
