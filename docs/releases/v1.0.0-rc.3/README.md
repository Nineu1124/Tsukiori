# Tsukiori v1.0.0-rc.3

本版本根据 [cc-haha](https://github.com/NanmiCoder/cc-haha) 的源码结构补齐了 Tsukiori 的本地资源管理核心：MCP、Skills、Memory、Session Activity、后台任务和定时任务。

## 安装

下载 `Tsukiori-1.0.0-rc.3-x64-setup.exe`。这是个人本地发行版，未购买 Authenticode 证书，Windows SmartScreen 可能显示未知发布者；请用 SHA-256 和仓库内 Ed25519 清单验证文件。

预期 SHA-256：

```text
fd84860d64fae5b8e46fbe7c984e23c239530dd6b16ba4c2e630685549ea84af
```

## 本版新增

- MCP User / Project / Local Scope 配置管理；Project/Local 配置同步到项目 `.mcp.json`。
- MCP stdio、HTTP、SSE 配置校验；敏感环境变量只保存变量名，不保存值。
- 从项目 `.claude/skills`、`.codex/skills` 和本机导入目录扫描 Skill。
- 本地 Skill 详情、导入、卸载、大小限制和符号链接拒绝。
- `MEMORY.md`、`.claude/.codex/memory/*.md` 白名单读写与安全路径校验。
- Session Activity、SubAgent、后台任务停止与脱敏事件展示。
- 定时任务创建、启用/停用、立即运行、隔离 Session、错误记录和下次运行时间。
- 保留 RC2 的 Provider 模型发现、DeepSeek 对话修复、可拖拽工作面板和完整诊断导出。

## 当前边界

cc-haha 的 Computer Use 依赖平台原生 Helper、截图坐标映射、应用白名单和会话锁。Tsukiori 当前不会宣称已经具备 Windows 桌面控制；该能力仍保持 `unknown`，不会向 Runtime 暴露未经验证的鼠标、键盘或屏幕工具。

完整验证见 [validation-report.md](./validation-report.md)。

