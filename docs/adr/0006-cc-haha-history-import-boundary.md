# ADR-0006：cc-haha 历史导入安全边界

- 状态：Accepted
- 日期：2026-08-09
- 范围：基础 Transcript/Project 迁移；不等同于 cc-haha 全功能或全数据迁移

## 背景

迁移决策要求先解决老用户数据落点，同时禁止仅凭目录存在就宣称能力已迁移。cc-haha 的 Claude Transcript 位于配置目录下的 `projects/<sanitized-cwd>/<uuid>.jsonl`；目录名经过有损替换，不能可靠恢复真实项目路径。Transcript 本身通常包含 `cwd`、User/Assistant Message、Thinking、Tool Use/Result、标题和 Runtime Session ID，也可能包含敏感工具输入或结果正文。

## 决策

1. 导入必须由用户显式选择目录并先执行只读 Dry Run；源目录永不写入。
2. 仅枚举直接项目子目录中的 UUID JSONL，拒绝符号链接、超限目录/文件/行数/总字节和高比例损坏数据。
3. 不使用 sanitized 目录名恢复项目。只有 Transcript `cwd` 能由 `git rev-parse --show-toplevel` 验证时，候选才可导入。
4. Dry Run 生成每条 Transcript SHA-256 与全源 Source Fingerprint；执行前重新扫描、重算哈希，任何变化都要求用户重新 Dry Run。
5. Manifest 以 Transcript 内容哈希记账，同一内容重复导入得到“已导入”，不复制 Session。
6. 只转换 User/Assistant Text、Thinking 和脱敏 Tool 生命周期摘要。OAuth、API Key、Cookie、Keychain、Raw Tool Input/Result、IM 登录态、Plugins/Hooks 配置和运行中进程均不迁移。
7. 每条历史绑定独立 `tsukiori/import-*` Worktree 与源 Claude Session UUID。导入 Session 标记 `importedReadOnly`；Main Process 拒绝 Prompt、选项修改、附件、Terminal、Stage/Unstage/Commit、Checkpoint 创建/回退。用户必须显式 Fork，才能创建新的可写历史和 Worktree。
8. 单批最多 50 条。转换全部预检后才开始创建 Worktree；失败时回滚该批新建 Session、Transcript、Worktree、分支和新增 Project 状态。
9. 导入事件和 Transcript 有独立数量/字节上限；超出时显式标记 `truncated`，不静默把不完整历史声明为完整迁移。

## 未采用方案

### 从目录名直接恢复项目

拒绝。sanitize 变换不可逆，错误映射会把历史绑定到错误代码库。

### 直接复制 JSONL 到 Tsukiori

拒绝。两边事件 Schema、Session ID 和敏感字段边界不同，Raw Tool Input/Result 不能进入 Renderer/Host Transcript。

### 导入后直接 Resume

拒绝。历史来自另一宿主，代码状态和 Runtime 状态没有事务证明。只读展示后由用户显式 Fork，才是可解释的继续点。

### 迁移认证和运行状态

拒绝。OAuth/Keychain/API Key 与运行中进程均属于原宿主或 Runtime 安全域，不能由文件迁移器复制或声称接管。

## 后果与限制

- 已覆盖 cc-haha/Claude JSONL 基础历史，不覆盖 cc-haha Settings、MCP、Skills、Hooks、Plugins、IM、宠物、自动更新或其他产品数据。
- Fixture 证明源文件不变、哈希幂等、Dry Run 后修改拒绝、只读保护、批次隔离和显式 Fork；真实 Claude CLI 对旧 Session UUID 的长期兼容仍由版本锁与后续 E2E 决定。
- Manifest 保存在 Tsukiori `userData/imports/cc-haha`，不写回源目录。
