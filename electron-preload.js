const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('app', {
  enviar: (command) => ipcRenderer.send('cmd', command),
  login: (email, password) => ipcRenderer.invoke('login', { email, password }),
  onLog: (callback) => ipcRenderer.on('log', (_, entry) => callback(entry)),
  onLogsIniciais: (callback) => ipcRenderer.on('logs-iniciais', (_, entries) => callback(entries)),
  onStatus: (callback) => ipcRenderer.on('status', (_, status) => callback(status)),
  onFbStatus: (callback) => ipcRenderer.on('fb-status', (_, contas) => callback(contas)),
  onBloqueio: (callback) => ipcRenderer.on('bloqueio', (_, info) => callback(info)),
  onUpdate: (callback) => ipcRenderer.on('update', (_, estado) => callback(estado)),
  onSessao: (callback) => ipcRenderer.on('sessao', (_, sessao) => callback(sessao)),
});
