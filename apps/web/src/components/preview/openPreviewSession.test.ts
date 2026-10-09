import {
  DEFAULT_BROWSER_PROFILE_ID,
  DEFAULT_CLIENT_SETTINGS,
  FILL_PREVIEW_VIEWPORT,
  type PreviewOpenInput,
  type AssetCreateUrlResult,
  type PreviewSessionSnapshot,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import * as browserDefaults from "~/browser/browserDefaults";
import * as previewRuntime from "~/browser/previewRuntime";
import * as hostingRecovery from "./previewHostingRecovery";
import {
  BrowserSettingsReadError,
  openFileInPreview,
  openUrlInPreview,
} from "~/browser/openFileInPreview";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { useRightPanelStore } from "~/rightPanelStore";
import {
  applyPreviewServerSnapshot,
  applyPreviewServerEvent,
  hiddenPreviewTabIds,
  readThreadPreviewState,
  reconcilePreviewServerSessions,
  resetPreviewStateForTests,
  setActivePreviewTab,
} from "~/previewStateStore";

import { openPreviewSession } from "./openPreviewSession";

const threadRef = {
  environmentId: "local" as ScopedThreadRef["environmentId"],
  threadId: "thread-1" as ScopedThreadRef["threadId"],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

const snapshot: PreviewSessionSnapshot = {
  threadId: threadRef.threadId,
  tabId: "tab-1",
  navStatus: {
    _tag: "Loading",
    url: "https://t3.chat/",
    title: "",
  },
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-06-11T23:00:00.000Z",
};

const applyOpenedEvent = (opened: PreviewSessionSnapshot, background = false) =>
  applyPreviewServerEvent(threadRef, {
    type: "opened",
    threadId: threadRef.threadId,
    tabId: opened.tabId,
    snapshot: opened,
    serverEpoch: "server-a",
    revision: 1,
    background,
    createdAt: opened.updatedAt,
  });

beforeEach(() => {
  resetPreviewStateForTests();
  useRightPanelStore.setState({
    byThreadKey: {},
    threadPanelVisibilityByThreadKey: {},
    userActionRevisionByThreadKey: {},
  });
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("openPreviewSession", () => {
  it("moves to the environment's browser without selecting this desktop's native host", async () => {
    vi.spyOn(previewRuntime, "previewRuntimeFor").mockReturnValue(undefined);
    const desktopHost = vi
      .spyOn(previewRuntime, "desktopBrowserHostFor")
      .mockReturnValue("desktop-remote");
    vi.spyOn(hostingRecovery, "prepareHostedPreview").mockResolvedValue({
      url: "http://environment.example.test:5173/check",
      managed: true,
      restored: true,
    });
    const openPreview = vi.fn(async () => AsyncResult.success(snapshot));

    await openPreviewSession({
      openPreview,
      threadRef,
      url: "http://localhost:5173/check",
      runtime: "server",
    });

    expect(desktopHost).not.toHaveBeenCalled();
    expect(openPreview).toHaveBeenCalledExactlyOnceWith({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        url: "http://localhost:5173/check",
        runtime: "server",
        profileId: DEFAULT_BROWSER_PROFILE_ID,
        viewport: FILL_PREVIEW_VIEWPORT,
      },
    });
  });

  it("moves to this computer's browser even when the default runtime is server", async () => {
    vi.spyOn(previewRuntime, "previewRuntimeFor").mockReturnValue("server");
    const desktopHost = vi
      .spyOn(previewRuntime, "desktopBrowserHostFor")
      .mockReturnValue("desktop-remote");
    vi.spyOn(hostingRecovery, "prepareHostedPreview").mockResolvedValue({
      url: "http://environment.example.test:5173/check",
      managed: true,
      restored: true,
    });
    const openPreview = vi.fn(async () => AsyncResult.success(snapshot));

    await openPreviewSession({
      openPreview,
      threadRef,
      url: "http://localhost:5173/check",
      runtime: "desktop",
    });

    expect(desktopHost).not.toHaveBeenCalled();
    expect(openPreview).toHaveBeenCalledExactlyOnceWith({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        url: "http://environment.example.test:5173/check",
        profileId: DEFAULT_BROWSER_PROFILE_ID,
        viewport: FILL_PREVIEW_VIEWPORT,
      },
    });
  });

  it.each(["session", "link"] as const)(
    "pins a remote desktop %s open to its selected profile and recovered destination",
    async (entryPoint) => {
      vi.spyOn(previewRuntime, "previewRuntimeFor").mockReturnValue("server");
      vi.spyOn(previewRuntime, "desktopBrowserHostFor").mockReturnValue("desktop-remote");
      vi.spyOn(hostingRecovery, "prepareHostedPreview").mockResolvedValue({
        url: "http://environment.example.test:5173/check?x=1#section",
        managed: true,
        restored: true,
      });
      __setClientSettingsForTests({
        ...DEFAULT_CLIENT_SETTINGS,
        browserDefaultProfileId: "work",
        browserProfiles: [{ id: "work", name: "Work", kind: "persistent" }],
      });
      const openPreview = vi.fn(async () => AsyncResult.success(snapshot));
      const open = entryPoint === "session" ? openPreviewSession : openUrlInPreview;
      await open({ openPreview, threadRef, url: "http://localhost:5173/check?x=1#section" });
      expect(openPreview).toHaveBeenCalledWith({
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          url: "http://environment.example.test:5173/check?x=1#section",
          runtime: "server",
          desktopHostId: "desktop-remote",
          profileId: "work",
          viewport: FILL_PREVIEW_VIEWPORT,
          ...(entryPoint === "link"
            ? { focus: expect.objectContaining({ userActionRevision: 1 }) }
            : {}),
        },
      });
    },
  );

  it("creates an idle tab without recording a recently visited URL", async () => {
    const idleSnapshot: PreviewSessionSnapshot = {
      ...snapshot,
      tabId: "tab-blank",
      navStatus: { _tag: "Idle" },
    };
    const open = vi.fn(async (_input: PreviewOpenInput) => AsyncResult.success(idleSnapshot));

    await openPreviewSession({
      openPreview: ({ input }) => open(input),
      threadRef,
    });

    expect(open).toHaveBeenCalledWith({
      threadId: "thread-1",
      viewport: FILL_PREVIEW_VIEWPORT,
      profileId: DEFAULT_BROWSER_PROFILE_ID,
    });
    expect(readThreadPreviewState(threadRef).snapshot).toEqual(idleSnapshot);
    expect(readThreadPreviewState(threadRef).recentlySeenUrls).toEqual([]);
  });

  it("applies the RPC response without waiting for a preview event", async () => {
    const open = vi.fn(async (_input: PreviewOpenInput) => AsyncResult.success(snapshot));

    await openPreviewSession({
      openPreview: ({ input }) => open(input),
      threadRef,
      url: "t3.chat",
    });

    expect(open).toHaveBeenCalledWith({
      threadId: "thread-1",
      url: "t3.chat",
      viewport: FILL_PREVIEW_VIEWPORT,
      profileId: DEFAULT_BROWSER_PROFILE_ID,
    });
    expect(readThreadPreviewState(threadRef).snapshot).toEqual(snapshot);
    expect(readThreadPreviewState(threadRef).recentlySeenUrls).toEqual(["https://t3.chat/"]);
  });

  it("returns failures without mutating preview state", async () => {
    const failure = new Error("preview unavailable");

    const result = await openPreviewSession({
      openPreview: async () => AsyncResult.failure(Cause.fail(failure)),
      threadRef,
      url: "t3.chat",
    });

    expect(result._tag).toBe("Failure");
    expect(readThreadPreviewState(threadRef).snapshot).toBeNull();
    expect(readThreadPreviewState(threadRef).recentlySeenUrls).toEqual([]);
  });

  it.each(["session", "link"] as const)(
    "does not open a %s with unread settings and uses the saved profile on retry",
    async (entryPoint) => {
      const failure = new Error("Settings read failed");
      vi.spyOn(browserDefaults, "resolveBrowserDefaults").mockRejectedValueOnce(failure);
      const viewport = { _tag: "freeform", width: 1280, height: 720 } as const;
      __setClientSettingsForTests({
        ...DEFAULT_CLIENT_SETTINGS,
        browserDefaultViewport: viewport,
        browserDefaultProfileId: "work",
        browserProfiles: [{ id: "work", name: "Work", kind: "persistent" }],
      });
      const openPreview = vi.fn(async () => AsyncResult.success(snapshot));
      const input = { openPreview, threadRef, url: "https://t3.chat/" };
      const open = entryPoint === "session" ? openPreviewSession : openUrlInPreview;

      const result = await open(input);

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(Cause.squash(result.cause)).toBeInstanceOf(BrowserSettingsReadError);
        expect(Cause.squash(result.cause)).toMatchObject({ cause: failure });
      }
      expect(openPreview).not.toHaveBeenCalled();
      expect(readThreadPreviewState(threadRef).snapshot).toBeNull();
      expect(readThreadPreviewState(threadRef).recentlySeenUrls).toEqual([]);

      await expect(open(input)).resolves.toMatchObject({ _tag: "Success" });
      expect(openPreview).toHaveBeenCalledExactlyOnceWith({
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          url: input.url,
          viewport,
          profileId: "work",
          ...(entryPoint === "link"
            ? { focus: expect.objectContaining({ userActionRevision: 2 }) }
            : {}),
        },
      });
    },
  );
});

