import * as NodeEvents from "node:events";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  EnvironmentId,
  DesktopBrowserTransportError,
  PreviewTabId,
  ProviderInstanceId,
  ThreadId,
  type PreviewAutomationSnapshot,
  type PreviewAutomationStatus,
  type PreviewViewportSetting,
  type DesktopBrowserCommand,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type { BrowserContext, Page } from "playwright-core";
import { beforeEach, expect, vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Broker from "../mcp/PreviewAutomationBroker.ts";
import * as DesktopChannel from "./DesktopBrowserChannel.ts";
import * as Manager from "./Manager.ts";
import * as ServerBrowser from "./ServerBrowser.ts";
import * as PreviewBrowser from "./PreviewBrowser.ts";

// Keep the manager, broker, ownership, refs, and viewer paths real; replace Chromium I/O only.
vi.mock("./ServerBrowserContexts.ts", () => ({
  presentAsChrome: async () => {},
  ServerBrowserContexts: class {
    private readonly onClose: ((context: BrowserContext) => void) | undefined;
    constructor(options: { onContextClose?: (context: BrowserContext) => void }) {
      this.onClose = options.onContextClose;
    }
    async contextFor(profileId: string, isolationKey?: string) {
      contextRequests.push({ profileId, isolated: isolationKey !== undefined });
      if (contextFailure) throw contextFailure;
      await contextGate?.promise;
      const context = makeContext(this.onClose);
      contexts.push(context);
      return context as unknown as BrowserContext;
    }
    async scratchPage() {
      const page = makeContext().page;
      encoderPages.push(page);
      if (encoderSetupGate) {
        const evaluate = page.evaluate.getMockImplementation()!;
        page.evaluate.mockImplementation(async () => {
          recordingStageEntered?.resolve();
          await encoderSetupGate?.promise;
          return evaluate();
        });
      }
      if (encoderAcquireGate) recordingStageEntered?.resolve();
      await encoderAcquireGate?.promise;
      return page as unknown as Page;
    }
    async connectDesktopPage(endpoint: string) {
      const context = makeContext();
      await desktopPageSetup?.(context, endpoint);
      context.page.emulateMedia.mockImplementation(async () => {
        nativeRenderingEntered?.resolve();
        await nativeRenderingGate?.promise;
      });
      desktopConnections.push({ endpoint, context });
      return { browser: { close: async () => {} }, page: context.page as unknown as Page };
    }
    async close() {
      for (const context of contexts) await context.close();
    }
  },
}));

function makeSession() {
  return {
    on: vi.fn(),
    detach: vi.fn(async () => {}),
    send: vi.fn(async (method: string, _input?: unknown): Promise<Record<string, unknown>> => {
      if (method === "Page.getNavigationHistory") return { currentIndex: 0, entries: [{}] };
      if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { pageX: 0, pageY: 0 } };
      if (method === "Page.captureScreenshot") return { data: "ZnJhbWU=" };
      return { result: { value: "evaluated" } };
    }),
  };
}

function makeContext(onClose?: (context: BrowserContext) => void) {
  const events = new NodeEvents.EventEmitter();
  const sessions: ReturnType<typeof makeSession>[] = [];
  let url = "about:blank";
  let viewport = { width: 1280, height: 800 };
  let closed = false;
  let contextClosed = false;
  const page = {
    on: (name: string, callback: (...args: unknown[]) => void) => events.on(name, callback),
    once: (name: string, callback: (...args: unknown[]) => void) => events.once(name, callback),
    off: (name: string, callback: (...args: unknown[]) => void) => events.off(name, callback),
    emit: (name: string, ...args: unknown[]) => events.emit(name, ...args),
    emitAsync: (name: string, ...args: unknown[]) =>
      Promise.all(events.listeners(name).map((listener) => listener(...args))),
    setDefaultTimeout: vi.fn(),
    setDefaultNavigationTimeout: vi.fn(),
    context: () => context,
    mainFrame: () => page,
    url: () => url,
    title: vi.fn(async () => "test page"),
    viewportSize: () => viewport,
    setViewportSize: vi.fn(async (size: typeof viewport) => {
      viewport = size;
    }),
    goto: vi.fn(async (next: string) => {
      url = next;
      events.emit("load");
    }),
    goBack: vi.fn(async () => {}),
    goForward: vi.fn(async () => {}),
    reload: vi.fn(async () => {}),
    emulateMedia: vi.fn(async () => {}),
    waitForLoadState: vi.fn(async () => {}),
    evaluate: vi.fn(async (expression?: unknown) =>
      expression === "document.readyState"
        ? "complete"
        : {
            url,
            title: "test page",
            loading: false,
            visibleText: "delete",
            interactiveElements: [],
          },
    ),
    ariaSnapshot: vi.fn(async () => '- button "delete" [ref=e1]'),
    locator: vi.fn(() => {
      throw new Error("Unexpected locator action");
    }),
    keyboard: { press: vi.fn(async () => {}), insertText: vi.fn(async () => {}) },
    isClosed: () => closed,
    close: vi.fn(async () => {
      if (!closed) {
        closed = true;
        events.emit("close");
      }
    }),
  };
  const context = {
    page,
    sessions,
    newPage: async () => page as unknown as Page,
    grantPermissions: vi.fn(async () => {}),
    exposeBinding: vi.fn(async (_name: string, binding: ClipboardBinding) => {
      clipboardBinding = binding;
    }),
    addInitScript: vi.fn(async () => {}),
    newCDPSession: async () => {
      const session = makeSession();
      sessions.push(session);
      if (recordingCdpGate) recordingStageEntered?.resolve();
      await recordingCdpGate?.promise;
      return session;
    },
    close: vi.fn(async () => {
      if (contextClosed) return;
      contextClosed = true;
      await page.close();
      onClose?.(context as unknown as BrowserContext);
    }),
  };
  return context;
}

const contexts: ReturnType<typeof makeContext>[] = [];
/** The profile and isolation each headless tab asked its context for. */
const contextRequests: Array<{ profileId: string; isolated: boolean }> = [];
let contextGate: PromiseWithResolvers<void> | null = null;
type ClipboardBinding = (source: { page: unknown }, text: unknown) => void;
let clipboardBinding: ClipboardBinding | null = null;
let contextFailure: Error | null = null;
/** Server tabs the fake desktop renders, and the endpoints the server connected to. */
let desktopRendersNext = false;
let localDesktopAvailable = false;
let remoteUrlAvailable = true;
let remoteUrlGate: ReturnType<typeof Promise.withResolvers<void>> | null = null;
let remoteUrlEntered: ReturnType<typeof Promise.withResolvers<void>> | null = null;
let encoderAcquireGate: ReturnType<typeof Promise.withResolvers<void>> | null = null;
let encoderSetupGate: ReturnType<typeof Promise.withResolvers<void>> | null = null;
let recordingCdpGate: ReturnType<typeof Promise.withResolvers<void>> | null = null;
let recordingStageEntered: ReturnType<typeof Promise.withResolvers<void>> | null = null;
const encoderPages: Array<ReturnType<typeof makeContext>["page"]> = [];
type ProfileCatalogue = NonNullable<
  Effect.Success<ReturnType<DesktopChannel.DesktopBrowserChannel["Service"]["getProfiles"]>>
>;
let profileCatalogue: ProfileCatalogue | null = null;
let profileCatalogueUnavailable = false;
const profileRequests: Array<{ desktopHostId?: string }> = [];
const profileCatalogues = new Map<string, ProfileCatalogue>();
/** Pages the fake desktop takes back or returns; the channel's streams emit them. */
const desktopDetaches = new NodeEvents.EventEmitter();
const desktopTabs = new Set<string>();
const desktopRenders = (tabId: string) => {
  if (desktopRendersNext) {
    desktopRendersNext = false;
    desktopTabs.add(tabId);
  }
  return desktopTabs.has(tabId);
};
const releasedDesktopTabs: Array<string> = [];
const desktopConnections: Array<{ endpoint: string; context: ReturnType<typeof makeContext> }> = [];
let desktopPageSetup:
  | ((context: ReturnType<typeof makeContext>, endpoint: string) => Promise<void>)
  | null = null;
const presentedDesktopTabs = new Set<string>();
const desktopPresentations = new NodeEvents.EventEmitter();
const desktopPopupEvents = new NodeEvents.EventEmitter();
let nativePopupCreatedSeen: PromiseWithResolvers<void> | null = null;
let nativePopupClosedSeen: PromiseWithResolvers<void> | null = null;
let nativePopupCloseAttempted: PromiseWithResolvers<void> | null = null;
let desktopPopupHostConnected = true;
let nativePopupCloseFailure: "close-canceled" | null = null;
let nativeCloseChannel: DesktopChannel.DesktopBrowserChannel["Service"] | null = null;
let nativeCloseRejected: PromiseWithResolvers<void> | null = null;
const nativePopupPresence = new Map<string, boolean>();
let nativePopupProbeUnavailable = false;
let nativePopupProbeEntered: PromiseWithResolvers<void> | null = null;
let nativePopupProbeGate: PromiseWithResolvers<void> | null = null;
let nativePopupProbeProcessed: PromiseWithResolvers<void> | null = null;
const nativePopupProbes: Array<DesktopChannel.DesktopTabKey & { popupId: string }> = [];
let nativeCloseProcessed: PromiseWithResolvers<void> | null = null;
let nativeNavigationReported: {
  status: "Success" | "Loading" | "LoadFailed";
  completed: PromiseWithResolvers<void>;
} | null = null;
const popupBindings: Array<{
  threadId: string;
  tabId: string;
  desktopHostId?: string | undefined;
  popupId: string;
  openerTabId: string;
}> = [];
const popupClosures: Array<{ threadId: string; tabId: string; popupId: string }> = [];
const rootCreations: Array<
  DesktopChannel.DesktopTabKey & {
    profileId: string;
    url: string;
    viewport?: PreviewViewportSetting;
  }
> = [];
const rootClosures: Array<DesktopChannel.DesktopTabKey & { rootId: string }> = [];
const rootAcceptances: Array<DesktopChannel.DesktopTabKey & { rootId: string }> = [];
const rootPublications: Array<DesktopChannel.DesktopTabKey & { rootId: string }> = [];
let rootAcceptanceGate: PromiseWithResolvers<void> | null = null;
let rootAcceptanceEntered: PromiseWithResolvers<void> | null = null;
let rootAcceptanceFailure: DesktopBrowserTransportError | null = null;
let rootCloseFailure: "close-canceled" | null = null;
let rootCloseAttempted: PromiseWithResolvers<void> | null = null;
let releasedDesktopSeen: PromiseWithResolvers<void> | null = null;
const nativePopupEvents = <T>(name: string) =>
  Stream.callback<T>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const listener = (event: T) => Queue.offerUnsafe(queue, event);
        desktopPopupEvents.on(name, listener);
        return listener;
      }),
      (listener) => Effect.sync(() => desktopPopupEvents.off(name, listener)),
    ),
  );
let nativeRenderingGate: PromiseWithResolvers<void> | null = null;
let nativeRenderingEntered: PromiseWithResolvers<void> | null = null;
let nativePresentationProcessed: PromiseWithResolvers<void> | null = null;
let surfaceFailure: DesktopBrowserTransportError | null = null;
const surfaceCalls: Array<{
  tabId: string;
  leaseId: string;
  action: "acquire" | "release";
  viewport?: PreviewViewportSetting;
}> = [];
const testThread = {
  threadId: ThreadId.make("browser-test-thread"),
  providerSessionId: "agent-a",
  providerInstanceId: ProviderInstanceId.make("codex"),
};
const scope = {
  environmentId: EnvironmentId.make("browser-test-environment"),
  thread: testThread,
  client: undefined,
  requestNamespace: "browser-test",
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
};
/** The same thread, as another of its agent sessions. */
const asSession = (providerSessionId: string) => ({
  ...scope,
  thread: { ...testThread, providerSessionId },
});
const dependencies = Layer.mergeAll(
  Broker.layer,
  Manager.layer,
  Layer.succeed(ServerEnvironment.ServerEnvironment, {
    getEnvironmentId: Effect.succeed(scope.environmentId),
    getDescriptor: Effect.die("unused descriptor"),
  }),
  Layer.succeed(PreviewBrowser.PreviewBrowser, {
    executable: Effect.die("mock Chromium does not need an executable"),
    installed: Effect.die("mock Chromium does not need an executable"),
  }),
  Layer.succeed(DesktopChannel.DesktopBrowserChannel, {
    // Only tabs a test marks render on the desktop; the rest stay headless.
    available: true,
    getProfiles: (input) =>
      Effect.sync(() => {
        profileRequests.push(input);
        const selected =
          input.desktopHostId === undefined
            ? profileCatalogue
            : (profileCatalogues.get(input.desktopHostId) ??
              (profileCatalogue?.desktopHostId === input.desktopHostId ? profileCatalogue : null));
        return (
          selected ??
          (!profileCatalogueUnavailable &&
          (input.desktopHostId === undefined || input.desktopHostId === "local") &&
          (desktopRendersNext || localDesktopAvailable)
            ? {
                desktopHostId: "local",
                profiles: [{ id: "default", name: "Default", kind: "persistent" as const }],
                defaultProfileId: "default",
              }
            : null)
        );
      }),
    resolveUrl: (input) =>
      Effect.promise(async () => {
        remoteUrlEntered?.resolve();
        await remoteUrlGate?.promise;
        return remoteUrlAvailable
          ? input.url.replace("localhost", "environment.example.test")
          : null;
      }),
    subscribeCommands: () => Stream.empty,
    connectedHosts: nativePopupEvents<string>("host-connected"),
    receiveEvent: () => Effect.void,
    awaitAttached: (key) => Effect.sync(() => desktopRenders(key.tabId)),
    detached: Stream.callback<{ threadId: string; tabId: string }>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const onDetach = (key: { threadId: string; tabId: string }) =>
            Queue.offerUnsafe(queue, key);
          desktopDetaches.on("detach", onDetach);
          return onDetach;
        }),
        (onDetach) => Effect.sync(() => desktopDetaches.off("detach", onDetach)),
      ),
    ),
    attached: Stream.callback<{ threadId: string; tabId: string }>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const onAttach = (key: { threadId: string; tabId: string }) =>
            Queue.offerUnsafe(queue, key);
          desktopDetaches.on("attach", onAttach);
          return onAttach;
        }),
        (onAttach) => Effect.sync(() => desktopDetaches.off("attach", onAttach)),
      ),
    ),
    isAttached: (key) => Effect.sync(() => desktopRenders(key.tabId)),
    isPresented: (key) => presentedDesktopTabs.has(key.tabId),
    popups: nativePopupEvents<DesktopChannel.DesktopTabKey & { popupId: string; url: string }>(
      "created",
    ).pipe(Stream.tap(() => Effect.sync(() => nativePopupCreatedSeen?.resolve()))),
    closedPopups: nativePopupEvents<DesktopChannel.DesktopTabKey & { popupId: string }>(
      "closed",
    ).pipe(Stream.tap(() => Effect.sync(() => nativePopupClosedSeen?.resolve()))),
    probePopup: (key, popupId) =>
      Effect.suspend(() => {
        nativePopupProbes.push({ ...key, popupId });
        if (nativeCloseChannel) return nativeCloseChannel.probePopup(key, popupId);
        return Effect.promise(async () => {
          nativePopupProbeEntered?.resolve();
          await nativePopupProbeGate?.promise;
          return nativePopupPresence.get(popupId) ?? true;
        }).pipe(
          Effect.flatMap((present) =>
            nativePopupProbeUnavailable
              ? Effect.fail(new DesktopBrowserTransportError({ reason: "host-unavailable" }))
              : Effect.succeed(present),
          ),
          Effect.ensuring(Effect.sync(() => nativePopupProbeProcessed?.resolve())),
        );
      }),
    closedRoots: nativePopupEvents<DesktopChannel.DesktopTabKey & { rootId: string }>(
      "root-closed",
    ),
    createRoot: (key, input) =>
      Effect.suspend(() => {
        rootCreations.push({ ...key, ...input });
        return desktopRenders(key.tabId)
          ? Effect.succeed(`root-${key.tabId}`)
          : Effect.fail(new DesktopBrowserTransportError({ reason: "guest-unavailable" }));
      }),
    acceptRoot: (key, rootId) =>
      Effect.promise(async () => {
        rootAcceptances.push({ ...key, rootId });
        rootAcceptanceEntered?.resolve();
        await rootAcceptanceGate?.promise;
      }).pipe(
        Effect.andThen(
          Effect.suspend(() =>
            rootAcceptanceFailure ? Effect.fail(rootAcceptanceFailure) : Effect.void,
          ),
        ),
      ),
    publishRoot: (key, rootId) =>
      Effect.sync(() => {
        rootPublications.push({ ...key, rootId });
      }),
    closeRoot: (key, rootId) =>
      Effect.suspend(() => {
        rootClosures.push({ ...key, rootId });
        rootCloseAttempted?.resolve();
        if (rootCloseFailure)
          return Effect.fail(new DesktopBrowserTransportError({ reason: rootCloseFailure }));
        desktopPopupEvents.emit("root-closed", { ...key, rootId });
        return Effect.void;
      }),
    cancelRootCreation: (key, rootId) =>
      Effect.sync(() => {
        rootClosures.push({ ...key, rootId });
        rootCloseAttempted?.resolve();
        desktopPopupEvents.emit("root-closed", { ...key, rootId });
      }),
    bindPopup: (key, input) =>
      Effect.sync(() => {
        popupBindings.push({ ...key, ...input });
        desktopTabs.add(key.tabId);
      }),
    closePopup: (key, popupId) =>
      Effect.suspend(() => {
        nativePopupCloseAttempted?.resolve();
        if (nativeCloseChannel) return nativeCloseChannel.closePopup(key, popupId);
        if (!desktopPopupHostConnected)
          return Effect.fail(new DesktopBrowserTransportError({ reason: "host-unavailable" }));
        popupClosures.push({ threadId: key.threadId, tabId: key.tabId, popupId });
        if (nativePopupCloseFailure)
          return Effect.fail(new DesktopBrowserTransportError({ reason: nativePopupCloseFailure }));
        desktopPopupEvents.emit("closed", { ...key, popupId });
        return Effect.void;
      }),
    presentations: Stream.callback<{ threadId: string; tabId: string; desktopHostId: string }>(
      (queue) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const listener = (key: { threadId: string; tabId: string; desktopHostId: string }) =>
              Queue.offerUnsafe(queue, key);
            desktopPresentations.on("presentation", listener);
            return listener;
          }),
          (listener) => Effect.sync(() => desktopPresentations.off("presentation", listener)),
        ),
    ).pipe(Stream.tap(() => Effect.sync(() => nativePresentationProcessed?.resolve()))),
    surface: (key, input) =>
      Effect.sync(() => {
        surfaceCalls.push({ tabId: key.tabId, ...input });
        if (input.action === "release") return null;
        if (input.viewport && input.viewport._tag !== "fill") {
          return { width: input.viewport.width, height: input.viewport.height };
        }
        return { width: 1280, height: 800 };
      }).pipe(
        Effect.flatMap((viewport) =>
          input.action === "acquire" && surfaceFailure
            ? Effect.fail(surfaceFailure)
            : Effect.succeed(viewport),
        ),
      ),
    endpoint: (key) =>
      Effect.acquireRelease(Effect.succeed(`ws://desktop/${key.tabId}`), () =>
        Effect.sync(() => {
          releasedDesktopTabs.push(key.tabId);
          releasedDesktopSeen?.resolve();
        }),
      ),
    pointer: () => Effect.void,
  }),
).pipe(
  Layer.provideMerge(
    Layer.effect(
      ServerConfig.ServerConfig,
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        return {
          ...config,
          get desktopBrowserFd() {
            return desktopRendersNext || localDesktopAvailable ? 4 : undefined;
          },
          get desktopBrowserControlFd() {
            return desktopRendersNext || localDesktopAvailable ? 5 : undefined;
          },
        };
      }),
    ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-server-browser-" }))),
  ),
  Layer.provideMerge(NodeServices.layer),
);
const observedManager = Layer.effect(
  Manager.PreviewManager,
  Effect.gen(function* () {
    const manager = yield* Manager.PreviewManager;
    return {
      ...manager,
      close: (input: Parameters<typeof manager.close>[0]) =>
        manager
          .close(input)
          .pipe(Effect.tapError(() => Effect.sync(() => nativeCloseRejected?.resolve()))),
      reportStatus: (input: Parameters<typeof manager.reportStatus>[0]) =>
        manager.reportStatus(input).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (input.navStatus._tag === nativeNavigationReported?.status)
                nativeNavigationReported.completed.resolve();
            }),
          ),
        ),
      nativeClosedConfirmed: (input: Parameters<typeof manager.nativeClosedConfirmed>[0]) =>
        manager
          .nativeClosedConfirmed(input)
          .pipe(Effect.tap(() => Effect.sync(() => nativeCloseProcessed?.resolve()))),
    };
  }),
).pipe(Layer.provideMerge(dependencies));
const layer = ServerBrowser.layer.pipe(Layer.provideMerge(observedManager));
const ready = Effect.gen(function* () {
  const browser = yield* ServerBrowser.ServerBrowser;
  const broker = yield* Broker.PreviewAutomationBroker;
  yield* Effect.yieldNow;
  const opened = yield* broker.invoke<PreviewAutomationStatus>({
    scope,
    operation: "open",
    input: { reuseExistingTab: false, show: false },
  });
  const tabId = PreviewTabId.make(opened.tabId!);
  return { browser, broker, tabId };
});
/** Fills a viewer's output the way a viewer that stopped reading leaves it. */
const stallViewer = (
  viewer: ServerBrowser.ServerBrowserViewer,
  item: ServerBrowser.ServerBrowserViewerOutput,
) => {
  // The service hands out the read side of a queue it also writes to.
  const output = viewer.output as unknown as Queue.Queue<ServerBrowser.ServerBrowserViewerOutput>;
  while (Queue.offerUnsafe(output, item));
};
const viewerInput = (tabId: string, canOperate: boolean) => ({
  threadId: scope.thread.threadId,
  tabId,
  canOperate,
  maxWidth: 1280,
  maxHeight: 800,
  quality: 70,
});

