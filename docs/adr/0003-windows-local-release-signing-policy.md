# ADR 0003：Windows Local V1 分级签名策略

- 状态：Accepted
- 日期：2026-08-02
- 决策范围：Windows x64 Local V1 与未来 Verified Publisher 发布通道

## 背景

Tsukiori 是本地优先的个人桌面软件。Windows Authenticode 能显示已验证发布者并改善 SmartScreen 体验，但不是 Windows 安装和运行 NSIS 的技术前置条件。公开项目 `NanmiCoder/cc-haha` 的 Windows 发布工作流同样将代码签名设为可选：缺少 Windows Certificate 时继续构建和发布，并明确提示 SmartScreen 风险。

T5.4 已验证两种能力：未签名 NSIS 的真实安装生命周期，以及 `forceCodeSigning` 在没有可信证书时 fail closed。缺少个人代码签名证书不应继续阻塞本地个人软件的 V1，但也不能把未签名 Artifact 描述为已验证发布者。

参考：

- `https://github.com/NanmiCoder/cc-haha/blob/main/.github/workflows/release-desktop.yml`
- `https://github.com/NanmiCoder/cc-haha/actions/runs/30583697217`

## 决策

建立两个明确分离的 Windows 发布通道。

### Local V1

- 使用 `pnpm --filter @tsukiori/desktop run package:win`；
- 允许 Authenticode 状态为 `NotSigned`；
- 安装说明必须明确提示 Windows SmartScreen 可能显示“未知发布者”；
- 必须记录 Artifact 文件名、Byte Length 和 SHA-256；
- 必须生成 Ed25519 detached Release Manifest；
- 必须验证 HTTPS Origin、Release Channel、文件名、Hash 和数据库 Schema 兼容性；
- 必须在干净 Windows x64 CI 完成安装、Smoke、更新覆盖、卸载和重装；
- 不提交安装包、私钥、证书、Token PIN 或 Credential。

### Verified Publisher

- 使用 `pnpm --filter @tsukiori/desktop run package:win:release`；
- 设置 `TSUKIORI_REQUIRE_CODE_SIGNING=1` 并启用 `forceCodeSigning`；
- 只接受 Authenticode `Status=Valid` 且 Signer Thumbprint 在受控信任列表中；
- 缺少证书、时间戳或信任匹配时 fail closed；
- 这是未来可选发布通道，不计入 Local V1 完成率。

## 安全边界

- SHA-256 与 Ed25519 Manifest 提供 Artifact 完整性和项目发布来源验证，但不会让 Windows 显示“已验证发布者”。
- 未签名 Local V1 必须显示风险说明，不隐藏、不弱化 SmartScreen 行为。
- Authenticode 不替代 Runtime 权限、凭据隔离、Migration 备份或更新来源校验。
- 自签名证书不作为 Public Trust，也不会被包装成 Verified Publisher。

## 结果

- Authenticode 缺失不再阻塞 G5 或 Local V1 Ready。
- `package:win:release` 和 Authenticode 自动化测试继续保留，未来取得证书时无需重做发布架构。
- 第 37 章新增 Local V1 未签名风险验收项，并由 T5.4、T5.5 与本 ADR 提供证据。
