# G5 Windows Local V1 Gate 报告与发布签字记录

- Gate：G5
- 日期：2026-08-02
- 平台：Windows Native x64
- 决策：PASS
- 发布状态：Local V1 Ready Candidate
- 证据：`tests/fixtures/gates/g5-evidence.json`

## 决策摘要

T0.1 至 T5.6 的全部顶层任务、G0 至 G4 和第 37.1–37.9 分类验收均已完成。T5.6 提交 `c9d859da144d944f72bdb8b84f9d9c122dfa35fa` 对应的 Windows CI `30755866810` 在干净 runner 上通过完整无凭据回归和 NSIS 生命周期，结论为 success。

根据 ADR 0003，Local V1 采用与 `cc-haha` Windows 发布相同的可选 Authenticode 策略。未签名 NSIS 不显示为已验证发布者，必须明确提示 SmartScreen 风险；Artifact 完整性继续由 SHA-256、Ed25519 Release Manifest、HTTPS Origin、Channel、文件名和数据库 Schema 验证。未来 Verified Publisher 通道继续启用 `forceCodeSigning`，不计入 Local V1 完成率。

## G5-C1 顶层任务

- T0.1–T0.4：完成；
- T1.1–T1.5：完成；
- T2.1–T2.4：完成；
- T3.1–T3.4：完成；
- T4.1–T4.5：完成；
- T5.1–T5.6：完成；真实 Codex Thread/Turn、UI/UX V1.0、Daemon 子进程回收与无凭据交互测试均通过。

结果：通过。

## G5-C2 阶段 Gate 与阻塞项

- G0–G4：已通过并分别归档 Gate 报告；
- T5.6 后最终 Windows CI `30755866810`：success；
- Local V1 未解决阻塞项：0；
- Verified Publisher 缺少证书是可选通道状态，不是 Local V1 阻塞。

结果：通过。

## G5-C3 第 37.1–37.9 验收

9 个分类共 75 项全部勾选。每一项的 T/G 映射都能在 `v1-acceptance-evidence.json` 找到至少一个实际存在的 ADR、Spike 或 Gate 报告。T5.6 新增的产品闭环由真实本机 Probe、UI 像素检查、退出回收测试和公开 CI 无凭据替身测试共同验证。

结果：通过。

## G5-C4 严重问题

| 严重问题类别 | 未解决数量 |
| --- | ---: |
| 安全 | 0 |
| 数据丢失 | 0 |
| 错误进程终止 | 0 |

Runtime 已知未知能力、SmartScreen 提示和平台范围限制已进入已知问题，不伪装为已支持或已受保护。

结果：通过。

## G5-C5 后续任务池

B1 Claude Adapter、B2 Generic ACP、B3 WSL/macOS/Linux 均保持未勾选，不计入 Local V1 完成率，也没有出现在 V1 可操作承诺中。

结果：通过。

## 发布签字记录

| 签字维度 | 决策 | 证据 |
| --- | --- | --- |
| 架构依赖与 Gate | PASS | T0–T5、G0–G4 报告 |
| Windows Installer | PASS | CI 30755866810、T5.5 Fixture |
| 数据与恢复 | PASS | Migration Backup、Kill Matrix、Upgrade Recovery |
| 安全与凭据 | PASS | Credential Broker、Secret Scan、严重问题计数 |
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
pnpm run typecheck
npm run check
git diff --check
```

## 结论

- G5：通过。
- Local V1 Ready：已满足，T5.6 纠正后的干净 Windows CI 已重新签字。
- 禁止声明：Verified Publisher、Claude、ACP、WSL、macOS 或 Linux 已随 Local V1 发布。
