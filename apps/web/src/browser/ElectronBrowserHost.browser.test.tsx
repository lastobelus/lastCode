import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { setPreviewBootstrapTokenOnUrl } from "@t3tools/shared/remote";
import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  ThreadId,
  type ClientSettings,
  type DesktopPreviewBridge,
  type DesktopBrowserRendererRequest,
  type PreviewSessionSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render, stubGlobal } from "../../test/render";

const mocks = vi.hoisted(() => ({
  getClientSettings: vi.fn<() => Promise<ClientSettings | null>>(),
  setClientSettings: vi.fn<(settings: ClientSettings) => Promise<void>>(),
  createTab: vi.fn<DesktopPreviewBridge["createTab"]>(),
  closeTab: vi.fn<DesktopPreviewBridge["closeTab"]>(),
  registerWebview: vi.fn<DesktopPreviewBridge["registerWebview"]>(),
  getPreviewConfig: vi.fn<DesktopPreviewBridge["getPreviewConfig"]>(),
  setHostingActivity: vi.fn(),
}));

vi.mock(import("~/env"), async (original) => ({ ...(await original()), isElectron: true }));

vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
}));

vi.mock(import("~/localApi"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    ensureLocalApi: () => ({ ...actual.ensureLocalApi(), persistence: mocks as never }),
  };
});

// The Electron desktop bridge; a browser has none.
vi.mock(import("~/components/preview/previewBridge"), async (original) => ({
  ...(await original()),
  previewBridge: {
    createTab: mocks.createTab,
    closeTab: mocks.closeTab,
    registerWebview: mocks.registerWebview,
    getPreviewConfig: mocks.getPreviewConfig,
  } as never,
}));

vi.mock(import("~/components/preview/usePreviewBridge"), async (original) => ({
  ...(await original()),
  usePreviewBridge: () => undefined,
}));
vi.mock(import("~/state/use-atom-command"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useAtomCommand: ((command, options) =>
      command.label === previewEnvironment.hostingActivity.label
        ? mocks.setHostingActivity
        : actual.useAtomCommand(command, options)) as typeof actual.useAtomCommand,
  };
});

import {
  __resetClientSettingsPersistenceForTests,
  ensureClientSettingsHydrated,
} from "~/hooks/useSettings";
import { reconcilePreviewServerSessions, resetPreviewStateForTests } from "~/previewStateStore";
import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { ElectronBrowserHost } from "./ElectronBrowserHost";
import { acquireBrowserSurfaceActivity, useBrowserSurfaceStore } from "./browserSurfaceStore";
import { previewRuntimeTabId } from "./previewRuntimeTabId";
import { ensureDesktopBrowserTab } from "./desktopBrowserDemand";
import * as previewRecovery from "~/components/preview/previewHostingRecovery";
import { getDesktopBrowserHostId } from "./desktopBrowserTransport";
import { previewEnvironment } from "~/state/preview";

vi.mock(import("~/components/preview/previewHostingRecovery"), { spy: true });

const threadRef = scopeThreadRef(
  EnvironmentId.make("host-webview-order"),
  ThreadId.make("thread-webview-order"),
);

const snapshot = (tabId: string, updatedAt: string): PreviewSessionSnapshot => ({
  threadId: threadRef.threadId,
  tabId,
  navStatus: { _tag: "Success", url: `https://example.com/${tabId}`, title: tabId },
  canGoBack: false,
  canGoForward: false,
  updatedAt,
});

function setup(): Disposable {
  __resetClientSettingsPersistenceForTests();
  mocks.getClientSettings.mockReset().mockResolvedValue(DEFAULT_CLIENT_SETTINGS);
  mocks.setHostingActivity.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  mocks.setClientSettings.mockReset().mockResolvedValue(undefined);
  mocks.createTab.mockReset().mockResolvedValue(undefined);
  mocks.closeTab.mockReset().mockResolvedValue(undefined);
  mocks.registerWebview.mockReset().mockResolvedValue(undefined);
  mocks.getPreviewConfig.mockReset().mockResolvedValue({
    partition: "persist:t3-preview-default",
    webPreferences: "contextIsolation=yes",
    preloadUrl: null,
  });
  return {
    [Symbol.dispose]() {
      resetPreviewStateForTests();
      useBrowserSurfaceStore.setState({ byTabId: {}, activityByTabId: {} });
      __resetClientSettingsPersistenceForTests();
    },
  };
}

async function renderHost() {
  await using stack = new AsyncDisposableStack();
  const screen = stack.use(
    await render(
      <AppAtomRegistryProvider>
        <ElectronBrowserHost />
      </AppAtomRegistryProvider>,
    ),
  );
  // Unmounting releases each tab on a close timer; run it now so it never fires in a later test.
  stack.defer(async () => {
    using _timers = fakeTimers();
    await screen.unmount();
    await vi.advanceTimersByTimeAsync(0);
  });
  await act(() => ensureClientSettingsHydrated());
  const environment = stack.move();
  return { container: screen.container, [Symbol.asyncDispose]: () => environment.disposeAsync() };
}

