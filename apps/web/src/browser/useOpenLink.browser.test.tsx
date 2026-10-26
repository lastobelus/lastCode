import {
  AuthPreviewOperateScope,
  EnvironmentId,
  ThreadId,
  type BrowserLinkTarget,
  type PreviewOpenInput,
  type PreviewSessionSnapshot,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import type { PreparedHostedPreview } from "@t3tools/client-runtime/preview-hosting";
import { setPreviewBootstrapTokenOnUrl } from "@t3tools/shared/remote";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render, stubGlobal } from "../../test/render";

const mocks = vi.hoisted(() => ({
  prepareHostedPreview:
    vi.fn<(ref: ScopedThreadRef, url: string) => Promise<PreparedHostedPreview> | undefined>(),
  resolvePreference: vi.fn<() => Promise<BrowserLinkTarget>>(),
  resolveDefaults: vi.fn(async () => ({})),
  openPreview: vi.fn(),
  openExternal: vi.fn(async (_url: string) => undefined),
  readScope: vi.fn((_environmentId: EnvironmentId, _scope: string) => true),
  connected: true,
  serverBrowser: true,
}));

vi.mock(import("~/components/preview/previewHostingRecovery"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    prepareHostedPreview: (...args: Parameters<typeof actual.prepareHostedPreview>) =>
      mocks.prepareHostedPreview(args[0], args[1]) ?? actual.prepareHostedPreview(...args),
  };
});
vi.mock(import("./browserLinkTarget"), async (original) => ({
  ...(await original()),
  resolveBrowserLinkTargetPreference: mocks.resolvePreference,
}));
vi.mock("./browserDefaults", () => ({
  resolveBrowserDefaults: mocks.resolveDefaults,
  browserDefaultOpenViewport: () => ({ _tag: "fill" }),
  browserDefaultOpenProfileId: () => "work-account",
}));
vi.mock("./previewRuntime", () => ({
  isPreviewAvailableFor: () => mocks.serverBrowser,
  previewRuntimeFor: () => (mocks.serverBrowser ? "server" : undefined),
  desktopBrowserHostFor: () => undefined,
}));
vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  readEnvironmentSupportsServerBrowser: () => mocks.serverBrowser,
}));
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: mocks.readScope,
  readPreparedConnection: (() =>
    mocks.connected ? { httpBaseUrl: "https://workstation.example" } : null) as never,
}));
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => mocks.openPreview) as never,
}));
vi.mock("~/localApi", () => ({
  readLocalApi: () => ({ shell: { openExternal: mocks.openExternal } }),
  ensureLocalApi: () => ({ shell: { openExternal: mocks.openExternal } }),
}));

import { BrowserSettingsReadError } from "./openFileInPreview";
import { useOpenLink } from "./useOpenLink";
import { useBrowserHistoryStore } from "~/browserHistoryStore";
import { readThreadPreviewState, resetPreviewStateForTests } from "~/previewStateStore";
import { selectActiveRightPanelSurface, useRightPanelStore } from "~/rightPanelStore";

