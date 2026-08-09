# Tsukiori v1.0.0-rc.5

RC5 在 RC4 的完整本地工作台和 Windows Computer Use 基础上，完成 Codex 式项目/作业导航、六入口工作面板、真实 Side Chat、可调 ConPTY 终端，并修复“按钮看得到但点不到、弹窗退不出”的可达性问题。

## 安装

下载 `Tsukiori-1.0.0-rc.5-x64-setup.exe`。这是个人本地发行版，未购买 Authenticode 证书，Windows SmartScreen 可能显示未知发布者；请从本仓库 Release 下载，并核对 SHA-256：

```text
290a66d265a5fca6306995cc596afb3d227438b5c74a059ee89dcb56297df1f7  Tsukiori-1.0.0-rc.5-x64-setup.exe
ceb1e3f261be505b2967285406e03ddb0d0f42446f47c952247401bec3f761dc  Tsukiori-1.0.0-rc.5-x64-setup.exe.blockmap
```

## 主要变化

- 左侧项目可置顶、折叠、滚动和跨项目搜索，Agent 作业直接嵌套在所属项目下。
- 右侧提供审阅、终端、浏览器、文件、侧边聊天和桌面控制六个真实入口。
- Side Chat 绑定项目内另一个独立 Session，沿用其 Runtime、Provider、Worktree 和权限策略。
- 底部 ConPTY 终端支持拖动高度、键盘微调、折叠、重启和本地持久化。
- Session、Agent Team、Settings 统一支持取消、关闭、Esc 和点击遮罩；底部操作按钮通过真实命中测试。
- 31 张 1600×1000 界面截图已按蔚蓝档案 / SCHALE OS 视觉方向重新验收。

## 本地数据与模型出口

项目文件、Workspace 状态、Transcript、Memory 和配置保存在本机。模型请求由所选 Runtime 直连 ChatGPT 登录、OpenAI、Anthropic、DeepSeek 或兼容 Provider；API Key 仍只保存到 Windows Credential Manager。

完整证据见 [validation-report.md](./validation-report.md) 和 [T5.8 工作台可达性补充报告](../../spikes/T5.8-codex-workbench-dialog-accessibility.md)。
