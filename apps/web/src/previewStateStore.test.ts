import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type EnvironmentId,
  type PreviewEvent,
  type PreviewSessionSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { setPreviewBootstrapTokenOnUrl } from "@t3tools/shared/remote";

import {
  __testing,
  applyPreviewDesktopState,
  applyPreviewServerEvent as applyPreviewServerEventImpl,
  applyPreviewServerSnapshot,
  beginPreviewSessionClose,
  cancelPreviewSessionClose,
  capturePreviewOpenFocus,
  hiddenPreviewTabIds,
  previewStateAtom,
  readThreadPreviewState,
  reconcilePreviewEnvironmentSessions,
  reconcilePreviewServerSessions,
  rememberPreviewUrl,
  resetPreviewStateForTests,
  resetPreviewServerEpoch,
  setActivePreviewTab,
  updatePreviewServerSnapshot,
} from "./previewStateStore";
import { appAtomRegistry } from "./rpc/atomRegistry";
import {
  selectActiveRightPanelSurface,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "./rightPanelStore";

it.each(["same", "other"] as const)(
  "accepts foreground focus from the %s client when its origin has not been superseded",
  (origin) => {
    const source = makeSnapshot({ tabId: "source-focus" });
    const destination = makeSnapshot({ tabId: "destination-focus" });
    applyPreviewServerSnapshot(ref, source);
    useRightPanelStore.getState().openBrowser(ref, source.tabId);
    const capturedFocus = capturePreviewOpenFocus(ref);
    const focus =
      origin === "other" ? { ...capturedFocus, clientId: "another-client" } : capturedFocus;
    if (origin === "other") {
      useRightPanelStore.getState().openFile(ref, "src/app.ts");
    }
    const revision = useRightPanelStore.getState().getUserActionRevision(ref);
    applyPreviewServerEvent(ref, {
      type: "opened",
      threadId: ref.threadId,
      tabId: destination.tabId,
      snapshot: destination,
      createdAt: destination.updatedAt,
      focus,
    });
    expect(readThreadPreviewState(ref).activeTabId).toBe(destination.tabId);
    expect(
      selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, ref),
    ).toMatchObject({ kind: "preview", resourceId: destination.tabId });
    expect(useRightPanelStore.getState().getUserActionRevision(ref)).toBe(
      revision + (origin === "other" ? 1 : 0),
    );
  },
);

// ChatView's resource-only reconciliation may run well after an opened event.
const reconcilePanel = (): void => {
  const state = readThreadPreviewState(ref);
  useRightPanelStore
    .getState()
    .reconcileBrowserSurfaces(
      ref,
      Object.keys(state.sessions),
      hiddenPreviewTabIds(state.sessions),
    );
};

const environmentId = "env-1" as EnvironmentId;
const ref = scopeThreadRef(environmentId, ThreadId.make("thread-1"));
const otherRef = scopeThreadRef(environmentId, ThreadId.make("thread-2"));