const threadRef = {
  environmentId: EnvironmentId.make("managed-link-env"),
  threadId: ThreadId.make("managed-link-thread"),
};
const sourceUrl = "http://localhost:5173/app/a%2Fb?q=1#section";
const prepared = {
  url: "https://workstation.example:5173/app/a%2Fb?q=1#section",
  localUrl: "http://127.0.0.1:5173/app/a%2Fb?q=1#section",
  managed: true,
  restored: true,
} satisfies PreparedHostedPreview;
const snapshot: PreviewSessionSnapshot = {
  threadId: threadRef.threadId,
  tabId: "managed-link-browser-tab",
  runtime: "server",
  backingPage: "server",
  navStatus: { _tag: "Idle" },
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function setup(surface: "web" | "desktop" = "web"): Disposable {
  using globals = new DisposableStack();
  globals.use(stubGlobal("desktopBridge", surface === "desktop" ? {} : undefined));
  mocks.prepareHostedPreview.mockReset().mockResolvedValue(prepared);
  mocks.resolvePreference.mockReset().mockResolvedValue("system");
  mocks.resolveDefaults.mockReset().mockResolvedValue({});
  mocks.openPreview.mockReset().mockResolvedValue(AsyncResult.success(snapshot));
  mocks.openExternal.mockClear();
  mocks.readScope.mockReset().mockReturnValue(true);
  mocks.connected = true;
  mocks.serverBrowser = true;
  resetPreviewStateForTests();
  useRightPanelStore.setState({
    byThreadKey: {},
    threadPanelVisibilityByThreadKey: {},
    userActionRevisionByThreadKey: {},
  });
  useBrowserHistoryStore.setState({
    byProjectKey: {},
    projectKeyByThreadKey: {},
    pendingVisitsByThreadKey: {},
  });
  useBrowserHistoryStore.getState().registerThreadProject(threadRef, "managed-link-project");
  return globals.move();
}

async function renderLinks(urls: readonly string[], targetThreadRef?: ScopedThreadRef) {
  await using stack = new AsyncDisposableStack();
  const openings = new Map<string, Promise<void>>();
  function Link({ url }: { url: string }) {
    const openLink = useOpenLink(threadRef);
    return (
      <a
        href={url}
        onClick={(event) => {
          event.preventDefault();
          openings.set(url, openLink(url, { event, threadRef: targetThreadRef }));
        }}
      >
        Open link
      </a>
    );
  }
  const screen = stack.use(await render(urls.map((url) => <Link key={url} url={url} />)));
  const environment = stack.move();
  return {
    click: (url: string, options?: MouseEventInit) => {
      [...screen.container.querySelectorAll("a")]
        .find((link) => link.getAttribute("href") === url)!
        .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...options }));
      return openings.get(url)!;
    },
    [Symbol.asyncDispose]: () => environment.disposeAsync(),
  };
}

async function renderLink(url = sourceUrl, targetThreadRef?: ScopedThreadRef) {
  await using stack = new AsyncDisposableStack();
  const links = stack.use(await renderLinks([url], targetThreadRef));
  const environment = stack.move();
  return {
    click: (options?: MouseEventInit) => links.click(url, options),
    [Symbol.asyncDispose]: () => environment.disposeAsync(),
  };
}

function deferredPreparation() {
  let finish!: (destination: PreparedHostedPreview) => void;
  const promise = new Promise<PreparedHostedPreview>((resolve) => {
    finish = resolve;
  });
  return { promise, finish };
}

function reservePopup() {
  const tab = {
    opener: {},
    closed: false,
    close: vi.fn(),
    location: { replace: vi.fn() },
    document: document.implementation.createHTMLDocument(),
  };
  const open = vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
  return { open, tab, [Symbol.dispose]: () => open.mockRestore() };
}

function expectNoVisit() {
  expect(useBrowserHistoryStore.getState().byProjectKey).toEqual({});
  expect(readThreadPreviewState(threadRef).recentlySeenUrls).toEqual([]);
}

