import { HostedPreviewUrlTooLongError } from "@t3tools/client-runtime/preview-hosting";
import {
  BUILT_IN_BROWSER_PROFILES,
  DEFAULT_BROWSER_PROFILE_ID,
  DEFAULT_PREVIEW_APPEARANCE,
  DEFAULT_PREVIEW_ZOOM_FACTOR,
  EnvironmentId,
  FILL_PREVIEW_VIEWPORT,
  ThreadId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { act, Profiler, StrictMode, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import type { PreviewableServer } from "./useDiscoveredLocalServers";

const mocks = vi.hoisted(() => ({
  openExternal: vi.fn(async (_url: string): Promise<void> => undefined),
  clearRecovery: vi.fn(),
  recoverHostedPreview: vi.fn(
    async (_ref: ScopedThreadRef, _url: string): Promise<boolean> => false,
  ),
  preparedRecoveryUrl: null as string | null,
  // Synthetic private address exercises WSL host mapping.
  environmentUrl: "http://172.16.0.2:3773" as string | null,
  restarted: false,
  serverRuntime: false,
  serverNavigate: vi.fn((_url: string) => true),
  serverReload: vi.fn(() => true),
  serverControl: null as
    | ((control: { controller: string; canOperate: boolean } | null) => void)
    | null,
  preparationPurposes: [] as Array<string | undefined>,
  refresh: vi.fn(async (): Promise<void> => undefined),
  navStatus: { _tag: "Success", url: "http://example.com/", title: "Example" } as
    | { _tag: "Success"; url: string; title: string }
    | { _tag: "LoadFailed"; url: string; code: number; description: string },
  navigate: vi.fn(async (_tabId: string, _url: string): Promise<void> => undefined),
  rememberPreviewUrl: vi.fn(),
  readPreparedConnection: vi.fn(() => ({ httpBaseUrl: "http://172.16.0.2:3773" })),
  readEnvironmentScope: vi.fn((_environmentId?: unknown, _scope?: unknown) => true),
  setAnnotationSendEnabled: vi.fn(async (_tabId: string, _enabled: boolean): Promise<void> => {}),
  cancelPickElement: vi.fn(async (_tabId: string) => undefined),
  openPictureInPicture: vi.fn(async (_tabId: string): Promise<void> => undefined),
  closePictureInPicture: vi.fn(async (_tabId: string): Promise<void> => undefined),
  pickElement: vi.fn(),
  addPreviewAnnotation: vi.fn(),
  addImage: vi.fn(),
  toast: vi.fn(),
  pictureInPicture: false,
  showEmptyState: false,
  loading: false,
  serverEpoch: null as string | null,
  servers: [] as PreviewableServer[],
  recordingTabIds: new Set<string>(),
  recordingRuntimeTabId: null as string | null,
  recordVisitForThread: vi.fn(),
}));

const STUB_BROWSER_DEFAULTS = {
  viewport: FILL_PREVIEW_VIEWPORT,
  zoomFactor: DEFAULT_PREVIEW_ZOOM_FACTOR,
  appearance: DEFAULT_PREVIEW_APPEARANCE,
  autoShowFloatingPreview: true,
  profiles: BUILT_IN_BROWSER_PROFILES,
  profileId: DEFAULT_BROWSER_PROFILE_ID,
};

vi.mock("./previewHostingRecovery", () => ({
  recoverHostedPreview: mocks.recoverHostedPreview,
  prepareHostedPreview: async (
    _ref: Parameters<typeof import("./previewHostingRecovery").prepareHostedPreview>[0],
    url: string,
    purpose?: "navigation" | "resource",
  ) => {
    mocks.preparationPurposes.push(purpose);
    return {
      url: mocks.preparedRecoveryUrl ?? url,
      managed: mocks.preparedRecoveryUrl !== null,
      restored:
        purpose === "resource" && !mocks.restarted
          ? false
          : await mocks.recoverHostedPreview(_ref, url),
      restarted: mocks.restarted,
    };
  },
}));

vi.mock("~/browser/ServerBrowserSurface", async () => {
  const { createElement, useImperativeHandle } = await import("react");
  return {
    ServerBrowserSurface: (props: {
      ref: import("react").Ref<unknown>;
      onControl: (control: { controller: string; canOperate: boolean } | null) => void;
    }) => {
      mocks.serverControl = props.onControl;
      useImperativeHandle(props.ref, () => ({
        navigate: mocks.serverNavigate,
        reload: mocks.serverReload,
      }));
      return createElement("server-surface");
    },
  };
});

// The desktop bridge only exists inside Electron; the view reads it once at import.
vi.mock(import("./previewBridge"), async (original) => ({
  ...(await original()),
  previewBridge: {
    navigate: mocks.navigate,
    pickElement: mocks.pickElement,
    setAnnotationSendEnabled: mocks.setAnnotationSendEnabled,
    cancelPickElement: mocks.cancelPickElement,
    refresh: mocks.refresh,
    goBack: vi.fn(async () => undefined),
    goForward: vi.fn(async () => undefined),
    hardReload: vi.fn(async () => undefined),
    openDevTools: vi.fn(async () => undefined),
    setColorScheme: vi.fn(async () => undefined),
    zoomIn: vi.fn(async () => undefined),
    zoomOut: vi.fn(async () => undefined),
    resetZoom: vi.fn(async () => undefined),
    clearCookies: vi.fn(async () => undefined),
    clearCache: vi.fn(async () => undefined),
    pictureInPicture: {
      open: mocks.openPictureInPicture,
      close: mocks.closePictureInPicture,
    },
  } as never,
}));
vi.mock(import("~/browserHistoryStore"), async (original) => ({
  ...(await original()),
  recordVisitForThread: mocks.recordVisitForThread,
}));
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  readPreparedConnection: mocks.readPreparedConnection as never,
  readEnvironmentScope: mocks.readEnvironmentScope,
  useEnvironmentScope: mocks.readEnvironmentScope,
}));
vi.mock(import("~/browser/browserDefaults"), async (original) => ({
  ...(await original()),
  useBrowserDefaults: () => STUB_BROWSER_DEFAULTS,
  getBrowserDefaults: () => STUB_BROWSER_DEFAULTS,
}));
// Importing the store here cycles through utils and composerDraftStore back into this mock.
vi.mock(import("~/previewStateStore"), () => ({
  applyPreviewServerEvent: vi.fn(),
  applyPreviewServerSnapshot: vi.fn(),
  beginPreviewSessionClose: vi.fn(),
  cancelPreviewSessionClose: vi.fn(),
  capturePreviewOpenFocus: vi.fn(),
  hiddenPreviewTabIds: () => new Set<string>(),
  reconcilePreviewServerSessions: vi.fn(),
  whenPreviewTabKnown: vi.fn(),
  updatePreviewServerSnapshot: vi.fn(),
  isPreviewSupportedInRuntime: () => Boolean(window.desktopBridge?.preview),
  rememberPreviewUrl: mocks.rememberPreviewUrl,
  readThreadPreviewState: (() => ({
    sessions: { "tab-1": { navStatus: mocks.navStatus } },
  })) as never,
  useThreadPreviewState: (() => ({
    activeTabId: "tab-1",
    serverEpoch: mocks.serverEpoch,
    desktopByTabId: {
      "tab-1": {
        hasWebContents: true,
        canGoBack: false,
        canGoForward: false,
        loading: mocks.loading,
        zoomFactor: 1,
        pictureInPicture: mocks.pictureInPicture,
        colorScheme: "system",
        audioMuted: false,
        audible: false,
        controller: "none",
      },
    },
    recentlySeenUrls: [],
    sessions: mocks.showEmptyState
      ? {}
      : {
          "tab-1": {
            threadId: "thread-1",
            tabId: "tab-1",
            navStatus: mocks.navStatus,
            ...(mocks.serverRuntime ? { runtime: "server" } : {}),
            canGoBack: false,
            canGoForward: false,
            updatedAt: "2026-07-13T00:00:00.000Z",
          },
        },
  })) as never,
}));
vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  useEnvironment: (() => ({ label: "WSL" })) as never,
  useEnvironmentHttpBaseUrl: () => mocks.environmentUrl,
  usePrimaryEnvironmentId: () => null,
}));
vi.mock(import("~/browser/browserRecording"), async (original) => ({
  ...(await original()),
  findActiveBrowserRecordingRuntimeTabId: () => mocks.recordingRuntimeTabId,
  useActiveBrowserRecordingTabIds: () => mocks.recordingTabIds,
}));
vi.mock(import("~/components/ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: mocks.toast } };
});
vi.mock(import("./useDiscoveredLocalServers"), async (original) => ({
  ...(await original()),
  useDiscoveredLocalServers: () => mocks.servers,
}));
vi.mock(import("./usePreviewSession"), async (original) => ({
  ...(await original()),
  usePreviewSession: () => {},
}));

