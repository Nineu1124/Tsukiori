import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WorkspaceCapabilities } from '../../apps/desktop/dist/electron-main/workspace-capabilities.js';

export function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'tsukiori-mcp-'));
  const project = join(root, 'project');
  const data = join(root, 'data');
  mkdirSync(project);
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }));
  return { root, project, data, config: join(project, '.mcp.json'), capabilities: new WorkspaceCapabilities(data) };
}
const input = { name: 'managed', scope: 'project', projectId: 'project:fixture', transport: 'stdio', command: 'node', args: [] };

test('unmanaged same-name servers are not adopted or replaced', (t) => {
  const f = fixture(t);
  const original = JSON.stringify({ mcpServers: { managed: { command: 'independent' } } });
  writeFileSync(f.config, original);
  f.capabilities.saveMcp(input);
  assert.throws(() => f.capabilities.syncProjectMcp(f.project, input.projectId), /冲突/);
  assert.equal(readFileSync(f.config, 'utf8'), original);
});

test('external edits prevent update and deletion of a formerly managed entry', (t) => {
  const f = fixture(t);
  const record = f.capabilities.saveMcp(input);
  f.capabilities.syncProjectMcp(f.project, input.projectId);
  const changed = JSON.stringify({ mcpServers: { managed: { command: 'external-edit' } } });
  writeFileSync(f.config, changed);
  assert.throws(() => f.capabilities.syncProjectMcp(f.project, input.projectId), /外部修改/);
  f.capabilities.deleteMcp(record.id);
  assert.throws(() => f.capabilities.syncProjectMcp(f.project, input.projectId), /外部修改/);
  assert.equal(readFileSync(f.config, 'utf8'), changed);
});

test('duplicate effective names and nonexistent update IDs are rejected', (t) => {
  const f = fixture(t);
  f.capabilities.saveMcp(input);
  assert.throws(() => f.capabilities.saveMcp(input), /重复/);
  assert.throws(() => f.capabilities.saveMcp({ ...input, scope: 'user' }), /重复/);
  assert.throws(() => f.capabilities.saveMcp({ ...input, id: 'missing' }), /不存在/);
  assert.doesNotThrow(() => f.capabilities.saveMcp({ ...input, projectId: 'other-project' }));
});

test('renaming a managed entry removes only its previous name', (t) => {
  const f = fixture(t);
  writeFileSync(f.config, '{"mcpServers":{"independent":{"command":"keep"}}}');
  const record = f.capabilities.saveMcp(input);
  f.capabilities.syncProjectMcp(f.project, input.projectId);
  f.capabilities.saveMcp({ ...record, name: 'renamed' });
  f.capabilities.syncProjectMcp(f.project, input.projectId);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(f.config)).mcpServers).sort(), ['independent', 'renamed']);
});

test('MCP additions and removal preserve independent servers and unrelated settings after restart', (t) => {
  const f = fixture(t);
  const independent = { type: 'http', url: 'https://example.invalid/mcp', custom: { fixture: true } };
  writeFileSync(f.config, JSON.stringify({ custom: ['keep'], mcpServers: { independent } }));
  const managed = f.capabilities.saveMcp(input);
  f.capabilities.syncProjectMcp(f.project, input.projectId);
  let value = JSON.parse(readFileSync(f.config));
  assert.deepEqual(value.mcpServers.independent, independent);
  assert.deepEqual(value.custom, ['keep']);
  assert.equal(value.mcpServers.managed.command, 'node');
  const restarted = new WorkspaceCapabilities(f.data);
  restarted.deleteMcp(managed.id);
  restarted.syncProjectMcp(f.project, input.projectId);
  value = JSON.parse(readFileSync(f.config));
  assert.deepEqual(value.mcpServers, { independent });
});

for (const malformed of ['{', 'null', '[]', '{"mcpServers":[]}']) {
  test(`invalid MCP input is preserved: ${malformed}`, (t) => {
    const f = fixture(t);
    writeFileSync(f.config, malformed);
    f.capabilities.saveMcp(input);
    assert.throws(() => f.capabilities.syncProjectMcp(f.project, input.projectId), /MCP/);
    assert.equal(readFileSync(f.config, 'utf8'), malformed);
  });
}
