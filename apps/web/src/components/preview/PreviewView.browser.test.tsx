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
import { StrictMode, type ComponentProps } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render, stubGlobal } from "../../../test/render";

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
  pictureInPicture: false,
  showEmptyState: false,
  idleServerTab: false,
  loading: false,
  nativeServerTab: false,
  streamedServerTab: false,
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
      className?: string;
    }) => {
      mocks.serverControl = props.onControl;
      useImperativeHandle(props.ref, () => ({
        navigate: mocks.serverNavigate,
        reload: mocks.serverReload,
      }));
      return createElement("div", {
        "data-testid": "server-browser-surface",
        className: props.className,
      });
    },
  };
});

// The desktop bridge only exists inside Electron; the view reads it once at import.
vi.mock(import("./previewBridge"), async (original) => ({
  ...(await original()),
  previewBridge: {
    navigate: mocks.navigate,
    pickElement: mocks.pickElement,
    annotationVoice: { onEvent: () => () => {}, update: async () => {} },
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
    findInPage: vi.fn(async () => undefined),
    stopFindInPage: vi.fn(async () => undefined),
    onFindResult: vi.fn(() => () => undefined),
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
  capturePreviewOpenFocus: vi.fn(() => ({ clientId: "preview-test-client", userActionRevision: 0 })),
  hiddenPreviewTabIds: () => new Set<string>(),
  reconcilePreviewServerSessions: vi.fn(),
  whenPreviewTabKnown: vi.fn(),
  updatePreviewServerSnapshot: vi.fn(),
  isPreviewSupportedInRuntime: () => Boolean(window.desktopBridge?.preview),
  rememberPreviewUrl: mocks.rememberPreviewUrl,
  readThreadPreviewState: (() => ({
    sessions: { "tab-1": { navStatus: mocks.navStatus } },
    handledOpenTabIds: new Set<string>(),
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
      : mocks.idleServerTab
        ? {
            "tab-1": {
              threadId: "thread-1",
              tabId: "tab-1",
              runtime: "server",
              navStatus: { _tag: "Idle" },
              canGoBack: false,
              canGoForward: false,
              updatedAt: "2026-07-13T00:00:00.000Z",
            },
          }
        : {
            "tab-1": {
              threadId: "thread-1",
              tabId: "tab-1",
              runtime:
                mocks.nativeServerTab || mocks.streamedServerTab || mocks.serverRuntime
                  ? "server"
                  : "desktop",
              navStatus: mocks.navStatus,
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
vi.mock(import("./useDiscoveredLocalServers"), async (original) => ({
  ...(await original()),
  useDiscoveredLocalServers: () => mocks.servers,
}));
vi.mock(import("./usePreviewSession"), async (original) => ({
  ...(await original()),
  usePreviewSession: () => {},
}));

vi.mock(import("~/browser/previewRuntime"), async (original) => ({
  ...(await original()),
  useRendersServerTabNatively: () => mocks.nativeServerTab,
}));

vi.mock(import("~/browser/browserViewportActions"), { spy: true });

import { useComposerDraftStore } from "~/composerDraftStore";
import { commitBrowserViewportChange } from "~/browser/browserViewportActions";
import { resolveResponsiveBrowserViewportSize } from "~/browser/browserViewportLayout";
import { useBrowserPointerStore } from "~/browser/browserPointerStore";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { usePreviewMiniPlayerStore } from "~/previewMiniPlayerStore";
import { dispatchPreviewAction } from "./previewActionBus";
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
import { ToastProvider, toastManager } from "~/components/ui/toast";

const TEST_THREAD_REF = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
} as const;
const TEST_RUNTIME_TAB_ID = previewRuntimeTabId(TEST_THREAD_REF, null, "tab-1");

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

// The mocked modules and stores are shared by the whole file, so every test starts by
// resetting them.
function setup() {
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
  mocks.idleServerTab = false;
  mocks.loading = false;
  mocks.nativeServerTab = false;
  mocks.streamedServerTab = false;
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
}

async function submitAddress(text: string) {
  const input = page.getByPlaceholder("Search or enter URL");
  await userEvent.click(input);
  await userEvent.fill(input, text);
  await userEvent.keyboard("{Enter}");
}

describe("PreviewView", () => {
  it.each(["mailto:alice@example.com", "http://"])(
    "reports rejected address %s without navigating or recording it",
    async (address) => {
      setup();
      await using _screen = await render(<ToastProvider timeout={0}>{view()}</ToastProvider>);
      const input = page.getByPlaceholder("Search or enter URL");
      await input.fill(address);
      await userEvent.keyboard("{Enter}");

      await expect.element(page.getByText("Could not open this address")).toBeVisible();
      await expect.element(page.getByText("Enter an http or https URL.")).toBeVisible();
      expect(mocks.navigate).not.toHaveBeenCalled();
      expect(mocks.recordVisitForThread).not.toHaveBeenCalled();
      await userEvent.click(page.getByRole("button", { name: "Dismiss notification" }));
    },
  );

  it("keeps the address in the bar when Enter commits an IME composition", async () => {
    setup();
    await using _screen = await render(view());
    const input = page.getByPlaceholder("Search or enter URL");
    await input.fill("https://example.com/pinyin");

    const enter = new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(enter, "keyCode", { value: 229 });
    act(() => {
      input.element().dispatchEvent(enter);
    });

    await expect.element(input).toHaveFocus();
    await expect.element(input).toHaveValue("https://example.com/pinyin");
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(enter.defaultPrevented).toBe(true);
  });

  it("retains a restarted panel through StrictMode and waits for stream control before sending", async () => {
    setup();
    await using screen = await render(null);
    mocks.serverRuntime = true;
    mocks.restarted = true;
    mocks.navStatus = { _tag: "Success", url: "http://localhost:5173/qa", title: "QA" };
    mocks.recoverHostedPreview.mockResolvedValue(true);
    await act(() =>
      screen.rerender(
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
    setup();
    await using screen = await render(null);
    mocks.serverRuntime = true;
    mocks.restarted = true;
    mocks.navStatus = { _tag: "Success", url: "http://localhost:5173/qa", title: "QA" };
    mocks.recoverHostedPreview.mockResolvedValue(true);
    mocks.serverReload.mockReturnValueOnce(false).mockReturnValue(true);
    await act(() =>
      screen.rerender(<PreviewView threadRef={TEST_THREAD_REF} tabId="tab-1" visible />),
    );
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
      setup();
      await using screen = await render(null);
      mocks.serverRuntime = true;
      const original = "http://localhost:5173/qa?token=application-reset#token=application-invite";
      mocks.navStatus = { _tag: "Success", url: original, title: "QA" };
      mocks.recoverHostedPreview.mockResolvedValue(true);
      const requestId = requestHostedPreviewRefresh(TEST_THREAD_REF, "tab-1", original);
      await act(() =>
        screen.rerender(
          <StrictMode>
            <PreviewView threadRef={TEST_THREAD_REF} tabId="tab-1" visible />
          </StrictMode>,
        ),
      );
      expect(mocks.serverReload).not.toHaveBeenCalled();
      if (navigateAway) {
        mocks.navStatus = { _tag: "Success", url: "https://example.com/newer", title: "Newer" };
        await act(() =>
          screen.rerender(
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
      setup();
      await using screen = await render(null);
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
        screen.rerender(<PreviewView threadRef={TEST_THREAD_REF} tabId="tab-1" visible />),
      );
      expect(mocks.refresh).not.toHaveBeenCalled();
      await act(() =>
        screen.rerender(<PreviewView threadRef={TEST_THREAD_REF} tabId="tab-1" visible={false} />),
      );
      await act(async () => finishOldAuthentication(true));
      expect(mocks.refresh).not.toHaveBeenCalled();
      await act(() =>
        screen.rerender(<PreviewView threadRef={TEST_THREAD_REF} tabId="tab-1" visible />),
      );
      expect(mocks.refresh).toHaveBeenCalledTimes(1);
      expect(mocks.recoverHostedPreview).toHaveBeenCalledTimes(status === "Success" ? 3 : 2);
    },
  );

  it("prepares a retained panel after its environment connection hydrates", async () => {
    setup();
    await using screen = await render(null);
    mocks.environmentUrl = null;
    mocks.restarted = true;
    mocks.recoverHostedPreview.mockResolvedValue(true);
    await act(() =>
      screen.rerender(<PreviewView threadRef={TEST_THREAD_REF} tabId="tab-1" visible />),
    );
    expect(mocks.preparationPurposes).toEqual([]);
    mocks.environmentUrl = "http://172.16.0.2:3773";
    await act(() =>
      screen.rerender(<PreviewView threadRef={TEST_THREAD_REF} tabId="tab-1" visible />),
    );
    expect(mocks.preparationPurposes).toEqual(["resource", undefined]);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it.each(["submit", "reload", "automatic"])(
    "does not let a pending %s recovery replace a newer submitted address",
    async (action) => {
      setup();
      await using screen = await render(null);
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
        screen.rerender(<PreviewView threadRef={TEST_THREAD_REF} tabId="tab-1" visible />),
      );
      if (action === "submit") await submitAddress("http://localhost:5173/first");
      else if (action === "reload")
        await userEvent.click(page.getByRole("button", { name: "Refresh", exact: true }));
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
    setup();
    await using screen = await render(null);
    let complete!: (restored: boolean) => void;
    mocks.recoverHostedPreview.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    await act(() =>
      screen.rerender(<PreviewView threadRef={TEST_THREAD_REF} tabId="tab-1" visible />),
    );
    await submitAddress("http://localhost:5173/first");
    mocks.navStatus = {
      _tag: "Success",
      url: "https://example.com/agent-navigation",
      title: "New destination",
    };
    await act(() =>
      screen.rerender(<PreviewView threadRef={TEST_THREAD_REF} tabId="tab-1" visible />),
    );
    await act(async () => complete(true));
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.recordVisitForThread).not.toHaveBeenCalled();
  });

  it("waits for toolbar recovery before opening the prepared external destination", async () => {
    setup();
    using _desktopBridge = stubGlobal("desktopBridge", {});
    await using screen = await render(null);
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
    await act(() =>
      screen.rerender(<PreviewView threadRef={TEST_THREAD_REF} tabId="tab-1" visible />),
    );
    await userEvent.hover(page.getByPlaceholder("Search or enter URL"));
    await userEvent.click(page.getByRole("button", { name: "Open in system browser" }));
    expect(mocks.recoverHostedPreview).toHaveBeenCalledWith(TEST_THREAD_REF, original);
    expect(mocks.openExternal).not.toHaveBeenCalled();
    await act(async () => complete(true));
    expect(mocks.openExternal).toHaveBeenCalledExactlyOnceWith(destination);
  });

  it("restores a failed managed preview once, then reloads without an agent message", async () => {
    setup();
    await using screen = await render(null);
    let complete!: (restored: boolean) => void;
    mocks.recoverHostedPreview.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const original = "http://localhost:5173/qa";
    mocks.navStatus = { _tag: "LoadFailed", url: original, code: -102, description: "refused" };
    await act(() =>
      screen.rerender(<PreviewView threadRef={TEST_THREAD_REF} tabId="tab-1" visible />),
    );
    // A new snapshot of the same failed URL must not cancel or duplicate restoration.
    mocks.navStatus = { ...mocks.navStatus };
    await act(() =>
      screen.rerender(<PreviewView threadRef={{ ...TEST_THREAD_REF }} tabId="tab-1" visible />),
    );
    expect(mocks.recoverHostedPreview).toHaveBeenCalledTimes(1);
    expect(mocks.recoverHostedPreview).toHaveBeenCalledWith(TEST_THREAD_REF, original);
    await act(async () => complete(true));
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    await act(() =>
      screen.rerender(<PreviewView threadRef={TEST_THREAD_REF} tabId="tab-1" visible />),
    );
    expect(mocks.recoverHostedPreview).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    "completes failed-page recovery under StrictMode (restored=%s)",
    async (restored) => {
      setup();
      await using screen = await render(null);
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
        screen.rerender(
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
        screen.rerender(
          <StrictMode>
            <PreviewView threadRef={{ ...TEST_THREAD_REF }} tabId="tab-1" visible />
          </StrictMode>,
        ),
      );
      expect(mocks.recoverHostedPreview).toHaveBeenCalledTimes(1);
    },
  );

  it("settles a rejected recovery under StrictMode and leaves failure controls available", async () => {
    setup();
    using toast = vi.spyOn(toastManager, "add");
    await using screen = await render(null);
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
    const renderView = () =>
      screen.rerender(
        <StrictMode>
          <PreviewView threadRef={TEST_THREAD_REF} tabId="tab-1" visible />
        </StrictMode>,
      );
    await act(renderView);
    expect(document.body.textContent?.includes("Restoring preview…")).toBe(true);
    await act(async () => rejectRecovery(new HostedPreviewUrlTooLongError()));
    expect(document.body.textContent?.includes("Restoring preview…")).toBe(false);
    expect(document.body.textContent?.includes("Ask agent to restore preview")).toBe(true);
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledTimes(1);
    await act(renderView);
    expect(mocks.recoverHostedPreview).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledTimes(1);
    mocks.recoverHostedPreview.mockRejectedValueOnce(new HostedPreviewUrlTooLongError());
    await userEvent.click(page.getByRole("button", { name: "Refresh", exact: true }));
    expect(mocks.recoverHostedPreview).toHaveBeenCalledTimes(2);
    expect(toast).toHaveBeenCalledTimes(2);
    expect(document.body.textContent?.includes("Ask agent to restore preview")).toBe(true);
  });

  it("retries a transient native recovery failure when the user reloads", async () => {
    setup();
    await using screen = await render(null);
    const original = "http://localhost:5173/qa";
    mocks.navStatus = { _tag: "LoadFailed", url: original, code: -102, description: "refused" };
    mocks.recoverHostedPreview.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await act(() =>
      screen.rerender(<PreviewView threadRef={TEST_THREAD_REF} tabId="tab-1" visible />),
    );
    expect(mocks.recoverHostedPreview).toHaveBeenCalledTimes(1);
    expect(mocks.refresh).not.toHaveBeenCalled();
    await userEvent.click(page.getByRole("button", { name: "Refresh", exact: true }));
    expect(mocks.recoverHostedPreview).toHaveBeenCalledTimes(2);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("retries an already failed tab when its environment reconnects at a new address", async () => {
    setup();
    await using screen = await render(null);
    mocks.navStatus = {
      _tag: "LoadFailed",
      url: "http://192.168.1.30:5173/qa",
      code: -102,
      description: "refused",
    };
    await act(() =>
      screen.rerender(<PreviewView threadRef={TEST_THREAD_REF} tabId="tab-1" visible />),
    );
    expect(mocks.recoverHostedPreview).toHaveBeenCalledTimes(1);
    mocks.environmentUrl = "http://managed-server.ts.net:3773";
    mocks.preparedRecoveryUrl = "http://managed-server.ts.net:5173/qa";
    mocks.recoverHostedPreview.mockResolvedValue(true);
    await act(() =>
      screen.rerender(<PreviewView threadRef={TEST_THREAD_REF} tabId="tab-1" visible />),
    );
    expect(mocks.recoverHostedPreview).toHaveBeenCalledTimes(2);
    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith(
      TEST_RUNTIME_TAB_ID,
      mocks.preparedRecoveryUrl,
    );
  });

  it("navigates failed tabs to the current environment address after recovery and on reload", async () => {
    setup();
    await using screen = await render(null);
    const original = "http://192.168.1.30:5173/qa?q=1#part";
    const current = "http://managed-server.ts.net:5173/qa?q=1#part";
    mocks.navStatus = { _tag: "LoadFailed", url: original, code: -102, description: "refused" };
    mocks.preparedRecoveryUrl = current;
    mocks.recoverHostedPreview.mockResolvedValue(true);
    await act(() =>
      screen.rerender(<PreviewView threadRef={TEST_THREAD_REF} tabId="tab-1" visible />),
    );
    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith(TEST_RUNTIME_TAB_ID, current);
    expect(mocks.refresh).not.toHaveBeenCalled();
    mocks.navigate.mockClear();
    await userEvent.click(page.getByRole("button", { name: "Refresh", exact: true }));
    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith(TEST_RUNTIME_TAB_ID, current);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("reenables the original failed link after a redirect, without clearing another thread", async () => {
    setup();
    await using screen = await render(null);
    const original = "http://localhost:3000/qa";
    const redirected = "http://localhost:3000/qa/";
    mocks.navStatus = { _tag: "LoadFailed", url: original, code: -102, description: "refused" };
    await act(() =>
      screen.rerender(<PreviewView threadRef={TEST_THREAD_REF} tabId="tab-1" visible />),
    );
    mocks.navStatus = { _tag: "Success", url: redirected, title: "QA" };
    await act(() =>
      screen.rerender(<PreviewView threadRef={TEST_THREAD_REF} tabId="tab-1" visible />),
    );
    expect(mocks.clearRecovery.mock.calls).toEqual([
      [TEST_THREAD_REF, original],
      [TEST_THREAD_REF, redirected],
    ]);
    mocks.clearRecovery.mockClear();
    mocks.navStatus = { _tag: "LoadFailed", url: original, code: -102, description: "refused" };
    await act(() =>
      screen.rerender(<PreviewView threadRef={TEST_THREAD_REF} tabId="tab-1" visible />),
    );
    const otherThread = { ...TEST_THREAD_REF, threadId: ThreadId.make("other-thread") };
    mocks.navStatus = { _tag: "Success", url: redirected, title: "QA" };
    await act(() => screen.rerender(<PreviewView threadRef={otherThread} tabId="tab-1" visible />));
    expect(mocks.clearRecovery.mock.calls).toEqual([[otherThread, redirected]]);
  });

  it("retains the annotation locally when its own environment loses access during capture", async () => {
    setup();
    const picked = annotation("annotation-revoked");
    const onSendAnnotation = vi.fn();
    let submitPick: (() => void) | undefined;
    mocks.pickElement.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          submitPick = () => resolve({ annotation: picked, submission: "send" });
        }),
    );
    await using screen = await render(view(onSendAnnotation));
    await userEvent.click(page.getByRole("button", { name: "Annotate preview" }));
    await vi.waitFor(() => expect(submitPick).toBeDefined());
    expect(mocks.setAnnotationSendEnabled).toHaveBeenLastCalledWith(TEST_RUNTIME_TAB_ID, true);

    mocks.readEnvironmentScope.mockImplementation(
      (environmentId?: unknown) => environmentId !== TEST_THREAD_REF.environmentId,
    );
    await screen.rerender(view(onSendAnnotation));
    expect(mocks.setAnnotationSendEnabled).toHaveBeenLastCalledWith(TEST_RUNTIME_TAB_ID, false);
    await act(async () => submitPick!());
    await vi.waitFor(() =>
      expect(mocks.addPreviewAnnotation).toHaveBeenCalledWith(TEST_THREAD_REF, picked),
    );
    expect(onSendAnnotation).not.toHaveBeenCalled();

    mocks.readEnvironmentScope.mockReturnValue(true);
    mocks.pickElement.mockResolvedValue({ annotation: picked, submission: "send" });
    await screen.rerender(view(onSendAnnotation));
    await userEvent.click(page.getByRole("button", { name: "Annotate preview" }));
    await vi.waitFor(() => expect(onSendAnnotation).toHaveBeenCalledWith(picked, null));
    expect(mocks.setAnnotationSendEnabled).toHaveBeenLastCalledWith(TEST_RUNTIME_TAB_ID, true);
  });

  it("still sends annotation text when the picked element's crop is malformed", async () => {
    setup();
    const picked = annotation("annotation-2", {
      dataUrl: "data:image/png;base64,%%%",
      width: 10,
      height: 10,
      cropRect: { x: 0, y: 0, width: 10, height: 10 },
    });
    const onSendAnnotation = vi.fn();
    mocks.pickElement.mockResolvedValue({ annotation: picked, submission: "send" });
    await using _screen = await render(view(onSendAnnotation));
    await userEvent.click(page.getByRole("button", { name: "Annotate preview" }));

    const sent = { ...picked, screenshot: null };
    await vi.waitFor(() => expect(onSendAnnotation).toHaveBeenCalledWith(sent, null));
    expect(mocks.addPreviewAnnotation).toHaveBeenCalledWith(TEST_THREAD_REF, sent);
    expect(mocks.addImage).not.toHaveBeenCalled();
  });

  it("lets the pointer reach a local server card above an idle server-rendered tab", async () => {
    setup();
    mocks.idleServerTab = true;
    mocks.servers = [
      {
        host: "localhost",
        port: 8081,
        url: "http://localhost:8081/",
        requestedUrl: "http://localhost:8081/",
        processName: "python3",
        pid: 4242,
        terminal: null,
        source: "scanner",
      },
    ];
    await using _screen = await render(<ToastProvider timeout={0}>{view()}</ToastProvider>);
    const card = page.getByRole("button", { name: /localhost:8081/ });
    await expect.element(card).toBeVisible();

    const rect = card.element().getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    expect(card.element().contains(hit)).toBe(true);
  });

  it("sizes the first device viewport of a streamed tab to its panel", async () => {
    setup();
    mocks.streamedServerTab = true;
    await using _screen = await render(<ToastProvider timeout={0}>{view()}</ToastProvider>);
    const surface = page.getByTestId("server-browser-surface");
    await expect.element(surface).toBeInTheDocument();
    const rect = surface.element().getBoundingClientRect();

    await userEvent.click(page.getByRole("button", { name: "Preview menu" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Show device toolbar" }));

    expect(commitBrowserViewportChange).toHaveBeenCalledWith(expect.anything(), {
      _tag: "freeform",
      ...resolveResponsiveBrowserViewportSize(rect, 1),
    });
  });

  it("focuses and selects the address from forwarded desktop actions only while visible", async () => {
    setup();
    using stack = new DisposableStack();
    const previousBridge = window.desktopBridge;
    stack.defer(() => {
      if (previousBridge) window.desktopBridge = previousBridge;
      else delete window.desktopBridge;
    });
    const listeners = new Set<(action: string) => void>();
    window.desktopBridge = {
      getWindowZoomFactor: () => 1,
      onMenuAction: (listener: (action: string) => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    } as NonNullable<typeof window.desktopBridge>;
    await using screen = await render(view());
    const address = page.getByRole("textbox");
    const input = address.element() as HTMLInputElement;
    const forward = () =>
      act(() => {
        listeners.forEach((listener) => listener("preview.focusUrl"));
      });

    await forward();
    await expect.element(address).toHaveFocus();
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
    await act(() => input.blur());
    await forward();
    await expect.element(address).toHaveFocus();

    await act(() => input.blur());
    await screen.rerender(
      <PreviewView threadRef={TEST_THREAD_REF} tabId="tab-1" visible={false} />,
    );
    await forward();
    await expect.element(address).not.toHaveFocus();
    expect(listeners.size).toBe(0);
  });

  it("focuses the address bar each time the focus-url shortcut fires", async () => {
    setup();
    await using _screen = await render(view());
    const address = page.getByRole("textbox");

    act(() => dispatchPreviewAction("focus-url"));
    await expect.element(address).toHaveFocus();

    (address.element() as HTMLInputElement).blur();
    await expect.element(address).not.toHaveFocus();
    act(() => dispatchPreviewAction("focus-url"));
    await expect.element(address).toHaveFocus();
  });

  it("does not reopen find when the user returns to a tab they left with find open", async () => {
    setup();
    const tabView = (tabId: string) => (
      <PreviewView threadRef={TEST_THREAD_REF} tabId={tabId} visible />
    );
    await using screen = await render(tabView("tab-1"));
    const findBar = page.getByRole("search", { name: "Find in page" });

    act(() => dispatchPreviewAction("find"));
    await expect.element(findBar).toBeInTheDocument();

    await screen.rerender(tabView("tab-2"));
    await expect.element(findBar).not.toBeInTheDocument();
    await screen.rerender(tabView("tab-1"));
    await expect.element(findBar).not.toBeInTheDocument();
  });
});
