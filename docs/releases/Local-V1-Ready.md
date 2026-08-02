# Tsukiori Local V1 Ready 发布报告

- 日期：2026-08-02
- 平台：Windows Native x64
- Release Candidate：`1.0.0-rc.1`
- 决策：`Local V1 Ready`
- 机器可读证据：`tests/fixtures/release/v1-ready.json`

## 发布结论

T0.1 至 T5.5、G0 至 G5、第 37.1 至 37.8 的 67 项分类验收，以及第 37.0 的 5 项总门槛均已通过。G5 提交 `e71976fdd259c369c65a598a75b2a5e41f938d6f` 对应的 Windows CI `30751434838` 在干净 runner 上完成全部无凭据回归和 NSIS 安装器生命周期验证，结论为 success。

Local V1 可采用未签名 NSIS，但这不代表 Windows 已验证发布者。下载与安装说明必须明确提示 SmartScreen“未知发布者”风险；SHA-256、Ed25519 Release Manifest、HTTPS 来源、Channel、数据库 Schema 和安装回归仍是强制验证。未来 Verified Publisher 通道继续 `forceCodeSigning` 并在缺少有效 Authenticode 证书时 fail closed。

## 验收计数

| 范围 | 数量 | 结果 |
| --- | ---: | --- |
| T0.1–T5.5 顶层任务 | 27 | PASS |
| G0–G5 阶段 Gate | 6 | PASS |
| 第 37.1–37.8 分类验收 | 67 | PASS |
| 第 37.0 总门槛 | 5 | PASS |
| 严重安全、数据丢失、错误进程终止问题 | 0 | PASS |

## 发布证据

- RC 与安装回归：`tests/fixtures/release/t5.5-result.json`
- Runtime 与发布兼容性矩阵：`tests/fixtures/release/v1.0.0-rc.1-compatibility.json`
- 验收项到任务证据映射：`tests/fixtures/release/v1-acceptance-evidence.json`
- 已知问题：`docs/releases/V1.0.0-rc.1-known-issues.md`
- G5 签字：`docs/gates/G5-stage-5.md`
- Windows CI：<https://github.com/Nineu1124/Tsukiori/actions/runs/30751434838>

## 范围边界

B1 Claude Adapter、B2 Generic ACP、B3 WSL/macOS/Linux 保持未完成，不计入 Local V1 完成率，也不得出现在 V1 可操作能力承诺中。Runtime 未验证行为继续标记为 `unknown`；Worktree 继续只作为变更隔离机制，不作为安全沙箱。

本报告确认工程发布门槛已满足，不是 Authenticode 数字签名，也不授权提交证书、私钥、凭据、用户源码、完整 Prompt 或未脱敏 Runtime Event。

## 验证命令

```powershell
npm run test:v1-ready
pnpm run typecheck
npm run check
git diff --check
```
