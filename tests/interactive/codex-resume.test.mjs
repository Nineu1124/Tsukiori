import assert from 'node:assert/strict';
import test from 'node:test';
import { codexHistoryFixture } from './codex-history-fixture.mjs';

test('new Codex clients resume persisted threads before the next turn', async (t) => {
  const f = await codexHistoryFixture(t);
  const first = await f.workspace.sendPrompt(f.session.id, 'first fixture');
  f.clients[0].complete(first.turnId);
  await f.workspace.shutdown();
  const restarted = f.open();
  const second = await restarted.sendPrompt(f.session.id, 'second fixture');
  assert.deepEqual(f.calls.filter((call) => call[0] === 1).map((call) => call[1]), ['initialize', 'thread/resume', 'turn/start']);
  assert.equal(f.calls.find((call) => call[0] === 1 && call[1] === 'thread/resume')[2], 'thread:fixture');
  assert.equal(restarted.snapshot().sessions.find((s) => s.id === f.session.id).threadId, 'thread:fixture');
  f.clients[1].complete(second.turnId);
});

for (const reason of ['rejection', 'identity mismatch']) {
  test(`a Codex resume ${reason} never starts a turn or replaces the saved thread`, async (t) => {
    const f = await codexHistoryFixture(t);
    const first = await f.workspace.sendPrompt(f.session.id, 'first fixture');
    f.clients[0].complete(first.turnId);
    await f.workspace.shutdown();
    f.control.resume = () => {
      if (reason === 'rejection') throw new Error('private-resume-failure');
      return 'wrong-thread';
    };
    const restarted = f.open();
    await assert.rejects(restarted.sendPrompt(f.session.id, 'second fixture'), /Runtime 执行失败/);
    assert.deepEqual(f.calls.filter((call) => call[0] === 1).map((call) => call[1]), ['initialize', 'thread/resume', 'stop']);
    const session = restarted.snapshot().sessions.find((s) => s.id === f.session.id);
    assert.equal(session.threadId, 'thread:fixture');
    assert.equal(session.turnCount, 1);
    assert.equal(session.status, 'error');
    assert.doesNotMatch(JSON.stringify(f.emitted), /private-resume-failure/);
  });
}
