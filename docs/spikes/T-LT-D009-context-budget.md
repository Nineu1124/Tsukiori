# T-LT-D009：完整消息上下文预算

实际完成：2026-09-28。Windows；Node 24.11.1；沿用锁文件安装的依赖。

Direct API 在请求前取 Provider 配置与内置模型目录中较小的上下文容量，预留输出和 128 单位协议空间。使用 UTF-8 字节加消息开销估算输入，从最新用户消息向前选连续、完整的问答组；不会切开文本、Thinking 或消息结构，也不会删除存档。最新一组放不下时拒绝请求。

每轮产生 `context.budget` 事件并纳入 Transcript，记录容量、估算方式、消息取舍数量及是否拒绝，不包含正文。字节估算是偏保守的启发式，不能代替 Provider tokenizer；实际用量仍以 Provider 返回值为准。

验证：`npm run build` 21/21，`npm run typecheck` 34/34；API 预算、历史、运行时及失败矩阵四组测试 18/18。覆盖完整问答保留、连续后缀、中文字节、超大最新消息、无效容量、拒绝前不联系 SDK、预算事件不含正文。提交前执行 `npm run check`、`git diff --check`。
