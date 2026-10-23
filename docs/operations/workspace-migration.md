# 工作区迁移与降级恢复

适用范围：包含 D039、D040 迁移接口的源码构建。以下命令在仓库根目录的 PowerShell 中执行，使用 Node.js 24 或更新版本和已编译的 `apps/desktop/dist`。先运行 `npm run build` 并确认成功。具体安装包是否默认启用 SQLite，以该构建的正式入口为准；迁移接口存在不代表旧安装包已切换存储。

## 关闭程序并确认数据目录

先退出桌面程序、相关 Daemon 和所有会写这份数据的工具。确认进程已结束后再操作；关闭窗口但保留后台进程不够。不要在两个版本同时运行时迁移。目录由 Electron `app.getPath('userData')` 决定，不要凭 `%APPDATA%` 下的名称猜测。

```powershell
$ErrorActionPreference = 'Stop'
$migrationDataDir = (Resolve-Path -LiteralPath (Read-Host '输入当前构建实际使用的 userData 绝对目录')).Path
if (-not (Test-Path -LiteralPath $migrationDataDir -PathType Container)) { throw '数据目录不存在' }
$env:TSUKIORI_MIGRATION_USER_DATA = $migrationDataDir
```

本指南处理工作区状态和已保存的会话。项目原仓库、Git 共享引用、外部 Runtime 历史和系统凭据库应单独备份。关闭“保存对话”期间未落盘的消息无法靠迁移补回。MCP 所有权、定时任务、检查点、导入记录、Integration 和子代理投影目前保留原目录，不能只复制 SQLite 就当作完整备份。

## 先复制完整数据目录

选择数据目录之外的备份父目录。以下命令创建新的备份目录，不覆盖既有备份。迁移前后、降级前都可以执行一次；每次记下返回的完整位置。

```powershell
$migrationBackupParent = (Resolve-Path -LiteralPath (Read-Host '输入独立备份父目录')).Path
$migrationBackupDir = Join-Path $migrationBackupParent ('tsukiori-data-' + [guid]::NewGuid().ToString('N'))
$migrationSourceFull = [IO.Path]::GetFullPath($migrationDataDir).TrimEnd('\')
$migrationBackupFull = [IO.Path]::GetFullPath($migrationBackupDir).TrimEnd('\')
if ($migrationBackupFull.Equals($migrationSourceFull, [StringComparison]::OrdinalIgnoreCase) -or
    $migrationBackupFull.StartsWith($migrationSourceFull + '\', [StringComparison]::OrdinalIgnoreCase)) {
  throw '备份必须放在当前数据目录之外'
}
Copy-Item -LiteralPath $migrationDataDir -Destination $migrationBackupDir -Recurse
foreach ($migrationDbName in @('workspace.sqlite', 'workspace.sqlite-wal', 'workspace.sqlite-shm')) {
  $migrationDbSource = Join-Path $migrationDataDir $migrationDbName
  if (Test-Path -LiteralPath $migrationDbSource -PathType Leaf) {
    $migrationDbCopy = Join-Path $migrationBackupDir $migrationDbName
    if ((Get-FileHash -LiteralPath $migrationDbSource -Algorithm SHA256).Hash -ne
        (Get-FileHash -LiteralPath $migrationDbCopy -Algorithm SHA256).Hash) { throw '数据库备份校验失败' }
  }
}
$migrationBackupDir
```

SQLite 正常关闭可能合并并移除 WAL/SHM；若它们仍存在，必须在没有写入者的情况下与主数据库一起复制。不能只复制正在写入的 `.sqlite` 文件，也不要先删除 WAL 来获得“干净”备份。

## 准备只输出计数和校验值的迁移命令

保留当前 PowerShell 会话中的 `$migrationDataDir`。下面只定义脚本，不会立即迁移。不要打印 `statePlan`、`eventPlan` 或消息数组，它们包含用户数据。

