# Tsukiori v1.0.0-rc.2 验证报告

验证日期：2026-08-03  
平台：Windows 10 x64  
Desktop / Daemon：1.0.0-rc.2

## 对话链路

- 根因：Claude Code 在 `--print --output-format stream-json` 下要求同时传入 `--verbose`；此前 Runtime 立即退出，但界面没有把“缺少 result”呈现为失败。
- 修复后真实 DeepSeek Anthropic endpoint 返回 HTTP 200。
- 修复后真实 Claude Code + DeepSeek 隔离仓库 Probe：收到 assistant response、命中随机 marker、收到 completed result，且没有 Runtime error。
- Key 仅通过 Probe 的标准输入进入子进程；报告、Fixture、命令输出、环境持久化和仓库均不包含 Key。
- 自动化合同测试验证 `--verbose`、缺失 result 错误、单 Session 并发保护和 Provider 环境清理。

## UI 与功能

- `npm run probe:ui-interactions`：真实 Electron Renderer 中以 PointerEvent 将工作面板从 360 px 拖到 440 px；CSS、ARIA 与持久化设置均为 440 px，拖动状态正常清除。
- UI 测试：9/9 通过，覆盖四区域比例、18 个设置分类、Provider/Runtime 选择、按钮动画、紧凑窗口布局与 reduced-motion。
- 交互测试：13/13 通过，覆盖 Claude Code、Codex、自定义 Provider、DeepSeek 模型映射、Session、Git、Agent Team、工作面板、Terminal 与 Diagnostics。

## 回归与安全

- TypeScript：20 个 workspace package 全部通过。
- Security：6/6 通过；Credential Manager、秘密拒绝持久化、XSS/ANSI/Markdown/MCP 输入边界均通过。
- Host：9/9 通过；包含 Renderer crash、Daemon 生命周期和 Named Pipe Host 父进程退出清理。
- Release Candidate：4/4 通过；版本、Schema、迁移、证据映射和 Windows CI 合同一致。
- Checkpoint 校验：30 个任务、6 个 Gate、3 个后续任务池，结构有效。
- 秘密扫描：clean；未发现 API Key、私钥、认证存储、用户源码或未脱敏 Runtime 事件。
- 安装生命周期：安装、Packaged Smoke、升级、卸载、重装和最终卸载全部通过。
- 最终上传安装器独立执行安装、Packaged Smoke、卸载，全部通过。
- 退出后 `named-pipe-host.ps1` 残留数 0，孤儿数 0。

## 发布物

- 安装器：`Tsukiori-1.0.0-rc.2-x64-setup.exe`
- 大小：219808497 bytes
- SHA-256：`fe92e4532f52c6718d849f209f122d9e2b99e39f1d2c0fd88991b6aa7c81bc89`
- Authenticode：NotSigned（符合个人本地发行 ADR）
- 完整性签名：Ed25519，Key ID `tsukiori-release-2026`
- 私钥位置：Windows Credential Manager；仓库仅包含公开验证密钥。

