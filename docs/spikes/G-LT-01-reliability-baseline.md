# G-LT-01：可靠性修复基线验收

实际验收日期：2026-10-16；原计划日期：2026-10-18。结论：**PASS，限本阶段离线可靠性范围**。前 27 个日任务已完成，日历校验通过；提前完成不代表 10 月 17、18 日已有实际提交。

环境：Windows / Node 24.11.1。离线合同使用 Codex 0.146.0、Claude 2.1.226、OpenCode 1.18.4；Codex 0.162.0 仅做过 MCP 配置解析器探测，不升级 Runtime 整体兼容等级。

| Gate 条件 | 证据与结果 |
| --- | --- |
| 截断或损坏状态不被空数据覆盖 | D001–D003；workspace-state/atomic-file 故障注入、备份恢复、版本拒绝通过 |
| 错误秘密不进入持久化或界面 | D004–D006；API、子进程、失败/中断/超时的脱敏矩阵通过 |
| 长对话及重启历史完整 | D008–D010、D013；模型历史与 UI 缓存独立、上下文按完整问答裁剪、分段读取、重启和分支通过 |
| Codex 先恢复再继续 | D011–D012；正式工作区入口与 stdio 夹具的恢复顺序、身份校验、取消、重试及并发初始化通过 |
| MCP 保留用户配置并到达会话目录 | D015–D020；合并、所有权、冲突拒绝、失败回滚、真实 Git Worktree、Runtime 启动参数与已有会话重载通过 |
| 双 Runtime 已知失败解决 | D022–D024；注入实际触发并退出 23，故障成员 stopped/interrupted_runtime，两个正常成员继续完成新 Turn；同原生 ID 的跨 Handle 串流已修复 |
| 验证入口可发现失败 | D025–D027；Claude 独立组、失败退出码、全测试文件覆盖、Gate 顺序、每日计划与报告校验通过 |

验证基线由 [D026 完整分组记录](./T-LT-D026-ci-fail-fast.md)与本次变更后的复验组成：

- `npm run build` 21/21、`npm run typecheck` 34/34 通过；此后未修改产品 TypeScript。
- D027 新增校验后 `node scripts/run-ci-tests.mjs core`：61/61，4 个会话快照场景通过。
- Windows 宿主 25、Adapter 52、Claude 16、工作区 44、桌面 163、发布 13、历史 Gate 36 均通过，加上最新 core 为 **410/410**，无跳过。桌面 UI 交互与四种窗口尺寸探测通过。
- 本次工作区断言修正后再次执行 workspace 组：44/44。
- 日历检查：162 个日任务、6 个 Gate，完成项报告可读；`npm run check` 与 `git diff --check` 通过后提交。

CI 发现与收尾：D026、D027 的 [Actions 日志](https://github.com/Nineu1124/Tsukiori/actions/runs/38845872496)在工作区组报告路径前缀断言失败。WorktreeManager 返回 realpath 的规范路径，而测试直接与未规范化的临时目录字符串比较。本提交将断言收紧为与 `realpathSync.native(f.worktreeRoot)` 精确相等，保留绝对路径、目录穿越及 Junction 逃逸拒绝断言；没有修改生产安全边界。新的失败即停入口正确暴露了此问题。本记录不把旧失败运行当成成功，修复后的远端结果以本提交 Actions 为准。

未扩大本阶段结论：MCP 原生连接、OAuth 和真实工具调用尚未完整验收；Claude 单服务器健康继续 unknown；多文件 MCP 回滚不承诺断电事务。正式业务仍主要在 Electron Main，Daemon 归属、统一存储、异步 Git 属于后续阶段。未重新安装候选产品，也未执行真实 Provider 请求。

允许进入阶段 2 的服务归属 ADR；下一阶段 Gate 仍须按其自身条件验收。