describe("openUrlInPreview from a link", () => {
  it.each(["source-profile", DEFAULT_BROWSER_PROFILE_ID, "incognito"])(
    "opens under the source tab's %s profile instead of the configured default",
    async (profileId) => {
      __setClientSettingsForTests({
        ...DEFAULT_CLIENT_SETTINGS,
        browserDefaultProfileId: "work",
        browserProfiles: [{ id: "work", name: "Work", kind: "persistent" }],
      });
      const openPreview = vi.fn(async (_arg: { input: PreviewOpenInput }) =>
        AsyncResult.success(snapshot),
      );
      await openUrlInPreview({ openPreview, threadRef, url: "https://t3.chat/", profileId });
      expect(openPreview.mock.calls[0]?.[0].input.profileId).toBe(profileId);
    },
  );

  it("keeps the current tab active for a background open", async () => {
    applyPreviewServerSnapshot(threadRef, { ...snapshot, tabId: "tab-current" });

    await openUrlInPreview({
      openPreview: async () => AsyncResult.success(snapshot),
      threadRef,
      url: "https://t3.chat/",
      background: true,
    });

    const state = readThreadPreviewState(threadRef);
    expect(state.activeTabId).toBe("tab-current");
    expect(Object.keys(state.sessions).toSorted()).toEqual(["tab-1", "tab-current"]);
  });

  it("keeps a tab the user picked while a background open was in flight", async () => {
    applyPreviewServerSnapshot(threadRef, { ...snapshot, tabId: "tab-current" });
    applyPreviewServerSnapshot(threadRef, { ...snapshot, tabId: "tab-other" });
    setActivePreviewTab(threadRef, "tab-current");

    await openUrlInPreview({
      openPreview: async () => {
        // The server introduces the background tab, then the user selects
        // another page before the open resolves.
        applyOpenedEvent(snapshot, true);
        setActivePreviewTab(threadRef, "tab-other");
        return AsyncResult.success(snapshot);
      },
      threadRef,
      url: "https://t3.chat/",
      background: true,
    });

    expect(readThreadPreviewState(threadRef).activeTabId).toBe("tab-other");
  });

  it("keeps the new tab when the user picks it while a background open is in flight", async () => {
    applyPreviewServerSnapshot(threadRef, { ...snapshot, tabId: "tab-current" });
    setActivePreviewTab(threadRef, "tab-current");

    await openUrlInPreview({
      openPreview: async () => {
        // The user explicitly selects the new background tab before its reply.
        applyOpenedEvent(snapshot, true);
        setActivePreviewTab(threadRef, snapshot.tabId);
        useRightPanelStore.getState().openBrowser(threadRef, snapshot.tabId);
        return AsyncResult.success(snapshot);
      },
      threadRef,
      url: "https://t3.chat/",
      background: true,
    });

    expect(readThreadPreviewState(threadRef).activeTabId).toBe(snapshot.tabId);
  });

  it("activates the new tab for a foreground open", async () => {
    applyPreviewServerSnapshot(threadRef, { ...snapshot, tabId: "tab-current" });

    await openUrlInPreview({
      openPreview: async () => AsyncResult.success(snapshot),
      threadRef,
      url: "https://t3.chat/",
    });

    expect(readThreadPreviewState(threadRef).activeTabId).toBe("tab-1");
    expect(useRightPanelStore.getState().byThreadKey["local:thread-1"]?.activeSurfaceId).toBe(
      "browser:tab-1",
    );
  });
});

