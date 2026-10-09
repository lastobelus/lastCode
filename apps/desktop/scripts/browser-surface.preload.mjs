import { contextBridge, ipcRenderer } from "electron";
import {
  DESKTOP_BROWSER_SURFACE_REQUEST_CHANNEL,
  DESKTOP_BROWSER_SURFACE_RESPONSE_CHANNEL,
} from "../src/ipc/channels.ts";

contextBridge.exposeInMainWorld("surfaceSmokeBridge", {
  configuration: () => ipcRenderer.invoke("surface-smoke:configuration"),
  registerGuest: (runtimeTabId, webContentsId) =>
    ipcRenderer.invoke("surface-smoke:register-guest", { runtimeTabId, webContentsId }),
  ready: () => ipcRenderer.invoke("surface-smoke:ready"),
  respond: (response) => ipcRenderer.invoke(DESKTOP_BROWSER_SURFACE_RESPONSE_CHANNEL, response),
  onRequest: (listener) => {
    const wrapped = (_event, request) => listener(request);
    ipcRenderer.on(DESKTOP_BROWSER_SURFACE_REQUEST_CHANNEL, wrapped);
    return () => ipcRenderer.removeListener(DESKTOP_BROWSER_SURFACE_REQUEST_CHANNEL, wrapped);
  },
});
