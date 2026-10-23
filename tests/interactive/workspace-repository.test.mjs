import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { historyFixture } from './history-fixture.mjs';
import { InteractiveWorkspace } from '../../apps/desktop/dist/electron-main/interactive-workspace.js';

test('formal project and session operations use the supplied repository through restart', async (t) => {
  let saved;
  let writes = 0;
  const stateRepository = {
    read: () => saved ? { value: structuredClone(saved) } : {},
    save: (state) => { writes++; saved = structuredClone(state); },
  };
  const f = await historyFixture(t, { stateRepository });
  f.workspace.renameSession(f.session.id, '保留会话名称');
  f.workspace.pinProject(f.session.projectId, true);
  assert.ok(writes >= 4);
  assert.equal(existsSync(join(f.userDataPath, 'workspace-state-v3.json')), false);
  await f.workspace.shutdown();
  const reopened = f.open().snapshot();
  assert.equal(reopened.sessions[0].name, '保留会话名称');
  assert.equal(reopened.sessions[0].threadId, f.session.threadId);
  assert.equal(reopened.projects[0].pinned, true);
  assert.equal(saved.sessions[0].projectId, saved.projects[0].id);
});

test('a repository read failure cannot initialize or save an empty workspace', (t) => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'tsukiori-repository-failure-'));
  t.after(() => rmSync(userDataPath, { recursive: true, force: true }));
  let writes = 0;
  assert.throws(() => new InteractiveWorkspace({ userDataPath, emit() {}, stateRepository: {
    read() { throw new Error('fixture read failure'); }, save() { writes++; },
  } }), /fixture read failure/);
  assert.equal(writes, 0);
  assert.equal(existsSync(join(userDataPath, 'workspace-state-v3.json')), false);
});
