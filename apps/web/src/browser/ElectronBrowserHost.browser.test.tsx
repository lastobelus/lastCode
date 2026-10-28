import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  AVAILABLE_CONNECTION_STATE,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import { setPreviewBootstrapTokenOnUrl } from "@t3tools/shared/remote";
import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  ThreadId,
  type ClientSettings,
  type DesktopPreviewBridge,
  type DesktopBrowserRendererRequest,
  type PreviewSessionSnapshot,
  type ServerConfig,
  PreviewHostingError,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
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
  environmentSession: {
    ...(await original()).environmentSession,
    initialConfigValueAtom: () => hostingConfig,
  },
}));
vi.mock(import("~/connection/catalog"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentCatalog: { ...actual.environmentCatalog, stateAtom: () => hostingConnection },
  };
});

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
import { AppAtomRegistryProvider, appAtomRegistry } from "~/rpc/atomRegistry";
import { ElectronBrowserHost } from "./ElectronBrowserHost";
import { acquireBrowserSurfaceActivity, useBrowserSurfaceStore } from "./browserSurfaceStore";
import { previewRuntimeTabId } from "./previewRuntimeTabId";
import { ensureDesktopBrowserTab } from "./desktopBrowserDemand";
import * as previewRecovery from "~/components/preview/previewHostingRecovery";
import { getDesktopBrowserHostId } from "./desktopBrowserTransport";
import { previewEnvironment } from "~/state/preview";

vi.mock(import("~/components/preview/previewHostingRecovery"), { spy: true });

const hostingConfig = Atom.make<ServerConfig | null>(null).pipe(Atom.keepAlive);
const hostingConnection = Atom.make<AsyncResult.AsyncResult<SupervisorConnectionState>>(
  AsyncResult.initial(),
).pipe(Atom.keepAlive);
const connected = (generation: number): SupervisorConnectionState => ({
  ...AVAILABLE_CONNECTION_STATE,
  phase: "connected",
  generation,
});
const configWithActivity = (advertised: boolean): ServerConfig =>
  ({
    environment: { capabilities: advertised ? { previewHostingActivity: true } : {} },
  }) as ServerConfig;

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

async function mountActivityTab(tabId: string, initialUrl?: string) {
  await using stack = new AsyncDisposableStack();
  const saved = snapshot(tabId, "2026-01-01T00:00:01.000Z");
  const initial = {
    ...saved,
    ...(initialUrl === undefined
      ? {}
      : { navStatus: { _tag: "Success" as const, url: initialUrl, title: tabId } }),
    runtime: "desktop" as const,
  };
  const runtimeTabId = previewRuntimeTabId(threadRef, "activity-epoch", initial.tabId);
  const url = initial.navStatus._tag === "Idle" ? "" : initial.navStatus.url;
  const prepare = stack.use(
    vi.spyOn(previewRecovery, "prepareHostedPreview").mockResolvedValue({
      url,
      managed: initialUrl === undefined,
      restored: false,
      ...(initialUrl === undefined ? { runId: "healthy-run" } : {}),
    }),
  );
  const release = acquireBrowserSurfaceActivity(runtimeTabId);
  reconcilePreviewServerSessions(threadRef, {
    sessions: [initial],
    serverEpoch: "activity-epoch",
    revision: 1,
  });
  const screen = stack.use(await renderHost());
  const environment = stack.move();
  return {
    initial,
    runtimeTabId,
    url,
    prepare,
    release,
    container: screen.container,
    [Symbol.asyncDispose]: () => environment.disposeAsync(),
  };
}

