import type { PreviewSessionSnapshot, ScopedThreadRef } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  openTerminalLinkInPreview,
  TerminalLinkPreviewOpenError,
} from "./openTerminalLinkInPreview";

const hostingMocks = vi.hoisted(() => ({
  prepare: vi.fn(async (_ref: ScopedThreadRef, url: string) => ({
    url,
    managed: false,
    restored: false,
  })),
}));
vi.mock("./previewHostingRecovery", () => ({ prepareHostedPreview: hostingMocks.prepare }));

vi.mock("~/previewStateStore", () => ({
  applyPreviewServerSnapshot: vi.fn(),
  isPreviewSupportedInRuntime: () => true,
}));

vi.mock("~/rightPanelStore", () => ({
  useRightPanelStore: {
    getState: () => ({ openBrowser: vi.fn() }),
  },
}));

const browserDefaultsMocks = vi.hoisted(() => ({
  resolve: vi.fn(),
}));

vi.mock("~/browser/browserDefaults", () => ({
  resolveBrowserDefaults: browserDefaultsMocks.resolve,
  browserDefaultOpenViewport: (defaults: { viewport: unknown }) => defaults.viewport,
  browserDefaultOpenProfileId: (defaults: { profileId: string }) => defaults.profileId,
}));

const linkTargetMocks = vi.hoisted(() => ({
  preference: vi.fn<() => "system" | "app">(),
}));

vi.mock("~/browser/browserLinkTarget", () => ({
  resolveBrowserLinkTargetPreference: async () => linkTargetMocks.preference(),
  isWebUrl: (url: string) => /^https?:/u.test(url),
}));

const hydratedDefaults = {
  viewport: { _tag: "fixed", width: 1280, height: 720 } as const,
  profileId: "work",
};

const threadRef = {
  environmentId: "local" as ScopedThreadRef["environmentId"],
  threadId: "thread-1" as ScopedThreadRef["threadId"],
};

const snapshot: PreviewSessionSnapshot = {
  threadId: threadRef.threadId,
  tabId: "tab-1",
  navStatus: { _tag: "Idle" },
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-06-20T00:00:00.000Z",
};

