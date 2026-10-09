import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ThreadId,
  type AssetCreateUrlResult,
  type PreviewSessionSnapshot,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";

const mocks = vi.hoisted(() => ({
  prepareHostedPreview: vi.fn(async (_ref: unknown, url: string) => ({ url })),
  applySnapshot: vi.fn(),
  rememberUrl: vi.fn(),
  openBrowser: vi.fn(),
  rememberHandoff: vi.fn(),
}));
vi.mock("~/components/preview/previewHostingRecovery", () => ({
  prepareHostedPreview: mocks.prepareHostedPreview,
}));
vi.mock("~/browser/previewRuntime", () => ({
  isPreviewAvailableFor: () => true,
  previewRuntimeFor: () => "server",
  desktopBrowserHostFor: () => undefined,
}));
vi.mock("~/previewStateStore", () => ({
  applyPreviewServerSnapshot: mocks.applySnapshot,
  rememberPreviewUrl: mocks.rememberUrl,
}));
vi.mock("~/rightPanelStore", () => ({
  useRightPanelStore: { getState: () => ({ openBrowser: mocks.openBrowser }) },
}));
vi.mock("~/handoffs/handoffsStore", () => ({ rememberHandoffBrowser: mocks.rememberHandoff }));
vi.mock("./browserDefaults", () => ({
  resolveBrowserDefaults: async () => ({}),
  browserDefaultOpenViewport: () => ({ _tag: "fill" }),
  browserDefaultOpenProfileId: () => "default",
}));

import { openFileInPreview } from "./openFileInPreview";

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

afterEach(() => vi.clearAllMocks());

describe("linked file browser previews", () => {
  it.each(["/repo/report.html", "/tmp/report.pdf"])(
    "requests only the published file for restricted access to %s",
    async (filePath) => {
      const createAssetUrl = vi.fn(async () =>
        AsyncResult.success({ relativeUrl: "/api/assets/linked-file", expiresAt: 1790000000000 }),
      );
      const openPreview = vi.fn(async () => AsyncResult.success(snapshot));
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
        input: expect.objectContaining({ threadId: threadRef.threadId }),
      });
      expect(mocks.openBrowser).toHaveBeenCalledExactlyOnceWith(threadRef, snapshot.tabId);
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
    expect(mocks.openBrowser).not.toHaveBeenCalled();
    expect(mocks.rememberHandoff).not.toHaveBeenCalled();
  });
});
