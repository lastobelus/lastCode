import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ThreadId,
  type DesktopPreviewBridge,
  type PreviewOpenInput,
  type PreviewSessionSnapshot,
} from "@t3tools/contracts";
import { Effect } from "effect";
import { AsyncResult } from "effect/reactivity";
import type { PreparedHostedPreview } from "@t3tools/client-runtime/preview-hosting";
import { createPreviewBridgeFixture } from "../../test/previewBridge";

const mocks = vi.hoisted(() => ({
  runtime: vi.fn<() => "server" | undefined>(() => "server"),
  desktopHost: vi.fn<() => string | undefined>(() => "local"),
  localDesktopBrowser: vi.fn<() => boolean | undefined>(() => true),
  restarted: vi.fn<() => boolean>(() => false),
}));
vi.mock("~/components/preview/previewHostingRecovery", () => ({
  prepareHostedPreview: async (_ref: unknown, url: string): Promise<PreparedHostedPreview> => ({
    url,
    managed: false,
    restored: false,
    restarted: mocks.restarted(),
  }),
}));
vi.mock("~/browser/previewRuntime", () => ({
  isPreviewAvailableFor: () => true,
  previewRuntimeFor: mocks.runtime,
  desktopBrowserHostFor: mocks.desktopHost,
}));
vi.mock("~/state/entities", () => ({
  readEnvironmentSupportsServerBrowser: () => true,
  readEnvironmentHasLocalDesktopBrowser: mocks.localDesktopBrowser,
}));
vi.mock("./browserDefaults", () => ({
  resolveBrowserDefaults: async () => ({ viewport: { _tag: "fill" }, profileId: "default" }),
}));

import { findReusablePreviewTab } from "./lastcodePreviewTabReuse";
import { startElectronBrowserHost } from "./ElectronBrowserHost";
import { openUrlInPreview } from "./openFileInPreview";
import { previewRuntimeTabId } from "./previewRuntimeTabId";
import {
  applyPreviewDesktopState,
  applyPreviewServerSnapshot,
  beginPreviewSessionClose,
  cancelPreviewSessionClose,
  readThreadPreviewState,
  reconcilePreviewServerSessions,
  resetPreviewStateForTests,
  setActivePreviewTab,
  updatePreviewServerSnapshot,
} from "~/previewStateStore";
import { selectActiveRightPanelSurface, useRightPanelStore } from "~/rightPanelStore";
import { previewEnvironment } from "~/state/preview";

const threadRef = {
  environmentId: EnvironmentId.make("tab-reuse-env"),
  threadId: ThreadId.make("tab-reuse-thread"),
};
const HUB = "http://dopamine.localhost:4000";

function tab(
  tabId: string,
  url: string,
  extra: Partial<PreviewSessionSnapshot> = {},
): PreviewSessionSnapshot {
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
    ...extra,
  };
}

function seed(...tabs: PreviewSessionSnapshot[]) {
  for (const snapshot of tabs) applyPreviewServerSnapshot(threadRef, snapshot);
}

const opened = tab("opened-by-test", "about:blank");
const openPreview = vi.fn(async (_input: { input: PreviewOpenInput }) =>
  AsyncResult.success(opened),
);

function activeSurfaceId() {
  return selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, threadRef)?.id;
}

