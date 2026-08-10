import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

const OUTPUT_LIMIT = 4 * 1024 * 1024;

export type InteractiveIntegrationStrategy = 'merge' | 'rebase';
export type InteractiveIntegrationStatus =
  | 'preparing'
  | 'verified'
  | 'conflicted'
  | 'verification_failed'
  | 'interrupted'
  | 'promoted'
  | 'discarded';

export type InteractiveIntegration = {
  id: string;
  sessionId: string;
  projectId: string;
  strategy: InteractiveIntegrationStrategy;
  targetRef: string;
  sourceCommit: string;
  targetCommit: string;
  integrationBranch: string;
  integrationPath: string;
  status: InteractiveIntegrationStatus;
  resultCommit?: string;
  conflictPaths: string[];
  retained: boolean;
  promotionRequired: boolean;
  recoveryRef?: string;
  errorCategory?: string;
  createdAt: number;
  updatedAt: number;
};

type PrepareInput = {
  sessionId: string;
  projectId: string;
  sessionWorktree: string;
  projectGitRoot: string;
  targetRef?: string;
  strategy?: InteractiveIntegrationStrategy;
};

type GitResult = { status: number; stdout: string; stderr: string };

export class InteractiveIntegrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InteractiveIntegrationError';
  }
}

export class InteractiveIntegrationManager {
  readonly #statePath: string;
  readonly #root: string;
  #items: InteractiveIntegration[] = [];

  constructor(userDataPath: string) {
    const root = resolve(userDataPath, 'integration-worktrees');
    this.#statePath = resolve(userDataPath, 'integration-state-v1.json');
    mkdirSync(root, { recursive: true });
    this.#root = realpathSync.native(root);
    this.#load();
  }

  list(sessionId?: string): InteractiveIntegration[] {
    return this.#items
      .filter((item) => !sessionId || item.sessionId === sessionId)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map(copyIntegration);
  }

  target(projectGitRoot: string): { targetRef: string; targetCommit: string; clean: boolean } {
    const projectRoot = this.#repository(projectGitRoot, '项目 Git Root');
    const targetRef = this.#currentBranch(projectRoot);
    const targetCommit = this.#commit(this.#git(projectRoot, ['rev-parse', '--verify', 'HEAD']).stdout.trim());
    const clean = this.#git(projectRoot, ['status', '--porcelain=v2', '--untracked-files=all']).stdout.length === 0;
    return { targetRef, targetCommit, clean };
  }

