# Tsukiori v1.0.0-rc.6

RC6 在 RC5 的 Codex 式本地工作台上补齐可持续协作的 Agent Team：2–4 个成员各自使用独立 Session 与 Git Worktree，支持继续派发、单成员故障重试、全队中断、实时成员状态和协调者结果汇总。UI 动效按本机 Codex Desk 的实际时间参数校准，同时保留蔚蓝档案 / SCHALE OS 的蓝白切角视觉。

## 安装

下载 `Tsukiori-1.0.0-rc.6-x64-setup.exe`。这是个人本地发行版，未购买 Authenticode 证书，Windows SmartScreen 可能显示未知发布者；请从本仓库 Release 下载，并核对 SHA-256：

```text
672fe12795a2b8e39f9aebd974dc056efb0ee2b83f133cec605eed9323d19a06  Tsukiori-1.0.0-rc.6-x64-setup.exe
375602bd040e2e322927401738e38127221642a4085810128c4f2b223f0517a2  Tsukiori-1.0.0-rc.6-x64-setup.exe.blockmap
```

## 主要变化

- Agent Team 创建器支持动态添加或移除成员，总数限制为 2–4 人。
- 每位成员显示实际 Runtime、职责、Session、Worktree 和运行状态，可直接打开对应会话。
- 支持向全队或单个成员继续派发，失败成员可独立重试，运行中的团队可统一停止。
- 协调者只读取每个成员最后一条回复的有界摘录，并将其作为不可信输入生成团队汇总。
- 应用重启后不会把未结束团队伪装成成功；状态会恢复为已停止或部分失败。
- 控件、面板、遮罩和进入动画分别按 `120ms`、`180ms`、`170ms`、`260ms` 校准，并支持系统减少动态效果设置。
- 交互探针覆盖 100%、125%、150% DPI 和 1100px 窄屏 Overlay；31 张界面验收图同步更新。

## 本地数据与模型出口

项目文件、Workspace 状态、Transcript、Memory 和配置保存在本机。模型请求由所选 Runtime 直连 ChatGPT 登录、OpenAI、Anthropic、DeepSeek 或兼容 Provider；API Key 只保存到 Windows Credential Manager。

完整证据见 [validation-report.md](./validation-report.md) 和 [T5.8 Agent Team / Motion 报告](../../spikes/T5.8-agent-team-codex-motion.md)。
