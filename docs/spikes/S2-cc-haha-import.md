# S2 cc-haha 基础历史导入

- 日期：2026-08-09
- 结论：PASS（基础历史范围）
- 决策：`docs/adr/0006-cc-haha-history-import-boundary.md`

## 验证范围

- 配置根目录与 `projects` 目录的只读发现；
- UUID JSONL、文件/总量/行数/事件数量边界；
- Transcript `cwd` 到真实 Git 根目录的结构化验证；
- Transcript SHA-256、Source Fingerprint、Dry Run 后变化拒绝和内容哈希幂等；
- User/Assistant Text、Thinking、脱敏 Tool 状态转换；
- Raw Tool Input/Result、凭据和运行状态排除；
- 每 Session 独立 Worktree、只读 Host Session 与显式 Claude Fork；
- 单批错误时 Session、Transcript、Worktree、Branch 和新增 Project 状态回滚；
- Preload 固定 API、设置页 Dry Run/选择/确认和只读提示。

## 自动证据

```powershell
pnpm --filter @tsukiori/desktop build
node --test tests/interactive/cc-haha-importer.test.mjs
node --test tests/interactive/interactive-workspace.test.mjs
node --test tests/ui/basic-ui.test.mjs
```

Fixture 覆盖源文件字节不变、重复导入跳过、Dry Run 后修改拒绝、Raw Tool 内容不进入转换结果、Host 写入口拒绝，以及导入历史显式 Fork 后解除只读标记。

## 明确不在本范围

- cc-haha Settings、认证、MCP、Skills、Hooks、Plugins、IM、宠物和更新状态；
- 非 Claude JSONL 或没有可验证 `cwd` 的历史；
- 真实 Claude CLI 对任意历史 Session UUID 的 Resume/Fork 兼容承诺；
- 跨机器项目路径自动重映射和用户自定义映射 UI。
