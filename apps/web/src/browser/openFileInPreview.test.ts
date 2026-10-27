import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ThreadId,
  type AssetCreateUrlResult,
  type PreviewOpenInput,
  type PreviewSessionSnapshot,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import type { PreparedHostedPreview } from "@t3tools/client-runtime/preview-hosting";

const mocks = vi.hoisted(() => ({
  prepareHostedPreview: vi.fn(
    async (_ref: unknown, url: string): Promise<PreparedHostedPreview> => ({
      url,
      managed: false,
      restored: false,
    }),
  ),
  rememberHandoff: vi.fn(),
  runtime: vi.fn<() => "server" | undefined>(() => "server"),
  desktopHost: vi.fn<() => string | undefined>(() => undefined),
}));
vi.mock("~/components/preview/previewHostingRecovery", () => ({
  prepareHostedPreview: mocks.prepareHostedPreview,
}));
vi.mock("~/browser/previewRuntime", () => ({
  isPreviewAvailableFor: () => true,
  previewRuntimeFor: mocks.runtime,
  desktopBrowserHostFor: mocks.desktopHost,
}));
vi.mock("~/state/entities", () => ({ readEnvironmentSupportsServerBrowser: () => true }));
vi.mock("~/handoffs/handoffsStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/handoffs/handoffsStore")>()),
  rememberHandoffBrowser: mocks.rememberHandoff,
}));
vi.mock("./browserDefaults", () => ({
  resolveBrowserDefaults: async () => ({}),
  browserDefaultOpenViewport: () => ({ _tag: "fill" }),
  browserDefaultOpenProfileId: () => "default",
}));

import { openFileInPreview, openUrlInPreview } from "./openFileInPreview";
import { readThreadPreviewState, resetPreviewStateForTests } from "~/previewStateStore";
import { selectActiveRightPanelSurface, useRightPanelStore } from "~/rightPanelStore";

const threadRef = {
  environmentId: EnvironmentId.make("linked-file-env"),
  threadId: ThreadId.make("linked-file-thread"),
};
const snapshot: PreviewSessionSnapshot = {
  threadId: threadRef.threadId,
  tabId: "linked-file-browser-tab",
  navStatus: { _tag: "Idle" },
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-01-01T00:00:00.000Z",
};

beforeEach(() => {
  mocks.prepareHostedPreview.mockImplementation(async (_ref, url) => ({
    url,
    managed: false,
    restored: false,
  }));
  mocks.runtime.mockReturnValue("server");
  mocks.desktopHost.mockReturnValue(undefined);
  resetPreviewStateForTests();
  useRightPanelStore.setState({
    byThreadKey: {},
    threadPanelVisibilityByThreadKey: {},
    userActionRevisionByThreadKey: {},
  });
});

afterEach(() => vi.clearAllMocks());

