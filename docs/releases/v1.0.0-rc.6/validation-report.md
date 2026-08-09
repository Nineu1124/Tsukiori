# Tsukiori v1.0.0-rc.6 验证报告

验证日期：2026-08-10  
平台：Windows 10 x64  
Desktop / Daemon：1.0.0-rc.6

## Agent Team 与真实 Runtime

- Interactive 回归覆盖 4 个成员、4 个独立 Worktree、全员/单员继续派发、协调者汇总、故障重试、全队中断和重启恢复。
- 本机使用已登录的 Codex app-server `0.146.0` 进行了两个真实成员的无文件修改探测：2 个 Session、2 个不同 Worktree、48 个 Assistant Event、0 次权限请求、0 个源码文件修改，团队最终状态为 completed。
- 持久化状态不保存团队汇总原文；汇总输入限制为每成员最后一条回复最多 6000 字、总计最多 24000 字，并明确标记为不可信 Runtime 输出。

## UI 与 Motion

- Electron 实际交互通过：成员从 2 增至 4 再移除、取消、右上角关闭、Esc、Backdrop、设置保存、项目置顶、六工具入口、左右栏折叠、工作面板与终端拖动。
- 响应式矩阵通过：1920×1080@100%、1366×768@125%、1280×800@150%、1100×720@150%；无水平溢出，窄屏切换为右侧 Overlay。
- Motion 基线来自本机 Codex Desk 打包 CSS 的只读测量：控件 120ms、面板 180ms、Overlay 170ms、进入 260ms；蔚蓝档案的颜色、切角和几何装饰保持不变。
- 31 张完整设计验收截图已重新生成。

## 自动化测试

- `pnpm run typecheck`：21 个 Workspace Package、34 个 Build/Typecheck Task 通过。
- 全量 `tests/**/*.test.mjs`：230/230 通过。
- Interactive：15/15；UI：11/11；Electron UI Probe schema 3：全部通过。
- Checkpoint：30 个任务、6 个 Gate、3 个后续池有效；秘密扫描 clean；`git diff --check` 通过。

## Windows 安装生命周期

- `scripts/verify-windows-release-candidate.ps1`：Install、Packaged Smoke、Update、Uninstall、Reinstall、Final Uninstall 全部通过。
- 仓库发布目录中的 `win-unpacked/Tsukiori.exe` 另行执行打包态 Smoke，退出码为 0。
- 最终安装器：230,750,426 bytes。
- 安装器 SHA-256：`672fe12795a2b8e39f9aebd974dc056efb0ee2b83f133cec605eed9323d19a06`。
- Blockmap SHA-256：`375602bd040e2e322927401738e38127221642a4085810128c4f2b223f0517a2`。
- Authenticode：NotSigned，符合个人本地发行策略；Ed25519 Release Manifest 已用 Windows Credential Manager 中的私钥签名，仓库仅保存公钥。
- 打包前旧预览退出后，Tsukiori 进程和 `named-pipe-host` 孤儿进程均为 0。

## 安全与边界

- Renderer 继续启用 Sandbox、Context Isolation，且无 Node Integration；新增 Team IPC 均绑定受控 Session/Project/Worktree 服务。
- Provider 凭据不进入 Team 状态、Fixture、日志或仓库；真实 Provider 探针默认拒绝运行，必须显式传入外部模型调用确认参数。
- 成员输出按不可信数据处理，汇总有长度上限；停止与重试只作用于目标团队内已登记 Session。
- H5、IM、桌面宠物、远程 Skill Marketplace 和 Generic ACP 不包含在 RC6，继续保持 unknown / backlog。