it.each(
  (["terminal", "file"] as const).flatMap((initialPanel) =>
    (["event-first", "reply-first"] as const).flatMap((order) =>
      (["foreground", "background", "later-choice"] as const).map((intent) => ({
        initialPanel,
        order,
        intent,
      })),
    ),
  ),
)(
  "handles the first $intent open from an authoritative empty list with $initialPanel and $order delivery",
  async ({ initialPanel, order, intent }) => {
    reconcilePreviewServerSessions(threadRef, {
      serverEpoch: "server-a",
      revision: 0,
      sessions: [],
    });
    const panel = useRightPanelStore.getState();
    if (initialPanel === "terminal") panel.openTerminal(threadRef, "terminal-1");
    else panel.openFile(threadRef, "src/app.ts");
    const started = deferred<PreviewOpenInput>();
    const reply = deferred<PreviewSessionSnapshot>();
    const opening = openUrlInPreview({
      threadRef,
      url: "https://t3.chat/",
      background: intent === "background",
      openPreview: async ({ input }) => {
        started.resolve(input);
        return AsyncResult.success(await reply.promise);
      },
    });
    const request = await started.promise;
    if (intent === "later-choice") {
      if (initialPanel === "terminal") panel.openFile(threadRef, "src/later.ts");
      else panel.openTerminal(threadRef, "terminal-later");
    }
    const chosenSurface =
      useRightPanelStore.getState().byThreadKey["local:thread-1"]!.activeSurfaceId;
    const revision = panel.getUserActionRevision(threadRef);
    const listed = {
      ...snapshot,
      navStatus: { _tag: "Success" as const, url: "https://t3.chat/", title: "Loaded" },
      updatedAt: "2026-06-11T23:00:02.000Z",
    };
    reconcilePreviewServerSessions(threadRef, {
      serverEpoch: "server-a",
      revision: 2,
      sessions: [listed],
    });
    const reconcilePanel = () => {
      const state = readThreadPreviewState(threadRef);
      panel.reconcileBrowserSurfaces(
        threadRef,
        Object.keys(state.sessions),
        hiddenPreviewTabIds(state.sessions),
      );
    };
    reconcilePanel();
    expect(useRightPanelStore.getState().byThreadKey["local:thread-1"]?.activeSurfaceId).toBe(
      chosenSurface,
    );
    const event = {
      type: "opened" as const,
      threadId: threadRef.threadId,
      tabId: snapshot.tabId,
      snapshot,
      serverEpoch: "server-a",
      revision: 1,
      createdAt: snapshot.updatedAt,
      background: request.background,
      focus: request.focus,
    };
    const expected = intent === "foreground" ? `browser:${snapshot.tabId}` : chosenSurface;
    const assertDisplayedSurface = () => {
      const state = readThreadPreviewState(threadRef);
      expect(state.sessions[snapshot.tabId]).toEqual(listed);
      expect(state.serverRevision).toBe(2);
      expect(hiddenPreviewTabIds(state.sessions).size).toBe(0);
      const currentPanel = useRightPanelStore.getState().byThreadKey["local:thread-1"];
      expect(currentPanel?.isOpen).toBe(true);
      expect(currentPanel?.activeSurfaceId).toBe(expected);
      expect(currentPanel?.surfaces).toContainEqual({
        id: `browser:${snapshot.tabId}`,
        kind: "preview",
        resourceId: snapshot.tabId,
      });
      expect(panel.getUserActionRevision(threadRef)).toBe(revision);
    };
    if (order === "event-first") {
      applyPreviewServerEvent(threadRef, event);
      assertDisplayedSurface();
    }
    reply.resolve(snapshot);
    await expect(opening).resolves.toMatchObject({ _tag: "Success" });
    assertDisplayedSurface();
    if (order === "reply-first") applyPreviewServerEvent(threadRef, event);
    reconcilePanel();
    assertDisplayedSurface();
    // Creation replays must not undo an explicit choice after either completion.
    panel.openTerminal(threadRef, "terminal-after-open");
    const laterRevision = panel.getUserActionRevision(threadRef);
    applyPreviewServerEvent(threadRef, event);
    reconcilePanel();
    expect(useRightPanelStore.getState().byThreadKey["local:thread-1"]?.activeSurfaceId).toBe(
      "terminal:terminal-after-open",
    );
    expect(panel.getUserActionRevision(threadRef)).toBe(laterRevision);
  },
);

it.each(["terminal-only", "browser-then-terminal", "browser-before-server-event"] as const)(
  "keeps browser selection during a background open: %s",
  async (selection) => {
    applyPreviewServerSnapshot(threadRef, { ...snapshot, tabId: "tab-current" });
    applyPreviewServerSnapshot(threadRef, { ...snapshot, tabId: "tab-other" });
    setActivePreviewTab(threadRef, "tab-current");
    useRightPanelStore.getState().openBrowser(threadRef, "tab-current");
    await openUrlInPreview({
      threadRef,
      url: "https://t3.chat/",
      background: true,
      openPreview: async () => {
        if (selection !== "browser-before-server-event") applyOpenedEvent(snapshot, true);
        if (selection !== "terminal-only") {
          setActivePreviewTab(threadRef, "tab-other");
          useRightPanelStore.getState().openBrowser(threadRef, "tab-other");
        }
        useRightPanelStore.getState().openTerminal(threadRef, "terminal-1");
        if (selection === "browser-before-server-event") applyOpenedEvent(snapshot, true);
        return AsyncResult.success(snapshot);
      },
    });
    expect(readThreadPreviewState(threadRef).activeTabId).toBe(
      selection === "terminal-only" ? "tab-current" : "tab-other",
    );
    expect(useRightPanelStore.getState().byThreadKey["local:thread-1"]?.activeSurfaceId).toBe(
      "terminal:terminal-1",
    );
  },
);

it("retains the authored and recovered hosted URLs with an explicit link profile", async () => {
  vi.spyOn(previewRuntime, "previewRuntimeFor").mockReturnValue("server");
  vi.spyOn(previewRuntime, "desktopBrowserHostFor").mockReturnValue("desktop-remote");
  vi.spyOn(hostingRecovery, "prepareHostedPreview").mockResolvedValue({
    url: "http://environment.example.test:5173/check?x=1#section",
    navigationUrl: "http://environment.example.test:5173/check?x=1#token=hosted-token",
    managed: true,
    restored: true,
  });
  const openPreview = vi.fn(async () => AsyncResult.success(snapshot));
  await openUrlInPreview({
    threadRef,
    url: "http://localhost:5173/check?x=1#section",
    profileId: "source-profile",
    background: true,
    openPreview,
  });
  expect(openPreview).toHaveBeenCalledWith({
    environmentId: threadRef.environmentId,
    input: {
      threadId: threadRef.threadId,
      url: "http://environment.example.test:5173/check?x=1#token=hosted-token&t3-preview-return-hash=%23section",
      runtime: "server",
      desktopHostId: "desktop-remote",
      profileId: "source-profile",
      viewport: FILL_PREVIEW_VIEWPORT,
      background: true,
      focus: expect.objectContaining({ userActionRevision: 0 }),
    },
  });
  expect(readThreadPreviewState(threadRef).recentlySeenUrls).toContain(
    "http://localhost:5173/check?x=1#section",
  );
});

it("never activates a background opened event while its RPC is pending", async () => {
  applyPreviewServerSnapshot(threadRef, { ...snapshot, tabId: "tab-current" });
  const started = deferred<PreviewOpenInput>();
  const reply = deferred<PreviewSessionSnapshot>();
  const opened = openUrlInPreview({
    threadRef,
    url: "https://t3.chat/",
    background: true,
    openPreview: async ({ input }) => {
      started.resolve(input);
      return AsyncResult.success(await reply.promise);
    },
  });
  const request = await started.promise;
  expect(request.background).toBe(true);
  expect(request.reveal).toBeUndefined();
  const backgroundSnapshot = snapshot;
  applyOpenedEvent(backgroundSnapshot, true);
  expect(readThreadPreviewState(threadRef).activeTabId).toBe("tab-current");
  expect(readThreadPreviewState(threadRef).sessions[snapshot.tabId]).toEqual(backgroundSnapshot);
  reply.resolve(backgroundSnapshot);
  await opened;
  expect(readThreadPreviewState(threadRef).activeTabId).toBe("tab-current");
});

it("retains background intent through late and replayed opened events and later selections", async () => {
  applyPreviewServerSnapshot(threadRef, { ...snapshot, tabId: "tab-current" });
  const backgroundSnapshot = snapshot;
  await openUrlInPreview({
    threadRef,
    url: "https://t3.chat/",
    background: true,
    openPreview: async () => AsyncResult.success(backgroundSnapshot),
  });
  applyOpenedEvent(backgroundSnapshot, true);
  expect(readThreadPreviewState(threadRef).activeTabId).toBe("tab-current");
  applyPreviewServerSnapshot(threadRef, { ...snapshot, tabId: "tab-other" });
  applyOpenedEvent(backgroundSnapshot, true);
  expect(readThreadPreviewState(threadRef).activeTabId).toBe("tab-other");
  setActivePreviewTab(threadRef, snapshot.tabId);
  applyOpenedEvent(backgroundSnapshot, true);
  expect(readThreadPreviewState(threadRef).activeTabId).toBe(snapshot.tabId);
});