beforeEach(() => {
  hostingMocks.prepare
    .mockReset()
    .mockImplementation(async (_ref, url) => ({ url, managed: false, restored: false }));
  browserDefaultsMocks.resolve.mockReset();
  browserDefaultsMocks.resolve.mockResolvedValue(hydratedDefaults);
  linkTargetMocks.preference.mockReturnValue("app");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("openTerminalLinkInPreview", () => {
  it("waits for owning-thread recovery before opening a stopped terminal link", async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let finish!: (prepared: { url: string; managed: boolean; restored: boolean }) => void;
    hostingMocks.prepare.mockImplementationOnce(
      () =>
        new Promise<{ url: string; managed: boolean; restored: boolean }>((resolve) => {
          finish = resolve;
          entered();
        }),
    );
    const openPreview = vi.fn(async () => AsyncResult.success(snapshot));
    const url = "http://localhost:5173/qa?case=terminal#first";
    const opening = openTerminalLinkInPreview({
      url,
      threadRef,
      openPreview,
      fallbackToBrowser: vi.fn(),
      forceBrowser: false,
    });
    await started;
    expect(openPreview).not.toHaveBeenCalled();
    expect(hostingMocks.prepare).toHaveBeenCalledWith(threadRef, url);
    finish({ url, managed: true, restored: true });
    await opening;
    expect(openPreview).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "prepares the remote owned destination before external opening (modifier=%s)",
    async (forceBrowser) => {
      linkTargetMocks.preference.mockReturnValue("system");
      const url = "http://localhost:5173/qa?case=remote#first";
      const resolved = "http://managed-server.local:5173/qa?case=remote#first";
      let finish!: (value: { url: string; managed: boolean; restored: boolean }) => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      hostingMocks.prepare.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
            entered();
          }),
      );
      const fallbackToBrowser = vi.fn();
      const openPreview = vi.fn(async () => AsyncResult.success(snapshot));
      const opening = openTerminalLinkInPreview({
        url,
        threadRef,
        openPreview,
        fallbackToBrowser,
        forceBrowser,
      });
      await started;
      expect(fallbackToBrowser).not.toHaveBeenCalled();
      finish({ url: resolved, managed: true, restored: true });
      await opening;
      expect(fallbackToBrowser).toHaveBeenCalledExactlyOnceWith(resolved);
      expect(openPreview).not.toHaveBeenCalled();
    },
  );

  it.each(["target", "defaults"] as const)(
    "does not open either browser when reading %s fails",
    async (setting) => {
      const failure = new Error("Settings read failed");
      if (setting === "target") {
        linkTargetMocks.preference.mockImplementationOnce(() => {
          throw failure;
        });
      } else {
        browserDefaultsMocks.resolve.mockRejectedValueOnce(failure);
      }
      const fallbackToBrowser = vi.fn();
      const openPreview = vi.fn(async () => AsyncResult.success(snapshot));

      await expect(
        openTerminalLinkInPreview({
          url: "https://example.com/docs",
          threadRef,
          openPreview,
          fallbackToBrowser,
          forceBrowser: false,
        }),
      ).rejects.toBe(failure);
      expect(fallbackToBrowser).not.toHaveBeenCalled();
      expect(openPreview).not.toHaveBeenCalled();
    },
  );

  it("opens in the system browser while that is the configured target", async () => {
    linkTargetMocks.preference.mockReturnValue("system");
    const fallbackToBrowser = vi.fn();
    const openPreview = vi.fn(async () => AsyncResult.success(snapshot));

    await openTerminalLinkInPreview({
      url: "http://localhost:3000/",
      threadRef,
      openPreview,
      fallbackToBrowser,
      forceBrowser: false,
    });

    expect(fallbackToBrowser).toHaveBeenCalledOnce();
    expect(openPreview).not.toHaveBeenCalled();
  });

  it("opens public URLs in-app too, not only local servers", async () => {
    const fallbackToBrowser = vi.fn();
    const openPreview = vi.fn(async () => AsyncResult.success(snapshot));

    await openTerminalLinkInPreview({
      url: "https://example.com/docs",
      threadRef,
      openPreview,
      fallbackToBrowser,
      forceBrowser: false,
    });

    expect(openPreview).toHaveBeenCalledOnce();
    expect(fallbackToBrowser).not.toHaveBeenCalled();
  });

  it("waits for hydrated viewport and profile defaults before opening", async () => {
    let hydrate: ((defaults: typeof hydratedDefaults) => void) | undefined;
    browserDefaultsMocks.resolve.mockImplementationOnce(
      () =>
        new Promise<typeof hydratedDefaults>((resolve) => {
          hydrate = resolve;
        }),
    );
    const openPreview = vi.fn(async () => AsyncResult.success(snapshot));

    const opening = openTerminalLinkInPreview({
      url: "http://localhost:3000/",
      threadRef,
      openPreview,
      fallbackToBrowser: vi.fn(),
      forceBrowser: false,
    });

    await vi.waitFor(() => expect(browserDefaultsMocks.resolve).toHaveBeenCalledOnce());
    expect(openPreview).not.toHaveBeenCalled();
    hydrate?.(hydratedDefaults);
    await opening;

    expect(openPreview).toHaveBeenCalledWith({
      environmentId: "local",
      input: {
        threadId: "thread-1",
        url: "http://localhost:3000/",
        viewport: hydratedDefaults.viewport,
        profileId: hydratedDefaults.profileId,
      },
    });
  });

  it("preserves the complete preview failure cause before falling back", async () => {
    const rpcError = new Error("preview unavailable");
    const cause = Cause.combine(Cause.fail(rpcError), Cause.die("preview defect"));
    const fallbackToBrowser = vi.fn();
    const reportError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await openTerminalLinkInPreview({
      url: "http://127.0.0.1:5173/",
      threadRef,
      openPreview: async () => AsyncResult.failure(cause),
      fallbackToBrowser,
      forceBrowser: false,
    });

    expect(fallbackToBrowser).toHaveBeenCalledOnce();
    expect(reportError).toHaveBeenCalledOnce();
    const error = reportError.mock.calls[0]?.[0];
    expect(error).toBeInstanceOf(TerminalLinkPreviewOpenError);
    expect(error).toMatchObject({
      environmentId: "local",
      threadId: "thread-1",
      targetOrigin: "http://127.0.0.1:5173",
      cause,
    });
    expect(error.message).not.toContain("preview unavailable");
  });

  it("does not report or fall back when opening the preview is interrupted", async () => {
    const fallbackToBrowser = vi.fn();
    const reportError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await openTerminalLinkInPreview({
      url: "http://localhost:5173/",
      threadRef,
      openPreview: async () => AsyncResult.failure(Cause.interrupt()),
      fallbackToBrowser,
      forceBrowser: false,
    });

    expect(reportError).not.toHaveBeenCalled();
    expect(fallbackToBrowser).not.toHaveBeenCalled();
  });

  it("opens in the system browser when Ctrl or Command is held", async () => {
    const fallbackToBrowser = vi.fn();
    const openPreview = vi.fn(async () => AsyncResult.success(snapshot));

    await openTerminalLinkInPreview({
      url: "https://example.com/docs",
      threadRef,
      openPreview,
      fallbackToBrowser,
      forceBrowser: true,
    });

    expect(fallbackToBrowser).toHaveBeenCalledOnce();
    expect(openPreview).not.toHaveBeenCalled();
  });
});
