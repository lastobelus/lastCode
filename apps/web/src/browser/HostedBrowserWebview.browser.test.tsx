import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  FILL_PREVIEW_VIEWPORT,
  ThreadId,
  type ClientSettings,
  type DesktopPreviewBridge,
  type PreviewEvent,
  type PreviewListResult,
  type PreviewSessionSnapshot,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { Cause, Effect } from "effect";
import type { OpenPreviewMutation } from "./openFileInPreview";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ReactNode } from "react";

import "~/index.css";
import { act, fakeTimers, render as renderUi, type Screen } from "../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";
import type { previewBridge } from "~/components/preview/previewBridge";

const mocks = vi.hoisted(() => ({
  getClientSettings: vi.fn<() => Promise<ClientSettings | null>>(),
  setClientSettings: vi.fn<(settings: ClientSettings) => Promise<void>>(),
  createTab: vi.fn<DesktopPreviewBridge["createTab"]>(),
  closeTab: vi.fn<DesktopPreviewBridge["closeTab"]>(),
  registerWebview: vi.fn<DesktopPreviewBridge["registerWebview"]>(),
  getPreviewConfig: vi.fn<DesktopPreviewBridge["getPreviewConfig"]>(),
  openPreview: vi.fn<OpenPreviewMutation>(),
  activeRecordings: new Set<string>(),
}));

vi.mock(import("~/localApi"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    ensureLocalApi: () => ({ ...actual.ensureLocalApi(), persistence: mocks as never }),
  };
});

vi.mock(import("./desktopTabLifetime"), { spy: true });
vi.mock(import("~/components/preview/previewHostingRecovery"), { spy: true });
vi.mock(import("./browserDefaults"), { spy: true });

// The Electron desktop bridge; a browser has none.
vi.mock(import("~/components/preview/previewBridge"), async (original) => ({
  ...(await original()),
  previewBridge: {
    createTab: mocks.createTab,
    closeTab: mocks.closeTab,
    registerWebview: mocks.registerWebview,
    getPreviewConfig: mocks.getPreviewConfig,
    setColorScheme: async () => undefined,
    setZoomFactor: async () => undefined,
  } as unknown as NonNullable<typeof previewBridge>,
}));

vi.mock(import("~/env"), async (original) => ({ ...(await original()), isElectron: true }));
vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock("~/state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/session")>()),
  useEnvironmentScope: () => true,
}));
vi.mock("~/state/primaryEnvironment", async () => {
  const { Atom } = await import("effect/reactivity");
  return { primaryEnvironmentIdAtom: Atom.make("desktop-primary") };
});
vi.mock("~/state/preview", () => ({
  previewEnvironment: {
    open: {
      label: "preview:open",
      run: (_registry: unknown, input: Parameters<OpenPreviewMutation>[0]) =>
        mocks.openPreview(input),
    },
    events: ({ environmentId }: { environmentId: string }) => previewEventsFor(environmentId),
    list: ({ environmentId, input }: { environmentId: string; input: { threadId?: string } }) => {
      if (input.threadId === undefined) return previewList;
      const ref = scopeThreadRef(EnvironmentId.make(environmentId), ThreadId.make(input.threadId));
      return threadListQueries.get(scopedThreadKey(ref)) ?? threadListValues(scopedThreadKey(ref));
    },
  },
}));

vi.mock(import("~/components/preview/usePreviewBridge"), async (original) => ({
  ...(await original()),
  usePreviewBridge: () => undefined,
}));

import {
  __resetClientSettingsPersistenceForTests,
  ensureClientSettingsHydrated,
} from "~/hooks/useSettings";
import { useBrowserSurfaceStore } from "./browserSurfaceStore";
import { HostedBrowserWebview } from "./HostedBrowserWebview";
import { ElectronBrowserHost } from "./ElectronBrowserHost";
import { previewRuntimeTabId } from "./previewRuntimeTabId";
import {
  applyPreviewServerSnapshot,
  previewStateAtom,
  resetPreviewStateForTests,
} from "~/previewStateStore";
import * as hostingRecovery from "~/components/preview/previewHostingRecovery";
import * as browserDefaults from "./browserDefaults";
import { toastManager } from "~/components/ui/toast";
import { usePreviewSession } from "~/components/preview/usePreviewSession";
import { AppAtomRegistryProvider, appAtomRegistry } from "~/rpc/atomRegistry";
import { selectActiveRightPanelSurface, useRightPanelStore } from "~/rightPanelStore";