const makeSnapshot = (overrides: Partial<PreviewSessionSnapshot> = {}): PreviewSessionSnapshot => ({
  threadId: "thread-1",
  tabId: "tab_a",
  navStatus: { _tag: "Loading", url: "http://localhost:5173/", title: "" },
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

type PreviewEventDraft = PreviewEvent extends infer Event
  ? Event extends { readonly revision: number }
    ? Omit<Event, "revision" | "serverEpoch">
    : never
  : never;

const serverEpoch = "server-a";
let nextServerRevision = 0;
const applyPreviewServerEvent = (eventRef: typeof ref, event: PreviewEventDraft): void => {
  nextServerRevision += 1;
  applyPreviewServerEventImpl(eventRef, {
    ...event,
    serverEpoch,
    revision: nextServerRevision,
  } as PreviewEvent);
};

beforeEach(() => {
  nextServerRevision = 0;
  resetPreviewStateForTests();
  useRightPanelStore.setState({
    byThreadKey: {},
    threadPanelVisibilityByThreadKey: {},
    userActionRevisionByThreadKey: {},
    closeRevisionByThreadKey: {},
  });
});

it("keeps bootstrap credentials out of recent addresses across loading and success", () => {
  const destination =
    "http://localhost:5173/project?token=application-code&view=qa#token=invite-code";
  const navigationUrl = setPreviewBootstrapTokenOnUrl(new URL(destination), "one-use-secret").href;
  applyPreviewServerSnapshot(
    ref,
    makeSnapshot({
      navStatus: { _tag: "Loading", url: navigationUrl, title: "" },
    }),
  );
  expect(readThreadPreviewState(ref).recentlySeenUrls).toEqual([destination]);
  applyPreviewServerSnapshot(
    ref,
    makeSnapshot({
      navStatus: { _tag: "Success", url: destination, title: "QA" },
      updatedAt: "2026-01-01T00:00:01.000Z",
    }),
  );
  expect(readThreadPreviewState(ref).recentlySeenUrls).toEqual([destination]);
});
it("preserves application tokens in recent preview destinations", () => {
  const urls = [
    "https://app.example/reset?token=first-code",
    "https://app.example/reset?token=second-code",
    "https://app.example/invite#token=invite-code",
  ];
  for (const url of urls) rememberPreviewUrl(ref, url);
  expect(readThreadPreviewState(ref).recentlySeenUrls).toEqual(urls.toReversed());
});

it("drops a restarted server's desktop pages without resetting another environment", () => {
  const remoteRef = scopeThreadRef("remote" as EnvironmentId, ref.threadId);
  reconcilePreviewServerSessions(ref, {
    serverEpoch,
    revision: 1,
    sessions: [makeSnapshot()],
  });
  reconcilePreviewServerSessions(otherRef, {
    serverEpoch,
    revision: 1,
    sessions: [makeSnapshot({ threadId: otherRef.threadId, tabId: "background" })],
  });
  reconcilePreviewServerSessions(remoteRef, {
    serverEpoch,
    revision: 1,
    sessions: [makeSnapshot({ tabId: "remote-tab" })],
  });

  expect(resetPreviewServerEpoch(environmentId, "server-b")).toEqual([ref, otherRef]);
  expect(readThreadPreviewState(ref)).toMatchObject({
    sessions: {},
    serverEpoch: "server-b",
    serverRevision: 0,
    listLoaded: false,
  });
  expect(readThreadPreviewState(otherRef).sessions).toEqual({});
  expect(readThreadPreviewState(ref).recentlySeenUrls).toEqual(["http://localhost:5173/"]);
  expect(readThreadPreviewState(remoteRef).snapshot?.tabId).toBe("remote-tab");
});

it("rejects completed environment and thread lists from a retired primary epoch", () => {
  const oldSnapshot = makeSnapshot();
  reconcilePreviewEnvironmentSessions(environmentId, {
    serverEpoch,
    revision: 10,
    sessions: [oldSnapshot],
  });
  resetPreviewServerEpoch(environmentId, "server-b");
  const newSnapshot = makeSnapshot({ tabId: "restarted-tab" });
  reconcilePreviewEnvironmentSessions(environmentId, {
    serverEpoch: "server-b",
    revision: 1,
    sessions: [newSnapshot],
  });
  const staleResult = { serverEpoch, revision: 100, sessions: [oldSnapshot] };
  reconcilePreviewEnvironmentSessions(environmentId, staleResult);
  reconcilePreviewServerSessions(ref, staleResult);
  resetPreviewServerEpoch(environmentId, serverEpoch);
  expect(readThreadPreviewState(ref)).toMatchObject({
    serverEpoch: "server-b",
    sessions: { "restarted-tab": newSnapshot },
    serverRevision: 1,
  });
});

it("hydrates unseen threads and reconciles missing tabs without overwriting newer events", () => {
  const remoteRef = scopeThreadRef("remote" as EnvironmentId, ref.threadId);
  reconcilePreviewServerSessions(remoteRef, {
    serverEpoch,
    revision: 1,
    sessions: [makeSnapshot({ tabId: "remote-tab" })],
  });
  reconcilePreviewEnvironmentSessions(environmentId, {
    serverEpoch,
    revision: 1,
    sessions: [makeSnapshot(), makeSnapshot({ threadId: otherRef.threadId, tabId: "background" })],
  });
  expect(readThreadPreviewState(otherRef).snapshot?.tabId).toBe("background");
  applyPreviewServerEventImpl(ref, {
    type: "opened",
    serverEpoch,
    revision: 3,
    threadId: ref.threadId,
    tabId: "newer-tab",
    snapshot: makeSnapshot({ tabId: "newer-tab" }),
    createdAt: "2026-10-06T00:00:00.000Z",
  });
  reconcilePreviewEnvironmentSessions(environmentId, {
    serverEpoch,
    revision: 2,
    sessions: [makeSnapshot()],
  });
  expect(readThreadPreviewState(ref).snapshot?.tabId).toBe("newer-tab");
  expect(readThreadPreviewState(otherRef).sessions).toEqual({});
  expect(readThreadPreviewState(remoteRef).snapshot?.tabId).toBe("remote-tab");
});

it("requests another baseline when a live event overtakes the first environment list", () => {
  const live = makeSnapshot({ tabId: "live-tab" });
  applyPreviewServerEventImpl(ref, {
    type: "opened",
    serverEpoch,
    revision: 2,
    threadId: ref.threadId,
    tabId: live.tabId,
    snapshot: live,
    createdAt: live.updatedAt,
  });
  expect(
    reconcilePreviewEnvironmentSessions(environmentId, {
      serverEpoch,
      revision: 1,
      sessions: [makeSnapshot()],
    }),
  ).toBe(false);
  expect(readThreadPreviewState(ref).sessions).toEqual({ "live-tab": live });
  expect(
    reconcilePreviewEnvironmentSessions(environmentId, {
      serverEpoch,
      revision: 2,
      sessions: [makeSnapshot(), live],
    }),
  ).toBe(true);
  expect(Object.keys(readThreadPreviewState(ref).sessions)).toEqual(["tab_a", "live-tab"]);
  expect(readThreadPreviewState(ref).listLoaded).toBe(true);
});

describe("previewStateStore (single-tab)", () => {
  it("keeps independent state atoms for each thread", () => {
    expect(previewStateAtom(scopedThreadKey(ref))).toBe(previewStateAtom(scopedThreadKey(ref)));
    expect(previewStateAtom(scopedThreadKey(ref))).not.toBe(
      previewStateAtom(scopedThreadKey(otherRef)),
    );

    applyPreviewServerSnapshot(ref, makeSnapshot());
    expect(readThreadPreviewState(ref).snapshot?.tabId).toBe("tab_a");
    expect(readThreadPreviewState(otherRef)).toEqual(__testing.EMPTY_THREAD_PREVIEW_STATE);
  });

  it("opened event seeds the snapshot and remembers the URL", () => {
    const snapshot = makeSnapshot();
    applyPreviewServerEvent(ref, {
      type: "opened",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: snapshot.updatedAt,
      snapshot,
    });
    const state = readThreadPreviewState(ref);
    expect(state.snapshot?.tabId).toBe(snapshot.tabId);
    expect(state.recentlySeenUrls).toContain("http://localhost:5173/");
  });

  it("a second `opened` for a different tab replaces the rendered snapshot", () => {
    const a = makeSnapshot({ tabId: "tab_a" });
    const b = makeSnapshot({ tabId: "tab_b" });
    applyPreviewServerEvent(ref, {
      type: "opened",
      threadId: "thread-1",
      tabId: a.tabId,
      createdAt: a.updatedAt,
      snapshot: a,
    });
    applyPreviewServerEvent(ref, {
      type: "opened",
      threadId: "thread-1",
      tabId: b.tabId,
      createdAt: b.updatedAt,
      snapshot: b,
    });
    const state = readThreadPreviewState(ref);
    expect(state.snapshot?.tabId).toBe(b.tabId);
  });

  it("navigated event updates the snapshot URL", () => {
    const snapshot = makeSnapshot();
    applyPreviewServerEvent(ref, {
      type: "opened",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: snapshot.updatedAt,
      snapshot,
    });
    applyPreviewServerEvent(ref, {
      type: "navigated",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: "2026-01-01T00:00:01.000Z",
      snapshot: {
        ...snapshot,
        navStatus: { _tag: "Success", url: "http://localhost:5173/about", title: "About" },
      },
    });
    const state = readThreadPreviewState(ref);
    expect(state.snapshot?.navStatus._tag).toBe("Success");
    if (state.snapshot?.navStatus._tag === "Success") {
      expect(state.snapshot.navStatus.url).toBe("http://localhost:5173/about");
    }
  });

  it("resized event updates tab viewport without changing the active tab", () => {
    const active = makeSnapshot({ tabId: "tab_a" });
    const background = makeSnapshot({ tabId: "tab_b" });
    applyPreviewServerSnapshot(ref, background);
    applyPreviewServerSnapshot(ref, active);

    applyPreviewServerEvent(ref, {
      type: "resized",
      threadId: "thread-1",
      tabId: background.tabId,
      createdAt: "2026-01-01T00:00:01.000Z",
      snapshot: {
        ...background,
        viewport: { _tag: "preset", presetId: "pixel-8", width: 412, height: 915 },
        updatedAt: "2026-01-01T00:00:01.000Z",
      },
    });

    const state = readThreadPreviewState(ref);
    expect(state.activeTabId).toBe(active.tabId);
    expect(state.sessions[background.tabId]?.viewport).toEqual({
      _tag: "preset",
      presetId: "pixel-8",
      width: 412,
      height: 915,
    });
  });

  it("failed event flips the snapshot to LoadFailed when tabId matches", () => {
    const snapshot = makeSnapshot();
    applyPreviewServerEvent(ref, {
      type: "opened",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: snapshot.updatedAt,
      snapshot,
    });
    applyPreviewServerEvent(ref, {
      type: "failed",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: "2026-01-01T00:00:01.000Z",
      url: "http://localhost:5173/",
      title: "",
      code: -105,
      description: "ERR_NAME_NOT_RESOLVED",
    });
    const state = readThreadPreviewState(ref);
    expect(state.snapshot?.navStatus._tag).toBe("LoadFailed");
  });

  it("failed event for a non-active tab is ignored", () => {
    const snapshot = makeSnapshot({ tabId: "tab_a" });
    applyPreviewServerEvent(ref, {
      type: "opened",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: snapshot.updatedAt,
      snapshot,
    });
    applyPreviewServerEvent(ref, {
      type: "failed",
      threadId: "thread-1",
      tabId: "tab_b",
      createdAt: "2026-01-01T00:00:01.000Z",
      url: "http://localhost:9999/",
      title: "",
      code: -105,
      description: "ERR_NAME_NOT_RESOLVED",
    });
    const state = readThreadPreviewState(ref);
    expect(state.snapshot?.navStatus._tag).toBe("Loading");
  });

  it("closed event clears snapshot but retains recently-seen URLs", () => {
    const snapshot = makeSnapshot();
    applyPreviewServerEvent(ref, {
      type: "opened",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: snapshot.updatedAt,
      snapshot,
    });
    applyPreviewServerEvent(ref, {
      type: "closed",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    const state = readThreadPreviewState(ref);
    expect(state.snapshot).toBeNull();
    expect(state.recentlySeenUrls).toContain("http://localhost:5173/");
  });

  it("optimistically removes a session before the server close event arrives", () => {
    const first = makeSnapshot({ tabId: "tab_a" });
    const second = makeSnapshot({
      tabId: "tab_b",
      updatedAt: "2026-01-01T00:00:01.000Z",
    });
    applyPreviewServerSnapshot(ref, first);
    applyPreviewServerSnapshot(ref, second);

    beginPreviewSessionClose(ref, second.tabId);

    const state = readThreadPreviewState(ref);
    expect(Object.keys(state.sessions)).toEqual([first.tabId]);
    expect(state.activeTabId).toBe(first.tabId);
    expect(state.snapshot?.tabId).toBe(first.tabId);
  });

  it("treats a late server close event after optimistic removal as a no-op", () => {
    const snapshot = makeSnapshot();
    applyPreviewServerSnapshot(ref, snapshot);
    beginPreviewSessionClose(ref, snapshot.tabId);

    applyPreviewServerEvent(ref, {
      type: "closed",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: "2026-01-01T00:00:01.000Z",
    });

    const state = readThreadPreviewState(ref);
    expect(state.sessions).toEqual({});
    expect(state.snapshot).toBeNull();
  });

  it("does not resurrect an intentionally closed tab from a stale list snapshot", () => {
    const snapshot = makeSnapshot();
    applyPreviewServerSnapshot(ref, snapshot);
    beginPreviewSessionClose(ref, snapshot.tabId);

    applyPreviewServerSnapshot(ref, snapshot);

    const state = readThreadPreviewState(ref);
    expect(state.sessions).toEqual({});
    expect(state.snapshot).toBeNull();
  });

  it("can restore a suppressed tab after a failed close", () => {
    const snapshot = makeSnapshot();
    applyPreviewServerSnapshot(ref, snapshot);
    beginPreviewSessionClose(ref, snapshot.tabId);

    cancelPreviewSessionClose(ref, snapshot, snapshot.tabId);

    const state = readThreadPreviewState(ref);
    expect(state.sessions).toEqual({ [snapshot.tabId]: snapshot });
    expect(state.snapshot).toEqual(snapshot);
  });

  it("closed event for a different tab is a no-op", () => {
    const snapshot = makeSnapshot({ tabId: "tab_a" });
    applyPreviewServerEvent(ref, {
      type: "opened",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: snapshot.updatedAt,
      snapshot,
    });
    applyPreviewServerEvent(ref, {
      type: "closed",
      threadId: "thread-1",
      tabId: "tab_b",
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    const state = readThreadPreviewState(ref);
    expect(state.snapshot?.tabId).toBe(snapshot.tabId);
  });

  it("desktopOverlay updates independently of snapshot", () => {
    const snapshot = makeSnapshot();
    applyPreviewServerEvent(ref, {
      type: "opened",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: snapshot.updatedAt,
      snapshot,
    });
    applyPreviewDesktopState(ref, snapshot.tabId, {
      hasWebContents: true,
      canGoBack: true,
      canGoForward: false,
      loading: false,
      zoomFactor: 1,
      pictureInPicture: false,
      colorScheme: "system",
      audioMuted: false,
      audible: false,
      controller: "none",
      favicon: null,
    });
    const state = readThreadPreviewState(ref);
    expect(state.desktopOverlay?.canGoBack).toBe(true);
    expect(state.snapshot?.canGoBack).toBe(false);
  });

  it("does not publish duplicate desktop browser state", () => {
    const snapshot = makeSnapshot();
    applyPreviewServerSnapshot(ref, snapshot);
    const overlay = {
      hasWebContents: true,
      canGoBack: true,
      canGoForward: false,
      loading: false,
      zoomFactor: 1,
      pictureInPicture: false,
      colorScheme: "system" as const,
      audioMuted: false,
      audible: false,
      controller: "none" as const,
      favicon: {
        dataUrl: "data:image/png;base64,AA==",
        pageUrl: "https://example.com",
        capturedAt: 1,
      },
    };
    let updateCount = 0;
    const unsubscribe = appAtomRegistry.subscribe(previewStateAtom(scopedThreadKey(ref)), () => {
      updateCount += 1;
    });

    applyPreviewDesktopState(ref, snapshot.tabId, overlay);
    applyPreviewDesktopState(ref, snapshot.tabId, { ...overlay, favicon: { ...overlay.favicon } });
    unsubscribe();

    expect(updateCount).toBe(1);
  });

  it("retains multiple tabs and switches active desktop state", () => {
    const first = makeSnapshot();
    const second = { ...makeSnapshot(), tabId: "tab_2", updatedAt: "2026-01-02T00:00:00.000Z" };
    applyPreviewServerSnapshot(ref, first);
    applyPreviewServerSnapshot(ref, second);
    applyPreviewDesktopState(ref, first.tabId, {
      hasWebContents: true,
      canGoBack: true,
      canGoForward: false,
      loading: false,
      zoomFactor: 1,
      pictureInPicture: false,
      colorScheme: "system",
      audioMuted: false,
      audible: false,
      controller: "none",
      favicon: null,
    });
    setActivePreviewTab(ref, first.tabId);

    const state = readThreadPreviewState(ref);
    expect(Object.keys(state.sessions)).toEqual([first.tabId, second.tabId]);
    expect(state.snapshot?.tabId).toBe(first.tabId);
    expect(state.desktopOverlay?.canGoBack).toBe(true);
  });

  it("updates a background snapshot without changing the active tab", () => {
    const background = makeSnapshot({ tabId: "tab_a" });
    const active = makeSnapshot({
      tabId: "tab_b",
      updatedAt: "2026-01-01T00:00:01.000Z",
    });
    applyPreviewServerSnapshot(ref, background);
    applyPreviewServerSnapshot(ref, active);

    const resized = {
      ...background,
      viewport: { _tag: "freeform" as const, width: 900, height: 700 },
      updatedAt: "2026-01-01T00:00:02.000Z",
    };
    updatePreviewServerSnapshot(ref, resized);

    const state = readThreadPreviewState(ref);
    expect(state.activeTabId).toBe(active.tabId);
    expect(state.snapshot?.tabId).toBe(active.tabId);
    expect(state.sessions[background.tabId]).toEqual(resized);
  });

  it("reconciles an authoritative session list without focusing a background tab", () => {
    const active = makeSnapshot({ tabId: "tab_a" });
    const stale = makeSnapshot({
      tabId: "tab_stale",
      updatedAt: "2026-01-01T00:00:01.000Z",
    });
    applyPreviewServerSnapshot(ref, stale);
    applyPreviewServerSnapshot(ref, active);
    applyPreviewDesktopState(ref, stale.tabId, {
      hasWebContents: true,
      canGoBack: false,
      canGoForward: false,
      loading: false,
      zoomFactor: 1,
      pictureInPicture: false,
      colorScheme: "system",
      audioMuted: false,
      audible: false,
      controller: "none",
      favicon: null,
    });

    reconcilePreviewServerSessions(ref, { sessions: [active], serverEpoch, revision: 1 });

    const state = readThreadPreviewState(ref);
    expect(Object.keys(state.sessions)).toEqual([active.tabId]);
    expect(state.activeTabId).toBe(active.tabId);
    expect(state.snapshot).toEqual(active);
    expect(state.desktopByTabId[stale.tabId]).toBeUndefined();
  });

  it("clears stale sessions when an authoritative list is empty", () => {
    applyPreviewServerSnapshot(ref, makeSnapshot());

    reconcilePreviewServerSessions(ref, { sessions: [], serverEpoch, revision: 1 });

    const state = readThreadPreviewState(ref);
    expect(state.sessions).toEqual({});
    expect(state.activeTabId).toBeNull();
    expect(state.snapshot).toBeNull();
  });

  it("ignores a list response older than the latest server event", () => {
    const snapshot = makeSnapshot();
    applyPreviewServerEvent(ref, {
      type: "opened",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: snapshot.updatedAt,
      snapshot,
    });

    reconcilePreviewServerSessions(ref, { sessions: [], serverEpoch, revision: 0 });

    expect(readThreadPreviewState(ref).sessions).toEqual({ [snapshot.tabId]: snapshot });
    expect(readThreadPreviewState(ref).listLoaded).toBe(false);

    const olderTab = makeSnapshot({ tabId: "tab_before_event" });
    reconcilePreviewServerSessions(ref, {
      sessions: [olderTab, snapshot],
      serverEpoch,
      revision: 2,
    });
    expect(readThreadPreviewState(ref).listLoaded).toBe(true);
    expect(readThreadPreviewState(ref).sessions).toEqual({
      [olderTab.tabId]: olderTab,
      [snapshot.tabId]: snapshot,
    });
  });

  it("does not resurrect a tab from an event older than its close", () => {
    const snapshot = makeSnapshot();
    applyPreviewServerEvent(ref, {
      type: "opened",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: snapshot.updatedAt,
      snapshot,
    });
    applyPreviewServerEvent(ref, {
      type: "closed",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: "2026-01-01T00:00:01.000Z",
    });

    applyPreviewServerEventImpl(ref, {
      type: "opened",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: snapshot.updatedAt,
      serverEpoch,
      revision: 1,
      snapshot,
    });

    expect(readThreadPreviewState(ref).sessions).toEqual({});
  });

  it("accepts a lower revision from a newly restarted server", () => {
    const snapshot = makeSnapshot();
    applyPreviewServerEventImpl(ref, {
      type: "opened",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: snapshot.updatedAt,
      serverEpoch,
      revision: 12,
      snapshot,
    });

    reconcilePreviewServerSessions(ref, {
      sessions: [],
      serverEpoch: "server-b",
      revision: 0,
    });

    const state = readThreadPreviewState(ref);
    expect(state.sessions).toEqual({});
    expect(state.serverEpoch).toBe("server-b");
    expect(state.serverRevision).toBe(0);
  });

  it("does not carry raw-tab state across a server restart", () => {
    const previous = makeSnapshot({
      navStatus: { _tag: "Success", url: "https://old.example", title: "Old" },
      updatedAt: "2026-01-01T00:00:02.000Z",
    });
    applyPreviewServerEventImpl(ref, {
      type: "opened",
      threadId: "thread-1",
      tabId: previous.tabId,
      createdAt: previous.updatedAt,
      serverEpoch,
      revision: 12,
      snapshot: previous,
    });
    beginPreviewSessionClose(ref, previous.tabId);
    applyPreviewDesktopState(ref, previous.tabId, {
      hasWebContents: true,
      canGoBack: false,
      canGoForward: false,
      loading: false,
      zoomFactor: 1,
      pictureInPicture: false,
      colorScheme: "system",
      audioMuted: false,
      audible: false,
      controller: "none",
      favicon: null,
    });
    const restarted = makeSnapshot({
      navStatus: { _tag: "Success", url: "https://new.example", title: "New" },
      updatedAt: "2026-01-01T00:00:01.000Z",
    });
    reconcilePreviewServerSessions(ref, {
      sessions: [restarted],
      serverEpoch: "server-b",
      revision: 0,
    });

    const state = readThreadPreviewState(ref);
    expect(state.sessions[restarted.tabId]).toEqual(restarted);
    expect(state.suppressedTabIds).toEqual(new Set());
    expect(state.desktopByTabId).toEqual({});
    expect(state.desktopOverlay).toBeNull();
  });

  it("applyServerSnapshot null clears snapshot for a thread that had one", () => {
    const snapshot = makeSnapshot();
    applyPreviewServerSnapshot(ref, snapshot);
    applyPreviewServerSnapshot(ref, null);
    const state = readThreadPreviewState(ref);
    expect(state.snapshot).toBeNull();
  });

  it("does not replace a streamed snapshot with older SWR data", () => {
    applyPreviewServerSnapshot(
      ref,
      makeSnapshot({
        navStatus: { _tag: "Success", url: "http://localhost:5173/new", title: "New" },
        updatedAt: "2026-01-01T00:00:02.000Z",
      }),
    );
    applyPreviewServerSnapshot(
      ref,
      makeSnapshot({
        navStatus: { _tag: "Success", url: "http://localhost:5173/old", title: "Old" },
        updatedAt: "2026-01-01T00:00:01.000Z",
      }),
    );

    const state = readThreadPreviewState(ref);
    expect(state.snapshot?.navStatus).toEqual({
      _tag: "Success",
      url: "http://localhost:5173/new",
      title: "New",
    });
  });

  it("rememberUrl dedupes and caps at limit", () => {
    for (let i = 0; i < __testing.RECENT_URL_LIMIT + 5; i += 1) {
      rememberPreviewUrl(ref, `http://localhost:${5000 + i}/`);
    }
    const state = readThreadPreviewState(ref);
    expect(state.recentlySeenUrls.length).toBeLessThanOrEqual(__testing.RECENT_URL_LIMIT);
    expect(state.recentlySeenUrls[0]).toBe(
      `http://localhost:${5000 + __testing.RECENT_URL_LIMIT + 4}/`,
    );
  });
});

it("merges an opened event replay without repeating its selection", () => {
  const opened = makeSnapshot();
  const other = makeSnapshot({ tabId: "tab-other" });
  applyPreviewServerSnapshot(ref, opened);
  applyPreviewServerSnapshot(ref, other);
  applyPreviewServerEvent(ref, {
    type: "opened",
    threadId: ref.threadId,
    tabId: opened.tabId,
    snapshot: {
      ...opened,
      navStatus: { _tag: "Success", url: "https://example.test/", title: "Updated" },
    },
    createdAt: opened.updatedAt,
  });
  expect(readThreadPreviewState(ref).activeTabId).toBe(other.tabId);
  expect(readThreadPreviewState(ref).sessions[opened.tabId]?.navStatus).toEqual({
    _tag: "Success",
    url: "https://example.test/",
    title: "Updated",
  });
});

it.each([1, 2])(
  "consumes foreground creation focus after list revision %i without rolling metadata back",
  (revision) => {
    const active = makeSnapshot({ tabId: "source" });
    const opened = makeSnapshot({ tabId: "destination" });
    const listed = {
      ...opened,
      navStatus: { _tag: "Success" as const, url: "https://example.test/loaded", title: "Loaded" },
      updatedAt: "2026-01-01T00:00:02.000Z",
    };
    applyPreviewServerSnapshot(ref, active);
    reconcilePreviewServerSessions(ref, { serverEpoch, revision, sessions: [active, listed] });
    expect(readThreadPreviewState(ref).activeTabId).toBe(active.tabId);
    applyPreviewServerEvent(ref, {
      type: "opened",
      threadId: ref.threadId,
      tabId: opened.tabId,
      snapshot: revision === 1 ? listed : opened,
      createdAt: opened.updatedAt,
      background: false,
    });
    const state = readThreadPreviewState(ref);
    expect(state.activeTabId).toBe(opened.tabId);
    expect(state.snapshot).toEqual(listed);
    expect(state.serverRevision).toBe(revision);
    setActivePreviewTab(ref, active.tabId);
    applyPreviewServerEvent(ref, {
      type: "opened",
      threadId: ref.threadId,
      tabId: opened.tabId,
      snapshot: listed,
      createdAt: opened.updatedAt,
      background: false,
    });
    expect(readThreadPreviewState(ref).activeTabId).toBe(active.tabId);
  },
);

it.each([true, false])(
  "honors an explicit same-tab choice after list hydration before background=%s creation",
  (background) => {
    const active = makeSnapshot({ tabId: "source" });
    const opened = makeSnapshot({ tabId: "destination" });
    applyPreviewServerSnapshot(ref, active);
    reconcilePreviewServerSessions(ref, { serverEpoch, revision: 2, sessions: [active, opened] });
    setActivePreviewTab(ref, active.tabId);
    useRightPanelStore.getState().openBrowser(ref, active.tabId);
    applyPreviewServerEvent(ref, {
      type: "opened",
      threadId: ref.threadId,
      tabId: opened.tabId,
      snapshot: opened,
      createdAt: opened.updatedAt,
      background,
    });
    expect(readThreadPreviewState(ref).activeTabId).toBe(active.tabId);
    reconcilePanel();
    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, ref)?.id).toBe(
      `browser:${active.tabId}`,
    );
  },
);

it("keeps a list-first background tab visible without consuming selection, including a later replay", () => {
  const active = makeSnapshot({ tabId: "source" });
  const opened = makeSnapshot({ tabId: "destination", runtime: "server" });
  applyPreviewServerSnapshot(ref, active);
  reconcilePreviewServerSessions(ref, { serverEpoch, revision: 2, sessions: [active, opened] });
  const event = {
    type: "opened" as const,
    threadId: ref.threadId,
    tabId: opened.tabId,
    snapshot: opened,
    createdAt: opened.updatedAt,
    background: true,
  };
  applyPreviewServerEvent(ref, event);
  expect(readThreadPreviewState(ref).activeTabId).toBe(active.tabId);
  expect(hiddenPreviewTabIds(readThreadPreviewState(ref).sessions).size).toBe(0);
  setActivePreviewTab(ref, opened.tabId);
  applyPreviewServerEvent(ref, event);
  expect(readThreadPreviewState(ref).activeTabId).toBe(opened.tabId);
});

it.each(["terminal", "file"] as const)(
  "accepts a foreign foreground event after an authoritative empty list while displaying a %s",
  (initialPanel) => {
    reconcilePreviewServerSessions(ref, { serverEpoch, revision: 0, sessions: [] });
    const panel = useRightPanelStore.getState();
    if (initialPanel === "terminal") panel.openTerminal(ref, "terminal-1");
    else panel.openFile(ref, "src/app.ts");
    const revision = panel.getUserActionRevision(ref);
    const opened = makeSnapshot({ tabId: "first-tab" });
    const listed = { ...opened, updatedAt: "2026-01-01T00:00:02.000Z" };
    reconcilePreviewServerSessions(ref, { serverEpoch, revision: 2, sessions: [listed] });
    reconcilePanel();
    const event = {
      type: "opened" as const,
      threadId: ref.threadId,
      tabId: opened.tabId,
      snapshot: opened,
      serverEpoch,
      revision: 1,
      createdAt: opened.updatedAt,
      focus: { clientId: "other-client", userActionRevision: 0 },
    };
    applyPreviewServerEventImpl(ref, event);
    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, ref)).toEqual({
      id: "browser:first-tab",
      kind: "preview",
      resourceId: "first-tab",
    });
    expect(readThreadPreviewState(ref).snapshot).toEqual(listed);
    expect(panel.getUserActionRevision(ref)).toBe(revision + 1);
    applyPreviewServerEventImpl(ref, event);
    expect(panel.getUserActionRevision(ref)).toBe(revision + 1);
    panel.openTerminal(ref, "later-terminal");
    applyPreviewServerEventImpl(ref, event);
    reconcilePanel();
    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, ref)?.id).toBe(
      "terminal:later-terminal",
    );
    expect(panel.getUserActionRevision(ref)).toBe(revision + 2);
  },
);

