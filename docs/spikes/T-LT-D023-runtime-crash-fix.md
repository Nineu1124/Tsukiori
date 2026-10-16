# T-LT-D023：修复双 Runtime 故障注入的连接复用

实际完成：2026-10-16。Windows / Node 24.11.1，OpenCode 1.18.4 与 Codex 0.146.0 离线合同。

根因是夹具请求时序：五轮对话后，同步 Git 检查、提交及合并阻塞父进程事件循环；子进程 HTTP 服务此时可以关闭空闲连接。父进程尚未处理关闭通知就复用连接发第六次 POST，得到 connection_closed，注入逻辑完全没有执行。因此 Session=error、Handle=ready 是请求失败时的事实，等待进程退出不会成功。

双 Runtime 夹具启用 closeHttpConnections，普通响应明确发送 Connection: close；持续的 SSE 不经过该 helper，保留原事件连接。没有修改产品的请求重试、恢复语义或生产网络配置。尤其没有自动重放可能已被服务器接受的 Prompt。

补充短时因果回归：子进程在响应后 25 ms 关闭连接，父进程同步阻塞 150 ms 后发送注入请求。修复后收到第二次请求、crash_injected、实际 exit(23,null)。在工作区外生成同一测试的负向对照，仅关闭 closeHttpConnections 并去掉 Header 检查，稳定失败于“crash request must reach the fixture”，证明断开复用而非等待时长是原因。负向对照不进入正常测试集。

`node --test tests/dual-runtime/*.test.mjs`：4/4，约 17 秒。完整链路记录请求 1–6、注入和退出；继续断言数据库 Handle exited/exitCode=23、会话 interrupted_runtime、另一 Codex 成员健康且可完成下一轮，Git 集成及无泄漏断言保留。8 秒状态等待没有增加。`npm run check`、`git diff --check` 通过后提交。

限制：修复的是可复现的离线夹具连接竞态。真实 Runtime 断网或连接回收后的恢复策略仍需各自合同验证，不能由本次成功推断。
