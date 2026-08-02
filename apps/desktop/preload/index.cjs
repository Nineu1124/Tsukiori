'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const api = Object.freeze({
  versions: () => ipcRenderer.invoke('host:versions'),
  daemon: Object.freeze({
    status: () => ipcRenderer.invoke('daemon:status'),
  }),
});

contextBridge.exposeInMainWorld('tsukiori', api);