beforeEach(() => {
  surfaceCalls.length = 0;
  surfaceFailure = null;
  remoteUrlGate = null;
  remoteUrlEntered = null;
  encoderAcquireGate = null;
  encoderSetupGate = null;
  recordingCdpGate = null;
  recordingStageEntered = null;
  encoderPages.length = 0;
  contexts.length = 0;
  contextRequests.length = 0;
  contextGate = null;
  contextFailure = null;
  desktopTabs.clear();
  presentedDesktopTabs.clear();
  nativeRenderingGate = null;
  nativeRenderingEntered = null;
  nativePresentationProcessed = null;
  desktopRendersNext = false;
  localDesktopAvailable = false;
  profileCatalogue = null;
  profileCatalogueUnavailable = false;
  profileRequests.length = 0;
  profileCatalogues.clear();
  remoteUrlAvailable = true;
  releasedDesktopTabs.length = 0;
  desktopConnections.length = 0;
  desktopPageSetup = null;
  popupBindings.length = 0;
  popupClosures.length = 0;
  rootCreations.length = 0;
  rootClosures.length = 0;
  rootAcceptances.length = 0;
  rootPublications.length = 0;
  rootAcceptanceGate = null;
  rootAcceptanceEntered = null;
  rootAcceptanceFailure = null;
  rootCloseFailure = null;
  rootCloseAttempted = null;
  releasedDesktopSeen = null;
  nativePopupCreatedSeen = null;
  nativePopupClosedSeen = null;
  nativePopupCloseAttempted = null;
  desktopPopupHostConnected = true;
  nativePopupCloseFailure = null;
  nativeCloseChannel = null;
  nativeCloseRejected = null;
  nativePopupPresence.clear();
  nativePopupProbeUnavailable = false;
  nativePopupProbeEntered = null;
  nativePopupProbeGate = null;
  nativePopupProbeProcessed = null;
  nativePopupProbes.length = 0;
  nativeCloseProcessed = null;
  nativeNavigationReported = null;
});

it.live("readiness none responds immediately but takeover input waits for navigation commit", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, broker, tabId } = yield* ready;
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      const committed = Promise.withResolvers<void>();
      const events: string[] = [];
      contexts[0]!.page.goto.mockImplementationOnce(async () => {
        await committed.promise;
        events.push("navigation committed");
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => committed.resolve()));
      const response = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId,
        operation: "navigate",
        input: { url: "http://localhost:5173/next", readiness: "none" },
      });
      expect(response.available).toBe(true);
      expect(events).toEqual([]);
      yield* Queue.clear(viewer.output);
      const takeover = yield* viewer.input({ type: "takeControl" }).pipe(Effect.forkScoped);
      let control = yield* Queue.take(viewer.output);
      while (control._tag !== "control" || control.controller !== "you") {
        control = yield* Queue.take(viewer.output);
      }
      const cdp = contexts[0]!.sessions.at(-1)!;
      const send = cdp.send.getMockImplementation()!;
      cdp.send.mockImplementation(async (operation, input) => {
        if (operation === "Input.insertText") events.push("human typed");
        return send(operation, input);
      });
      const typing = yield* viewer.input({ type: "text", text: "hello" }).pipe(Effect.forkScoped);
      yield* broker.invoke({ scope, tabId, operation: "status", input: {} });
      expect(events).toEqual([]);
      committed.resolve();
      yield* Fiber.join(takeover);
      yield* Fiber.join(typing);
      expect(events).toEqual(["navigation committed", "human typed"]);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live.each([
  { method: "goto" as const, message: { type: "navigate", url: "http://localhost:5173/next" } },
  { method: "goBack" as const, message: { type: "history", delta: -1 } },
  { method: "goForward" as const, message: { type: "history", delta: 1 } },
  { method: "reload" as const, message: { type: "reload" } },
])("release waits for viewer $method to commit before agent actions", ({ method, message }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, broker, tabId } = yield* ready;
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* viewer.input({ type: "takeControl" });
      yield* Queue.clear(viewer.output);
      yield* viewer.input({ type: "key", action: "down", key: "Shift", code: "ShiftLeft" });
      yield* viewer.input({ type: "mouse", action: "down", button: "left", x: 10, y: 20 });
      const started = Promise.withResolvers<void>();
      const committed = Promise.withResolvers<void>();
      const events: string[] = [];
      contexts[0]!.page[method].mockImplementationOnce(async () => {
        started.resolve();
        await committed.promise;
        events.push("navigation committed");
      });
      const navigate = yield* viewer.input(message).pipe(Effect.forkScoped);
      yield* Effect.addFinalizer(() => Effect.sync(() => committed.resolve()));
      yield* Effect.promise(() => started.promise);
      const releasing = yield* viewer.input({ type: "releaseControl" }).pipe(Effect.forkScoped);
      let control = yield* Queue.take(viewer.output);
      while (control._tag !== "control" || control.controller !== "agent") {
        control = yield* Queue.take(viewer.output);
      }
      const cdp = contexts[0]!.sessions[0]!;
      const send = cdp.send.getMockImplementation()!;
      cdp.send.mockImplementation(async (operation, input) => {
        if (operation === "Runtime.evaluate") events.push("agent acted");
        return send(operation, input);
      });
      const resumed = yield* broker
        .invoke({
          scope,
          tabId,
          operation: "evaluate",
          input: { expression: "resumed()" },
        })
        .pipe(Effect.forkScoped);
      yield* broker.invoke({ scope, tabId, operation: "status", input: {} });
      expect(events).toEqual([]);
      committed.resolve();
      yield* Fiber.join(navigate);
      yield* Fiber.join(releasing);
      yield* Fiber.join(resumed);
      expect(events).toEqual(["navigation committed", "agent acted"]);
      const inputSession = contexts[0]!.sessions.at(-1)!;
      expect(inputSession.send).toHaveBeenCalledWith("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Shift",
        code: "ShiftLeft",
      });
      expect(inputSession.send).toHaveBeenCalledWith("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        button: "left",
        x: 10,
        y: 20,
        buttons: 0,
        clickCount: 1,
      });
      const calls = contexts[0]!.page[method].mock.calls;
      expect(calls[0]?.at(-1)).toMatchObject({ waitUntil: "commit", timeout: 15_000 });
    }),
  ).pipe(Effect.provide(layer)),
);

it.live.each(
  [false, true].flatMap((native) =>
    [
      { method: "goto" as const, message: { type: "navigate", url: "http://10.255.255.1/" } },
      { method: "goBack" as const, message: { type: "history", delta: -1 } },
      { method: "goForward" as const, message: { type: "history", delta: 1 } },
      { method: "reload" as const, message: { type: "reload" } },
    ].map((navigation) => ({ ...navigation, native })),
  ),
)(
  "a viewer $method that never commits does not hold back the viewer's next input (native: $native)",
  ({ method, message, native }) =>
    Effect.scoped(
      Effect.gen(function* () {
        desktopRendersNext = native;
        const { browser, tabId } = yield* ready;
        const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
        yield* viewer.input({ type: "takeControl" });
        const context = native ? desktopConnections[0]!.context : contexts[0]!;
        const hung = Promise.withResolvers<void>();
        context.page[method].mockImplementationOnce(() => hung.promise);
        yield* Effect.addFinalizer(() => Effect.sync(() => hung.resolve()));
        yield* viewer.input(message);
        yield* viewer.input({ type: "navigate", url: "http://localhost:5173/fixed" });
        yield* viewer.input({ type: "text", text: "hello" });
        expect(context.page.goto).toHaveBeenLastCalledWith(
          "http://localhost:5173/fixed",
          expect.objectContaining({ waitUntil: "commit" }),
        );
        expect(context.sessions.at(-1)!.send).toHaveBeenCalledWith("Input.insertText", {
          text: "hello",
        });
        if (native) {
          // Viewer navigation keeps the existing native lease until the viewer disconnects.
          expect(surfaceCalls.map((call) => call.action)).toEqual([
            "acquire",
            "release",
            "acquire",
          ]);
          expect(releasedDesktopTabs).toEqual([]);
        }
      }),
    ).pipe(Effect.provide(layer)),
);

it.live("enforces provider ownership and explicit targets when a session has multiple tabs", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const foreign = yield* broker
        .invoke<void>({
          scope: asSession("agent-b"),
          tabId,
          operation: "navigate",
          input: { url: "http://localhost:5173/foreign" },
        })
        .pipe(Effect.flip);
      expect(foreign).toMatchObject({
        _tag: "PreviewAutomationControlInterruptedError",
        reason: "agentMismatch",
      });
      expect(contexts[0]!.page.goto).not.toHaveBeenCalledWith(
        "http://localhost:5173/foreign",
        expect.anything(),
      );
      // Another session may still read the tab, but not run page script in it.
      yield* broker.invoke<PreviewAutomationSnapshot>({
        scope: asSession("agent-b"),
        tabId,
        operation: "snapshot",
        input: {},
      });
      const foreignEvaluate = yield* broker
        .invoke<void>({
          scope: asSession("agent-b"),
          tabId,
          operation: "evaluate",
          input: { expression: "read()" },
        })
        .pipe(Effect.flip);
      expect(foreignEvaluate).toMatchObject({
        _tag: "PreviewAutomationControlInterruptedError",
        reason: "agentMismatch",
      });
      yield* broker.invoke({
        scope,
        operation: "open",
        input: { reuseExistingTab: false, show: false },
      });
      const ambiguous = yield* broker
        .invoke<void>({ scope, operation: "evaluate", input: { expression: "ambiguous()" } })
        .pipe(Effect.flip);
      expect(ambiguous).toMatchObject({
        _tag: "PreviewAutomationControlInterruptedError",
        reason: "tabRequired",
      });
      const ambiguousStop = yield* broker
        .invoke<void>({ scope, operation: "recordingStop", input: {} })
        .pipe(Effect.flip);
      expect(ambiguousStop).toMatchObject({
        _tag: "PreviewAutomationControlInterruptedError",
        reason: "tabRequired",
      });
      const explicitStop = yield* broker
        .invoke<void>({ scope, tabId, operation: "recordingStop", input: {} })
        .pipe(Effect.flip);
      expect(explicitStop).toMatchObject({
        _tag: "PreviewAutomationExecutionError",
        cause: { _tag: "PreviewAutomationRecordingNotActiveError" },
      });
      const result = yield* broker.invoke({
        scope,
        tabId,
        operation: "evaluate",
        input: { expression: "owned()" },
      });
      expect(result).toBe("evaluated");
      expect(contexts).toHaveLength(2);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("streams to a read-only viewer without allowing takeover, input, or viewport changes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, tabId } = yield* ready;
      const viewer = yield* browser.attachViewer(viewerInput(tabId, false));
      const page = contexts[0]!.page;
      page.setViewportSize.mockClear();
      const session = contexts[0]!.sessions.at(-1)!;
      session.send.mockClear();
      for (const message of [
        { type: "takeControl" },
        { type: "key", action: "down", key: "a", text: "a" },
        { type: "resize", width: 390, height: 844 },
        { type: "viewport", setting: { _tag: "freeform", width: 390, height: 844 } },
      ])
        yield* viewer.input(message);
      expect(page.setViewportSize).not.toHaveBeenCalled();
      expect(session.send.mock.calls.some(([method]) => method.startsWith("Input."))).toBe(false);
      const outputs = yield* Queue.takeAll(viewer.output);
      expect(outputs).toContainEqual(
        expect.objectContaining({ _tag: "frame", data: Buffer.from("frame") }),
      );
      expect(outputs).toContainEqual(expect.objectContaining({ _tag: "viewport" }));
      expect(outputs).toContainEqual(
        expect.objectContaining({ _tag: "control", canOperate: false, controller: "agent" }),
      );
      const operator = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* operator.input({ type: "takeControl" });
      yield* operator.input({ type: "text", text: "typed" });
      yield* operator.input({ type: "resize", width: 390, height: 844 });
      expect(contexts[0]!.sessions.at(-1)!.send).toHaveBeenCalledWith("Input.insertText", {
        text: "typed",
      });
      expect(page.setViewportSize).toHaveBeenCalledWith({ width: 390, height: 844 });
      yield* operator.input({ type: "releaseControl" });
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("applies any client's viewport, appearance, and zoom to a headless tab", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { tabId } = yield* ready;
      const manager = yield* Manager.PreviewManager;
      const page = contexts[0]!.page;
      const session = contexts[0]!.sessions[0]!;
      const target = { threadId: scope.thread.threadId, tabId };
      // The agent owns this tab, and the client sends no takeover first.
      yield* manager.resize({ ...target, viewport: { _tag: "freeform", width: 390, height: 844 } });
      yield* manager.adjust({ ...target, colorScheme: "dark", zoomFactor: 1.25 });
      // Settings apply in order, so the reload landing means the earlier ones did too.
      const reloaded = Promise.withResolvers<void>();
      const send = session.send.getMockImplementation()!;
      session.send.mockImplementation(async (method, input) => {
        if (method === "Page.reload") reloaded.resolve();
        return send(method, input);
      });
      yield* manager.adjust({ ...target, hardReload: true });
      yield* Effect.promise(() => reloaded.promise);
      expect(session.send).toHaveBeenCalledWith("Page.reload", { ignoreCache: true });
      expect(page.setViewportSize).toHaveBeenCalledWith({ width: 390, height: 844 });
      expect(page.emulateMedia).toHaveBeenCalledWith({ colorScheme: "dark" });
      // Zoom lays the page out in fewer CSS pixels and draws each one larger.
      expect(session.send).toHaveBeenCalledWith("Emulation.setDeviceMetricsOverride", {
        width: 312,
        height: 675,
        deviceScaleFactor: 2.5,
        mobile: false,
      });
    }),
  ).pipe(Effect.provide(layer)),
);

