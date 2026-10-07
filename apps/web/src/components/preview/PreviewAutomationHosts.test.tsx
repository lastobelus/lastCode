import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  ThreadId,
  type ClientSettings,
  type PreviewAutomationResponse,
  type PreviewAutomationStreamEvent,
  type PreviewOpenInput,
  type PreviewAutomationOpenInput,
  type PreviewAutomationRequest,
  type PreviewSessionSnapshot,
} from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useBrowserSurfaceStore } from "~/browser/browserSurfaceStore";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { __resetClientSettingsPersistenceForTests } from "~/hooks/useSettings";
import {
  applyPreviewServerSnapshot,
  readThreadPreviewState,
  resetPreviewStateForTests,
  applyPreviewDesktopState,
} from "~/previewStateStore";
import { readThreadHandoffs, useHandoffsStore } from "~/handoffs/handoffsStore";
import { appAtomRegistry, AppAtomRegistryProvider } from "~/rpc/atomRegistry";

import { PreviewAutomationHosts } from "./PreviewAutomationHosts";

const mocks = vi.hoisted(() => ({
  getClientSettings: vi.fn<() => Promise<ClientSettings | null>>(),
  setClientSettings: vi.fn(),
  open: vi.fn(async (_target: { environmentId: EnvironmentId; input: PreviewOpenInput }) =>
    AsyncResult.success(snapshot),
  ),
  list: vi.fn(async () => AsyncResult.success(emptyList)),
  resize: vi.fn(),
  respond:
    vi.fn<
      (target: { environmentId: EnvironmentId; input: PreviewAutomationResponse }) => Promise<void>
    >(),
  focus: vi.fn<() => Promise<AtomCommandResult<void, Error>>>(),
  navigate: vi.fn(async () => undefined),
  navigationStatus: vi.fn(),
}));

vi.mock("~/localApi", () => ({
  ensureLocalApi: () => ({ persistence: mocks }),
}));
vi.mock("~/env", () => ({ isElectron: true }));
vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({ environments: [{ environmentId }] }),
}));
vi.mock("~/state/preview", () => ({
  previewEnvironment: {
    automationRequests: () => requestsAtom,
    list: () => listAtom,
    open: mocks.open,
    resize: mocks.resize,
    respondToAutomation: mocks.respond,
    focusAutomationHost: mocks.focus,
  },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => command,
}));
vi.mock("~/state/use-atom-query-runner", () => ({
  useAtomQueryRunner: () => mocks.list,
}));
// Presentation plumbing is independently tested; these cases exercise the real
// request consumer and capture boundary once a desktop host accepts the open.
vi.mock("./previewAutomationHostBudget", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./previewAutomationHostBudget")>()),
  waitForHostReadiness: async () => true,
}));
vi.mock("./previewBridge", () => ({
  previewBridge: { automation: { status: mocks.navigationStatus }, navigate: mocks.navigate },
}));

const environmentId = EnvironmentId.make("automation-environment");
const threadId = ThreadId.make("automation-thread");
const threadRef = { environmentId, threadId };
const viewport = { _tag: "freeform", width: 1440, height: 900 } as const;
const savedSettings: ClientSettings = {
  ...DEFAULT_CLIENT_SETTINGS,
  browserDefaultViewport: viewport,
  browserDefaultProfileId: "work",
  browserProfiles: [{ id: "work", name: "Work", kind: "persistent" }],
};
const snapshot: PreviewSessionSnapshot = {
  threadId,
  tabId: "automation-tab",
  navStatus: { _tag: "Idle" },
  canGoBack: false,
  canGoForward: false,
  viewport,
  profileId: "work",
  updatedAt: "2026-09-05T00:00:00.000Z",
};
const emptyList = {
  sessions: [] as PreviewSessionSnapshot[],
  serverEpoch: "test-server",
  revision: 0,
};
const listAtom = Atom.make(AsyncResult.success(emptyList));
const requestsAtom = Atom.make<AsyncResult.AsyncResult<PreviewAutomationStreamEvent, Error>>(
  AsyncResult.initial(false),
);
const requestEvent = {
  type: "request",
  connectionId: "automation-connection",
  request: {
    requestId: "open-request",
    threadId,
    operation: "open",
    input: { open: false, reuseExistingTab: false },
    timeoutMs: 15_000,
  },
} satisfies PreviewAutomationStreamEvent;