describe("ElectronBrowserHost", () => {
  it("waits for cold destination protection before preparing and releases a cancelled demand after acknowledgement", async () => {
    using _state = setup();
    const initial = snapshot("pending-protection", "2026-01-01T00:00:01.000Z");
    const runtimeTabId = previewRuntimeTabId(threadRef, "protection-epoch", initial.tabId);
    let acknowledge!: (value: unknown) => void;
    mocks.setHostingActivity.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          acknowledge = resolve;
        }),
    );
    using prepare = vi.spyOn(previewRecovery, "prepareHostedPreview");
    const release = acquireBrowserSurfaceActivity(runtimeTabId);
    reconcilePreviewServerSessions(threadRef, {
      sessions: [initial],
      serverEpoch: "protection-epoch",
      revision: 1,
    });
    await using screen = await renderHost();
    expect(mocks.setHostingActivity).toHaveBeenCalledTimes(1);
    expect(prepare).not.toHaveBeenCalled();
    expect(screen.container.querySelector("webview")).toBeNull();
    await act(() => release());
    await act(async () => acknowledge({ _tag: "Success", value: undefined }));
    expect(prepare).not.toHaveBeenCalled();
    const first = mocks.setHostingActivity.mock.calls[0]![0];
    expect(mocks.setHostingActivity).toHaveBeenLastCalledWith({
      ...first,
      input: { ...first.input, active: false },
    });
    expect(mocks.createTab).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "reloads a retained native guest after another preparer restarts the app, then preserves the new run (authentication=%s)",
    async (authenticated) => {
      using _state = setup();
      const initial = snapshot("retained-run", "2026-01-01T00:00:01.000Z");
      const runtimeTabId = previewRuntimeTabId(threadRef, "run-epoch", initial.tabId);
      const url = initial.navStatus._tag === "Idle" ? "" : initial.navStatus.url;
      using prepare = vi.spyOn(previewRecovery, "prepareHostedPreview").mockResolvedValue({
        url,
        managed: true,
        restored: false,
        runId: "original-run",
      });
      const navigate = vi.fn<DesktopPreviewBridge["navigate"]>().mockResolvedValue(undefined);
      const refresh = vi.fn<DesktopPreviewBridge["refresh"]>().mockResolvedValue(undefined);
      using _desktopBridge = stubGlobal("desktopBridge", {
        preview: {
          navigate,
          refresh,
          browserPresentation: async () => undefined,
          setAnnotationTheme: async () => undefined,
          onPointerEvent: () => () => undefined,
          onOpenLink: () => () => undefined,
          onBrowserSurfaceRequest: () => () => undefined,
          browserSurfaceResponse: async () => undefined,
        },
      });
      let release = acquireBrowserSurfaceActivity(runtimeTabId);
      reconcilePreviewServerSessions(threadRef, {
        sessions: [initial],
        serverEpoch: "run-epoch",
        revision: 1,
      });
      await using screen = await renderHost();
      const guest = screen.container.querySelector("webview");
      expect(guest).not.toBeNull();
      await act(() => release());
      const authenticatedUrl = setPreviewBootstrapTokenOnUrl(
        new URL(url),
        "fixture-return-credential",
      ).href;
      prepare.mockImplementation(async (_thread, _url, purpose) => ({
        url,
        managed: true,
        restored: false,
        restarted: false,
        runId: "resource-restarted-run",
        ...(authenticated && purpose === "navigation" ? { navigationUrl: authenticatedUrl } : {}),
      }));
      await act(async () => {
        release = acquireBrowserSurfaceActivity(runtimeTabId);
      });
      expect(prepare).toHaveBeenNthCalledWith(2, threadRef, url, "resource");
      expect(prepare).toHaveBeenLastCalledWith(threadRef, url, "navigation");
      if (authenticated) {
        expect(navigate).toHaveBeenCalledExactlyOnceWith(runtimeTabId, authenticatedUrl);
        expect(refresh).not.toHaveBeenCalled();
      } else {
        expect(refresh).toHaveBeenCalledExactlyOnceWith(runtimeTabId);
        expect(navigate).not.toHaveBeenCalled();
      }
      expect(screen.container.querySelector("webview")).toBe(guest);
      await act(() => release());
      await act(async () => {
        release = acquireBrowserSurfaceActivity(runtimeTabId);
      });
      expect(refresh).toHaveBeenCalledTimes(authenticated ? 0 : 1);
      expect(navigate).toHaveBeenCalledTimes(authenticated ? 1 : 0);
      expect(screen.container.querySelector("webview")).toBe(guest);
      await act(() => release());
    },
  );

  it("keeps a failed cold recovery dormant, then retries in the same selected tab without loading an unprepared URL", async () => {
    using _state = setup();
    const initial = snapshot("cold-retry", "2026-01-01T00:00:01.000Z");
    const runtimeTabId = previewRuntimeTabId(threadRef, "cold-epoch", initial.tabId);
    using prepare = vi
      .spyOn(previewRecovery, "prepareHostedPreview")
      .mockRejectedValueOnce(new Error("The saved listener is owned by another process."));
    let rendererRequest: ((request: DesktopBrowserRendererRequest) => void) | undefined;
    using _desktopBridge = stubGlobal("desktopBridge", {
      preview: {
        onBrowserRendererRequest: (listener: typeof rendererRequest) => {
          rendererRequest = listener;
          return () => {
            rendererRequest = undefined;
          };
        },
        browserPresentation: async () => undefined,
        setAnnotationTheme: async () => undefined,
        onPointerEvent: () => () => undefined,
        onOpenLink: () => () => undefined,
        onBrowserSurfaceRequest: () => () => undefined,
        browserSurfaceResponse: async () => undefined,
      },
    });
    const createElement = document.createElement.bind(document);
    using _createElement = vi.spyOn(document, "createElement").mockImplementation(((
      tagName: string,
      options?: ElementCreationOptions,
    ) => {
      const element = createElement(tagName, options);
      return tagName === "webview"
        ? Object.assign(element, { getWebContentsId: () => 45 })
        : element;
    }) as typeof document.createElement);
    reconcilePreviewServerSessions(threadRef, {
      sessions: [initial],
      serverEpoch: "cold-epoch",
      revision: 1,
    });
    await using screen = await renderHost();
    expect(screen.container.querySelector("webview")).toBeNull();
    let first!: Promise<void>;
    await act(() => {
      first = ensureDesktopBrowserTab(runtimeTabId);
      void first.catch(() => undefined);
    });
    await expect(first).rejects.toThrow("owned by another process");
    expect(screen.container.querySelector("webview")).toBeNull();
    expect(mocks.createTab).not.toHaveBeenCalled();
    prepare.mockResolvedValueOnce({
      url: "https://fresh.example.test/",
      managed: true,
      restored: true,
    });
    let retry!: Promise<void>;
    await act(() => {
      retry = ensureDesktopBrowserTab(runtimeTabId, "https://fresh.example.test/");
    });
    await retry;
    expect(screen.container.querySelector("webview")?.getAttribute("src")).toBe(
      "https://fresh.example.test/",
    );
    expect(mocks.registerWebview).toHaveBeenCalledWith(runtimeTabId, 45);
    await act(() => {
      reconcilePreviewServerSessions(threadRef, {
        sessions: [
          {
            ...initial,
            navStatus: { _tag: "Success", url: "https://later.example.test/", title: "Later" },
          },
        ],
        serverEpoch: "cold-epoch",
        revision: 2,
      });
    });
    await act(() => {
      rendererRequest!({
        action: "unload",
        environmentId: threadRef.environmentId,
        desktopHostId: getDesktopBrowserHostId(threadRef.environmentId),
        threadId: threadRef.threadId,
        tabId: initial.tabId,
      });
    });
    expect(screen.container.querySelector("webview")).toBeNull();
    prepare.mockResolvedValueOnce({
      url: "https://later.example.test/",
      managed: false,
      restored: false,
    });
    await act(() => {
      retry = ensureDesktopBrowserTab(runtimeTabId);
    });
    await retry;
    expect(screen.container.querySelector("webview")?.getAttribute("src")).toBe(
      "https://later.example.test/",
    );
    expect(prepare).toHaveBeenLastCalledWith(
      threadRef,
      "https://later.example.test/",
      "navigation",
    );
  });

  it("never moves a tab's webview when the server reorders tabs by last update", async () => {
    using _state = setup();
    const releaseOne = acquireBrowserSurfaceActivity(
      previewRuntimeTabId(threadRef, "server-a", "tab_7"),
    );
    const releaseTwo = acquireBrowserSurfaceActivity(
      previewRuntimeTabId(threadRef, "server-a", "tab_8"),
    );
    reconcilePreviewServerSessions(threadRef, {
      sessions: [
        snapshot("tab_7", "2026-01-01T00:00:01.000Z"),
        snapshot("tab_8", "2026-01-01T00:00:02.000Z"),
      ],
      serverEpoch: "server-a",
      revision: 1,
    });
    await using screen = await renderHost();

    const host = screen.container.querySelector("[data-electron-browser-host]")!;
    const webviews = () => [...host.querySelectorAll("webview")];
    const before = webviews();
    expect(before.map((node) => node.getAttribute("data-preview-server-tab")).toSorted()).toEqual([
      "tab_7",
      "tab_8",
    ]);

    // Electron destroys a webview's guest when its element leaves the DOM, so a reorder that
    // detaches and re-inserts the element blanks the tab.
    const detached: Node[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) detached.push(...record.removedNodes);
    });
    observer.observe(host, { childList: true, subtree: true });

    await act(async () => {
      reconcilePreviewServerSessions(threadRef, {
        sessions: [
          snapshot("tab_8", "2026-01-01T00:00:02.000Z"),
          snapshot("tab_7", "2026-01-01T00:00:03.000Z"),
        ],
        serverEpoch: "server-a",
        revision: 2,
      });
    });
    observer.takeRecords().forEach((record) => detached.push(...record.removedNodes));
    observer.disconnect();

    expect(detached).toEqual([]);
    const after = webviews();
    expect(after).toHaveLength(2);
    expect(after.every((node, index) => node.isSameNode(before[index]!))).toBe(true);
    releaseOne();
    releaseTwo();
  });
});
