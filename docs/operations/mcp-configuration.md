# MCP 配置来源与生效时机

适用于包含 T-LT-D015–D020 的源码构建。早期 S2 报告记录的是当时的部分能力，当前写入和重载行为以本文为准。

## 作用域怎样对应到会话

| 设置中的作用域 | 宿主选择范围 | 实际写入位置 |
| --- | --- | --- |
| User | 所有已登记项目 | 各项目根目录及其可写 Codex/Claude 会话 Worktree 的 `.mcp.json` |
| Project | 绑定项目 | 该项目根目录及其可写会话 Worktree 的 `.mcp.json` |
| Local | 绑定项目 | 当前与 Project 使用相同文件路径；没有独立的原生私有配置层 |

这是 Tsukiori 的配置选择范围，不代表 Runtime 报告了相同作用域。Local 也不会自动让文件被 Git 忽略；不要根据名称认定配置不可分享。只读导入会话、Direct API 会话不参与配置同步。新建或分支会话在创建 Worktree 后绑定配置，绑定失败会清理本次新建的 Worktree 和分支。

宿主登记保存在 Electron userData 下的 `mcp-servers-v1.json`，条目所有权摘要在 `mcp-ownership/`。同一生效范围不能登记两个启用的同名条目；User 和 Project/Local 同名也会报冲突，不按优先级覆盖。

## Runtime 实际读取什么

| Runtime | 宿主管理条目的入口 | 原生独立配置 |
| --- | --- | --- |
| Codex | app-server 的 `-c mcp_servers.<名称>.<字段>=...` 启动参数，stdio/HTTP | 不改写原生 config.toml；Runtime 自行加载的服务器单独显示 |
| Claude | `--mcp-config <实际 Worktree>/.mcp.json`，包括 bare 模式 | 保留同一 JSON 内的非托管条目，不启用 strict-mcp-config |
| Direct API | 暂无 MCP 工具接入 | 设置中存在条目不等于模型能调用 |

Codex 生成的服务器名为 `tsukiori_` 加登记 ID 摘要；该前缀用于宿主管理，原生配置避免使用。界面仍显示填写的名称。Codex 不把 `.mcp.json` 作为启动来源；仅存在于该 JSON 的独立条目不会自动转换为 Codex 配置。Codex 的 SSE 合同尚未验证，启用 SSE 条目会阻止其启动；请使用 HTTP/stdio 或停用条目。

环境变量只保存名字。Claude 文件写 `${变量名}`，Codex 传 env_vars；值必须在该 Runtime 允许继承的环境中存在。Provider 凭据隔离仍然有效，填写名字不会绕过隔离。HTTP 的授权 Header、MCP OAuth 登录目前没有统一管理入口；不要把凭据放进 URL、命令参数或仓库文件。

## 保存、重载与健康状态

保存同时准备登记、配置和所有权文件，逐个原子替换；可捕获的写入失败会尝试整体回滚并报错。外部改动过的托管条目、独立同名条目、损坏或超限文件会阻止保存，原内容保留。删除仅移除宿主拥有的条目；其他顶层字段、独立服务器不删。

Codex 正在运行时继续使用旧配置，健康说明显示等待下一轮。下一轮或空闲时查询能力会重启客户端并恢复原 Thread。恢复失败保留 Thread ID，处理原因后可以重试；不自动新开无历史会话。Claude 在下一轮进程启动时重新读取文件。

`loaded` 只表示启动配置已加载。Codex 的服务器清单用于区分 observed、not_observed、unknown，认证与可用性以原生反馈为准；Claude 目前只有服务器数量证据，单项名称、认证与健康仍是 unknown。真实服务器连接、OAuth 续期和工具调用需要另行验证。

## 冲突和故障处理

先保留出错文件和 userData 登记，不要直接删除所有权记录。若修改了托管条目，可先恢复到保存前的内容，再从设置修改；若需要同时保留独立服务器，为新登记换一个名称。新 Worktree 只从 Git 取得已提交的独立文件，不会复制项目目录中尚未提交的任意配置。

当前多文件事务不承诺断电时整体提交或整体回滚。若提示回滚未完成，停止继续编辑，备份登记、所有权文件和涉及目录的 `.mcp.json`，逐一核对后恢复；不要反复保存掩盖差异。单个配置与登记文件上限为 512 KiB。

实现与验证：[合并及所有权](../spikes/T-LT-D016-mcp-ownership.md)、[写入回滚](../spikes/T-LT-D017-mcp-transaction.md)、[Worktree 绑定](../spikes/T-LT-D018-mcp-worktree.md)、[Runtime 合同](../spikes/T-LT-D019-mcp-runtime-config.md)、[已有会话重载](../spikes/T-LT-D020-mcp-reload.md)。
