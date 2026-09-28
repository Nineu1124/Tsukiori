# T-LT-D011：Codex 恢复后续聊

实际完成：2026-09-28。Windows；Node 24.11.1；协议夹具 codex-cli 0.146.0。

新建客户端完成 initialize 后，如 Session 已有 Thread ID，先等待 `thread/resume`，确认返回同一身份后才允许 `turn/start`。恢复拒绝或身份不一致会停止该客户端，保留原 Thread ID 和轮次数，不能悄悄新建 Thread。并发能力读取和发消息共享初始化 Promise；旧进程迟到的退出、通知不能影响新客户端。

依据：[OpenAI App Server 文档](https://learn.chatgpt.com/docs/app-server)的 Start or resume a thread，以及仓库 `tests/fixtures/codex/0.146.0/codex_app_server_protocol.schemas.json` 中的 ThreadResumeParams / ThreadResumeResponse；现有桌面客户端已提供对应方法。本项没有升级 Runtime 版本或改变权限参数。

验证：`npm run build` 21/21；恢复、错误边界、锁定协议夹具三组 8/8。正式 InteractiveWorkspace 使用离线客户端完成首次发送、保存、重启、恢复再发送；覆盖拒绝、身份错配和错误脱敏。提交前执行 `npm run check`、`git diff --check`。真实账号、外部服务可用性及跨版本兼容没有重新验收。