it("lets a foreground open explicitly select an already known background tab", async () => {
  const backgroundSnapshot = snapshot;
  applyOpenedEvent(backgroundSnapshot, true);
  applyPreviewServerSnapshot(threadRef, { ...snapshot, tabId: "tab-current" });
  await openUrlInPreview({
    threadRef,
    url: "https://t3.chat/",
    openPreview: async () => AsyncResult.success(backgroundSnapshot),
  });
  expect(readThreadPreviewState(threadRef).activeTabId).toBe(snapshot.tabId);
  expect(useRightPanelStore.getState().byThreadKey["local:thread-1"]?.activeSurfaceId).toBe(
    `browser:${snapshot.tabId}`,
  );
  applyOpenedEvent(backgroundSnapshot, true);
  expect(readThreadPreviewState(threadRef).activeTabId).toBe(snapshot.tabId);
});

it.each(["event-first", "reply-first"] as const)(
  "creates a visible selectable background tab without switching pages: %s",
  async (order) => {
    vi.spyOn(previewRuntime, "previewRuntimeFor").mockReturnValue("server");
    vi.spyOn(previewRuntime, "desktopBrowserHostFor").mockReturnValue("desktop-local");
    const source = { ...snapshot, runtime: "server" as const, tabId: "source-tab" };
    const destination = { ...snapshot, runtime: "server" as const, tabId: "background-tab" };
    applyPreviewServerSnapshot(threadRef, source);
    useRightPanelStore.getState().openBrowser(threadRef, source.tabId);
    const reconcileSurfaces = () => {
      const state = readThreadPreviewState(threadRef);
      const hidden = hiddenPreviewTabIds(state.sessions);
      expect(hidden.size).toBe(0);
      useRightPanelStore
        .getState()
        .reconcileBrowserSurfaces(threadRef, Object.keys(state.sessions), hidden);
    };
    const started = deferred<PreviewOpenInput>();
    const reply = deferred<PreviewSessionSnapshot>();
    const opening = openUrlInPreview({
      threadRef,
      url: "https://t3.chat/",
      background: true,
      openPreview: async ({ input }) => {
        started.resolve(input);
        return AsyncResult.success(await reply.promise);
      },
    });
    const request = await started.promise;
    expect(request).toMatchObject({
      runtime: "server",
      background: true,
      desktopHostId: "desktop-local",
    });
    expect(request.reveal).toBeUndefined();
    if (order === "event-first") {
      applyOpenedEvent(destination, request.background);
      reconcileSurfaces();
      expect(readThreadPreviewState(threadRef).activeTabId).toBe(source.tabId);
      expect(useRightPanelStore.getState().byThreadKey["local:thread-1"]?.activeSurfaceId).toBe(
        `browser:${source.tabId}`,
      );
    }
    reply.resolve(destination);
    await opening;
    if (order === "reply-first") applyOpenedEvent(destination, request.background);
    reconcileSurfaces();
    const panel = useRightPanelStore.getState().byThreadKey["local:thread-1"];
    expect(panel?.surfaces.map((surface) => surface.id)).toEqual([
      `browser:${source.tabId}`,
      `browser:${destination.tabId}`,
    ]);
    expect(panel?.activeSurfaceId).toBe(`browser:${source.tabId}`);
    expect(readThreadPreviewState(threadRef).activeTabId).toBe(source.tabId);
    setActivePreviewTab(threadRef, destination.tabId);
    useRightPanelStore.getState().activateSurface(threadRef, `browser:${destination.tabId}`);
    applyOpenedEvent(destination, request.background);
    reconcileSurfaces();
    expect(readThreadPreviewState(threadRef).activeTabId).toBe(destination.tabId);
    expect(useRightPanelStore.getState().byThreadKey["local:thread-1"]?.activeSurfaceId).toBe(
      `browser:${destination.tabId}`,
    );
  },
);

it.each(
  (["event-first", "reply-first", "newer-list-first"] as const).flatMap((order) =>
    (["browser", "terminal", "file", "hide"] as const).map((choice) => ({ order, choice })),
  ),
)(
  "keeps an explicit $choice choice through a late foreground RPC reply with $order delivery",
  async ({ order, choice }) => {
    const source = { ...snapshot, tabId: "source-tab" };
    const other = { ...snapshot, tabId: "other-tab" };
    applyPreviewServerSnapshot(threadRef, source);
    applyPreviewServerSnapshot(threadRef, other);
    setActivePreviewTab(threadRef, source.tabId);
    useRightPanelStore.getState().openBrowser(threadRef, source.tabId);
    const started = deferred<void>();
    const reply = deferred<PreviewSessionSnapshot>();
    const onOpened = vi.fn();
    const opening = openUrlInPreview({
      threadRef,
      url: "https://t3.chat/",
      onOpened,
      openPreview: async () => {
        started.resolve();
        return AsyncResult.success(await reply.promise);
      },
    });
    await started.promise;
    const listed = {
      ...snapshot,
      navStatus: { _tag: "Success" as const, url: "https://t3.chat/loaded", title: "Loaded" },
      updatedAt: "2026-06-11T23:00:02.000Z",
    };
    if (order === "event-first") {
      applyOpenedEvent(snapshot);
      expect(useRightPanelStore.getState().byThreadKey["local:thread-1"]?.activeSurfaceId).toBe(
        `browser:${snapshot.tabId}`,
      );
    } else if (order === "newer-list-first") {
      reconcilePreviewServerSessions(threadRef, {
        serverEpoch: "server-a",
        revision: 2,
        sessions: [source, other, listed],
      });
    }
    const panel = useRightPanelStore.getState();
    if (choice === "browser") {
      setActivePreviewTab(threadRef, other.tabId);
      panel.openBrowser(threadRef, other.tabId);
    }
    if (choice === "terminal") panel.openTerminal(threadRef, "terminal-1");
    if (choice === "file") panel.openFile(threadRef, "src/app.ts");
    if (choice === "hide") panel.close(threadRef);
    const chosenPreviewTab = readThreadPreviewState(threadRef).activeTabId;
    const chosenPanel = useRightPanelStore.getState().byThreadKey["local:thread-1"];
    const chosenRevision = panel.getUserActionRevision(threadRef);
    reply.resolve(snapshot);
    await expect(opening).resolves.toMatchObject({ _tag: "Success" });
    expect(onOpened).toHaveBeenCalledExactlyOnceWith(snapshot.tabId);
    expect(readThreadPreviewState(threadRef).activeTabId).toBe(chosenPreviewTab);
    expect(useRightPanelStore.getState().byThreadKey["local:thread-1"]?.activeSurfaceId).toBe(
      chosenPanel?.activeSurfaceId,
    );
    expect(useRightPanelStore.getState().byThreadKey["local:thread-1"]?.isOpen).toBe(
      chosenPanel?.isOpen,
    );
    expect(useRightPanelStore.getState().getUserActionRevision(threadRef)).toBe(chosenRevision);
    // Reply-first and list-first events are still unconsumed until the reply.
    // Replays must likewise leave the chosen displayed resource alone.
    applyOpenedEvent(snapshot);
    const state = readThreadPreviewState(threadRef);
    useRightPanelStore
      .getState()
      .reconcileBrowserSurfaces(
        threadRef,
        Object.keys(state.sessions),
        hiddenPreviewTabIds(state.sessions),
      );
    expect(state.activeTabId).toBe(chosenPreviewTab);
    expect(state.sessions[snapshot.tabId]).toEqual(
      order === "newer-list-first" ? listed : snapshot,
    );
    expect(useRightPanelStore.getState().byThreadKey["local:thread-1"]?.activeSurfaceId).toBe(
      chosenPanel?.activeSurfaceId,
    );
    expect(useRightPanelStore.getState().byThreadKey["local:thread-1"]?.isOpen).toBe(
      chosenPanel?.isOpen,
    );
  },
);

