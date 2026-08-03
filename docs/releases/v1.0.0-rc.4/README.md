# Tsukiori v1.0.0-rc.4

RC4 在 RC3 的本地 MCP、Skills、Memory、Activity、Scheduled Tasks 和完整工作台基础上，增加了 Windows Computer Use 本机桥接：前台应用指纹、短时会话锁、截图、鼠标/键盘动作和逐次确认。

## 安装

下载 `Tsukiori-1.0.0-rc.4-x64-setup.exe`。这是个人本地发行版，未购买 Authenticode 证书，Windows SmartScreen 可能显示未知发布者；请用 SHA-256、仓库内 Ed25519 清单和 GitHub 来源验证文件。

SHA-256：

```text
43308e00b9970fa7563d62a9c1b4ebd3e251f67f828dacdfd08f7256374d437e  Tsukiori-1.0.0-rc.4-x64-setup.exe
89fff1fdfbf1ea74777cadd6b7f18dea2923208d14080f8b8381bde24dfcc504  Tsukiori-1.0.0-rc.4-x64-setup.exe.blockmap
```

## Computer Use 安全边界

- 工作面板中显式锁定目标应用；锁定动作提供 2 秒切换窗口，Shell、终端宿主和 Tsukiori 自身不能作为目标。
- 每个截图、鼠标动作、键盘输入和快捷键都要单次确认；PID、进程启动时间或路径变化会拒绝执行。
- 截图只以内存 Data URL 返回并立即清理临时文件，不保存到 Transcript、数据库或诊断包。
- `interceptable` 表示 IPC 层拦截和审批，不表示 OS 安全沙箱；Runtime 自动调用 Computer Use MCP、远程 H5 和 IM 仍未接入。

完整证据见 [validation-report.md](./validation-report.md) 和 [T5.9 Computer Use 报告](../../spikes/T5.9-computer-use.md)。
