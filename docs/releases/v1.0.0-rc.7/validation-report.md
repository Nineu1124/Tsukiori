# Tsukiori v1.0.0-rc.7 验证报告

验证日期：2026-08-10
平台：Windows 10 x64
Desktop / Daemon：1.0.0-rc.7

## Integration Worktree 与 Promotion

- Merge 验证、目标分支前进后的 Rebase、冲突保留/修复/继续、`git diff --check` 失败修复、显式 Promotion 与恢复引用均有真实临时 Git 仓库测试；
- 隔离验证阶段主工作区 HEAD 和文件保持不变；Promotion 拒绝脏工作区、目标分支变化与 HEAD 竞争；
- Submodule gitlink、越界路径、未提交 Session 和未完成 Git 操作均 fail closed；Git 使用参数数组、关闭交互 Prompt、Hook 和提交签名；
- Review UI、Preload/Main IPC、持久化恢复和 1600×1000 安全合并截图形成跨层证据。

## 设置与 Windows 生命周期

- Electron 窗口生命周期探针实测首次启动为 `minimized`；第二实例退出码 0，原实例恢复为 `normal` 并继续存活；
- 默认 Runtime / Provider / Model 保存后进入新 Session，Provider 不包含所选模型时安全回退；
- 英文界面与系统主题在当前版本明确锁定；高风险确认由 Main Process 状态迁移与更新路径强制为 true；
- UI Probe Schema 5 覆盖设置按钮命中、默认模型持久化、锁定能力、六工作面板、弹窗退出、左右折叠、工作面板/终端拖动和多档 DPI。

## 自动化测试

- `pnpm run typecheck` 与 `pnpm run build`：21 个 Workspace Package 通过；
- Integration Manager：5/5；设置/Workspace/Host/UI 重点回归：28/28；全量 `tests/**/*.test.mjs`：236/236 通过；
- UI Probe Schema 5、Window Lifecycle Probe Schema 1、32 张完整设计截图全部通过；
- Checkpoint：30 个任务、6 个 Gate、3 个后续池有效；第 37 章 99 项验收映射完整；秘密扫描 clean；`git diff --check` 通过。

## Windows 安装与发布

- `scripts/verify-windows-release-candidate.ps1`：Install、Packaged Smoke、Update、Uninstall、Reinstall、Final Uninstall 全部通过；测试构建不进入仓库；
- 最终打包态 Smoke：退出码 0，Daemon `1.0.0-rc.7`、Protocol 1、Renderer Sandbox 与 Renderer Crash 后 Daemon 存活均通过；
- 最终安装器：230,778,800 bytes；SHA-256 `bda80e77db8b6590baa624ce45a09f9eb9feb3fb0b75d0baf18c09126f77007d`；
- Blockmap：240,177 bytes；SHA-256 `84ba5d6542ff103a3d87a96af0576074be09e5448153e669946461701f572568`；
- Authenticode：NotSigned，符合个人本地发行策略；Ed25519 Release Manifest 已用 Windows Credential Manager 中的私钥签名，仓库仅保存公钥；
- 打包和 Smoke 退出后，父进程不存在的 Tsukiori `named-pipe-host` 数量为 0。

## 安全与已知边界

- Renderer 继续启用 Sandbox、Context Isolation、禁用 Node Integration；新增窗口状态接口只读，不暴露窗口控制或 Electron 对象；
- Provider 凭据、Prompt、用户源码、Diff 正文和原始 Runtime 事件不进入发布 Fixture 或日志；
- H5、IM、桌面宠物、远程 Skill Marketplace 和 Generic ACP 不包含在 RC7，继续保持 unknown / backlog；
- 个人本地发行不要求购买 Authenticode 证书，SmartScreen 未知发布者提示仍需用户确认来源和 SHA-256。
