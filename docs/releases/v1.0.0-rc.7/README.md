# Tsukiori v1.0.0-rc.7

RC7 在 RC6 的本地多 Agent 工作台上补齐两个关键闭环：Review 面板现在能在临时 Integration Worktree 中执行 Merge / Rebase、保留冲突现场并显式 Promotion；通用设置中的最小化启动、默认 Model 与单实例行为已连接真实产品路径。

## 安装

下载 `Tsukiori-1.0.0-rc.7-x64-setup.exe`。这是个人本地发行版，未购买 Authenticode 证书，Windows SmartScreen 可能显示未知发布者；请从本仓库 Release 下载，并核对 SHA-256：

```text
bda80e77db8b6590baa624ce45a09f9eb9feb3fb0b75d0baf18c09126f77007d  Tsukiori-1.0.0-rc.7-x64-setup.exe
84ba5d6542ff103a3d87a96af0576074be09e5448153e669946461701f572568  Tsukiori-1.0.0-rc.7-x64-setup.exe.blockmap
```

## 主要变化

- Review 面板新增 Integration Worktree：支持 Merge / Rebase 隔离验证，不直接修改项目主工作区。
- 冲突或 `git diff --check` 失败时保留临时 Worktree，可打开、修复、继续验证或安全丢弃。
- Promotion 前复验目标分支、HEAD 和干净状态，并先建立 `refs/tsukiori/recovery/*` 恢复引用。
- 最小化启动真正进入 Windows 任务栏；第二次启动退出并恢复现有窗口，不再产生多个产品实例。
- 设置页新增默认 Model；新 Session 使用与 Provider 匹配的持久化模型。
- 未实现的英文界面和系统主题明确锁定；高风险确认由宿主强制启用，不能被状态文件或 Renderer 关闭。
- 完整设计输出增加安全合并画面，总计 32 张 1600×1000 应用截图。
- Windows 打包脚本先构建全仓依赖，打包态 Smoke 明确验证 Desktop / Daemon 均为 RC7。

## 本地数据与模型出口

项目文件、Workspace 状态、Transcript、Memory 和配置保存在本机。模型请求由所选 Runtime 直连 ChatGPT 登录、OpenAI、Anthropic、DeepSeek 或兼容 Provider；API Key 只保存到 Windows Credential Manager。

完整证据见 [validation-report.md](./validation-report.md)、[Integration / Promotion 报告](../../spikes/T5.8-interactive-integration-promotion.md)和[设置 / 单实例报告](../../spikes/T5.8-effective-settings-window-lifecycle.md)。
