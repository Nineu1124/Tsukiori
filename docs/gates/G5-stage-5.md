# G5 Windows Local V1 Gate 报告与发布签字记录

- Gate：G5
- 日期：2026-08-03
- 平台：Windows Native x64
- 决策：PASS
- 发布状态：Local V1 Ready Candidate
- 机器可读证据：`tests/fixtures/gates/g5-evidence.json`

## 决策摘要

T0.1 至 T5.8 的 30 个顶层任务、G0 至 G4 和第 37.1–37.11 的 97 项分类验收均已完成。T5.7 在 T5.6 真实 Codex 闭环基础上补齐设置中心、Provider/API 管理、按 Session 选择 Runtime/Provider/Model/Environment/Permission、受限 Claude Code `stream-json` 接入和设计稿视觉系统；T5.8 继续融合三个参考产品的优点，补齐 Transcript、文件/附件、ConPTY、预览、Skills/MCP、Agent Team、完整按钮微动效、响应式比例和最终 NSIS 交付。

T5.8 提交 `6187dd0ee9d5b45c4027329bef233c4aaa86fd35` 的预 Gate Windows CI `30778175326` 验证 T5.8 产品、UI、Host 和安全测试；其最终 Ready 断言失败是因为 G5 与第 37.0 总门槛当时按流程保持未勾选。本 G5 完成提交的 Windows CI 必须重新执行无凭据完整回归和 NSIS 安装生命周期并以 `success` 结束，才构成外部 runner 的最终发布验证。

根据 ADR 0003，Local V1 采用与 `cc-haha` Windows 发布相同的可选 Authenticode 策略。未签名 NSIS 不显示为已验证发布者，必须明确提示 SmartScreen 风险；Artifact 完整性继续由 SHA-256、Ed25519 Release Manifest、HTTPS Origin、Channel、文件名和数据库 Schema 验证。未来 Verified Publisher 通道继续启用 `forceCodeSigning`，不计入 Local V1 完成率。

## G5-C1 顶层任务

- T0.1–T0.4：完成；
- T1.1–T1.5：完成；
- T2.1–T2.4：完成；
- T3.1–T3.4：完成；
- T4.1–T4.5：完成；
- T5.1–T5.8：完成；真实 Codex Thread/Turn、设置与 Provider 管理、Claude Code 降级接入、UI/UX V1.0、文件/附件、ConPTY、Skills/MCP、Agent Team、Daemon 子进程回收和无凭据交互测试均通过。

结果：通过。

## G5-C2 阶段 Gate 与阻塞项

- G0–G4：已通过并分别归档 Gate 报告；
- T5.8 预 Gate CI `30778175326`：T5.8 回归通过，Ready 检查因 G5 尚未签字而按预期失败；
- 本机 `scripts/verify-windows-release-candidate.ps1`：构建、Packaged Smoke、安装、升级、卸载、重装和最终卸载全部通过，用户数据按策略保留；临时 Artifact SHA-256 为 `5056ba8eb351a65e0eff9d8a365273c218ec49a88916a9b5270d436430908a49`，未提交仓库；
- 采用用户角色图标重新构建的最终本地安装包 `Tsukiori-1.0.0-rc.1-x64-setup.exe` 大小为 `219793969` bytes，SHA-256 为 `e691c46a90706b5bef34fec28034673c232d21b00329d8ec8a3f8764ce9a2e86`，并独立通过安装、Packaged Smoke 和卸载；
- G5 完成 push：必须在干净 Windows runner 上通过完整无凭据回归和 NSIS 生命周期；
- Local V1 未解决阻塞项：0；
- Verified Publisher 缺少证书是可选通道状态，不是 Local V1 阻塞。

结果：通过；外部 CI 结论由 G5 完成 push 验证。

## G5-C3 第 37.1–37.11 验收

11 个分类共 97 项全部勾选。每一项的 T/G 映射都能在 `v1-acceptance-evidence.json` 找到至少一个实际存在的 ADR、Spike、Fixture 或 Gate 报告。T5.7 新增的设置、Provider、多 Runtime 和视觉一致性，以及 T5.8 新增的完整工作台、全按钮动效和可安装交付，由 DOM/交互测试、真实 Codex Probe、脱敏截图、Credential Manager 回归、ConPTY/退出回收测试和公开 CI 无凭据替身测试共同验证。

结果：通过。

## G5-C4 严重问题

| 严重问题类别 | 未解决数量 |
| --- | ---: |
| 安全 | 0 |
| 数据丢失 | 0 |
| 错误进程终止 | 0 |

Runtime 已知未知能力、降级能力、SmartScreen 提示和平台范围限制已进入已知问题，不伪装为已支持或已受保护。

结果：通过。

## G5-C5 后续任务池

B1 完整 Claude Adapter、B2 Generic ACP、B3 WSL/macOS/Linux 均保持未勾选，不计入 Local V1 完成率。Local V1 中 Claude Code 仅通过官方 CLI `stream-json` 以 `degraded` 级别接入，不等同于 B1 的完整 Approval、Hooks、Skills、MCP、Subagents 和 Checkpoint 合同。

结果：通过。

## 发布签字记录

| 签字维度 | 决策 | 证据 |
| --- | --- | --- |
| 架构依赖与 Gate | PASS | T0–T5、G0–G4 报告 |
| 设置、Provider 与完整工作台 | PASS | T5.7/T5.8 报告、Fixture、脱敏 UI 截图、ConPTY 与 Agent Team 回归 |
| Windows Installer | PASS | G5 完成 push 的 Windows CI、T5.5 Fixture |
| 数据与恢复 | PASS | Migration Backup、Kill Matrix、Upgrade Recovery |
| 安全与凭据 | PASS | Credential Broker、Windows Credential Manager、Secret Scan、严重问题计数 |
| Local V1 签名策略 | PASS | ADR 0003、SmartScreen 风险声明、Verified Publisher fail closed |
| Backlog 边界 | PASS | B1–B3 未勾选且被排除 |

该签字是工程证据 Gate，不是 Authenticode 数字签名，也不声称未签名 NSIS 是 Windows 已验证发布者。

## 验证命令

```powershell
npm run test:contract
npm run test:git
npm run test:recovery
npm run test:security
npm run test:alpha
npm run test:dual-runtime
npm run test:release
npm run test:release-candidate
npm run test:host
npm run test:interactive
npm run test:ui
npm run test:gate5
npm run test:v1-ready
pnpm run typecheck
npm run check
git diff --check
```

## 结论

- G5：通过。
- Local V1 Ready：30 个任务、6 个 Gate、97 项分类验收和 5 项总门槛均已签字。
- 发布外部验证：G5 完成 push 必须通过 Windows CI 的完整回归和 NSIS 生命周期。
- 能力边界：Codex 为 `supported`；Claude Code `stream-json` 为 `degraded`；OpenCode 与 Generic ACP 为 `unknown`。
- 禁止声明：Verified Publisher、完整 Claude Adapter、Generic ACP、WSL、macOS 或 Linux 已随 Local V1 发布。