```powershell
$migrationScript = @'
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { WorkspaceSqliteStore, WorkspaceStorageError, WORKSPACE_SQLITE_VERSION } from './apps/desktop/dist/electron-main/workspace-sqlite.js';
import { planWorkspaceMigration, applyWorkspaceMigration, WorkspaceMigrationError } from './apps/desktop/dist/electron-main/workspace-state-migration.js';
import { planConversationMigration, applyConversationMigration, ConversationMigrationError } from './apps/desktop/dist/electron-main/workspace-conversation-migration.js';

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const reasons = new Set(['unsupported_version', 'invalid_schema', 'invalid_data', 'unavailable',
  'invalid_plan', 'source_changed', 'source_invalid', 'source_unavailable', 'target_not_empty',
  'target_mismatch', 'backup_failed', 'import_failed']);
let store;
try {
  const mode = process.env.TSUKIORI_MIGRATION_MODE;
  if (!['dry', 'apply', 'inspect'].includes(mode)) throw new Error();
  if (!process.env.TSUKIORI_MIGRATION_USER_DATA) throw new Error();
  const directory = realpathSync.native(process.env.TSUKIORI_MIGRATION_USER_DATA);
  const databasePath = join(directory, 'workspace.sqlite');
  if (mode === 'inspect') {
    if (!existsSync(databasePath)) throw new Error();
    store = new WorkspaceSqliteStore(databasePath);
    const state = store.readState();
    if (!state) throw new Error();
    console.log(JSON.stringify({ status: 'inspected', schemaVersion: WORKSPACE_SQLITE_VERSION,
      counts: { projects: state.projects.length, sessions: state.sessions.length,
        events: state.sessions.reduce((sum, session) => sum + store.readEvents(session.id).length, 0) },
      migrations: store.listMigrationRuns().map(({ phase, sourceHash, counts, backupName }) =>
        ({ phase, sourceHash, counts, backupName })) }, null, 2));
  } else {
    const statePlan = planWorkspaceMigration(directory);
    if (!statePlan.selectedSource) throw new Error();
    const eventPlan = planConversationMigration(directory, statePlan.state);
    const summary = { stateSourceHash: statePlan.sourceHash, conversationSourceHash: eventPlan.sourceHash,
      stateCounts: statePlan.counts, conversationCounts: eventPlan.counts,
      recoveredFromBackup: statePlan.recoveredFromBackup };
    if (mode === 'dry') {
      console.log(JSON.stringify({ status: 'planned', ...summary }, null, 2));
    } else {
      if (process.env.TSUKIORI_MIGRATION_EXPECTED_STATE !== statePlan.sourceHash ||
          process.env.TSUKIORI_MIGRATION_EXPECTED_EVENTS !== eventPlan.sourceHash) {
        throw new WorkspaceMigrationError('source_changed');
      }
      store = new WorkspaceSqliteStore(databasePath);
      const stateResult = applyWorkspaceMigration(statePlan, store);
      const eventResult = applyConversationMigration(eventPlan, store);
      if (hash(store.readState()) !== statePlan.stateHash ||
          eventPlan.sessions.some((session) => hash(store.readEvents(session.sessionId)) !== session.eventHash)) {
        throw new Error();
      }
      console.log(JSON.stringify({ status: 'verified', ...summary,
        stateResult: stateResult.status, conversationResult: eventResult.status,
        backupNames: [stateResult.run.backupName, eventResult.run.backupName] }, null, 2));
    }
  }
} catch (error) {
  const known = error instanceof WorkspaceStorageError || error instanceof WorkspaceMigrationError || error instanceof ConversationMigrationError;
  console.error(JSON.stringify({ status: 'failed', reason: known && reasons.has(error.reason) ? error.reason : 'operation_failed' }));
  process.exitCode = 1;
} finally {
  try { store?.close(); }
  catch { console.error(JSON.stringify({ status: 'failed', reason: 'close_failed' })); process.exitCode = 1; }
}
'@
```

### Dry run

```powershell
$env:TSUKIORI_MIGRATION_MODE = 'dry'
$migrationScript | node --input-type=module -
if ($LASTEXITCODE -ne 0) { throw '预检查失败，请参照失败处理表；不要继续 apply' }
```

