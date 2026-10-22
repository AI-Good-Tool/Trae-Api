const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld(
  'desktopUpdates',
  Object.freeze({
    state: () => ipcRenderer.invoke('app-update', 'state'),
    check: () => ipcRenderer.invoke('app-update', 'check'),
    download: () => ipcRenderer.invoke('app-update', 'download'),
    cancel: () => ipcRenderer.invoke('app-update', 'cancel'),
    install: () => ipcRenderer.invoke('app-update', 'install'),
    onChange: (callback) => {
      const listener = (_event, value) => callback(value);
      ipcRenderer.on('app-update-state', listener);
      return () => ipcRenderer.removeListener('app-update-state', listener);
    },
  }),
);
