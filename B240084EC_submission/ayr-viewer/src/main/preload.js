/*
 * Preload: the ONLY bridge between the page and the main process.
 * The page gets window.ayr with these functions and nothing else - no ipcRenderer,
 * no Node APIs, no way to name a file or a program to run.
 */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ayr', {
  openCase: () => ipcRenderer.invoke('case:open'),
  confirmCase: token => ipcRenderer.invoke('case:confirm', Number(token)),
  rejectCase: token => ipcRenderer.invoke('case:reject', Number(token)),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  detectPython: () => ipcRenderer.invoke('python:detect'),
  browsePython: () => ipcRenderer.invoke('python:browse'),
  browseSolver: () => ipcRenderer.invoke('solver:browse'),
  runSolver: failAt => ipcRenderer.invoke('solver:run', { failAt: failAt === null || failAt === undefined ? null : String(failAt) }),
  cancelSolver: () => ipcRenderer.invoke('solver:cancel'),
  onSolverEvent: callback => {
    // Pass only the data, never the IpcRendererEvent (it would expose ipcRenderer via event.sender).
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('solver:event', listener);
    return () => ipcRenderer.removeListener('solver:event', listener);
  },
});
