# T-LT-D050：正式工作区单写入方保护

实际完成：2026-11-17（Asia/Hong_Kong）。正式 `InteractiveWorkspace` 在打开状态、迁移历史、构造配置服务之前取得数据实例的 OS 文件锁。专用 `workspace-owner.sqlite` 持有独立 SQLite EXCLUSIVE 事务，不在该事务中保存业务记录；数据库和队列清理完成后才释放所有权。

真实数据目录归一化后取得同一锁，Windows 大小写/Junction 别名不能绕过。另一个正式宿主在读取或写入业务状态前被拒绝；不同数据目录可独立打开。不使用 PID、时间戳或超时推断死亡，不删除锁文件抢占；实际进程终止后由 OS 释放。初始化失败释放本次所有权，未知锁文件保留并进入恢复提示。shutdown 返回同一个 Promise，避免重复退出提前释放锁。

Windows / Node.js 24.16.0 / pnpm 11.9.0：

- 桌面构建通过；既有完整交互组 251/251。
- 新所有权、启动恢复与真实 Electron 启动失败组联合 10/10；最终所有权专项 5/5。
- 实际两个正式工作区竞争时第二个被拒且原状态不变；正常退出后恢复原会话，旧实例重复 shutdown 不影响新所有者。
- 实际 Node 子进程持锁时父进程不能取得；SIGKILL 并确认退出后，保留原锁文件即可重新打开，无 PID/租约绕过。
- Junction、不同目录、坏 JSON 初始化、未知锁文件及安全错误分类通过。
- `node scripts/probe-window-lifecycle.mjs`：真实 Electron 最小化启动、第二实例唤回及原进程保留全部通过。
- 提交前 `npm run check`、`git diff --check`。

保护范围是采用该入口/锁合同的正式工作区，不是限制任意 SQLite 客户端的安全沙箱；离线迁移和手工修复仍须关闭所有写入者。当前 Daemon 尚未装配业务，D060 的跨进程所有权交接与 owner epoch 不能由本项锁替代。未调用真实 Provider。
