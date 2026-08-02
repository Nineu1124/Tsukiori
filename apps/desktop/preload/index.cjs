'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const api = Object.freeze({
  versions: () => ipcRenderer.invoke('host:versions'),
  daemon: Object.freeze({
    status: () => ipcRenderer.invoke('daemon:status'),
  }),
  workspace: Object.freeze({
    snapshot: () => ipcRenderer.invoke('workspace:snapshot'),
  }),
});

contextBridge.exposeInMainWorld('tsukiori', api);
