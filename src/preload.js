const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("launcher", {
  getState: () => ipcRenderer.invoke("launcher:getState"),
  check: (options) => ipcRenderer.invoke("launcher:check", options),
  repair: () => ipcRenderer.invoke("launcher:repair"),
  play: () => ipcRenderer.invoke("launcher:play"),
  ping: () => ipcRenderer.invoke("launcher:ping"),
  getSettings: () => ipcRenderer.invoke("launcher:getSettings"),
  saveSettings: (settings) => ipcRenderer.invoke("launcher:saveSettings", settings),
  minimize: () => ipcRenderer.invoke("window:minimize"),
  close: () => ipcRenderer.invoke("window:close"),
  startWindowDrag: (point) => ipcRenderer.invoke("window:startDrag", point),
  moveWindowDrag: (point) => ipcRenderer.invoke("window:dragMove", point),
  endWindowDrag: () => ipcRenderer.invoke("window:endDrag"),
  onStatus: (callback) => ipcRenderer.on("launcher:status", (_event, value) => callback(value)),
  onProgress: (callback) => ipcRenderer.on("launcher:progress", (_event, value) => callback(value))
});
