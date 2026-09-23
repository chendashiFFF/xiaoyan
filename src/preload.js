const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopPet', {
  getState: () => ipcRenderer.invoke('window:get-state'),
  moveRelative: (dx, dy = 0) => ipcRenderer.invoke('window:move-relative', dx, dy),
  setSize: (width, height) => ipcRenderer.invoke('window:set-size', width, height),
  dragStart: (point) => ipcRenderer.send('window:drag-start', point),
  dragMove: (point) => ipcRenderer.send('window:drag-move', point),
  dragEnd: () => ipcRenderer.send('window:drag-end'),
  setIgnoreMouseEvents: (ignore) => ipcRenderer.send('window:set-ignore-mouse-events', ignore),
  onPlay: (callback) => {
    const listener = (_event, action) => callback(action);
    ipcRenderer.on('pet:play', listener);
    return () => ipcRenderer.removeListener('pet:play', listener);
  },
});