  prepare(input: PrepareInput): InteractiveIntegration {
    const strategy = input.strategy === 'rebase' ? 'rebase' : 'merge';
    const projectRoot = this.#repository(input.projectGitRoot, '项目 Git Root');
    const sessionRoot = this.#repository(input.sessionWorktree, 'Session Worktree');
    const targetRef = this.#currentBranch(projectRoot);
    if (input.targetRef && input.targetRef !== targetRef) {
      throw new InteractiveIntegrationError('目标分支已经变化，请刷新后重试');
    }
    this.#assertCleanSource(sessionRoot);
    this.#assertNoSubmodules(sessionRoot);
    const sourceCommit = this.#commit(this.#success(sessionRoot, ['rev-parse', '--verify', 'HEAD']).stdout.trim());
    const targetCommit = this.#commit(this.#success(projectRoot, ['rev-parse', '--verify', targetRef + '^{commit}']).stdout.trim());
    const token = randomUUID();
    const integrationBranch = 'tsukiori/integration-' + token.slice(0, 12);
    const integrationPath = resolve(this.#root, token.slice(0, 16));
    this.#assertWithinRoot(integrationPath);
    const now = Date.now();
    const item: InteractiveIntegration = {
      id: 'integration:' + token,
      sessionId: cleanId(input.sessionId, 'Session ID'),
      projectId: cleanId(input.projectId, 'Project ID'),
      strategy,
      targetRef,
      sourceCommit,
      targetCommit,
      integrationBranch,
      integrationPath,
      status: 'preparing',
      conflictPaths: [],
      retained: false,
      promotionRequired: true,
      createdAt: now,
      updatedAt: now,
    };
    this.#items.push(item);
    this.#save();
    try {
      const startCommit = strategy === 'merge' ? targetCommit : sourceCommit;
      this.#success(projectRoot, ['worktree', 'add', '-b', integrationBranch, integrationPath, startCommit]);
      item.retained = true;
      this.#save();
      const action = strategy === 'merge'
        ? ['-c', 'core.hooksPath=NUL', '-c', 'commit.gpgSign=false', 'merge', '--no-ff', '--no-edit', '--no-gpg-sign', sourceCommit]
        : ['-c', 'core.hooksPath=NUL', '-c', 'commit.gpgSign=false', 'rebase', targetCommit];
      const result = this.#git(integrationPath, action);
      if (result.status !== 0) return this.#conflictedOrFailed(item, integrationPath);
      return this.#verify(item, projectRoot, integrationPath);
    } catch (error) {
      item.status = 'interrupted';
      item.errorCategory = error instanceof InteractiveIntegrationError ? 'integration_setup_failed' : 'unexpected_failure';
      item.updatedAt = Date.now();
      this.#save();
      throw error;
    }
  }

  continue(id: string, projectGitRoot: string): InteractiveIntegration {
    const item = this.#item(id);
    if (!['conflicted', 'verification_failed', 'interrupted'].includes(item.status)) {
      throw new InteractiveIntegrationError('当前 Integration 不需要继续');
    }
    const projectRoot = this.#repository(projectGitRoot, '项目 Git Root');
    const integrationPath = this.#existingIntegrationPath(item.integrationPath);
    const conflicts = this.#conflicts(integrationPath);
    if (conflicts.length) throw new InteractiveIntegrationError('仍有未解决的 Git 冲突');
    const inProgress = item.strategy === 'merge'
      ? this.#git(integrationPath, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']).status === 0
      : this.#rebaseInProgress(integrationPath);
    if (inProgress) {
      const command = item.strategy === 'merge'
        ? ['-c', 'core.hooksPath=NUL', '-c', 'commit.gpgSign=false', '-c', 'core.editor=true', 'merge', '--continue']
        : ['-c', 'core.hooksPath=NUL', '-c', 'commit.gpgSign=false', '-c', 'sequence.editor=true', '-c', 'core.editor=true', 'rebase', '--continue'];
      this.#success(integrationPath, command);
    }
    return this.#verify(item, projectRoot, integrationPath);
  }

  promote(id: string, projectGitRoot: string): InteractiveIntegration {
    const item = this.#item(id);
    if (item.status === 'promoted') return copyIntegration(item);
    if (item.status !== 'verified' || !item.resultCommit) {
      throw new InteractiveIntegrationError('只有验证通过的 Integration 才能 Promotion');
    }
    const projectRoot = this.#repository(projectGitRoot, '项目 Git Root');
    const currentBranch = this.#currentBranch(projectRoot);
    const currentCommit = this.#commit(this.#success(projectRoot, ['rev-parse', '--verify', 'HEAD']).stdout.trim());
    if (currentBranch !== item.targetRef || currentCommit !== item.targetCommit) {
      throw new InteractiveIntegrationError('目标分支或 HEAD 已变化，请重新创建 Integration');
    }
    if (this.#success(projectRoot, ['status', '--porcelain=v2', '--untracked-files=all']).stdout) {
      throw new InteractiveIntegrationError('项目主工作区必须保持干净才能 Promotion');
    }
    this.#commit(this.#success(projectRoot, ['rev-parse', '--verify', item.resultCommit + '^{commit}']).stdout.trim());
    const recoveryRef = 'refs/tsukiori/recovery/promotion-' + item.id.slice('integration:'.length).replace(/[^a-zA-Z0-9-]/g, '').slice(0, 48);
    this.#success(projectRoot, ['update-ref', recoveryRef, item.targetCommit]);
    this.#success(projectRoot, ['-c', 'core.hooksPath=NUL', 'merge', '--ff-only', item.resultCommit]);
    item.status = 'promoted';
    item.recoveryRef = recoveryRef;
    item.promotionRequired = false;
    item.retained = false;
    item.updatedAt = Date.now();
    delete item.errorCategory;
    this.#save();
    return copyIntegration(item);
  }

  discard(id: string, projectGitRoot: string): InteractiveIntegration {
    const item = this.#item(id);
    if (item.status === 'promoted') throw new InteractiveIntegrationError('已 Promotion 的 Integration 不能丢弃');
    if (item.status === 'discarded') return copyIntegration(item);
    const projectRoot = this.#repository(projectGitRoot, '项目 Git Root');
    if (existsSync(item.integrationPath)) {
      this.#existingIntegrationPath(item.integrationPath);
      this.#success(projectRoot, ['worktree', 'remove', '--force', item.integrationPath]);
    }
    const branchExists = this.#git(projectRoot, ['show-ref', '--verify', '--quiet', 'refs/heads/' + item.integrationBranch]).status === 0;
    if (branchExists) this.#success(projectRoot, ['branch', '-D', item.integrationBranch]);
    item.status = 'discarded';
    item.retained = false;
    item.promotionRequired = false;
    item.updatedAt = Date.now();
    delete item.errorCategory;
    this.#save();
    return copyIntegration(item);
  }

  openPath(id: string): string {
    const item = this.#item(id);
    return this.#existingIntegrationPath(item.integrationPath);
  }

  #verify(item: InteractiveIntegration, projectRoot: string, integrationPath: string): InteractiveIntegration {
    const resultCommit = this.#commit(this.#success(integrationPath, ['rev-parse', '--verify', 'HEAD']).stdout.trim());
    const verify = this.#git(integrationPath, ['diff', '--check', item.targetCommit, resultCommit]);
    if (verify.status !== 0 || verify.stdout.trim() || verify.stderr.trim()) {
      item.status = 'verification_failed';
      item.resultCommit = resultCommit;
      item.errorCategory = 'git_diff_check_failed';
      item.retained = true;
      item.updatedAt = Date.now();
      this.#save();
      return copyIntegration(item);
    }
    this.#success(projectRoot, ['worktree', 'remove', integrationPath]);
    item.status = 'verified';
    item.resultCommit = resultCommit;
    item.conflictPaths = [];
    item.retained = false;
    item.updatedAt = Date.now();
    delete item.errorCategory;
    this.#save();
    return copyIntegration(item);
  }