import { useComposerDraftStore } from "~/composerDraftStore";
import { useBrowserPointerStore } from "~/browser/browserPointerStore";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { usePreviewMiniPlayerStore } from "~/previewMiniPlayerStore";
vi.mock(import("./previewRecoveryRequest"), async (original) => ({
  ...(await original()),
  clearPreviewRecoveryRequest: mocks.clearRecovery,
  requestPreviewRecovery: vi.fn(),
  usePreviewRecoveryRequest: () => ({ status: "idle" as const }),
}));
vi.mock(import("~/localApi"), async (original) => ({
  ...(await original()),
  ensureLocalApi: vi.fn(() => ({ shell: { openExternal: mocks.openExternal } })) as never,
}));

import {
  requestHostedPreviewRefresh,
  completeHostedPreviewRefresh,
} from "~/browser/hostedPreviewRefresh";
import { PreviewView } from "./PreviewView";

const TEST_THREAD_REF = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
} as const;
const TEST_RUNTIME_TAB_ID = previewRuntimeTabId(TEST_THREAD_REF, null, "tab-1");

const desktopBridgeDescriptor = Object.getOwnPropertyDescriptor(window, "desktopBridge");
const roots: Root[] = [];
let root: Root;

async function render(node: ReactNode) {
  await act(async () => root.render(node));
}

