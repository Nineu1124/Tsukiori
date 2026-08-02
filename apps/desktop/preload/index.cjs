'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const api = Object.freeze({
  versions: () => ipcRenderer.invoke('host:versions'),
  daemon: Object.freeze({
    status: () => ipcRenderer.invoke('daemon:status'),
  }),
  workspace: Object.freeze({
    snapshot: () => ipcRenderer.invoke('workspace:snapshot'),
    pickProject: () => ipcRenderer.invoke('workspace:command', { type: 'pick_project' }),
    refreshRuntimes: () => ipcRenderer.invoke('workspace:command', { type: 'refresh_runtimes' }),
    createSession: (projectId, selection) => ipcRenderer.invoke(
      'workspace:command', { type: 'create_session', projectId, ...(selection ?? {}) },
    ),
    updateSessionOptions: (sessionId, selection) => ipcRenderer.invoke(
      'workspace:command', { type: 'update_session_options', sessionId, ...(selection ?? {}) },
    ),
    updateSettings: (settings) => ipcRenderer.invoke(
      'workspace:command', { type: 'update_settings', settings },
    ),
    saveProvider: (provider) => ipcRenderer.invoke(
      'workspace:command', { type: 'save_provider', ...(provider ?? {}) },
    ),
    deleteProvider: (providerId) => ipcRenderer.invoke(
      'workspace:command', { type: 'delete_provider', providerId },
    ),
    testProvider: (providerId) => ipcRenderer.invoke(
      'workspace:command', { type: 'test_provider', providerId },
    ),
    exportSettings: () => ipcRenderer.invoke('workspace:command', { type: 'export_settings' }),
    openWorktree: (sessionId) => ipcRenderer.invoke(
      'workspace:command', { type: 'open_worktree', sessionId },
    ),
    openUrl: (url) => ipcRenderer.invoke('workspace:command', { type: 'open_url', url }),
    sendPrompt: (sessionId, text) => ipcRenderer.invoke(
      'workspace:command', { type: 'send_prompt', sessionId, text },
    ),
    interruptTurn: (sessionId) => ipcRenderer.invoke(
      'workspace:command', { type: 'interrupt_turn', sessionId },
    ),
    gitStatus: (sessionId) => ipcRenderer.invoke(
      'workspace:command', { type: 'git_status', sessionId },
    ),
    gitDiff: (sessionId, path) => ipcRenderer.invoke(
      'workspace:command', { type: 'git_diff', sessionId, path },
    ),
    stage: (sessionIdOrPaths, maybePaths) => ipcRenderer.invoke('workspace:command', {
      type: 'stage',
      ...(Array.isArray(sessionIdOrPaths)
        ? { paths: sessionIdOrPaths }
        : { sessionId: sessionIdOrPaths, paths: maybePaths }),
    }),
    unstage: (sessionIdOrPaths, maybePaths) => ipcRenderer.invoke('workspace:command', {
      type: 'unstage',
      ...(Array.isArray(sessionIdOrPaths)
        ? { paths: sessionIdOrPaths }
        : { sessionId: sessionIdOrPaths, paths: maybePaths }),
    }),
    revert: (paths) => ipcRenderer.invoke('workspace:command', { type: 'revert', paths }),
    commit: (sessionIdOrSubject, maybeSubject) => ipcRenderer.invoke('workspace:command', {
      type: 'commit',
      ...(maybeSubject === undefined
        ? { subject: sessionIdOrSubject }
        : { sessionId: sessionIdOrSubject, subject: maybeSubject }),
    }),
    archive: (cleanup) => ipcRenderer.invoke('workspace:command', { type: 'archive', cleanup }),
    integrate: (sourceSessionId, targetRef, strategy) => ipcRenderer.invoke(
      'workspace:command', { type: 'integrate', sourceSessionId, targetRef, strategy },
    ),
    continueIntegration: (operationId) => ipcRenderer.invoke(
      'workspace:command', { type: 'continue_integration', operationId },
    ),
    openExternalEditor: (operationId) => ipcRenderer.invoke(
      'workspace:command', { type: 'open_external_editor', operationId },
    ),
    decidePermission: (requestId, connectionEpoch, decision) => ipcRenderer.invoke(
      'workspace:command', { type: 'permission', requestId, connectionEpoch, decision },
    ),
    exportDiagnostic: (includeSensitivePreviews) => ipcRenderer.invoke(
      'workspace:command', { type: 'export_diagnostic', includeSensitivePreviews: includeSensitivePreviews === true },
    ),
    answerInput: (requestId, answers) => ipcRenderer.invoke(
      'workspace:command', { type: 'answer_input', requestId, answers },
    ),
    pollEvents: (afterSequence) => ipcRenderer.invoke(
      'workspace:command', { type: 'poll_events', afterSequence },
    ),
  }),
});

contextBridge.exposeInMainWorld('tsukiori', api);
