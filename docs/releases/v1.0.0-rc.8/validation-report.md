# Tsukiori v1.0.0-rc.8 验证报告

验证日期：2026-08-14
平台：Windows 10 x64
Desktop / Daemon：1.0.0-rc.8

## DeepSeek Harness 路线图

- DSH-06、07、09、10、02、01、04、08、05 按依赖顺序完成，每个任务都有独立实现报告、自动化测试、单一完成提交并已推送 `main`；
- 所有未验证能力保持 `unknown`：Claude Compaction 未启用，DeepSeek 经 Claude Code 的 effort 映射未启用，本机未锁定 Claude 版本不展示 effort 设置；
- Provider 审计、SubAgent、Thinking 和 Compaction 投影不保存 API Key、完整 Prompt、用户源码或原始 Runtime 事件；
- `CLAUDE_CODE_EFFORT_LEVEL` 只保留在继承环境清理名单中，显式 Provider 注入会被拒绝。

## 自动化与交互验证

- TypeScript / Turbo：21 个 Workspace Package、34/34 类型任务通过；
- DSH-05 重点回归：Runtime 23/23、Claude Adapter 14/14、Interactive 50/50、UI 14/14、Security 6/6、Snapshot 3/3；
- 全仓 `tests/` 与 `spikes/` 共 294 项在正式隔离分组中通过；一次人为的单进程全并发运行使 Dual Runtime 超时，随后隔离重跑 2/2 通过，未发现语义失败；
- UI Probe Schema 6：弹窗 Close/Cancel/Escape/Backdrop、工作面板 360→440px 拖动、终端拖动、六个工作面板、设置命中与 1920/1366/1280/1100 四档布局全部通过；
- V1 Ready 6/6；Checkpoint 30 个任务、6 个 Gate、3 个后续池有效；秘密扫描 456 个文件 clean；
- DSH-05 源码提交 `cbaede6` 的 GitHub Windows CI `31725698592` 通过全部凭据无关回归和安装包生命周期。

## Windows 安装与发布

- 本地安装器：230,791,002 bytes；SHA-256 `b53e65dc5532a55e1071846dac8f45e28098a23d9d49bb5000be4dfa8cfb024c`；
- Blockmap：241,175 bytes；SHA-256 `68f83309be4c6667549abec40c09361897a7695417c48dbc71b3c0d1b818a2da`；
- `release-manifest.json` 已用 Windows Credential Manager 中的 Ed25519 私钥签名，并以仓库公钥完成本地验证；私钥和引用文件不进入仓库；
- Authenticode：NotSigned，符合个人本地发行策略；SmartScreen 未知发布者提示仍需用户确认来源和 SHA-256；
- `scripts/verify-windows-release-candidate.ps1` 已验证 Install、Packaged Smoke、Update、Uninstall、Reinstall 和 Final Uninstall 全部为 `passed`，测试构建不进入仓库且用户数据按升级语义保留；
- 将要交付的 `apps/desktop/release/win-unpacked/Tsukiori.exe` 已以独立临时用户数据运行本地 Packaged Smoke，退出码为 0；
- 最新解包调试版生成在 `apps/desktop/release/win-unpacked`；测试结束后父进程不存在的 `named-pipe-host` 数量为 0。

## 安全与数据边界

- 项目、Worktree、Workspace 状态、Transcript、Memory 与设置保存在本机；模型请求由所选 Runtime 发送至用户配置的服务；
- API Key 只保存到 Windows Credential Manager，不进入状态文件、Fixture、诊断包或 Git；
- Renderer 保持 Sandbox、Context Isolation、禁用 Node Integration，只使用固定 Preload 白名单；
- Worktree 是代码隔离而不是安全沙箱；Computer Use 仍要求会话锁、前台应用校验和单动作授权；
- 发布 Fixture 和文档不包含完整 Prompt、用户源码、认证头、Raw Payload 或未脱敏日志。