it("does not repeat foreground event focus when its RPC reply arrives without another choice", async () => {
  const source = { ...snapshot, tabId: "source-tab" };
  applyPreviewServerSnapshot(threadRef, source);
  useRightPanelStore.getState().openBrowser(threadRef, source.tabId);
  const started = deferred<void>();
  const reply = deferred<PreviewSessionSnapshot>();
  const opening = openUrlInPreview({
    threadRef,
    url: "https://t3.chat/",
    openPreview: async () => {
      started.resolve();
      return AsyncResult.success(await reply.promise);
    },
  });
  await started.promise;
  applyOpenedEvent(snapshot);
  const revision = useRightPanelStore.getState().getUserActionRevision(threadRef);
  reply.resolve(snapshot);
  await opening;
  expect(useRightPanelStore.getState().getUserActionRevision(threadRef)).toBe(revision);
  expect(readThreadPreviewState(threadRef).activeTabId).toBe(snapshot.tabId);
  expect(useRightPanelStore.getState().byThreadKey["local:thread-1"]?.activeSurfaceId).toBe(
    `browser:${snapshot.tabId}`,
  );
});

it.each(
  (["recovery", "rpc"] as const).flatMap((delay) =>
    (["browser", "terminal", "file", "hide"] as const).flatMap((choice) =>
      [false, true].map((listFirst) => ({ delay, choice, listFirst })),
    ),
  ),
)(
  "keeps a $choice selection made during $delay before an unknown opened event (list first: $listFirst)",
  async ({ delay, choice, listFirst }) => {
    const source = { ...snapshot, tabId: "source-tab" };
    const other = { ...snapshot, tabId: "other-tab" };
    applyPreviewServerSnapshot(threadRef, source);
    applyPreviewServerSnapshot(threadRef, other);
    setActivePreviewTab(threadRef, source.tabId);
    useRightPanelStore.getState().openBrowser(threadRef, source.tabId);
    const recovery = deferred<{ url: string; managed: boolean; restored: boolean }>();
    vi.spyOn(hostingRecovery, "prepareHostedPreview").mockImplementation(() => recovery.promise);
    const started = deferred<PreviewOpenInput>();
    const reply = deferred<PreviewSessionSnapshot>();
    const opening = openUrlInPreview({
      threadRef,
      url: "https://t3.chat/",
      openPreview: async ({ input }) => {
        started.resolve(input);
        return AsyncResult.success(await reply.promise);
      },
    });
    if (delay === "rpc") {
      recovery.resolve({ url: "https://t3.chat/", managed: false, restored: false });
      await started.promise;
    }
    const panel = useRightPanelStore.getState();
    if (choice === "browser") {
      setActivePreviewTab(threadRef, other.tabId);
      panel.openBrowser(threadRef, other.tabId);
    } else if (choice === "terminal") panel.openTerminal(threadRef, "terminal-1");
    else if (choice === "file") panel.openFile(threadRef, "src/app.ts");
    else panel.close(threadRef);
    const selectedTab = readThreadPreviewState(threadRef).activeTabId;
    const selectedPanel = useRightPanelStore.getState().byThreadKey["local:thread-1"];
    recovery.resolve({ url: "https://t3.chat/", managed: false, restored: false });
    const request = await started.promise;
    expect(request.focus?.userActionRevision).toBeLessThan(panel.getUserActionRevision(threadRef));
    if (listFirst) {
      reconcilePreviewServerSessions(threadRef, {
        serverEpoch: "server-a",
        revision: 2,
        sessions: [source, other, snapshot],
      });
    }
    const event = {
      type: "opened" as const,
      threadId: threadRef.threadId,
      tabId: snapshot.tabId,
      snapshot,
      serverEpoch: "server-a",
      revision: 1,
      createdAt: snapshot.updatedAt,
      focus: request.focus,
    };
    applyPreviewServerEvent(threadRef, event);
    const assertSelection = () => {
      expect(readThreadPreviewState(threadRef).activeTabId).toBe(selectedTab);
      const currentPanel = useRightPanelStore.getState().byThreadKey["local:thread-1"];
      expect(currentPanel?.activeSurfaceId).toBe(selectedPanel?.activeSurfaceId);
      expect(currentPanel?.isOpen).toBe(selectedPanel?.isOpen);
    };
    assertSelection();
    reply.resolve(snapshot);
    await opening;
    applyPreviewServerEvent(threadRef, event);
    assertSelection();
    expect(readThreadPreviewState(threadRef).sessions[snapshot.tabId]).toEqual(snapshot);
  },
);