it("does not replay historical creation focus after a cold authoritative baseline", () => {
  const old = makeSnapshot({ tabId: "older" });
  const newest = makeSnapshot({ tabId: "newest", updatedAt: "2026-01-01T00:00:02.000Z" });
  reconcilePreviewServerSessions(ref, { serverEpoch, revision: 5, sessions: [old, newest] });
  applyPreviewServerEvent(ref, {
    type: "opened",
    threadId: ref.threadId,
    tabId: old.tabId,
    snapshot: old,
    createdAt: old.updatedAt,
  });
  expect(readThreadPreviewState(ref).activeTabId).toBe(newest.tabId);
  expect(readThreadPreviewState(ref).serverRevision).toBe(5);
  expect(useRightPanelStore.getState().getUserActionRevision(ref)).toBe(0);
});

it("does not resurrect a tab removed by a newer list when its creation focus arrives late", () => {
  const active = makeSnapshot({ tabId: "source" });
  const opened = makeSnapshot({ tabId: "removed" });
  applyPreviewServerSnapshot(ref, active);
  reconcilePreviewServerSessions(ref, { serverEpoch, revision: 2, sessions: [active] });
  applyPreviewServerEvent(ref, {
    type: "opened",
    threadId: ref.threadId,
    tabId: opened.tabId,
    snapshot: opened,
    createdAt: opened.updatedAt,
  });
  expect(readThreadPreviewState(ref).activeTabId).toBe(active.tabId);
  expect(readThreadPreviewState(ref).sessions[opened.tabId]).toBeUndefined();
  expect(useRightPanelStore.getState().getUserActionRevision(ref)).toBe(0);
});

