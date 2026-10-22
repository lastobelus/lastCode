import * as NodeEvents from "node:events";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Playwright download mocks perform real file operations outside the Effect runtime.
import * as NodeFSP from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
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
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import type { BrowserContext, Page } from "playwright-core";
import { beforeEach, expect, vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Broker from "../mcp/PreviewAutomationBroker.ts";
import * as DesktopChannel from "./DesktopBrowserChannel.ts";
import * as Manager from "./Manager.ts";
import * as ServerBrowser from "./ServerBrowser.ts";
import * as ServerBrowserContexts from "./ServerBrowserContexts.ts";
import * as PreviewBrowser from "./PreviewBrowser.ts";

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

function makeFrame() {
  const frame = {
    copy: "",
    detached: false,
    isDetached: () => frame.detached,
    recording: Promise.withResolvers<void>(),
  };
  return frame;
}

const PNG_HEADER = (() => {
  const header = Buffer.alloc(24);
  header.write("IHDR", 12);
  header.writeUInt32BE(1280, 16);
  header.writeUInt32BE(800, 20);
  return header.toString("base64");
})();

function makeSession(frame?: ReturnType<typeof makeFrame>) {
  const events = new NodeEvents.EventEmitter();
  return {
    on: vi.fn((name: string, listener: () => void) => events.on(name, listener)),
    emit: (name: string) => events.emit(name),
    detach: vi.fn(async () => {}),
    send: vi.fn(async (method: string, input?: unknown): Promise<Record<string, unknown>> => {
      if (method === "Page.getNavigationHistory") return { currentIndex: 0, entries: [{}] };
      if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { pageX: 0, pageY: 0 } };
      if (method === "Page.captureScreenshot") {
        // A snapshot sizes its screenshot from the PNG header; viewers get JPEG frames as-is.
        return { data: (input as { format: string }).format === "png" ? PNG_HEADER : "ZnJhbWU=" };
      }
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
      // Snapshots read password fields from their own isolated world in each frame.
      if (method === "Page.createIsolatedWorld") {
        return {
          executionContextId: (input as { worldName?: string }).worldName === "t3-preview" ? 1 : 7,
        };
      }
      if (method === "Runtime.evaluate" && (input as { contextId?: number }).contextId === 1) {
        return { result: { value: [] } };
      }
      if (method === "Page.addScriptToEvaluateOnNewDocument") frame?.recording.resolve();
      if (method === "Input.dispatchKeyEvent" && (input as { commands?: unknown }).commands) {
        if (focusedFrame) focusedFrame.copy = keyCopy || focusedFrame.copy;
        else pageCopy = keyCopy || pageCopy;
      }
      if (
        method === "Runtime.evaluate" &&
        String((input as { expression?: string })?.expression).includes("devicePixelRatio")
      ) {
        return { result: { value: { ratio: 1, width: 1280, height: 800 } } };
      }
      if (method === "Runtime.evaluate" && (input as { contextId?: number }).contextId === 7) {
        const value = frame ? frame.copy : pageCopy;
        if (frame) frame.copy = "";
        else pageCopy = "";
        return { result: { value } };
      }
      return { result: { value: "evaluated" } };
    }),
  };
}