it.each(
  (["older-first", "newer-first"] as const).flatMap((recoveryOrder) =>
    (["older-first", "newer-first"] as const).flatMap((completionOrder) =>
      [false, true].flatMap((olderEventFirst) =>
        [false, true].flatMap((newerEventFirst) =>
          [false, true].map((listFirst) => ({
            recoveryOrder,
            completionOrder,
            olderEventFirst,
            newerEventFirst,
            listFirst,
          })),
        ),
      ),
    ),
  ),
)(
  "keeps the newest foreground request with recovery=$recoveryOrder completion=$completionOrder olderEventFirst=$olderEventFirst newerEventFirst=$newerEventFirst listFirst=$listFirst",
  async ({ recoveryOrder, completionOrder, olderEventFirst, newerEventFirst, listFirst }) => {
    const source = { ...snapshot, tabId: "source-tab" };
    applyPreviewServerSnapshot(threadRef, source);
    useRightPanelStore.getState().openBrowser(threadRef, source.tabId);
    const pages = ["older", "newer"].map((name) => ({
      ...snapshot,
      tabId: name,
      navStatus: { _tag: "Loading" as const, url: `https://app.example/${name}`, title: "" },
    }));
    const listed = pages.map((page) => ({
      ...page,
      navStatus: {
        _tag: "Success" as const,
        url: `https://app.example/${page.tabId}/loaded`,
        title: page.tabId,
      },
      updatedAt: "2026-06-11T23:00:02.000Z",
    }));
    const recoveries = pages.map(() =>
      deferred<{ url: string; managed: boolean; restored: boolean }>(),
    );
    vi.spyOn(hostingRecovery, "prepareHostedPreview")
      .mockReturnValueOnce(recoveries[0]!.promise)
      .mockReturnValueOnce(recoveries[1]!.promise);
    const requests = pages.map(() => deferred<PreviewOpenInput>());
    const replies = pages.map(() => deferred<PreviewSessionSnapshot>());
    const revisions = [0, 0];
    let serverRevision = 0;
    const callbacks = pages.map(() => vi.fn());
    const openings = pages.map((page, index) =>
      openUrlInPreview({
        threadRef,
        url: page.navStatus.url,
        profileId: "source-profile",
        onOpened: callbacks[index]!,
        openPreview: async ({ input }) => {
          revisions[index] = ++serverRevision;
          requests[index]!.resolve(input);
          return AsyncResult.success(await replies[index]!.promise);
        },
      }),
    );
    // Both intents are ordered before either recovery completes; the view stays put.
    const intentRevision = useRightPanelStore.getState().getUserActionRevision(threadRef);
    expect(useRightPanelStore.getState().byThreadKey["local:thread-1"]?.activeSurfaceId).toBe(
      "browser:source-tab",
    );
    for (const index of recoveryOrder === "older-first" ? [0, 1] : [1, 0]) {
      recoveries[index]!.resolve({
        url: pages[index]!.navStatus.url,
        managed: false,
        restored: false,
      });
      await requests[index]!.promise;
    }
    const captured = await Promise.all(requests.map((request) => request.promise));
    expect(captured[0]!.focus!.userActionRevision).toBeLessThan(
      captured[1]!.focus!.userActionRevision,
    );
    expect(captured[1]!.focus!.userActionRevision).toBe(intentRevision);
    expect(captured.every((request) => request.profileId === "source-profile")).toBe(true);
    if (listFirst) {
      reconcilePreviewServerSessions(threadRef, {
        serverEpoch: "server-a",
        revision: 3,
        sessions: [source, ...listed],
      });
    }
    const deliverEvent = (index: number) =>
      applyPreviewServerEvent(threadRef, {
        type: "opened",
        threadId: threadRef.threadId,
        tabId: pages[index]!.tabId,
        snapshot: pages[index]!,
        createdAt: snapshot.updatedAt,
        serverEpoch: "server-a",
        revision: revisions[index]!,
        focus: captured[index]!.focus,
      });
    let newestCompleted = false;
    for (const index of completionOrder === "older-first" ? [0, 1] : [1, 0]) {
      const eventFirst = index === 0 ? olderEventFirst : newerEventFirst;
      if (eventFirst) deliverEvent(index);
      replies[index]!.resolve(pages[index]!);
      await expect(openings[index]).resolves.toMatchObject({ _tag: "Success" });
      newestCompleted ||= index === 1;
      const expected = newestCompleted ? "newer" : source.tabId;
      // Reply-first selection must already work before its event can repair it.
      expect(readThreadPreviewState(threadRef).activeTabId).toBe(expected);
      expect(useRightPanelStore.getState().byThreadKey["local:thread-1"]?.activeSurfaceId).toBe(
        `browser:${expected}`,
      );
      if (!eventFirst) deliverEvent(index);
      const state = readThreadPreviewState(threadRef);
      useRightPanelStore
        .getState()
        .reconcileBrowserSurfaces(
          threadRef,
          Object.keys(state.sessions),
          hiddenPreviewTabIds(state.sessions),
        );
      expect(state.activeTabId).toBe(expected);
      expect(useRightPanelStore.getState().byThreadKey["local:thread-1"]?.activeSurfaceId).toBe(
        `browser:${expected}`,
      );
      expect(useRightPanelStore.getState().getUserActionRevision(threadRef)).toBe(intentRevision);
    }
    const state = readThreadPreviewState(threadRef);
    expect(state.snapshot).toEqual(listFirst ? listed[1] : pages[1]);
    expect(Object.keys(state.sessions).toSorted()).toEqual(["newer", "older", source.tabId]);
    for (const index of [0, 1]) {
      deliverEvent(index);
      expect(callbacks[index]).toHaveBeenCalledExactlyOnceWith(pages[index]!.tabId);
    }
    expect(readThreadPreviewState(threadRef).activeTabId).toBe("newer");
    expect(useRightPanelStore.getState().byThreadKey["local:thread-1"]?.activeSurfaceId).toBe(
      "browser:newer",
    );
  },
);

it.each(
  ["before-foreground", "after-foreground"].flatMap((backgroundCompletion) =>
    ["none", "browser", "terminal", "file", "hide"].map((choice) => ({
      backgroundCompletion,
      choice,
    })),
  ),
)(
  "preserves $choice selection with a subsequent background open completing $backgroundCompletion",
  async ({ backgroundCompletion, choice }) => {
    const source = { ...snapshot, tabId: "source-tab" };
    const other = { ...snapshot, tabId: "other-tab" };
    applyPreviewServerSnapshot(threadRef, other);
    applyPreviewServerSnapshot(threadRef, source);
    useRightPanelStore.getState().openBrowser(threadRef, source.tabId);
    const pages = [snapshot, { ...snapshot, tabId: "background-tab" }];
    const requests = pages.map(() => deferred<PreviewOpenInput>());
    const replies = pages.map(() => deferred<PreviewSessionSnapshot>());
    const foreground = openUrlInPreview({
      threadRef,
      url: "https://app.example/foreground",
      openPreview: async ({ input }) => {
        requests[0]!.resolve(input);
        return AsyncResult.success(await replies[0]!.promise);
      },
    });
    const foregroundRevision = useRightPanelStore.getState().getUserActionRevision(threadRef);
    const background = openUrlInPreview({
      threadRef,
      url: "https://app.example/background",
      background: true,
      openPreview: async ({ input }) => {
        requests[1]!.resolve(input);
        return AsyncResult.success(await replies[1]!.promise);
      },
    });
    expect(useRightPanelStore.getState().getUserActionRevision(threadRef)).toBe(foregroundRevision);
    const panel = useRightPanelStore.getState();
    if (choice === "browser") {
      setActivePreviewTab(threadRef, other.tabId);
      panel.openBrowser(threadRef, other.tabId);
    }
    if (choice === "terminal") panel.openTerminal(threadRef, "terminal-1");
    if (choice === "file") panel.openFile(threadRef, "src/app.ts");
    if (choice === "hide") panel.close(threadRef);
    const chosenTab = readThreadPreviewState(threadRef).activeTabId;
    const chosenPanel = useRightPanelStore.getState().byThreadKey["local:thread-1"];
    const captured = await Promise.all(requests.map((request) => request.promise));
    expect(captured[1]!.focus!.userActionRevision).toBe(foregroundRevision);
    const openings = [foreground, background];
    for (const index of backgroundCompletion === "before-foreground" ? [1, 0] : [0, 1]) {
      applyPreviewServerEvent(threadRef, {
        type: "opened",
        threadId: threadRef.threadId,
        tabId: pages[index]!.tabId,
        snapshot: pages[index]!,
        createdAt: snapshot.updatedAt,
        serverEpoch: "server-a",
        revision: index + 1,
        focus: captured[index]!.focus,
        background: index === 1,
      });
      replies[index]!.resolve(pages[index]!);
      await openings[index];
    }
    const state = readThreadPreviewState(threadRef);
    useRightPanelStore
      .getState()
      .reconcileBrowserSurfaces(
        threadRef,
        Object.keys(state.sessions),
        hiddenPreviewTabIds(state.sessions),
      );
    expect(state.activeTabId).toBe(choice === "none" ? snapshot.tabId : chosenTab);
    const currentPanel = useRightPanelStore.getState().byThreadKey["local:thread-1"];
    expect(currentPanel?.activeSurfaceId).toBe(
      choice === "none" ? `browser:${snapshot.tabId}` : chosenPanel?.activeSurfaceId,
    );
    expect(currentPanel?.isOpen).toBe(chosenPanel?.isOpen);
    expect(currentPanel?.surfaces.some((surface) => surface.id === "browser:background-tab")).toBe(
      true,
    );
  },
);

