# T-LT-D012：续聊与取消回归

实际完成：2026-09-28。Windows；Node 24.11.1；复用 D011 构建产物。

新增正式 InteractiveWorkspace 生命周期回归：同一进程两轮只创建一个 Thread，重启后恢复，取消请求指向当前 Turn，再次重启继续沿用同一 Thread。异常退出、恢复失败后重试、旧客户端迟到回调及能力读取与发消息并发均有覆盖。

另用真实 CodexAppServerClient 连接本地 Node stdio RPC 服务，记录 initialize、account/read、thread/start 或 thread/resume、turn/start、turn/interrupt 的实际传输顺序与 ID。该服务不执行模型请求，不使用用户凭据；它验证桌面正式入口与传输客户端的联通，不代表真实 Codex 服务全部行为。

命令：`node --test tests/interactive/codex-lifecycle.test.mjs tests/interactive/codex-resume.test.mjs`，7/7 通过。提交前执行 `npm run check`、`git diff --check`。本项只增加测试，没有修改运行时代码。