function makeContext(onClose?: (context: BrowserContext) => void) {
  const events = new NodeEvents.EventEmitter();
  const nativeFileChooser = vi.fn();
  const setChooserFiles = vi.fn(async (_files: unknown) => {});
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
    nativeFileChooser,
    setChooserFiles,
    openFileChooser: () => {
      if (
        !events.emit("filechooser", {
          isMultiple: () => false,
          element: () => ({ getAttribute: async () => ".csv" }),
          setFiles: setChooserFiles,
        })
      ) {
        nativeFileChooser();
      }
    },
    emitAsync: (name: string, ...args: unknown[]) =>
      Promise.all(events.listeners(name).map((listener) => listener(...args))),
    setDefaultTimeout: vi.fn(),
    setDefaultNavigationTimeout: vi.fn(),
    context: () => context,
    mainFrame: () => page,
    frames: () => [page],
    url: () => url,
    title: vi.fn(async () => "test page"),
    viewportSize: () => viewport,
    setViewportSize: vi.fn(async (size: typeof viewport) => {
      viewport = size;
    }),
    goto: vi.fn(async (next: string) => {
      url = next;
      events.emit("load");
      const pending = initialNavigation;
      initialNavigation = null;
      await pending?.();
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
    newCDPSession: async (target: unknown) => {
      const session = makeSession(
        target === page ? undefined : (target as ReturnType<typeof makeFrame>),
      );
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
const contextRequests: Array<{ profileId: string; isolated: boolean }> = [];
let contextGate: PromiseWithResolvers<void> | null = null;
let pageCopy = "";
let keyCopy = "";
let focusedFrame: ReturnType<typeof makeFrame> | null = null;
let contextFailure: Error | null = null;
let initialNavigation: (() => Promise<void>) | null = null;
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
let profileCatalogue: {
  desktopHostId: string;
  profiles: Array<{ id: string; name: string; kind: "persistent" }>;
  defaultProfileId: string;
} | null = null;
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
    available: true,
    getProfiles: () => Effect.sync(() => profileCatalogue),
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
        Effect.sync(() => releasedDesktopTabs.push(key.tabId)),
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
          Effect.tap(() =>
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
  initialNavigation = null;
  pageCopy = "";
  keyCopy = "";
  focusedFrame = null;
  desktopTabs.clear();
  presentedDesktopTabs.clear();
  nativeRenderingGate = null;
  nativeRenderingEntered = null;
  nativePresentationProcessed = null;
  desktopRendersNext = false;
  localDesktopAvailable = false;
  profileCatalogue = null;
  remoteUrlAvailable = true;
  releasedDesktopTabs.length = 0;
  desktopConnections.length = 0;
  desktopPageSetup = null;
  popupBindings.length = 0;
  popupClosures.length = 0;
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

it.live.each(["desktop" as const, undefined])(
  "explicit desktop targets ($0 runtime) fail without creating a server tab",
  (runtime) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { broker, tabId } = yield* ready;
        const manager = yield* Manager.PreviewManager;
        const desktop = yield* manager.open({
          threadId: scope.thread.threadId,
          url: "https://example.com/original",
          ...(runtime === undefined ? {} : { runtime }),
        });
        const before = yield* manager.list({ threadId: scope.thread.threadId });
        const error = yield* broker
          .invoke<PreviewAutomationStatus>({
            scope,
            tabId: PreviewTabId.make(desktop.tabId),
            operation: "open",
            input: { url: "https://example.com/replacement", open: true },
          })
          .pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "PreviewAutomationExecutionError" });
        expect(error.message).toContain("desktop runtime");
        expect(error.message).toContain("cannot control");
        expect(yield* manager.list({ threadId: scope.thread.threadId })).toEqual(before);
        expect(contexts).toHaveLength(1);
        // A rejected explicit target must not replace this session's working tab.
        const reused = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          operation: "open",
          input: { open: false },
        });
        expect(reused.tabId).toBe(tabId);
      }),
    ).pipe(Effect.provide(layer)),
);

it.live.each([
  {
    method: "goto" as const,
    message: { type: "navigate", url: "http://localhost:5173/next" },
    handoff: "release",
  },
  { method: "goBack" as const, message: { type: "history", delta: -1 }, handoff: "release" },
  { method: "goForward" as const, message: { type: "history", delta: 1 }, handoff: "release" },
  { method: "reload" as const, message: { type: "reload" }, handoff: "release" },
  {
    method: "goto" as const,
    message: { type: "navigate", url: "http://localhost:5173/next" },
    handoff: "disconnect",
  },
])(
  "$handoff waits for viewer $method to commit before agent actions",
  ({ method, message, handoff }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { browser, broker, tabId } = yield* ready;
        const viewerScope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(viewerScope, Exit.void));
        const viewer = yield* browser
          .attachViewer(viewerInput(tabId, true))
          .pipe(Effect.provideService(Scope.Scope, viewerScope));
        yield* viewer.input({ type: "takeControl" });
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
        yield* Effect.promise(() => started.promise);
        const releasing = yield* (
          handoff === "disconnect"
            ? Scope.close(viewerScope, Exit.void)
            : viewer.input({ type: "releaseControl" })
        ).pipe(Effect.forkScoped);
        yield* Effect.addFinalizer(() => Effect.sync(() => committed.resolve()));
        // Drain runnable promise work while the navigation gate remains closed.
        yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
        const status = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          tabId,
          operation: "status",
          input: {},
        });
        expect(status.control?.owner).toBe("agent");
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
        yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
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