it.live(
  "takeover waits for the running agent and revokes snapshot refs before returning control",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { browser, broker, tabId } = yield* ready;
        const snapshot = yield* broker.invoke<PreviewAutomationSnapshot>({
          scope,
          tabId,
          operation: "snapshot",
          input: {},
        });
        const ref = /\[ref=([^\]]+)\]/.exec(String(snapshot.accessibilityTree))![1]!;
        const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
        const started = Promise.withResolvers<void>();
        const finish = Promise.withResolvers<Record<string, unknown>>();
        const session = contexts[0]!.sessions[0]!;
        session.send.mockImplementationOnce(async () => {
          started.resolve();
          return finish.promise;
        });
        const running = yield* broker
          .invoke({ scope, tabId, operation: "evaluate", input: { expression: "pending()" } })
          .pipe(Effect.forkScoped);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => finish.resolve({ result: { value: "finished" } })),
        );
        yield* Effect.promise(() => started.promise);
        const takeover = yield* viewer.input({ type: "takeControl" }).pipe(Effect.forkScoped);
        let control = yield* Queue.take(viewer.output);
        while (control._tag !== "control" || control.controller !== "you") {
          control = yield* Queue.take(viewer.output);
        }
        const rejected = yield* broker
          .invoke<void>({ scope, tabId, operation: "evaluate", input: { expression: "racing()" } })
          .pipe(Effect.flip);
        expect(rejected).toMatchObject({
          _tag: "PreviewAutomationControlInterruptedError",
          reason: "humanControl",
        });
        finish.resolve({ result: { value: "finished" } });
        expect(yield* Fiber.join(running)).toBe("finished");
        yield* Fiber.join(takeover);
        yield* viewer.input({ type: "releaseControl" });
        const stale = yield* broker
          .invoke<void>({ scope, tabId, operation: "click", input: { locator: `aria-ref=${ref}` } })
          .pipe(Effect.flip);
        expect(stale._tag).toBe("PreviewAutomationInvalidSelectorError");
        expect(contexts[0]!.page.locator).not.toHaveBeenCalled();
        expect(
          yield* broker.invoke({
            scope,
            tabId,
            operation: "evaluate",
            input: { expression: "resumed()" },
          }),
        ).toBe("evaluated");
      }),
    ).pipe(Effect.provide(layer)),
);

it.live("reports a pending dialog without evaluating the page and resolves it explicitly", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const page = contexts[0]!.page;
      yield* broker.invoke({
        scope,
        tabId,
        operation: "navigate",
        input: { url: "http://localhost:5173" },
      });
      const started = Promise.withResolvers<void>();
      const resolvedEvaluation = Promise.withResolvers<Record<string, unknown>>();
      const session = contexts[0]!.sessions[0]!;
      const send = session.send.getMockImplementation()!;
      session.send.mockImplementation(async (method, input) => {
        if (method !== "Runtime.evaluate") return send(method, input);
        started.resolve();
        return resolvedEvaluation.promise;
      });
      const blockedAction = yield* broker
        .invoke({
          scope,
          tabId,
          operation: "evaluate",
          input: { expression: 'confirm("Delete row?")' },
        })
        .pipe(Effect.forkScoped);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => resolvedEvaluation.resolve({ result: { value: true } })),
      );
      yield* Effect.promise(() => started.promise);
      const dialog = {
        type: () => "confirm",
        message: () => "Delete row?",
        defaultValue: () => "",
        accept: vi.fn(async () => {
          resolvedEvaluation.resolve({ result: { value: true } });
        }),
        dismiss: vi.fn(async () => {}),
      };
      page.emit("dialog", dialog);
      page.title.mockClear();
      const status = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId,
        operation: "status",
        input: {},
      });
      expect(status.dialog).toMatchObject({ type: "confirm", message: "Delete row?" });
      expect(page.title).not.toHaveBeenCalled();
      expect(dialog.dismiss).not.toHaveBeenCalled();
      const reuse = yield* broker
        .invoke<void>({
          scope,
          tabId,
          operation: "open",
          input: { url: "http://localhost:5173/other" },
        })
        .pipe(Effect.flip);
      expect(reuse).toMatchObject({
        _tag: "PreviewAutomationControlInterruptedError",
        reason: "dialogPending",
      });
      expect(page.goto).toHaveBeenCalledTimes(1);
      yield* broker.invoke({ scope, tabId, operation: "dialog", input: { accept: true } });
      expect(yield* Fiber.join(blockedAction)).toBe(true);
      expect(dialog.accept).toHaveBeenCalledTimes(1);
      const resolved = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId,
        operation: "status",
        input: {},
      });
      expect(resolved.dialog).toBeNull();
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("the owner can close a tab while an agent action waits on its dialog", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const page = contexts[0]!.page;
      const started = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<Record<string, unknown>>();
      contexts[0]!.sessions[0]!.send.mockImplementationOnce(async () => {
        started.resolve();
        return finish.promise;
      });
      page.on("close", () => finish.resolve({ result: { value: "closed" } }));
      const running = yield* broker
        .invoke({
          scope,
          tabId,
          operation: "evaluate",
          input: { expression: 'confirm("Delete?")' },
        })
        .pipe(Effect.forkScoped);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => finish.resolve({ result: { value: "cleanup" } })),
      );
      yield* Effect.promise(() => started.promise);
      page.emit("dialog", {
        type: () => "confirm",
        message: () => "Delete?",
        defaultValue: () => "",
        accept: vi.fn(),
        dismiss: vi.fn(),
      });
      const foreign = yield* broker
        .invoke<void>({
          scope: asSession("agent-b"),
          tabId,
          operation: "close",
          input: {},
        })
        .pipe(Effect.flip);
      expect(foreign).toMatchObject({
        _tag: "PreviewAutomationControlInterruptedError",
        reason: "agentMismatch",
      });
      expect(page.close).not.toHaveBeenCalled();
      yield* broker.invoke({ scope, tabId, operation: "close", input: {} });
      expect(yield* Fiber.join(running)).toBe("closed");
      expect(page.close).toHaveBeenCalled();
      const manager = yield* Manager.PreviewManager;
      expect((yield* manager.list({ threadId: scope.thread.threadId })).sessions).toHaveLength(0);
      const afterClose = yield* broker
        .invoke<void>({ scope, tabId, operation: "evaluate", input: { expression: "late()" } })
        .pipe(Effect.flip);
      expect(afterClose._tag).toBe("PreviewAutomationTabNotFoundError");
    }),
  ).pipe(Effect.provide(layer)),
);

it.live.each([false, true])(
  "a popup keeps its agent, profile, and opener page (native: %s)",
  (native) =>
    Effect.scoped(
      Effect.gen(function* () {
        if (native) {
          profileCatalogue = {
            desktopHostId: "local",
            profiles: [
              { id: "work", name: "Work", kind: "persistent" },
              { id: "personal", name: "Personal", kind: "persistent" },
            ],
            defaultProfileId: "work",
          };
          desktopRendersNext = true;
        }
        const { broker, tabId } = yield* ready;
        const opener = native ? desktopConnections[0]!.context.page : contexts[0]!.page;
        const popup = makeContext();
        const manager = yield* Manager.PreviewManager;
        const events = yield* manager.subscribeEvents;
        const popupSource = {
          threadId: scope.thread.threadId,
          tabId,
          desktopHostId: "local",
          popupId: "popup-native",
          url: "https://signin.example.test/",
        };
        if (native) desktopPopupEvents.emit("created", popupSource);
        else opener.emit("popup", popup.page);
        const openedEvent = Option.getOrThrow(
          yield* Stream.fromSubscription(events).pipe(
            Stream.filter((event) => event.type === "opened" && event.tabId !== tabId),
            Stream.runHead,
          ),
        );
        const sessions = (yield* manager.list({ threadId: scope.thread.threadId })).sessions;
        if (openedEvent.type !== "opened") throw new Error("Expected popup opening");
        const popupTab = openedEvent.snapshot;
        expect(popupTab).toMatchObject({
          automationOwner: sessions.find((session) => session.tabId === tabId)!.automationOwner,
          reveal: false,
          backingPage: native ? "desktop-popup" : "server",
          ...(native ? { profileId: "work", desktopHostId: "local" } : {}),
        });
        expect(
          yield* broker.invoke({
            scope,
            tabId: popupTab.tabId,
            operation: "evaluate",
            input: { expression: "window.opener !== null" },
          }),
        ).toBe("evaluated");
        const actualPopup = native ? desktopConnections[1]!.context : popup;
        expect(actualPopup.sessions[0]!.send).toHaveBeenCalledWith(
          "Runtime.evaluate",
          expect.objectContaining({ expression: "window.opener !== null" }),
        );
        const foreign = yield* broker
          .invoke<void>({
            scope: asSession("agent-b"),
            tabId: popupTab.tabId,
            operation: "evaluate",
            input: { expression: "foreign()" },
          })
          .pipe(Effect.flip);
        expect(foreign).toMatchObject({
          _tag: "PreviewAutomationControlInterruptedError",
          reason: "agentMismatch",
        });
        expect(contexts).toHaveLength(native ? 0 : 1);
        expect(desktopConnections).toHaveLength(native ? 2 : 0);
        if (native) {
          expect(popupBindings).toEqual([
            {
              threadId: scope.thread.threadId,
              tabId: popupTab.tabId,
              desktopHostId: "local",
              popupId: "popup-native",
              openerTabId: tabId,
            },
          ]);
          expect(popupTab.desktopPopupId).toBe("popup-native");
          presentedDesktopTabs.add(popupTab.tabId);
          const shown = yield* broker.invoke<PreviewAutomationStatus>({
            scope,
            tabId: popupTab.tabId,
            operation: "status",
            input: {},
          });
          expect(shown).toMatchObject({ visible: true, nativePresented: true, streamViewers: 0 });
          presentedDesktopTabs.delete(popupTab.tabId);
          const hidden = yield* broker.invoke<PreviewAutomationStatus>({
            scope,
            tabId: popupTab.tabId,
            operation: "status",
            input: {},
          });
          expect(hidden).toMatchObject({ visible: false, nativePresented: false });
          const viewer = yield* (yield* ServerBrowser.ServerBrowser).attachViewer(
            viewerInput(popupTab.tabId, false),
          );
          desktopDetaches.emit("detach", {
            threadId: scope.thread.threadId,
            tabId: popupTab.tabId,
          });
          let ending = yield* Queue.take(viewer.output);
          while (ending._tag !== "reconnect") ending = yield* Queue.take(viewer.output);
          presentedDesktopTabs.add(popupTab.tabId);
          yield* (yield* ServerBrowser.ServerBrowser).attachViewer(
            viewerInput(popupTab.tabId, false),
          );
          const reconnected = yield* broker.invoke<PreviewAutomationStatus>({
            scope,
            tabId: popupTab.tabId,
            operation: "status",
            input: {},
          });
          expect(reconnected.nativePresented).toBe(true);
          expect(popupBindings).toHaveLength(1);
          expect(desktopConnections).toHaveLength(3);
          // A repeated announcement must not create a second server tab or root relay.
          desktopPopupEvents.emit("created", popupSource);
        }
        const status = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          tabId,
          operation: "status",
          input: {},
        });
        expect(status.tabs).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ tabId }),
            expect.objectContaining({ tabId: popupTab.tabId, openerTabId: tabId }),
          ]),
        );
        expect(opener.goto).not.toHaveBeenCalled();
        expect(opener.close).not.toHaveBeenCalled();
        expect(actualPopup.page.goto).not.toHaveBeenCalled();
        // The page the popup script holds is the tab, so closing it ends the tab.
        const closing = yield* manager.subscribeEvents;
        if (native) desktopPopupEvents.emit("closed", popupSource);
        else yield* Effect.promise(() => popup.page.close());
        yield* Stream.fromSubscription(closing).pipe(
          Stream.filter((event) => event.type === "closed" && event.tabId === popupTab.tabId),
          Stream.runHead,
        );
        const afterPopupClose = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          tabId,
          operation: "status",
          input: {},
        });
        expect(afterPopupClose.tabs).toEqual([expect.objectContaining({ tabId })]);
        expect((yield* manager.list({ threadId: scope.thread.threadId })).sessions).toHaveLength(1);
        expect(opener.close).not.toHaveBeenCalled();
        if (native) expect(popupClosures).toEqual([]);
      }),
    ).pipe(Effect.provide(layer)),
);

