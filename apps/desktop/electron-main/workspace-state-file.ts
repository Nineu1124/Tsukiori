import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

type StateRecord = Record<string, unknown>;
export type WorkspaceStateDocument = {
  schemaVersion: 1 | 2 | 3;
  projects: StateRecord[];
  sessions: StateRecord[];
  settings?: StateRecord;
  providers?: StateRecord[];
  teams?: StateRecord[];
};

export class WorkspaceStateError extends Error {
  constructor(readonly reason: 'invalid' | 'unreadable' | 'unsupported_version', path: string) {
    const detail = {
      invalid: '文件内容损坏或结构不完整',
      unreadable: '文件无法读取，请检查权限和磁盘状态',
      unsupported_version: '文件由不兼容的版本保存，请使用对应版本打开',
    }[reason];
    super(`无法加载 ${basename(path)}：${detail}。原文件已保留，请备份后再处理。`);
    this.name = 'WorkspaceStateError';
  }
}

export function readWorkspaceStateFile(path: string): WorkspaceStateDocument | undefined {
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new WorkspaceStateError('unreadable', path);
  }
  return parseWorkspaceState(content, path);
}

export function parseWorkspaceState(content: string, path: string): WorkspaceStateDocument {
  let value: unknown;
  try { value = JSON.parse(content); } catch { throw new WorkspaceStateError('invalid', path); }
  if (!record(value)) throw new WorkspaceStateError('invalid', path);
  if (![1, 2, 3].includes(Number(value.schemaVersion)) || typeof value.schemaVersion !== 'number') {
    throw new WorkspaceStateError('unsupported_version', path);
  }
  const invalid = () => { throw new WorkspaceStateError('invalid', path); };
  const rows = (raw: unknown): StateRecord[] => {
    if (!Array.isArray(raw) || !raw.every(record)) return invalid();
    const ids = new Set<string>();
    for (const row of raw) {
      if (typeof row.id !== 'string' || !row.id.trim() || ids.has(row.id)) return invalid();
      ids.add(row.id);
    }
    return raw;
  };
  const projects = rows(value.projects);
  const sessions = rows(value.sessions);
  for (const project of projects) {
    if (!['name', 'rootPath', 'gitRoot'].every((key) => typeof project[key] === 'string')) invalid();
  }
  const projectIds = new Set(projects.map((item) => item.id));
  for (const session of sessions) {
    if (!projectIds.has(session.projectId)
      || !['name', 'worktreePath', 'branch'].every((key) => typeof session[key] === 'string')) invalid();
  }
  if (value.schemaVersion >= 2) {
    if (!record(value.settings)) invalid();
    for (const provider of rows(value.providers)) {
      if (typeof provider.kind !== 'string' || !Array.isArray(provider.models)
        || !provider.models.every((model) => typeof model === 'string')) invalid();
    }
  }
  if (value.schemaVersion >= 3) {
    const sessionProjects = new Map(sessions.map((item) => [item.id, item.projectId]));
    for (const team of rows(value.teams)) {
      if (!projectIds.has(team.projectId) || !Array.isArray(team.memberSessionIds)
        || new Set(team.memberSessionIds).size !== team.memberSessionIds.length
        || !team.memberSessionIds.every((id) => sessionProjects.get(id) === team.projectId)) invalid();
    }
  }
  return value as WorkspaceStateDocument;
}

function record(value: unknown): value is StateRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
