const { contextBridge, ipcRenderer } = require('electron');

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

const licenseChannel = {
  getStatus: () => ipcRenderer.invoke('license:get-status'),
  activate: (key) => ipcRenderer.invoke('license:activate', key),
  requestPrompt: () => ipcRenderer.invoke('license:prompt'),
  purchase: () => ipcRenderer.invoke('license:purchase'),
  setIdentity: (identity) => ipcRenderer.invoke('license:set-identity', identity ?? null),
  getStoredKey: () => ipcRenderer.invoke('license:get-stored-key'),
  onStatus: (callback) => {
    if (typeof callback !== 'function') return () => undefined;
    const subscription = (_event, status) => {
      callback(status);
    };
    ipcRenderer.on('license:status', subscription);
    return () => {
      ipcRenderer.removeListener('license:status', subscription);
    };
  },
  onPrompt: (callback) => {
    if (typeof callback !== 'function') return () => undefined;
    const subscription = () => {
      callback();
    };
    ipcRenderer.on('license:prompt-input', subscription);
    return () => {
      ipcRenderer.removeListener('license:prompt-input', subscription);
    };
  },
  onTrialWarning: (callback) => {
    if (typeof callback !== 'function') return () => undefined;
    const subscription = (_event, status) => {
      callback(status);
    };
    ipcRenderer.on('license:show-trial-warning', subscription);
    return () => {
      ipcRenderer.removeListener('license:show-trial-warning', subscription);
    };
  },
};

const chatChannel = {
  open: (payload) => {
    if (!payload || typeof payload !== 'string') return Promise.resolve();
    return ipcRenderer.invoke('chat:open', payload);
  },
};

const blocklistChannel = {
  open: () => ipcRenderer.invoke('blocklist:open'),
};

const authChannel = {
  getPending: () => ipcRenderer.invoke('auth:get-pending'),
  acknowledge: () => ipcRenderer.invoke('auth:acknowledge'),
  onDeepLink: (callback) => {
    if (typeof callback !== 'function') return () => undefined;
    const handler = (_event, payload) => {
      callback(payload);
    };
    ipcRenderer.on('auth:deep-link', handler);
    return () => ipcRenderer.removeListener('auth:deep-link', handler);
  },
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
  license: licenseChannel,
  auth: authChannel,
  chat: chatChannel,
  blocklist: blocklistChannel,
  navigation: {
    onOpenApp: (callback) => {
      if (typeof callback !== 'function') return () => undefined;
      const handler = () => {
        callback();
      };
      ipcRenderer.on('navigation:open-app', handler);
      return () => ipcRenderer.removeListener('navigation:open-app', handler);
    },
    onLogout: (callback) => {
      if (typeof callback !== 'function') return () => undefined;
      const handler = () => {
        callback();
      };
      ipcRenderer.on('navigation:logout', handler);
      return () => ipcRenderer.removeListener('navigation:logout', handler);
    },
    onOpenSettings: (callback) => {
      if (typeof callback !== 'function') return () => undefined;
      const handler = () => {
        callback();
      };
      ipcRenderer.on('navigation:open-settings', handler);
      return () => ipcRenderer.removeListener('navigation:open-settings', handler);
    },
    onChangePassword: (callback) => {
      if (typeof callback !== 'function') return () => undefined;
      const handler = () => {
        callback();
      };
      ipcRenderer.on('navigation:change-password', handler);
      return () => ipcRenderer.removeListener('navigation:change-password', handler);
    },
  },
});
