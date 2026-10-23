# T-LT-D036：项目与会话状态的读写接口

实际完成：2026-10-23。正式工作区通过 `WorkspaceStateRepository` 读取和保存项目、会话、团队、设置及 Provider 引用；默认 `JsonWorkspaceRepository` 保留 v3→v2→v1 选择、校验、备份和原子写入行为。旧数据归一化独立为纯入口，后续迁移可复用，尚未切换默认存储。

Windows / Node 24.11.1：桌面 TypeScript 编译通过。Repository 与原状态文件测试共 34/34 通过；注入内存 Repository 后，正式创建、重命名、置顶和重启均走接口，运行时会话 ID 不变，也不生成第二份 JSON 状态。读取抛错时构造失败，没有写出空状态。原有坏文件、备份恢复及原子写入测试继续通过。

执行：`node --test tests/interactive/workspace-repository.test.mjs tests/interactive/workspace-state.test.mjs`、`npm run check`、`git diff --check`。