beforeEach(() => {
  mocks.runtime.mockReturnValue("server");
  mocks.desktopHost.mockReturnValue("local");
  mocks.localDesktopBrowser.mockReturnValue(true);
  mocks.restarted.mockReturnValue(false);
  resetPreviewStateForTests();
  useRightPanelStore.setState({
    byThreadKey: {},
    threadPanelVisibilityByThreadKey: {},
    userActionRevisionByThreadKey: {},
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("link clicks reuse an open tab", () => {
  it("reveals the open hub tab for a second click with a different query", async () => {
    seed(tab("hub", `${HUB}/d/status--mac?view=1`), tab("other", "https://example.com/"));
    setActivePreviewTab(threadRef, "other");

    const result = await openUrlInPreview({
      threadRef,
      url: `${HUB}/d/status--mac?view=2`,
      openPreview,
    });

    expect(result._tag).toBe("Success");
    expect(openPreview).not.toHaveBeenCalled();
    expect(activeSurfaceId()).toBe("browser:hub");
    expect(readThreadPreviewState(threadRef).activeTabId).toBe("hub");
    // Revealing never navigates the tab.
    expect(readThreadPreviewState(threadRef).sessions.hub?.navStatus).toMatchObject({
      url: `${HUB}/d/status--mac?view=1`,
    });
  });

  it.each([
    { matches: "only the source tab", hasMatch: false },
    { matches: "another tab as well", hasMatch: true },
  ])("skips the source when a desktop link matches $matches", async ({ hasMatch }) => {
    mocks.runtime.mockReturnValue(undefined);
    const placement = { runtime: undefined, desktopHostId: undefined, backingPage: undefined };
    const source = tab("source", `${HUB}/d/a?view=1`, placement);
    const target = tab("new", `${HUB}/d/a?view=2`, placement);
    const other = tab("other", `${HUB}/d/a?view=3`, placement);
    seed(source);
    if (hasMatch) seed(other);
    setActivePreviewTab(threadRef, source.tabId);

    const onOpenLink = vi.fn<DesktopPreviewBridge["onOpenLink"]>(() => () => undefined);
    vi.stubGlobal("window", {
      desktopBridge: {
        preview: createPreviewBridgeFixture({ onOpenLink, onPointerEvent: () => () => undefined }),
      },
      requestAnimationFrame: () => 1,
      cancelAnimationFrame: () => undefined,
    });
    vi.stubGlobal("document", {});
    vi.stubGlobal(
      "MutationObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    const open = vi.spyOn(await import("./openFileInPreview"), "openUrlInPreview");
    const command = vi
      .spyOn(previewEnvironment.open, "run")
      .mockReturnValue(Effect.succeed(target));
    using _host = { [Symbol.dispose]: startElectronBrowserHost() };
    const onLink = onOpenLink.mock.calls[0]![0];

    onLink({
      tabId: previewRuntimeTabId(threadRef, null, source.tabId),
      url: `${HUB}/d/a?view=2`,
      background: false,
    });
    await open.mock.results[0]?.value;

    const selected = hasMatch ? other : target;
    expect(command).toHaveBeenCalledTimes(hasMatch ? 0 : 1);
    expect(activeSurfaceId()).toBe(`browser:${selected.tabId}`);
    expect(readThreadPreviewState(threadRef).sessions.source?.navStatus).toEqual(source.navStatus);
    expect(readThreadPreviewState(threadRef).sessions[selected.tabId]?.navStatus).toEqual(
      selected.navStatus,
    );
  });

  it("opens a new tab for a background (Cmd-click) open", async () => {
    seed(tab("hub", `${HUB}/`));
    await openUrlInPreview({ threadRef, url: `${HUB}/`, openPreview, background: true });
    expect(openPreview).toHaveBeenCalledOnce();
  });

  it("does not reuse agent-owned, hidden, other-profile or other-host tabs", async () => {
    seed(
      tab("agent", `${HUB}/`, { automationOwner: "agent-session" }),
      tab("hidden", `${HUB}/`, { reveal: false }),
      tab("work-profile", `${HUB}/`, { profileId: "work" }),
      tab("environment", `${HUB}/`, { desktopHostId: undefined, backingPage: "server" }),
      tab("other-desktop", `${HUB}/`, { desktopHostId: "laptop" }),
    );
    await openUrlInPreview({ threadRef, url: `${HUB}/`, openPreview });
    expect(openPreview).toHaveBeenCalledOnce();
  });

  it("opens a new tab when the caller opts out of reuse", async () => {
    seed(tab("hub", `${HUB}/`));
    await openUrlInPreview({ threadRef, url: `${HUB}/`, openPreview, reuse: "none" });
    expect(openPreview).toHaveBeenCalledOnce();
  });

  it("does not reuse a tab whose page failed to load", async () => {
    seed(
      tab("failed", `${HUB}/`, {
        navStatus: { _tag: "LoadFailed", url: `${HUB}/`, title: "", code: -102, description: "" },
      }),
    );
    await openUrlInPreview({ threadRef, url: `${HUB}/`, openPreview });
    expect(openPreview).toHaveBeenCalledOnce();
  });

  it("does not reuse a tab after preparation restarted its preview", async () => {
    mocks.restarted.mockReturnValue(true);
    seed(tab("hub", `${HUB}/`));
    await openUrlInPreview({ threadRef, url: `${HUB}/`, openPreview });
    expect(openPreview).toHaveBeenCalledOnce();
  });

  it("matches only the host the server will choose when the open names none", async () => {
    mocks.desktopHost.mockReturnValue(undefined);
    seed(tab("environment", `${HUB}/`, { desktopHostId: undefined, backingPage: "server" }));
    await openUrlInPreview({ threadRef, url: `${HUB}/`, openPreview });
    expect(openPreview).toHaveBeenCalledOnce();

    openPreview.mockClear();
    mocks.localDesktopBrowser.mockReturnValue(false);
    await openUrlInPreview({ threadRef, url: `${HUB}/`, openPreview });
    expect(openPreview).not.toHaveBeenCalled();
    expect(activeSurfaceId()).toBe("browser:environment");

    openPreview.mockClear();
    mocks.localDesktopBrowser.mockReturnValue(undefined);
    await openUrlInPreview({ threadRef, url: `${HUB}/`, openPreview });
    expect(openPreview).toHaveBeenCalledOnce();
  });

  it("reveals the most recently selected dashboard after another dashboard navigates", async () => {
    seed(tab("a", `${HUB}/d/a`), tab("b", `${HUB}/d/b`), tab("other", "https://example.com/"));
    const panels = useRightPanelStore.getState();
    panels.reconcileBrowserSurfaces(threadRef, ["a", "b", "other"]);
    for (const tabId of ["a", "b", "a"]) {
      panels.activateSurface(threadRef, `browser:${tabId}`);
      setActivePreviewTab(threadRef, tabId);
    }
    updatePreviewServerSnapshot(
      threadRef,
      tab("b", `${HUB}/d/b?view=2`, { updatedAt: "2026-11-24T11:00:00.000Z" }),
    );
    panels.activateSurface(threadRef, "browser:other");
    setActivePreviewTab(threadRef, "other");

    await openUrlInPreview({ threadRef, url: `${HUB}/`, openPreview, reuse: "origin" });

    expect(activeSurfaceId()).toBe("browser:a");
    expect(openPreview).not.toHaveBeenCalled();
    expect(readThreadPreviewState(threadRef).sessions.a?.navStatus).toMatchObject({
      url: `${HUB}/d/a`,
    });
  });

  it("keeps a dashboard's place in the selection order when its close fails", async () => {
    const a = tab("a", `${HUB}/d/a`);
    seed(a, tab("b", `${HUB}/d/b`), tab("other", "https://example.com/"));
    const panels = useRightPanelStore.getState();
    panels.reconcileBrowserSurfaces(threadRef, ["a", "b", "other"]);
    for (const tabId of ["b", "a", "other"]) {
      panels.activateSurface(threadRef, `browser:${tabId}`);
      setActivePreviewTab(threadRef, tabId);
    }

    panels.closeSurface(threadRef, "browser:a");
    beginPreviewSessionClose(threadRef, "a");
    panels.reconcileBrowserSurfaces(threadRef, ["b", "other"]);
    cancelPreviewSessionClose(threadRef, a, "a");
    panels.reconcileBrowserSurfaces(threadRef, ["b", "other", "a"]);

    await openUrlInPreview({ threadRef, url: `${HUB}/`, openPreview, reuse: "origin" });

    expect(activeSurfaceId()).toBe("browser:a");
    expect(openPreview).not.toHaveBeenCalled();
  });

  it("keeps dashboard selections when a foreground tab opens before the session list", async () => {
    const a = tab("a", `${HUB}/d/a`);
    const b = tab("b", `${HUB}/d/b`, { updatedAt: "2026-11-24T11:00:00.000Z" });
    seed(a, b);
    const panels = useRightPanelStore.getState();
    panels.reconcileBrowserSurfaces(threadRef, ["a", "b"]);
    for (const tabId of ["a", "b", "a"]) {
      panels.activateSurface(threadRef, `browser:${tabId}`);
      setActivePreviewTab(threadRef, tabId);
    }

    resetPreviewStateForTests();
    const other = tab("other", "https://example.com/");
    await openUrlInPreview({
      threadRef,
      url: "https://example.com/",
      openPreview: async () => AsyncResult.success(other),
    });
    reconcilePreviewServerSessions(threadRef, {
      serverEpoch: "server",
      revision: 1,
      sessions: [a, b, other],
    });
    panels.reconcileBrowserSurfaces(threadRef, ["a", "b", "other"]);

    await openUrlInPreview({ threadRef, url: `${HUB}/`, openPreview, reuse: "origin" });

    expect(activeSurfaceId()).toBe("browser:a");
    expect(openPreview).not.toHaveBeenCalled();
  });
});

describe("findReusablePreviewTab", () => {
  const placement = { profileId: "default", runtime: "server" as const, desktopHostId: "local" };
  const find = (url: string, reuse: "address" | "origin" = "address") =>
    findReusablePreviewTab(readThreadPreviewState(threadRef), {
      urls: [url],
      placement,
      reuse,
    });

  it("matches a local address by origin and path, ignoring the query", () => {
    seed(tab("hub", `${HUB}/d/a?x=1`));
    expect(find(`${HUB}/d/a?x=2`)).toBe("hub");
    expect(find(`${HUB}/d/b`)).toBeNull();
    expect(find("http://other.localhost:4000/d/a")).toBeNull();
    expect(find(`${HUB}/d/a?x=1#/other`)).toBeNull();
  });

  it("uses a desktop tab's live address over its last server report", () => {
    seed(tab("hub", `${HUB}/d/a`));
    applyPreviewDesktopState(threadRef, "hub", {
      hasWebContents: true,
      navStatus: { _tag: "Success", url: "https://example.com/", title: "" },
      canGoBack: true,
      canGoForward: false,
      loading: false,
      zoomFactor: 1,
      pictureInPicture: false,
      colorScheme: "light",
      audioMuted: false,
      audible: false,
      controller: "human",
      favicon: null,
    });
    expect(find(`${HUB}/d/a`)).toBeNull();
    expect(find("https://example.com/")).toBe("hub");
  });

  it("matches a public address only exactly", () => {
    seed(tab("site", "https://example.com/page?x=1"));
    expect(find("https://example.com/page?x=1")).toBe("site");
    expect(find("https://example.com/page?x=2")).toBeNull();
  });

  it("matches any page on the origin for an entry point, preferring the most recent", () => {
    seed(
      tab("older", `${HUB}/d/a`, { updatedAt: "2026-11-24T09:00:00.000Z" }),
      tab("newer", `${HUB}/d/b`, { updatedAt: "2026-11-24T11:00:00.000Z" }),
    );
    expect(find(`${HUB}/`, "origin")).toBe("newer");
    expect(find(`${HUB}/`)).toBeNull();
  });

  it("prefers the active tab", () => {
    seed(
      tab("active", `${HUB}/d/a`, { updatedAt: "2026-11-24T09:00:00.000Z" }),
      tab("newer", `${HUB}/d/b`, { updatedAt: "2026-11-24T11:00:00.000Z" }),
    );
    setActivePreviewTab(threadRef, "active");
    expect(find(`${HUB}/`, "origin")).toBe("active");
  });

  it("matches client-run desktop tabs only for client-run opens", () => {
    seed(
      tab("client", `${HUB}/`, {
        runtime: undefined,
        desktopHostId: undefined,
        backingPage: undefined,
      }),
    );
    expect(find(`${HUB}/`)).toBeNull();
    expect(
      findReusablePreviewTab(readThreadPreviewState(threadRef), {
        urls: [`${HUB}/`],
        placement: { profileId: "default" },
        reuse: "address",
      }),
    ).toBe("client");
  });
});