it.each(
  [0, 1].flatMap((fileIndex) =>
    [false, true].map((newerCompletesFirst) => ({ fileIndex, newerCompletesFirst })),
  ),
)(
  "orders file/link requests before asset creation (file index $fileIndex, newer first $newerCompletesFirst)",
  async ({ fileIndex, newerCompletesFirst }) => {
    vi.spyOn(previewRuntime, "isPreviewAvailableFor").mockReturnValue(true);
    const source = { ...snapshot, tabId: "source-tab" };
    applyPreviewServerSnapshot(threadRef, source);
    useRightPanelStore.getState().openBrowser(threadRef, source.tabId);
    const pages = ["older", "newer"].map((tabId) => ({ ...snapshot, tabId }));
    const asset = deferred<AssetCreateUrlResult>();
    const requests = pages.map(() => deferred<PreviewOpenInput>());
    const replies = pages.map(() => deferred<PreviewSessionSnapshot>());
    const openings = pages.map((page, index) => {
      const openPreview = async ({ input }: { input: PreviewOpenInput }) => {
        requests[index]!.resolve(input);
        return AsyncResult.success(await replies[index]!.promise);
      };
      return index === fileIndex
        ? openFileInPreview({
            threadRef,
            filePath: "/workspace/page.html",
            canReadFiles: true,
            workspaceRoot: "/workspace",
            httpBaseUrl: "https://environment.example",
            openPreview,
            createAssetUrl: async () => AsyncResult.success(await asset.promise),
          })
        : openUrlInPreview({ threadRef, url: `https://app.example/${page.tabId}`, openPreview });
    });
    // The file's asset result comes after the link's RPC starts, whichever request is newer.
    await requests[1 - fileIndex]!.promise;
    const intentRevision = useRightPanelStore.getState().getUserActionRevision(threadRef);
    asset.resolve({ relativeUrl: "/api/assets/example", expiresAt: 0 });
    const captured = await Promise.all(requests.map((request) => request.promise));
    expect(captured[0]!.focus!.userActionRevision).toBeLessThan(
      captured[1]!.focus!.userActionRevision,
    );
    expect(useRightPanelStore.getState().getUserActionRevision(threadRef)).toBe(intentRevision);
    let newerCompleted = false;
    for (const index of newerCompletesFirst ? [1, 0] : [0, 1]) {
      replies[index]!.resolve(pages[index]!);
      await expect(openings[index]).resolves.toMatchObject({ _tag: "Success" });
      applyPreviewServerEvent(threadRef, {
        type: "opened",
        threadId: threadRef.threadId,
        tabId: pages[index]!.tabId,
        snapshot: pages[index]!,
        createdAt: snapshot.updatedAt,
        serverEpoch: "server-a",
        revision: index + 1,
        focus: captured[index]!.focus,
      });
      newerCompleted ||= index === 1;
      const expected = newerCompleted ? "newer" : source.tabId;
      expect(readThreadPreviewState(threadRef).activeTabId).toBe(expected);
      expect(useRightPanelStore.getState().byThreadKey["local:thread-1"]?.activeSurfaceId).toBe(
        `browser:${expected}`,
      );
    }
  },
);

it("keeps foreign-client foreground focus when an older local request completes", async () => {
  const source = { ...snapshot, tabId: "source-tab" };
  applyPreviewServerSnapshot(threadRef, source);
  useRightPanelStore.getState().openBrowser(threadRef, source.tabId);
  const started = deferred<PreviewOpenInput>();
  const reply = deferred<PreviewSessionSnapshot>();
  const older = { ...snapshot, tabId: "older-local" };
  const opening = openUrlInPreview({
    threadRef,
    url: "https://app.example/older",
    openPreview: async ({ input }) => {
      started.resolve(input);
      return AsyncResult.success(await reply.promise);
    },
  });
  const request = await started.promise;
  await openUrlInPreview({
    threadRef,
    url: "https://app.example/newer",
    openPreview: async () => AsyncResult.success({ ...snapshot, tabId: "newer-local" }),
  });
  useRightPanelStore.getState().openFile(threadRef, "src/app.ts");
  const foreign = { ...snapshot, tabId: "foreign-client" };
  applyPreviewServerEvent(threadRef, {
    type: "opened",
    threadId: threadRef.threadId,
    tabId: foreign.tabId,
    snapshot: foreign,
    createdAt: snapshot.updatedAt,
    serverEpoch: "server-a",
    revision: 2,
    focus: { clientId: "another-client", userActionRevision: 0 },
  });
  expect(readThreadPreviewState(threadRef).activeTabId).toBe(foreign.tabId);
  expect(useRightPanelStore.getState().byThreadKey["local:thread-1"]?.activeSurfaceId).toBe(
    `browser:${foreign.tabId}`,
  );
  reply.resolve(older);
  await opening;
  applyPreviewServerEvent(threadRef, {
    type: "opened",
    threadId: threadRef.threadId,
    tabId: older.tabId,
    snapshot: older,
    createdAt: snapshot.updatedAt,
    serverEpoch: "server-a",
    revision: 1,
    focus: request.focus,
  });
  expect(readThreadPreviewState(threadRef).activeTabId).toBe(foreign.tabId);
  expect(useRightPanelStore.getState().byThreadKey["local:thread-1"]?.activeSurfaceId).toBe(
    `browser:${foreign.tabId}`,
  );
});