describe("web link opening", () => {
  it.each(["system", "app"] as const)(
    "opens a recovered managed app in its owning panel with the %s preference",
    async (preference) => {
      using _setup = setup();
      mocks.resolvePreference.mockResolvedValueOnce(preference);
      using popup = reservePopup();
      const { open, tab } = popup;
      const preparation = deferredPreparation();
      mocks.prepareHostedPreview.mockReturnValueOnce(preparation.promise);
      await using link = await renderLink();
      const opening = link.click();
      expect(open).toHaveBeenCalledExactlyOnceWith("about:blank", "_blank");
      expect(mocks.openPreview).not.toHaveBeenCalled();
      await act(async () => {
        preparation.finish(prepared);
        await opening;
      });

      expect(mocks.prepareHostedPreview).toHaveBeenCalledExactlyOnceWith(threadRef, sourceUrl);
      expect(mocks.readScope).toHaveBeenCalledWith(
        threadRef.environmentId,
        AuthPreviewOperateScope,
      );
      expect(mocks.openPreview).toHaveBeenCalledExactlyOnceWith({
        environmentId: threadRef.environmentId,
        input: expect.objectContaining({
          threadId: threadRef.threadId,
          url: prepared.localUrl,
          runtime: "server",
          browserHost: "environment",
          profileId: "default",
        }),
      });
      expect(
        selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, threadRef)?.id,
      ).toBe(`browser:${snapshot.tabId}`);
      expect(readThreadPreviewState(threadRef).recentlySeenUrls).toEqual([sourceUrl]);
      expect(useBrowserHistoryStore.getState().byProjectKey["managed-link-project"]).toEqual([
        expect.objectContaining({ url: sourceUrl }),
      ]);
      expect(tab.location.replace).not.toHaveBeenCalled();
      expect(tab.close).toHaveBeenCalledOnce();
      expect(mocks.openExternal).not.toHaveBeenCalled();
    },
  );

  it("opens the owning panel even when the client blocks popups", async () => {
    using _setup = setup();
    using _open = vi.spyOn(window, "open").mockReturnValue(null);
    await using link = await renderLink();
    await act(async () => link.click());
    expect(mocks.openPreview).toHaveBeenCalledOnce();
    expect(readThreadPreviewState(threadRef).snapshot).toEqual(snapshot);
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });

  it("uses the link's thread override for the browser and permission check", async () => {
    using _setup = setup();
    const targetThreadRef = {
      environmentId: EnvironmentId.make("other-managed-link-env"),
      threadId: ThreadId.make("other-managed-link-thread"),
    };
    mocks.openPreview.mockResolvedValueOnce(
      AsyncResult.success({ ...snapshot, threadId: targetThreadRef.threadId }),
    );
    using _popup = reservePopup();
    await using link = await renderLink(sourceUrl, targetThreadRef);
    await act(async () => link.click());
    expect(mocks.prepareHostedPreview).toHaveBeenCalledExactlyOnceWith(targetThreadRef, sourceUrl);
    expect(mocks.readScope).toHaveBeenCalledWith(
      targetThreadRef.environmentId,
      AuthPreviewOperateScope,
    );
    expect(mocks.openPreview).toHaveBeenCalledExactlyOnceWith({
      environmentId: targetThreadRef.environmentId,
      input: expect.objectContaining({
        threadId: targetThreadRef.threadId,
        browserHost: "environment",
      }),
    });
    expect(readThreadPreviewState(threadRef).snapshot).toBeNull();
    expect(readThreadPreviewState(targetThreadRef).snapshot?.threadId).toBe(
      targetThreadRef.threadId,
    );
  });

  it.each(["system", "app"] as const)(
    "opens a public GitHub link immediately while disconnected with the %s preference",
    async (preference) => {
      using _setup = setup();
      mocks.resolvePreference.mockResolvedValueOnce(preference);
      mocks.connected = false;
      mocks.readScope.mockReturnValue(false);
      mocks.prepareHostedPreview.mockReset();
      using popup = reservePopup();
      const { open, tab } = popup;
      const url = "https://github.com/example/project/pull/42";
      await using link = await renderLink(url);
      const opening = link.click();
      expect(open).toHaveBeenCalledExactlyOnceWith("about:blank", "_blank");
      await act(async () => opening);
      expect(tab.location.replace).toHaveBeenCalledExactlyOnceWith(url);
      expect(tab.close).not.toHaveBeenCalled();
      expect(mocks.openPreview).not.toHaveBeenCalled();
      expectNoVisit();
    },
  );

  it.each([{ metaKey: true }, { ctrlKey: true }, { button: 1 }])(
    "opens a managed link in the owning browser background for modifier intent %o",
    async (event) => {
      using _setup = setup();
      using popup = reservePopup();
      const { tab } = popup;
      await using link = await renderLink();
      await act(async () => link.click(event));
      expect(tab.location.replace).not.toHaveBeenCalled();
      expect(tab.close).toHaveBeenCalledOnce();
      expect(mocks.openPreview).toHaveBeenCalledExactlyOnceWith({
        environmentId: threadRef.environmentId,
        input: expect.objectContaining({
          url: prepared.localUrl,
          runtime: "server",
          browserHost: "environment",
          background: true,
        }),
      });
      expect(readThreadPreviewState(threadRef).sessions[snapshot.tabId]).toEqual(snapshot);
      expect(
        selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, threadRef),
      ).toBeNull();
      expect(useBrowserHistoryStore.getState().byProjectKey["managed-link-project"]).toEqual([
        expect.objectContaining({ url: sourceUrl }),
      ]);
    },
  );

  it.each(["permission", "unavailable", "unmanaged"])(
    "keeps the external fallback for %s links",
    async (reason) => {
      using _setup = setup();
      if (reason === "permission") mocks.readScope.mockReturnValue(false);
      if (reason === "unavailable") mocks.serverBrowser = false;
      if (reason === "unmanaged")
        mocks.prepareHostedPreview.mockResolvedValue({ ...prepared, managed: false });
      using popup = reservePopup();
      const { tab } = popup;
      await using link = await renderLink();
      await act(async () => link.click());
      expect(tab.location.replace).toHaveBeenCalledExactlyOnceWith(prepared.url);
      expect(mocks.openPreview).not.toHaveBeenCalled();
      expectNoVisit();
    },
  );

  it("quietly closes the reserved popup when the panel open is interrupted", async () => {
    using _setup = setup();
    mocks.openPreview.mockResolvedValueOnce(AsyncResult.failure(Cause.interrupt()));
    using popup = reservePopup();
    const { tab } = popup;
    await using link = await renderLink();
    await act(async () => link.click());
    expect(tab.close).toHaveBeenCalledOnce();
    expect(tab.location.replace).not.toHaveBeenCalled();
    expectNoVisit();
  });

  it("reports a managed panel failure without navigating a client private URL", async () => {
    using _setup = setup();
    const navigationUrl = setPreviewBootstrapTokenOnUrl(new URL(prepared.url), "one-use").href;
    mocks.prepareHostedPreview.mockResolvedValueOnce({ ...prepared, navigationUrl });
    const failure = new Error("failed");
    mocks.openPreview.mockResolvedValueOnce(AsyncResult.failure(Cause.fail(failure)));
    using popup = reservePopup();
    const { tab } = popup;
    await using link = await renderLink();
    await expect(link.click()).rejects.toBe(failure);
    expect(tab.location.replace).not.toHaveBeenCalled();
    expect(tab.close).toHaveBeenCalledOnce();
    expect(mocks.prepareHostedPreview).toHaveBeenCalledExactlyOnceWith(threadRef, sourceUrl);
    expectNoVisit();
  });

  it("rejects settings failures without navigating the popup", async () => {
    using _setup = setup();
    const failure = new Error("settings unavailable");
    mocks.resolveDefaults.mockRejectedValueOnce(failure);
    using popup = reservePopup();
    const { tab } = popup;
    await using link = await renderLink();
    await expect(link.click()).rejects.toBeInstanceOf(BrowserSettingsReadError);
    expect(tab.close).toHaveBeenCalledOnce();
    expect(tab.location.replace).not.toHaveBeenCalled();
    expect(mocks.openPreview).not.toHaveBeenCalled();
    expectNoVisit();
  });

  it.each(["preference", "recovery"])(
    "rejects %s failures without opening either browser",
    async (stage) => {
      using _setup = setup();
      const failure = new Error(`${stage} unavailable`);
      if (stage === "preference") mocks.resolvePreference.mockRejectedValueOnce(failure);
      else mocks.prepareHostedPreview.mockRejectedValueOnce(failure);
      using popup = reservePopup();
      const { tab } = popup;
      await using link = await renderLink();
      await expect(link.click()).rejects.toBe(failure);
      expect(tab.close).toHaveBeenCalledOnce();
      expect(tab.location.replace).not.toHaveBeenCalled();
      expect(mocks.openPreview).not.toHaveBeenCalled();
      expectNoVisit();
    },
  );
});

