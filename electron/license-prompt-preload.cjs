const { contextBridge, ipcRenderer } = require('electron');

const api = {
  activate: (key) => ipcRenderer.invoke('license:activate', key),
  getStatus: () => ipcRenderer.invoke('license:get-status'),
  close: () => ipcRenderer.send('license-prompt:close'),
  onStatus: (callback) => {
    if (typeof callback !== 'function') {
      return () => undefined;
    }
    const listener = (_event, status) => {
      callback(status);
    };
    ipcRenderer.on('license:status', listener);
    return () => {
      ipcRenderer.removeListener('license:status', listener);
    };
  },
};

contextBridge.exposeInMainWorld('licensePrompt', api);