describe("linked file browser previews", () => {
  it.each(["/repo/report.html", "/tmp/report.pdf"])(
    "requests only the published file for restricted access to %s",
    async (filePath) => {
      const createAssetUrl = vi.fn(async () =>
        AsyncResult.success({ relativeUrl: "/api/assets/linked-file", expiresAt: 1790000000000 }),
      );
      const openPreview = vi.fn(async (_input: { input: PreviewOpenInput }) =>
        AsyncResult.success(snapshot),
      );
      const result = await openFileInPreview({
        threadRef,
        filePath,
        workspaceRoot: "/repo",
        canReadFiles: false,
        httpBaseUrl: "https://workstation.example",
        createAssetUrl,
        openPreview,
      });
      expect(result._tag).toBe("Success");
      expect(createAssetUrl).toHaveBeenCalledExactlyOnceWith({
        environmentId: threadRef.environmentId,
        input: {
          resource: {
            _tag: "media-file",
            threadId: threadRef.threadId,
            path: filePath,
            linkedThreadFile: true,
          },
        },
      });
      expect(openPreview).toHaveBeenCalledWith({
        environmentId: threadRef.environmentId,
        input: expect.objectContaining({
          threadId: threadRef.threadId,
          url: "https://workstation.example/api/assets/linked-file",
        }),
      });
      expect(openPreview.mock.calls[0]?.[0].input).not.toHaveProperty("browserHost");
      expect(readThreadPreviewState(threadRef).snapshot).toEqual(snapshot);
      expect(
        selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, threadRef)?.id,
      ).toBe(`browser:${snapshot.tabId}`);
      expect(mocks.rememberHandoff).toHaveBeenCalledExactlyOnceWith(
        threadRef,
        snapshot.tabId,
        { kind: "file", path: filePath },
        "https://workstation.example/api/assets/linked-file",
      );
    },
  );

  it("preserves workspace document serving when filesystem access is granted", async () => {
    const createAssetUrl = vi.fn(async () =>
      AsyncResult.success({
        relativeUrl: "/api/assets/workspace-document",
        expiresAt: 1790000000000,
      }),
    );
    await openFileInPreview({
      threadRef,
      filePath: "/repo/report.html",
      workspaceRoot: "/repo",
      canReadFiles: true,
      httpBaseUrl: "https://workstation.example",
      createAssetUrl,
      openPreview: async () => AsyncResult.success(snapshot),
    });
    expect(createAssetUrl).toHaveBeenCalledExactlyOnceWith({
      environmentId: threadRef.environmentId,
      input: {
        resource: {
          _tag: "workspace-file",
          threadId: threadRef.threadId,
          path: "/repo/report.html",
        },
      },
    });
  });

  it("does not open or record a browser handoff when the linked file is denied", async () => {
    const failure = AsyncResult.failure<AssetCreateUrlResult, Error>(
      Cause.fail(new Error("File is not published")),
    );
    const createAssetUrl = vi.fn(async () => failure);
    const openPreview = vi.fn(async () => AsyncResult.success(snapshot));
    const result = await openFileInPreview({
      threadRef,
      filePath: "/tmp/private.pdf",
      workspaceRoot: "/repo",
      canReadFiles: false,
      httpBaseUrl: "https://workstation.example",
      createAssetUrl,
      openPreview,
    });
    expect(result._tag).toBe("Failure");
    expect(createAssetUrl).toHaveBeenCalledWith({
      environmentId: threadRef.environmentId,
      input: { resource: expect.objectContaining({ linkedThreadFile: true }) },
    });
    expect(openPreview).not.toHaveBeenCalled();
    expect(mocks.prepareHostedPreview).not.toHaveBeenCalled();
    expect(readThreadPreviewState(threadRef).sessions).toEqual({});
    expect(
      selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, threadRef),
    ).toBeNull();
    expect(mocks.rememberHandoff).not.toHaveBeenCalled();
  });
});

describe("managed app links", () => {
  it.each(["default", "incognito"])(
    "opens a remote loopback app in its environment with the %s profile",
    async (profileId) => {
      mocks.runtime.mockReturnValue(undefined);
      mocks.desktopHost.mockReturnValue("remote-desktop");
      const url = "http://workstation.example:5173/app/a%2Fb?q=1#section";
      const localUrl = "http://127.0.0.1:5173/app/a%2Fb?q=1#section";
      mocks.prepareHostedPreview.mockResolvedValue({
        url,
        localUrl,
        managed: true,
        restored: true,
      });
      const openPreview = vi.fn(async (_input: { input: PreviewOpenInput }) =>
        AsyncResult.success(snapshot),
      );
      await openUrlInPreview({ threadRef, url, profileId, openPreview });
      expect(openPreview.mock.calls[0]?.[0].input).toMatchObject({
        url: localUrl,
        runtime: "server",
        browserHost: "environment",
        profileId,
      });
      expect(openPreview.mock.calls[0]?.[0].input).not.toHaveProperty("desktopHostId");
    },
  );

  it("preserves an explicitly selected desktop profile for a managed app", async () => {
    mocks.desktopHost.mockReturnValue("remote-desktop");
    const url = "http://workstation.example:5173/sign-in";
    mocks.prepareHostedPreview.mockResolvedValue({
      url,
      localUrl: "http://127.0.0.1:5173/sign-in",
      managed: true,
      restored: true,
    });
    const openPreview = vi.fn(async (_input: { input: unknown }) => AsyncResult.success(snapshot));
    await openUrlInPreview({ threadRef, url, profileId: "work-account", openPreview });
    expect(openPreview.mock.calls[0]?.[0].input).toMatchObject({
      url,
      runtime: "server",
      desktopHostId: "remote-desktop",
      profileId: "work-account",
    });
    expect(openPreview.mock.calls[0]?.[0].input).not.toHaveProperty("browserHost");
  });

  it("leaves an unmanaged app URL on the usual desktop route", async () => {
    mocks.runtime.mockReturnValue(undefined);
    const url = "http://workstation.example:5173/another-app?q=1";
    const openPreview = vi.fn(async (_input: { input: unknown }) => AsyncResult.success(snapshot));
    await openUrlInPreview({ threadRef, url, openPreview });
    expect(openPreview.mock.calls[0]?.[0].input).toMatchObject({ url });
    expect(openPreview.mock.calls[0]?.[0].input).not.toHaveProperty("browserHost");
    expect(openPreview.mock.calls[0]?.[0].input).not.toHaveProperty("runtime");
  });
});
