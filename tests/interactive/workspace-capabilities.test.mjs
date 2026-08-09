import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const { WorkspaceCapabilities } = await import(new URL('../../apps/desktop/dist/electron-main/workspace-capabilities.js', import.meta.url));

test('MCP CRUD persists only sanitized configuration and enforces transport boundaries', () => {
  const root = mkdtempSync(join(tmpdir(), 'tsukiori-capabilities-mcp-'));
  try {
    const capabilities = new WorkspaceCapabilities(root);
    const server = capabilities.saveMcp({
      name: 'Local MCP', scope: 'user', transport: 'stdio', command: 'node.exe',
      args: ['server.mjs'], envKeys: ['MCP_TOKEN'],
    });
    assert.equal(capabilities.listMcp()[0].name, 'Local MCP');
    assert.equal(capabilities.listMcp()[0].authStatus, 'configured');
    assert.doesNotMatch(readFileSync(join(root, 'mcp-servers-v1.json'), 'utf8'), /secret-value|MCP_TOKEN=.*|token-value/);
    assert.throws(() => capabilities.saveMcp({ name: 'unsafe', scope: 'user', transport: 'http', url: 'file:///secret' }), /URL/);
    const project = join(root, 'project'); mkdirSync(project, { recursive: true });
    const projectServer = capabilities.saveMcp({ name: 'Project MCP', scope: 'project', projectId: 'project:1', transport: 'stdio', command: 'node.exe', args: [] });
    const otherLocal = capabilities.saveMcp({ name: 'Other Local MCP', scope: 'local', projectId: 'project:2', transport: 'stdio', command: 'node.exe', args: [] });
    assert.equal(capabilities.listMcp('project:1').some((item) => item.name === 'Other Local MCP'), false);
    assert.throws(() => capabilities.saveMcp({ name: 'Unbound Local', scope: 'local', transport: 'stdio', command: 'node.exe', args: [] }), /绑定 Project/);
    capabilities.syncProjectMcp(project, 'project:1');
    assert.match(readFileSync(join(project, '.mcp.json'), 'utf8'), /Project MCP/);
    capabilities.deleteMcp(projectServer.id);
    capabilities.syncProjectMcp(project, 'project:1');
    assert.doesNotMatch(readFileSync(join(project, '.mcp.json'), 'utf8'), /Project MCP/);
    capabilities.deleteMcp(server.id);
    capabilities.deleteMcp(otherLocal.id);
    assert.equal(capabilities.listMcp().length, 0);
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); }
});

test('Skills can be imported into .claude/skills and removed without leaving files outside the project', () => {
  const root = mkdtempSync(join(tmpdir(), 'tsukiori-capabilities-skill-'));
  try {
    const project = join(root, 'project'); const source = join(root, 'source');
    mkdirSync(project, { recursive: true }); mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'SKILL.md'), '---\nname: fixture-skill\ndescription: safe fixture\n---\n# Fixture\n', 'utf8');
    writeFileSync(join(source, 'helper.txt'), 'fixture helper\n', 'utf8');
    const capabilities = new WorkspaceCapabilities(join(root, 'user-data'));
    const installed = capabilities.installSkill(project, source);
    assert.equal(installed.name, 'fixture-skill');
    assert.equal(installed.scope, 'project');
    assert.equal(existsSync(join(project, '.claude', 'skills', 'fixture-skill', 'SKILL.md')), true);
    assert.equal(existsSync(join(project, '.claude', 'skills', 'fixture-skill', 'helper.txt')), true);
    assert.equal(capabilities.skillDetail(installed.id, project).content.includes('Fixture'), true);
    capabilities.uninstallSkill(project, installed.name);
    assert.equal(existsSync(join(project, '.claude', 'skills', 'source')), false);
    assert.throws(() => capabilities.uninstallSkill(project, '../project'), /名称|路径/);
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); }
});

test('Memory files are editable only within the project memory allowlist', () => {
  const root = mkdtempSync(join(tmpdir(), 'tsukiori-capabilities-memory-'));
  try {
    const project = join(root, 'project'); mkdirSync(project, { recursive: true });
    const capabilities = new WorkspaceCapabilities(join(root, 'user-data'));
    const saved = capabilities.saveMemory(project, 'MEMORY.md', '# Project Memory\n- keep tests deterministic\n');
    assert.equal(saved.path, 'MEMORY.md');
    assert.match(capabilities.readMemory(project, 'MEMORY.md').content, /deterministic/);
    assert.equal(capabilities.listMemory(project).length, 1);
    mkdirSync(join(project, '.claude', 'memory'), { recursive: true });
    writeFileSync(join(project, '.claude', 'memory', 'notes.md'), 'nested memory\n', 'utf8');
    assert.equal(capabilities.listMemory(project).some((file) => file.path === '.claude/memory/notes.md'), true);
    assert.throws(() => capabilities.readMemory(project, '../workspace-state-v3.json'), /允许范围|路径/);
    assert.throws(() => capabilities.saveMemory(project, 'notes.txt', 'unsafe'), /允许范围/);
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); }
});

test('scheduled tasks persist bounded prompts, support enable/disable, and reject unsafe intervals', () => {
  const root = mkdtempSync(join(tmpdir(), 'tsukiori-capabilities-schedule-'));
  try {
    const capabilities = new WorkspaceCapabilities(root);
    const task = capabilities.saveScheduledTask({ name: 'Daily review', projectId: 'project:1', prompt: 'Review local changes', intervalMinutes: 60 });
    assert.equal(task.enabled, false);
    assert.equal(capabilities.listScheduledTasks('project:1').length, 1);
    assert.equal(capabilities.setScheduledTaskEnabled(task.id, true).enabled, true);
    assert.equal(capabilities.setScheduledTaskEnabled(task.id, false).enabled, false);
    assert.throws(() => capabilities.saveScheduledTask({ name: 'Too fast', projectId: 'project:1', prompt: 'x', intervalMinutes: 1 }), /5–10080/);
    capabilities.deleteScheduledTask(task.id);
    assert.equal(capabilities.listScheduledTasks().length, 0);
    assert.doesNotMatch(readFileSync(join(root, 'scheduled-tasks-v1.json'), 'utf8'), /api[_-]?key|secret|password/i);
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); }
});
