'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * API mínima que ve el renderer. Todo pasa por IPC; el renderer nunca habla
 * directamente con el pipe.
 */
contextBridge.exposeInMainWorld('mascotAPI', {
  platform: process.platform,
  versions: { shell: require('../package.json').version, protocol: 1 },
  getState: () => ipcRenderer.invoke('mascot:get-state'),
  onMessage: (callback) => {
    const listener = (event, message) => callback(message);
    ipcRenderer.on('mascot:event', listener);
    return () => ipcRenderer.removeListener('mascot:event', listener);
  },
  reportLayout: (layout) => ipcRenderer.send('mascot:renderer-layout', layout),
  setInteractive: (interactive) => ipcRenderer.send('mascot:interactive', Boolean(interactive)),
  quit: () => ipcRenderer.send('mascot:quit'),
});
