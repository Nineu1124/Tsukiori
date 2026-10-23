# T-LT-D034：正式命令的身份与输入边界

实际完成：2026-10-23。测试执行编译后 Main 实际注册的命令回调，注入 Electron 事件与离线工作区，不用另一份模拟分派器替代产品入口。

Windows / Node 24.11.1：命令边界和 Preload 合同 7/7 通过。验证当前窗口、主 Frame、固定文档 URL；省略版本/v1 兼容与错误版本拒绝；异步请求反序完成时结果仍归原调用；错误 ID、绝对路径和目录穿越在分派前拒绝；真实 Git Worktree 中不存在 Session 与指向另一 Worktree 的 Junction 无法读取；两个待审批请求按各自 ID 答复，已经消费的 ID 不可复用。

检查不代表 Daemon 身份握手或 connection epoch 已实现。`workspace:snapshot` 也不属于本项新命令合同。`npm run check`、`git diff --check` 通过后提交。