Dry run 不打开 SQLite、不创建迁移备份、不修复原文件。它核对 JSON 和活动 Transcript 分段、会话关联及记录版本，输出计数、两个源校验值和是否选用了有效 `.bak`。确认项目、会话数量符合预期。没有找到旧状态源时，本示例会失败，不把错误目录当作新工作区导入。

### 显式 apply

将刚才输出的两个校验值输入下面的命令。若源文件已经改变，重新做 dry run 和核对；不要用旧计划强行覆盖目标。

```powershell
$env:TSUKIORI_MIGRATION_EXPECTED_STATE = Read-Host '输入刚核对过的 stateSourceHash'
$env:TSUKIORI_MIGRATION_EXPECTED_EVENTS = Read-Host '输入刚核对过的 conversationSourceHash'
$env:TSUKIORI_MIGRATION_MODE = 'apply'
$migrationScript | node --input-type=module -
if ($LASTEXITCODE -ne 0) { throw '迁移未完成，请保留原文件、数据库和备份后排查' }
```

状态和会话写入同一个 `workspace.sqlite`，分别在各自事务中提交。因此失败时可能只有 `state` 阶段完成，不能仅看到数据库文件就认定会话已导入。成功返回 `verified`，并核对实际状态及各会话完整事件的 hash；相同来源重复执行返回 `already_applied`，不会再追加一份相同历史。应用开始产生新数据后，不要再把旧导入命令当作同步工具。

自动迁移备份位于用户目录下的 `workspace-migration-backups/`：状态目录名为 `<stateSourceHash>-<随机标识>`，会话目录名为 `events-<conversationSourceHash>-<随机标识>`。返回的 `backupNames` 对应这些子目录，各自有 `manifest.json`、源文件清单、字节数和 SHA-256。失败尝试留下的备份也会保留。它们只覆盖相应迁移源，不能替代前面的完整目录备份。

## 重新打开并核对结果

apply 完成且进程关闭后，先在同一 PowerShell 会话中查看持久化结果：

```powershell
$env:TSUKIORI_MIGRATION_MODE = 'inspect'
$migrationScript | node --input-type=module -
if ($LASTEXITCODE -ne 0) { throw '数据库检查失败，请先恢复或排查，不要启动旧版本覆盖' }
```

`inspect` 重新打开并验证存储结构，只输出当前项目、会话、事件计数以及迁移阶段/hash/备份名称，不再次导入。刚迁移完应与 dry run 数量一致，迁移记录应同时有 `state` 和 `events`。缺少 `events` 时先处理会话迁移失败。后续新增消息会增加当前计数，迁移记录中的计数仍是导入时的快照。

再启动对应构建，检查项目、会话、设置和一段较早的对话；关闭后再次打开，确认数据仍在。离线导入成功不证明原生 Runtime Thread、权限请求或 Git 工作区可以自动恢复执行；继续任务前先核对这些实际状态，不重放已有写入操作。

## 失败后怎么继续

| 输出原因 | 处理 |
| --- | --- |
| `source_invalid`、`source_unavailable` | 保留原文件，包括损坏 JSON、`.bak`、Transcript 索引和活动分段。在副本上排查，从同一备份点补回缺失文件；不要删掉索引来隐藏缺口。 |
| `source_changed`、`invalid_plan` | 停止其他写入者，重新 dry run。若目标已导入另一份来源，先核对迁移记录，不直接覆盖。 |
| `backup_failed` | 检查空间和权限。保留已有完整备份及失败尝试的目录，解决问题后用原数据重试。 |
| `import_failed` | 当前阶段事务回滚，之前已成功的阶段保留。关闭数据库后重新执行相同源的 dry run/apply，已完成阶段会被识别；不要清空表或删库重跑。 |
| `target_not_empty`、`target_mismatch` | 目标已有其他来源或关联不符，停止迁移，核对是否选错数据目录。不能把活跃数据库覆盖成旧快照。 |
| `unsupported_version` | 换用兼容这份数据的程序；不要改 `user_version`、JSON 版本号或删数据库强制启动。 |
| `invalid_schema`、`invalid_data`、`unavailable`、`operation_failed`、`close_failed` | 保留目录和备份，在副本上核查结构、权限、磁盘及构建版本。关闭失败时先确认进程已结束，再备份数据库。示例故意不输出异常正文；不能把通用失败理解为空工作区。 |