function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

let renderer: ReactTestRenderer | null = null;

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.getClientSettings.mockReset().mockResolvedValue(savedSettings);
  mocks.respond.mockReset();
  mocks.focus.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  __resetClientSettingsPersistenceForTests();
  resetPreviewStateForTests();
  useBrowserSurfaceStore.setState({ byTabId: {} });
  useHandoffsStore.setState({ byThreadKey: {} });
  appAtomRegistry.set(requestsAtom, AsyncResult.initial(false));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn(), setTimeout });
  vi.stubGlobal(
    "document",
    Object.assign(new EventTarget(), {
      hasFocus: () => false,
      visibilityState: "visible",
      querySelectorAll: () => [],
    }),
  );
  await act(() => {
    renderer = create(
      <AppAtomRegistryProvider>
        <PreviewAutomationHosts />
      </AppAtomRegistryProvider>,
    );
  });
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = null;
  resetPreviewStateForTests();
  useHandoffsStore.setState({ byThreadKey: {} });
  __resetClientSettingsPersistenceForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("PreviewAutomationHosts open", () => {
  async function runOpen(
    input: PreviewAutomationOpenInput,
    requestId = "handoff-open",
    requestOverrides: Partial<PreviewAutomationRequest> = {},
  ) {
    const response = deferred<PreviewAutomationResponse>();
    mocks.respond.mockImplementationOnce(async ({ input: responseInput }) =>
      response.resolve(responseInput),
    );
    await act(async () => {
      appAtomRegistry.set(
        requestsAtom,
        AsyncResult.success({
          ...requestEvent,
          request: {
            ...requestEvent.request,
            requestId,
            input,
            timeoutMs: 50,
            operation:
              input.profileId !== undefined || input.profileName !== undefined
                ? "openWithProfile"
                : "open",
            ...requestOverrides,
          },
        }),
      );
      await response.promise;
    });
    return response.promise;
  }

  it("lists profiles and the resolved default without opening or changing settings", async () => {
    const response = await runOpen({}, "profiles", { operation: "profiles" });
    expect(response).toMatchObject({
      ok: true,
      result: {
        defaultProfileId: "work",
        profiles: [
          { id: "default", name: "Default", kind: "persistent" },
          { id: "incognito", name: "Incognito", kind: "incognito" },
          { id: "work", name: "Work", kind: "persistent" },
        ],
      },
    });
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.setClientSettings).not.toHaveBeenCalled();
  });

  it.each([{ profileName: "Default" }, { profileId: "default" }, { profileId: "incognito" }])(
    "opens a new tab with an explicit profile without changing the default: %o",
    async (selection) => {
      const profileId = "profileId" in selection ? selection.profileId : "default";
      mocks.open.mockResolvedValueOnce(AsyncResult.success({ ...snapshot, profileId }));
      const response = await runOpen({ ...selection, open: false, reuseExistingTab: false });
      expect(mocks.open).toHaveBeenCalledExactlyOnceWith({
        environmentId,
        input: { threadId, viewport, profileId },
      });
      expect(response).toMatchObject({
        ok: true,
        result: { profileId, profileName: profileId === "incognito" ? "Incognito" : "Default" },
      });
      expect(mocks.setClientSettings).not.toHaveBeenCalled();
    },
  );

  it.each([{ profileName: "work" }, { profileId: "missing" }])(
    "rejects an unknown exact profile without creating or navigating a tab: %o",
    async (selection) => {
      const response = await runOpen({ ...selection, open: false });
      expect(response).toMatchObject({
        ok: false,
        error: { _tag: "PreviewAutomationProfileError", detail: { reason: "unknown" } },
      });
      expect(response.error?.message).toContain("preview_profiles");
      expect(mocks.open).not.toHaveBeenCalled();
      expect(mocks.navigate).not.toHaveBeenCalled();
    },
  );

  it("rejects duplicate names with the available IDs and accepts a specific ID", async () => {
    mocks.getClientSettings.mockResolvedValueOnce({
      ...savedSettings,
      browserProfiles: [
        ...savedSettings.browserProfiles,
        { id: "work-2", name: "Work", kind: "persistent" },
      ],
    });
    const response = await runOpen({ profileName: "Work", open: false });
    expect(response).toMatchObject({
      ok: false,
      error: { _tag: "PreviewAutomationProfileError", detail: { reason: "ambiguous" } },
    });
    expect(response.error?.message).toContain('"work", "work-2"');
    expect(mocks.open).not.toHaveBeenCalled();
    mocks.open.mockResolvedValueOnce(AsyncResult.success({ ...snapshot, profileId: "work-2" }));
    expect(await runOpen({ profileId: "work-2", open: false }, "by-id")).toMatchObject({
      ok: true,
      result: { profileId: "work-2", profileName: "Work" },
    });
  });

  it("creates a new tab when the implicitly reused tab has another profile", async () => {
    applyPreviewServerSnapshot(threadRef, snapshot);
    const newSnapshot = { ...snapshot, tabId: "other-profile-tab", profileId: "default" };
    mocks.list.mockResolvedValueOnce(AsyncResult.success({ ...emptyList, sessions: [snapshot] }));
    mocks.open.mockResolvedValueOnce(AsyncResult.success(newSnapshot));
    expect(
      await runOpen({ profileName: "Default", open: false }, "different-profile", {
        tabId: snapshot.tabId,
        tabIdExplicit: false,
      }),
    ).toMatchObject({
      ok: true,
      result: { tabId: newSnapshot.tabId, profileId: "default", profileName: "Default" },
    });
    expect(mocks.open).toHaveBeenCalledOnce();
    expect(readThreadPreviewState(threadRef).sessions[snapshot.tabId]?.profileId).toBe("work");
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("rejects a profile mismatch on an exact tab without changing it", async () => {
    applyPreviewServerSnapshot(threadRef, snapshot);
    const response = await runOpen(
      { profileId: "default", open: false, url: "https://example.test/" },
      "mismatch",
      {
        tabId: snapshot.tabId,
        tabIdExplicit: true,
      },
    );
    expect(response).toMatchObject({
      ok: false,
      error: { _tag: "PreviewAutomationProfileError", detail: { reason: "tab-mismatch" } },
    });
    expect(response.error?.message).toContain("reuseExistingTab=false");
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(readThreadPreviewState(threadRef).sessions[snapshot.tabId]?.profileId).toBe("work");
  });

  it.each([
    { _tag: "fill" },
    { _tag: "freeform", width: 900, height: 600 },
    { _tag: "preset", presetId: "iphone-12-pro", width: 390, height: 844 },
  ] as const)(
    "keeps the configured viewport on a newly opened agent tab: %o",
    async (configuredViewport) => {
      mocks.getClientSettings.mockResolvedValueOnce({
        ...savedSettings,
        browserDefaultViewport: configuredViewport,
      });
      mocks.open.mockResolvedValueOnce(
        AsyncResult.success({ ...snapshot, viewport: configuredViewport }),
      );
      const response = await runOpen({ profileName: "Work", open: false, reuseExistingTab: false });
      expect(mocks.open).toHaveBeenCalledExactlyOnceWith({
        environmentId,
        input: { threadId, viewport: configuredViewport, profileId: "work" },
      });
      expect(response).toMatchObject({ ok: true, result: { viewportSetting: configuredViewport } });
      expect(mocks.resize).not.toHaveBeenCalled();
    },
  );

  it("leaves the reused tab's Fill viewport unchanged", async () => {
    applyPreviewServerSnapshot(threadRef, { ...snapshot, viewport: { _tag: "fill" } });
    const response = await runOpen({ profileName: "Work", open: false }, "reused-fill", {
      tabId: snapshot.tabId,
      tabIdExplicit: true,
    });
    expect(response).toMatchObject({ ok: true, result: { viewportSetting: { _tag: "fill" } } });
    expect(mocks.resize).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("rejects a missing exact tab instead of creating a replacement with the requested profile", async () => {
    const response = await runOpen({ profileName: "Work", open: false }, "missing-tab", {
      tabId: "missing-tab",
      tabIdExplicit: true,
    });
    expect(response).toMatchObject({
      ok: false,
      error: { _tag: "PreviewAutomationTabNotFoundError" },
    });
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it.each([
    { profileId: undefined, expectedId: "default", expectedName: "Default" },
    { profileId: "deleted-profile", expectedId: "deleted-profile", expectedName: null },
  ])(
    "reports a tab's stored profile rather than the current default: %o",
    async ({ profileId, expectedId, expectedName }) => {
      applyPreviewServerSnapshot(threadRef, { ...snapshot, profileId });
      const response = await runOpen({}, "status-profile", {
        operation: "status",
        tabId: snapshot.tabId,
      });
      expect(response).toMatchObject({
        ok: true,
        result: { profileId: expectedId, profileName: expectedName },
      });
      expect(mocks.open).not.toHaveBeenCalled();
    },
  );

  it("reuses an exact tab with the matching profile", async () => {
    applyPreviewServerSnapshot(threadRef, snapshot);
    expect(
      await runOpen({ profileName: "Work", open: false }, "matching", {
        tabId: snapshot.tabId,
        tabIdExplicit: true,
      }),
    ).toMatchObject({
      ok: true,
      result: { tabId: snapshot.tabId, profileId: "work", profileName: "Work" },
    });
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("preserves the reused tab profile when selection is omitted", async () => {
    const existing = { ...snapshot, profileId: "default" };
    applyPreviewServerSnapshot(threadRef, existing);
    expect(await runOpen({ open: false }, "unspecified", { tabId: snapshot.tabId })).toMatchObject({
      ok: true,
      result: { profileId: "default", profileName: "Default" },
    });
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("records an explicit offscreen open once even when auto-show is disabled", async () => {
    mocks.getClientSettings.mockResolvedValueOnce({
      ...savedSettings,
      browserAutoShowFloatingPreview: false,
    });
    const response = await runOpen({
      open: true,
      show: false,
      url: "https://example.test/handoff",
    });
    expect(response).toMatchObject({ ok: true, result: { visible: false } });
    expect(readThreadHandoffs(threadRef)).toHaveLength(1);
    expect(readThreadHandoffs(threadRef)[0]?.target).toEqual({
      kind: "url",
      url: "https://example.test/handoff",
    });
  });

  it("does not record a reused tab destination when native navigation rejects", async () => {
    await runOpen({ open: true }, "initial-open");
    mocks.list.mockResolvedValueOnce(AsyncResult.success({ ...emptyList, sessions: [snapshot] }));
    mocks.navigate.mockRejectedValueOnce(new Error("Native navigation rejected"));
    const response = await runOpen({ open: true, url: "https://example.test/rejected" });
    expect(response).toMatchObject({ ok: false });
    expect(mocks.navigate).toHaveBeenCalledOnce();
    expect(readThreadHandoffs(threadRef)).toHaveLength(0);
  });

  it("keeps accepted navigation available to retry when readiness fails", async () => {
    await runOpen({ open: true }, "initial-open");
    mocks.list.mockResolvedValueOnce(AsyncResult.success({ ...emptyList, sessions: [snapshot] }));
    mocks.navigationStatus.mockRejectedValueOnce(new Error("Page load failed"));
    const response = await runOpen({ open: true, url: "https://example.test/retry" });
    expect(response).toMatchObject({ ok: false });
    expect(mocks.navigate).toHaveBeenCalledOnce();
    expect(readThreadHandoffs(threadRef)[0]?.target).toEqual({
      kind: "url",
      url: "https://example.test/retry",
    });
  });

  it.each([{ open: false, show: true }, { show: false }])(
    "does not record an explicitly suppressed presentation: %o",
    async (input) => {
      expect(await runOpen({ ...input, url: "https://example.test/suppressed" })).toMatchObject({
        ok: true,
      });
      expect(readThreadHandoffs(threadRef)).toHaveLength(0);
    },
  );

  it("does not record an implicit open when auto-show is disabled", async () => {
    mocks.getClientSettings.mockResolvedValueOnce({
      ...savedSettings,
      browserAutoShowFloatingPreview: false,
    });
    expect(await runOpen({ url: "https://example.test/implicit" })).toMatchObject({ ok: true });
    expect(readThreadHandoffs(threadRef)).toHaveLength(0);
  });

  it("does not record a destination-less open", async () => {
    await runOpen({ open: true });
    expect(readThreadHandoffs(threadRef)).toHaveLength(0);
  });

  it("waits for saved settings before opening a tab with the configured profile and viewport", async () => {
    const readStarted = deferred<void>();
    const read = deferred<ClientSettings>();
    const response = deferred<PreviewAutomationResponse>();
    mocks.getClientSettings.mockImplementationOnce(() => {
      readStarted.resolve();
      return read.promise;
    });
    mocks.respond.mockImplementationOnce(async ({ input }) => response.resolve(input));

    await act(async () => {
      appAtomRegistry.set(requestsAtom, AsyncResult.success(requestEvent));
      await readStarted.promise;
    });
    expect(mocks.open).not.toHaveBeenCalled();

    await act(async () => {
      read.resolve(savedSettings);
      await response.promise;
    });

    expect(mocks.open).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { threadId, viewport, profileId: "work" },
    });
    expect(mocks.getClientSettings).toHaveBeenCalledOnce();
    await expect(response.promise).resolves.toMatchObject({
      requestId: "open-request",
      ok: true,
      result: { available: false, tabId: snapshot.tabId, profileId: "work", profileName: "Work" },
    });
    expect(readThreadPreviewState(threadRef).snapshot).toEqual(snapshot);
    expect(mocks.setClientSettings).not.toHaveBeenCalled();
  });

  it("reports a settings read failure without opening a tab", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.getClientSettings.mockRejectedValueOnce(new Error("Settings read failed"));
    const response = deferred<PreviewAutomationResponse>();
    mocks.respond.mockImplementationOnce(async ({ input }) => response.resolve(input));

    await act(async () => {
      appAtomRegistry.set(requestsAtom, AsyncResult.success(requestEvent));
      await response.promise;
    });

    await expect(response.promise).resolves.toMatchObject({
      requestId: "open-request",
      ok: false,
      error: { _tag: "PreviewAutomationExecutionError" },
    });
    expect(mocks.getClientSettings).toHaveBeenCalledOnce();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(readThreadPreviewState(threadRef).snapshot).toBeNull();
    expect(mocks.setClientSettings).not.toHaveBeenCalled();
  });
});

describe("PreviewAutomationHosts ownership", () => {
  it("reports only local live tabs and removes ownership when their web contents close", async () => {
    await act(() => {
      appAtomRegistry.set(
        requestsAtom,
        AsyncResult.success({ type: "connected", connectionId: "automation-connection" }),
      );
      applyPreviewServerSnapshot(threadRef, snapshot);
    });
    expect(mocks.focus).toHaveBeenLastCalledWith(
      expect.objectContaining({ input: expect.objectContaining({ liveTabs: [] }) }),
    );
    const overlay = {
      hasWebContents: true,
      canGoBack: false,
      canGoForward: false,
      loading: false,
      zoomFactor: 1,
      pictureInPicture: false,
      colorScheme: "system" as const,
      audioMuted: false,
      audible: false,
      controller: "none" as const,
      favicon: null,
    };
    await act(() => applyPreviewDesktopState(threadRef, snapshot.tabId, overlay));
    expect(mocks.focus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          liveTabs: [{ threadId, tabId: snapshot.tabId, visible: false }],
        }),
      }),
    );
    const reportCount = mocks.focus.mock.calls.length;
    await act(() =>
      applyPreviewDesktopState(threadRef, snapshot.tabId, { ...overlay, loading: true }),
    );
    expect(mocks.focus).toHaveBeenCalledTimes(reportCount);
    const runtimeTabId = previewRuntimeTabId(threadRef, null, snapshot.tabId);
    const owner = Symbol();
    await act(() => {
      useBrowserSurfaceStore.getState().claim(runtimeTabId, owner, false);
      useBrowserSurfaceStore
        .getState()
        .present(runtimeTabId, owner, { x: 0, y: 0, width: 800, height: 600 }, true, 0, 1);
    });
    expect(mocks.focus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          liveTabs: [{ threadId, tabId: snapshot.tabId, visible: true }],
        }),
      }),
    );
    for (const visibilityState of ["hidden", "visible"]) {
      await act(() => {
        Object.assign(document, { visibilityState });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(mocks.focus).toHaveBeenLastCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            focused: false,
            liveTabs: [{ threadId, tabId: snapshot.tabId, visible: visibilityState === "visible" }],
          }),
        }),
      );
    }
    await act(() => {
      appAtomRegistry.set(
        requestsAtom,
        AsyncResult.success({ type: "connected", connectionId: "reconnected" }),
      );
    });
    expect(mocks.focus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          connectionId: "reconnected",
          liveTabs: [{ threadId, tabId: snapshot.tabId, visible: true }],
        }),
      }),
    );
    await act(() =>
      applyPreviewDesktopState(threadRef, snapshot.tabId, { ...overlay, hasWebContents: false }),
    );
    expect(mocks.focus).toHaveBeenLastCalledWith(
      expect.objectContaining({ input: expect.objectContaining({ liveTabs: [] }) }),
    );
  });

  it.each([false, true])(
    "retries failed reports without clearing newer connection reports (reconnect: %s)",
    async (reconnect) => {
      const report = deferred<Awaited<ReturnType<typeof mocks.focus>>>();
      mocks.focus.mockReturnValueOnce(report.promise);
      await act(() => {
        appAtomRegistry.set(
          requestsAtom,
          AsyncResult.success({ type: "connected", connectionId: "first" }),
        );
      });
      if (reconnect) {
        await act(() => {
          appAtomRegistry.set(
            requestsAtom,
            AsyncResult.success({ type: "connected", connectionId: "second" }),
          );
        });
      }
      await act(async () => {
        report.resolve(AsyncResult.failure(Cause.fail(new Error("Focus report failed"))));
        await report.promise;
      });
      expect(mocks.focus).toHaveBeenCalledTimes(reconnect ? 2 : 1);
      await act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(mocks.focus).toHaveBeenCalledTimes(2);
      expect(mocks.focus).toHaveBeenLastCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({ connectionId: reconnect ? "second" : "first" }),
        }),
      );
    },
  );

  it("does not claim an available runtime from a server snapshot alone", async () => {
    const response = deferred<PreviewAutomationResponse>();
    mocks.respond.mockImplementationOnce(async ({ input }) => response.resolve(input));
    await act(async () => {
      applyPreviewServerSnapshot(threadRef, snapshot);
      appAtomRegistry.set(
        requestsAtom,
        AsyncResult.success({
          ...requestEvent,
          request: {
            ...requestEvent.request,
            operation: "status",
            tabId: snapshot.tabId,
            input: {},
          },
        }),
      );
      await response.promise;
    });
    await expect(response.promise).resolves.toMatchObject({
      ok: true,
      result: { available: false, tabId: snapshot.tabId, profileId: "work", profileName: "Work" },
    });
  });
});