function view(onSendAnnotation?: ComponentProps<typeof PreviewView>["onSendAnnotation"]) {
  return (
    <PreviewView
      threadRef={TEST_THREAD_REF}
      tabId="tab-1"
      visible
      {...(onSendAnnotation ? { onSendAnnotation } : {})}
    />
  );
}

function annotation(id: string, screenshot: unknown = null) {
  return {
    id,
    pageUrl: "https://example.com/dashboard",
    pageTitle: "Dashboard",
    comment: "Tighten this spacing",
    elements: [],
    regions: [],
    strokes: [],
    styleChanges: [],
    screenshot,
    createdAt: "2026-07-27T00:00:00.000Z",
  };
}

async function submitAddress(text: string) {
  await act(async () => {
    const input = page.getByPlaceholder("Search or enter URL");
    await userEvent.click(input);
    await userEvent.fill(input, text);
    await userEvent.keyboard("{Enter}");
  });
}

function hasCursor() {
  return document.querySelector("svg.lucide-mouse-pointer2") !== null;
}

describe("PreviewView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.recoverHostedPreview.mockReset().mockResolvedValue(false);
    mocks.preparedRecoveryUrl = null;
    mocks.environmentUrl = "http://172.16.0.2:3773";
    mocks.restarted = false;
    mocks.serverRuntime = false;
    mocks.serverNavigate.mockReset().mockReturnValue(true);
    mocks.serverReload.mockReset().mockReturnValue(true);
    mocks.serverControl = null;
    mocks.preparationPurposes = [];
    mocks.refresh.mockClear();
    mocks.clearRecovery.mockClear();
    mocks.navStatus = { _tag: "Success", url: "http://example.com/", title: "Example" };

    mocks.readEnvironmentScope.mockReset().mockReturnValue(true);
    mocks.setAnnotationSendEnabled.mockReset().mockResolvedValue(undefined);
    mocks.pickElement.mockReset();
    mocks.pictureInPicture = false;
    mocks.showEmptyState = false;
    mocks.loading = false;
    mocks.serverEpoch = null;
    mocks.servers = [];
    mocks.recordingTabIds = new Set();
    mocks.recordingRuntimeTabId = null;
    useComposerDraftStore.setState({
      addPreviewAnnotation: mocks.addPreviewAnnotation,
      addImage: mocks.addImage,
    });
    usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
    useBrowserPointerStore.setState({ byTabId: {} });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    roots.push(root);
  });

  afterEach(async () => {
    for (const each of roots.splice(0)) await act(async () => each.unmount());
    document.body.replaceChildren();
    if (desktopBridgeDescriptor)
      Object.defineProperty(window, "desktopBridge", desktopBridgeDescriptor);
    else Reflect.deleteProperty(window, "desktopBridge");
    vi.useRealTimers();
  });

  it("retains a restarted panel through StrictMode and waits for stream control before sending", async () => {
    mocks.serverRuntime = true;
    mocks.restarted = true;
    mocks.navStatus = { _tag: "Success", url: "http://localhost:5173/qa", title: "QA" };
    mocks.recoverHostedPreview.mockResolvedValue(true);
    await act(() =>
      root.render(
        <StrictMode>
          <PreviewView threadRef={TEST_THREAD_REF} tabId="tab-1" visible />
        </StrictMode>,
      ),
    );
    expect(mocks.preparationPurposes).toEqual(["resource"]);
    expect(mocks.serverReload).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
    await act(async () => mocks.serverControl?.({ controller: "you", canOperate: true }));
    expect(mocks.preparationPurposes).toEqual(["resource", undefined]);
    expect(mocks.serverReload).toHaveBeenCalledTimes(1);
    await act(async () => mocks.serverControl?.(null));
    await act(async () => mocks.serverControl?.({ controller: "you", canOperate: true }));
    expect(mocks.serverReload).toHaveBeenCalledTimes(1);
  });

  it("retries a rejected stream dispatch on reconnection without replaying an accepted command", async () => {
    mocks.serverRuntime = true;
    mocks.restarted = true;
    mocks.navStatus = { _tag: "Success", url: "http://localhost:5173/qa", title: "QA" };
    mocks.recoverHostedPreview.mockResolvedValue(true);
    mocks.serverReload.mockReturnValueOnce(false).mockReturnValue(true);
    await act(() => root.render(<PreviewView threadRef={TEST_THREAD_REF} tabId="tab-1" visible />));
    await act(async () => mocks.serverControl?.({ controller: "you", canOperate: true }));
    expect(mocks.serverReload).toHaveBeenCalledTimes(1);
    await act(async () => mocks.serverControl?.(null));
    await act(async () => mocks.serverControl?.({ controller: "you", canOperate: true }));
    expect(mocks.serverReload).toHaveBeenCalledTimes(2);
    expect(mocks.preparationPurposes).toEqual(["resource", undefined, undefined]);
    await act(async () => mocks.serverControl?.(null));
    await act(async () => mocks.serverControl?.({ controller: "you", canOperate: true }));
    expect(mocks.serverReload).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])(
    "retains a queued handoff until control is ready and respects newer navigation (%s)",
    async (navigateAway) => {
      mocks.serverRuntime = true;
      const original = "http://localhost:5173/qa?token=application-reset#token=application-invite";
      mocks.navStatus = { _tag: "Success", url: original, title: "QA" };
      mocks.recoverHostedPreview.mockResolvedValue(true);
      const requestId = requestHostedPreviewRefresh(TEST_THREAD_REF, "tab-1", original);
      await act(() =>
        root.render(
          <StrictMode>
            <PreviewView threadRef={TEST_THREAD_REF} tabId="tab-1" visible />
          </StrictMode>,
        ),
      );
      expect(mocks.serverReload).not.toHaveBeenCalled();
      if (navigateAway) {
        mocks.navStatus = { _tag: "Success", url: "https://example.com/newer", title: "Newer" };
        await act(() =>
          root.render(
            <StrictMode>
              <PreviewView threadRef={TEST_THREAD_REF} tabId="tab-1" visible />
            </StrictMode>,
          ),
        );
      }
      await act(async () => mocks.serverControl?.({ controller: "you", canOperate: true }));
      expect(mocks.serverReload).toHaveBeenCalledTimes(navigateAway ? 0 : 1);
      expect(mocks.serverNavigate).not.toHaveBeenCalled();
      await act(async () => mocks.serverControl?.(null));
      await act(async () => mocks.serverControl?.({ controller: "you", canOperate: true }));
      expect(mocks.serverReload).toHaveBeenCalledTimes(navigateAway ? 0 : 1);
      completeHostedPreviewRefresh(TEST_THREAD_REF, "tab-1", requestId);
    },
  );

  it.each(["Success", "LoadFailed"] as const)(
    "discards an unsent credential when a %s panel is hidden during authentication",
    async (status) => {
      mocks.navStatus =
        status === "Success"
          ? { _tag: "Success", url: "http://localhost:5173/qa", title: "QA" }
          : {
              _tag: "LoadFailed",
              url: "http://localhost:5173/qa",
              code: -102,
              description: "refused",
            };
      mocks.restarted = status === "Success";
      mocks.recoverHostedPreview.mockResolvedValue(true);
      if (status === "Success") mocks.recoverHostedPreview.mockResolvedValueOnce(true);
      let finishOldAuthentication!: (restored: boolean) => void;
      mocks.recoverHostedPreview.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishOldAuthentication = resolve;
          }),
      );
      await act(() =>
        root.render(<PreviewView threadRef={TEST_THREAD_REF} tabId="tab-1" visible />),
      );
      expect(mocks.refresh).not.toHaveBeenCalled();
      await act(() =>
        root.render(<PreviewView threadRef={TEST_THREAD_REF} tabId="tab-1" visible={false} />),
      );
      await act(async () => finishOldAuthentication(true));
      expect(mocks.refresh).not.toHaveBeenCalled();
      await act(() =>
        root.render(<PreviewView threadRef={TEST_THREAD_REF} tabId="tab-1" visible />),
      );
      expect(mocks.refresh).toHaveBeenCalledTimes(1);
      expect(mocks.recoverHostedPreview).toHaveBeenCalledTimes(status === "Success" ? 3 : 2);
    },
  );

  it("prepares a retained panel after its environment connection hydrates", async () => {
    mocks.environmentUrl = null;
    mocks.restarted = true;
    mocks.recoverHostedPreview.mockResolvedValue(true);
    await act(() => root.render(<PreviewView threadRef={TEST_THREAD_REF} tabId="tab-1" visible />));
    expect(mocks.preparationPurposes).toEqual([]);
    mocks.environmentUrl = "http://172.16.0.2:3773";
    await act(() => root.render(<PreviewView threadRef={TEST_THREAD_REF} tabId="tab-1" visible />));
    expect(mocks.preparationPurposes).toEqual(["resource", undefined]);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it.each(["submit", "reload", "automatic"])(
    "does not let a pending %s recovery replace a newer submitted address",
    async (action) => {
      let complete!: (restored: boolean) => void;
      mocks.recoverHostedPreview.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      );
      if (action === "automatic") {
        mocks.navStatus = {
          _tag: "LoadFailed",
          url: "http://localhost:5173/first",
          code: -102,
          description: "refused",
        };
      }
      await act(() =>
        root.render(<PreviewView threadRef={TEST_THREAD_REF} tabId="tab-1" visible />),
      );
      if (action === "submit") await submitAddress("http://localhost:5173/first");
      else if (action === "reload")
        await act(async () =>
          userEvent.click(page.getByRole("button", { name: "Refresh", exact: true })),
        );
      expect(mocks.navigate).not.toHaveBeenCalled();
      await submitAddress("https://example.com/newer");
      expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith(
        TEST_RUNTIME_TAB_ID,
        "https://example.com/newer",
      );
      await act(async () => complete(true));
      expect(mocks.navigate).toHaveBeenCalledTimes(1);
      expect(mocks.refresh).not.toHaveBeenCalled();
      expect(mocks.recordVisitForThread).toHaveBeenCalledExactlyOnceWith(
        TEST_THREAD_REF,
        "https://example.com/newer",
      );
    },
  );
  it("does not navigate an old tab after it changes while address recovery is pending", async () => {
    let complete!: (restored: boolean) => void;
    mocks.recoverHostedPreview.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    await act(() => root.render(<PreviewView threadRef={TEST_THREAD_REF} tabId="tab-1" visible />));
    await submitAddress("http://localhost:5173/first");
    mocks.navStatus = {
      _tag: "Success",
      url: "https://example.com/agent-navigation",
      title: "New destination",
    };
    await act(() => root.render(<PreviewView threadRef={TEST_THREAD_REF} tabId="tab-1" visible />));
    await act(async () => complete(true));
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.recordVisitForThread).not.toHaveBeenCalled();
  });

  it("waits for toolbar recovery before opening the prepared external destination", async () => {
    Object.defineProperty(window, "desktopBridge", { value: {}, configurable: true });
    const original = "http://localhost:5173/qa";
    const destination = "http://managed-server.ts.net:5173/qa";
    mocks.navStatus = { _tag: "Success", url: original, title: "QA" };
    mocks.preparedRecoveryUrl = destination;
    let complete!: (restored: boolean) => void;
    mocks.recoverHostedPreview.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    await act(() => root.render(<PreviewView threadRef={TEST_THREAD_REF} tabId="tab-1" visible />));
    await userEvent.hover(page.getByPlaceholder("Search or enter URL"));
    await act(async () =>
      userEvent.click(page.getByRole("button", { name: "Open in system browser" })),
    );
    expect(mocks.recoverHostedPreview).toHaveBeenCalledWith(TEST_THREAD_REF, original);
    expect(mocks.openExternal).not.toHaveBeenCalled();
    await act(async () => complete(true));
    expect(mocks.openExternal).toHaveBeenCalledExactlyOnceWith(destination);
  });

  it("restores a failed managed preview once, then reloads without an agent message", async () => {
    let complete!: (restored: boolean) => void;
    mocks.recoverHostedPreview.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const original = "http://localhost:5173/qa";
    mocks.navStatus = { _tag: "LoadFailed", url: original, code: -102, description: "refused" };
    await act(() => root.render(<PreviewView threadRef={TEST_THREAD_REF} tabId="tab-1" visible />));
    // A new snapshot of the same failed URL must not cancel or duplicate restoration.
    mocks.navStatus = { ...mocks.navStatus };
    await act(() =>
      root.render(<PreviewView threadRef={{ ...TEST_THREAD_REF }} tabId="tab-1" visible />),
    );
    expect(mocks.recoverHostedPreview).toHaveBeenCalledTimes(1);
    expect(mocks.recoverHostedPreview).toHaveBeenCalledWith(TEST_THREAD_REF, original);
    await act(async () => complete(true));
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    await act(() => root.render(<PreviewView threadRef={TEST_THREAD_REF} tabId="tab-1" visible />));
    expect(mocks.recoverHostedPreview).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    "completes failed-page recovery under StrictMode (restored=%s)",
    async (restored) => {
      let complete!: (restored: boolean) => void;
      mocks.recoverHostedPreview.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      );
      mocks.navStatus = {
        _tag: "LoadFailed",
        url: "http://localhost:5173/qa",
        code: -102,
        description: "refused",
      };
      await act(() =>
        root.render(
          <StrictMode>
            <PreviewView threadRef={TEST_THREAD_REF} tabId="tab-1" visible />
          </StrictMode>,
        ),
      );
      expect(mocks.recoverHostedPreview).toHaveBeenCalledTimes(1);
      expect(document.body.textContent?.includes("Restoring preview…")).toBe(true);
      await act(async () => complete(restored));
      expect(document.body.textContent?.includes("Restoring preview…")).toBe(false);
      expect(document.body.textContent?.includes("Ask agent to restore preview")).toBe(true);
      expect(mocks.refresh).toHaveBeenCalledTimes(restored ? 1 : 0);
      await act(() =>
        root.render(
          <StrictMode>
            <PreviewView threadRef={{ ...TEST_THREAD_REF }} tabId="tab-1" visible />
          </StrictMode>,
        ),
      );
      expect(mocks.recoverHostedPreview).toHaveBeenCalledTimes(1);
    },
  );

  it("settles a rejected recovery under StrictMode and leaves failure controls available", async () => {
    let rejectRecovery!: (cause: unknown) => void;
    mocks.recoverHostedPreview.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectRecovery = reject;
        }),
    );
    mocks.navStatus = {
      _tag: "LoadFailed",
      url: "http://localhost:5173/qa",
      code: -102,
      description: "refused",
    };
    const render = () =>
      root.render(
        <StrictMode>
          <PreviewView threadRef={TEST_THREAD_REF} tabId="tab-1" visible />
        </StrictMode>,
      );
    await act(render);
    expect(document.body.textContent?.includes("Restoring preview…")).toBe(true);
    await act(async () => rejectRecovery(new HostedPreviewUrlTooLongError()));
    expect(document.body.textContent?.includes("Restoring preview…")).toBe(false);
    expect(document.body.textContent?.includes("Ask agent to restore preview")).toBe(true);
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledTimes(1);
    await act(render);
    expect(mocks.recoverHostedPreview).toHaveBeenCalledTimes(1);
    expect(mocks.toast).toHaveBeenCalledTimes(1);
    mocks.recoverHostedPreview.mockRejectedValueOnce(new HostedPreviewUrlTooLongError());
    await act(async () =>
      userEvent.click(page.getByRole("button", { name: "Refresh", exact: true })),
    );
    expect(mocks.recoverHostedPreview).toHaveBeenCalledTimes(2);
    expect(mocks.toast).toHaveBeenCalledTimes(2);
    expect(document.body.textContent?.includes("Ask agent to restore preview")).toBe(true);
  });

  it("retries a transient native recovery failure when the user reloads", async () => {
    const original = "http://localhost:5173/qa";
    mocks.navStatus = { _tag: "LoadFailed", url: original, code: -102, description: "refused" };
    mocks.recoverHostedPreview.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await act(() => root.render(<PreviewView threadRef={TEST_THREAD_REF} tabId="tab-1" visible />));
    expect(mocks.recoverHostedPreview).toHaveBeenCalledTimes(1);
    expect(mocks.refresh).not.toHaveBeenCalled();
    await act(async () =>
      userEvent.click(page.getByRole("button", { name: "Refresh", exact: true })),
    );
    expect(mocks.recoverHostedPreview).toHaveBeenCalledTimes(2);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("retries an already failed tab when its environment reconnects at a new address", async () => {
    mocks.navStatus = {
      _tag: "LoadFailed",
      url: "http://192.168.1.30:5173/qa",
      code: -102,
      description: "refused",
    };
    await act(() => root.render(<PreviewView threadRef={TEST_THREAD_REF} tabId="tab-1" visible />));
    expect(mocks.recoverHostedPreview).toHaveBeenCalledTimes(1);
    mocks.environmentUrl = "http://managed-server.ts.net:3773";
    mocks.preparedRecoveryUrl = "http://managed-server.ts.net:5173/qa";
    mocks.recoverHostedPreview.mockResolvedValue(true);
    await act(() => root.render(<PreviewView threadRef={TEST_THREAD_REF} tabId="tab-1" visible />));
    expect(mocks.recoverHostedPreview).toHaveBeenCalledTimes(2);
    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith(
      TEST_RUNTIME_TAB_ID,
      mocks.preparedRecoveryUrl,
    );
  });

  it("navigates failed tabs to the current environment address after recovery and on reload", async () => {
    const original = "http://192.168.1.30:5173/qa?q=1#part";
    const current = "http://managed-server.ts.net:5173/qa?q=1#part";
    mocks.navStatus = { _tag: "LoadFailed", url: original, code: -102, description: "refused" };
    mocks.preparedRecoveryUrl = current;
    mocks.recoverHostedPreview.mockResolvedValue(true);
    await act(() => root.render(<PreviewView threadRef={TEST_THREAD_REF} tabId="tab-1" visible />));
    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith(TEST_RUNTIME_TAB_ID, current);
    expect(mocks.refresh).not.toHaveBeenCalled();
    mocks.navigate.mockClear();
    await act(async () =>
      userEvent.click(page.getByRole("button", { name: "Refresh", exact: true })),
    );
    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith(TEST_RUNTIME_TAB_ID, current);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("reenables the original failed link after a redirect, without clearing another thread", async () => {
    const original = "http://localhost:3000/qa";
    const redirected = "http://localhost:3000/qa/";
    mocks.navStatus = { _tag: "LoadFailed", url: original, code: -102, description: "refused" };
    await act(() => root.render(<PreviewView threadRef={TEST_THREAD_REF} tabId="tab-1" visible />));
    mocks.navStatus = { _tag: "Success", url: redirected, title: "QA" };
    await act(() => root.render(<PreviewView threadRef={TEST_THREAD_REF} tabId="tab-1" visible />));
    expect(mocks.clearRecovery.mock.calls).toEqual([
      [TEST_THREAD_REF, original],
      [TEST_THREAD_REF, redirected],
    ]);
    mocks.clearRecovery.mockClear();
    mocks.navStatus = { _tag: "LoadFailed", url: original, code: -102, description: "refused" };
    await act(() => root.render(<PreviewView threadRef={TEST_THREAD_REF} tabId="tab-1" visible />));
    const otherThread = { ...TEST_THREAD_REF, threadId: ThreadId.make("other-thread") };
    mocks.navStatus = { _tag: "Success", url: redirected, title: "QA" };
    await act(() => root.render(<PreviewView threadRef={otherThread} tabId="tab-1" visible />));
    expect(mocks.clearRecovery.mock.calls).toEqual([[otherThread, redirected]]);
  });

  it("shows the cursor in a replacement browser while the old instance still records", async () => {
    mocks.recordingTabIds.add(TEST_RUNTIME_TAB_ID);
    mocks.recordingRuntimeTabId = TEST_RUNTIME_TAB_ID;
    const replacementTabId = previewRuntimeTabId(TEST_THREAD_REF, "replacement-server", "tab-1");
    useBrowserPointerStore.setState({
      byTabId: Object.fromEntries(
        [TEST_RUNTIME_TAB_ID, replacementTabId].map((tabId) => [
          tabId,
          { tabId, phase: "move", x: 10, y: 10, sequence: 1, createdAt: "2026-07-27T00:00:00Z" },
        ]),
      ),
    });
    await render(view());
    expect(hasCursor()).toBe(false);
    mocks.serverEpoch = "replacement-server";
    await render(view());
    expect(hasCursor()).toBe(true);
    expect(mocks.recordingTabIds.has(TEST_RUNTIME_TAB_ID)).toBe(true);
  });

  it("does not rerender while loading time passes", async () => {
    vi.useFakeTimers();
    mocks.loading = true;
    const onRender = vi.fn();
    await render(
      <Profiler id="preview" onRender={onRender}>
        {view()}
      </Profiler>,
    );
    const initialRenderCount = onRender.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(onRender).toHaveBeenCalledTimes(initialRenderCount);
  });

  it.each([
    [
      "https://localhost:8000/dashboard?mode=test#top",
      "https://localhost:8000/dashboard?mode=test#top",
    ],
    ["localhost:5173/app", "http://localhost:5173/app"],
  ])(
    "preserves a direct localhost URL %s in a WSL environment and records it",
    async (submitted, expected) => {
      await render(view());
      await submitAddress(submitted);
      await vi.waitFor(() =>
        expect(mocks.navigate).toHaveBeenCalledWith(TEST_RUNTIME_TAB_ID, expected),
      );
      expect(mocks.rememberPreviewUrl).toHaveBeenCalledWith(TEST_THREAD_REF, expected);
      expect(mocks.recordVisitForThread).toHaveBeenCalledWith(TEST_THREAD_REF, expected);
    },
  );

  it("maps an empty-state localhost server onto the WSL host", async () => {
    mocks.showEmptyState = true;
    mocks.servers = [
      {
        host: "localhost",
        port: 5173,
        url: "http://localhost:5173/app?mode=test#top",
        requestedUrl: "http://localhost:5173/app?mode=test#top",
        processName: "vite",
        pid: 1,
        terminal: null,
        source: "scanner",
      } as unknown as PreviewableServer,
    ];
    await render(view());
    await userEvent.click(page.getByRole("button", { name: /vite/ }));

    await vi.waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith(
        TEST_RUNTIME_TAB_ID,
        "http://172.16.0.2:5173/app?mode=test#top",
      ),
    );
    expect(mocks.rememberPreviewUrl).toHaveBeenCalledWith(
      TEST_THREAD_REF,
      "http://172.16.0.2:5173/app?mode=test#top",
    );
    // History keys off the requested loopback URL, which stays stable across hosts.
    await vi.waitFor(() =>
      expect(mocks.recordVisitForThread).toHaveBeenCalledWith(
        TEST_THREAD_REF,
        "http://localhost:5173/app?mode=test#top",
      ),
    );
  });

  it("opens and closes a thread-scoped floating preview for the active tab", async () => {
    await render(view());
    await userEvent.click(page.getByRole("button", { name: "Float preview over chat" }));
    expect(usePreviewMiniPlayerStore.getState().byThreadKey).toMatchObject({
      "environment-1:thread-1": { source: { kind: "browser", tabId: "tab-1" } },
    });
    const closeButton = page.getByRole("button", { name: "Close floating preview" });
    await expect.element(closeButton).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(closeButton);
    expect(usePreviewMiniPlayerStore.getState().byThreadKey).toEqual({});
  });

  it("keeps the native preview window as a secondary menu action", async () => {
    await render(view());
    await userEvent.click(page.getByRole("button", { name: "Preview menu" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Open separate preview window" }));
    await vi.waitFor(() =>
      expect(mocks.openPictureInPicture).toHaveBeenCalledWith(TEST_RUNTIME_TAB_ID),
    );
    await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull());

    mocks.pictureInPicture = true;
    await render(view());
    await userEvent.click(page.getByRole("button", { name: "Preview menu" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Close separate preview window" }));
    await vi.waitFor(() =>
      expect(mocks.closePictureInPicture).toHaveBeenCalledWith(TEST_RUNTIME_TAB_ID),
    );
  });

  it("forwards Cmd/Ctrl+Enter annotations to the composer send path", async () => {
    const picked = annotation("annotation-1");
    const onSendAnnotation = vi.fn();
    mocks.pickElement.mockResolvedValue({ annotation: picked, submission: "send" });
    await render(view(onSendAnnotation));
    await userEvent.click(page.getByRole("button", { name: "Annotate preview" }));

    await vi.waitFor(() => expect(onSendAnnotation).toHaveBeenCalledWith(picked, null));
    expect(mocks.addPreviewAnnotation).toHaveBeenCalledWith(TEST_THREAD_REF, picked);
  });

  it("retains the annotation locally when its own environment loses access during capture", async () => {
    const picked = annotation("annotation-revoked");
    const onSendAnnotation = vi.fn();
    let submitPick: (() => void) | undefined;
    mocks.pickElement.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          submitPick = () => resolve({ annotation: picked, submission: "send" });
        }),
    );
    await render(view(onSendAnnotation));
    await userEvent.click(page.getByRole("button", { name: "Annotate preview" }));
    await vi.waitFor(() => expect(submitPick).toBeDefined());
    expect(mocks.setAnnotationSendEnabled).toHaveBeenLastCalledWith(TEST_RUNTIME_TAB_ID, true);

    mocks.readEnvironmentScope.mockImplementation(
      (environmentId?: unknown) => environmentId !== TEST_THREAD_REF.environmentId,
    );
    await render(view(onSendAnnotation));
    expect(mocks.setAnnotationSendEnabled).toHaveBeenLastCalledWith(TEST_RUNTIME_TAB_ID, false);
    await act(async () => submitPick!());
    await vi.waitFor(() =>
      expect(mocks.addPreviewAnnotation).toHaveBeenCalledWith(TEST_THREAD_REF, picked),
    );
    expect(onSendAnnotation).not.toHaveBeenCalled();

    mocks.readEnvironmentScope.mockReturnValue(true);
    mocks.pickElement.mockResolvedValue({ annotation: picked, submission: "send" });
    await render(view(onSendAnnotation));
    await userEvent.click(page.getByRole("button", { name: "Annotate preview" }));
    await vi.waitFor(() => expect(onSendAnnotation).toHaveBeenCalledWith(picked, null));
    expect(mocks.setAnnotationSendEnabled).toHaveBeenLastCalledWith(TEST_RUNTIME_TAB_ID, true);
  });

  it("does not reopen a cancelled picker after the permission update finishes", async () => {
    let finishUpdate: (() => void) | undefined;
    mocks.setAnnotationSendEnabled.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishUpdate = resolve;
        }),
    );
    await render(view());
    await userEvent.click(page.getByRole("button", { name: "Annotate preview" }));
    await vi.waitFor(() => expect(finishUpdate).toBeDefined());
    expect(mocks.pickElement).not.toHaveBeenCalled();
    await userEvent.click(page.getByRole("button", { name: "Cancel annotation" }));
    expect(mocks.cancelPickElement).toHaveBeenCalledWith(TEST_RUNTIME_TAB_ID);
    await act(async () => finishUpdate!());
    expect(mocks.pickElement).not.toHaveBeenCalled();
    expect(mocks.addPreviewAnnotation).not.toHaveBeenCalled();
  });

  it("warns when main dropped the crop before handing over the pick", async () => {
    const picked = annotation("annotation-3");
    const onSendAnnotation = vi.fn();
    mocks.pickElement.mockResolvedValue({
      annotation: picked,
      submission: "send",
      screenshotFailed: true,
    });
    await render(view(onSendAnnotation));
    await userEvent.click(page.getByRole("button", { name: "Annotate preview" }));

    await vi.waitFor(() => expect(onSendAnnotation).toHaveBeenCalledWith(picked, null));
    expect(mocks.toast).toHaveBeenCalledOnce();
  });

  it("still sends annotation text when the picked element's crop is malformed", async () => {
    const picked = annotation("annotation-2", {
      dataUrl: "data:image/png;base64,%%%",
      width: 10,
      height: 10,
      cropRect: { x: 0, y: 0, width: 10, height: 10 },
    });
    const onSendAnnotation = vi.fn();
    mocks.pickElement.mockResolvedValue({ annotation: picked, submission: "send" });
    await render(view(onSendAnnotation));
    await userEvent.click(page.getByRole("button", { name: "Annotate preview" }));

    const sent = { ...picked, screenshot: null };
    await vi.waitFor(() => expect(onSendAnnotation).toHaveBeenCalledWith(sent, null));
    expect(mocks.addPreviewAnnotation).toHaveBeenCalledWith(TEST_THREAD_REF, sent);
    expect(mocks.addImage).not.toHaveBeenCalled();
  });
});