const previewEvents = new Map<
  string,
  Atom.Writable<AsyncResult.AsyncResult<PreviewEvent>, AsyncResult.AsyncResult<PreviewEvent>>
>();
const previewList = Atom.make<AsyncResult.AsyncResult<PreviewListResult>>(AsyncResult.initial());
const threadListValues = Atom.family((_threadKey: string) =>
  Atom.make<AsyncResult.AsyncResult<PreviewListResult>>(AsyncResult.initial()),
);
const threadListQueries = new Map<string, Atom.Atom<AsyncResult.AsyncResult<PreviewListResult>>>();
function previewEventsFor(environmentId: string) {
  let atom = previewEvents.get(environmentId);
  if (!atom) {
    atom = Atom.make<AsyncResult.AsyncResult<PreviewEvent>>(AsyncResult.initial());
    previewEvents.set(environmentId, atom);
  }
  return atom;
}

let screen: Screen | undefined;
let container: HTMLDivElement;
let guestWebContentsId: number;

async function render(element: ReactNode, webContentsId = 44) {
  guestWebContentsId = webContentsId;
  if (screen) await screen.rerender(element);
  else screen = await renderUi(element, { container, router: false });
}

function deferred<A>() {
  let resolve!: (value: A) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<A>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function setup() {
  screen = undefined;
  vi.clearAllMocks();
  // Each case mounts its own sync hook; retained subscriptions from another
  // root must not receive this case's pre-mount cached event as live.
  appAtomRegistry.reset();
  resetPreviewStateForTests();
  threadListQueries.clear();
  appAtomRegistry.set(previewList, AsyncResult.initial());
  for (const atom of previewEvents.values()) appAtomRegistry.set(atom, AsyncResult.initial());
  __resetClientSettingsPersistenceForTests();
  useBrowserSurfaceStore.setState({ activityByTabId: {}, byTabId: {} });
  mocks.getClientSettings.mockReset();
  mocks.openPreview.mockReset();
  mocks.setClientSettings.mockReset().mockResolvedValue(undefined);
  mocks.createTab.mockReset().mockResolvedValue(undefined);
  mocks.closeTab.mockReset().mockResolvedValue(undefined);
  mocks.registerWebview.mockReset().mockResolvedValue(undefined);
  mocks.getPreviewConfig.mockReset().mockResolvedValue({
    partition: "persist:t3-preview-work",
    webPreferences: "contextIsolation=yes",
    preloadUrl: null,
  });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  guestWebContentsId = 44;
  // Chromium treats <webview> as an unknown element; supply the guest API used by the host.
  const createElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(((
    tagName: string,
    options?: ElementCreationOptions,
  ) => {
    const element = createElement(tagName, options);
    return tagName === "webview"
      ? Object.assign(element, { getWebContentsId: () => guestWebContentsId })
      : element;
  }) as typeof document.createElement);
  container = document.createElement("div");
  document.body.append(container);
  return { [Symbol.asyncDispose]: cleanup };
}

describe("Electron browser hosting outside the selected thread", () => {
  it("never creates a native guest for a headless tab, including after a reconnect", async () => {
    await using _fixture = setup();
    mocks.getClientSettings.mockResolvedValue(DEFAULT_CLIENT_SETTINGS);
    await act(async () => {
      await ensureClientSettingsHydrated();
      await render(
        <AppAtomRegistryProvider>
          <ElectronBrowserHost />
        </AppAtomRegistryProvider>,
      );
    });
    const snapshot: PreviewListResult["sessions"][number] = {
      threadId: "headless-thread",
      tabId: "headless-tab",
      runtime: "server",
      backingPage: "server",
      navStatus: { _tag: "Idle" },
      canGoBack: false,
      canGoForward: false,
      updatedAt: "2026-10-07T00:00:00.000Z",
    };
    for (const serverEpoch of ["headless-server", "reconnected-server"]) {
      await act(() => {
        appAtomRegistry.set(
          previewList,
          AsyncResult.success({ serverEpoch, revision: 1, sessions: [snapshot] }),
        );
      });
    }
    expect(mocks.createTab).not.toHaveBeenCalled();
    expect(mocks.registerWebview).not.toHaveBeenCalled();
  });

  it.each(["settings", "rpc", "defect", "interruption"] as const)(
    "handles a settled %s result without replacing the source tab",
    async (failureKind) => {
      await using _fixture = setup();
      const threadRef = scopeThreadRef(
        EnvironmentId.make("desktop-primary"),
        ThreadId.make("settled-link-source"),
      );
      const snapshot = {
        threadId: threadRef.threadId,
        tabId: "source-tab",
        navStatus: { _tag: "Idle" as const },
        canGoBack: false,
        canGoForward: false,
        updatedAt: "2026-10-07T00:00:00.000Z",
      };
      let onOpenLink!: Parameters<DesktopPreviewBridge["onOpenLink"]>[0];
      vi.stubGlobal("desktopBridge", {
        preview: {
          onOpenLink: (listener: typeof onOpenLink) => {
            onOpenLink = listener;
            return () => undefined;
          },
          onPointerEvent: () => () => undefined,
          setAnnotationTheme: async () => undefined,
        },
      });
      const url = "http://localhost:5173/qa";
      vi.mocked(hostingRecovery.prepareHostedPreview).mockResolvedValue({
        url,
        managed: false,
        restored: false,
      });
      const failure = new Error("Preview open unavailable.");
      mocks.openPreview.mockResolvedValue(
        AsyncResult.failure(
          failureKind === "interruption"
            ? Cause.interrupt()
            : failureKind === "defect"
              ? Cause.die(failure)
              : Cause.fail(failure),
        ),
      );
      const report = vi.spyOn(toastManager, "add").mockReturnValue("open-error");
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      mocks.getClientSettings.mockResolvedValue(DEFAULT_CLIENT_SETTINGS);
      applyPreviewServerSnapshot(threadRef, snapshot);
      await act(async () => {
        await ensureClientSettingsHydrated();
        await render(
          <AppAtomRegistryProvider>
            <ElectronBrowserHost />
          </AppAtomRegistryProvider>,
          44,
        );
      });
      const createCount = mocks.createTab.mock.calls.length;
      if (failureKind === "settings") {
        vi.mocked(browserDefaults.resolveBrowserDefaults).mockRejectedValueOnce(failure);
      }
      await act(async () => {
        onOpenLink({
          tabId: previewRuntimeTabId(threadRef, null, snapshot.tabId),
          url,
          background: false,
        });
      });
      if (failureKind === "interruption") {
        expect(report).not.toHaveBeenCalled();
      } else {
        expect(report).toHaveBeenCalledExactlyOnceWith({
          type: "error",
          title: "Could not open the link in the browser",
          description:
            failureKind === "settings"
              ? "Saved browser settings could not be loaded."
              : failure.message,
        });
      }
      expect(mocks.openPreview).toHaveBeenCalledTimes(failureKind === "settings" ? 0 : 1);
      expect(mocks.createTab).toHaveBeenCalledTimes(createCount);
      expect(appAtomRegistry.get(previewStateAtom(scopedThreadKey(threadRef)))).toMatchObject({
        activeTabId: snapshot.tabId,
        sessions: { [snapshot.tabId]: snapshot },
      });
      expect(
        Object.keys(appAtomRegistry.get(previewStateAtom(scopedThreadKey(threadRef))).sessions),
      ).toEqual([snapshot.tabId]);
    },
  );

  it("reports rejected hosted-link recovery without replacing the source tab", async () => {
    await using _fixture = setup();
    const threadRef = scopeThreadRef(
      EnvironmentId.make("desktop-primary"),
      ThreadId.make("link-source"),
    );
    const snapshot = {
      threadId: threadRef.threadId,
      tabId: "source-tab",
      navStatus: { _tag: "Idle" as const },
      canGoBack: false,
      canGoForward: false,
      updatedAt: "2026-10-07T00:00:00.000Z",
    };
    let onOpenLink!: Parameters<DesktopPreviewBridge["onOpenLink"]>[0];
    vi.stubGlobal("desktopBridge", {
      preview: {
        onOpenLink: (listener: typeof onOpenLink) => {
          onOpenLink = listener;
          return () => undefined;
        },
        onPointerEvent: () => () => undefined,
        setAnnotationTheme: async () => undefined,
      },
    });
    const failure = new Error("Preview recovery unavailable.");
    const prepare = vi.mocked(hostingRecovery.prepareHostedPreview).mockRejectedValue(failure);
    const report = vi.spyOn(toastManager, "add").mockReturnValue("recovery-error");
    mocks.getClientSettings.mockResolvedValue(DEFAULT_CLIENT_SETTINGS);
    applyPreviewServerSnapshot(threadRef, snapshot);
    await act(async () => {
      await ensureClientSettingsHydrated();
      await render(
        <AppAtomRegistryProvider>
          <ElectronBrowserHost />
        </AppAtomRegistryProvider>,
        44,
      );
    });
    await act(async () => {
      onOpenLink({
        tabId: previewRuntimeTabId(threadRef, null, snapshot.tabId),
        url: "http://localhost:5173/qa",
        background: false,
      });
    });
    expect(prepare).toHaveBeenCalledWith(threadRef, "http://localhost:5173/qa");
    expect(report).toHaveBeenCalledExactlyOnceWith({
      type: "error",
      title: "Could not open the link in the browser",
      description: failure.message,
    });
    expect(appAtomRegistry.get(previewStateAtom(scopedThreadKey(threadRef))).activeTabId).toBe(
      snapshot.tabId,
    );
  });

  it.each(
    (["primary", "remote"] as const).flatMap((origin) =>
      (["cached", "live"] as const).flatMap((delivery) =>
        [1, 2].map((listRevision) => ({ origin, delivery, listRevision })),
      ),
    ),
  )(
    "classifies $delivery $origin creation focus after first list revision $listRevision",
    async ({ origin, delivery, listRevision }) => {
      await using _fixture = setup();
      useRightPanelStore.setState({
        byThreadKey: {},
        threadPanelVisibilityByThreadKey: {},
        userActionRevisionByThreadKey: {},
      });
      const threadRef = scopeThreadRef(
        EnvironmentId.make(origin === "primary" ? "desktop-primary" : "remote-hydration"),
        ThreadId.make(`${origin}-${delivery}-list-${listRevision}`),
      );
      const snapshot: PreviewSessionSnapshot = {
        threadId: threadRef.threadId,
        tabId: "foreign-first-tab",
        runtime: "server",
        backingPage: "desktop",
        desktopHostId: "local",
        navStatus: { _tag: "Idle" },
        canGoBack: false,
        canGoForward: false,
        updatedAt: "2026-10-07T00:00:00.000Z",
      };
      const event: PreviewEvent = {
        type: "opened",
        threadId: threadRef.threadId,
        tabId: snapshot.tabId,
        snapshot,
        createdAt: snapshot.updatedAt,
        serverEpoch: "server",
        revision: 1,
        focus: { clientId: "another-client", userActionRevision: 3 },
      };
      const panel = useRightPanelStore.getState();
      panel.openFile(threadRef, "src/app.ts");
      const beforeRevision = panel.getUserActionRevision(threadRef);
      if (delivery === "cached") {
        appAtomRegistry.set(previewEventsFor(threadRef.environmentId), AsyncResult.success(event));
      }
      function ChatSync() {
        usePreviewSession(threadRef);
        return null;
      }
      mocks.getClientSettings.mockResolvedValue(DEFAULT_CLIENT_SETTINGS);
      await act(async () => {
        await ensureClientSettingsHydrated();
        await render(
          <AppAtomRegistryProvider>
            {origin === "primary" ? <ElectronBrowserHost /> : <ChatSync />}
          </AppAtomRegistryProvider>,
          44,
        );
      });
      await act(() => {
        appAtomRegistry.set(
          origin === "primary" ? previewList : threadListValues(scopedThreadKey(threadRef)),
          AsyncResult.success({
            serverEpoch: "server",
            revision: listRevision,
            sessions: [{ ...snapshot, updatedAt: "2026-10-07T00:00:02.000Z" }],
          }),
        );
      });
      expect(
        selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, threadRef)?.id,
      ).toBe("file:src/app.ts");
      // A cached value can re-emit as waiting during reconnect. A value first
      // delivered after the sync mounted comes from the live server subscription.
      await act(() => {
        appAtomRegistry.set(
          previewEventsFor(threadRef.environmentId),
          AsyncResult.success(event, { waiting: true }),
        );
      });
      expect(
        selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, threadRef)?.id,
      ).toBe(delivery === "live" ? `browser:${snapshot.tabId}` : "file:src/app.ts");
      expect(panel.getUserActionRevision(threadRef)).toBe(
        beforeRevision + (delivery === "live" ? 1 : 0),
      );
      panel.openTerminal(threadRef, "later-terminal");
      const laterRevision = panel.getUserActionRevision(threadRef);
      await act(() => {
        appAtomRegistry.set(previewEventsFor(threadRef.environmentId), AsyncResult.success(event));
      });
      expect(
        selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, threadRef)?.id,
      ).toBe("terminal:later-terminal");
      expect(panel.getUserActionRevision(threadRef)).toBe(laterRevision);
    },
  );

  it("applies primary events once and ignores retired lists while remote epochs advance", async () => {
    await using _fixture = setup();
    const local = {
      environmentId: EnvironmentId.make("desktop-primary"),
      threadId: ThreadId.make("selected-thread"),
    };
    const remote = { ...local, environmentId: EnvironmentId.make("remote-server") };
    function ChatSync() {
      usePreviewSession(local);
      usePreviewSession(remote);
      return null;
    }
    mocks.getClientSettings.mockResolvedValue(DEFAULT_CLIENT_SETTINGS);
    await act(async () => {
      await ensureClientSettingsHydrated();
      await render(
        <AppAtomRegistryProvider>
          <ElectronBrowserHost />
          <ChatSync />
        </AppAtomRegistryProvider>,
        44,
      );
    });
    const applied = vi.fn();
    const stop = appAtomRegistry.subscribe(previewStateAtom(scopedThreadKey(local)), (state) => {
      if (state.sessions["selected-tab"]) applied();
    });
    const opened: PreviewEvent = {
      type: "opened",
      threadId: local.threadId,
      tabId: "selected-tab",
      serverEpoch: "server",
      revision: 1,
      createdAt: "2026-10-07T00:00:00.000Z",
      snapshot: {
        threadId: local.threadId,
        tabId: "selected-tab",
        runtime: "server",
        backingPage: "desktop",
        desktopHostId: "local",
        navStatus: { _tag: "Idle" },
        canGoBack: false,
        canGoForward: false,
        updatedAt: "2026-10-07T00:00:00.000Z",
      },
    };
    try {
      await act(() => {
        appAtomRegistry.set(previewEventsFor(local.environmentId), AsyncResult.success(opened));
        appAtomRegistry.set(previewEventsFor(remote.environmentId), AsyncResult.success(opened));
      });
      expect(applied).toHaveBeenCalledOnce();
      expect(appAtomRegistry.get(previewStateAtom(scopedThreadKey(remote))).sessions).toEqual({
        "selected-tab": opened.snapshot,
      });
      expect(mocks.createTab).toHaveBeenCalledOnce();

      await act(() => {
        appAtomRegistry.set(
          threadListValues(scopedThreadKey(local)),
          AsyncResult.success({
            serverEpoch: "retired-server",
            revision: 100,
            sessions: [{ ...opened.snapshot, tabId: "retired-tab" }],
          }),
        );
      });
      expect(appAtomRegistry.get(previewStateAtom(scopedThreadKey(local)))).toMatchObject({
        serverEpoch: opened.serverEpoch,
        sessions: { "selected-tab": opened.snapshot },
      });
      expect(applied).toHaveBeenCalledOnce();
      expect(mocks.createTab).toHaveBeenCalledOnce();

      const remoteSnapshot = { ...opened.snapshot, tabId: "remote-restarted-tab" };
      await act(() => {
        appAtomRegistry.set(
          threadListValues(scopedThreadKey(remote)),
          AsyncResult.success({
            serverEpoch: "restarted-remote-server",
            revision: 1,
            sessions: [remoteSnapshot],
          }),
        );
      });
      expect(appAtomRegistry.get(previewStateAtom(scopedThreadKey(remote)))).toMatchObject({
        serverEpoch: "restarted-remote-server",
        sessions: { "remote-restarted-tab": remoteSnapshot },
      });
    } finally {
      stop();
    }
  });

  it("refreshes the mounted chat's separate query when the host list adopts a new epoch", async () => {
    await using _fixture = setup();
    const threadRef = scopeThreadRef(
      EnvironmentId.make("desktop-primary"),
      ThreadId.make("epoch-refresh-thread"),
    );
    const oldRead = deferred<PreviewListResult>();
    const freshRead = deferred<PreviewListResult>();
    let restarted = false;
    threadListQueries.set(
      scopedThreadKey(threadRef),
      Atom.make(() => Effect.promise(() => (restarted ? freshRead.promise : oldRead.promise))),
    );
    function ChatSync() {
      usePreviewSession(threadRef);
      return null;
    }
    mocks.getClientSettings.mockResolvedValue(DEFAULT_CLIENT_SETTINGS);
    await act(async () => {
      await ensureClientSettingsHydrated();
      await render(
        <AppAtomRegistryProvider>
          <ElectronBrowserHost />
          <ChatSync />
        </AppAtomRegistryProvider>,
        45,
      );
    });
    const oldSnapshot: PreviewListResult["sessions"][number] = {
      threadId: threadRef.threadId,
      tabId: "before-restart",
      runtime: "server",
      backingPage: "desktop",
      desktopHostId: "local",
      navStatus: { _tag: "Idle" },
      canGoBack: false,
      canGoForward: false,
      updatedAt: "2026-10-07T00:00:00.000Z",
    };
    await act(async () => {
      oldRead.resolve({ serverEpoch: "server-before", revision: 5, sessions: [oldSnapshot] });
      await oldRead.promise;
    });
    expect(mocks.createTab).toHaveBeenCalledOnce();
    using _timers = fakeTimers();
    restarted = true;
    await act(() => {
      appAtomRegistry.set(
        previewList,
        AsyncResult.success({ serverEpoch: "server-after", revision: 1, sessions: [] }),
      );
    });
    const freshSnapshot = { ...oldSnapshot, tabId: "after-restart" };
    await act(async () => {
      freshRead.resolve({ serverEpoch: "server-after", revision: 2, sessions: [freshSnapshot] });
      await freshRead.promise;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(appAtomRegistry.get(previewStateAtom(scopedThreadKey(threadRef)))).toMatchObject({
      serverEpoch: "server-after",
      sessions: { "after-restart": freshSnapshot },
      listLoaded: true,
    });
    expect(mocks.createTab).toHaveBeenLastCalledWith(
      previewRuntimeTabId(threadRef, "server-after", freshSnapshot.tabId),
      expect.objectContaining({
        serverTab: {
          threadId: threadRef.threadId,
          tabId: freshSnapshot.tabId,
          desktopHostId: "local",
        },
      }),
    );
  });

  it("attaches existing tabs from the initial list and reconciles a reconnect without events", async () => {
    await using _fixture = setup();
    mocks.getClientSettings.mockResolvedValue(DEFAULT_CLIENT_SETTINGS);
    await act(async () => {
      await ensureClientSettingsHydrated();
      await render(
        <AppAtomRegistryProvider>
          <ElectronBrowserHost />
        </AppAtomRegistryProvider>,
        43,
      );
    });
    const threadRef = {
      environmentId: EnvironmentId.make("desktop-primary"),
      threadId: ThreadId.make("already-open"),
    };
    const initialList: PreviewListResult = {
      serverEpoch: "existing-server",
      revision: 1,
      sessions: [
        {
          threadId: threadRef.threadId,
          tabId: "existing-tab",
          runtime: "server",
          backingPage: "desktop",
          desktopHostId: "local",
          navStatus: { _tag: "Idle" },
          canGoBack: false,
          canGoForward: false,
          updatedAt: "2026-10-06T00:00:00.000Z",
        },
      ],
    };
    await act(() => {
      appAtomRegistry.set(previewList, AsyncResult.success(initialList));
    });
    const runtimeTabId = previewRuntimeTabId(threadRef, initialList.serverEpoch, "existing-tab");
    expect(mocks.createTab).toHaveBeenCalledExactlyOnceWith(
      runtimeTabId,
      expect.objectContaining({
        serverTab: { threadId: threadRef.threadId, tabId: "existing-tab", desktopHostId: "local" },
      }),
    );
    expect(mocks.registerWebview).toHaveBeenCalledExactlyOnceWith(runtimeTabId, 43);

    using _timers = fakeTimers();
    await act(() => {
      appAtomRegistry.set(previewList, AsyncResult.success(initialList, { waiting: true }));
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.closeTab).not.toHaveBeenCalled();
    await act(() => {
      appAtomRegistry.set(
        previewList,
        AsyncResult.success({ ...initialList, revision: 2, sessions: [] }),
      );
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.closeTab).toHaveBeenCalledExactlyOnceWith(runtimeTabId);
  });

  it("attaches a primary-server tab without a chat view and releases it when closed", async () => {
    await using _fixture = setup();
    mocks.getClientSettings.mockResolvedValue(DEFAULT_CLIENT_SETTINGS);
    await act(async () => {
      await ensureClientSettingsHydrated();
      await render(
        <AppAtomRegistryProvider>
          <ElectronBrowserHost />
        </AppAtomRegistryProvider>,
        42,
      );
    });
    const threadRef = {
      environmentId: EnvironmentId.make("desktop-primary"),
      threadId: ThreadId.make("background-agent"),
    };
    const opened: PreviewEvent = {
      type: "opened",
      threadId: threadRef.threadId,
      tabId: "background-tab",
      serverEpoch: "primary-server",
      revision: 1,
      createdAt: "2026-10-06T00:00:00.000Z",
      snapshot: {
        threadId: threadRef.threadId,
        tabId: "background-tab",
        runtime: "server",
        backingPage: "desktop",
        desktopHostId: "local",
        navStatus: { _tag: "Idle" },
        canGoBack: false,
        canGoForward: false,
        updatedAt: "2026-10-06T00:00:00.000Z",
      },
    };
    await act(() => {
      appAtomRegistry.set(
        previewEventsFor(threadRef.environmentId),
        AsyncResult.success(opened, { waiting: true }),
      );
    });
    const runtimeTabId = previewRuntimeTabId(threadRef, opened.serverEpoch, opened.tabId);
    expect(mocks.createTab).toHaveBeenCalledExactlyOnceWith(runtimeTabId, {
      zoomFactor: DEFAULT_CLIENT_SETTINGS.browserDefaultZoomFactor,
      colorScheme: DEFAULT_CLIENT_SETTINGS.browserDefaultAppearance,
      serverTab: { threadId: threadRef.threadId, tabId: opened.tabId, desktopHostId: "local" },
    });
    expect(mocks.registerWebview).toHaveBeenCalledExactlyOnceWith(runtimeTabId, 42);

    // Separate threads can open tabs before React paints again. The stream
    // subscriber must retain both, and must not subscribe to remote environments.
    await act(() => {
      for (const suffix of ["b", "c"]) {
        const threadId = `background-${suffix}`;
        const tabId = `tab-${suffix}`;
        appAtomRegistry.set(
          previewEventsFor(threadRef.environmentId),
          AsyncResult.success(
            {
              ...opened,
              threadId,
              tabId,
              revision: suffix === "b" ? 2 : 3,
              snapshot: { ...opened.snapshot, threadId, tabId },
            },
            { waiting: true },
          ),
        );
      }
      appAtomRegistry.set(previewEventsFor("remote-server"), AsyncResult.success(opened));
    });
    expect(mocks.createTab).toHaveBeenCalledTimes(3);
    expect(mocks.registerWebview).toHaveBeenCalledTimes(3);

    using _timers = fakeTimers();
    await act(() => {
      appAtomRegistry.set(
        previewEventsFor(threadRef.environmentId),
        AsyncResult.success({ ...opened, type: "closed", revision: 4 }, { waiting: true }),
      );
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.closeTab).toHaveBeenCalledExactlyOnceWith(runtimeTabId);

    await act(() => {
      appAtomRegistry.set(
        previewEventsFor(threadRef.environmentId),
        AsyncResult.success(
          {
            ...opened,
            serverEpoch: "restarted-primary-server",
            revision: 1,
          },
          { waiting: true },
        ),
      );
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.closeTab).toHaveBeenCalledTimes(3);
    for (const suffix of ["b", "c"]) {
      expect(mocks.closeTab).toHaveBeenCalledWith(
        previewRuntimeTabId(
          { ...threadRef, threadId: ThreadId.make(`background-${suffix}`) },
          opened.serverEpoch,
          `tab-${suffix}`,
        ),
      );
    }
    expect(mocks.createTab).toHaveBeenLastCalledWith(
      previewRuntimeTabId(threadRef, "restarted-primary-server", opened.tabId),
      expect.objectContaining({
        serverTab: { threadId: threadRef.threadId, tabId: opened.tabId, desktopHostId: "local" },
      }),
    );
    expect(mocks.registerWebview).toHaveBeenCalledTimes(4);
    await act(() => {
      appAtomRegistry.set(
        previewList,
        AsyncResult.success({
          serverEpoch: opened.serverEpoch,
          revision: 100,
          sessions: [opened.snapshot],
        }),
      );
      appAtomRegistry.set(
        previewEventsFor(threadRef.environmentId),
        AsyncResult.success({ ...opened, revision: 101 }),
      );
    });
    expect(appAtomRegistry.get(previewStateAtom(scopedThreadKey(threadRef)))).toMatchObject({
      serverEpoch: "restarted-primary-server",
      sessions: { [opened.tabId]: opened.snapshot },
    });
    expect(mocks.createTab).toHaveBeenCalledTimes(4);
    expect(mocks.closeTab).toHaveBeenCalledTimes(3);
  });
});

async function cleanup() {
  using _timers = fakeTimers();
  await screen?.[Symbol.asyncDispose]();
  screen = undefined;
  container.remove();
  await vi.advanceTimersByTimeAsync(0);
  __resetClientSettingsPersistenceForTests();
  useBrowserSurfaceStore.setState({ activityByTabId: {}, byTabId: {} });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
}

describe("HostedBrowserWebview settings hydration", () => {
  it("reports the visible native slot independently of a hidden capture lease", async () => {
    await using _fixture = setup();
    mocks.getClientSettings.mockResolvedValue(DEFAULT_CLIENT_SETTINGS);
    const browserPresentation = vi.fn(async () => undefined);
    vi.stubGlobal("desktopBridge", {
      preview: {
        browserPresentation,
        onBrowserSurfaceRequest: () => () => undefined,
        browserSurfaceResponse: async () => undefined,
      },
    });
    const runtimeTabId = "native-presentation";
    const owner = Symbol("browser-slot");
    useBrowserSurfaceStore.getState().claim(runtimeTabId, owner, false);
    useBrowserSurfaceStore.getState().acquireActivity(runtimeTabId);
    await act(async () => {
      await ensureClientSettingsHydrated();
      await render(
        <HostedBrowserWebview
          threadRef={{
            environmentId: EnvironmentId.make("desktop-primary"),
            threadId: ThreadId.make("native-thread"),
          }}
          tabId="native-tab"
          runtimeTabId={runtimeTabId}
          initialUrl={null}
          profileId="default"
          viewport={FILL_PREVIEW_VIEWPORT}
          pictureInPicture={false}
          zoomFactor={1}
          serverDriven
          desktopHostId="local"
        />,
        46,
      );
    });
    expect(browserPresentation).toHaveBeenLastCalledWith({ runtimeTabId, presented: false });
    await act(() => {
      useBrowserSurfaceStore
        .getState()
        .present(runtimeTabId, owner, { x: 0, y: 0, width: 800, height: 600 }, true, 0, 30);
    });
    expect(browserPresentation).toHaveBeenLastCalledWith({ runtimeTabId, presented: true });
    await act(() => {
      useBrowserSurfaceStore.getState().release(runtimeTabId, owner);
    });
    expect(browserPresentation).toHaveBeenLastCalledWith({ runtimeTabId, presented: false });
  });
});
