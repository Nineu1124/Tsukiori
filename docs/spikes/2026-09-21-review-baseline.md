# 2026-09-21 长期计划审查基线

审查提交：`d0f6ffe3efd9a4a5881f0e297f7ddfc6a94ac065`。本文件固定长期计划的已知起点，不代表后续修复已经完成。

环境：Windows；Node 24.11.1；pnpm 11.9.0。安装依赖使用冻结锁文件。

## 已执行的验证

| 验证 | 结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 通过 |
| `pnpm run build` | 21/21 构建任务通过 |
| `pnpm run typecheck` | 34/34 Turbo 任务通过，含 13 个依赖构建缓存命中 |
| `npm run check` | 历史 30 任务、6 Gate、3 后续池检查有效；464 文件秘密扫描 clean |
| 68 个测试文件，单文件并发执行 | 297 项：296 通过，1 失败；约 472 秒 |
| 单独执行 `node --test tests/dual-runtime/dual-runtime-e2e.test.mjs` | 2 项：1 通过、1 失败；相同位置超时 |

全套测试使用 `node --test --test-concurrency=1 --test-reporter=tap` 加 `tests/`、`spikes/` 下 `.test.mjs` 文件列表；排除会读取当前前台应用的 `tests/computer-use/native-helper.test.mjs`。这不等同于重新执行全部安装包或真实 Provider 发布验收。

双 Runtime 失败位于 `tests/dual-runtime/dual-runtime-e2e.test.mjs:222`，等待 OpenCode Session 变成 `interrupted_runtime` 超时。额外诊断显示 Runtime 记录仍为 `ready`，Session 为 `error / idle`。原因未确定，不把它当作已证明的机器性能问题，也不降低测试断言。

## 行为复现与静态证据

| 发现 | 证据与边界 | 计划任务 |
| --- | --- | --- |
| 损坏状态被默认数据覆盖 | 临时用户目录中的截断 JSON 经正式 Workspace 构造后被覆盖，项目数 0，无备份；未损坏真实用户数据 | T-LT-D001–D003 |
| Provider 错误正文携带秘密进入输出 | 模拟 SDK 错误包含合成秘密标记，事件、Transcript、Renderer Snapshot 均出现该标记；未使用真实密钥或联系 Provider | T-LT-D004–D006 |
| 流事件淘汰影响 API 上下文 | 第一轮产生 510 个文本 Delta，第二轮历史丢失第一轮用户消息；模型历史来自 500 事件缓冲 | T-LT-D008–D010、D013 |
| Codex 重启续聊缺少恢复调用 | 注入客户端观察到 `initialize → turn/start`，未调用已有 `resumeThread()`；没有执行真实账号续聊 | T-LT-D011–D012 |
| 保存 MCP 覆盖既有服务器 | 临时项目预置独立服务器，正式保存另一项后旧条目消失；既有 Worktree 未同步该配置 | T-LT-D015–D020 |
| 正式恢复入口尚未接通 | `main.ts` 的正式 `recover_operation` 返回 `recovery_manager_not_connected`；Smoke 分支独立模拟成功 | T-LT-D029、D071–D073 |
| 业务归属与架构目标不同 | 正式会话、Runtime 客户端、定时器与 JSON 持久化主要位于 Electron Main；不能以 Daemon 存活推导任务仍运行 | 日历第 29–84 天，至 G-LT-03 |
| 当前 CI 漏掉独立 Claude Adapter 测试组 | `package.json` 有脚本，Windows CI 未调用 | T-LT-D025–D027 |

双 Runtime 恢复超时由 T-LT-D022–D024 负责诊断、修复与回归，G-LT-01 前必须解决。完整日期与验收见[每日提交日历](../roadmap/daily-commit-calendar.md)。

主要代码位置：

- `apps/desktop/electron-main/interactive-workspace.ts`：`#load`、`#save`、`#emit`、`sendPrompt`、`#ensureCodexClient`、`saveMcp`。
- `apps/desktop/electron-main/api-runtime.ts`：错误处理和 `readApiHistory`。
- `apps/desktop/electron-main/workspace-capabilities.ts`：`syncProjectMcp`。
- `apps/desktop/electron-main/main.ts`：正式/Smoke 命令分支和退出流程。
- `apps/desktop/electron-main/codex-app-server-client.ts`：`resumeThread`。
- `.github/workflows/windows-ci.yml`：测试组列表。

Codex 恢复调用的协议依据：继续已保存 Thread 应先执行恢复，再开始 Turn；见 [OpenAI 官方 App Server 文档](https://learn.chatgpt.com/docs/app-server)。执行修复时仍应核对项目锁定版本的合同。

本轮没有修改业务源码，没有联系真实模型 Provider，没有重新打包安装，也没有进行长期负载测试。长期计划中的真实服务、迁移、性能和发布验收全部作为未来工作保留。