it.each(
  (["recovery", "rpc"] as const).flatMap((delay) =>
    [false, true].flatMap((listFirst) =>
      [false, true].flatMap((localEventFirst) =>
        [false, true].map((laterLocal) => ({ delay, listFirst, localEventFirst, laterLocal })),
      ),
    ),
  ),
)(
  "foreign foreground focus supersedes a local $delay wait (listFirst=$listFirst eventFirst=$localEventFirst laterLocal=$laterLocal)",
  async ({ delay, listFirst, localEventFirst, laterLocal }) => {
    const source = { ...snapshot, tabId: "source-tab" };
    const older = { ...snapshot, tabId: "older-local" };
    const foreign = { ...snapshot, tabId: "foreign-client" };
    const listedForeign = {
      ...foreign,
      navStatus: {
        _tag: "Success" as const,
        url: "https://app.example/foreign/loaded",
        title: "Foreign",
      },
      updatedAt: "2026-06-11T23:00:02.000Z",
    };
    applyPreviewServerSnapshot(threadRef, source);
    useRightPanelStore.getState().openBrowser(threadRef, source.tabId);
    const recovery = deferred<{ url: string; managed: boolean; restored: boolean }>();
    vi.spyOn(hostingRecovery, "prepareHostedPreview")
      .mockResolvedValue({ url: "https://app.example/newer", managed: false, restored: false })
      .mockReturnValueOnce(recovery.promise);
    const olderStarted = deferred<PreviewOpenInput>();
    const olderReply = deferred<PreviewSessionSnapshot>();
    const olderOpening = openUrlInPreview({
      threadRef,
      url: "https://app.example/older",
      openPreview: async ({ input }) => {
        olderStarted.resolve(input);
        return AsyncResult.success(await olderReply.promise);
      },
    });
    const olderRevision = useRightPanelStore.getState().getUserActionRevision(threadRef);
    if (delay === "rpc") {
      recovery.resolve({ url: "https://app.example/older", managed: false, restored: false });
      await olderStarted.promise;
    }
    if (listFirst) {
      reconcilePreviewServerSessions(threadRef, {
        serverEpoch: "server-a",
        revision: 2,
        sessions: [source, listedForeign],
      });
    }
    const foreignEvent = {
      type: "opened" as const,
      threadId: threadRef.threadId,
      tabId: foreign.tabId,
      snapshot: foreign,
      createdAt: foreign.updatedAt,
      serverEpoch: "server-a",
      revision: 1,
      focus: { clientId: "another-client", userActionRevision: 0 },
    };
    applyPreviewServerEvent(threadRef, foreignEvent);
    expect(useRightPanelStore.getState().getUserActionRevision(threadRef)).toBe(olderRevision + 1);
    const assertDisplayed = (tabId: string) => {
      expect(readThreadPreviewState(threadRef).activeTabId).toBe(tabId);
      expect(useRightPanelStore.getState().byThreadKey["local:thread-1"]?.activeSurfaceId).toBe(
        `browser:${tabId}`,
      );
    };
    assertDisplayed(foreign.tabId);
    expect(readThreadPreviewState(threadRef).snapshot).toEqual(listFirst ? listedForeign : foreign);
    applyPreviewServerEvent(threadRef, foreignEvent);
    expect(useRightPanelStore.getState().getUserActionRevision(threadRef)).toBe(olderRevision + 1);
    const newer = { ...snapshot, tabId: "newer-local" };
    const newerStarted = deferred<PreviewOpenInput>();
    const newerReply = deferred<PreviewSessionSnapshot>();
    const newerOpening = laterLocal
      ? openUrlInPreview({
          threadRef,
          url: "https://app.example/newer",
          openPreview: async ({ input }) => {
            newerStarted.resolve(input);
            return AsyncResult.success(await newerReply.promise);
          },
        })
      : undefined;
    const currentRevision = useRightPanelStore.getState().getUserActionRevision(threadRef);
    // A replay received after a newer local start must not supersede that request again.
    applyPreviewServerEvent(threadRef, foreignEvent);
    expect(useRightPanelStore.getState().getUserActionRevision(threadRef)).toBe(currentRevision);
    recovery.resolve({ url: "https://app.example/older", managed: false, restored: false });
    const olderRequest = await olderStarted.promise;
    expect(olderRequest.focus!.userActionRevision).toBeLessThan(currentRevision);
    const localEvent = {
      type: "opened" as const,
      threadId: threadRef.threadId,
      tabId: older.tabId,
      snapshot: older,
      createdAt: older.updatedAt,
      serverEpoch: "server-a",
      revision: 2,
      focus: olderRequest.focus,
    };
    if (localEventFirst) {
      applyPreviewServerEvent(threadRef, localEvent);
      assertDisplayed(foreign.tabId);
    }
    olderReply.resolve(older);
    await expect(olderOpening).resolves.toMatchObject({ _tag: "Success" });
    assertDisplayed(foreign.tabId);
    if (!localEventFirst) applyPreviewServerEvent(threadRef, localEvent);
    assertDisplayed(foreign.tabId);
    expect(readThreadPreviewState(threadRef).sessions[older.tabId]).toEqual(older);
    if (laterLocal) {
      const newerRequest = await newerStarted.promise;
      expect(newerRequest.focus!.userActionRevision).toBe(currentRevision);
      newerReply.resolve(newer);
      await newerOpening;
      assertDisplayed(newer.tabId);
      applyPreviewServerEvent(threadRef, {
        type: "opened",
        threadId: threadRef.threadId,
        tabId: newer.tabId,
        snapshot: newer,
        createdAt: newer.updatedAt,
        serverEpoch: "server-a",
        revision: 3,
        focus: newerRequest.focus,
      });
      applyPreviewServerEvent(threadRef, foreignEvent);
      applyPreviewServerEvent(threadRef, localEvent);
      assertDisplayed(newer.tabId);
    }
    expect(useRightPanelStore.getState().getUserActionRevision(threadRef)).toBe(currentRevision);
  },
);

it.each(["background", "hidden"] as const)(
  "does not invalidate a pending local foreground open for foreign %s creation",
  async (kind) => {
    const source = { ...snapshot, tabId: "source-tab" };
    applyPreviewServerSnapshot(threadRef, source);
    useRightPanelStore.getState().openBrowser(threadRef, source.tabId);
    const started = deferred<PreviewOpenInput>();
    const reply = deferred<PreviewSessionSnapshot>();
    const opening = openUrlInPreview({
      threadRef,
      url: "https://app.example/local",
      openPreview: async ({ input }) => {
        started.resolve(input);
        return AsyncResult.success(await reply.promise);
      },
    });
    const request = await started.promise;
    const revision = useRightPanelStore.getState().getUserActionRevision(threadRef);
    const foreign = {
      ...snapshot,
      tabId: "foreign-tab",
      runtime: "server" as const,
      ...(kind === "hidden" ? { reveal: false } : {}),
    };
    applyPreviewServerEvent(threadRef, {
      type: "opened",
      threadId: threadRef.threadId,
      tabId: foreign.tabId,
      snapshot: foreign,
      createdAt: foreign.updatedAt,
      serverEpoch: "server-a",
      revision: 1,
      focus: { clientId: "another-client", userActionRevision: 0 },
      background: kind === "background",
    });
    expect(useRightPanelStore.getState().getUserActionRevision(threadRef)).toBe(revision);
    expect(readThreadPreviewState(threadRef).activeTabId).toBe(source.tabId);
    reply.resolve(snapshot);
    await opening;
    applyPreviewServerEvent(threadRef, {
      type: "opened",
      threadId: threadRef.threadId,
      tabId: snapshot.tabId,
      snapshot,
      createdAt: snapshot.updatedAt,
      serverEpoch: "server-a",
      revision: 2,
      focus: request.focus,
    });
    const state = readThreadPreviewState(threadRef);
    useRightPanelStore
      .getState()
      .reconcileBrowserSurfaces(
        threadRef,
        Object.keys(state.sessions),
        hiddenPreviewTabIds(state.sessions),
      );
    expect(state.activeTabId).toBe(snapshot.tabId);
    const panel = useRightPanelStore.getState().byThreadKey["local:thread-1"];
    expect(panel?.activeSurfaceId).toBe(`browser:${snapshot.tabId}`);
    expect(panel?.surfaces.some((surface) => surface.id === `browser:${foreign.tabId}`)).toBe(
      kind === "background",
    );
    expect(useRightPanelStore.getState().getUserActionRevision(threadRef)).toBe(revision);
  },
);
