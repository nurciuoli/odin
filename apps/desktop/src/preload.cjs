// Sandboxed preload (CommonJS, as sandboxed preloads require). The bridge `window.odinDesktop`
// (OdinDesktop in packages/web/src/app/desktop.ts). Every call goes to a main-process handler that checks the
// sender is the core origin's top frame; arguments are passed through as plain values.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld(
  "odinDesktop",
  Object.freeze({
    platform: process.platform,
    exportArtifactPdf: (id, version) => ipcRenderer.invoke("desktop:exportArtifactPdf", id, version),
    openPath: (path, target) => ipcRenderer.invoke("desktop:openPath", String(path), String(target)),
    getLoginItem: () => ipcRenderer.invoke("desktop:getLoginItem"),
    setLoginItem: (on) => ipcRenderer.invoke("desktop:setLoginItem", on === true),
    shortcutStatus: () => ipcRenderer.invoke("desktop:shortcutStatus"),
    openLog: () => ipcRenderer.invoke("desktop:openLog"),
  }),
);