  #conflictedOrFailed(item: InteractiveIntegration, integrationPath: string): InteractiveIntegration {
    const conflicts = this.#conflicts(integrationPath);
    item.conflictPaths = conflicts;
    item.status = conflicts.length ? 'conflicted' : 'interrupted';
    item.errorCategory = conflicts.length ? item.strategy + '_conflict' : 'integration_command_failed';
    item.retained = true;
    item.updatedAt = Date.now();
    this.#save();
    if (!conflicts.length) throw new InteractiveIntegrationError('Integration 命令失败且没有可观察的冲突');
    return copyIntegration(item);
  }

  #assertCleanSource(sessionRoot: string): void {
    if (this.#success(sessionRoot, ['status', '--porcelain=v2', '--untracked-files=all']).stdout) {
      throw new InteractiveIntegrationError('请先提交 Session Worktree 的全部改动');
    }
    for (const marker of ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD']) {
      if (this.#git(sessionRoot, ['rev-parse', '--verify', '--quiet', marker]).status === 0) {
        throw new InteractiveIntegrationError('Session Worktree 存在未完成的 Git 操作');
      }
    }
  }

  #assertNoSubmodules(sessionRoot: string): void {
    if (/^160000 /m.test(this.#success(sessionRoot, ['ls-files', '--stage']).stdout)) {
      throw new InteractiveIntegrationError('当前版本不自动合并 Submodule gitlink');
    }
  }

  #conflicts(path: string): string[] {
    return this.#success(path, ['diff', '--name-only', '--diff-filter=U', '-z', '--no-color', '--no-ext-diff'])
      .stdout.split('\0').filter(Boolean).sort().slice(0, 500);
  }

  #rebaseInProgress(path: string): boolean {
    for (const name of ['rebase-merge', 'rebase-apply']) {
      const raw = this.#success(path, ['rev-parse', '--git-path', name]).stdout.trim();
      const candidate = isAbsolute(raw) ? raw : resolve(path, raw);
      if (existsSync(candidate)) return true;
    }
    return false;
  }

  #repository(path: string, label: string): string {
    let canonical: string;
    try { canonical = realpathSync.native(path); }
    catch { throw new InteractiveIntegrationError(label + ' 不存在'); }
    const result = this.#success(canonical, ['rev-parse', '--show-toplevel']).stdout.trim();
    let top: string;
    try { top = realpathSync.native(result); }
    catch { throw new InteractiveIntegrationError(label + ' 无法规范化'); }
    if (normalizePath(top) !== normalizePath(canonical)) throw new InteractiveIntegrationError(label + ' 与 Git Top Level 不一致');
    return canonical;
  }

  #currentBranch(projectRoot: string): string {
    const result = this.#git(projectRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    const branch = result.stdout.trim();
    if (result.status !== 0 || !branch || branch.length > 240 || branch.startsWith('-') || /[\0\r\n]/.test(branch)) {
      throw new InteractiveIntegrationError('项目主工作区必须位于普通本地分支');
    }
    return branch;
  }

  #existingIntegrationPath(path: string): string {
    this.#assertWithinRoot(path);
    if (!existsSync(path)) throw new InteractiveIntegrationError('Integration Worktree 不存在');
    const canonical = realpathSync.native(path);
    this.#assertWithinRoot(canonical);
    if (normalizePath(canonical) !== normalizePath(resolve(path))) {
      throw new InteractiveIntegrationError('Integration Worktree 规范路径已变化');
    }
    return canonical;
  }

  #assertWithinRoot(path: string): void {
    const root = resolve(this.#root);
    const target = resolve(path);
    const child = relative(root, target);
    if (!child || child.startsWith('..') || isAbsolute(child)) {
      throw new InteractiveIntegrationError('Integration 路径越出本地隔离目录');
    }
  }

  #item(id: string): InteractiveIntegration {
    const item = this.#items.find((value) => value.id === id);
    if (!item) throw new InteractiveIntegrationError('Integration 记录不存在');
    return item;
  }

  #commit(value: string): string {
    if (!/^[a-f0-9]{40,64}$/i.test(value)) throw new InteractiveIntegrationError('Git Commit 无效');
    return value;
  }

  #success(cwd: string, args: readonly string[]): GitResult {
    const result = this.#git(cwd, args);
    if (result.status !== 0) throw new InteractiveIntegrationError('结构化 Git 操作失败');
    return result;
  }

  #git(cwd: string, args: readonly string[]): GitResult {
    const result = spawnSync('git.exe', ['-C', cwd, ...args], {
      encoding: 'utf8', windowsHide: true, shell: false, timeout: 60_000,
      maxBuffer: OUTPUT_LIMIT, stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_PAGER: 'cat',
        GIT_TERMINAL_PROMPT: '0',
        GIT_EDITOR: 'true',
        GIT_SEQUENCE_EDITOR: 'true',
      },
    });
    return {
      status: result.error ? -1 : result.status ?? -1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  }

  #load(): void {
    if (!existsSync(this.#statePath)) return;
    try {
      const value = JSON.parse(readFileSync(this.#statePath, 'utf8')) as Record<string, unknown>;
      if (value.schemaVersion !== 1 || !Array.isArray(value.integrations)) return;
      this.#items = value.integrations.map((raw) => migrateIntegration(raw as Record<string, unknown>)).filter(Boolean) as InteractiveIntegration[];
      for (const item of this.#items) {
        if (item.status === 'preparing') {
          item.status = 'interrupted';
          item.errorCategory = 'application_restarted';
          item.retained = existsSync(item.integrationPath);
          item.updatedAt = Date.now();
        }
      }
      this.#save();
    } catch {
      this.#items = [];
    }
  }

  #save(): void {
    mkdirSync(dirname(this.#statePath), { recursive: true });
    writeFileSync(this.#statePath, JSON.stringify({
      schemaVersion: 1,
      integrations: this.#items,
    }, null, 2), { encoding: 'utf8', mode: 0o600 });
  }
}

function migrateIntegration(value: Record<string, unknown>): InteractiveIntegration | null {
  const statuses: InteractiveIntegrationStatus[] = [
    'preparing', 'verified', 'conflicted', 'verification_failed', 'interrupted', 'promoted', 'discarded',
  ];
  const strategy = value.strategy === 'rebase' ? 'rebase' : value.strategy === 'merge' ? 'merge' : null;
  const status = statuses.includes(value.status as InteractiveIntegrationStatus)
    ? value.status as InteractiveIntegrationStatus : null;
  if (!strategy || !status) return null;
  try {
    return {
      id: cleanId(value.id, 'Integration ID'),
      sessionId: cleanId(value.sessionId, 'Session ID'),
      projectId: cleanId(value.projectId, 'Project ID'),
      strategy,
      targetRef: cleanRef(value.targetRef),
      sourceCommit: cleanCommit(value.sourceCommit),
      targetCommit: cleanCommit(value.targetCommit),
      integrationBranch: cleanRef(value.integrationBranch),
      integrationPath: cleanPath(value.integrationPath),
      status,
      ...(typeof value.resultCommit === 'string' ? { resultCommit: cleanCommit(value.resultCommit) } : {}),
      conflictPaths: Array.isArray(value.conflictPaths)
        ? value.conflictPaths.filter((path): path is string => typeof path === 'string' && path.length <= 500 && !/[\0\r\n]/.test(path)).slice(0, 500)
        : [],
      retained: value.retained === true,
      promotionRequired: value.promotionRequired === true,
      ...(typeof value.recoveryRef === 'string' ? { recoveryRef: cleanRef(value.recoveryRef) } : {}),
      ...(typeof value.errorCategory === 'string' ? { errorCategory: cleanCategory(value.errorCategory) } : {}),
      createdAt: typeof value.createdAt === 'number' ? value.createdAt : Date.now(),
      updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : Date.now(),
    };
  } catch {
    return null;
  }
}

function copyIntegration(value: InteractiveIntegration): InteractiveIntegration {
  return { ...value, conflictPaths: [...value.conflictPaths] };
}

function cleanId(value: unknown, label: string): string {
  const text = String(value ?? '').trim();
  if (!text || text.length > 180 || /[\0\r\n]/.test(text)) throw new InteractiveIntegrationError(label + ' 无效');
  return text;
}

function cleanRef(value: unknown): string {
  const text = String(value ?? '').trim();
  if (!text || text.length > 240 || text.startsWith('-') || /[\0\r\n]/.test(text)) throw new InteractiveIntegrationError('Git Ref 无效');
  return text;
}

function cleanCommit(value: unknown): string {
  const text = String(value ?? '').trim();
  if (!/^[a-f0-9]{40,64}$/i.test(text)) throw new InteractiveIntegrationError('Git Commit 无效');
  return text;
}

function cleanPath(value: unknown): string {
  const text = String(value ?? '').trim();
  if (!text || text.length > 2_000 || /[\0\r\n]/.test(text) || !isAbsolute(text)) throw new InteractiveIntegrationError('本地路径无效');
  return resolve(text);
}

function cleanCategory(value: unknown): string {
  const text = String(value ?? '').trim();
  return /^[a-z0-9_-]{1,80}$/i.test(text) ? text : 'unknown_failure';
}

function normalizePath(value: string): string {
  return resolve(value).replaceAll('/', '\\').toLowerCase();
}