function setup(): Disposable {
  appAtomRegistry.set(hostingConfig, configWithActivity(true));
  appAtomRegistry.set(hostingConnection, AsyncResult.success(connected(1)));
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
  vi.mocked(previewRecovery.prepareHostedPreview)
    .mockReset()
    .mockImplementation(async (_thread, url) => ({
      url,
      managed: false,
      restored: false,
    }));
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
  it("opens desktop-runtime tabs on an older remote host without calling an unadvertised activity RPC", async () => {
    using _state = setup();
    appAtomRegistry.set(hostingConfig, configWithActivity(false));
    mocks.setHostingActivity.mockRejectedValue(
      new Error("Unknown request tag: previewHosting.activity"),
    );
    await using tab = await mountActivityTab("older-host");
    const { initial, runtimeTabId, url, release, container } = tab;
    expect(mocks.setHostingActivity).not.toHaveBeenCalled();
    expect(container.querySelector("webview")?.getAttribute("src")).toBe(url);
    // Desktop-runtime tabs carry the same native reservation/attachment identity as server tabs.
    expect(mocks.createTab).toHaveBeenCalledWith(
      runtimeTabId,
      expect.objectContaining({
        serverTab: {
          threadId: threadRef.threadId,
          tabId: initial.tabId,
          desktopHostId: getDesktopBrowserHostId(threadRef.environmentId),
        },
      }),
    );
    await act(() => release());
    expect(mocks.setHostingActivity).not.toHaveBeenCalled();
  });

  it.each([
    new Error("This connection requires preview:operate."),
    new PreviewHostingError({ reason: "capacity", message: "All preview slots are protected." }),
    new PreviewHostingError({ reason: "unavailable", message: "Activity storage failed." }),
  ])("keeps an advertised activity failure blocking preparation: %s", async (error) => {
    using _state = setup();
    mocks.setHostingActivity.mockResolvedValueOnce({ _tag: "Failure", cause: Cause.fail(error) });
    await using tab = await mountActivityTab("failed-activity");
    const { prepare, release, container } = tab;
    expect(mocks.setHostingActivity).toHaveBeenCalledOnce();
    expect(prepare).not.toHaveBeenCalled();
    expect(mocks.createTab).not.toHaveBeenCalled();
    expect(container.querySelector("webview")).toBeNull();
    await act(() => release());
  });

  it.each([false, true])(
    "uses the reconnected host's activity capability without remounting or reloading a healthy guest (advertised=%s)",
    async (advertised) => {
      using _state = setup();
      const refresh = vi.fn().mockResolvedValue(undefined);
      const navigate = vi.fn().mockResolvedValue(undefined);
      using _desktopBridge = stubGlobal("desktopBridge", {
        getWindowZoomFactor: () => 1,
        preview: {
          refresh,
          navigate,
          browserPresentation: async () => undefined,
          setAnnotationTheme: async () => undefined,
          onPointerEvent: () => () => undefined,
          onOpenLink: () => () => undefined,
          onBrowserSurfaceRequest: () => () => undefined,
          browserSurfaceResponse: async () => undefined,
        },
      });
      await using tab = await mountActivityTab("reconnect");
      const { release, container } = tab;
      const guest = container.querySelector("webview");
      expect(guest).not.toBeNull();
      const first = mocks.setHostingActivity.mock.calls[0]![0];
      await act(() => {
        appAtomRegistry.set(
          hostingConnection,
          AsyncResult.success({ ...connected(1), phase: "backoff" }),
        );
        appAtomRegistry.set(hostingConfig, null);
      });
      expect(mocks.setHostingActivity).toHaveBeenCalledTimes(1);
      expect(container.querySelector("webview")).toBe(guest);
      await act(() => {
        appAtomRegistry.set(hostingConnection, AsyncResult.success(connected(2)));
      });
      expect(mocks.setHostingActivity).toHaveBeenCalledTimes(1);
      await act(() => appAtomRegistry.set(hostingConfig, configWithActivity(advertised)));
      expect(mocks.setHostingActivity).toHaveBeenCalledTimes(advertised ? 2 : 1);
      const renewed = mocks.setHostingActivity.mock.calls[1]?.[0];
      if (advertised) {
        expect(renewed.input.active).toBe(true);
        expect(renewed.input.activityId).not.toBe(first.input.activityId);
      }
      expect(container.querySelector("webview")).toBe(guest);
      expect(mocks.createTab).toHaveBeenCalledTimes(1);
      expect(mocks.closeTab).not.toHaveBeenCalled();
      expect(refresh).not.toHaveBeenCalled();
      expect(navigate).not.toHaveBeenCalled();
      await act(() => release());
      if (advertised)
        expect(mocks.setHostingActivity).toHaveBeenLastCalledWith({
          ...renewed,
          input: { ...renewed.input, active: false },
        });
      else expect(mocks.setHostingActivity).toHaveBeenCalledTimes(1);
    },
  );

  it("does not release a disconnected declaration through a new connection after its late acknowledgement", async () => {
    using _state = setup();
    let acknowledge!: (value: unknown) => void;
    mocks.setHostingActivity.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          acknowledge = resolve;
        }),
    );
    await using tab = await mountActivityTab("late-reconnect");
    const { prepare, release, container } = tab;
    expect(container.querySelector("webview")).toBeNull();
    await act(() => {
      appAtomRegistry.set(
        hostingConnection,
        AsyncResult.success({ ...connected(1), phase: "backoff" }),
      );
    });
    await act(() => appAtomRegistry.set(hostingConnection, AsyncResult.success(connected(2))));
    expect(mocks.setHostingActivity).toHaveBeenCalledTimes(2);
    const renewed = mocks.setHostingActivity.mock.calls[1]![0];
    expect(container.querySelector("webview")).not.toBeNull();
    expect(prepare).toHaveBeenCalledOnce();
    await act(() => acknowledge({ _tag: "Success", value: undefined }));
    expect(mocks.setHostingActivity).toHaveBeenCalledTimes(2);
    expect(prepare).toHaveBeenCalledOnce();
    await act(() => release());
    expect(mocks.setHostingActivity).toHaveBeenCalledTimes(3);
    expect(mocks.setHostingActivity).toHaveBeenLastCalledWith({
      ...renewed,
      input: { ...renewed.input, active: false },
    });
  });

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

  it.each([
    { authenticated: false, hash: "" },
    { authenticated: true, hash: "" },
    { authenticated: false, hash: "#document" },
    { authenticated: true, hash: "#document" },
  ])(
    "reloads a retained native guest after another preparer restarts the app, then preserves the new run (authentication=$authenticated, hash=$hash)",
    async ({ authenticated, hash }) => {
      using _state = setup();
      const saved = snapshot("retained-run", "2026-01-01T00:00:01.000Z");
      const initial = {
        ...saved,
        navStatus: {
          _tag: "Success" as const,
          url: `https://example.com/retained-run${hash}`,
          title: "Retained",
        },
      };
      const runtimeTabId = previewRuntimeTabId(threadRef, "run-epoch", initial.tabId);
      const url = initial.navStatus.url;
      using prepare = vi.spyOn(previewRecovery, "prepareHostedPreview").mockResolvedValue({
        url,
        managed: true,
        restored: false,
        runId: "original-run",
      });
      const navigate = vi.fn<DesktopPreviewBridge["navigate"]>().mockResolvedValue(undefined);
      const refresh = vi.fn<DesktopPreviewBridge["refresh"]>().mockResolvedValue(undefined);
      using _desktopBridge = stubGlobal("desktopBridge", {
        getWindowZoomFactor: () => 1,
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

  it.each([undefined, "https://unmanaged.example.test/", "about:blank"])(
    "preserves input entered on a new managed destination while its preparation is pending (previous=%s)",
    async (initialUrl) => {
      using _state = setup();
      const editor = document.createElement("input");
      const refresh = vi.fn<DesktopPreviewBridge["refresh"]>().mockImplementation(async () => {
        editor.value = "";
      });
      const navigate = vi.fn<DesktopPreviewBridge["navigate"]>().mockImplementation(async () => {
        editor.value = "";
      });
      using _desktopBridge = stubGlobal("desktopBridge", {
        getWindowZoomFactor: () => 1,
        preview: {
          refresh,
          navigate,
          browserPresentation: async () => undefined,
          setAnnotationTheme: async () => undefined,
          onPointerEvent: () => () => undefined,
          onOpenLink: () => () => undefined,
          onBrowserSurfaceRequest: () => () => undefined,
          browserSurfaceResponse: async () => undefined,
        },
      });
      await using tab = await mountActivityTab("new-destination", initialUrl);
      const { initial, prepare, runtimeTabId, release, container } = tab;
      const guest = container.querySelector("webview")!;
      expect(guest).not.toBeNull();
      guest.append(editor);
      let finishPreparation!: (
        value: Awaited<ReturnType<typeof previewRecovery.prepareHostedPreview>>,
      ) => void;
      prepare.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishPreparation = resolve;
          }),
      );
      const destination = "http://127.0.0.1:4000/form#draft";
      await act(() =>
        reconcilePreviewServerSessions(threadRef, {
          sessions: [
            { ...initial, navStatus: { _tag: "Success", url: destination, title: "App B" } },
          ],
          serverEpoch: "activity-epoch",
          revision: 2,
        }),
      );
      expect(prepare).toHaveBeenLastCalledWith(threadRef, destination, "resource");
      editor.value = "draft typed after app B loaded";
      await act(() =>
        finishPreparation({
          url: destination,
          managed: true,
          restored: false,
          restarted: false,
          runId: "app-b-run",
        }),
      );
      expect(editor.value).toBe("draft typed after app B loaded");
      expect(container.querySelector("webview")).toBe(guest);
      expect(mocks.createTab).toHaveBeenCalledTimes(1);
      expect(refresh).not.toHaveBeenCalled();
      expect(navigate).not.toHaveBeenCalled();
      expect(prepare).toHaveBeenCalledTimes(2);

      prepare.mockResolvedValue({
        url: destination,
        managed: true,
        restored: false,
        runId: "app-b-run",
      });
      await act(() => release());
      let releaseReturn!: () => void;
      await act(() => {
        releaseReturn = acquireBrowserSurfaceActivity(runtimeTabId);
      });
      expect(prepare).toHaveBeenLastCalledWith(threadRef, destination, "resource");
      expect(editor.value).toBe("draft typed after app B loaded");
      expect(refresh).not.toHaveBeenCalled();
      expect(navigate).not.toHaveBeenCalled();

      await act(() => releaseReturn());
      prepare.mockResolvedValue({
        url: destination,
        managed: true,
        restored: false,
        runId: "app-b-restarted",
      });
      await act(() => {
        releaseReturn = acquireBrowserSurfaceActivity(runtimeTabId);
      });
      expect(refresh).toHaveBeenCalledExactlyOnceWith(runtimeTabId);
      expect(navigate).not.toHaveBeenCalled();
      expect(editor.value).toBe("");
      await act(() => releaseReturn());
    },
  );

  it("prepares a one-use navigation credential when the new destination actually needed recovery", async () => {
    using _state = setup();
    const navigate = vi.fn<DesktopPreviewBridge["navigate"]>().mockResolvedValue(undefined);
    const refresh = vi.fn<DesktopPreviewBridge["refresh"]>().mockResolvedValue(undefined);
    using _desktopBridge = stubGlobal("desktopBridge", {
      getWindowZoomFactor: () => 1,
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
    await using tab = await mountActivityTab("recovered-destination");
    const { initial, prepare, runtimeTabId, release, container } = tab;
    const guest = container.querySelector("webview");
    const destination = "http://127.0.0.1:4000/form#draft";
    const navigationUrl = setPreviewBootstrapTokenOnUrl(
      new URL(destination),
      "fixture-new-destination-credential",
    ).href;
    prepare.mockImplementation(async (_thread, _url, purpose) => ({
      url: destination,
      managed: true,
      restored: true,
      restarted: true,
      runId: "recovered-app-b",
      ...(purpose === "navigation" ? { navigationUrl } : {}),
    }));
    await act(() =>
      reconcilePreviewServerSessions(threadRef, {
        sessions: [
          {
            ...initial,
            navStatus: {
              _tag: "LoadFailed",
              url: destination,
              title: "App B",
              code: -102,
              description: "Connection refused",
            },
          },
        ],
        serverEpoch: "activity-epoch",
        revision: 2,
      }),
    );
    expect(prepare).toHaveBeenNthCalledWith(2, threadRef, destination, "resource");
    expect(prepare).toHaveBeenLastCalledWith(threadRef, destination, "navigation");
    expect(navigate).toHaveBeenCalledExactlyOnceWith(runtimeTabId, navigationUrl);
    expect(refresh).not.toHaveBeenCalled();
    expect(container.querySelector("webview")).toBe(guest);
    await act(() => release());
    let releaseReturn!: () => void;
    await act(() => {
      releaseReturn = acquireBrowserSurfaceActivity(runtimeTabId);
    });
    expect(prepare).toHaveBeenLastCalledWith(threadRef, destination, "resource");
    expect(navigate).toHaveBeenCalledTimes(1);
    await act(() => releaseReturn());
  });

  it("keeps a failed cold recovery dormant, then retries in the same selected tab without loading an unprepared URL", async () => {
    using _state = setup();
    const initial = {
      ...snapshot("cold-retry", "2026-01-01T00:00:01.000Z"),
      runtime: "desktop" as const,
    };
    const runtimeTabId = previewRuntimeTabId(threadRef, "cold-epoch", initial.tabId);
    using prepare = vi
      .spyOn(previewRecovery, "prepareHostedPreview")
      .mockRejectedValueOnce(new Error("The saved listener is owned by another process."));
    let rendererRequest: ((request: DesktopBrowserRendererRequest) => void) | undefined;
    using _desktopBridge = stubGlobal("desktopBridge", {
      getWindowZoomFactor: () => 1,
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