it.live("an unbound native popup reconnects its retained opener without a pending tab", () =>
  Effect.scoped(
    Effect.gen(function* () {
      profileCatalogue = {
        desktopHostId: "host-a",
        profiles: [{ id: "work", name: "Work", kind: "persistent" }],
        defaultProfileId: "work",
      };
      desktopRendersNext = true;
      const { browser, broker, tabId } = yield* ready;
      const viewer = yield* browser.attachViewer(viewerInput(tabId, false));
      desktopDetaches.emit("detach", {
        threadId: scope.thread.threadId,
        tabId,
        desktopHostId: "host-a",
      });
      let ending = yield* Queue.take(viewer.output);
      while (ending._tag !== "reconnect") ending = yield* Queue.take(viewer.output);
      const manager = yield* Manager.PreviewManager;
      const events = yield* manager.subscribeEvents;
      desktopPopupEvents.emit("created", {
        threadId: scope.thread.threadId,
        tabId,
        desktopHostId: "host-a",
        popupId: "unbound-after-disconnect",
        url: "https://signin.example.test/",
      });
      const event = Option.getOrThrow(
        yield* Stream.fromSubscription(events).pipe(
          Stream.filter((event) => event.type === "opened" && event.tabId !== tabId),
          Stream.runHead,
        ),
      );
      if (event.type !== "opened") throw new Error("Expected native popup opening");
      expect(event.snapshot).toMatchObject({
        backingPage: "desktop-popup",
        desktopHostId: "host-a",
        profileId: "work",
        automationOwner: `${scope.environmentId}\u0000agent-a`,
      });
      yield* broker.invoke({
        scope,
        tabId: event.tabId,
        operation: "evaluate",
        input: { expression: "window.opener !== null" },
      });
      expect(desktopConnections).toHaveLength(3);
      expect(contexts).toEqual([]);
      expect(popupClosures).toEqual([]);
      expect(popupBindings).toEqual([
        expect.objectContaining({ desktopHostId: "host-a", openerTabId: tabId }),
      ]);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("failed native popup closes retain their session and retry after reconnect", () =>
  Effect.scoped(
    Effect.gen(function* () {
      desktopRendersNext = true;
      const { broker, tabId } = yield* ready;
      const manager = yield* Manager.PreviewManager;
      const events = yield* manager.subscribeEvents;
      const source = {
        threadId: scope.thread.threadId,
        tabId,
        desktopHostId: "local",
        popupId: "close-after-reconnect",
        url: "https://signin.example.test/",
      };
      desktopPopupEvents.emit("created", source);
      const event = Option.getOrThrow(
        yield* Stream.fromSubscription(events).pipe(
          Stream.filter((event) => event.type === "opened" && event.tabId !== tabId),
          Stream.runHead,
        ),
      );
      if (event.type !== "opened") throw new Error("Expected native popup opening");
      yield* broker.invoke({
        scope,
        tabId: event.tabId,
        operation: "evaluate",
        input: { expression: "window.opener !== null" },
      });
      desktopPopupHostConnected = false;
      nativePopupCloseAttempted = Promise.withResolvers<void>();
      const disconnected = yield* manager
        .close({ threadId: scope.thread.threadId, tabId: event.tabId })
        .pipe(Effect.flip);
      expect(disconnected).toMatchObject({
        _tag: "PreviewNativeCloseError",
        reason: "unavailable",
      });
      yield* Effect.promise(() => nativePopupCloseAttempted!.promise);
      expect(popupClosures).toEqual([]);
      expect((yield* manager.list({ threadId: scope.thread.threadId })).sessions).toHaveLength(2);
      // The same authenticated source announces its still-living window on reconnect.
      desktopPopupHostConnected = true;
      nativePopupCloseFailure = "close-canceled";
      nativePopupCloseAttempted = Promise.withResolvers<void>();
      desktopPopupEvents.emit("created", source);
      yield* Effect.promise(() => nativePopupCloseAttempted!.promise);
      expect(popupClosures).toEqual([
        { threadId: scope.thread.threadId, tabId, popupId: source.popupId },
      ]);
      // A canceled close is reported to its caller and leaves the agent able to use the popup.
      desktopConnections[1]!.context.page.emit("dialog", {
        type: () => "beforeunload",
        message: () => "Leave this page?",
        defaultValue: () => "",
      });
      const canceled = yield* broker
        .invoke<void>({ scope, tabId: event.tabId, operation: "close", input: {} })
        .pipe(Effect.flip);
      expect(canceled._tag).toBe("PreviewAutomationExecutionError");
      const retainedStatus = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId: event.tabId,
        operation: "status",
        input: {},
      });
      expect(retainedStatus.dialog).toBeNull();
      expect((yield* manager.list({ threadId: scope.thread.threadId })).sessions).toHaveLength(2);
      expect(
        yield* broker.invoke({
          scope,
          tabId: event.tabId,
          operation: "evaluate",
          input: { expression: "stillOpen()" },
        }),
      ).toBe("evaluated");
      // The eventual actual close removes the session rather than creating another tab.
      nativePopupCloseFailure = null;
      const closing = yield* manager.subscribeEvents;
      nativeCloseProcessed = Promise.withResolvers<void>();
      nativePopupCloseAttempted = Promise.withResolvers<void>();
      yield* manager.close({ threadId: scope.thread.threadId, tabId: event.tabId });
      yield* Stream.fromSubscription(closing).pipe(
        Stream.filter((closed) => closed.type === "closed" && closed.tabId === event.tabId),
        Stream.runHead,
      );
      yield* Effect.promise(() => nativeCloseProcessed!.promise);
      expect(popupClosures).toHaveLength(3);
      expect(popupBindings).toHaveLength(1);
      expect((yield* manager.list({ threadId: scope.thread.threadId })).sessions).toHaveLength(1);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("a native veto lost offline clears pending close intent without replacing its popup", () =>
  Effect.scoped(
    Effect.gen(function* () {
      profileCatalogue = {
        desktopHostId: "host-a",
        profiles: [{ id: "work", name: "Work", kind: "persistent" }],
        defaultProfileId: "work",
      };
      desktopRendersNext = true;
      const { broker, tabId } = yield* ready;
      const manager = yield* Manager.PreviewManager;
      const events = yield* manager.subscribeEvents;
      const source = {
        threadId: scope.thread.threadId,
        tabId,
        desktopHostId: "host-a",
        popupId: "veto-offline",
        url: "https://signin.example.test/",
      };
      desktopPopupEvents.emit("created", source);
      const event = Option.getOrThrow(
        yield* Stream.fromSubscription(events).pipe(
          Stream.filter((event) => event.type === "opened" && event.tabId !== tabId),
          Stream.runHead,
        ),
      );
      if (event.type !== "opened") throw new Error("Expected native popup");
      yield* broker.invoke<void>({
        scope,
        tabId: event.tabId,
        operation: "evaluate",
        input: { expression: "popupReady()" },
      });
      const context = yield* Layer.build(
        DesktopChannel.layer.pipe(
          Layer.provide(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-native-veto-channel-" }),
          ),
        ),
      );
      const channel = Context.get(context, DesktopChannel.DesktopBrowserChannel);
      nativeCloseChannel = channel;
      const connect = (owner: string) =>
        Effect.gen(function* () {
          const commands = yield* Queue.unbounded<DesktopBrowserCommand>();
          const fiber = yield* channel.subscribeCommands(owner, "host-a").pipe(
            Stream.runForEach((command) => Queue.offer(commands, command)),
            Effect.forkScoped,
          );
          expect(yield* Queue.take(commands)).toEqual({ type: "announce" });
          return { commands, fiber };
        });
      const first = yield* connect("socket-a");
      const closing = yield* manager
        .close({ threadId: scope.thread.threadId, tabId: event.tabId })
        .pipe(Effect.flip, Effect.forkScoped);
      const original = yield* Queue.take(first.commands);
      if (original.type !== "closePopup") throw new Error("Expected native close");
      // The host vetoed the received request, but disconnected before reporting its result.
      yield* Fiber.interrupt(first.fiber);
      expect((yield* Fiber.join(closing))._tag).toBe("PreviewNativeCloseError");
      const reconnected = yield* connect("socket-b");
      nativeCloseRejected = Promise.withResolvers<void>();
      desktopPopupEvents.emit("host-connected", "host-a");
      const probe = yield* Queue.take(reconnected.commands);
      if (probe.type !== "probePopup") throw new Error("Expected native presence probe");
      yield* channel.receiveEvent("socket-b", "host-a", {
        type: "popupPresence",
        ...source,
        requestId: probe.requestId,
        present: true,
      });
      expect(yield* Queue.take(reconnected.commands)).toEqual(original);
      yield* channel.receiveEvent("socket-b", "host-a", {
        type: "popupCloseCanceled",
        ...source,
        requestId: original.requestId,
      });
      yield* Effect.promise(() => nativeCloseRejected!.promise);
      const sessions = (yield* manager.list({ threadId: scope.thread.threadId })).sessions;
      expect(sessions.find((session) => session.tabId === event.tabId)).toMatchObject({
        tabId: event.tabId,
        backingPage: "desktop-popup",
        desktopHostId: "host-a",
        profileId: "work",
        automationOwner: event.snapshot.automationOwner,
      });
      expect(
        yield* broker.invoke({
          scope,
          tabId: event.tabId,
          operation: "evaluate",
          input: { expression: "stillOpen()" },
        }),
      ).toBe("evaluated");
      // Re-announcement is processed by the popup stream; its following owned popup proves completion.
      nativePopupCloseAttempted = Promise.withResolvers<void>();
      nativePopupCreatedSeen = Promise.withResolvers<void>();
      desktopPopupEvents.emit("created", source);
      yield* Effect.promise(() => nativePopupCreatedSeen!.promise);
      desktopPopupEvents.emit("created", { ...source, popupId: "next-owned-popup" });
      yield* Stream.fromSubscription(events).pipe(
        Stream.filter(
          (opened) =>
            opened.type === "opened" && opened.tabId !== event.tabId && opened.tabId !== tabId,
        ),
        Stream.runHead,
      );
      expect(yield* Queue.size(reconnected.commands)).toBe(0);
      expect(popupBindings.filter((binding) => binding.popupId === source.popupId)).toHaveLength(1);
      const explicit = yield* manager
        .close({ threadId: scope.thread.threadId, tabId: event.tabId })
        .pipe(Effect.forkScoped);
      const fresh = yield* Queue.take(reconnected.commands);
      if (fresh.type !== "closePopup") throw new Error("Expected deliberate close");
      expect(fresh.requestId).not.toBe(original.requestId);
      yield* channel.receiveEvent("socket-b", "host-a", { type: "popupClosed", ...source });
      yield* Fiber.join(explicit);
      desktopPopupEvents.emit("closed", source);
      expect(
        (yield* manager.list({ threadId: scope.thread.threadId })).sessions.some(
          (session) => session.tabId === event.tabId,
        ),
      ).toBe(false);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live.each(["absent", "present", "unavailable"] as const)(
  "reconnect reconciles a retained unannounced popup without closing other identities (%s)",
  (presence) =>
    Effect.scoped(
      Effect.gen(function* () {
        profileCatalogue = {
          desktopHostId: "host-a",
          profiles: [{ id: "work", name: "Work", kind: "persistent" }],
          defaultProfileId: "work",
        };
        desktopRendersNext = true;
        const { broker, tabId } = yield* ready;
        const manager = yield* Manager.PreviewManager;
        const events = yield* manager.subscribeEvents;
        const source = {
          threadId: scope.thread.threadId,
          tabId,
          desktopHostId: "host-a",
          popupId: "ordinary-offline-close",
          url: "https://signin.example.test/",
        };
        desktopPopupEvents.emit("created", source);
        const opened = Option.getOrThrow(
          yield* Stream.fromSubscription(events).pipe(
            Stream.filter((event) => event.type === "opened" && event.tabId !== tabId),
            Stream.runHead,
          ),
        );
        if (opened.type !== "opened") throw new Error("Expected native popup");
        yield* broker.invoke<void>({
          scope,
          tabId: opened.tabId,
          operation: "evaluate",
          input: { expression: "ready()" },
        });
        // No close was requested. The native window may have disappeared offline without an event.
        nativePopupPresence.set(source.popupId, presence !== "absent");
        nativePopupProbeUnavailable = presence === "unavailable";
        nativePopupProbeEntered = Promise.withResolvers<void>();
        nativePopupProbeProcessed = Promise.withResolvers<void>();
        nativePopupProbeGate = Promise.withResolvers<void>();
        yield* Effect.addFinalizer(() => Effect.sync(() => nativePopupProbeGate?.resolve()));
        desktopPopupEvents.emit("host-connected", "other-host");
        desktopPopupEvents.emit("host-connected", "host-a");
        yield* Effect.promise(() => nativePopupProbeEntered!.promise);
        expect(nativePopupProbes).toEqual([
          expect.objectContaining({
            threadId: source.threadId,
            tabId: source.tabId,
            desktopHostId: source.desktopHostId,
            popupId: source.popupId,
          }),
        ]);
        // A distinct popup announced during this probe is outside its captured identity.
        desktopPopupEvents.emit("created", { ...source, popupId: "new-during-probe" });
        const fresh = Option.getOrThrow(
          yield* Stream.fromSubscription(events).pipe(
            Stream.filter(
              (event) =>
                event.type === "opened" && event.tabId !== tabId && event.tabId !== opened.tabId,
            ),
            Stream.runHead,
          ),
        );
        if (fresh.type !== "opened") throw new Error("Expected newly announced popup");
        yield* broker.invoke<void>({
          scope,
          tabId: fresh.tabId,
          operation: "evaluate",
          input: { expression: "ready()" },
        });
        nativeCloseProcessed = Promise.withResolvers<void>();
        nativePopupProbeGate.resolve();
        yield* Effect.promise(() =>
          presence === "absent"
            ? nativeCloseProcessed!.promise
            : nativePopupProbeProcessed!.promise,
        );
        const sessions = (yield* manager.list({ threadId: scope.thread.threadId })).sessions;
        expect(sessions.some((session) => session.tabId === opened.tabId)).toBe(
          presence !== "absent",
        );
        expect(sessions.find((session) => session.tabId === fresh.tabId)).toMatchObject({
          profileId: "work",
          automationOwner: opened.snapshot.automationOwner,
        });
        expect(popupClosures).toEqual([]);
        expect(nativePopupProbes).toHaveLength(1);
      }),
    ).pipe(Effect.provide(layer)),
);

it.live("host reconnect resolves a pending popup close without a live popup announcement", () =>
  Effect.scoped(
    Effect.gen(function* () {
      desktopRendersNext = true;
      const { broker, tabId } = yield* ready;
      const manager = yield* Manager.PreviewManager;
      const events = yield* manager.subscribeEvents;
      const source = {
        threadId: scope.thread.threadId,
        tabId,
        desktopHostId: "local",
        popupId: "gone-while-offline",
        url: "https://signin.example.test/",
      };
      desktopPopupEvents.emit("created", source);
      const event = Option.getOrThrow(
        yield* Stream.fromSubscription(events).pipe(
          Stream.filter((event) => event.type === "opened" && event.tabId !== tabId),
          Stream.runHead,
        ),
      );
      yield* broker.invoke<void>({
        scope,
        tabId: event.tabId,
        operation: "evaluate",
        input: { expression: "popupReady()" },
      });
      desktopPopupHostConnected = false;
      const unavailable = yield* manager
        .close({ threadId: scope.thread.threadId, tabId: event.tabId })
        .pipe(Effect.flip);
      expect(unavailable._tag).toBe("PreviewNativeCloseError");
      expect((yield* manager.list({ threadId: scope.thread.threadId })).sessions).toHaveLength(2);
      // The window closed offline. Reconnect sends no popupCreated or attached child.
      desktopTabs.delete(event.tabId);
      nativePopupPresence.set(source.popupId, false);
      desktopPopupHostConnected = true;
      nativeCloseProcessed = Promise.withResolvers<void>();
      desktopPopupEvents.emit("host-connected", "local");
      yield* Effect.promise(() => nativeCloseProcessed!.promise);
      expect((yield* manager.list({ threadId: scope.thread.threadId })).sessions).toHaveLength(1);
      expect(popupBindings).toHaveLength(1);
      expect(popupClosures).toEqual([]);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("a native popup loaded before attachment publishes its current navigation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      desktopRendersNext = true;
      const { tabId } = yield* ready;
      const manager = yield* Manager.PreviewManager;
      const events = yield* manager.subscribeEvents;
      const url = "https://signin.example.test/completed";
      desktopPageSetup = async (context) => {
        await context.page.goto(url);
      };
      desktopPopupEvents.emit("created", {
        threadId: scope.thread.threadId,
        tabId,
        desktopHostId: "local",
        popupId: "already-loaded",
        url,
      });
      const loaded = Option.getOrThrow(
        yield* Stream.fromSubscription(events).pipe(
          Stream.filter(
            (event) =>
              event.type === "navigated" &&
              event.tabId !== tabId &&
              event.snapshot.navStatus._tag === "Success",
          ),
          Stream.runHead,
        ),
      );
      if (loaded.type !== "navigated") throw new Error("Expected current navigation");
      expect(loaded.snapshot.navStatus).toEqual({ _tag: "Success", url, title: "test page" });
      expect(desktopConnections[1]!.context.page.goto).toHaveBeenCalledTimes(1);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live.each(["Loading", "LoadFailed"] as const)(
  "sampling an attached popup does not overwrite intervening %s navigation",
  (nextStatus) =>
    Effect.scoped(
      Effect.gen(function* () {
        desktopRendersNext = true;
        const { tabId } = yield* ready;
        const manager = yield* Manager.PreviewManager;
        const events = yield* manager.subscribeEvents;
        const titleEntered = Promise.withResolvers<void>();
        const titleRelease = Promise.withResolvers<string>();
        yield* Effect.addFinalizer(() => Effect.sync(() => titleRelease.resolve("test page")));
        const url = "https://signin.example.test/";
        desktopPageSetup = async (context) => {
          await context.page.goto(url);
          context.page.title.mockImplementation(async () => {
            titleEntered.resolve();
            return titleRelease.promise;
          });
        };
        desktopPopupEvents.emit("created", {
          threadId: scope.thread.threadId,
          tabId,
          desktopHostId: "local",
          popupId: "navigation-during-sample",
          url,
        });
        yield* Effect.promise(() => titleEntered.promise);
        const page = desktopConnections[1]!.context.page;
        nativeNavigationReported = { status: nextStatus, completed: Promise.withResolvers<void>() };
        const request = {
          isNavigationRequest: () => true,
          frame: () => page,
          url: () => url,
          method: () => "GET",
          failure: () => ({ errorText: "net::ERR_CONNECTION_REFUSED" }),
        };
        page.emit(nextStatus === "Loading" ? "request" : "requestfailed", request);
        titleRelease.resolve("stale title");
        const changed = Option.getOrThrow(
          yield* Stream.fromSubscription(events).pipe(
            Stream.filter(
              (event) =>
                event.tabId !== tabId &&
                (nextStatus === "LoadFailed"
                  ? event.type === "failed"
                  : event.type === "navigated" && event.snapshot.navStatus._tag === nextStatus),
            ),
            Stream.runHead,
          ),
        );
        yield* Effect.promise(() => nativeNavigationReported!.completed.promise);
        expect(changed.type).toBe(nextStatus === "LoadFailed" ? "failed" : "navigated");
        const session = (yield* manager.list({ threadId: scope.thread.threadId })).sessions.find(
          (session) => session.tabId !== tabId,
        );
        expect(session?.navStatus._tag).toBe(nextStatus);
        // The error page's subsequent load must keep the failed status too.
        if (nextStatus === "LoadFailed") {
          page.emit("load");
          yield* Effect.promise(() => page.title.mock.results.at(-1)!.value);
          expect(
            (yield* manager.list({ threadId: scope.thread.threadId })).sessions.find(
              (session) => session.tabId !== tabId,
            )?.navStatus._tag,
          ).toBe("LoadFailed");
        }
      }),
    ).pipe(Effect.provide(layer)),
);

it.live("a native popup closed during opener reconnect never creates a phantom tab", () =>
  Effect.scoped(
    Effect.gen(function* () {
      desktopRendersNext = true;
      const { browser, broker, tabId } = yield* ready;
      yield* broker.invoke<void>({
        scope,
        tabId,
        operation: "setColorScheme",
        input: { colorScheme: "dark" },
      });
      const viewer = yield* browser.attachViewer(viewerInput(tabId, false));
      desktopDetaches.emit("detach", { threadId: scope.thread.threadId, tabId });
      let ending = yield* Queue.take(viewer.output);
      while (ending._tag !== "reconnect") ending = yield* Queue.take(viewer.output);
      nativeRenderingGate = Promise.withResolvers<void>();
      nativeRenderingEntered = Promise.withResolvers<void>();
      yield* Effect.addFinalizer(() => Effect.sync(() => nativeRenderingGate?.resolve()));
      const connecting = yield* Effect.scoped(browser.attachViewer(viewerInput(tabId, false))).pipe(
        Effect.forkScoped,
      );
      yield* Effect.promise(() => nativeRenderingEntered!.promise);
      const source = {
        threadId: scope.thread.threadId,
        tabId,
        desktopHostId: "local",
        popupId: "closed-before-source",
        url: "https://signin.example.test/",
      };
      nativePopupCreatedSeen = Promise.withResolvers<void>();
      desktopPopupEvents.emit("created", source);
      yield* Effect.promise(() => nativePopupCreatedSeen!.promise);
      nativePopupClosedSeen = Promise.withResolvers<void>();
      desktopPopupEvents.emit("closed", source);
      yield* Effect.promise(() => nativePopupClosedSeen!.promise);
      nativeRenderingGate.resolve();
      yield* Fiber.join(connecting);
      const status = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId,
        operation: "status",
        input: {},
      });
      expect(status.tabs).toEqual([expect.objectContaining({ tabId })]);
      expect(popupBindings).toEqual([]);
      expect(popupClosures).toEqual([]);
      const manager = yield* Manager.PreviewManager;
      expect((yield* manager.list({ threadId: scope.thread.threadId })).sessions).toHaveLength(1);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("a tab opened to a file the browser cannot show reports the file to download", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* ServerBrowser.ServerBrowser;
      const manager = yield* Manager.PreviewManager;
      const events = yield* manager.subscribeEvents;
      yield* Effect.yieldNow;
      const opened = yield* manager.open({ threadId: scope.thread.threadId, runtime: "server" });
      const viewer = yield* browser.attachViewer(viewerInput(opened.tabId, true));
      const page = contexts[0]!.page;
      const pdf = "https://example.com/paper.pdf";
      const request = { url: () => pdf, method: () => "GET", isNavigationRequest: () => true };
      // What Chromium reports when a navigation turns into a download.
      page.emit("requestfailed", {
        ...request,
        frame: () => page,
        failure: () => ({ errorText: "net::ERR_ABORTED" }),
      });
      // Stands in for Chromium, which writes the file itself.
      const saved = yield* Queue.unbounded<string>();
      const written = Promise.withResolvers<void>();
      page.emit("download", {
        failure: async () => null,
        saveAs: (path: string) => {
          Queue.offerUnsafe(saved, path);
          return written.promise;
        },
        suggestedFilename: () => "paper.pdf",
        url: () => pdf,
      });
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(yield* Queue.take(saved), "%PDF");
      written.resolve();
      let status = yield* PubSub.take(events);
      while (status.type !== "failed") status = yield* PubSub.take(events);
      expect(status).toMatchObject({ url: pdf, download: { fileName: "paper.pdf" } });
      // The tab shows the file, so no separate download toast is offered.
      expect((yield* Queue.clear(viewer.output)).some((item) => item._tag === "download")).toBe(
        false,
      );
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("a file a blank tab opened is offered to download if the tab moves on while it saves", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* ServerBrowser.ServerBrowser;
      const manager = yield* Manager.PreviewManager;
      yield* Effect.yieldNow;
      const opened = yield* manager.open({ threadId: scope.thread.threadId, runtime: "server" });
      const viewer = yield* browser.attachViewer(viewerInput(opened.tabId, true));
      yield* viewer.input({ type: "takeControl" });
      const page = contexts[0]!.page;
      const pdf = "https://example.com/paper.pdf";
      const navigation = {
        url: () => pdf,
        method: () => "GET",
        isNavigationRequest: () => true,
        frame: () => page,
        failure: () => ({ errorText: "net::ERR_ABORTED" }),
      };
      page.emit("request", navigation);
      page.emit("requestfailed", navigation);
      const saved = yield* Queue.unbounded<string>();
      const written = Promise.withResolvers<void>();
      page.emit("download", {
        failure: async () => null,
        saveAs: (path: string) => {
          Queue.offerUnsafe(saved, path);
          return written.promise;
        },
        suggestedFilename: () => "paper.pdf",
        url: () => pdf,
      });
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(yield* Queue.take(saved), "%PDF");
      // The person navigates elsewhere while the file is still being written.
      page.emit("request", {
        url: () => "https://example.com/next",
        method: () => "GET",
        isNavigationRequest: () => true,
        frame: () => page,
      });
      written.resolve();
      let offered = yield* Queue.take(viewer.output);
      while (offered._tag !== "download") offered = yield* Queue.take(viewer.output);
      expect(offered).toMatchObject({ _tag: "download", fileName: "paper.pdf" });
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("a download from a superseded navigation leaves the newer navigation loading", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const page = contexts[0]!.page;
      const pdf = "https://example.com/paper.pdf";
      const navigation = {
        url: () => pdf,
        method: () => "GET",
        isNavigationRequest: () => true,
        frame: () => page,
        failure: () => ({ errorText: "net::ERR_ABORTED" }),
      };
      page.emit("request", navigation);
      page.emit("requestfailed", navigation);
      const saved = yield* Queue.unbounded<string>();
      const written = Promise.withResolvers<void>();
      page.emit("download", {
        failure: async () => null,
        saveAs: (path: string) => {
          Queue.offerUnsafe(saved, path);
          return written.promise;
        },
        suggestedFilename: () => "paper.pdf",
        url: () => pdf,
      });
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(yield* Queue.take(saved), "%PDF");
      // The person navigates elsewhere while the file is still being written.
      page.emit("request", {
        url: () => "https://example.com/next",
        method: () => "GET",
        isNavigationRequest: () => true,
        frame: () => page,
      });
      written.resolve();
      const status = () =>
        broker.invoke<PreviewAutomationStatus>({ scope, tabId, operation: "status", input: {} });
      while ((yield* status()).downloads?.length !== 1) yield* Effect.sleep("5 millis");
      expect((yield* status()).loading).toBe(true);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live(
  "a late failure from a request that predates tracking leaves a newer navigation loading",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { broker, tabId } = yield* ready;
        const page = contexts[0]!.page;
        const navigation = (url: string) => ({
          url: () => url,
          method: () => "GET",
          isNavigationRequest: () => true,
          frame: () => page,
          failure: () => ({ errorText: "net::ERR_CONNECTION_REFUSED" }),
        });
        page.emit("request", navigation("https://example.com/next"));
        // A popup's first request can start before the tab listens for requests.
        page.emit("requestfailed", navigation("https://example.com/first"));
        const status = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          tabId,
          operation: "status",
          input: {},
        });
        expect(status.loading).toBe(true);
      }),
    ).pipe(Effect.provide(layer)),
);

it.live("an aborted navigation that no download explains stops loading", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const page = contexts[0]!.page;
      const navigation = {
        url: () => "https://example.com/cancelled",
        method: () => "GET",
        isNavigationRequest: () => true,
        frame: () => page,
        failure: () => ({ errorText: "net::ERR_ABORTED" }),
      };
      const status = () =>
        broker.invoke<PreviewAutomationStatus>({ scope, tabId, operation: "status", input: {} });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        page.emit("request", navigation);
        page.emit("requestfailed", navigation);
        expect((yield* status()).loading).toBe(true);
        vi.advanceTimersByTime(5_000);
      } finally {
        vi.useRealTimers();
      }
      expect((yield* status()).loading).toBe(false);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("a popup from a person's click is shown to that person, with its opener kept", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* ServerBrowser.ServerBrowser;
      const manager = yield* Manager.PreviewManager;
      yield* Effect.yieldNow;
      const opened = yield* manager.open({ threadId: scope.thread.threadId, runtime: "server" });
      const watcher = yield* browser.attachViewer(viewerInput(opened.tabId, false));
      const viewer = yield* browser.attachViewer(viewerInput(opened.tabId, true));
      yield* viewer.input({ type: "takeControl" });
      const opener = contexts[0]!.page;
      const popup = makeContext();
      opener.emit("popup", popup.page);
      let shown = yield* Queue.take(viewer.output);
      while (shown._tag !== "popup") shown = yield* Queue.take(viewer.output);
      const sessions = (yield* manager.list({ threadId: scope.thread.threadId })).sessions;
      expect(sessions.map((session) => session.tabId)).toEqual(
        expect.arrayContaining([opened.tabId, shown.tabId]),
      );
      expect((yield* Queue.clear(watcher.output)).some((item) => item._tag === "popup")).toBe(
        false,
      );
      expect(opener.close).not.toHaveBeenCalled();
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("closing a tab while a viewer is still opening it does not leave its page behind", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* ServerBrowser.ServerBrowser;
      const manager = yield* Manager.PreviewManager;
      yield* Effect.yieldNow;
      // The background open fails, so the tab exists only as a session.
      contextFailure = new Error("first launch failed");
      const snapshot = yield* manager.open({ threadId: scope.thread.threadId, runtime: "server" });
      yield* Effect.sleep("10 millis");
      contextFailure = null;
      contextGate = Promise.withResolvers<void>();
      const attaching = yield* browser
        .attachViewer(viewerInput(snapshot.tabId, false))
        .pipe(Effect.flip, Effect.forkScoped);
      yield* Effect.sleep("10 millis");
      yield* manager.close({ threadId: scope.thread.threadId, tabId: snapshot.tabId });
      yield* Effect.sleep("10 millis");
      contextGate.resolve();
      expect((yield* Fiber.join(attaching))._tag).toBe("ServerBrowserTabNotFoundError");
      expect(contexts).toHaveLength(1);
      expect(contexts[0]!.page.close).toHaveBeenCalled();
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("page copies reach only the controlling viewer right after its input", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, tabId } = yield* ready;
      const page = contexts[0]!.page;
      const watcher = yield* browser.attachViewer(viewerInput(tabId, false));
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* viewer.input({ type: "takeControl" });
      const clipboard = (queue: typeof viewer.output) =>
        Queue.clear(queue).pipe(
          Effect.map((items) => items.filter((item) => item._tag === "clipboard")),
        );
      // A page writing on its own, without a recent gesture, stays on the server.
      clipboardBinding!({ page }, "unprompted");
      expect(yield* clipboard(viewer.output)).toEqual([]);
      yield* viewer.input({ type: "key", action: "down", key: "c", code: "KeyC", modifiers: 4 });
      const cdp = contexts[0]!.sessions.at(-1)!;
      expect(cdp.send).toHaveBeenCalledWith(
        "Input.dispatchKeyEvent",
        expect.objectContaining({ key: "c", commands: ["copy"] }),
      );
      clipboardBinding!({ page }, "copied");
      expect(yield* clipboard(viewer.output)).toEqual([{ _tag: "clipboard", text: "copied" }]);
      expect(yield* clipboard(watcher.output)).toEqual([]);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("a page download is saved, offered to the controller, and listed for the agent", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, broker, tabId } = yield* ready;
      const page = contexts[0]!.page;
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* viewer.input({ type: "takeControl" });
      yield* Queue.clear(viewer.output);
      // Stands in for Chromium, which writes the file itself.
      const saved = yield* Queue.unbounded<string>();
      const written = Promise.withResolvers<void>();
      page.emit("download", {
        failure: async () => null,
        saveAs: (path: string) => {
          Queue.offerUnsafe(saved, path);
          return written.promise;
        },
        suggestedFilename: () => "report.csv",
        url: () => "blob:http://localhost:5173/1",
      });
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Queue.take(saved);
      yield* fs.writeFileString(path, "a,b");
      written.resolve();
      let offered = yield* Queue.take(viewer.output);
      while (offered._tag !== "download") offered = yield* Queue.take(viewer.output);
      expect(offered).toMatchObject({ _tag: "download", fileName: "report.csv", sizeBytes: 3 });
      const file = yield* browser.openDownload({
        threadId: scope.thread.threadId,
        tabId,
        downloadId: offered.id,
      });
      expect(Option.isSome(file) && file.value.fileName).toBe("report.csv");
      const status = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId,
        operation: "status",
        input: {},
      });
      expect(status.downloads).toEqual([
        expect.objectContaining({ fileName: "report.csv", sizeBytes: 3 }),
      ]);
      expect(
        Option.isNone(
          yield* browser.openDownload({
            threadId: scope.thread.threadId,
            tabId,
            downloadId: "guess",
          }),
        ),
      ).toBe(true);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("a page's file picker goes to the controller and takes its uploaded files", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, tabId } = yield* ready;
      const page = contexts[0]!.page;
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* viewer.input({ type: "takeControl" });
      const setFiles = vi.fn(async (_files: unknown) => {});
      page.emit("filechooser", {
        isMultiple: () => false,
        element: () => ({ getAttribute: async () => ".csv" }),
        setFiles,
      });
      let offered = yield* Queue.take(viewer.output);
      while (offered._tag !== "fileChooser") offered = yield* Queue.take(viewer.output);
      expect(offered).toMatchObject({ multiple: false, accept: ".csv" });
      const file = (name: string) => ({ name, mimeType: "text/csv", buffer: Buffer.from(name) });
      const answer = (chooserId: string) =>
        browser.answerFileChooser({
          threadId: scope.thread.threadId,
          tabId,
          chooserId,
          files: [file("a.csv"), file("b.csv")],
        });
      expect(yield* answer("other")).toBe(false);
      expect(yield* answer(offered.id)).toBe(true);
      // A single-file input only receives the first file.
      expect(setFiles).toHaveBeenCalledExactlyOnceWith([file("a.csv")]);
      let closed = yield* Queue.take(viewer.output);
      while (closed._tag !== "fileChooserClosed") closed = yield* Queue.take(viewer.output);
      expect(closed.id).toBe(offered.id);
      expect(yield* answer(offered.id)).toBe(false);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("a file picker replaces a stalled viewer backlog instead of being dropped", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, tabId } = yield* ready;
      const page = contexts[0]!.page;
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* viewer.input({ type: "takeControl" });
      const accept = Promise.withResolvers<string>();
      page.emit("filechooser", {
        isMultiple: () => false,
        element: () => ({ getAttribute: () => accept.promise }),
        setFiles: async () => {},
      });
      // The viewer stopped reading: its output is full when the picker opens.
      yield* Queue.clear(viewer.output);
      stallViewer(viewer, { _tag: "viewport", width: 1, height: 1 });
      accept.resolve(".csv");
      // The picker is offered within the microtasks that follow its accept attribute.
      yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
      expect(yield* Queue.clear(viewer.output)).toEqual([
        expect.objectContaining({ _tag: "fileChooser", accept: ".csv" }),
      ]);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("control updates replace a stalled viewer backlog in the order they happen", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, tabId } = yield* ready;
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* Queue.clear(viewer.output);
      // Chromium is slow to take back the frames the replacement drops.
      const acked = Promise.withResolvers<void>();
      yield* Effect.addFinalizer(() => Effect.sync(() => acked.resolve()));
      stallViewer(viewer, {
        _tag: "frame",
        data: Buffer.alloc(0),
        ack: Effect.promise(() => acked.promise),
      });
      yield* viewer.input({ type: "takeControl" });
      yield* viewer.input({ type: "releaseControl" });
      const controls = (yield* Queue.clear(viewer.output)).flatMap((item) =>
        item._tag === "control" ? [item.controller] : [],
      );
      expect(controls[0]).toBe("you");
      expect(controls.at(-1)).not.toBe("you");
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("a native idle-close veto resets the deadline without blocking deliberate closure", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const initial = 1_000_000;
      const clock = vi.spyOn(Date, "now").mockReturnValue(initial);
      yield* Effect.addFinalizer(() => Effect.sync(() => clock.mockRestore()));
      desktopRendersNext = true;
      const { browser, broker, tabId } = yield* ready;
      // Watching the opener leaves just the popup eligible for idle closure.
      yield* browser.attachViewer(viewerInput(tabId, false));
      const manager = yield* Manager.PreviewManager;
      const events = yield* manager.subscribeEvents;
      const source = {
        threadId: scope.thread.threadId,
        tabId,
        desktopHostId: "local",
        popupId: "idle-veto",
        url: "https://signin.example.test/",
      };
      desktopPopupEvents.emit("created", source);
      const popup = Option.getOrThrow(
        yield* Stream.fromSubscription(events).pipe(
          Stream.filter((event) => event.type === "opened" && event.tabId !== tabId),
          Stream.runHead,
        ),
      );
      yield* broker.invoke<void>({
        scope,
        tabId: popup.tabId,
        operation: "evaluate",
        input: { expression: "ready()" },
      });
      nativePopupCloseFailure = "close-canceled";
      nativeCloseRejected = Promise.withResolvers<void>();
      const expired = initial + 31 * 60_000;
      clock.mockReturnValue(expired);
      yield* TestClock.adjust("1 minute");
      yield* Effect.promise(() => nativeCloseRejected!.promise);
      expect(popupClosures).toHaveLength(1);
      for (let minute = 1; minute <= 3; minute += 1) {
        clock.mockReturnValue(expired + minute * 60_000);
        yield* TestClock.adjust("1 minute");
      }
      expect(popupClosures).toHaveLength(1);
      expect(
        yield* broker.invoke({
          scope,
          tabId: popup.tabId,
          operation: "evaluate",
          input: { expression: "stillOpen()" },
        }),
      ).toBe("evaluated");
      nativePopupCloseFailure = null;
      yield* broker.invoke<void>({ scope, tabId: popup.tabId, operation: "close", input: {} });
      expect(popupClosures).toHaveLength(2);
      expect(
        (yield* manager.list({ threadId: scope.thread.threadId })).sessions.some(
          (session) => session.tabId === popup.tabId,
        ),
      ).toBe(false);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("an agent's tabs stop at the limit until an unwatched idle tab closes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const open = broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "open",
        input: { reuseExistingTab: false, show: false },
      });
      for (let count = 1; count < 8; count += 1) yield* open;
      expect(yield* Effect.flip(open)).toMatchObject({
        _tag: "PreviewAutomationControlInterruptedError",
        reason: "tabLimit",
      });
      // Another agent session keeps its own budget.
      yield* broker.invoke({
        scope: asSession("agent-b"),
        operation: "open",
        input: { reuseExistingTab: false, show: false },
      });
      const later = (yield* Clock.currentTimeMillis) + 31 * 60 * 1000;
      const clock = vi.spyOn(Date, "now").mockReturnValue(later);
      yield* Effect.addFinalizer(() => Effect.sync(() => clock.mockRestore()));
      // The first tab is watched, so it stays open while the agent's other idle tabs close.
      const browser = yield* ServerBrowser.ServerBrowser;
      yield* browser.attachViewer(viewerInput(tabId, false));
      const reopened = yield* open;
      const manager = yield* Manager.PreviewManager;
      const { sessions } = yield* manager.list({ threadId: scope.thread.threadId });
      expect(sessions.map((session) => session.tabId).toSorted()).toEqual(
        [tabId, reopened.tabId].toSorted(),
      );
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("an agent answers the page's file picker or sets files on a file input", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const page = contexts[0]!.page;
      const upload = (input: Record<string, unknown>) =>
        broker.invoke<void>({ scope, tabId, operation: "upload", input });
      expect(yield* Effect.flip(upload({ paths: ["/tmp/a.csv"] }))).toMatchObject({
        _tag: "PreviewAutomationExecutionError",
      });
      const setFiles = vi.fn(async (_files: unknown) => {});
      page.emit("filechooser", {
        isMultiple: () => false,
        element: () => ({ getAttribute: async () => ".csv" }),
        setFiles,
      });
      const status = broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId,
        operation: "status",
        input: {},
      });
      let opened = yield* status;
      while (!opened.fileChooser) {
        yield* Effect.sleep("5 millis");
        opened = yield* status;
      }
      expect(opened.fileChooser).toEqual({ multiple: false, accept: ".csv" });
      // A single-file picker rejects several files instead of dropping some.
      yield* Effect.flip(upload({ paths: ["/tmp/a.csv", "/tmp/b.csv"] }));
      yield* upload({ paths: ["/tmp/a.csv"] });
      expect(setFiles).toHaveBeenCalledExactlyOnceWith(["/tmp/a.csv"], expect.anything());
      expect((yield* status).fileChooser).toBeNull();

      const setInputFiles = vi.fn(async () => {});
      page.locator.mockReturnValue({ setInputFiles } as never);
      yield* upload({ paths: ["/tmp/b.csv"], locator: "input[type=file]" });
      expect(page.locator).toHaveBeenLastCalledWith("input[type=file]");
      expect(setInputFiles).toHaveBeenCalledWith(["/tmp/b.csv"], expect.anything());
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("viewers see the agent's pointer move to its target and click there", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, broker, tabId } = yield* ready;
      const page = contexts[0]!.page;
      const viewer = yield* browser.attachViewer(viewerInput(tabId, false));
      const click = vi.fn(async () => {});
      page.locator.mockReturnValue({
        scrollIntoViewIfNeeded: async () => {},
        boundingBox: async () => ({ x: 100, y: 40, width: 80, height: 20 }),
        click,
      } as never);
      yield* broker.invoke({ scope, tabId, operation: "click", input: { locator: "#go" } });
      const pointers = (yield* Queue.clear(viewer.output)).filter(
        (item) => item._tag === "pointer",
      );
      expect(pointers).toEqual([
        expect.objectContaining({ phase: "move", x: 140, y: 50 }),
        expect.objectContaining({ phase: "click", x: 140, y: 50 }),
      ]);
      expect(click).toHaveBeenCalledOnce();
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect.each(["layout-timeout", "surface-unsupported"] as const)(
  "reports native %s without dispatching the page mutation or evicting the host",
  (reason) =>
    Effect.scoped(
      Effect.gen(function* () {
        desktopRendersNext = true;
        const { broker, tabId } = yield* ready;
        surfaceCalls.length = 0;
        surfaceFailure = new DesktopBrowserTransportError({ reason });
        const error = yield* broker
          .invoke<void>({ scope, tabId, operation: "click", input: { locator: "button" } })
          .pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: "PreviewAutomationRemoteUnavailableError",
          cause: { detail: { reason } },
        });
        expect(desktopConnections[0]!.context.page.locator).not.toHaveBeenCalled();
        expect(surfaceCalls.map((call) => call.action)).toEqual(["acquire", "release"]);
        surfaceFailure = null;
        expect(
          yield* broker.invoke({ scope, tabId, operation: "evaluate", input: { expression: "1" } }),
        ).toBe("evaluated");
      }),
    ).pipe(Effect.provide(layer)),
);

it.effect.each(["encoder acquisition", "encoder setup", "CDP acquisition"] as const)(
  "a canceled recording %s releases its queue and disposes late resources",
  (stage) =>
    Effect.scoped(
      Effect.gen(function* () {
        desktopRendersNext = true;
        const { broker, tabId } = yield* ready;
        surfaceCalls.length = 0;
        const gate = Promise.withResolvers<void>();
        if (stage === "encoder acquisition") encoderAcquireGate = gate;
        if (stage === "encoder setup") encoderSetupGate = gate;
        if (stage === "CDP acquisition") recordingCdpGate = gate;
        recordingStageEntered = Promise.withResolvers<void>();
        const started = yield* broker
          .invoke<void>({ scope, tabId, operation: "recordingStart", input: {}, timeoutMs: 200 })
          .pipe(Effect.flip, Effect.forkScoped);
        yield* Effect.promise(() => recordingStageEntered!.promise);
        const disposed = Promise.withResolvers<void>();
        const lateResource =
          stage === "CDP acquisition"
            ? desktopConnections[0]!.context.sessions.at(-1)!.detach
            : encoderPages[0]!.close;
        lateResource.mockImplementation(async () => {
          disposed.resolve();
        });
        yield* Effect.addFinalizer(() => Effect.sync(() => gate.resolve()));
        const recordingLease = surfaceCalls[1]!.leaseId;
        yield* TestClock.adjust(180);
        expect(yield* Fiber.join(started)).toMatchObject({ _tag: "PreviewAutomationTimeoutError" });
        // Neither control nor capture waits for the resource that has not answered.
        const snapshot = yield* broker.invoke<PreviewAutomationSnapshot>({
          scope,
          tabId,
          operation: "snapshot",
          input: { includeImage: false },
        });
        expect(snapshot.title).toBe("test page");
        expect(
          surfaceCalls.filter((call) => call.leaseId === recordingLease).map((call) => call.action),
        ).toEqual(["acquire", "release"]);
        gate.resolve();
        yield* Effect.promise(() => disposed.promise);
        expect(
          desktopConnections[0]!.context.sessions.some((session) =>
            session.send.mock.calls.some(([method]) => method === "Page.startScreencast"),
          ),
        ).toBe(false);
        const stopped = yield* broker
          .invoke<void>({ scope, tabId, operation: "recordingStop", input: {} })
          .pipe(Effect.flip);
        expect(stopped).toMatchObject({
          _tag: "PreviewAutomationExecutionError",
          cause: { _tag: "PreviewAutomationRecordingNotActiveError" },
        });
      }),
    ).pipe(Effect.provide(layer)),
);

it.effect("a canceled recording stop closes its encoder without pinning subsequent captures", () =>
  Effect.scoped(
    Effect.gen(function* () {
      desktopRendersNext = true;
      const { broker, tabId } = yield* ready;
      yield* broker.invoke({ scope, tabId, operation: "recordingStart", input: {} });
      const encoder = encoderPages[0]!;
      const entered = Promise.withResolvers<void>();
      const stalled = Promise.withResolvers<never>();
      encoder.evaluate.mockImplementationOnce(async () => {
        entered.resolve();
        return stalled.promise;
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => stalled.reject(new Error("late encoder reply"))),
      );
      const stopping = yield* broker
        .invoke<void>({ scope, tabId, operation: "recordingStop", input: {}, timeoutMs: 200 })
        .pipe(Effect.flip, Effect.forkScoped);
      yield* Effect.promise(() => entered.promise);
      yield* TestClock.adjust(180);
      expect(yield* Fiber.join(stopping)).toMatchObject({ _tag: "PreviewAutomationTimeoutError" });
      const snapshot = yield* broker.invoke<PreviewAutomationSnapshot>({
        scope,
        tabId,
        operation: "snapshot",
        input: {},
      });
      expect(snapshot.screenshot).toBeDefined();
      expect(encoder.close).toHaveBeenCalled();
      const stopped = yield* broker
        .invoke<void>({ scope, tabId, operation: "recordingStop", input: {} })
        .pipe(Effect.flip);
      expect(stopped).toMatchObject({
        _tag: "PreviewAutomationExecutionError",
        cause: { _tag: "PreviewAutomationRecordingNotActiveError" },
      });
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("a canceled snapshot pause cannot pin the viewer or tab queue", () =>
  Effect.scoped(
    Effect.gen(function* () {
      desktopRendersNext = true;
      const { broker, browser, tabId } = yield* ready;
      yield* browser.attachViewer(viewerInput(tabId, false));
      const session = desktopConnections[0]!.context.sessions.at(-1)!;
      const send = session.send.getMockImplementation()!;
      const entered = Promise.withResolvers<void>();
      const stalled = Promise.withResolvers<Record<string, unknown>>();
      let stalledOnce = false;
      session.send.mockImplementation(async (method, input) => {
        if (method === "Page.stopScreencast" && !stalledOnce) {
          stalledOnce = true;
          entered.resolve();
          return stalled.promise;
        }
        return send(method, input);
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => stalled.resolve({})));
      const snapshot = yield* broker
        .invoke<PreviewAutomationSnapshot>({
          scope,
          tabId,
          operation: "snapshot",
          input: {},
          timeoutMs: 200,
        })
        .pipe(Effect.flip, Effect.forkScoped);
      yield* Effect.promise(() => entered.promise);
      yield* TestClock.adjust(180);
      expect(yield* Fiber.join(snapshot)).toMatchObject({ _tag: "PreviewAutomationTimeoutError" });
      // Resume resets its parameter queue while the abandoned stop still has no reply.
      const fresh = yield* broker.invoke<PreviewAutomationSnapshot>({
        scope,
        tabId,
        operation: "snapshot",
        input: {},
      });
      expect(fresh.screenshot).toBeDefined();
      expect(session.send).toHaveBeenCalledWith("Page.startScreencast", expect.anything());
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("a canceled remote URL resolution never dispatches delayed navigation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      profileCatalogue = {
        desktopHostId: "remote-desktop",
        profiles: [{ id: "work", name: "Work", kind: "persistent" }],
        defaultProfileId: "work",
      };
      desktopRendersNext = true;
      const { broker, tabId } = yield* ready;
      remoteUrlGate = Promise.withResolvers<void>();
      remoteUrlEntered = Promise.withResolvers<void>();
      const gate = remoteUrlGate;
      yield* Effect.addFinalizer(() => Effect.sync(() => gate.resolve()));
      const navigating = yield* broker
        .invoke<void>({
          scope,
          tabId,
          operation: "navigate",
          input: { url: "http://localhost:3000/late" },
          timeoutMs: 200,
        })
        .pipe(Effect.flip, Effect.forkScoped);
      yield* Effect.promise(() => remoteUrlEntered!.promise);
      yield* TestClock.adjust(180);
      expect(yield* Fiber.join(navigating)).toMatchObject({
        _tag: "PreviewAutomationTimeoutError",
      });
      expect(
        yield* broker.invoke({ scope, tabId, operation: "evaluate", input: { expression: "1" } }),
      ).toBe("evaluated");
      gate.resolve();
      yield* broker.invoke({ scope, tabId, operation: "evaluate", input: { expression: "2" } });
      expect(desktopConnections[0]!.context.page.goto).not.toHaveBeenCalled();
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("keeps a native recording surface acquired until its tab closes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      desktopRendersNext = true;
      const { broker, tabId } = yield* ready;
      surfaceCalls.length = 0;
      yield* broker.invoke({ scope, tabId, operation: "recordingStart", input: {} });
      expect(surfaceCalls.map((call) => call.action)).toEqual(["acquire", "acquire", "release"]);
      const recordingLease = surfaceCalls[1]!.leaseId;
      expect(recordingLease).not.toBe(surfaceCalls[0]!.leaseId);
      expect(surfaceCalls.filter((call) => call.leaseId === recordingLease)).toHaveLength(1);
      yield* broker.invoke({ scope, tabId, operation: "close", input: {} });
      expect(
        surfaceCalls.filter((call) => call.leaseId === recordingLease).map((call) => call.action),
      ).toEqual(["acquire", "release"]);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("keeps a native viewer paintable for its scoped lifetime", () =>
  Effect.scoped(
    Effect.gen(function* () {
      desktopRendersNext = true;
      const { browser, tabId } = yield* ready;
      surfaceCalls.length = 0;
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* browser.attachViewer(viewerInput(tabId, false));
          expect(surfaceCalls.map((call) => call.action)).toEqual(["acquire"]);
        }),
      );
      expect(surfaceCalls.map((call) => call.action)).toEqual(["acquire", "release"]);
      expect(surfaceCalls[0]!.leaseId).toBe(surfaceCalls[1]!.leaseId);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("keeps a background native tab paintable through snapshot and geometry actions", () =>
  Effect.scoped(
    Effect.gen(function* () {
      desktopRendersNext = true;
      const { broker, tabId } = yield* ready;
      const page = desktopConnections[0]!.context.page;
      surfaceCalls.length = 0;
      page.locator.mockReturnValueOnce({
        scrollIntoViewIfNeeded: async () => {},
        boundingBox: async () => ({ x: 20, y: 20, width: 80, height: 30 }),
        click: async () => {},
      } as never);
      yield* broker.invoke({ scope, tabId, operation: "click", input: { locator: "button" } });
      yield* broker.invoke({ scope, tabId, operation: "snapshot", input: {} });
      expect(surfaceCalls.map((call) => call.action)).toEqual([
        "acquire",
        "release",
        "acquire",
        "release",
      ]);
      expect(surfaceCalls[0]!.leaseId).toBe(surfaceCalls[1]!.leaseId);
      expect(surfaceCalls[2]!.leaseId).toBe(surfaceCalls[3]!.leaseId);
      expect(surfaceCalls[0]!.leaseId).not.toBe(surfaceCalls[2]!.leaseId);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("reports the native renderer's applied resize instead of a fallback viewport", () =>
  Effect.scoped(
    Effect.gen(function* () {
      desktopRendersNext = true;
      const { broker, tabId } = yield* ready;
      const resized = yield* broker.invoke<{ viewport: { width: number; height: number } }>({
        scope,
        tabId,
        operation: "resize",
        input: { width: 390, height: 844 },
      });
      expect(resized.viewport).toEqual({ width: 390, height: 844 });
      expect(desktopConnections[0]!.context.page.setViewportSize).not.toHaveBeenCalled();
      expect(surfaceCalls.find((call) => call.viewport)).toMatchObject({
        action: "acquire",
        viewport: { _tag: "freeform", width: 390, height: 844 },
      });
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("a timed-out native snapshot preserves its connection and leaves both tabs usable", () =>
  Effect.scoped(
    Effect.gen(function* () {
      desktopRendersNext = true;
      const { broker, tabId } = yield* ready;
      desktopRendersNext = true;
      const second = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "open",
        input: { reuseExistingTab: false, show: false },
      });
      const entered = Promise.withResolvers<void>();
      const stalled = Promise.withResolvers<Record<string, unknown>>();
      yield* Effect.addFinalizer(() => Effect.sync(() => stalled.resolve({ data: "late" })));
      const session = desktopConnections[0]!.context.sessions[0]!;
      const send = session.send.getMockImplementation()!;
      session.send.mockImplementation(async (method, input) => {
        if (method === "Page.captureScreenshot") {
          entered.resolve();
          return stalled.promise;
        }
        return send(method, input);
      });
      const snapshot = yield* broker
        .invoke<PreviewAutomationSnapshot>({
          scope,
          tabId,
          operation: "snapshot",
          input: {},
          timeoutMs: 200,
        })
        .pipe(Effect.flip, Effect.forkScoped);
      yield* Effect.promise(() => entered.promise);
      yield* TestClock.adjust(180);
      expect(yield* Fiber.join(snapshot)).toMatchObject({
        _tag: "PreviewAutomationTimeoutError",
      });
      expect(releasedDesktopTabs).toEqual([]);
      expect(
        yield* broker.invoke({
          scope,
          tabId: PreviewTabId.make(second.tabId!),
          operation: "evaluate",
          input: { expression: "1" },
        }),
      ).toBe("evaluated");
      // A failed read releases the queue without replacing either native guest.
      expect(
        yield* broker.invoke({ scope, tabId, operation: "evaluate", input: { expression: "2" } }),
      ).toBe("evaluated");
      expect(desktopConnections).toHaveLength(2);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live.each([
  ["default", "Default", "local"],
  ["developer", "Logged in Developer", "remote-desktop"],
  ["incognito", "Incognito", "remote-desktop"],
] as const)(
  "agent opens %s on an independent native page owned by its selected host",
  ([profileId, profileName, desktopHostId]) =>
    Effect.scoped(
      Effect.gen(function* () {
        const browser = yield* ServerBrowser.ServerBrowser;
        const broker = yield* Broker.PreviewAutomationBroker;
        const manager = yield* Manager.PreviewManager;
        yield* Effect.yieldNow;
        profileCatalogue = {
          desktopHostId,
          defaultProfileId: profileId,
          profiles: [
            {
              id: profileId,
              name: profileName,
              kind: profileId === "incognito" ? "incognito" : "persistent",
            },
          ],
        };
        desktopRendersNext = true;
        const setupEntered = Promise.withResolvers<void>();
        const setupGate = Promise.withResolvers<void>();
        desktopPageSetup = async () => {
          setupEntered.resolve();
          await setupGate.promise;
        };
        const events = yield* manager.subscribeEvents;
        const opening = yield* broker
          .invoke<PreviewAutomationStatus>({
            scope,
            operation: "openWithProfile",
            input: {
              profileId,
              reuseExistingTab: false,
              show: false,
              url: "https://example.test/start",
            },
          })
          .pipe(Effect.forkChild);
        yield* Effect.promise(() => setupEntered.promise);
        expect((yield* manager.list({ threadId: scope.thread.threadId })).sessions).toEqual([]);
        expect(yield* PubSub.takeUpTo(events, 100)).toEqual([]);
        setupGate.resolve();
        const opened = yield* Fiber.join(opening);
        const snapshot = (yield* manager.list({ threadId: scope.thread.threadId })).sessions[0]!;
        expect(snapshot).toMatchObject({
          backingPage: "desktop-root",
          desktopRootId: `root-${opened.tabId}`,
          automationOwner: `${scope.environmentId}\u0000${scope.thread.providerSessionId}`,
          desktopHostId,
          profileId,
        });
        expect(rootCreations).toEqual([
          expect.objectContaining({
            tabId: opened.tabId,
            desktopHostId,
            profileId,
            url: "https://example.test/start",
          }),
        ]);
        expect(contexts).toHaveLength(0);
        expect(desktopConnections).toHaveLength(1);
        const page = desktopConnections[0]!.context.page;
        expect(page.goto).toHaveBeenCalledExactlyOnceWith(
          "https://example.test/start",
          expect.objectContaining({ waitUntil: "commit" }),
        );
        const published = yield* Stream.fromSubscription(events).pipe(
          Stream.filter((event) => event.type === "opened"),
          Stream.runHead,
        );
        expect(Option.getOrNull(published)).toMatchObject({
          snapshot: { desktopRootId: snapshot.desktopRootId },
        });
        yield* browser.attachViewer(viewerInput(opened.tabId!, false));
        expect(desktopConnections).toHaveLength(1);
        page.locator.mockReturnValue({ evaluate: async () => true } as never);
        yield* broker.invoke({
          scope,
          tabId: opened.tabId!,
          operation: "type",
          input: { locator: "#field", text: "root input" },
        });
        yield* broker.invoke({
          scope,
          tabId: opened.tabId!,
          operation: "press",
          input: { key: "Enter" },
        });
        expect(page.keyboard.insertText).toHaveBeenCalledExactlyOnceWith("root input");
        expect(page.keyboard.press).toHaveBeenCalledExactlyOnceWith("Enter");
        rootCloseFailure = "close-canceled";
        yield* broker
          .invoke<void>({ scope, tabId: opened.tabId!, operation: "close", input: {} })
          .pipe(Effect.flip);
        expect(
          (yield* manager.list({ threadId: scope.thread.threadId })).sessions[0],
        ).toMatchObject({
          desktopRootId: snapshot.desktopRootId,
          automationOwner: `${scope.environmentId}\u0000${scope.thread.providerSessionId}`,
        });
        rootCloseFailure = null;
        yield* broker.invoke({ scope, tabId: opened.tabId!, operation: "close", input: {} });
        expect((yield* manager.list({ threadId: scope.thread.threadId })).sessions).toEqual([]);
        expect(rootClosures.map((close) => close.rootId)).toEqual([
          snapshot.desktopRootId,
          snapshot.desktopRootId,
        ]);
        expect(page.close).not.toHaveBeenCalled();
      }),
    ).pipe(Effect.provide(layer)),
);

it.live("a root loaded before native acceptance publishes its completed navigation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* ServerBrowser.ServerBrowser;
      const manager = yield* Manager.PreviewManager;
      const broker = yield* Broker.PreviewAutomationBroker;
      yield* Effect.yieldNow;
      desktopRendersNext = true;
      rootAcceptanceEntered = Promise.withResolvers<void>();
      rootAcceptanceGate = Promise.withResolvers<void>();
      nativeNavigationReported = { status: "Success", completed: Promise.withResolvers<void>() };
      desktopPageSetup = async (context) => {
        context.page.title.mockResolvedValue("Completed before acceptance");
      };
      yield* Effect.addFinalizer(() => Effect.sync(() => rootAcceptanceGate!.resolve()));
      const events = yield* manager.subscribeEvents;
      const opening = yield* broker
        .invoke<PreviewAutomationStatus>({
          scope,
          operation: "open",
          input: { reuseExistingTab: false, show: false, url: "https://example.test/completed" },
        })
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => rootAcceptanceEntered!.promise);
      yield* Effect.promise(() => nativeNavigationReported!.completed.promise);
      const page = desktopConnections[0]!.context.page;
      expect(page.url()).toBe("https://example.test/completed");
      expect((yield* manager.list({ threadId: scope.thread.threadId })).sessions).toEqual([]);
      expect(yield* PubSub.takeUpTo(events, 100)).toEqual([]);
      rootAcceptanceGate.resolve();
      const opened = yield* Fiber.join(opening);
      expect((yield* manager.list({ threadId: scope.thread.threadId })).sessions).toEqual([
        expect.objectContaining({
          tabId: opened.tabId,
          navStatus: {
            _tag: "Success",
            url: "https://example.test/completed",
            title: "Completed before acceptance",
          },
        }),
      ]);
      expect(page.goto).toHaveBeenCalledTimes(1);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("a root that failed before native acceptance publishes its failed navigation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* ServerBrowser.ServerBrowser;
      const manager = yield* Manager.PreviewManager;
      const broker = yield* Broker.PreviewAutomationBroker;
      yield* Effect.yieldNow;
      desktopRendersNext = true;
      rootAcceptanceEntered = Promise.withResolvers<void>();
      rootAcceptanceGate = Promise.withResolvers<void>();
      nativeNavigationReported = { status: "LoadFailed", completed: Promise.withResolvers<void>() };
      const url = "https://example.test/refused";
      desktopPageSetup = async (context) => {
        context.page.goto.mockImplementationOnce(async (next) => {
          const request = {
            isNavigationRequest: () => true,
            frame: () => context.page,
            url: () => next,
            method: () => "GET",
            failure: () => ({ errorText: "net::ERR_CONNECTION_REFUSED" }),
          };
          context.page.emit("request", request);
          context.page.emit("requestfailed", request);
          throw new Error(`page.goto: net::ERR_CONNECTION_REFUSED at ${next}`);
        });
      };
      yield* Effect.addFinalizer(() => Effect.sync(() => rootAcceptanceGate!.resolve()));
      const opening = yield* broker
        .invoke<PreviewAutomationStatus>({
          scope,
          operation: "open",
          input: { reuseExistingTab: false, show: false, url },
        })
        .pipe(Effect.flip, Effect.forkChild);
      yield* Effect.promise(() => rootAcceptanceEntered!.promise);
      yield* Effect.promise(() => nativeNavigationReported!.completed.promise);
      expect((yield* manager.list({ threadId: scope.thread.threadId })).sessions).toEqual([]);
      rootAcceptanceGate.resolve();
      const failure = yield* Fiber.join(opening);
      expect(failure).toMatchObject({ _tag: "PreviewAutomationExecutionError" });
      expect(failure.message).toContain("ERR_CONNECTION_REFUSED");
      expect((yield* manager.list({ threadId: scope.thread.threadId })).sessions).toEqual([
        expect.objectContaining({
          navStatus: expect.objectContaining({
            _tag: "LoadFailed",
            url,
            title: "",
            code: -102,
            description: "ERR_CONNECTION_REFUSED",
          }),
        }),
      ]);
      expect(desktopConnections[0]!.context.page.goto).toHaveBeenCalledTimes(1);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("canceled root connection closes its attempted page and never publishes a late tab", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* ServerBrowser.ServerBrowser;
      const manager = yield* Manager.PreviewManager;
      const broker = yield* Broker.PreviewAutomationBroker;
      yield* Effect.yieldNow;
      desktopRendersNext = true;
      const setupEntered = Promise.withResolvers<void>();
      const setupGate = Promise.withResolvers<void>();
      desktopPageSetup = async () => {
        setupEntered.resolve();
        await setupGate.promise;
      };
      rootCloseAttempted = Promise.withResolvers<void>();
      rootCloseFailure = "close-canceled";
      releasedDesktopSeen = Promise.withResolvers<void>();
      const events = yield* manager.subscribeEvents;
      const opening = yield* broker
        .invoke<PreviewAutomationStatus>({
          scope,
          operation: "open",
          input: { reuseExistingTab: false, show: false },
          timeoutMs: 200,
        })
        .pipe(Effect.flip, Effect.forkChild);
      yield* Effect.promise(() => setupEntered.promise);
      yield* TestClock.adjust("201 millis");
      expect(yield* Fiber.join(opening)).toMatchObject({ _tag: "PreviewAutomationTimeoutError" });
      yield* Effect.promise(() => rootCloseAttempted!.promise);
      setupGate.resolve();
      yield* Effect.promise(() => releasedDesktopSeen!.promise);
      expect((yield* manager.list({ threadId: scope.thread.threadId })).sessions).toEqual([]);
      expect(yield* PubSub.takeUpTo(events, 100)).toEqual([]);
      expect(rootClosures).toEqual([
        expect.objectContaining({ rootId: `root-${rootCreations[0]!.tabId}` }),
      ]);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live(
  "shared native pages reject keyboard automation before acquiring a surface or sending input",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const browser = yield* ServerBrowser.ServerBrowser;
        const manager = yield* Manager.PreviewManager;
        const broker = yield* Broker.PreviewAutomationBroker;
        yield* Effect.yieldNow;
        desktopRendersNext = true;
        const shared = yield* manager.open({
          threadId: scope.thread.threadId,
          runtime: "server",
          desktopHostId: "local",
          automationOwner: `${scope.environmentId}\u0000${scope.thread.providerSessionId}`,
        });
        yield* browser.attachViewer(viewerInput(shared.tabId, false));
        expect(shared.backingPage).toBe("desktop");
        surfaceCalls.length = 0;
        for (const [operation, input] of [
          ["type", { locator: "#field", text: "shared input" }],
          ["press", { key: "Enter" }],
        ] as const) {
          const failure = yield* broker
            .invoke<void>({ scope, tabId: shared.tabId, operation, input })
            .pipe(Effect.flip);
          expect(failure).toMatchObject({ _tag: "PreviewAutomationExecutionError" });
          expect(failure.message).toContain("preview_open({reuseExistingTab:false})");
          expect(failure.message).toContain("returned tabId");
        }
        expect(surfaceCalls).toEqual([]);
        expect(rootCreations).toEqual([]);
        const page = desktopConnections[0]!.context.page;
        expect(page.locator).not.toHaveBeenCalled();
        expect(page.keyboard.insertText).not.toHaveBeenCalled();
        expect(page.keyboard.press).not.toHaveBeenCalled();
        expect((yield* manager.list({ threadId: scope.thread.threadId })).sessions).toEqual([
          shared,
        ]);
      }),
    ).pipe(Effect.provide(layer)),
);

it.live("drives the desktop's own page for a tab the desktop renders", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* ServerBrowser.ServerBrowser;
      const broker = yield* Broker.PreviewAutomationBroker;
      const manager = yield* Manager.PreviewManager;
      yield* Effect.yieldNow;
      desktopRendersNext = true;
      const opened = yield* manager.open({ threadId: scope.thread.threadId, runtime: "server" });
      const viewer = yield* browser.attachViewer(viewerInput(opened.tabId, true));
      expect(desktopConnections.map((connection) => connection.endpoint)).toEqual([
        `ws://desktop/${opened.tabId}`,
      ]);
      // No headless context was launched for it.
      expect(contexts).toEqual([]);
      const page = desktopConnections[0]!.context.page;
      // The desktop panel sizes its page, so a viewer resize leaves it alone.
      yield* viewer.input({ type: "takeControl" });
      yield* viewer.input({ type: "resize", width: 390, height: 844 });
      expect(page.setViewportSize).not.toHaveBeenCalled();
      yield* viewer.input({ type: "releaseControl" });
      // Agents reach it through the same engine as a headless tab.
      const evaluated = yield* broker.invoke({
        scope: asSession("agent-desktop"),
        operation: "status",
        input: {},
        tabId: PreviewTabId.make(opened.tabId),
      });
      expect(evaluated).toMatchObject({ tabId: opened.tabId });
      // Closing the session lets go of the desktop's page without closing it.
      yield* manager.close({ threadId: scope.thread.threadId, tabId: opened.tabId });
      while (releasedDesktopTabs.length === 0) yield* Effect.yieldNow;
      expect(releasedDesktopTabs).toEqual([opened.tabId]);
      expect(page.close).not.toHaveBeenCalled();
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("a desktop page the desktop takes back reconnects instead of closing", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* ServerBrowser.ServerBrowser;
      const manager = yield* Manager.PreviewManager;
      yield* Effect.yieldNow;
      desktopRendersNext = true;
      const opened = yield* manager.open({ threadId: scope.thread.threadId, runtime: "server" });
      const viewer = yield* browser.attachViewer(viewerInput(opened.tabId, false));
      // Devtools opened on the desktop, so it withdrew the page's debugger.
      // The server's listener subscribes in its own fiber; detach once it is there.
      while (desktopDetaches.listenerCount("detach") === 0) yield* Effect.yieldNow;
      desktopDetaches.emit("detach", { threadId: scope.thread.threadId, tabId: opened.tabId });
      let end = yield* Queue.take(viewer.output);
      while (end._tag !== "reconnect" && end._tag !== "gone")
        end = yield* Queue.take(viewer.output);
      expect(end._tag).toBe("reconnect");
      expect(releasedDesktopTabs).toEqual([opened.tabId]);
      // The session survives, and the next viewer reaches the page again.
      const { sessions } = yield* manager.list({ threadId: scope.thread.threadId });
      expect(sessions.map((session) => session.tabId)).toContain(opened.tabId);
      yield* browser.attachViewer(viewerInput(opened.tabId, false));
      expect(desktopConnections).toHaveLength(2);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("agents read a human's tab with no arguments and act on it only while nobody drives", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* ServerBrowser.ServerBrowser;
      const broker = yield* Broker.PreviewAutomationBroker;
      const manager = yield* Manager.PreviewManager;
      yield* Effect.yieldNow;
      const opened = yield* manager.open({
        threadId: scope.thread.threadId,
        url: "http://localhost:5173/mine",
        runtime: "server",
      });
      const tabId = PreviewTabId.make(opened.tabId);
      // The user opened and is looking at the tab; attaching takes control.
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      const status = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "status",
        input: {},
      });
      expect(status).toMatchObject({
        tabId,
        control: { owner: "human", ownedByCaller: false },
      });
      expect(status.tabs).toEqual([
        expect.objectContaining({ tabId, owner: "human", ownedByCaller: false, visible: true }),
      ]);
      // Reads work while the user drives; page script does not, since it can change the page.
      const evaluated = yield* broker
        .invoke<void>({ scope, operation: "evaluate", input: { expression: "read()" } })
        .pipe(Effect.flip);
      expect(evaluated).toMatchObject({
        _tag: "PreviewAutomationControlInterruptedError",
        reason: "humanControl",
      });
      yield* broker.invoke<PreviewAutomationSnapshot>({
        scope,
        tabId,
        operation: "snapshot",
        input: {},
      });
      // Acting is refused while the user controls the tab.
      const refused = yield* broker
        .invoke<void>({
          scope,
          tabId,
          operation: "navigate",
          input: { url: "http://localhost:5173/agent" },
        })
        .pipe(Effect.flip);
      expect(refused).toMatchObject({
        _tag: "PreviewAutomationControlInterruptedError",
        reason: "humanControl",
      });
      // Once they let go, the tab is unclaimed and the agent may act on it.
      yield* viewer.input({ type: "releaseControl" });
      const released = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId,
        operation: "status",
        input: {},
      });
      expect(released.control).toMatchObject({ owner: "unclaimed", ownedByCaller: false });
      yield* broker.invoke({
        scope,
        tabId,
        operation: "navigate",
        input: { url: "http://localhost:5173/agent" },
      });
      expect(contexts[0]!.page.goto).toHaveBeenCalledWith(
        "http://localhost:5173/agent",
        expect.anything(),
      );
      // Taking control back refuses the agent again.
      yield* viewer.input({ type: "takeControl" });
      const retaken = yield* broker
        .invoke<void>({ scope, tabId, operation: "press", input: { key: "Enter" } })
        .pipe(Effect.flip);
      expect(retaken).toMatchObject({ reason: "humanControl" });
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("a session's own tab stays its default while other sessions' tabs are listed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const other = yield* broker.invoke<PreviewAutomationStatus>({
        scope: asSession("agent-b"),
        operation: "open",
        input: { reuseExistingTab: false, show: false },
      });
      const status = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "status",
        input: {},
      });
      expect(status.tabId).toBe(tabId);
      expect(status.tabs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ tabId, owner: "agent", ownedByCaller: true }),
          expect.objectContaining({ tabId: other.tabId, owner: "agent", ownedByCaller: false }),
        ]),
      );
    }),
  ).pipe(Effect.provide(layer)),
);

it.live(
  "preview_open picks a reported profile by id or name and defaults to the reported one",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const browser = yield* ServerBrowser.ServerBrowser;
        const broker = yield* Broker.PreviewAutomationBroker;
        const manager = yield* Manager.PreviewManager;
        yield* Effect.yieldNow;
        yield* browser.reportProfiles({
          profiles: [{ id: "profile-work", name: "Work", kind: "persistent" }],
          defaultProfileId: "profile-work",
        });
        const openWith = (profileId?: string) =>
          broker.invoke<PreviewAutomationStatus>({
            scope,
            operation: "open",
            input: {
              reuseExistingTab: false,
              show: false,
              ...(profileId === undefined ? {} : { profileId }),
            },
          });
        const byDefault = yield* openWith();
        const byName = yield* openWith("WORK");
        const byId = yield* openWith("incognito");
        const { sessions } = yield* manager.list({ threadId: scope.thread.threadId });
        const profileOf = (tabId: string | null) =>
          sessions.find((session) => session.tabId === tabId)?.profileId;
        expect(profileOf(byDefault.tabId)).toBe("profile-work");
        expect(profileOf(byName.tabId)).toBe("profile-work");
        expect(profileOf(byId.tabId)).toBe("incognito");
        // The chosen profile reaches the headless tab's storage.
        expect(contextRequests).toEqual([
          { profileId: "profile-work", isolated: false },
          { profileId: "profile-work", isolated: false },
          { profileId: "incognito", isolated: true },
        ]);
        expect(byDefault).toMatchObject({
          defaultProfileId: "profile-work",
          profiles: [
            { id: "default", name: "Default" },
            { id: "incognito", name: "Incognito", incognito: true },
            { id: "profile-work", name: "Work" },
          ],
        });
        const unknown = yield* openWith("Personal").pipe(Effect.flip);
        expect(unknown).toMatchObject({
          _tag: "PreviewAutomationExecutionError",
          reason:
            'No browser profile is named "Personal". Use one of: Default (id default), Incognito (id incognito), Work (id profile-work).',
        });
      }),
    ).pipe(Effect.provide(layer)),
);

it.live("an agent tab keeps throwaway storage when no client reported profiles", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* ready;
      expect(contextRequests).toEqual([{ profileId: "default", isolated: true }]);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("a desktop page that comes back reconnects without waiting for a viewer", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const manager = yield* Manager.PreviewManager;
      yield* ServerBrowser.ServerBrowser;
      yield* Effect.yieldNow;
      desktopRendersNext = true;
      const opened = yield* manager.open({ threadId: scope.thread.threadId, runtime: "server" });
      while (desktopConnections.length === 0) yield* Effect.yieldNow;
      while (desktopDetaches.listenerCount("detach") === 0) yield* Effect.yieldNow;
      // DevTools opened, then closed: the desktop withdraws the page and returns it.
      desktopDetaches.emit("detach", { threadId: scope.thread.threadId, tabId: opened.tabId });
      while (releasedDesktopTabs.length === 0) yield* Effect.yieldNow;
      desktopDetaches.emit("attach", { threadId: scope.thread.threadId, tabId: opened.tabId });
      // Without a viewer or agent, the server drives the page again, so its URL keeps reaching clients.
      while (desktopConnections.length < 2) yield* Effect.yieldNow;
      expect(desktopConnections).toHaveLength(2);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live.each([true, false])(
  "reconciles native presentation changed during reconnect setup (initially presented: %s)",
  (initiallyPresented) =>
    Effect.scoped(
      Effect.gen(function* () {
        desktopRendersNext = true;
        const { browser, broker, tabId } = yield* ready;
        yield* broker.invoke({
          scope,
          tabId,
          operation: "setColorScheme",
          input: { colorScheme: "dark" },
        });
        const viewer = yield* browser.attachViewer(viewerInput(tabId, false));
        while (desktopDetaches.listenerCount("detach") === 0) yield* Effect.yieldNow;
        desktopDetaches.emit("detach", { threadId: scope.thread.threadId, tabId });
        let end = yield* Queue.take(viewer.output);
        while (end._tag !== "reconnect") end = yield* Queue.take(viewer.output);
        if (initiallyPresented) presentedDesktopTabs.add(tabId);
        nativeRenderingGate = Promise.withResolvers<void>();
        nativeRenderingEntered = Promise.withResolvers<void>();
        const connecting = yield* Effect.scoped(
          browser.attachViewer(viewerInput(tabId, false)),
        ).pipe(Effect.forkScoped);
        yield* Effect.promise(() => nativeRenderingEntered!.promise);
        // The new tab is not registered while emulateMedia is pending. Wait
        // until its presentation update has actually reached the subscriber.
        nativePresentationProcessed = Promise.withResolvers<void>();
        if (initiallyPresented) presentedDesktopTabs.delete(tabId);
        else presentedDesktopTabs.add(tabId);
        desktopPresentations.emit("presentation", {
          threadId: scope.thread.threadId,
          tabId,
          desktopHostId: "local",
        });
        yield* Effect.promise(() => nativePresentationProcessed!.promise);
        nativeRenderingGate.resolve();
        yield* Fiber.join(connecting);
        const status = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          tabId,
          operation: "status",
          input: {},
        });
        expect(status).toMatchObject({
          nativePresented: !initiallyPresented,
          visible: !initiallyPresented,
          streamViewers: 0,
        });
        expect(desktopConnections).toHaveLength(2);
        expect(contexts).toHaveLength(0);
      }),
    ).pipe(Effect.provide(layer)),
);

it.live(
  "uses the configured desktop profile and rejects explicit profile changes on the same tab",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        profileCatalogue = {
          desktopHostId: "local",
          profiles: [
            { id: "work", name: "Work", kind: "persistent" },
            { id: "personal", name: "Personal", kind: "persistent" },
          ],
          defaultProfileId: "work",
        };
        desktopRendersNext = true;
        const { broker, tabId } = yield* ready;
        const current = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          tabId,
          operation: "status",
          input: {},
        });
        expect(current).toMatchObject({ profileId: "work", profileName: "Work" });
        expect(profileRequests.at(-1)).toMatchObject({ desktopHostId: "local" });
        expect(contexts).toHaveLength(0);
        expect(desktopConnections).toHaveLength(1);
        const mismatch = yield* broker
          .invoke<void>({
            scope,
            tabId,
            operation: "openWithProfile",
            input: { profileName: "Personal" },
          })
          .pipe(Effect.flip);
        expect(mismatch).toMatchObject({
          _tag: "PreviewAutomationProfileError",
          reason: "tab-mismatch",
        });
        desktopRendersNext = true;
        const fresh = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          operation: "openWithProfile",
          input: { profileName: "Personal", show: false },
        });
        expect(fresh).toMatchObject({ profileId: "personal", profileName: "Personal" });
        expect(fresh.tabId).not.toBe(tabId);
        expect(desktopConnections).toHaveLength(2);
      }),
    ).pipe(Effect.provide(layer)),
);

it.live("keeps profile discovery and new tabs on the caller's retained desktop owner", () =>
  Effect.scoped(
    Effect.gen(function* () {
      profileCatalogue = {
        desktopHostId: "host-b",
        profiles: [{ id: "work", name: "Work", kind: "persistent" }],
        defaultProfileId: "work",
      };
      desktopRendersNext = true;
      const { broker, tabId } = yield* ready;
      profileCatalogues.set("host-b", profileCatalogue);
      profileCatalogue = {
        desktopHostId: "local",
        profiles: [{ id: "personal", name: "Personal", kind: "persistent" }],
        defaultProfileId: "personal",
      };
      const current = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId,
        operation: "status",
        input: {},
      });
      expect(current).toMatchObject({ profileId: "work", profileName: "Work" });
      const catalogue = yield* broker.invoke({ scope, tabId, operation: "profiles", input: {} });
      expect(catalogue).toMatchObject({ defaultProfileId: "work" });
      expect(profileRequests.at(-1)).toMatchObject({ desktopHostId: "host-b" });
      desktopRendersNext = true;
      const fresh = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "openWithProfile",
        input: { profileName: "Work", reuseExistingTab: false, show: false },
      });
      const manager = yield* Manager.PreviewManager;
      expect(
        (yield* manager.list({ threadId: scope.thread.threadId })).sessions.find(
          (session) => session.tabId === fresh.tabId,
        ),
      ).toMatchObject({ desktopHostId: "host-b", profileId: "work" });
      const requestedCatalogues = profileRequests.length;
      const stale = yield* broker
        .invoke<PreviewAutomationStatus>({
          scope,
          tabId: PreviewTabId.make("missing-tab"),
          operation: "openWithProfile",
          input: { profileName: "Personal", reuseExistingTab: false, show: false },
        })
        .pipe(Effect.flip);
      expect(stale).toMatchObject({ _tag: "PreviewAutomationTabNotFoundError" });
      expect(profileRequests).toHaveLength(requestedCatalogues);
      profileCatalogues.clear();
      const unavailable = yield* broker
        .invoke<PreviewAutomationStatus>({
          scope,
          tabId,
          operation: "open",
          input: { reuseExistingTab: false, show: false },
        })
        .pipe(Effect.flip);
      expect(unavailable).toMatchObject({ _tag: "PreviewAutomationRemoteUnavailableError" });
      expect(desktopConnections).toHaveLength(2);
      expect(contexts).toHaveLength(0);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live.each([false, true])(
  "explicitly selects a user's desktop tab without implicitly adopting it (attached=%s)",
  (attached) =>
    Effect.scoped(
      Effect.gen(function* () {
        const browser = yield* ServerBrowser.ServerBrowser;
        const broker = yield* Broker.PreviewAutomationBroker;
        const manager = yield* Manager.PreviewManager;
        yield* Effect.yieldNow;
        profileCatalogue = {
          desktopHostId: "local",
          profiles: [{ id: "personal", name: "Personal", kind: "persistent" }],
          defaultProfileId: "personal",
        };
        profileCatalogues.set("host-b", {
          desktopHostId: "host-b",
          profiles: [{ id: "work", name: "Work", kind: "persistent" }],
          defaultProfileId: "work",
        });
        desktopRendersNext = true;
        const opened = yield* manager.open({
          threadId: scope.thread.threadId,
          runtime: "server",
          desktopHostId: "host-b",
          profileId: "work",
        });
        const tabId = PreviewTabId.make(opened.tabId);
        if (attached) yield* browser.attachViewer(viewerInput(tabId, false));
        yield* broker.invoke({ scope, tabId, operation: "status", input: {} });
        const implicit = yield* broker.invoke({ scope, operation: "profiles", input: {} });
        expect(implicit).toMatchObject({ defaultProfileId: "personal" });
        const explicit = yield* broker.invoke({ scope, tabId, operation: "profiles", input: {} });
        expect(explicit).toMatchObject({ defaultProfileId: "work" });
        const reused = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          tabId,
          operation: "openWithProfile",
          input: { profileId: "work", show: false },
        });
        expect(reused).toMatchObject({
          tabId,
          profileId: "work",
          profileName: "Work",
          control: { owner: "unclaimed", ownedByCaller: false },
        });
        yield* broker.invoke({
          scope,
          tabId,
          operation: "navigate",
          input: { url: "https://example.test/agent" },
        });
        expect(desktopConnections[0]!.context.page.goto).toHaveBeenLastCalledWith(
          "https://example.test/agent",
          expect.anything(),
        );
        yield* browser.attachViewer(viewerInput(tabId, true));
        const controlled = yield* broker
          .invoke<PreviewAutomationStatus>({
            scope,
            tabId,
            operation: "openWithProfile",
            input: { profileId: "work", show: false },
          })
          .pipe(Effect.flip);
        expect(controlled).toMatchObject({
          _tag: "PreviewAutomationControlInterruptedError",
          reason: "humanControl",
        });
        expect(desktopConnections).toHaveLength(1);
        expect(contexts).toHaveLength(0);
      }),
    ).pipe(Effect.provide(layer)),
);

it.live("fails explicit missing and ambiguous profiles without opening another cookie jar", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* ServerBrowser.ServerBrowser;
      const broker = yield* Broker.PreviewAutomationBroker;
      yield* Effect.yieldNow;
      profileCatalogue = {
        desktopHostId: "local",
        profiles: [
          { id: "work", name: "Work", kind: "persistent" },
          { id: "work-2", name: "Work", kind: "persistent" },
        ],
        defaultProfileId: "work",
      };
      for (const [profileName, reason] of [
        ["Missing", "unknown"],
        ["Work", "ambiguous"],
      ] as const) {
        const failure = yield* broker
          .invoke<void>({ scope, operation: "openWithProfile", input: { profileName } })
          .pipe(Effect.flip);
        expect(failure).toMatchObject({ _tag: "PreviewAutomationProfileError", reason });
      }
      expect(contexts).toHaveLength(0);
      expect(desktopConnections).toHaveLength(0);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("never substitutes a headless page when the selected desktop does not attach", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* ServerBrowser.ServerBrowser;
      const broker = yield* Broker.PreviewAutomationBroker;
      yield* Effect.yieldNow;
      profileCatalogue = {
        desktopHostId: "local",
        profiles: [{ id: "work", name: "Work", kind: "persistent" }],
        defaultProfileId: "work",
      };
      yield* broker
        .invoke<void>({
          scope,
          operation: "openWithProfile",
          input: { profileId: "work", show: false },
        })
        .pipe(Effect.flip);
      expect(contexts).toHaveLength(0);
      expect(desktopConnections).toHaveLength(0);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("an unavailable profile catalogue never opens a fallback profile or publishes a tab", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* ServerBrowser.ServerBrowser;
      const manager = yield* Manager.PreviewManager;
      const broker = yield* Broker.PreviewAutomationBroker;
      yield* Effect.yieldNow;
      localDesktopAvailable = true;
      profileCatalogue = null;
      profileCatalogueUnavailable = true;
      yield* broker
        .invoke<void>({
          scope,
          operation: "open",
          input: { reuseExistingTab: false, show: false },
        })
        .pipe(Effect.flip);
      const { sessions } = yield* manager.list({ threadId: scope.thread.threadId });
      expect(sessions).toHaveLength(0);
      expect(rootCreations).toEqual([]);
      expect(contexts).toHaveLength(0);
      expect(desktopConnections).toHaveLength(0);
      desktopTabs.add("unpublished-root");
      expect(
        yield* browser.attachViewer(viewerInput("unpublished-root", false)).pipe(Effect.flip),
      ).toMatchObject({ _tag: "ServerBrowserTabNotFoundError" });
      expect(desktopConnections).toHaveLength(0);
      expect(contexts).toHaveLength(0);
      expect((yield* manager.list({ threadId: scope.thread.threadId })).sessions).toEqual([]);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("a headless page never becomes a native page when a desktop attaches later", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, broker, tabId } = yield* ready;
      const manager = yield* Manager.PreviewManager;
      expect(
        (yield* manager.list({ threadId: scope.thread.threadId })).sessions[0]?.backingPage,
      ).toBe("server");
      localDesktopAvailable = true;
      desktopTabs.add(tabId);
      yield* browser.attachViewer(viewerInput(tabId, false));
      yield* broker.invoke<void>({
        scope,
        tabId,
        operation: "open",
        input: { url: "https://headless.example/test", show: false },
      });
      expect(contexts).toHaveLength(1);
      expect(contexts[0]!.page.goto).toHaveBeenCalledWith(
        "https://headless.example/test",
        expect.anything(),
      );
      expect(desktopConnections).toHaveLength(0);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live(
  "visibility distinguishes native presentation, streamed viewers, and a pending reveal",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        desktopRendersNext = true;
        const { browser, broker, tabId } = yield* ready;
        const status = () =>
          broker.invoke<PreviewAutomationStatus>({ scope, tabId, operation: "status", input: {} });
        const revealed = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          tabId,
          operation: "open",
          input: { open: true },
        });
        expect(revealed).toMatchObject({
          available: true,
          visible: false,
          nativePresented: false,
          streamViewers: 0,
          revealRequested: true,
        });
        while (desktopPresentations.listenerCount("presentation") === 0) yield* Effect.yieldNow;
        presentedDesktopTabs.add(tabId);
        desktopPresentations.emit("presentation", {
          threadId: scope.thread.threadId,
          tabId,
          desktopHostId: "local",
        });
        yield* Effect.yieldNow;
        expect(yield* status()).toMatchObject({
          visible: true,
          nativePresented: true,
          streamViewers: 0,
          revealRequested: false,
        });
        presentedDesktopTabs.delete(tabId);
        desktopPresentations.emit("presentation", {
          threadId: scope.thread.threadId,
          tabId,
          desktopHostId: "local",
        });
        yield* Effect.yieldNow;
        expect(yield* status()).toMatchObject({ visible: false, nativePresented: false });
        yield* browser.attachViewer(viewerInput(tabId, false));
        expect(yield* status()).toMatchObject({
          visible: true,
          nativePresented: false,
          streamViewers: 1,
        });
      }),
    ).pipe(Effect.provide(layer)),
);

it.live(
  "uploads environment file bytes to a remote desktop profile without passing host paths",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        profileCatalogue = {
          desktopHostId: "remote-desktop",
          profiles: [{ id: "work", name: "Work", kind: "persistent" }],
          defaultProfileId: "work",
        };
        desktopRendersNext = true;
        const { broker, tabId } = yield* ready;
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = `${config.stateDir}/remote-upload.txt`;
        yield* fs.writeFileString(path, "environment file contents");
        const setInputFiles = vi.fn(async () => {});
        desktopConnections[0]!.context.page.locator.mockReturnValue({ setInputFiles } as never);
        yield* broker.invoke<void>({
          scope,
          tabId,
          operation: "upload",
          input: { paths: [path], locator: "input[type=file]" },
        });
        expect(setInputFiles).toHaveBeenCalledWith(
          [
            {
              name: "remote-upload.txt",
              mimeType: "text/plain",
              buffer: Buffer.from("environment file contents"),
            },
          ],
          expect.anything(),
        );
      }),
    ).pipe(Effect.provide(layer)),
);

it.live("resolves remote environment URLs for explicit profile opens and later navigation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* ServerBrowser.ServerBrowser;
      const broker = yield* Broker.PreviewAutomationBroker;
      yield* Effect.yieldNow;
      profileCatalogue = {
        desktopHostId: "remote-desktop",
        profiles: [{ id: "work", name: "Work", kind: "persistent" }],
        defaultProfileId: "work",
      };
      desktopRendersNext = true;
      const opened = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "openWithProfile",
        input: { profileName: "Work", url: "http://localhost:5173/start?x=1#section", show: false },
      });
      const page = desktopConnections[0]!.context.page;
      const manager = yield* Manager.PreviewManager;
      const initial = (yield* manager.list({ threadId: scope.thread.threadId })).sessions.find(
        (session) => session.tabId === opened.tabId,
      );
      // The server navigates the acknowledged root, after resolving the environment URL.
      expect(initial).toMatchObject({
        desktopHostId: "remote-desktop",
        profileId: "work",
        navStatus: {
          _tag: "Success",
          url: "http://environment.example.test:5173/start?x=1#section",
          title: "test page",
        },
      });
      expect(page.goto).toHaveBeenCalledExactlyOnceWith(
        "http://environment.example.test:5173/start?x=1#section",
        expect.objectContaining({ waitUntil: "commit" }),
      );
      yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId: opened.tabId!,
        operation: "navigate",
        input: { target: { kind: "environment-port", port: 3000, path: "/next?x=2#target" } },
      });
      expect(page.goto).toHaveBeenLastCalledWith(
        "http://environment.example.test:3000/next?x=2#target",
        expect.anything(),
      );
      const navigationCount = page.goto.mock.calls.length;
      remoteUrlAvailable = false;
      const failure = yield* broker
        .invoke<void>({
          scope,
          tabId: opened.tabId!,
          operation: "navigate",
          input: { url: "http://localhost:5173/wrong-machine" },
        })
        .pipe(Effect.flip);
      expect(failure).toMatchObject({ _tag: "PreviewAutomationRemoteUnavailableError" });
      expect(page.goto).toHaveBeenCalledTimes(navigationCount);
      expect(contexts).toHaveLength(0);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("does not open a remote profile when the environment URL cannot be resolved", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* ServerBrowser.ServerBrowser;
      const broker = yield* Broker.PreviewAutomationBroker;
      yield* Effect.yieldNow;
      profileCatalogue = {
        desktopHostId: "remote-desktop",
        profiles: [{ id: "work", name: "Work", kind: "persistent" }],
        defaultProfileId: "work",
      };
      remoteUrlAvailable = false;
      const failure = yield* broker
        .invoke<void>({
          scope,
          operation: "openWithProfile",
          input: { profileName: "Work", url: "http://localhost:5173/", show: false },
        })
        .pipe(Effect.flip);
      expect(failure).toMatchObject({ _tag: "PreviewAutomationRemoteUnavailableError" });
      expect(contexts).toHaveLength(0);
      expect(desktopConnections).toHaveLength(0);
      const manager = yield* Manager.PreviewManager;
      expect((yield* manager.list({ threadId: scope.thread.threadId })).sessions).toEqual([]);
    }),
  ).pipe(Effect.provide(layer)),
);
