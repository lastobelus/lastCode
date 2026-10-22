import type { PreviewSessionSnapshot, ScopedThreadRef } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import * as previewRuntime from "~/browser/previewRuntime";

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

vi.mock("~/browser/browserDefaults", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/browser/browserDefaults")>()),
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
  profileId: "default",
  profiles: [{ id: "work", name: "Work account", kind: "persistent" as const }],
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
  vi.stubGlobal("window", { desktopBridge: {} });
  hostingMocks.prepare
    .mockReset()
    .mockImplementation(async (_ref, url) => ({ url, managed: false, restored: false }));
  browserDefaultsMocks.resolve.mockReset();
  browserDefaultsMocks.resolve.mockResolvedValue(hydratedDefaults);
  linkTargetMocks.preference.mockReturnValue("app");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("openTerminalLinkInPreview", () => {
  it.each([
    { forceBrowser: false, catalogue: "present" },
    { forceBrowser: true, catalogue: "present" },
    { forceBrowser: false, catalogue: "missing" },
    { forceBrowser: true, catalogue: "missing" },
    { forceBrowser: false, catalogue: "unreadable" },
    { forceBrowser: true, catalogue: "unreadable" },
  ])(
    "directs hosted-web Action links to the owning desktop before $catalogue settings lookup (modifier=$forceBrowser)",
    async ({ forceBrowser, catalogue }) => {
      const externalOpen = vi.fn();
      vi.stubGlobal("window", { open: externalOpen });
      vi.spyOn(previewRuntime, "isPreviewAvailableFor").mockReturnValue(true);
      vi.spyOn(previewRuntime, "previewRuntimeFor").mockReturnValue("server");
      if (catalogue === "missing")
        browserDefaultsMocks.resolve.mockResolvedValue({ ...hydratedDefaults, profiles: [] });
      if (catalogue === "unreadable")
        browserDefaultsMocks.resolve.mockRejectedValue(new Error("Settings read failed"));
      const openPreview = vi.fn(async () => AsyncResult.success(snapshot));
      const fallbackToBrowser = vi.fn();

      await expect(
        openTerminalLinkInPreview({
          url: "https://example.com/sign-in",
          threadRef,
          terminalLinkProfileName: "Work account",
          openPreview,
          fallbackToBrowser,
          forceBrowser,
        }),
      ).rejects.toMatchObject({
        _tag: "TerminalLinkProfileUnavailableError",
        reason: "hosted-web",
        message:
          "Open this Action link in the desktop app that owns the configured browser profile.",
      });
      expect(browserDefaultsMocks.resolve).not.toHaveBeenCalled();
      expect(hostingMocks.prepare).not.toHaveBeenCalled();
      expect(openPreview).not.toHaveBeenCalled();
      expect(externalOpen).not.toHaveBeenCalled();
      expect(fallbackToBrowser).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "keeps ordinary hosted-web links external after managed recovery (modifier=%s)",
    async (forceBrowser) => {
      const replace = vi.fn();
      const externalOpen = vi.fn(() => ({
        opener: {},
        closed: false,
        document: { createElement: () => ({}), head: { append: vi.fn() } },
        location: { replace },
        close: vi.fn(),
      }));
      vi.stubGlobal("window", { open: externalOpen });
      vi.spyOn(previewRuntime, "isPreviewAvailableFor").mockReturnValue(true);
      const url = "http://localhost:5173/qa";
      const resolved = "http://workstation.example:5173/qa";
      hostingMocks.prepare.mockResolvedValue({ url: resolved, managed: true, restored: true });
      const openPreview = vi.fn(async () => AsyncResult.success(snapshot));
      const fallbackToBrowser = vi.fn();
      await openTerminalLinkInPreview({
        url,
        threadRef,
        openPreview,
        fallbackToBrowser,
        forceBrowser,
      });
      expect(externalOpen).toHaveBeenCalledExactlyOnceWith("about:blank", "_blank");
      expect(hostingMocks.prepare).toHaveBeenCalledExactlyOnceWith(threadRef, url);
      expect(replace).toHaveBeenCalledExactlyOnceWith(resolved);
      expect(browserDefaultsMocks.resolve).not.toHaveBeenCalled();
      expect(openPreview).not.toHaveBeenCalled();
      expect(fallbackToBrowser).not.toHaveBeenCalled();
    },
  );

  it("allows the desktop modifier only after validating the named profile", async () => {
    const openPreview = vi.fn(async () => AsyncResult.success(snapshot));
    const fallbackToBrowser = vi.fn();
    await openTerminalLinkInPreview({
      url: "https://example.com/docs",
      threadRef,
      terminalLinkProfileName: "Work account",
      openPreview,
      fallbackToBrowser,
      forceBrowser: true,
    });
    expect(browserDefaultsMocks.resolve).toHaveBeenCalledOnce();
    expect(fallbackToBrowser).toHaveBeenCalledExactlyOnceWith("https://example.com/docs");
    expect(openPreview).not.toHaveBeenCalled();
  });

  it("does not let a desktop modifier bypass ambiguous profile identity", async () => {
    browserDefaultsMocks.resolve.mockResolvedValue({
      ...hydratedDefaults,
      profiles: [
        ...hydratedDefaults.profiles,
        { id: "other", name: "Work account", kind: "persistent" },
      ],
    });
    const openPreview = vi.fn(async () => AsyncResult.success(snapshot));
    const fallbackToBrowser = vi.fn();
    await expect(
      openTerminalLinkInPreview({
        url: "https://example.com/docs",
        threadRef,
        terminalLinkProfileName: "Work account",
        openPreview,
        fallbackToBrowser,
        forceBrowser: true,
      }),
    ).rejects.toMatchObject({ _tag: "PreviewAutomationProfileError", reason: "ambiguous" });
    expect(hostingMocks.prepare).not.toHaveBeenCalled();
    expect(openPreview).not.toHaveBeenCalled();
    expect(fallbackToBrowser).not.toHaveBeenCalled();
  });

  it("opens a generic Action link with the exact named profile without changing Default", async () => {
    const openPreview = vi.fn(async () => AsyncResult.success(snapshot));
    const fallbackToBrowser = vi.fn();
    await openTerminalLinkInPreview({
      url: "https://example.com/docs",
      threadRef,
      openPreview,
      fallbackToBrowser,
      forceBrowser: false,
      terminalLinkProfileName: "Work account",
    });
    expect(openPreview).toHaveBeenCalledWith({
      environmentId: "local",
      input: {
        threadId: "thread-1",
        url: "https://example.com/docs",
        viewport: hydratedDefaults.viewport,
        profileId: "work",
      },
    });
    expect(hydratedDefaults.profileId).toBe("default");
    expect(fallbackToBrowser).not.toHaveBeenCalled();
  });

  it("keeps the configured ordinary profile after opening an opted-in Action", async () => {
    const defaults = { ...hydratedDefaults, profileId: "research" };
    browserDefaultsMocks.resolve.mockResolvedValue(defaults);
    const openPreview = vi.fn(async () => AsyncResult.success(snapshot));
    const fallbackToBrowser = vi.fn();
    const input = {
      url: "https://example.com/docs",
      threadRef,
      openPreview,
      fallbackToBrowser,
      forceBrowser: false,
    };
    await openTerminalLinkInPreview({ ...input, terminalLinkProfileName: "Work account" });
    await openTerminalLinkInPreview(input);
    expect(openPreview).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ input: expect.objectContaining({ profileId: "work" }) }),
    );
    expect(openPreview).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ input: expect.objectContaining({ profileId: "research" }) }),
    );
    expect(defaults.profileId).toBe("research");
    expect(fallbackToBrowser).not.toHaveBeenCalled();
  });

  it("does not let a browser modifier bypass a missing named profile", async () => {
    const fallbackToBrowser = vi.fn();
    const openPreview = vi.fn(async () => AsyncResult.success(snapshot));
    await expect(
      openTerminalLinkInPreview({
        url: "https://example.com/docs",
        threadRef,
        openPreview,
        fallbackToBrowser,
        forceBrowser: true,
        terminalLinkProfileName: "Missing",
      }),
    ).rejects.toMatchObject({ _tag: "PreviewAutomationProfileError", reason: "unknown" });
    expect(fallbackToBrowser).not.toHaveBeenCalled();
    expect(openPreview).not.toHaveBeenCalled();
  });

  it.each([
    { name: "Missing", profiles: hydratedDefaults.profiles, reason: "unknown" },
    { name: "work account", profiles: hydratedDefaults.profiles, reason: "unknown" },
    {
      name: "Work account",
      profiles: [
        ...hydratedDefaults.profiles,
        { id: "other", name: "Work account", kind: "persistent" as const },
      ],
      reason: "ambiguous",
    },
  ])(
    "rejects $reason profile intent before opening either browser",
    async ({ name, profiles, reason }) => {
      browserDefaultsMocks.resolve.mockResolvedValue({ ...hydratedDefaults, profiles });
      const openPreview = vi.fn(async () => AsyncResult.success(snapshot));
      const fallbackToBrowser = vi.fn();
      await expect(
        openTerminalLinkInPreview({
          url: "https://example.com/docs",
          threadRef,
          openPreview,
          fallbackToBrowser,
          forceBrowser: false,
          terminalLinkProfileName: name,
        }),
      ).rejects.toMatchObject({ _tag: "PreviewAutomationProfileError", reason });
      expect(openPreview).not.toHaveBeenCalled();
      expect(fallbackToBrowser).not.toHaveBeenCalled();
      expect(hostingMocks.prepare).not.toHaveBeenCalled();
    },
  );

  it("reports named-profile preview failure without falling back to another browser", async () => {
    const fallbackToBrowser = vi.fn();
    await expect(
      openTerminalLinkInPreview({
        url: "https://example.com/docs",
        threadRef,
        openPreview: async () => AsyncResult.failure(Cause.fail(new Error("unavailable"))),
        fallbackToBrowser,
        forceBrowser: false,
        terminalLinkProfileName: "Work account",
      }),
    ).rejects.toBeInstanceOf(TerminalLinkPreviewOpenError);
    expect(fallbackToBrowser).not.toHaveBeenCalled();
  });

  it("reports unavailable integrated routing for explicit intent instead of silently opening externally", async () => {
    linkTargetMocks.preference.mockReturnValue("system");
    const fallbackToBrowser = vi.fn();
    const openPreview = vi.fn(async () => AsyncResult.success(snapshot));
    await expect(
      openTerminalLinkInPreview({
        url: "https://example.com/docs",
        threadRef,
        openPreview,
        fallbackToBrowser,
        forceBrowser: false,
        terminalLinkProfileName: "Work account",
      }),
    ).rejects.toMatchObject({
      _tag: "TerminalLinkProfileUnavailableError",
      reason: "preview-unavailable",
      message: "Opening this Action link requires the integrated Browser with its named profile.",
    });
    expect(browserDefaultsMocks.resolve).toHaveBeenCalledOnce();
    expect(openPreview).not.toHaveBeenCalled();
    expect(fallbackToBrowser).not.toHaveBeenCalled();
  });

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
});