describe("desktop link opening", () => {
  it.each(["system", "app"] as const)(
    "opens a remote managed link in its owning panel with the %s preference",
    async (preference) => {
      using _setup = setup("desktop");
      mocks.resolvePreference.mockResolvedValueOnce(preference);
      using open = vi.spyOn(window, "open");
      await using link = await renderLink();
      await act(async () => link.click());
      expect(open).not.toHaveBeenCalled();
      expect(mocks.openExternal).not.toHaveBeenCalled();
      expect(mocks.prepareHostedPreview).toHaveBeenCalledExactlyOnceWith(threadRef, sourceUrl);
      expect(mocks.openPreview).toHaveBeenCalledExactlyOnceWith({
        environmentId: threadRef.environmentId,
        input: expect.objectContaining({
          threadId: threadRef.threadId,
          url: prepared.localUrl,
          runtime: "server",
          browserHost: "environment",
        }),
      });
      expect(
        selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, threadRef)?.id,
      ).toBe(`browser:${snapshot.tabId}`);
      expect(useBrowserHistoryStore.getState().byProjectKey["managed-link-project"]).toEqual([
        expect.objectContaining({ url: sourceUrl }),
      ]);
    },
  );

  it.each([{ metaKey: true }, { ctrlKey: true }, { button: 1 }])(
    "opens remote managed modifier intent %o in the owning browser background",
    async (event) => {
      using _setup = setup("desktop");
      await using link = await renderLink();
      await act(async () => link.click(event));
      expect(mocks.openPreview).toHaveBeenCalledExactlyOnceWith({
        environmentId: threadRef.environmentId,
        input: expect.objectContaining({
          url: prepared.localUrl,
          runtime: "server",
          browserHost: "environment",
          background: true,
        }),
      });
      expect(
        selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, threadRef),
      ).toBeNull();
      expect(mocks.openExternal).not.toHaveBeenCalled();
      expect(mocks.prepareHostedPreview).toHaveBeenCalledExactlyOnceWith(threadRef, sourceUrl);
    },
  );

  it.each(["localhost", "127.0.0.1", "[::1]"])(
    "keeps a local %s managed destination in the system browser",
    async (host) => {
      using _setup = setup("desktop");
      const url = `http://${host}:5173/app/a%2Fb?q=1#section`;
      mocks.prepareHostedPreview.mockResolvedValueOnce({ ...prepared, url });
      using open = vi.spyOn(window, "open");
      await using link = await renderLink();
      await act(async () => link.click());
      expect(open).not.toHaveBeenCalled();
      expect(mocks.openExternal).toHaveBeenCalledExactlyOnceWith(url);
      expect(mocks.openPreview).not.toHaveBeenCalled();
      expect(mocks.prepareHostedPreview).toHaveBeenCalledExactlyOnceWith(threadRef, sourceUrl);
      expectNoVisit();
    },
  );

  it.each(["permission", "unavailable", "unmanaged"])(
    "preserves the desktop fallback for %s links",
    async (reason) => {
      using _setup = setup("desktop");
      if (reason === "permission") {
        mocks.readScope.mockReturnValue(false);
        mocks.resolvePreference.mockResolvedValueOnce("app");
      }
      if (reason === "unavailable") mocks.serverBrowser = false;
      if (reason === "unmanaged")
        mocks.prepareHostedPreview.mockResolvedValueOnce({ ...prepared, managed: false });
      await using link = await renderLink();
      await act(async () => link.click());
      expect(mocks.openExternal).toHaveBeenCalledExactlyOnceWith(prepared.url);
      expect(mocks.openPreview).not.toHaveBeenCalled();
      expect(mocks.prepareHostedPreview).toHaveBeenCalledExactlyOnceWith(threadRef, sourceUrl);
      expectNoVisit();
    },
  );

  it.each([
    ["system", {}, false],
    ["app", {}, true],
    ["app", { metaKey: true }, false],
  ] as const)(
    "preserves public desktop links with preference %s and event %o",
    async (preference, event, inApp) => {
      using _setup = setup("desktop");
      const url = "https://github.com/example/project/pull/42";
      mocks.resolvePreference.mockResolvedValueOnce(preference);
      mocks.prepareHostedPreview.mockResolvedValueOnce({ url, managed: false, restored: false });
      await using link = await renderLink(url);
      await act(async () => link.click(event));
      expect(mocks.prepareHostedPreview).toHaveBeenCalledExactlyOnceWith(threadRef, url);
      if (inApp) {
        expect(mocks.openExternal).not.toHaveBeenCalled();
        expect(mocks.openPreview).toHaveBeenCalledExactlyOnceWith({
          environmentId: threadRef.environmentId,
          input: expect.objectContaining({ url }),
        });
        expect(mocks.openPreview.mock.calls[0]?.[0].input).not.toHaveProperty("browserHost");
      } else {
        expect(mocks.openExternal).toHaveBeenCalledExactlyOnceWith(url);
        expect(mocks.openPreview).not.toHaveBeenCalled();
      }
    },
  );

  it("reuses the prepared navigation when an ordinary desktop app open falls back externally", async () => {
    using _setup = setup("desktop");
    const navigationUrl = setPreviewBootstrapTokenOnUrl(new URL(prepared.url), "one-use").href;
    mocks.resolvePreference.mockResolvedValueOnce("app");
    mocks.prepareHostedPreview.mockResolvedValueOnce({
      ...prepared,
      navigationUrl,
      managed: false,
    });
    mocks.openPreview.mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("failed"))));
    using _consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await using link = await renderLink();
    await act(async () => link.click());
    expect(mocks.openExternal).toHaveBeenCalledExactlyOnceWith(navigationUrl);
    expect(mocks.prepareHostedPreview).toHaveBeenCalledExactlyOnceWith(threadRef, sourceUrl);
    expectNoVisit();
  });

  it("reports a remote managed desktop open failure without falling back to the client", async () => {
    using _setup = setup("desktop");
    const failure = new Error("failed");
    mocks.openPreview.mockResolvedValueOnce(AsyncResult.failure(Cause.fail(failure)));
    await using link = await renderLink();
    await expect(link.click()).rejects.toBe(failure);
    expect(mocks.openExternal).not.toHaveBeenCalled();
    expect(mocks.prepareHostedPreview).toHaveBeenCalledExactlyOnceWith(threadRef, sourceUrl);
    expectNoVisit();
  });

  it("keeps an interrupted remote managed desktop open silent", async () => {
    using _setup = setup("desktop");
    mocks.openPreview.mockResolvedValueOnce(AsyncResult.failure(Cause.interrupt()));
    await using link = await renderLink();
    await act(async () => link.click());
    expect(mocks.openExternal).not.toHaveBeenCalled();
    expectNoVisit();
  });
});

