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
    commit: (subject) => ipcRenderer.invoke('workspace:command', { type: 'commit', subject }),
    archive: (cleanup) => ipcRenderer.invoke('workspace:command', { type: 'archive', cleanup }),
    decidePermission: (requestId, connectionEpoch, decision) => ipcRenderer.invoke(
      'workspace:command', { type: 'permission', requestId, connectionEpoch, decision },
    ),
    answerInput: (requestId, answers) => ipcRenderer.invoke(
      'workspace:command', { type: 'answer_input', requestId, answers },
    ),
  }),
});

contextBridge.exposeInMainWorld('tsukiori', api);
