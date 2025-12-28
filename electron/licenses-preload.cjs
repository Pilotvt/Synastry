const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("licensesAPI", {
  getNotices: async () => {
    return ipcRenderer.invoke("licenses:get-notices");
  },
});
