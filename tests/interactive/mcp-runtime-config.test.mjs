import assert from 'node:assert/strict';
import test from 'node:test';
import { codexMcpArgs, codexMcpName } from '../../apps/desktop/dist/electron-main/mcp-runtime-config.js';
import { codexHistoryFixture } from './codex-history-fixture.mjs';

test('Codex launch receives namespaced overrides and environment names only', async (t) => {
  const f = await codexHistoryFixture(t);
  const server = f.workspace.saveMcp({ name: '有空格的 MCP', scope: 'project', projectId: f.session.projectId,
    transport: 'stdio', command: 'C:\\Program Files\\node.exe', args: ['quoted "argument"'], envKeys: ['MCP_LOCAL_TOKEN'] });
  const turn = await f.workspace.sendPrompt(f.session.id, 'fixture mcp');
  f.clients.at(-1).complete(turn.turnId);
  const args = f.clients.at(-1).options.configArgs;
  const name = codexMcpName(server);
  assert.match(name, /^tsukiori_[a-f0-9]{24}$/);
  assert.ok(args.includes(`mcp_servers.${name}.command="C:\\\\Program Files\\\\node.exe"`));
  assert.ok(args.includes(`mcp_servers.${name}.args=["quoted \\"argument\\""]`));
  assert.ok(args.includes(`mcp_servers.${name}.env_vars=["MCP_LOCAL_TOKEN"]`));
  assert.equal(args.some((arg) => arg.startsWith('mcp_servers=')), false);
  const http = { ...server, transport: 'http', url: 'https://example.test/mcp' };
  assert.deepEqual(codexMcpArgs([http]), ['-c', `mcp_servers.${name}.url="https://example.test/mcp"`]);
  assert.deepEqual(codexMcpArgs([{ ...http, enabled: false }]), []);
  assert.throws(() => codexMcpArgs([{ ...server, transport: 'sse' }]), /未验证 SSE/);
});
