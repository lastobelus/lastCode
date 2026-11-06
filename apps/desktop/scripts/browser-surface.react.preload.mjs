// Keep the production contextBridge and IPC payloads, including renderer lifecycle requests.
import "../src/preload.ts";
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("reactSmokeBridge", {
  configuration: () => ipcRenderer.invoke("react-smoke:configuration"),
  hosting: (operation, input) => ipcRenderer.invoke("react-smoke:hosting", { operation, input }),
  checkpoint: (name) => ipcRenderer.invoke("react-smoke:checkpoint", name),
});
