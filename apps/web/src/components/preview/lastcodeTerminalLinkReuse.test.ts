import type { PreviewSessionSnapshot, ScopedThreadRef } from "@t3tools/contracts";
import type { PreparedHostedPreview } from "@t3tools/client-runtime/preview-hosting";
import { AsyncResult } from "effect/reactivity";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

vi.mock("./previewHostingRecovery", () => ({
  prepareHostedPreview: async (_ref: unknown, url: string): Promise<PreparedHostedPreview> => ({
    url,
    managed: false,
    restored: false,
  }),
  mayBeHostedPreviewUrl: () => true,
}));
vi.mock("~/state/entities", () => ({
  readEnvironmentSupportsServerBrowser: () => true,
  readEnvironmentHasLocalDesktopBrowser: () => true,
  useEnvironmentSupportsServerBrowser: () => true,
}));
vi.mock("~/browser/previewRuntime", () => ({
  isPreviewAvailableFor: () => true,
  previewRuntimeFor: () => "server",
  desktopBrowserHostFor: () => "local",
}));
vi.mock("~/browser/browserDefaults", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/browser/browserDefaults")>()),
  resolveBrowserDefaults: async () => ({
    viewport: { _tag: "fill" },
    profileId: "default",
    profiles: [],
    zoomFactor: 1,
    appearance: "system",
  }),
}));
vi.mock("~/browser/browserLinkTarget", () => ({
  resolveBrowserLinkTargetPreference: async () => "app",
  isWebUrl: (url: string) => /^https?:/u.test(url),
}));

import {
  applyPreviewServerSnapshot,
  resetPreviewStateForTests,
  setActivePreviewTab,
} from "~/previewStateStore";
import { selectActiveRightPanelSurface, useRightPanelStore } from "~/rightPanelStore";

import { openTerminalLinkInPreview } from "./openTerminalLinkInPreview";

const threadRef = {
  environmentId: "local" as ScopedThreadRef["environmentId"],
  threadId: "terminal-reuse-thread" as ScopedThreadRef["threadId"],
};
const HUB = "http://dopamine.localhost:4000";

function tab(tabId: string, url: string): PreviewSessionSnapshot {
  return {
    threadId: threadRef.threadId,
    tabId,
    navStatus: { _tag: "Success", url, title: "" },
    canGoBack: false,
    canGoForward: false,
    profileId: "default",
    runtime: "server",
    desktopHostId: "local",
    backingPage: "desktop",
    updatedAt: "2026-11-24T10:00:00.000Z",
  };
}

beforeEach(() => {
  vi.stubGlobal("window", { desktopBridge: {} });
  resetPreviewStateForTests();
  useRightPanelStore.setState({
    byThreadKey: {},
    threadPanelVisibilityByThreadKey: {},
    userActionRevisionByThreadKey: {},
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it("reveals the open hub tab for a terminal link instead of opening another", async () => {
  applyPreviewServerSnapshot(threadRef, tab("hub", `${HUB}/d/status--mac`));
  applyPreviewServerSnapshot(threadRef, tab("other", "https://example.com/"));
  setActivePreviewTab(threadRef, "other");
  const openPreview = vi.fn(async () => AsyncResult.success(tab("new", "about:blank")));
  const fallbackToBrowser = vi.fn();

  await openTerminalLinkInPreview({
    url: `${HUB}/d/status--mac?from=terminal`,
    threadRef,
    openPreview,
    fallbackToBrowser,
    forceBrowser: false,
  });

  expect(openPreview).not.toHaveBeenCalled();
  expect(fallbackToBrowser).not.toHaveBeenCalled();
  expect(
    selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, threadRef)?.id,
  ).toBe("browser:hub");
});