选用有效 `.bak` 的迁移只读取它，不覆盖损坏的主 JSON；该主文件也包含在状态迁移备份中。补回分段或恢复源文件后，先确认 hash 与所选恢复点一致，再重试。不能把来自不同时间的 JSON、Transcript 索引和分段随意拼合。

## 降级只恢复迁移前的快照

旧 JSON 版本不会读取 SQLite 中新增的活动。本项目没有提供“把新库倒灌回旧 JSON/Transcript”的降级转换器。若必须降级，接受退回旧备份时间点，并先将当前完整目录另存；新版本产生的数据继续保留，待兼容版本打开或后续专门迁移处理。

关闭所有写入者，再执行前面的完整备份步骤，保留当前 `.sqlite`、可能存在的 `-wal`/`-shm` 及其他目录。然后选用**升级前完整备份**，确认其中的旧 JSON、`.bak`、`transcripts/` 及配置属于同一时间点。不要把自动生成的某一个迁移子目录当作完整备份。

下面将当前数据目录整体移到同一父目录下的新保留目录，再把选定的旧完整备份复制回原位置。只有明确决定恢复旧快照时才执行；不删除当前数据。

```powershell
$migrationOldSnapshot = (Resolve-Path -LiteralPath (Read-Host '输入升级前完整备份目录')).Path
$migrationOriginal = [IO.Path]::GetFullPath($migrationDataDir).TrimEnd('\')
$migrationOldFull = [IO.Path]::GetFullPath($migrationOldSnapshot).TrimEnd('\')
$migrationOriginalParent = Split-Path -Parent $migrationOriginal
if (-not $migrationOriginalParent -or -not (Test-Path -LiteralPath $migrationOriginal -PathType Container)) {
  throw '原数据目录无效'
}
if (-not (Test-Path -LiteralPath $migrationOldSnapshot -PathType Container) -or
    $migrationOldFull.Equals($migrationOriginal, [StringComparison]::OrdinalIgnoreCase) -or
    $migrationOldFull.StartsWith($migrationOriginal + '\', [StringComparison]::OrdinalIgnoreCase) -or
    $migrationOriginal.StartsWith($migrationOldFull + '\', [StringComparison]::OrdinalIgnoreCase)) {
  throw '旧备份必须是独立目录，不能与当前数据目录互相包含'
}
$migrationPreserved = Join-Path $migrationOriginalParent ('tsukiori-preserved-' + [guid]::NewGuid().ToString('N'))
if ((Split-Path -Parent ([IO.Path]::GetFullPath($migrationPreserved))) -ne $migrationOriginalParent -or
    (Test-Path -LiteralPath $migrationPreserved)) { throw '保留目录边界校验失败' }
Move-Item -LiteralPath $migrationOriginal -Destination $migrationPreserved
Copy-Item -LiteralPath $migrationOldSnapshot -Destination $migrationOriginal -Recurse
$migrationPreserved
```

若复制中断，不启动任何版本；原当前数据仍完整保留在返回目录，先完成恢复或在副本上核对。此操作恢复的是用户数据快照，不会回退外部项目的 Git 引用、Runtime 原生历史或系统凭据。启动旧构建后先核对旧项目/会话和文件，再决定是否继续任务；不要依靠旧会话自动回放副作用来“补齐”迁移后的工作。

实现与离线证据见 [D042 验收记录](../spikes/T-LT-D042-migration-recovery-guide.md)。存储归属及后续切换约束见 [ADR-0007](../adr/0007-workspace-ownership-and-daemon-migration.md)。
