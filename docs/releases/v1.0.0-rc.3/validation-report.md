# Tsukiori v1.0.0-rc.3 验证报告

验证日期：2026-08-03  
平台：Windows 10 x64  
Desktop / Daemon：1.0.0-rc.3

## cc-haha 核心能力对齐

- MCP：配置 CRUD、User/Project/Local Scope、stdio/HTTP/SSE、Project `.mcp.json` 同步、敏感环境变量名脱敏。
- Skills：本地项目扫描、Frontmatter 解析、详情查看、本地导入、卸载、文件数量/大小/符号链接边界。
- Memory：项目 Memory 文件白名单、读取、编辑、保存和嵌套 `.claude/.codex/memory` 路径。
- Activity：Runtime 事件、后台任务、SubAgent/Agent Team 关联、停止任务。
- Scheduled Tasks：本地持久化、5–10080 分钟间隔、启用/停用、立即运行、隔离 Worktree Session、错误和下次运行记录。
- Computer Use：保持 `unknown`；未实现原生 Windows Helper 前不暴露桌面控制工具。

## 自动化测试

- TypeScript：20 个 workspace package 通过。
- Interactive：18/18 通过，包含 MCP、Skills、Memory、定时任务实际启动 Runtime Session。
- UI：9/9 通过，覆盖新增设置入口、IPC API 和安全边界。
- Security：6/6 通过。
- Host：9/9 通过，包含 Named Pipe Host 父进程异常退出清理。
- Release：9/9 通过，包含签名清单、哈希、版本和安装策略。
- Release Candidate：4/4 通过。
- Checkpoint 校验：30 个任务、6 个 Gate、3 个后续任务池有效。
- 秘密扫描：clean；无 API Key、私钥、认证存储、用户源码或未脱敏 Runtime 事件。

## Windows 安装生命周期

- 独立构建验证：安装、Packaged Smoke、升级、卸载、重装、最终卸载全部通过。
- 最终上传安装器：安装、Packaged Smoke、卸载全部通过。
- 最终上传安装器 SHA-256：`fd84860d64fae5b8e46fbe7c984e23c239530dd6b16ba4c2e630685549ea84af`。
- 大小：219853469 bytes。
- Authenticode：NotSigned，符合个人发行策略。
- Release 清单：Ed25519，私钥仅在 Windows Credential Manager，仓库仅包含公钥。

