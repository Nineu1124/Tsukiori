'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const api = Object.freeze({
  versions: () => ipcRenderer.invoke('host:versions'),
  daemon: Object.freeze({
    status: () => ipcRenderer.invoke('daemon:status'),
  }),
  workspace: Object.freeze({
    snapshot: () => ipcRenderer.invoke('workspace:snapshot'),
    stage: (paths) => ipcRenderer.invoke('workspace:command', { type: 'stage', paths }),
    unstage: (paths) => ipcRenderer.invoke('workspace:command', { type: 'unstage', paths }),
    revert: (paths) => ipcRenderer.invoke('workspace:command', { type: 'revert', paths }),
    commit: (subject) => ipcRenderer.invoke('workspace:command', { type: 'commit', subject }),
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
    answerInput: (requestId, answers) => ipcRenderer.invoke(
      'workspace:command', { type: 'answer_input', requestId, answers },
    ),
  }),
});

contextBridge.exposeInMainWorld('tsukiori', api);
