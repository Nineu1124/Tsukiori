import assert from 'node:assert/strict';

export function runAdapterContract(adapter) {
  assert.equal(adapter.eventReaderCount, 1);
  const sessions = [adapter.createSession(), adapter.createSession(), adapter.createSession()];
  for (const [index, session] of sessions.entries()) {
    adapter.runScript(session, [
      { kind: 'event', nativeType: 'message.started', payload: { index } },
      { kind: 'event', nativeType: 'text.delta', payload: { text: 'chunk-' + index } },
      { kind: 'event', nativeType: 'tool.started', payload: { toolCallId: 'tool-' + index, toolName: 'fixture' } },
      { kind: 'event', nativeType: 'tool.completed', payload: { toolCallId: 'tool-' + index } },
      { kind: 'event', nativeType: 'user_input.requested', payload: { requestId: 'input-' + index } },
      { kind: 'event', nativeType: 'message.completed', payload: { index } },
    ]);
  }
  const sessionEvents = adapter.events.filter(({ sessionId }) => sessionId);
  assert.equal(new Set(sessionEvents.map(({ sessionId }) => sessionId)).size, 3);
  for (const session of sessions) {
    const own = sessionEvents.filter(({ sessionId }) => sessionId === session.runtimeSessionId);
    assert.deepEqual(own.map(({ type }) => type), [
      'assistant.message_started', 'assistant.text_delta', 'tool.started',
      'tool.completed', 'user_input.requested', 'assistant.message_completed',
    ]);
    assert.deepEqual(own.map(({ sessionSequence }) => sessionSequence), [1, 2, 3, 4, 5, 6]);
  }
  return { sessions, sessionEvents };
}