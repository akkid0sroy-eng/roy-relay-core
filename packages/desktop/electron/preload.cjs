const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  onDeepLink: (callback) => {
    ipcRenderer.on("deep-link", (_event, url) => callback(url));
  },
  removeDeepLinkListener: () => {
    ipcRenderer.removeAllListeners("deep-link");
  },
});