describe.each(["web", "desktop"] as const)("%s managed link focus", (surface) => {
  it("orders delayed recovery by click so an earlier slow link cannot steal focus", async () => {
    using _setup = setup(surface);
    using _popup = surface === "web" ? reservePopup() : undefined;
    const fastSource = "http://localhost:5173/fast";
    const fastPrepared = {
      ...prepared,
      url: "https://workstation.example:5173/fast",
      localUrl: "http://127.0.0.1:5173/fast",
    };
    const slow = deferredPreparation();
    mocks.prepareHostedPreview.mockImplementation((_ref, url) =>
      url === sourceUrl ? slow.promise : Promise.resolve(fastPrepared),
    );
    mocks.openPreview.mockImplementation(async ({ input }: { input: PreviewOpenInput }) =>
      AsyncResult.success({
        ...snapshot,
        tabId: input.url === prepared.localUrl ? "slow-tab" : "fast-tab",
      }),
    );
    await using links = await renderLinks([sourceUrl, fastSource]);
    const revision = useRightPanelStore.getState().getUserActionRevision(threadRef);
    const first = links.click(sourceUrl);
    expect(useRightPanelStore.getState().getUserActionRevision(threadRef)).toBe(revision + 1);
    const second = links.click(fastSource);
    expect(useRightPanelStore.getState().getUserActionRevision(threadRef)).toBe(revision + 2);
    await act(async () => second);
    expect(
      selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, threadRef)?.id,
    ).toBe("browser:fast-tab");
    await act(async () => {
      slow.finish(prepared);
      await first;
    });
    expect(
      selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, threadRef)?.id,
    ).toBe("browser:fast-tab");
    expect(
      mocks.openPreview.mock.calls.map(([request]) => request.input.focus.userActionRevision),
    ).toEqual([revision + 2, revision + 1]);
    expect(Object.keys(readThreadPreviewState(threadRef).sessions).sort()).toEqual([
      "fast-tab",
      "slow-tab",
    ]);
    expect(mocks.prepareHostedPreview).toHaveBeenCalledTimes(2);
  });

  it.each(["ready", "connection", "capability", "permission"])(
    "preserves a manual panel choice while a managed link waits for %s",
    async (pending) => {
      using _setup = setup(surface);
      if (pending === "connection") mocks.connected = false;
      if (pending === "capability") mocks.serverBrowser = false;
      if (pending === "permission") mocks.readScope.mockReturnValue(false);
      using _popup = surface === "web" ? reservePopup() : undefined;
      const preparation = deferredPreparation();
      mocks.prepareHostedPreview.mockReturnValueOnce(preparation.promise);
      await using link = await renderLink();
      const revision = useRightPanelStore.getState().getUserActionRevision(threadRef);
      const opening = link.click();
      useRightPanelStore.getState().open(threadRef, "files");
      await act(async () => {
        mocks.connected = true;
        mocks.serverBrowser = true;
        mocks.readScope.mockReturnValue(true);
        preparation.finish(prepared);
        await opening;
      });
      expect(
        selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, threadRef)?.id,
      ).toBe("files");
      expect(readThreadPreviewState(threadRef).sessions[snapshot.tabId]).toEqual(snapshot);
      expect(mocks.openPreview.mock.calls[0]?.[0].input.focus.userActionRevision).toBe(
        revision + 1,
      );
      expect(mocks.prepareHostedPreview).toHaveBeenCalledExactlyOnceWith(threadRef, sourceUrl);
    },
  );

  it("captures background modifier opens without superseding a pending foreground click", async () => {
    using _setup = setup(surface);
    using _popup = surface === "web" ? reservePopup() : undefined;
    const preparation = deferredPreparation();
    mocks.prepareHostedPreview.mockReturnValueOnce(preparation.promise);
    await using link = await renderLink();
    const revision = useRightPanelStore.getState().recordSelectionIntent(threadRef);
    const opening = link.click({ metaKey: true });
    expect(useRightPanelStore.getState().getUserActionRevision(threadRef)).toBe(revision);
    await act(async () => {
      preparation.finish(prepared);
      await opening;
    });
    expect(mocks.openPreview.mock.calls[0]?.[0].input).toMatchObject({
      background: true,
      focus: { userActionRevision: revision },
    });
    expect(
      selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, threadRef),
    ).toBeNull();
  });
});