it("consumes fresh creation focus when a closed tab id is reused", () => {
  const source = makeSnapshot({ tabId: "source" });
  const reopened = makeSnapshot({ tabId: "reopened" });
  applyPreviewServerSnapshot(ref, source);
  const event = {
    type: "opened" as const,
    threadId: ref.threadId,
    tabId: reopened.tabId,
    snapshot: reopened,
    createdAt: reopened.updatedAt,
  };
  applyPreviewServerEvent(ref, event);
  applyPreviewServerEvent(ref, {
    type: "closed",
    threadId: ref.threadId,
    tabId: reopened.tabId,
    createdAt: reopened.updatedAt,
  });
  expect(readThreadPreviewState(ref).activeTabId).toBe(source.tabId);
  applyPreviewServerEvent(ref, event);
  expect(readThreadPreviewState(ref).activeTabId).toBe(reopened.tabId);
});

it("keeps a hidden automation open from replacing the active page", () => {
  const active = makeSnapshot();
  applyPreviewServerSnapshot(ref, active);
  const background = makeSnapshot({ tabId: "background", reveal: false });
  applyPreviewServerEvent(ref, {
    type: "opened",
    threadId: ref.threadId,
    tabId: background.tabId,
    snapshot: background,
    createdAt: background.updatedAt,
  });
  expect(readThreadPreviewState(ref).activeTabId).toBe(active.tabId);
  expect(readThreadPreviewState(ref).sessions[background.tabId]).toEqual(background);
});