it.live.each([
  { method: "goto" as const, message: { type: "navigate", url: "http://10.255.255.1/" } },
  { method: "goBack" as const, message: { type: "history", delta: -1 } },
  { method: "goForward" as const, message: { type: "history", delta: 1 } },
  { method: "reload" as const, message: { type: "reload" } },
])("a pending viewer $method allows a corrected URL and text input", ({ method, message }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, tabId } = yield* ready;
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* viewer.input({ type: "takeControl" });
      const started = Promise.withResolvers<void>();
      const committed = Promise.withResolvers<void>();
      const page = contexts[0]!.page;
      page[method].mockImplementationOnce(() => {
        started.resolve();
        return committed.promise;
      });
      const navigation = yield* viewer.input(message).pipe(Effect.forkScoped);
      yield* Effect.promise(() => started.promise);
      const cdp = contexts[0]!.sessions.at(-1)!;
      const send = cdp.send.getMockImplementation()!;
      const typed = Promise.withResolvers<void>();
      cdp.send.mockImplementation(async (operation, input) => {
        if (operation === "Input.insertText") typed.resolve();
        return send(operation, input);
      });
      const correction = yield* Effect.gen(function* () {
        yield* viewer.input({ type: "navigate", url: "http://localhost:5173/fixed" });
        yield* viewer.input({ type: "text", text: "hello" });
      }).pipe(Effect.forkScoped);
      yield* Effect.addFinalizer(() => Effect.sync(() => committed.resolve()));
      // The text reaches the page while the first navigation is still uncommitted.
      yield* Effect.promise(() => typed.promise);
      expect(page.goto).toHaveBeenLastCalledWith(
        "http://localhost:5173/fixed",
        expect.objectContaining({ waitUntil: "commit" }),
      );
      expect(contexts[0]!.sessions.at(-1)!.send).toHaveBeenCalledWith("Input.insertText", {
        text: "hello",
      });
      committed.resolve();
      yield* Fiber.join(navigation);
      yield* Fiber.join(correction);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("a queued recording stop drains after its caller expires during navigation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const page = contexts[0]!.page;
      const closed = Promise.withResolvers<void>();
      const encoder = {
        evaluate: vi
          .fn()
          .mockResolvedValueOnce(undefined)
          .mockResolvedValueOnce(true)
          .mockResolvedValueOnce({ mimeType: "video/webm", count: 1, bytes: 5 })
          .mockResolvedValueOnce("ZnJhbWU="),
        close: vi.fn(async () => closed.resolve()),
      };
      const scratchPage = vi
        .spyOn(ServerBrowserContexts.ServerBrowserContexts.prototype, "scratchPage")
        .mockResolvedValue(encoder as unknown as Page);
      yield* Effect.addFinalizer(() => Effect.sync(() => scratchPage.mockRestore()));
      expect(
        yield* broker.invoke({ scope, tabId, operation: "recordingStart", input: {} }),
      ).toMatchObject({ recording: true });
      const session = contexts[0]!.sessions.at(-1)!;
      expect(session.send).toHaveBeenCalledWith("Page.startScreencast", expect.anything());

      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      yield* Effect.addFinalizer(() => Effect.sync(() => release.resolve()));
      page.goto.mockImplementationOnce(async () => {
        started.resolve();
        await release.promise;
      });
      const navigation = yield* broker
        .invoke({
          scope,
          tabId,
          operation: "navigate",
          input: { url: "https://example.test/pending" },
          timeoutMs: 5000,
        })
        .pipe(Effect.forkScoped);
      yield* Effect.promise(() => started.promise);
      const stop = yield* broker
        .invoke({
          scope,
          tabId,
          operation: "recordingStop",
          input: {},
          timeoutMs: 1000,
        })
        .pipe(Effect.flip, Effect.forkScoped);
      // Status marks delivery while navigation retains the serial action queue.
      yield* broker.invoke({ scope, tabId, operation: "status", input: {} });
      yield* TestClock.adjust(1000);
      expect(yield* Fiber.join(stop)).toMatchObject({ _tag: "PreviewAutomationTimeoutError" });
      expect(session.detach).not.toHaveBeenCalled();
      expect(encoder.close).not.toHaveBeenCalled();
      release.resolve();
      yield* Fiber.join(navigation);
      yield* Effect.promise(() => closed.promise);
      expect(session.detach).toHaveBeenCalled();
      expect(encoder.close).toHaveBeenCalledOnce();
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

it.live.each(
  ["headless", "local", "host-a"].flatMap((host) =>
    [false, true].map((fixed) => ({ host, fixed })),
  ),
)(
  "viewer disconnect restores connected fill sizes without changing fixed sizes ($host, $fixed)",
  ({ host, fixed }) =>
    Effect.scoped(
      Effect.gen(function* () {
        if (host !== "headless") {
          profileCatalogue = {
            desktopHostId: host,
            profiles: [{ id: "default", name: "Default", kind: "persistent" }],
            defaultProfileId: "default",
          };
          desktopRendersNext = true;
        }
        const { browser, broker, tabId } = yield* ready;
        const firstScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
          Scope.close(scope, Exit.void),
        );
        const first = yield* browser
          .attachViewer(viewerInput(tabId, true))
          .pipe(Effect.provideService(Scope.Scope, firstScope));
        yield* first.input({ type: "takeControl" });
        yield* first.input({ type: "resize", width: 640, height: 480 });
        if (fixed)
          yield* first.input({
            type: "viewport",
            setting: { _tag: "freeform", width: 390, height: 844 },
          });
        yield* first.input({ type: "releaseControl" });
        const latestScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
          Scope.close(scope, Exit.void),
        );
        const latest = yield* browser
          .attachViewer(viewerInput(tabId, true))
          .pipe(Effect.provideService(Scope.Scope, latestScope));
        yield* latest.input({ type: "takeControl" });
        yield* latest.input({ type: "resize", width: 1200, height: 720 });
        const status = () =>
          broker.invoke<PreviewAutomationStatus>({ scope, tabId, operation: "status", input: {} });
        expect((yield* status()).viewport).toEqual(
          fixed ? { width: 390, height: 844 } : { width: 1200, height: 720 },
        );
        yield* Queue.takeAll(first.output);
        yield* Scope.close(latestScope, Exit.void);
        const remainingSize = fixed ? { width: 390, height: 844 } : { width: 640, height: 480 };
        expect((yield* status()).viewport).toEqual(remainingSize);
        if (!fixed)
          expect(yield* Queue.takeAll(first.output)).toContainEqual({
            _tag: "viewport",
            ...remainingSize,
          });
        yield* Scope.close(firstScope, Exit.void);
        expect((yield* status()).viewport).toEqual(
          fixed ? { width: 390, height: 844 } : { width: 1280, height: 800 },
        );
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
      const saved = yield* Queue.unbounded<string>();
      const written = Promise.withResolvers<void>();
      page.emit("download", {
        failure: async () => null,
        delete: async () => {
          // A new navigation during cleanup must not erase the settled download status.
          page.emit("request", {
            url: () => "https://example.com/next",
            method: () => "GET",
            isNavigationRequest: () => true,
            frame: () => page,
          });
        },
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
      const received = [];
      let status;
      do {
        status = yield* PubSub.take(events);
        received.push(status);
      } while (
        status.type !== "navigated" ||
        status.snapshot.navStatus._tag !== "Loading" ||
        status.snapshot.navStatus.url !== "https://example.com/next"
      );
      expect(received).toContainEqual(
        expect.objectContaining({
          type: "failed",
          url: pdf,
          download: { id: expect.any(String), fileName: "paper.pdf" },
        }),
      );
      expect((yield* Queue.clear(viewer.output)).some((item) => item._tag === "download")).toBe(
        false,
      );
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

it.live("only the controlling viewer's copy and cut keys reach its clipboard", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, tabId } = yield* ready;
      const watcher = yield* browser.attachViewer(viewerInput(tabId, false));
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* viewer.input({ type: "takeControl" });
      const clipboard = (queue: typeof viewer.output) =>
        Queue.clear(queue).pipe(
          Effect.map((items) => items.filter((item) => item._tag === "clipboard")),
        );
      pageCopy = "unprompted";
      yield* viewer.input({ type: "mouse", action: "move", x: 10, y: 10 });
      yield* viewer.input({ type: "wheel", x: 10, y: 10, deltaY: 40 });
      yield* viewer.input({ type: "key", action: "down", key: "v", code: "KeyV", modifiers: 4 });
      yield* viewer.input({ type: "unknown" });
      expect(yield* clipboard(viewer.output)).toEqual([]);
      keyCopy = "copied";
      yield* viewer.input({ type: "key", action: "down", key: "c", code: "KeyC", modifiers: 4 });
      const cdp = contexts[0]!.sessions.at(-1)!;
      expect(cdp.send).toHaveBeenCalledWith(
        "Input.dispatchKeyEvent",
        expect.objectContaining({ key: "c", commands: ["copy"] }),
      );
      expect(yield* clipboard(viewer.output)).toEqual([{ _tag: "clipboard", text: "copied" }]);
      keyCopy = "cut";
      yield* viewer.input({ type: "key", action: "down", key: "x", code: "KeyX", modifiers: 2 });
      expect(yield* clipboard(viewer.output)).toEqual([{ _tag: "clipboard", text: "cut" }]);
      pageCopy = "left over";
      keyCopy = "";
      yield* viewer.input({ type: "key", action: "down", key: "c", code: "KeyC", modifiers: 4 });
      expect(yield* clipboard(viewer.output)).toEqual([]);
      expect(yield* clipboard(watcher.output)).toEqual([]);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live.each([false, true])(
  "a page download is saved, offered to the controller, and listed for the agent (delete fails: %s)",
  (deleteFails) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { browser, broker, tabId } = yield* ready;
        const page = contexts[0]!.page;
        const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
        yield* viewer.input({ type: "takeControl" });
        yield* Queue.clear(viewer.output);
        const fs = yield* FileSystem.FileSystem;
        const original = `${yield* fs.makeTempDirectoryScoped()}/chromium-download`;
        yield* fs.writeFileString(original, "a,b");
        const released = Promise.withResolvers<void>();
        page.emit("download", {
          failure: async () => null,
          delete: async () => {
            try {
              if (deleteFails) throw new Error("context closed");
              await NodeFSP.rm(original);
            } finally {
              released.resolve();
            }
          },
          saveAs: (path: string) => NodeFSP.copyFile(original, path),
          suggestedFilename: () => "report.csv",
          url: () => 'data:text/csv;charset="a,b",a b\'c',
        });
        let offered = yield* Queue.take(viewer.output);
        while (offered._tag !== "download") offered = yield* Queue.take(viewer.output);
        expect(offered).toMatchObject({ _tag: "download", fileName: "report.csv", sizeBytes: 3 });
        yield* Effect.promise(() => released.promise);
        expect(yield* fs.exists(original)).toBe(deleteFails);
        const file = yield* browser.openDownload({
          threadId: scope.thread.threadId,
          tabId,
          downloadId: offered.id,
        });
        expect(Option.isSome(file) && file.value.fileName).toBe("report.csv");
        expect(yield* fs.readFileString(Option.getOrThrow(file).path)).toBe("a,b");
        if ((yield* HostProcess.Platform) !== "win32") {
          expect((yield* fs.stat(Option.getOrThrow(file).path)).mode & 0o777).toBe(0o600);
        }
        const status = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          tabId,
          operation: "status",
          input: {},
        });
        expect(status.downloads).toEqual([
          expect.objectContaining({
            fileName: "report.csv",
            sizeBytes: 3,
            url: "data:text/csv,…",
          }),
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
        if ((yield* HostProcess.Platform) !== "win32") {
          const folder = (yield* Path.Path).dirname(Option.getOrThrow(file).path);
          yield* fs.chmod(folder, 0o755);
          page.emit("download", {
            failure: async () => null,
            delete: async () => {},
            saveAs: (path: string) => NodeFSP.writeFile(path, "c"),
            suggestedFilename: () => "again.csv",
            url: () => "https://example.test/again.csv",
          });
          let again = yield* Queue.take(viewer.output);
          while (again._tag !== "download") again = yield* Queue.take(viewer.output);
          expect((yield* fs.stat(folder)).mode & 0o777).toBe(0o700);
        }
      }),
    ).pipe(Effect.provide(layer)),
);

it.live.each(["save failed", "oversized"])(
  "a rejected download releases the original and keeps no saved copy (%s)",
  (outcome) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { broker, tabId } = yield* ready;
        const fs = yield* FileSystem.FileSystem;
        const original = `${yield* fs.makeTempDirectoryScoped()}/chromium-download`;
        yield* fs.writeFileString(original, "a,b");
        let savedPath: string | undefined;
        const released = Promise.withResolvers<void>();
        contexts[0]!.page.emit("download", {
          failure: async () => null,
          delete: async () => {
            await NodeFSP.rm(original);
            released.resolve();
          },
          saveAs: async (path: string) => {
            savedPath = path;
            await NodeFSP.copyFile(original, path);
            if (outcome === "save failed") throw new Error("save interrupted");
            // A sparse file exercises the size limit without writing a GiB of data.
            await NodeFSP.truncate(path, 1024 ** 3 + 1);
          },
          suggestedFilename: () => "report.csv",
          url: () => "blob:http://localhost:5173/1",
        });
        yield* Effect.promise(() => released.promise);
        expect(yield* fs.exists(original)).toBe(false);
        if (savedPath !== undefined) expect(yield* fs.exists(savedPath)).toBe(false);
        const status = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          tabId,
          operation: "status",
          input: {},
        });
        expect(status.downloads).toEqual([]);
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
      expect(setFiles).toHaveBeenCalledExactlyOnceWith([file("a.csv")]);
      let closed = yield* Queue.take(viewer.output);
      while (closed._tag !== "fileChooserClosed") closed = yield* Queue.take(viewer.output);
      expect(closed.id).toBe(offered.id);
      expect(yield* answer(offered.id)).toBe(false);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("only the current controller can answer a file picker", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, tabId } = yield* ready;
      const first = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* first.input({ type: "takeControl" });
      const setFiles = vi.fn(async (_files: unknown) => {});
      contexts[0]!.page.emit("filechooser", {
        isMultiple: () => false,
        element: () => ({ getAttribute: async () => "" }),
        setFiles,
      });
      let offered = yield* Queue.take(first.output);
      while (offered._tag !== "fileChooser") offered = yield* Queue.take(first.output);
      const second = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* first.input({ type: "releaseControl" });
      yield* second.input({ type: "takeControl" });
      const answered = yield* browser.answerFileChooser({
        threadId: scope.thread.threadId,
        tabId,
        chooserId: offered.id,
        files: [{ name: "a.txt", mimeType: "text/plain", buffer: Buffer.from("a") }],
      });
      expect(answered).toBe(false);
      expect(setFiles).not.toHaveBeenCalled();
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("an idle native popup stays open until deliberately closed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const initial = 1_000_000;
      const clock = vi.spyOn(Date, "now").mockReturnValue(initial);
      yield* Effect.addFinalizer(() => Effect.sync(() => clock.mockRestore()));
      desktopRendersNext = true;
      const { browser, broker, tabId } = yield* ready;
      // Native popup lifetime follows its desktop window, even without a streamed viewer.
      yield* browser.attachViewer(viewerInput(tabId, false));
      const manager = yield* Manager.PreviewManager;
      const events = yield* manager.subscribeEvents;
      const source = {
        threadId: scope.thread.threadId,
        tabId,
        desktopHostId: "local",
        popupId: "idle-popup",
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
      const expired = initial + 31 * 60_000;
      clock.mockReturnValue(expired);
      yield* TestClock.adjust("1 minute");
      expect(popupClosures).toHaveLength(0);
      expect(
        yield* broker.invoke({
          scope,
          tabId: popup.tabId,
          operation: "evaluate",
          input: { expression: "stillOpen()" },
        }),
      ).toBe("evaluated");
      yield* broker.invoke<void>({ scope, tabId: popup.tabId, operation: "close", input: {} });
      expect(popupClosures).toHaveLength(1);
      expect(
        (yield* manager.list({ threadId: scope.thread.threadId })).sessions.some(
          (session) => session.tabId === popup.tabId,
        ),
      ).toBe(false);
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
it.live.each([
  {
    name: "desktop at display ratio 1.5",
    desktop: true,
    page: { ratio: 1.5, width: 1280, height: 800, zoom: 1 },
    scrollY: 0,
    size: { width: 1280, height: 800 },
    clipY: 0,
  },
  {
    name: "desktop resized to a phone",
    desktop: true,
    page: { ratio: 1, width: 390, height: 844, zoom: 1 },
    scrollY: 0,
    size: { width: 390, height: 844 },
    clipY: undefined,
  },
  {
    name: "desktop zoom changes during a scrolled snapshot",
    desktop: true,
    page: { ratio: 3, width: 640, height: 400, zoom: 2 },
    scrollY: 100,
    size: { width: 1280, height: 800 },
    clipY: 200,
  },
  {
    name: "headless",
    desktop: false,
    page: { ratio: 2, width: 1280, height: 800, zoom: 1 },
    scrollY: 0,
    size: { width: 640, height: 400 },
    clipY: 0,
  },
])("snapshot captures the page's own viewport: $name", ({ desktop, page, scrollY, size, clipY }) =>
  Effect.scoped(
    Effect.gen(function* () {
      desktopRendersNext = desktop;
      const { browser, broker, tabId } = yield* ready;
      yield* browser.attachViewer(viewerInput(tabId, false));
      const context = desktop ? desktopConnections[0]!.context : contexts[0]!;
      const display = desktop ? page.ratio / page.zoom : 1;
      let zoom = 1;
      const clips: Array<{ y: number } | undefined> = [];
      let metricsReads = 0;
      for (const session of context.sessions) {
        const send = session.send.getMockImplementation()!;
        session.send.mockImplementation(async (method, input) => {
          if (
            method === "Runtime.evaluate" &&
            String((input as { expression?: string })?.expression).includes("devicePixelRatio")
          ) {
            metricsReads += 1;
            const value = {
              ratio: page.ratio * (zoom / page.zoom),
              width: page.width * (page.zoom / zoom),
              height: page.height * (page.zoom / zoom),
            };
            // Desktop zoom applies after this renderer read, before the next layout reply.
            zoom = page.zoom;
            return { result: { value } };
          }
          if (method === "Page.getLayoutMetrics") {
            return { cssVisualViewport: { pageX: 0, pageY: scrollY, zoom } };
          }
          if (method === "Page.captureScreenshot") {
            const clip = (
              input as { clip?: { y: number; width: number; height: number; scale: number } }
            )?.clip;
            clips.push(clip);
            const header = Buffer.alloc(24);
            header.write("IHDR", 12);
            header.writeUInt32BE(
              Math.round((clip ? clip.width * clip.scale : page.width * page.zoom) * display),
              16,
            );
            header.writeUInt32BE(
              Math.round((clip ? clip.height * clip.scale : page.height * page.zoom) * display),
              20,
            );
            return { data: header.toString("base64") };
          }
          return send(method, input);
        });
      }
      const result = yield* broker.invoke<PreviewAutomationSnapshot>({
        scope,
        tabId,
        operation: "snapshot",
        input: {},
      });
      const png = Buffer.from(result.screenshot!.data, "base64");
      expect(result.screenshot).toMatchObject(size);
      expect({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) }).toEqual(size);
      expect(clips.map((clip) => clip?.y)).toEqual([clipY]);
      if (!desktop) expect(metricsReads).toBe(0);
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

it.live("catalogue timeout and late desktop attachment keep the original native page choice", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* ServerBrowser.ServerBrowser;
      const manager = yield* Manager.PreviewManager;
      const broker = yield* Broker.PreviewAutomationBroker;
      yield* Effect.yieldNow;
      localDesktopAvailable = true;
      profileCatalogue = null;
      yield* broker
        .invoke<void>({ scope, operation: "open", input: { reuseExistingTab: false, show: false } })
        .pipe(Effect.flip);
      const { sessions } = yield* manager.list({ threadId: scope.thread.threadId });
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({ backingPage: "desktop", desktopHostId: "local" });
      expect(contexts).toHaveLength(0);
      expect(desktopConnections).toHaveLength(0);
      desktopTabs.add(sessions[0]!.tabId);
      yield* browser.attachViewer(viewerInput(sessions[0]!.tabId, false));
      expect(desktopConnections).toHaveLength(1);
      expect(contexts).toHaveLength(0);
      expect((yield* manager.list({ threadId: scope.thread.threadId })).sessions[0]).toMatchObject({
        backingPage: "desktop",
        desktopHostId: "local",
      });
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
      // The desktop loads the initial URL from the session snapshot itself.
      expect(initial).toMatchObject({
        desktopHostId: "remote-desktop",
        profileId: "work",
        navStatus: {
          _tag: "Loading",
          url: "http://environment.example.test:5173/start?x=1#section",
        },
      });
      expect(page.goto).not.toHaveBeenCalled();
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
