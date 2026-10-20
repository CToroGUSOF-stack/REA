/* oxlint-disable typescript/no-var-requires */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("reaDesktop", {
  chooseTarget: () => ipcRenderer.invoke("choose-target"),
  analyzeTarget: (targetPath) =>
    ipcRenderer.invoke("analyze-target", targetPath),
  chooseRebuildDirectory: () => ipcRenderer.invoke("choose-rebuild-directory"),
  createRebuild: (payload) => ipcRenderer.invoke("create-rebuild", payload),
  openFolder: (folderPath) => ipcRenderer.invoke("open-folder", folderPath),
  getSystemInfo: () => ipcRenderer.invoke("system-info"),
  openDocs: () => ipcRenderer.invoke("open-docs"),
  onAnalysisProgress: (callback) =>
    ipcRenderer.on("analysis-progress", (_event, payload) => callback(payload)),
});
