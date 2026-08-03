# Tsukiori Local V1 Ready 发布报告

- 日期：2026-08-03
- 平台：Windows Native x64
- Release Candidate：`1.0.0-rc.1`
- 决策：`Local V1 Ready`
- 机器可读证据：`tests/fixtures/release/v1-ready.json`

## 发布结论

T0.1 至 T5.8 的 30 个顶层任务、G0 至 G5、第 37.1 至 37.11 的 97 项分类验收，以及第 37.0 的 5 项总门槛均已通过。

T5.6 建立了真实项目、独立 Worktree、Codex Thread/Turn、流式消息、权限和 Git 操作闭环。T5.7 在此基础上补齐完整设置中心、OpenAI/Anthropic/DeepSeek 与自定义兼容 Provider、API Key 的 Windows Credential Manager 存储、Session 级 Runtime/Provider/Model/Environment/Permission 选择、Claude Code 降级接入、设计稿要求的主工作台与设置视觉。T5.8 进一步补齐本地 Transcript、文件/附件、安全 Markdown、Windows ConPTY、本地预览、Codex Skills/MCP、2–4 Agent Team、全按钮微动效、紧凑窗口比例和正式 NSIS 安装包。

Local V1 可采用未签名 NSIS，但这不代表 Windows 已验证发布者。下载与安装说明必须明确提示 SmartScreen“未知发布者”风险；SHA-256、Ed25519 Release Manifest、HTTPS 来源、Channel、数据库 Schema 和安装回归仍是强制验证。未来 Verified Publisher 通道继续 `forceCodeSigning` 并在缺少有效 Authenticode 证书时 fail closed。

## 验收计数

| 范围 | 数量 | 结果 |
| --- | ---: | --- |
| T0.1–T5.8 顶层任务 | 30 | PASS |
| G0–G5 阶段 Gate | 6 | PASS |
| 第 37.1–37.11 分类验收 | 97 | PASS |
| 第 37.0 总门槛 | 5 | PASS |
| 严重安全、数据丢失、错误进程终止问题 | 0 | PASS |

## 发布证据

- RC 与安装回归：`tests/fixtures/release/t5.5-result.json`
- Runtime 与发布兼容性矩阵：`tests/fixtures/release/v1.0.0-rc.1-compatibility.json`
- 验收项到任务证据映射：`tests/fixtures/release/v1-acceptance-evidence.json`
- 可交互产品真实 Probe：`tests/fixtures/release/t5.6-interactive-result.json`
- 设置、Provider、多 Runtime 与 UI：`tests/fixtures/release/t5.7-result.json`、`tests/fixtures/release/t5.7-runtime-provider-result.json`
- 完整工作台、动效与安装交付：`tests/fixtures/release/t5.8-result.json`、`docs/spikes/T5.8-three-product-complete-workbench.md`
- 设计稿视觉证据：`docs/visual/t5.7-main-workspace.png`、`docs/visual/t5.7-settings-general.png`、`docs/visual/t5.7-settings-agent.png`
- 已知问题：`docs/releases/V1.0.0-rc.1-known-issues.md`
- G5 签字：`docs/gates/G5-stage-5.md`
- 本机安装生命周期：构建、Packaged Smoke、安装、升级、卸载、重装和最终卸载全部通过；临时安装包 SHA-256 为 `5056ba8eb351a65e0eff9d8a365273c218ec49a88916a9b5270d436430908a49`，未提交仓库。采用用户角色图标重新构建的最终本地安装包大小为 `219793969` bytes，SHA-256 为 `e691c46a90706b5bef34fec28034673c232d21b00329d8ec8a3f8764ce9a2e86`，并再次通过安装、Smoke 和卸载。
- 预 Gate Windows CI：<https://github.com/Nineu1124/Tsukiori/actions/runs/30778175326>（T5.8 回归通过，Ready 因 G5 尚未勾选而按预期失败）
- 最终 Windows CI：G5 完成 push 对应运行，必须通过无凭据回归和 NSIS 生命周期。

## Runtime 与 Provider 边界

- Codex `0.146.0`：`supported`；使用原生 app-server，可选择 ChatGPT、OpenAI API 或兼容 OpenAI Responses API 的自定义 Provider。
- Claude Code `2.1.201`：`degraded`；使用官方 CLI `stream-json`，可选择 Anthropic、DeepSeek 或兼容 Anthropic Messages API 的自定义 Provider。权限只提供 Plan、Accept Edits、Don't Ask 的受限映射。
- OpenCode：`unknown`；协议 Spike 和 Adapter 证据保留，但未接入当前产品 Session 创建路径。
- Generic ACP：`unknown`；仍属于 B2。

Provider 未配置凭据时不会显示为 connected，也不会创建 Worktree 后再静默回退。API Key 只进入 Windows Credential Manager；持久化 JSON、SQLite、日志、设置导出、Renderer Snapshot 和公开 Fixture 均不包含明文 Key。

## 范围边界

B1 完整 Claude Adapter、B2 Generic ACP、B3 WSL/macOS/Linux 保持未完成，不计入 Local V1 完成率。Runtime 未验证行为继续标记为 `unknown`；Worktree 继续只作为变更隔离机制，不作为安全沙箱。

本报告确认工程发布门槛已满足，不是 Authenticode 数字签名，也不授权提交证书、私钥、凭据、用户源码、完整 Prompt 或未脱敏 Runtime Event。

## 验证命令

```powershell
npm run test:gate5
npm run test:v1-ready
npm run test:release-candidate
npm run test:host
npm run test:interactive
npm run test:ui
npm run test:security
pnpm run typecheck
npm run check
git diff --check
```
