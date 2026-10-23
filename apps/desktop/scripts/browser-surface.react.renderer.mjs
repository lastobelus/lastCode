import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { ElectronBrowserHost } from "../../web/src/browser/ElectronBrowserHost.tsx";
import { AppAtomRegistryProvider, appAtomRegistry } from "../../web/src/rpc/atomRegistry.ts";
import {
  acquireBrowserSurfaceActivity,
  useBrowserSurfaceStore,
} from "../../web/src/browser/browserSurfaceStore.ts";
import { ensureDesktopBrowserTab } from "../../web/src/browser/desktopBrowserDemand.ts";
import { previewRuntimeTabId } from "../../web/src/browser/previewRuntimeTabId.ts";
import { getDesktopBrowserHostId } from "../../web/src/browser/desktopBrowserTransport.ts";
import {
  fixtureState,
  configAtom,
  connectionAtom,
  useActivePreviewSessions,
  setActivityCapability,
  setConnectionGeneration,
} from "./browser-surface.react-state.fixture.mjs";

async function main() {
  const { origin, pageLimit } = await window.reactSmokeBridge.configuration();
  fixtureState.origin = origin;
  const threadRef = { environmentId: "fixture-remote", threadId: "fixture-thread" };
  const desktopHostId = getDesktopBrowserHostId(threadRef.environmentId);
  await window.desktopBridge.preview.bindBrowserEnvironment({
    desktopHostId,
    environmentId: threadRef.environmentId,
  });
  const sessions = Object.fromEntries(
    Array.from({ length: pageLimit + 1 }, (_, index) => {
      const tabId = `react-tab-${index.toString().padStart(2, "0")}`;
      return [
        tabId,
        {
          threadId: threadRef.threadId,
          tabId,
          runtime: "desktop",
          profileId: "default",
          navStatus: { _tag: "Success", url: `${origin}/${tabId}`, title: tabId },
          canGoBack: false,
          canGoForward: false,
          viewport: { _tag: "fill" },
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ];
    }),
  );
  useActivePreviewSessions.setState(
    {
      [scopedThreadKey(threadRef)]: { sessions, serverEpoch: "fixture-epoch", desktopByTabId: {} },
    },
    true,
  );
  const ids = Object.keys(sessions);
  const runtimeId = (index) => previewRuntimeTabId(threadRef, "fixture-epoch", ids[index]);
  const releases = new Map();
  setConnectionGeneration(1);
  setActivityCapability(false);
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  root.render(createElement(AppAtomRegistryProvider, null, createElement(ElectronBrowserHost)));
  window.reactSmoke = {
    ids,
    desktopHostId,
    runtimeId,
    demand: async (index) => {
      if (!releases.has(index))
        releases.set(index, acquireBrowserSurfaceActivity(runtimeId(index)));
      await ensureDesktopBrowserTab(runtimeId(index));
    },
    hide: (index) => {
      releases.get(index)?.();
      releases.delete(index);
    },
    generation: setConnectionGeneration,
    activityCapability: setActivityCapability,
    checkpoint: (name) => window.reactSmokeBridge.checkpoint(name),
    diagnostics: () => ({
      connection: appAtomRegistry.get(connectionAtom),
      config: appAtomRegistry.get(configAtom),
      hostMounted: document.querySelector("[data-electron-browser-host]") !== null,
      activities: useBrowserSurfaceStore.getState().activityByTabId,
      guests: [...document.querySelectorAll("webview")].map((guest) => {
        let contents;
        try {
          contents = guest.getWebContentsId();
        } catch (cause) {
          contents = String(cause);
        }
        return {
          tabId: guest.getAttribute("data-preview-server-tab"),
          runtimeTabId: guest.getAttribute("data-preview-tab"),
          src: guest.getAttribute("src"),
          partition: guest.getAttribute("partition"),
          contents,
        };
      }),
    }),
    dispose: () => {
      for (const release of releases.values()) release();
      root.unmount();
    },
  };
  await window.reactSmokeBridge.checkpoint("ready");
}
void main().catch((cause) => {
  console.error(cause);
  throw cause;
});
