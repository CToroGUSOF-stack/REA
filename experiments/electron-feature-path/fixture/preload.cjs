/* oxlint-disable typescript/no-var-requires -- The fixture exercises Electron CommonJS main-hook and sandboxed-preload interop. */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("prototype", {
  export: (value) => ipcRenderer.invoke("prototype:export", value),
  flush: () => ipcRenderer.invoke("prototype:flush"),
});
