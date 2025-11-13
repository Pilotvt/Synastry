import { contextBridge, ipcRenderer } from 'electron';

const netChannel = {
  getStatus: () => ipcRenderer.invoke('net:get-status'),
  onStatusChange: (callback) => {
    if (typeof callback !== 'function') return () => undefined;
    const subscription = (_event, status) => {
      callback(Boolean(status));
    };
    ipcRenderer.on('net:status-changed', subscription);
    return () => {
      ipcRenderer.removeListener('net:status-changed', subscription);
    };
  },
};

const cacheChannel = {
  getImagePath: (key) => ipcRenderer.invoke('cache:get-image-path', key),
  saveImage: (key, payload) => {
    if (!payload) return Promise.resolve(null);
    let data = payload;
    if (payload instanceof ArrayBuffer) {
      data = new Uint8Array(payload);
    }
    if (ArrayBuffer.isView(payload)) {
      data = new Uint8Array(payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength));
    }
    if (!(data instanceof Uint8Array)) {
      return Promise.reject(new TypeError('cache.saveImage expects ArrayBuffer or Uint8Array'));
    }
    return ipcRenderer.invoke('cache:save-image', { key, data: Array.from(data) });
  },
  clear: () => ipcRenderer.invoke('cache:clear'),
};

const mapsChannel = {
  getStatic: (options) => ipcRenderer.invoke('maps:get-static', options),
};

const notifyMainAboutStatus = () => {
  try {
    const status = navigator.onLine;
    ipcRenderer.send('net:renderer-status', status);
  } catch {
    // ignore navigator errors
  }
};

window.addEventListener('online', notifyMainAboutStatus);
window.addEventListener('offline', notifyMainAboutStatus);

notifyMainAboutStatus();

contextBridge.exposeInMainWorld('electronAPI', {
  net: netChannel,
  cache: cacheChannel,
  maps: mapsChannel,
});
