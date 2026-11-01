import "../src/preload.ts";
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("openLinkFixtureBridge", {
  configuration: () => ipcRenderer.invoke("open-link-fixture:configuration"),
  hosting: (operation, input) =>
    ipcRenderer.invoke("open-link-fixture:hosting", { operation, input }),
  open: (input) => ipcRenderer.invoke("open-link-fixture:open", input),
  report: (report) => ipcRenderer.invoke("open-link-fixture:report", report),
});
