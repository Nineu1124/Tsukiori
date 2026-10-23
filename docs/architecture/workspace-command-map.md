# 正式桌面命令与服务

基线：2026-10-23，D030–D034。此表描述当前 Main 入口；后续迁移时应同步更新数据源。入口是 [固定 Preload](../../apps/desktop/preload/index.cjs) → [Main 分派](../../apps/desktop/electron-main/main.ts) → [命令合同](../../apps/desktop/electron-main/workspace-command.ts) → [InteractiveWorkspace](../../apps/desktop/electron-main/interactive-workspace.ts)及下列服务。Smoke 分支不作为产品能力证据。

命令先验证当前窗口、主 Frame、固定文档 URL、v1 版本与参数。总体 JSON 上限 4 MiB，字段另有限额。Session 存在性、文件 realpath、Worktree 所有权和 Runtime 审批必须在服务层继续检查。调用返回属于原 Electron invoke；这不是 Daemon 请求 ID、连接 epoch 或断线重放协议。

表中“合同”指 D033/D034 的实际 Main 回调测试，只证明输入/来源和分派，不等于外部系统端到端验收。“工作区”指 `interactive-workspace.test.mjs` 的离线正式业务回归。“UI”指真实 Electron `probe-ui-interactions.mjs`。

| 命令 | 处理入口 | 当前数据或副作用 | 验证 |
| --- | --- | --- | --- |
| `pick_project` | Main dialog → addProject | 用户所选 Git 项目、状态 JSON | 合同、工作区；选择器为系统 UI |
| `remove_project`, `pin_project` | removeProject / pinProject | 项目及会话状态、Worktree 归属 | 工作区、UI 置顶 |
| `pick_cc_haha_source` | Main dialog | 只选择导入源 | 合同；系统选择器 |
| `scan_cc_haha_import`, `import_cc_haha` | CcHahaImporter / importCcHaha | 源只读；导入清单、会话、Transcript | cc-haha-importer、工作区 |
| `refresh_runtimes` | refreshRuntimes | 本机 Runtime 发现和认证状态 | 工作区、Adapter 离线合同 |
| `poll_events` | pollEvents | Main 有界事件缓存及游标 | 工作区、命令合同；非持久化补发 |
| `create_session` | SessionCreationService.create | Worktree、MCP、会话状态 | session-creation、mcp-worktree |
| `fork_session` | forkSession | 新 Worktree、原生分支标记与完整历史 | 工作区、history-restart |
| `search_sessions` | searchSessions | 项目会话元数据及 Transcript | 工作区 |
| `update_session_options`, `rename_session`, `pin_session`, `archive_session` | 对应会话方法 | 状态 JSON；运行状态约束 | 工作区、命令合同 |
| `send_prompt`, `interrupt_turn` | WorkspaceTurnService | Runtime 句柄、完整 API 历史、事件与会话状态 | workspace-turn-service、codex-lifecycle |
| `permission` | decidePermission | Main 待审批 Map；关联 Runtime 答复 | workspace-command-boundary、工作区 |
| `update_settings` | updateSettings | 工作区状态 JSON | UI、workspace-state |
| `save_provider`, `delete_provider` | ProviderRegistry | 工作区 Provider 引用；系统凭据库保存秘密 | provider-registry、工作区 |
| `test_provider`, `list_provider_models` | testProvider / listProviderModels | 临时验证、模型目录；独立安全审计文件 | provider-registry、工作区；真实服务另验 |
| `list_mcp`, `save_mcp`, `delete_mcp` | WorkspaceCapabilities | mcp-servers-v1.json、所有权文件、实际目录 .mcp.json | mcp-config、mcp-worktree、mcp-reload |
| `pick_skill_source` | Main dialog | 只选择来源 | 合同；系统选择器 |
| `list_skills`, `skill_detail`, `install_skill`, `uninstall_skill` | WorkspaceCapabilities | 项目 .claude/skills、安装清单 | workspace-capabilities |
| `list_memory`, `read_memory`, `save_memory` | WorkspaceCapabilities | 项目内允许的 Memory 文件 | workspace-capabilities、合同路径约束 |
| `activity`, `stop_background_task` | activity / stopBackgroundTask | 子代理投影、原生任务标识 | subagent-projection-store、工作区；原生停止能力另验 |
| `list_scheduled_tasks`, `save_scheduled_task`, `set_scheduled_task_enabled`, `delete_scheduled_task`, `run_scheduled_task` | WorkspaceCapabilities 与工作区调度 | scheduled-tasks-v1.json；Main 定时器创建会话 | workspace-capabilities、工作区 |
| `diagnostic_summary`, `export_diagnostic`, `export_settings` | 工作区安全摘要；Main 保存对话框 | 白名单诊断、脱敏设置导出 | 工作区、UI；不导出秘密 |
| `open_worktree`, `list_files`, `read_file`, `pick_attachments` | 工作区路径检查；Main shell/dialog | 对应会话目录，附件受限复制 | 工作区、workspace-command-boundary |
| `codex_native`, `extension_health` | Codex 客户端 / WorkspaceCapabilities | 当前会话原生状态与受限配置投影 | 工作区、mcp-runtime-config；未知项保持 unknown |
| `github_status` | githubStatus | 本机 gh 状态投影 | 工作区合同；真实账号状态另验 |
| `check_updates` | Main 有超时的 GitHub Release 查询 | 发布元数据，只检查版本 | 命令合同、UI；公共 Release 网络结果另验 |
| `create_team`, `team_message`, `team_retry_member`, `team_stop`, `team_synthesize` | 工作区 Team 编排 → 同一会话/Turn 服务 | Team 状态、成员独立会话和 Worktree | 工作区 Team 回归 |
| `terminal_start`, `terminal_input`, `terminal_resize`, `terminal_stop` | MainTerminalManager | 当前可写 Worktree 中的 ConPTY | terminal-manager、UI |
| `computer_use_status`, `computer_use_foreground`, `computer_use_acquire`, `computer_use_release`, `computer_use_request`, `computer_use_approve` | MainComputerUseManager | 设备锁、单次审批、受控设备操作 | tests/computer-use、工作区；非后台设备控制承诺 |
| `copy_text`, `open_url` | Main clipboard / shell | 受限文本及无内嵌认证的 HTTP(S) URL | 命令合同、工作区 |
| `list_checkpoints`, `create_checkpoint`, `preview_checkpoint`, `rewind_checkpoint` | CheckpointService / 工作区 Runtime 协调 | Git 快照、检查点清单与对话备份 | checkpoint-service、工作区 |
| `git_status`, `git_diff` | 工作区 Git 读取 | 当前会话 Worktree | 工作区 Git 回归；此基线仍同步 |
| `stage`, `unstage`, `commit` | 工作区 Git 写操作 | 显式路径与提交主题 | 工作区 Git 回归 |
| `integration_target`, `list_integrations`, `prepare_integration`, `continue_interactive_integration`, `promote_integration`, `discard_integration`, `open_integration` | InteractiveIntegrationManager | 独立集成 Worktree、integration-state-v1.json；显式 Promotion | integration-workspace、工作区 |
| `recover_operation` | Main 明确返回 recovery_manager_not_connected | 正式 Recovery 尚未装配 | 合同；不把 Smoke 恢复夹具当作正式能力 |

`workspace:snapshot` 是单独的固定读取接口，不经过本项新增命令校验器。业务仍主要位于 Main；完整归属和迁移条件见 [ADR-0007](../adr/0007-workspace-ownership-and-daemon-migration.md)。

测试位置：[命令合同](../../tests/interactive/workspace-command.test.mjs)、[身份/路径/审批边界](../../tests/interactive/workspace-command-boundary.test.mjs)、[正式工作区](../../tests/interactive/interactive-workspace.test.mjs)、[UI 探测](../../scripts/probe-ui-interactions.mjs)。表内其余文件位于 `tests/interactive/`；所有文件由 CI 分组入口枚举，不需要真实 Provider 凭据。
