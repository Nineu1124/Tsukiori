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
    pickCcHahaSource: () => ipcRenderer.invoke('workspace:command', { type: 'pick_cc_haha_source' }),
    scanCcHahaImport: (sourcePath) => ipcRenderer.invoke('workspace:command', { type: 'scan_cc_haha_import', sourcePath }),
    importCcHaha: (sourcePath, sourceFingerprint, candidateIds) => ipcRenderer.invoke(
      'workspace:command', { type: 'import_cc_haha', sourcePath, sourceFingerprint, candidateIds },
    ),
    removeProject: (projectId) => ipcRenderer.invoke('workspace:command', { type: 'remove_project', projectId }),
    pinProject: (projectId, pinned) => ipcRenderer.invoke('workspace:command', { type: 'pin_project', projectId, pinned: pinned === true }),
    refreshRuntimes: () => ipcRenderer.invoke('workspace:command', { type: 'refresh_runtimes' }),
    createSession: (projectId, selection) => ipcRenderer.invoke(
      'workspace:command', { type: 'create_session', projectId, ...(selection ?? {}) },
    ),
    forkSession: (sessionId) => ipcRenderer.invoke('workspace:command', { type: 'fork_session', sessionId }),
    searchSessions: (projectId, query) => ipcRenderer.invoke('workspace:command', { type: 'search_sessions', projectId, query }),
    updateSessionOptions: (sessionId, selection) => ipcRenderer.invoke(
      'workspace:command', { type: 'update_session_options', sessionId, ...(selection ?? {}) },
    ),
    renameSession: (sessionId, name) => ipcRenderer.invoke('workspace:command', { type: 'rename_session', sessionId, name }),
    pinSession: (sessionId, pinned) => ipcRenderer.invoke('workspace:command', { type: 'pin_session', sessionId, pinned: pinned === true }),
    archiveSession: (sessionId) => ipcRenderer.invoke('workspace:command', { type: 'archive_session', sessionId }),
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
    listProviderModels: (providerId) => ipcRenderer.invoke(
      'workspace:command', { type: 'list_provider_models', providerId },
    ),
    listMcp: (projectId) => ipcRenderer.invoke('workspace:command', { type: 'list_mcp', projectId }),
    saveMcp: (server) => ipcRenderer.invoke('workspace:command', { type: 'save_mcp', ...(server ?? {}) }),
    deleteMcp: (id) => ipcRenderer.invoke('workspace:command', { type: 'delete_mcp', id }),
    listSkills: (projectId) => ipcRenderer.invoke('workspace:command', { type: 'list_skills', projectId }),
    skillDetail: (projectId, id) => ipcRenderer.invoke('workspace:command', { type: 'skill_detail', projectId, id }),
    pickSkillSource: () => ipcRenderer.invoke('workspace:command', { type: 'pick_skill_source' }),
    installSkill: (projectId, sourcePath, name) => ipcRenderer.invoke('workspace:command', { type: 'install_skill', projectId, sourcePath, name }),
    uninstallSkill: (projectId, name) => ipcRenderer.invoke('workspace:command', { type: 'uninstall_skill', projectId, name }),
    listMemory: (projectId) => ipcRenderer.invoke('workspace:command', { type: 'list_memory', projectId }),
    readMemory: (projectId, path) => ipcRenderer.invoke('workspace:command', { type: 'read_memory', projectId, path }),
    saveMemory: (projectId, path, content) => ipcRenderer.invoke('workspace:command', { type: 'save_memory', projectId, path, content }),
    activity: (sessionId) => ipcRenderer.invoke('workspace:command', { type: 'activity', sessionId }),
    stopBackgroundTask: (taskId) => ipcRenderer.invoke('workspace:command', { type: 'stop_background_task', taskId }),
    listScheduledTasks: (projectId) => ipcRenderer.invoke('workspace:command', { type: 'list_scheduled_tasks', projectId }),
    saveScheduledTask: (task) => ipcRenderer.invoke('workspace:command', { type: 'save_scheduled_task', ...(task ?? {}) }),
    setScheduledTaskEnabled: (id, enabled) => ipcRenderer.invoke('workspace:command', { type: 'set_scheduled_task_enabled', id, enabled: enabled === true }),
    deleteScheduledTask: (id) => ipcRenderer.invoke('workspace:command', { type: 'delete_scheduled_task', id }),
    runScheduledTask: (id) => ipcRenderer.invoke('workspace:command', { type: 'run_scheduled_task', id }),
    diagnosticSummary: () => ipcRenderer.invoke('workspace:command', { type: 'diagnostic_summary' }),
    exportSettings: () => ipcRenderer.invoke('workspace:command', { type: 'export_settings' }),
    openWorktree: (sessionId) => ipcRenderer.invoke(
      'workspace:command', { type: 'open_worktree', sessionId },
    ),
    listFiles: (sessionId, query) => ipcRenderer.invoke('workspace:command', { type: 'list_files', sessionId, query }),
    readFile: (sessionId, path) => ipcRenderer.invoke('workspace:command', { type: 'read_file', sessionId, path }),
    pickAttachments: (sessionId) => ipcRenderer.invoke('workspace:command', { type: 'pick_attachments', sessionId }),
    codexNative: (sessionId) => ipcRenderer.invoke('workspace:command', { type: 'codex_native', sessionId }),
    extensionHealth: (sessionId) => ipcRenderer.invoke('workspace:command', { type: 'extension_health', sessionId }),
    githubStatus: (projectId) => ipcRenderer.invoke('workspace:command', { type: 'github_status', projectId }),
    checkUpdates: () => ipcRenderer.invoke('workspace:command', { type: 'check_updates' }),
    createTeam: (projectId, goal, agents) => ipcRenderer.invoke('workspace:command', { type: 'create_team', projectId, goal, agents }),
    sendTeamMessage: (teamId, text, sessionIds) => ipcRenderer.invoke('workspace:command', { type: 'team_message', teamId, text, sessionIds }),
    retryTeamMember: (teamId, sessionId) => ipcRenderer.invoke('workspace:command', { type: 'team_retry_member', teamId, sessionId }),
    stopTeam: (teamId) => ipcRenderer.invoke('workspace:command', { type: 'team_stop', teamId }),
    synthesizeTeam: (teamId, coordinatorSessionId) => ipcRenderer.invoke('workspace:command', { type: 'team_synthesize', teamId, coordinatorSessionId }),
    startTerminal: (sessionId, columns, rows) => ipcRenderer.invoke('workspace:command', { type: 'terminal_start', sessionId, columns, rows }),
    terminalInput: (sessionId, data) => ipcRenderer.invoke('workspace:command', { type: 'terminal_input', sessionId, data }),
    resizeTerminal: (sessionId, columns, rows) => ipcRenderer.invoke('workspace:command', { type: 'terminal_resize', sessionId, columns, rows }),
    stopTerminal: (sessionId) => ipcRenderer.invoke('workspace:command', { type: 'terminal_stop', sessionId }),
    copyText: (text) => ipcRenderer.invoke('workspace:command', { type: 'copy_text', text }),
    openUrl: (url) => ipcRenderer.invoke('workspace:command', { type: 'open_url', url }),
    sendPrompt: (sessionId, text) => ipcRenderer.invoke(
      'workspace:command', { type: 'send_prompt', sessionId, text },
    ),
    interruptTurn: (sessionId) => ipcRenderer.invoke(
      'workspace:command', { type: 'interrupt_turn', sessionId },
    ),
    listCheckpoints: (sessionId) => ipcRenderer.invoke('workspace:command', { type: 'list_checkpoints', sessionId }),
    createCheckpoint: (sessionId, label) => ipcRenderer.invoke('workspace:command', { type: 'create_checkpoint', sessionId, label }),
    previewCheckpoint: (sessionId, checkpointId) => ipcRenderer.invoke('workspace:command', { type: 'preview_checkpoint', sessionId, checkpointId }),
    rewindCheckpoint: (sessionId, checkpointId) => ipcRenderer.invoke('workspace:command', { type: 'rewind_checkpoint', sessionId, checkpointId }),
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
    computerUseStatus: () => ipcRenderer.invoke('workspace:command', { type: 'computer_use_status' }),
    computerUseForeground: () => ipcRenderer.invoke('workspace:command', { type: 'computer_use_foreground' }),
    computerUseAcquire: (sessionId) => ipcRenderer.invoke('workspace:command', { type: 'computer_use_acquire', sessionId }),
    computerUseRelease: () => ipcRenderer.invoke('workspace:command', { type: 'computer_use_release' }),
    computerUseRequest: (action) => ipcRenderer.invoke('workspace:command', { type: 'computer_use_request', action }),
    computerUseApprove: (approvalId) => ipcRenderer.invoke('workspace:command', { type: 'computer_use_approve', approvalId }),
  }),
});

contextBridge.exposeInMainWorld('tsukiori', api);
