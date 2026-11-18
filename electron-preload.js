const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('app', {
  enviar: (command) => ipcRenderer.send('cmd', command),
  onLog: (callback) => ipcRenderer.on('log', (_, entry) => callback(entry)),
  onLogsIniciais: (callback) => ipcRenderer.on('logs-iniciais', (_, entries) => callback(entries)),
  onStatus: (callback) => ipcRenderer.on('status', (_, status) => callback(status)),
  onUpdateStatus: (callback) => ipcRenderer.on('update-status', (_, status) => callback(status)),
  baixarAtualizacao: () => ipcRenderer.send('update-download'),
  instalarAtualizacao: () => ipcRenderer.send('update-install'),
});
