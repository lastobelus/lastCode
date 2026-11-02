// Only application hydration and external-server boundaries are replaced. Never implement
// guest admission, mounting, lifecycle requests, freeze/unload, or activity gating here.
import { useCallback } from "react";
import { create } from "zustand";
import { Atom, AsyncResult } from "effect/reactivity";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import { prepareHostedPreview as prepareOwnedPreview } from "@t3tools/client-runtime/preview-hosting";
import { appAtomRegistry } from "../../web/src/rpc/atomRegistry.ts";

export const primaryEnvironmentIdAtom = Atom.make("fixture-primary");
// Hydration precedes the lazy guest's subscription; retain the fixture server state between them.
export const configAtom = Atom.make(null).pipe(Atom.keepAlive);
export const connectionAtom = Atom.make(AsyncResult.initial()).pipe(Atom.keepAlive);
export const environmentCatalog = { stateAtom: () => connectionAtom };
export const environmentSession = { initialConfigValueAtom: () => configAtom };
export const useActivePreviewSessions = create(() => ({}));
export const fixtureState = { origin: "" };
export const previewEnvironment = { hostingActivity: "activity", open: "open" };

export function setConnectionGeneration(generation) {
  appAtomRegistry.set(connectionAtom, AsyncResult.success({ phase: "connected", generation }));
}
export function setActivityCapability(supported) {
  appAtomRegistry.set(configAtom, {
    environment: { capabilities: supported ? { previewHostingActivity: true } : {} },
  });
}
export const useEnvironmentScope = () => true;
export const useEnvironmentHasLocalDesktopBrowser = () => false;
export const readEnvironmentHasLocalDesktopBrowser = () => false;
export const readEnvironmentSupportsServerBrowser = () => true;
export const useEnvironmentSupportsServerBrowser = () => true;
export const isPreviewSupportedInRuntime = () => true;
export const readPreparedConnection = () => ({ httpBaseUrl: fixtureState.origin });

export function useAtomCommand(operation) {
  return useCallback(
    async (input) => {
      if (operation !== "activity") throw new Error(`Unexpected fixture command: ${operation}`);
      await window.reactSmokeBridge.hosting(operation, input);
      return { _tag: "Success", value: undefined };
    },
    [operation],
  );
}
export function prepareHostedPreview(threadRef, url, purpose) {
  return prepareOwnedPreview({
    threadRef,
    url,
    purpose,
    environmentUrl: fixtureState.origin,
    list: () => window.reactSmokeBridge.hosting("list", { threadRef, url }),
    recover: (lease, options) => window.reactSmokeBridge.hosting("recover", { lease, options }),
  });
}

export const useClientSettingsHydrated = () => true;
export const getClientSettings = () => DEFAULT_CLIENT_SETTINGS;
export const ensureClientSettingsHydrated = async () => {};
export const useClientSettings = (select) => select(DEFAULT_CLIENT_SETTINGS);
export const useDesktopHostedPreviewSessions = () => {};
export const useDesktopBrowserSessions = () => {};
export const usePreviewBridge = () => {};
export const DesktopCdpRelay = () => null;
export const BrowserDeviceToolbar = () => null;
const noRecordings = new Set();
export const useActiveBrowserRecordingTabIds = () => noRecordings;
export const stopBrowserRecording = async () => null;
export const openUrlInPreview = async () => {
  throw new Error("Unexpected fixture link open");
};
export const randomUUID = () => crypto.randomUUID();
export const cn = (...parts) => parts.filter((part) => typeof part === "string").join(" ");
export const isMacPlatform = (platform) => /mac|darwin/i.test(platform);
export const toastManager = {
  add: (toast) => {
    throw new Error(`React host reported a failure: ${toast.title}: ${toast.description}`);
  },
};