describe("creation focus reaches the rendered right-panel resource", () => {
  it("shows a foreground creation when a different kind of surface was already selected", () => {
    const source = makeSnapshot({ tabId: "source" });
    const destination = makeSnapshot({ tabId: "destination", runtime: "server" });
    applyPreviewServerSnapshot(ref, source);
    useRightPanelStore.getState().openFile(ref, "src/app.ts");
    applyPreviewServerEvent(ref, {
      type: "opened",
      threadId: ref.threadId,
      tabId: destination.tabId,
      snapshot: destination,
      createdAt: destination.updatedAt,
    });
    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, ref)).toEqual({
      id: "browser:destination",
      kind: "preview",
      resourceId: "destination",
    });
  });

  it("keeps hidden automation out of the panel while a file is displayed", () => {
    const source = makeSnapshot({ tabId: "source" });
    const hidden = makeSnapshot({ tabId: "hidden", runtime: "server", reveal: false });
    applyPreviewServerSnapshot(ref, source);
    useRightPanelStore.getState().openFile(ref, "src/app.ts");
    applyPreviewServerEvent(ref, {
      type: "opened",
      threadId: ref.threadId,
      tabId: hidden.tabId,
      snapshot: hidden,
      createdAt: hidden.updatedAt,
    });
    reconcilePanel();
    const panel = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref);
    expect(panel.activeSurfaceId).toBe("file:src/app.ts");
    expect(panel.surfaces.map((surface) => surface.id)).toEqual([
      "file:src/app.ts",
      "browser:source",
    ]);
  });

  it.each(["event-first", "list-first", "newer-list-first"])(
    "shows the foreground destination with %s delivery before resource reconciliation",
    (order) => {
      const source = makeSnapshot({ tabId: "source" });
      const destination = makeSnapshot({ tabId: "destination", runtime: "server" });
      applyPreviewServerSnapshot(ref, source);
      useRightPanelStore.getState().openBrowser(ref, source.tabId);
      const focus = capturePreviewOpenFocus(ref);
      const revision = useRightPanelStore.getState().getUserActionRevision(ref);
      if (order !== "event-first") {
        reconcilePreviewServerSessions(ref, {
          serverEpoch,
          revision: order === "list-first" ? 1 : 2,
          sessions: [source, destination],
        });
        reconcilePanel();
      }
      applyPreviewServerEvent(ref, {
        type: "opened",
        threadId: ref.threadId,
        tabId: destination.tabId,
        snapshot: destination,
        createdAt: destination.updatedAt,
        background: false,
        focus,
      });
      // PreviewPanel gets this resourceId, rather than previewState.activeTabId.
      expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, ref)).toEqual(
        { id: "browser:destination", kind: "preview", resourceId: "destination" },
      );
      expect(useRightPanelStore.getState().getUserActionRevision(ref)).toBe(revision);
      reconcilePanel();
      expect(
        selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, ref)?.id,
      ).toBe("browser:destination");
    },
  );

  it.each(["event-first", "list-first"])(
    "adds a visible background tab without changing the displayed resource with %s delivery",
    (order) => {
      const source = makeSnapshot({ tabId: "source" });
      const destination = makeSnapshot({ tabId: "destination", runtime: "server" });
      applyPreviewServerSnapshot(ref, source);
      useRightPanelStore.getState().openBrowser(ref, source.tabId);
      if (order === "list-first") {
        reconcilePreviewServerSessions(ref, {
          serverEpoch,
          revision: 1,
          sessions: [source, destination],
        });
        reconcilePanel();
      }
      applyPreviewServerEvent(ref, {
        type: "opened",
        threadId: ref.threadId,
        tabId: destination.tabId,
        snapshot: destination,
        createdAt: destination.updatedAt,
        background: true,
      });
      expect(
        selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, ref)?.id,
      ).toBe("browser:source");
      reconcilePanel();
      const panel = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref);
      expect(panel.activeSurfaceId).toBe("browser:source");
      expect(panel.surfaces.map((surface) => surface.id)).toEqual([
        "browser:source",
        "browser:destination",
      ]);
    },
  );

  it.each(["file", "terminal", "browser", "hide"])(
    "keeps a later explicit %s choice through delayed reconciliation and opened replay",
    (choice) => {
      const source = makeSnapshot({ tabId: "source" });
      const destination = makeSnapshot({ tabId: "destination", runtime: "server" });
      applyPreviewServerSnapshot(ref, source);
      useRightPanelStore.getState().openBrowser(ref, source.tabId);
      const event = {
        type: "opened" as const,
        threadId: ref.threadId,
        tabId: destination.tabId,
        snapshot: destination,
        createdAt: destination.updatedAt,
        background: false,
      };
      applyPreviewServerEvent(ref, event);
      const panel = useRightPanelStore.getState();
      if (choice === "file") panel.openFile(ref, "src/app.ts");
      if (choice === "terminal") panel.openTerminal(ref, "terminal-1");
      if (choice === "browser") {
        setActivePreviewTab(ref, source.tabId);
        panel.openBrowser(ref, source.tabId);
      }
      if (choice === "hide") panel.close(ref);
      const chosen = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref);
      reconcilePanel();
      applyPreviewServerEvent(ref, event);
      reconcilePanel();
      const after = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref);
      expect(after.activeSurfaceId).toBe(chosen.activeSurfaceId);
      expect(after.isOpen).toBe(chosen.isOpen);
    },
  );
});
