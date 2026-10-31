import * as NodeEvents from "node:events";
import * as NodeVM from "node:vm";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Playwright download mocks perform real file operations outside the Effect runtime.
import * as NodeFSP from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { it } from "@effect/vitest";
import {
  type BrowserRecordingFrameRate,
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
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type { BrowserContext, Page, Route } from "playwright-core";
import { beforeEach, expect, vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Broker from "../mcp/PreviewAutomationBroker.ts";
import * as DesktopChannel from "./DesktopBrowserChannel.ts";
import * as Manager from "./Manager.ts";
import * as PreviewAgentActivity from "./PreviewAgentActivity.ts";
import * as ServerBrowser from "./ServerBrowser.ts";
import * as ServerBrowserContexts from "./ServerBrowserContexts.ts";
import * as PreviewBrowser from "./PreviewBrowser.ts";
import * as Hosting from "./Hosting.ts";
import * as HostingAuth from "./HostingAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { base64UrlDecodeUtf8, base64UrlEncode, signPayload } from "../auth/utils.ts";

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
      const page = makeEncoderPage();
      encoderPages.push(page);
      if (encoderSetupGate) {
        const evaluate = page.evaluate.getMockImplementation()!;
        page.evaluate.mockImplementation(async (...args) => {
          recordingStageEntered?.resolve();
          await encoderSetupGate?.promise;
          return evaluate(...args);
        });
      }
      if (encoderAcquireGate) recordingStageEntered?.resolve();
      await encoderAcquireGate?.promise;
      return page as unknown as Page;
    }
    async connectDesktopPage(endpoint: string) {
      const context = makeContext();
      context.page.viewportSize.mockReturnValue(null);
      const creation = rootCreations.find((root) => endpoint === `ws://desktop/${root.tabId}`);
      if (creation)
        context.applyNativeRendering({
          ...(creation.viewport === undefined ? {} : { viewport: creation.viewport }),
          viewportSize: { width: 1024, height: 768 },
        });
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

function makeSession(
  frame?: ReturnType<typeof makeFrame>,
  viewport?: () => { width: number; height: number },
  pixelRatio?: () => number,
  zoom?: () => number,
  history?: () => { currentIndex: number; entries: Array<{ url: string }> },
  desktopViewport?: () => { width: number; height: number },
) {
  const events = new NodeEvents.EventEmitter();
  return {
    on: vi.fn((name: string, callback: (...args: unknown[]) => void) => events.on(name, callback)),
    emit: (name: string, ...args: unknown[]) => events.emit(name, ...args),
    emitAsync: (name: string, ...args: unknown[]) =>
      Promise.all(events.listeners(name).map((listener) => listener(...args))),
    detach: vi.fn(async () => {}),
    send: vi.fn(async (method: string, input?: unknown): Promise<Record<string, unknown>> => {
      if (
        method === "Runtime.evaluate" &&
        (input as { expression?: string } | undefined)?.expression === "devicePixelRatio"
      )
        return { result: { value: pixelRatio?.() ?? 2 } };
      if (method === "Page.getNavigationHistory")
        return history?.() ?? { currentIndex: 0, entries: [{}] };
      if (method === "Page.getLayoutMetrics") {
        const size = viewport?.();
        return {
          cssVisualViewport: {
            pageX: 0,
            pageY: 0,
            zoom: zoom?.() ?? 1,
            ...(size ? { clientWidth: size.width, clientHeight: size.height } : {}),
          },
        };
      }
      if (method === "Page.captureScreenshot") {
        if ((input as { format: string }).format !== "png") return { data: "ZnJhbWU=" };
        const size = viewport?.() ?? { width: 1280, height: 800 };
        const ratio = pixelRatio?.() ?? 2;
        const header = Buffer.from(PNG_HEADER, "base64");
        header.writeUInt32BE(Math.round(size.width * ratio), 16);
        header.writeUInt32BE(Math.round(size.height * ratio), 20);
        return { data: header.toString("base64") };
      }
      // Snapshots shrink their screenshot in the page; the header stands in for the result.
      if (method === "Runtime.callFunctionOn") {
        const { arguments: args } = input as { arguments: Array<{ value: string | number }> };
        const header = Buffer.from(args[0]!.value as string, "base64");
        header.writeUInt32BE(args[1]!.value as number, 16);
        header.writeUInt32BE(args[2]!.value as number, 20);
        return { result: { value: header.toString("base64") } };
      }
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
      if (method === "Page.createIsolatedWorld") {
        return {
          executionContextId:
            (input as { worldName?: string }).worldName === "t3-preview-viewport"
              ? 9
              : (input as { worldName?: string }).worldName === "t3-preview"
                ? 1
                : 7,
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
        return {
          result: {
            value: {
              ratio: pixelRatio?.() ?? 2,
              ...(viewport?.() ?? { width: 1280, height: 800 }),
            },
          },
        };
      }
      if (method === "Runtime.evaluate" && (input as { contextId?: number }).contextId === 7) {
        const value = frame ? frame.copy : pageCopy;
        if (frame) frame.copy = "";
        else pageCopy = "";
        return { result: { value } };
      }
      if (method === "Runtime.evaluate" && (input as { contextId?: number }).contextId === 9)
        return desktopSizeAnswer?.() ?? { result: { value: { ...desktopViewport?.() } } };
      return { result: { value: "evaluated" } };
    }),
  };
}

function fileChooserElement(accept: string) {
  return {
    getAttribute: async () => accept,
    evaluate: (probe: (element: { ownerDocument: unknown }) => boolean) =>
      Promise.resolve(
        probe({
          ownerDocument: (globalThis as typeof globalThis & { document?: unknown }).document,
        }),
      ),
  };
}

function makeContext(onClose?: (context: BrowserContext) => void) {
  const events = new NodeEvents.EventEmitter();
  const nativeFileChooser = vi.fn();
  const setChooserFiles = vi.fn(async (_files: unknown) => {});
  const sessions: ReturnType<typeof makeSession>[] = [];
  let url = "about:blank";
  const history = [url];
  let historyIndex = 0;
  const cookies = new Set<string>();
  let viewport = { width: 1280, height: 800 };
  let native = false;
  let zoomFactor = 1;
  const cssViewport = { width: 1920, height: 1080 };
  const layoutViewport = () => ({
    width: Math.round(viewport.width / zoomFactor),
    height: Math.round(viewport.height / zoomFactor),
  });
  let closed = false;
  let contextClosed = false;
  const routes = new Map<(url: URL) => boolean, (route: Route) => Promise<void>>();
  const routedUrl = async (next: string) => {
    let destination = next;
    const url = new URL(next);
    url.hash = "";
    for (const [matches, handler] of routes) {
      if (!matches(url)) continue;
      await handler({
        request: () => ({ isNavigationRequest: () => true, frame: () => page }),
        fulfill: async ({ headers }: { headers: { location: string } }) => {
          destination = headers.location;
        },
        fallback: async () => {},
        abort: async () => {
          throw new Error("Navigation aborted");
        },
      } as unknown as Route);
    }
    return destination;
  };
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
          element: () => fileChooserElement(".csv"),
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
    viewportSize: vi.fn(() => (native ? null : viewport)),
    setViewportSize: vi.fn(async (size: typeof viewport) => {
      viewport = size;
    }),
    goto: vi.fn(async (next: string): Promise<void | null> => {
      url = next;
      history.splice(++historyIndex, history.length, next);
      events.emit("load");
      const pending = initialNavigation;
      initialNavigation = null;
      await pending?.();
    }),
    goBack: vi.fn(async () => {
      historyIndex = Math.max(0, historyIndex - 1);
      url = history[historyIndex] = await routedUrl(history[historyIndex]!);
    }),
    goForward: vi.fn(async () => {
      historyIndex = Math.min(history.length - 1, historyIndex + 1);
      url = history[historyIndex] = await routedUrl(history[historyIndex]!);
    }),
    reload: vi.fn(async () => {
      url = history[historyIndex] = await routedUrl(url);
    }),
    route: async (matches: (url: URL) => boolean, handler: (route: Route) => Promise<void>) => {
      routes.set(matches, handler);
    },
    unroute: async (matches: (url: URL) => boolean) => {
      routes.delete(matches);
    },
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
    cookies,
    request: {
      post: vi.fn(async (url: string, _options: unknown) => {
        await credentialPreparation?.(url);
        cookies.add(new URL(url).origin);
        return { ok: () => true, status: () => 200, dispose: vi.fn(async () => {}) };
      }),
    },
    applyNativeRendering: (input: {
      viewport?: PreviewViewportSetting;
      viewportSize?: { width: number; height: number };
      zoomFactor?: number;
    }) => {
      native = true;
      const size =
        input.viewport && input.viewport._tag !== "fill" ? input.viewport : input.viewportSize;
      if (size) viewport = { width: size.width, height: size.height };
      if (input.zoomFactor !== undefined) zoomFactor = input.zoomFactor;
    },
    page,
    sessions,
    cssViewport,
    newPage: async () => page as unknown as Page,
    grantPermissions: vi.fn(async () => {}),
    newCDPSession: async (target: unknown) => {
      const session = makeSession(
        target === page ? undefined : (target as ReturnType<typeof makeFrame>),
        layoutViewport,
        () => 2 * zoomFactor,
        () => zoomFactor,
        () => ({ currentIndex: historyIndex, entries: history.map((url) => ({ url })) }),
        () => (native ? layoutViewport() : cssViewport),
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

// Runs the real encoder script against fake canvas and MediaRecorder globals.
function makeEncoderPage() {
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage() {}, fillRect() {} }),
    captureStream: (frameRate?: number) => ({ frameRate, getTracks: () => [] }),
  };
  class FakeMediaRecorder {
    static isTypeSupported = (type: string) => type === "video/webm";
    onstart: (() => void) | null = null;
    constructor(stream: { frameRate?: number }, options: { videoBitsPerSecond: number }) {
      encoderStreams.push({
        frameRate: stream.frameRate,
        bitsPerSecond: options.videoBitsPerSecond,
      });
    }
    start() {
      this.onstart?.();
    }
  }
  const sandbox: Record<string, unknown> = {
    document: { createElement: () => canvas },
    Path2D: function Path2D() {},
    MediaRecorder: FakeMediaRecorder,
    createImageBitmap: async () => ({ width: 1280, height: 800, close() {} }),
    atob,
    Blob,
    performance,
  };
  sandbox.window = sandbox;
  const context = NodeVM.createContext(sandbox);
  return {
    ...makeContext().page,
    evaluate: vi.fn(async (script: string | ((arg: unknown) => unknown), arg?: unknown) =>
      typeof script === "string"
        ? NodeVM.runInContext(script, context)
        : NodeVM.runInContext(`(${script.toString()})`, context)(arg),
    ),
  };
}

const contexts: ReturnType<typeof makeContext>[] = [];
const encoderStreams: Array<{ frameRate: number | undefined; bitsPerSecond: number }> = [];
const contextRequests: Array<{ profileId: string; isolated: boolean }> = [];
let contextGate: PromiseWithResolvers<void> | null = null;
let pageCopy = "";
let keyCopy = "";
let focusedFrame: ReturnType<typeof makeFrame> | null = null;
let contextFailure: Error | null = null;
let credentialPreparation: ((url: string) => Promise<void>) | undefined;
let initialNavigation: (() => Promise<void>) | null = null;
let desktopRendersNext = false;
/** Replaces the answer to the desktop page's size reads. */
let desktopSizeAnswer: (() => Promise<Record<string, unknown>>) | null = null;
let localDesktopAvailable = false;
let remoteUrlAvailable = true;
let remoteUrlHostname = "environment.example.test";
let remoteUrlGate: ReturnType<typeof Promise.withResolvers<void>> | null = null;
let remoteUrlEntered: ReturnType<typeof Promise.withResolvers<void>> | null = null;
let encoderAcquireGate: ReturnType<typeof Promise.withResolvers<void>> | null = null;
let encoderSetupGate: ReturnType<typeof Promise.withResolvers<void>> | null = null;
let recordingCdpGate: ReturnType<typeof Promise.withResolvers<void>> | null = null;
let recordingStageEntered: ReturnType<typeof Promise.withResolvers<void>> | null = null;
const encoderPages: Array<ReturnType<typeof makeEncoderPage>> = [];
type ProfileCatalogue = Omit<
  NonNullable<
    Effect.Success<ReturnType<DesktopChannel.DesktopBrowserChannel["Service"]["getProfiles"]>>
  >,
  "supportsNativeRoots"
> & { readonly supportsNativeRoots?: boolean };
let profileCatalogue: ProfileCatalogue | null = null;
let profileCatalogueUnavailable = false;
const profileRequests: Array<{ desktopHostId?: string }> = [];
const profileCatalogues = new Map<string, ProfileCatalogue>();
/** Pages the fake desktop takes back or returns; the channel's streams emit them. */
const desktopDetaches = new NodeEvents.EventEmitter();
let desktopDetachReady = Promise.withResolvers<void>();
let desktopReleased = Promise.withResolvers<void>();
let desktopDetachSubscribed = Promise.withResolvers<void>();
const desktopTabs = new Set<string>();
const desktopRenders = (tabId: string) => {
  if (desktopRendersNext) {
    desktopRendersNext = false;
    desktopTabs.add(tabId);
  }
  return desktopTabs.has(tabId);
};
const releasedDesktopTabs: Array<string> = [];
const desktopTurns = new NodeEvents.EventEmitter();
const desktopConnections: Array<{ endpoint: string; context: ReturnType<typeof makeContext> }> = [];
let desktopPageSetup:
  | ((context: ReturnType<typeof makeContext>, endpoint: string) => Promise<void>)
  | null = null;
const presentedDesktopTabs = new Set<string>();
const renderingDesktopTabs = new Set<string>();
const desktopPresentations = new NodeEvents.EventEmitter();
let desktopPresentationSubscribed = Promise.withResolvers<void>();
const desktopPopupEvents = new NodeEvents.EventEmitter();
let nativePopupCreatedSeen: PromiseWithResolvers<void> | null = null;
let nativePopupClosedSeen: PromiseWithResolvers<void> | null = null;
let nativePopupCloseAttempted: PromiseWithResolvers<void> | null = null;
let desktopPopupHostConnected = true;
let nativePopupCloseFailure: "close-canceled" | null = null;
let nativeCloseChannel: DesktopChannel.DesktopBrowserChannel["Service"] | null = null;
let nativeRootCloseChannel: DesktopChannel.DesktopBrowserChannel["Service"] | null = null;
let nativeRootCreationChannel: DesktopChannel.DesktopBrowserChannel["Service"] | null = null;
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
    serverEpoch: string;
    profileId: string;
    url: string;
    viewport?: PreviewViewportSetting;
  }
> = [];
const rootOwnerReconciliations: Array<{ desktopHostId: string; serverEpoch: string }> = [];
const nativeRootPresence = new Map<string, boolean>();
const nativeRootProbes: Array<DesktopChannel.DesktopTabKey & { rootId: string }> = [];
let nativeRootProbeUnavailable = false;
let nativeRootProbeEntered: PromiseWithResolvers<void> | null = null;
let nativeRootProbeGate: PromiseWithResolvers<void> | null = null;
let nativeRootProbeProcessed: PromiseWithResolvers<void> | null = null;
const rootClosures: Array<DesktopChannel.DesktopTabKey & { rootId: string }> = [];
const rootDiscards: Array<DesktopChannel.DesktopTabKey & { rootId: string }> = [];
const rootAcceptances: Array<DesktopChannel.DesktopTabKey & { rootId: string }> = [];
const rootPublications: Array<DesktopChannel.DesktopTabKey & { rootId: string }> = [];
let rootAcceptanceGate: PromiseWithResolvers<void> | null = null;
let rootAcceptanceEntered: PromiseWithResolvers<void> | null = null;
let rootAcceptanceFailure: DesktopBrowserTransportError | null = null;
let rootPublicationGate: PromiseWithResolvers<void> | null = null;
let rootPublicationEntered: PromiseWithResolvers<void> | null = null;
let rootPublicationFailure: DesktopBrowserTransportError | null = null;
let rootCloseFailure: "close-canceled" | "host-unavailable" | null = null;
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
  viewportSize?: { width: number; height: number };
  zoomFactor?: number;
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
let hostingPreparation: Hosting.PreviewHosting["Service"]["prepareNavigation"] = () =>
  Effect.succeed({ managed: false });
type HostingActivity = Parameters<Hosting.PreviewHosting["Service"]["setActivity"]>[0];
const hostingActivities = new Map<string, HostingActivity>();
let hostingActivityObserved: ((input: HostingActivity) => void) | undefined;
let hostingLeases: ReadonlyArray<Hosting.PreviewHostingLease> = [];
const dependencies = Layer.mergeAll(
  Broker.layer,
  Manager.layer,
  Layer.mock(ServerSecretStore.ServerSecretStore)({
    getOrCreateRandom: () => Effect.succeed(new Uint8Array(32).fill(7)),
  }),
  Layer.mock(Hosting.PreviewHosting)({
    setActivity: (input) =>
      Effect.sync(() => {
        if (input.active) hostingActivities.set(input.activityId, input);
        else hostingActivities.delete(input.activityId);
        hostingActivityObserved?.(input);
      }),
    list: () => Effect.sync(() => hostingLeases),
    prepareNavigation: (input) => Effect.suspend(() => hostingPreparation(input)),
  }),
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
    getProfiles: (input) =>
      Effect.sync(() => {
        profileRequests.push(input);
        const selected =
          input.desktopHostId === undefined
            ? profileCatalogue
            : (profileCatalogues.get(input.desktopHostId) ??
              (profileCatalogue?.desktopHostId === input.desktopHostId ? profileCatalogue : null));
        const catalogue: ProfileCatalogue | null =
          selected ??
          (!profileCatalogueUnavailable &&
          (input.desktopHostId === undefined || input.desktopHostId === "local") &&
          (desktopRendersNext || localDesktopAvailable)
            ? {
                desktopHostId: "local",
                profiles: [{ id: "default", name: "Default", kind: "persistent" as const }],
                defaultProfileId: "default",
              }
            : null);
        return catalogue
          ? { ...catalogue, supportsNativeRoots: catalogue.supportsNativeRoots ?? true }
          : null;
      }),
    resolveUrl: (input) =>
      Effect.promise(async () => {
        remoteUrlEntered?.resolve();
        await remoteUrlGate?.promise;
        return remoteUrlAvailable ? input.url.replace("localhost", remoteUrlHostname) : null;
      }),
    subscribeCommands: () => Stream.empty,
    connectedHosts: nativePopupEvents<string>("host-connected"),
    receiveEvent: () => Effect.void,
    awaitAttached: (key) => Effect.sync(() => desktopRenders(key.tabId)),
    dormant: nativePopupEvents<
      DesktopChannel.DesktopTabKey & { rootId?: string; popupId?: string }
    >("dormant"),
    detached: Stream.callback<{ threadId: string; tabId: string }>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const onDetach = (key: { threadId: string; tabId: string }) =>
            Queue.offerUnsafe(queue, key);
          desktopDetaches.on("detach", onDetach);
          desktopDetachReady.resolve();
          desktopDetachSubscribed.resolve();
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
    isRendering: (key) => renderingDesktopTabs.has(key.tabId),
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
          Effect.filterOrFail(
            () => !nativePopupProbeUnavailable,
            () => new DesktopBrowserTransportError({ reason: "host-unavailable" }),
          ),
          Effect.ensuring(Effect.sync(() => nativePopupProbeProcessed?.resolve())),
        );
      }),
    closedRoots: nativePopupEvents<DesktopChannel.DesktopTabKey & { rootId: string }>(
      "root-closed",
    ),
    reconcileRoots: (desktopHostId, serverEpoch) =>
      Effect.sync(() => {
        rootOwnerReconciliations.push({ desktopHostId, serverEpoch });
      }),
    probeRoot: (key, rootId) =>
      Effect.suspend(() => {
        nativeRootProbes.push({ ...key, rootId });
        if (nativeRootCloseChannel) return nativeRootCloseChannel.probeRoot(key, rootId);
        return Effect.promise(async () => {
          nativeRootProbeEntered?.resolve();
          await nativeRootProbeGate?.promise;
          return nativeRootPresence.get(rootId) ?? true;
        }).pipe(
          Effect.filterOrFail(
            () => !nativeRootProbeUnavailable,
            () => new DesktopBrowserTransportError({ reason: "host-unavailable" }),
          ),
          Effect.ensuring(Effect.sync(() => nativeRootProbeProcessed?.resolve())),
        );
      }),
    createRoot: (key, input) =>
      Effect.suspend(() => {
        rootCreations.push({ ...key, ...input });
        if (nativeRootCreationChannel) return nativeRootCreationChannel.createRoot(key, input);
        const generation = rootCreations.filter((root) => root.tabId === key.tabId).length;
        return desktopRenders(key.tabId)
          ? Effect.succeed(`root-${key.tabId}${generation === 1 ? "" : `-${generation}`}`)
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
            rootAcceptanceFailure
              ? Effect.fail(rootAcceptanceFailure)
              : (nativeRootCreationChannel?.acceptRoot(key, rootId) ?? Effect.void),
          ),
        ),
      ),
    publishRoot: (key, rootId) =>
      Effect.promise(async () => {
        rootPublications.push({ ...key, rootId });
        rootPublicationEntered?.resolve();
        await rootPublicationGate?.promise;
      }).pipe(
        Effect.andThen(
          Effect.suspend(() =>
            rootPublicationFailure
              ? Effect.fail(rootPublicationFailure)
              : (nativeRootCreationChannel?.publishRoot(key, rootId) ?? Effect.void),
          ),
        ),
      ),
    closeRoot: (key, rootId, options) =>
      Effect.suspend(() => {
        rootClosures.push({ ...key, rootId });
        rootCloseAttempted?.resolve();
        if (nativeRootCloseChannel) return nativeRootCloseChannel.closeRoot(key, rootId, options);
        if (
          options?.discardIfOffline &&
          rootCloseFailure === "host-unavailable" &&
          !desktopRenders(key.tabId)
        ) {
          rootDiscards.push({ ...key, rootId });
          return Effect.succeed("discarded" as const);
        }
        if (rootCloseFailure)
          return Effect.fail(new DesktopBrowserTransportError({ reason: rootCloseFailure }));
        desktopPopupEvents.emit("root-closed", { ...key, rootId });
        return Effect.succeed("closed" as const);
      }),
    discardRoot: (key, rootId) =>
      Effect.sync(() => {
        rootDiscards.push({ ...key, rootId });
      }).pipe(
        Effect.andThen(
          Effect.suspend(
            () =>
              (nativeRootCreationChannel ?? nativeRootCloseChannel)?.discardRoot(key, rootId) ??
              Effect.void,
          ),
        ),
      ),
    cancelRootCreation: (key, rootId) =>
      Effect.suspend(() => {
        rootClosures.push({ ...key, rootId });
        rootCloseAttempted?.resolve();
        if (nativeRootCreationChannel)
          return nativeRootCreationChannel.cancelRootCreation(key, rootId);
        desktopPopupEvents.emit("root-closed", { ...key, rootId });
        return Effect.void;
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
            desktopPresentationSubscribed.resolve();
            return listener;
          }),
          (listener) => Effect.sync(() => desktopPresentations.off("presentation", listener)),
        ),
    ).pipe(Stream.tap(() => Effect.sync(() => nativePresentationProcessed?.resolve()))),
    surface: (key, input) =>
      Effect.sync(() => {
        surfaceCalls.push({ tabId: key.tabId, ...input });
        if (input.action === "release") return null;
        if (rootCreations.some((root) => root.tabId === key.tabId))
          desktopConnections
            .find((connection) => connection.endpoint === `ws://desktop/${key.tabId}`)
            ?.context.applyNativeRendering(input);
        if (input.viewportSize) return input.viewportSize;
        if (input.viewport && input.viewport._tag !== "fill") {
          return { width: input.viewport.width, height: input.viewport.height };
        }
        return { width: 1280, height: 800 };
      }).pipe(
        Effect.filterOrFail(
          () => input.action !== "acquire" || surfaceFailure === null,
          () => surfaceFailure!,
        ),
      ),
    endpoint: (key) =>
      Effect.acquireRelease(Effect.succeed(`ws://desktop/${key.tabId}`), () =>
        Effect.sync(() => {
          releasedDesktopTabs.push(key.tabId);
          releasedDesktopSeen?.resolve();
          desktopReleased.resolve();
        }),
      ),
    pointer: () => Effect.void,
    turn: (threadId, active) => Effect.sync(() => desktopTurns.emit("turn", threadId, active)),
  }),
  PreviewAgentActivity.layer,
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
const dormantNativeRoot = Effect.fn("preview.test.dormantNativeRoot")(function* () {
  profileCatalogue = {
    desktopHostId: "host-a",
    profiles: [{ id: "work", name: "Work", kind: "persistent" }],
    defaultProfileId: "work",
  };
  desktopRendersNext = true;
  const opened = yield* ready;
  const manager = yield* Manager.PreviewManager;
  const original = (yield* manager.list({})).sessions[0]!;
  const events = yield* manager.subscribeEvents;
  const released = Promise.withResolvers<void>();
  releasedDesktopSeen = released;
  desktopPopupEvents.emit("dormant", {
    threadId: scope.thread.threadId,
    tabId: opened.tabId,
    desktopHostId: "host-a",
    rootId: original.desktopRootId,
  });
  yield* Stream.fromSubscription(events).pipe(
    Stream.filter(
      (event) =>
        event.type === "navigated" &&
        event.tabId === opened.tabId &&
        event.snapshot.desktopRootId === undefined,
    ),
    Stream.runHead,
  );
  yield* Effect.promise(() => released.promise);
  return { ...opened, manager, saved: (yield* manager.list({})).sessions[0]! };
});
const viewerInput = (tabId: string, canOperate: boolean) => ({
  threadId: scope.thread.threadId,
  tabId,
  canOperate,
  maxWidth: 1280,
  maxHeight: 800,
  quality: 70,
});
/** Fills a viewer's output with frames; resolves once every one of them is acknowledged. */
const stallViewer = (viewer: ServerBrowser.ServerBrowserViewer) => {
  const output = viewer.output as unknown as Queue.Queue<ServerBrowser.ServerBrowserViewerOutput>;
  const acked = Promise.withResolvers<void>();
  let unacked = 0;
  const ack = Effect.sync(() => {
    if (--unacked === 0) acked.resolve();
  });
  while (Queue.offerUnsafe(output, { _tag: "frame", data: Buffer.alloc(0), ack })) unacked++;
  return Effect.promise(() => acked.promise);
};
const viewportSizes = (items: ReadonlyArray<ServerBrowser.ServerBrowserViewerOutput>) =>
  items.flatMap((item) => (item._tag === "viewport" ? [`${item.width}x${item.height}`] : []));
const openDesktopViewer = Effect.gen(function* () {
  const browser = yield* ServerBrowser.ServerBrowser;
  const manager = yield* Manager.PreviewManager;
  desktopRendersNext = true;
  const { tabId } = yield* manager.open({ threadId: scope.thread.threadId, runtime: "server" });
  const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
  const context = desktopConnections[0]!.context;
  const cdp = context.sessions[0]!;
  const resize = (width: number, height: number) => {
    Object.assign(context.cssViewport, { width, height });
    return Effect.promise(() => cdp.emitAsync("Page.frameResized"));
  };
  return { tabId, viewer, context, cdp, resize };
});

beforeEach(() => {
  hostingPreparation = () => Effect.succeed({ managed: false });
  hostingActivities.clear();
  hostingActivityObserved = undefined;
  hostingLeases = [];
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
  encoderStreams.length = 0;
  contextRequests.length = 0;
  contextGate = null;
  contextFailure = null;
  credentialPreparation = undefined;
  initialNavigation = null;
  pageCopy = "";
  keyCopy = "";
  focusedFrame = null;
  desktopTabs.clear();
  desktopDetachSubscribed = Promise.withResolvers<void>();
  desktopPresentationSubscribed = Promise.withResolvers<void>();
  presentedDesktopTabs.clear();
  renderingDesktopTabs.clear();
  nativeRenderingGate = null;
  nativeRenderingEntered = null;
  nativePresentationProcessed = null;
  desktopRendersNext = false;
  desktopSizeAnswer = null;
  desktopDetachReady = Promise.withResolvers<void>();
  desktopReleased = Promise.withResolvers<void>();
  localDesktopAvailable = false;
  profileCatalogue = null;
  profileCatalogueUnavailable = false;
  profileRequests.length = 0;
  profileCatalogues.clear();
  remoteUrlAvailable = true;
  remoteUrlHostname = "environment.example.test";
  releasedDesktopTabs.length = 0;
  desktopConnections.length = 0;
  desktopPageSetup = null;
  popupBindings.length = 0;
  popupClosures.length = 0;
  rootCreations.length = 0;
  rootOwnerReconciliations.length = 0;
  nativeRootPresence.clear();
  nativeRootProbes.length = 0;
  nativeRootProbeUnavailable = false;
  nativeRootProbeEntered = null;
  nativeRootProbeGate = null;
  nativeRootProbeProcessed = null;
  rootClosures.length = 0;
  rootAcceptances.length = 0;
  rootPublications.length = 0;
  rootAcceptanceGate = null;
  rootAcceptanceEntered = null;
  rootAcceptanceFailure = null;
  rootPublicationGate = null;
  rootPublicationEntered = null;
  rootPublicationFailure = null;
  rootCloseFailure = null;
  rootDiscards.length = 0;
  rootCloseAttempted = null;
  releasedDesktopSeen = null;
  nativePopupCreatedSeen = null;
  nativePopupClosedSeen = null;
  nativePopupCloseAttempted = null;
  desktopPopupHostConnected = true;
  nativePopupCloseFailure = null;
  nativeCloseChannel = null;
  nativeRootCloseChannel = null;
  nativeRootCreationChannel = null;
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

it.live("tells the desktop once per thread when its agent turns start and end", () =>
  Effect.gen(function* () {
    yield* ServerBrowser.ServerBrowser;
    const activity = yield* PreviewAgentActivity.PreviewAgentActivity;
    const threadId = scope.thread.threadId;
    const turns = yield* Queue.unbounded<readonly [string, boolean]>();
    const record = (id: string, active: boolean) => Queue.offerUnsafe(turns, [id, active]);
    desktopTurns.on("turn", record);
    yield* Effect.addFinalizer(() => Effect.sync(() => desktopTurns.off("turn", record)));
    const endFirst = yield* activity.begin(threadId);
    // An overlapping turn on the same thread neither starts nor ends focus on its own.
    const endSecond = yield* activity.begin(threadId);
    expect(yield* Queue.take(turns)).toEqual([threadId, true]);
    yield* endFirst;
    yield* endFirst;
    expect(yield* activity.active(threadId)).toBe(true);
    yield* endSecond;
    expect(yield* Queue.take(turns)).toEqual([threadId, false]);
    expect(yield* Queue.size(turns)).toBe(0);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.live("preview_open reports its navigation timeout instead of the request budget", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker } = yield* ready;
      initialNavigation = async () => {
        throw Object.assign(new Error("page.goto: Timeout 15000ms exceeded."), {
          name: "TimeoutError",
        });
      };

      const error = yield* broker
        .invoke<PreviewAutomationStatus>({
          scope,
          operation: "open",
          input: {
            url: "http://localhost:1337/",
            reuseExistingTab: false,
            show: false,
          },
        })
        .pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "PreviewAutomationTimeoutError",
        timeoutMs: 15_000,
      });
      expect(error.message).toBe("Preview automation open timed out after 15000ms.");
    }),
  ).pipe(Effect.provide(layer)),
);

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
        const reused = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          operation: "open",
          input: { open: false },
        });
        expect(reused.tabId).toBe(tabId);
      }),
    ).pipe(Effect.provide(layer)),
);

it.effect("a tab the desktop does not draw is marked headless, so the desktop streams it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const manager = yield* Manager.PreviewManager;
      desktopRendersNext = true;
      const desktopTab = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "open",
        input: { browserHost: "desktop", reuseExistingTab: false, show: false },
      });
      const { sessions } = yield* manager.list({ threadId: scope.thread.threadId });
      const headlessOf = (id: string | null) =>
        sessions.find((session) => session.tabId === id)?.headless;

      expect(headlessOf(tabId)).toBe(true);
      expect(headlessOf(desktopTab.tabId)).toBeUndefined();
    }),
  ).pipe(Effect.provide(layer)),
);

it.live.each(["headless", "local", "remote"] as const)(
  "recovers owned opens and installs auth only in the selected profile: %s",
  (host) =>
    Effect.scoped(
      Effect.gen(function* () {
        const native = host !== "headless";
        const remote = host === "remote";
        const prepared: Array<{ threadId: string; url: string }> = [];
        hostingPreparation = (input) =>
          Effect.sync(() => {
            prepared.push(input);
            return { managed: true, bootstrapToken: "fixture-one-use-credential" };
          });
        if (native) {
          profileCatalogue = {
            desktopHostId: remote ? "fixture-desktop" : "local",
            profiles: [{ id: "fixture-profile", name: "Fixture profile", kind: "persistent" }],
            defaultProfileId: "fixture-profile",
          };
          desktopRendersNext = true;
        }
        const broker = yield* Broker.PreviewAutomationBroker;
        const manager = yield* Manager.PreviewManager;
        yield* Effect.yieldNow;
        const url = "http://localhost:5173/qa/nested?theme=dark#section";
        const browserUrl = remote ? url.replace("localhost", "environment.example.test") : url;
        const opened = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          operation: native ? "openWithProfile" : "open",
          input: {
            url,
            open: false,
            reuseExistingTab: false,
            ...(native ? { profileName: "Fixture profile" } : {}),
          },
        });
        const selected = native ? desktopConnections[0]!.context : contexts[0]!;
        expect(prepared).toEqual([
          { threadId: testThread.threadId, url, ...(remote ? { browserUrl } : {}) },
        ]);
        expect(selected.request.post).toHaveBeenCalledWith(
          new URL("/api/auth/browser-session", browserUrl).href,
          expect.objectContaining({
            maxRedirects: 0,
            data: { credential: "fixture-one-use-credential" },
          }),
        );
        expect(selected.cookies).toEqual(new Set([new URL(browserUrl).origin]));
        expect(selected.page.goto).toHaveBeenCalledExactlyOnceWith(browserUrl, expect.any(Object));
        expect(opened.url).toBe(browserUrl);
        expect(JSON.stringify(opened)).not.toContain("fixture-one-use");
        expect(
          JSON.stringify(yield* manager.list({ threadId: testThread.threadId })),
        ).not.toContain("fixture-one-use");
        expect(
          contexts
            .filter((context) => context !== selected)
            .every((context) => context.cookies.size === 0),
        ).toBe(true);
      }),
    ).pipe(Effect.provide(layer)),
);

it.live("returns the actionable shared-route failure to the browser caller", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      hostingPreparation = () =>
        Effect.fail(
          new HostingAuth.PreviewHostingAuthError({
            reason: "bootstrap_failed",
            boundary: "browser_descriptor",
          }),
        );
      const result = yield* Effect.result(
        broker.invoke({
          scope,
          tabId,
          operation: "navigate",
          input: { url: "http://localhost:5173/qa" },
        }),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure.message).toContain("descriptor");
        expect(result.failure.message).toContain("--share");
        expect(result.failure.message).toContain("HTTPS");
        expect(result.failure.message).not.toContain("localhost");
      }
    }),
  ).pipe(Effect.provide(layer)),
);

it.live.each(["environment.example.test", "127.0.0.1", "192.0.2.20"])(
  "retains the owned HTTP origin after a first cold HTTPS native open (connection host: %s)",
  (connectionHost) =>
    Effect.scoped(
      Effect.gen(function* () {
        remoteUrlHostname = connectionHost;
        profileCatalogue = {
          desktopHostId: "fixture-desktop",
          profiles: [{ id: "fixture-profile", name: "Fixture profile", kind: "persistent" }],
          defaultProfileId: "fixture-profile",
        };
        desktopRendersNext = true;
        const localUrl = "http://localhost:5173/qa?mode=dark#anchor";
        const browserUrl = "https://environment.example.test:5173/qa?mode=dark#anchor";
        const prepared: Array<{ threadId: string; url: string; browserUrl?: string }> = [];
        hostingPreparation = (input) =>
          Effect.sync(() => {
            prepared.push(input);
            return {
              managed: true,
              ...(input.url === browserUrl ? { localUrl } : {}),
              bootstrapToken: "fixture-one-use-credential",
            };
          });
        const broker = yield* Broker.PreviewAutomationBroker;
        yield* Effect.yieldNow;
        expect(desktopConnections).toHaveLength(0);
        const opened = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          operation: "openWithProfile",
          input: {
            profileName: "Fixture profile",
            url: browserUrl,
            open: false,
            reuseExistingTab: false,
          },
        });
        const selected = desktopConnections[0]!.context;
        expect(selected.request.post).toHaveBeenCalledExactlyOnceWith(
          "https://environment.example.test:5173/api/auth/browser-session",
          expect.objectContaining({
            data: { credential: "fixture-one-use-credential" },
            maxRedirects: 0,
          }),
        );
        expect(selected.cookies).toEqual(new Set(["https://environment.example.test:5173"]));
        expect(selected.page.goto).toHaveBeenCalledExactlyOnceWith(browserUrl, expect.any(Object));
        const nextBrowserUrl = browserUrl.replace("/qa?", "/qa/next?");
        const nextLocalUrl = localUrl.replace("/qa?", "/qa/next?");
        yield* broker.invoke({
          scope,
          tabId: opened.tabId!,
          operation: "navigate",
          input: { url: nextBrowserUrl },
        });
        expect(prepared).toEqual([
          { threadId: testThread.threadId, url: browserUrl },
          { threadId: testThread.threadId, url: nextLocalUrl, browserUrl: nextBrowserUrl },
        ]);
        expect(selected.page.url()).toBe(nextBrowserUrl);
        expect(selected.request.post).toHaveBeenCalledTimes(2);

        const browser = yield* ServerBrowser.ServerBrowser;
        const viewer = yield* browser.attachViewer(viewerInput(opened.tabId!, true));
        yield* viewer.input({ type: "takeControl" });
        for (const ignoreCache of [false, true]) {
          const reloaded = Promise.withResolvers<void>();
          const reload = selected.page.reload.getMockImplementation()!;
          selected.page.reload.mockImplementationOnce(async () => {
            await reload();
            reloaded.resolve();
          });
          for (const session of selected.sessions) {
            const send = session.send.getMockImplementation()!;
            session.send.mockImplementation(async (method, input) => {
              if (method === "Page.reload") reloaded.resolve();
              return send(method, input);
            });
          }
          yield* viewer.input({ type: "reload", ignoreCache });
          yield* Effect.promise(() => reloaded.promise);
          expect(selected.page.url()).toBe(nextBrowserUrl);
        }
        for (const delta of [-1, 1] as const) {
          const committed = Promise.withResolvers<void>();
          const method = delta < 0 ? "goBack" : "goForward";
          const navigate = selected.page[method].getMockImplementation()!;
          selected.page[method].mockImplementationOnce(async () => {
            await navigate();
            committed.resolve();
          });
          yield* viewer.input({ type: "history", delta });
          yield* Effect.promise(() => committed.promise);
          expect(selected.page.url()).toBe(delta < 0 ? browserUrl : nextBrowserUrl);
        }
        expect(prepared.slice(3)).toEqual(
          [nextLocalUrl, nextLocalUrl, localUrl, nextLocalUrl].map((url) => ({
            threadId: testThread.threadId,
            url,
            browserUrl: url.replace("http://localhost", "https://environment.example.test"),
          })),
        );
        expect(selected.request.post).toHaveBeenCalledTimes(7);
        expect(selected.cookies).toEqual(new Set(["https://environment.example.test:5173"]));
      }),
    ).pipe(Effect.provide(layer)),
);

it.live.each(["open", "openWithProfile", "navigate"] as const)(
  "%s passes both origins to hosting and cannot navigate after identity rejection",
  (operation) =>
    Effect.scoped(
      Effect.gen(function* () {
        profileCatalogue = {
          desktopHostId: "fixture-desktop",
          profiles: [{ id: "fixture-profile", name: "Fixture profile", kind: "persistent" }],
          defaultProfileId: "fixture-profile",
        };
        desktopRendersNext = true;
        const { broker, tabId } = yield* ready;
        const manager = yield* Manager.PreviewManager;
        const owned = "http://localhost:5173/qa/nested?theme=dark#anchor";
        const unowned = owned.replace("localhost", "environment.example.test");
        const prepared: Array<{ threadId: string; url: string; browserUrl?: string }> = [];
        hostingPreparation = (input) =>
          Effect.sync(() => {
            prepared.push(input);
          }).pipe(
            Effect.andThen(new HostingAuth.PreviewHostingAuthError({ reason: "bootstrap_failed" })),
          );
        const result = yield* Effect.result(
          broker.invoke({
            scope,
            ...(operation === "navigate" ? { tabId } : {}),
            operation,
            input: {
              url: owned,
              open: false,
              reuseExistingTab: false,
              ...(operation === "openWithProfile" ? { profileName: "Fixture profile" } : {}),
            },
          }),
        );
        expect(new URL(owned).port).toBe(new URL(unowned).port);
        expect(new URL(owned).origin).not.toBe(new URL(unowned).origin);
        expect(prepared).toEqual([
          { threadId: testThread.threadId, url: owned, browserUrl: unowned },
        ]);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure")
          expect(result.failure._tag).toBe("PreviewAutomationExecutionError");
        expect(JSON.stringify(result)).not.toContain("fixture-private-credential");
        expect(desktopConnections).toHaveLength(1);
        expect(desktopConnections[0]!.context.request.post).not.toHaveBeenCalled();
        expect(desktopConnections[0]!.context.cookies.size).toBe(0);
        expect(desktopConnections[0]!.context.page.goto).not.toHaveBeenCalled();
        expect((yield* manager.list({ threadId: testThread.threadId })).sessions).toHaveLength(1);
        expect(contexts.every((context) => context.cookies.size === 0)).toBe(true);
      }),
    ).pipe(Effect.provide(layer)),
);

it.live(
  "prepares environment-port navigation and both viewer reloads without changing the destination",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { browser, broker, tabId } = yield* ready;
        const prepared: string[] = [];
        hostingPreparation = ({ url }) =>
          Effect.sync(() => {
            prepared.push(url);
            return { managed: true };
          });
        const url = "http://localhost:5173/qa?mode=one#anchor";
        const navigated = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          tabId,
          operation: "navigate",
          input: { target: { kind: "environment-port", port: 5173, path: "/qa?mode=one#anchor" } },
        });
        expect(navigated.url).toBe(url);
        const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
        yield* viewer.input({ type: "takeControl" });
        const reloaded = Promise.withResolvers<void>();
        contexts[0]!.page.reload.mockImplementationOnce(async () => reloaded.resolve());
        yield* viewer.input({ type: "reload" });
        yield* Effect.promise(() => reloaded.promise);
        const hardReloaded = Promise.withResolvers<void>();
        const cdp = contexts[0]!.sessions.at(-1)!;
        const send = cdp.send.getMockImplementation()!;
        cdp.send.mockImplementation(async (method, input) => {
          if (method === "Page.reload") hardReloaded.resolve();
          return send(method, input);
        });
        yield* viewer.input({ type: "reload", ignoreCache: true });
        yield* Effect.promise(() => hardReloaded.promise);
        expect(prepared).toEqual([url, url, url, url]);
        expect(contexts[0]!.page.reload).toHaveBeenCalledOnce();
        expect(
          contexts[0]!.sessions.some((session) =>
            session.send.mock.calls.some(
              ([method, input]) =>
                method === "Page.reload" &&
                (input as { ignoreCache?: boolean })?.ignoreCache === true,
            ),
          ),
        ).toBe(true);
      }),
    ).pipe(Effect.provide(layer)),
);

it.live("reload recovers both owned remote origins after returning through public history", () =>
  Effect.scoped(
    Effect.gen(function* () {
      profileCatalogue = {
        desktopHostId: "fixture-desktop",
        profiles: [{ id: "fixture-profile", name: "Fixture profile", kind: "persistent" }],
        defaultProfileId: "fixture-profile",
      };
      desktopRendersNext = true;
      const { browser, broker, tabId } = yield* ready;
      const context = desktopConnections[0]!.context;
      const prepared: string[] = [];
      hostingPreparation = ({ url }) =>
        Effect.sync(() => {
          prepared.push(url);
          return { managed: new URL(url).hostname === "localhost" };
        });
      const destinations = [
        "http://localhost:5173/qa/first?mode=dark#first",
        "http://localhost:5180/qa/second?mode=light#second",
        "https://public.example/other",
      ];
      for (const url of destinations)
        yield* broker.invoke({ scope, tabId, operation: "navigate", input: { url } });
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* viewer.input({ type: "takeControl" });
      for (const url of destinations.slice(0, 2).toReversed()) {
        const wentBack = Promise.withResolvers<void>();
        const goBack = context.page.goBack.getMockImplementation()!;
        context.page.goBack.mockImplementationOnce(async () => {
          await goBack();
          wentBack.resolve();
        });
        yield* viewer.input({ type: "history", delta: -1 });
        yield* Effect.promise(() => wentBack.promise);
        const reloaded = Promise.withResolvers<void>();
        context.page.reload.mockImplementationOnce(async () => reloaded.resolve());
        yield* viewer.input({ type: "reload" });
        yield* Effect.promise(() => reloaded.promise);
        expect(context.page.url()).toBe(url.replace("localhost", "environment.example.test"));
      }
      expect(prepared).toEqual([
        ...destinations,
        "http://localhost:5180/qa/second?mode=light#second",
        "http://localhost:5180/qa/second?mode=light#second",
        "http://localhost:5173/qa/first?mode=dark#first",
        "http://localhost:5173/qa/first?mode=dark#first",
      ]);
      expect(context.page.reload).toHaveBeenCalledTimes(2);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live.each(["local", "remote", "changed address"])(
  "client hard reload prepares managed access before reloading (%s)",
  (connection) =>
    Effect.scoped(
      Effect.gen(function* () {
        const remote = connection !== "local";
        if (remote) {
          profileCatalogue = {
            desktopHostId: "fixture-desktop",
            profiles: [{ id: "fixture-profile", name: "Fixture profile", kind: "persistent" }],
            defaultProfileId: "fixture-profile",
          };
          desktopRendersNext = true;
        }
        const { broker, tabId } = yield* ready;
        const context = remote ? desktopConnections[0]!.context : contexts[0]!;
        const url = "http://localhost:5173/qa/reload?mode=dark#anchor";
        hostingPreparation = () => Effect.succeed({ managed: true });
        yield* broker.invoke({ scope, tabId, operation: "navigate", input: { url } });
        if (connection === "changed address")
          remoteUrlHostname = "updated-environment.example.test";
        const events: string[] = [];
        const prepared: Array<{ threadId: string; url: string; browserUrl?: string }> = [];
        hostingPreparation = (input) =>
          Effect.sync(() => {
            events.push("recovered");
            prepared.push(input);
            return { managed: true, bootstrapToken: "fixture-one-use-credential" };
          });
        const post = context.request.post.getMockImplementation()!;
        context.request.post.mockImplementationOnce(async (...args) => {
          events.push("authenticated");
          return post(...args);
        });
        const reloaded = Promise.withResolvers<void>();
        const reload = context.page.reload.getMockImplementation()!;
        context.page.reload.mockImplementationOnce(async () => {
          await reload();
          events.push("reloaded");
          reloaded.resolve();
        });
        const cdp = context.sessions[0]!;
        const send = cdp.send.getMockImplementation()!;
        cdp.send.mockImplementation(async (method, input) => {
          if (method === "Network.clearBrowserCookies") events.push("cleared");
          if (method === "Page.reload") {
            events.push("reloaded");
            reloaded.resolve();
          }
          return send(method, input);
        });
        const manager = yield* Manager.PreviewManager;
        yield* manager.adjust({
          threadId: scope.thread.threadId,
          tabId,
          clear: "cookies",
          hardReload: true,
        });
        yield* Effect.promise(() => reloaded.promise);
        const browserUrl = remote ? url.replace("localhost", remoteUrlHostname) : url;
        expect(prepared).toEqual([
          { threadId: scope.thread.threadId, url, ...(remote ? { browserUrl } : {}) },
        ]);
        expect(events).toEqual(["cleared", "recovered", "authenticated", "reloaded"]);
        expect(context.request.post).toHaveBeenCalledExactlyOnceWith(
          new URL("/api/auth/browser-session", browserUrl).href,
          expect.objectContaining({ data: { credential: "fixture-one-use-credential" } }),
        );
        if (connection === "changed address") {
          expect(context.page.url()).toBe(browserUrl);
          expect(context.page.reload).toHaveBeenCalledOnce();
          expect(cdp.send).not.toHaveBeenCalledWith("Page.reload", expect.anything());
        } else expect(cdp.send).toHaveBeenCalledWith("Page.reload", { ignoreCache: true });
      }),
    ).pipe(Effect.provide(layer)),
);

it.live.each([
  [-1, false],
  [1, false],
  [-1, true],
  [1, true],
] as const)(
  "history delta %s prepares the managed destination before navigation (address changed: %s)",
  ([delta, changed]) =>
    Effect.scoped(
      Effect.gen(function* () {
        profileCatalogue = {
          desktopHostId: "fixture-desktop",
          profiles: [{ id: "fixture-profile", name: "Fixture profile", kind: "persistent" }],
          defaultProfileId: "fixture-profile",
        };
        desktopRendersNext = true;
        const { browser, broker, tabId } = yield* ready;
        const context = desktopConnections[0]!.context;
        const url = "http://localhost:5173/qa/history?mode=dark#anchor";
        hostingPreparation = ({ url }) =>
          Effect.succeed({ managed: new URL(url).hostname === "localhost" });
        yield* broker.invoke({ scope, tabId, operation: "navigate", input: { url } });
        yield* broker.invoke({
          scope,
          tabId,
          operation: "navigate",
          input: { url: "https://public.example/other" },
        });
        if (delta > 0) {
          yield* Effect.promise(() => context.page.goBack());
          yield* Effect.promise(() => context.page.goBack());
        }
        if (changed) remoteUrlHostname = "updated-environment.example.test";
        const events: string[] = [];
        const prepared: Array<{ threadId: string; url: string; browserUrl?: string }> = [];
        hostingPreparation = (input) =>
          Effect.sync(() => {
            events.push("recovered");
            prepared.push(input);
            return { managed: true, bootstrapToken: "fixture-one-use-credential" };
          });
        const post = context.request.post.getMockImplementation()!;
        context.request.post.mockImplementationOnce(async (...args) => {
          events.push("authenticated");
          return post(...args);
        });
        const method = delta < 0 ? "goBack" : "goForward";
        const navigate = context.page[method].getMockImplementation()!;
        const committed = Promise.withResolvers<void>();
        context.page[method].mockImplementationOnce(async () => {
          await navigate();
          events.push("navigated");
          committed.resolve();
        });
        const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
        yield* viewer.input({ type: "takeControl" });
        yield* viewer.input({ type: "history", delta });
        yield* Effect.promise(() => committed.promise);
        const browserUrl = url.replace("localhost", remoteUrlHostname);
        expect(context.page.url()).toBe(browserUrl);
        expect(prepared).toEqual([{ threadId: scope.thread.threadId, url, browserUrl }]);
        expect(events).toEqual(["recovered", "authenticated", "navigated"]);
        expect(context.request.post).toHaveBeenCalledExactlyOnceWith(
          new URL("/api/auth/browser-session", browserUrl).href,
          expect.objectContaining({ data: { credential: "fixture-one-use-credential" } }),
        );
      }),
    ).pipe(Effect.provide(layer)),
);

it.live.each(["open", "openWithProfile", "navigate", "viewer"] as const)(
  "%s recovers reentered remote URLs and path edits using the verified local origin",
  (operation) =>
    Effect.scoped(
      Effect.gen(function* () {
        profileCatalogue = {
          desktopHostId: "fixture-desktop",
          profiles: [{ id: "fixture-profile", name: "Fixture profile", kind: "persistent" }],
          defaultProfileId: "fixture-profile",
        };
        desktopRendersNext = true;
        const { browser, broker, tabId } = yield* ready;
        const context = desktopConnections[0]!.context;
        const prepared: Array<{ threadId: string; url: string; browserUrl?: string }> = [];
        hostingPreparation = (input) =>
          Effect.sync(() => {
            prepared.push(input);
            return new URL(input.url).origin === "http://localhost:5173"
              ? { managed: true, bootstrapToken: "fixture-one-use-credential" }
              : { managed: false };
          });
        const owned = "http://localhost:5173/qa/original?mode=one#first";
        const localUrls = [owned, "http://localhost:5173/qa/edited?mode=two#second"];
        yield* broker.invoke({ scope, tabId, operation: "navigate", input: { url: owned } });
        const viewer =
          operation === "viewer"
            ? yield* browser.attachViewer(viewerInput(tabId, true))
            : undefined;
        if (viewer) yield* viewer.input({ type: "takeControl" });
        for (const localUrl of localUrls) {
          const browserUrl = localUrl.replace("localhost", "environment.example.test");
          if (viewer) {
            const committed = Promise.withResolvers<void>();
            const goto = context.page.goto.getMockImplementation()!;
            context.page.goto.mockImplementationOnce(async (url) => {
              await goto(url);
              committed.resolve();
            });
            yield* viewer.input({ type: "navigate", url: browserUrl });
            yield* Effect.promise(() => committed.promise);
          } else {
            yield* broker.invoke({
              scope,
              tabId,
              operation: operation === "viewer" ? "navigate" : operation,
              input: {
                url: browserUrl,
                open: false,
                ...(operation === "openWithProfile" ? { profileName: "Fixture profile" } : {}),
              },
            });
          }
          expect(context.page.url()).toBe(browserUrl);
        }
        expect(prepared).toEqual(
          [owned, ...(viewer ? [owned] : []), ...localUrls].map((url) => ({
            threadId: testThread.threadId,
            url,
            browserUrl: url.replace("localhost", "environment.example.test"),
          })),
        );
        expect(context.request.post).toHaveBeenCalledTimes(viewer ? 4 : 3);
        expect(context.request.post).toHaveBeenLastCalledWith(
          "http://environment.example.test:5173/api/auth/browser-session",
          expect.objectContaining({ data: { credential: "fixture-one-use-credential" } }),
        );
        expect(desktopConnections).toHaveLength(1);
      }),
    ).pipe(Effect.provide(layer)),
);

it.live.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true],
] as const)(
  "reattached desktop sessions retain verified origins for reload (ignoreCache=%s, address changed=%s)",
  ([ignoreCache, changed]) =>
    Effect.scoped(
      Effect.gen(function* () {
        profileCatalogue = {
          desktopHostId: "fixture-desktop",
          profiles: [{ id: "fixture-profile", name: "Fixture profile", kind: "persistent" }],
          defaultProfileId: "fixture-profile",
        };
        desktopRendersNext = true;
        const { browser, broker, tabId } = yield* ready;
        const prepared: Array<{ threadId: string; url: string; browserUrl?: string }> = [];
        hostingPreparation = (input) =>
          Effect.sync(() => {
            prepared.push(input);
            return new URL(input.url).origin === "http://localhost:5173"
              ? { managed: true, bootstrapToken: "fixture-one-use-credential" }
              : { managed: false };
          });
        const localUrl = "http://localhost:5173/qa/retained?mode=dark#anchor";
        const browserUrl = localUrl.replace("localhost", "environment.example.test");
        nativeNavigationReported = { status: "Success", completed: Promise.withResolvers<void>() };
        yield* broker.invoke({ scope, tabId, operation: "navigate", input: { url: localUrl } });
        yield* Effect.promise(() => nativeNavigationReported!.completed.promise);
        const previous = desktopConnections[0]!.context;
        const viewer = yield* browser.attachViewer(viewerInput(tabId, false));
        desktopPageSetup = async (context) => {
          await context.page.goto(previous.page.url());
          context.page.goto.mockClear();
        };
        desktopDetaches.emit("detach", {
          threadId: testThread.threadId,
          tabId,
          desktopHostId: "fixture-desktop",
        });
        let ending = yield* Queue.take(viewer.output);
        while (ending._tag !== "reconnect") ending = yield* Queue.take(viewer.output);
        desktopDetaches.emit("attach", {
          threadId: testThread.threadId,
          tabId,
          desktopHostId: "fixture-desktop",
        });
        const reattached = yield* browser.attachViewer(viewerInput(tabId, true));
        yield* reattached.input({ type: "takeControl" });
        const current = desktopConnections[1]!.context;
        if (changed) remoteUrlHostname = "updated-environment.example.test";
        const resolvedUrl = localUrl.replace("localhost", remoteUrlHostname);
        const reloaded = Promise.withResolvers<void>();
        if (ignoreCache) {
          const cdp = current.sessions.at(-1)!;
          const send = cdp.send.getMockImplementation()!;
          cdp.send.mockImplementation(async (method, input) => {
            if (method === "Page.reload") reloaded.resolve();
            return send(method, input);
          });
        }
        const reload = current.page.reload.getMockImplementation()!;
        current.page.reload.mockImplementationOnce(async () => {
          await reload();
          reloaded.resolve();
        });
        yield* reattached.input({ type: "reload", ignoreCache });
        yield* Effect.promise(() => reloaded.promise);
        expect(current.page.url()).toBe(resolvedUrl);
        expect(prepared).toEqual([
          { threadId: testThread.threadId, url: localUrl, browserUrl },
          { threadId: testThread.threadId, url: localUrl, browserUrl },
          { threadId: testThread.threadId, url: localUrl, browserUrl },
          { threadId: testThread.threadId, url: localUrl, browserUrl: resolvedUrl },
        ]);
        expect(current.request.post).toHaveBeenCalledTimes(2);
        expect(current.request.post).toHaveBeenLastCalledWith(
          new URL("/api/auth/browser-session", resolvedUrl).href,
          expect.objectContaining({ data: { credential: "fixture-one-use-credential" } }),
        );
        expect(previous.page.close).not.toHaveBeenCalled();
      }),
    ).pipe(Effect.provide(layer)),
);

it.live("cancelled authentication drains cookie writes before takeover and typing", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, broker, tabId } = yield* ready;
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      const context = contexts[0]!;
      const entered = Promise.withResolvers<void>();
      const response = Promise.withResolvers<void>();
      const events: string[] = [];
      hostingPreparation = () =>
        Effect.succeed({ managed: true, bootstrapToken: "fixture-delayed-credential" });
      context.request.post.mockImplementationOnce(async (url) => {
        entered.resolve();
        await response.promise;
        context.cookies.add(new URL(url).origin);
        events.push("cookie written");
        return {
          ok: () => true,
          status: () => 200,
          dispose: vi.fn(async () => {
            events.push("response disposed");
          }),
        };
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => response.resolve()));
      const request = yield* broker
        .invoke({ scope, tabId, operation: "navigate", input: { url: "http://localhost:5173/qa" } })
        .pipe(Effect.forkScoped);
      yield* Effect.promise(() => entered.promise);
      yield* Fiber.interrupt(request);
      yield* Queue.clear(viewer.output);
      const takeover = yield* viewer.input({ type: "takeControl" }).pipe(Effect.forkScoped);
      let control = yield* Queue.take(viewer.output);
      while (control._tag !== "control") control = yield* Queue.take(viewer.output);
      expect(control).toMatchObject({ controller: "taking-control" });
      const cdp = context.sessions.at(-1)!;
      const send = cdp.send.getMockImplementation()!;
      cdp.send.mockImplementation(async (method, input) => {
        if (method === "Input.insertText") events.push("human typed");
        return send(method, input);
      });
      const typing = yield* viewer.input({ type: "text", text: "hello" }).pipe(Effect.forkScoped);
      yield* broker.invoke({ scope, tabId, operation: "status", input: {} });
      expect(events).toEqual([]);
      response.resolve();
      yield* Fiber.join(takeover);
      expect(yield* Queue.takeAll(viewer.output)).toContainEqual(
        expect.objectContaining({ _tag: "control", controller: "you" }),
      );
      yield* Fiber.join(typing);
      expect(events).toEqual(["cookie written", "response disposed", "human typed"]);
      expect(context.page.goto).not.toHaveBeenCalled();
    }),
  ).pipe(Effect.provide(layer)),
);

it.live.each(["navigate", "history"] as const)(
  "a newer viewer %s cancels preparation without blocking input",
  (type) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { browser, tabId } = yield* ready;
        const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
        yield* viewer.input({ type: "takeControl" });
        const entered = Promise.withResolvers<void>();
        const interrupted = Promise.withResolvers<void>();
        const committed = Promise.withResolvers<void>();
        const slowUrl = "http://localhost:5173/slow";
        hostingPreparation = ({ url }) =>
          url === slowUrl
            ? Effect.sync(() => entered.resolve()).pipe(
                Effect.andThen(Effect.never),
                Effect.onInterrupt(() => Effect.sync(() => interrupted.resolve())),
              )
            : Effect.succeed({ managed: false });
        yield* viewer.input({ type: "navigate", url: slowUrl });
        yield* Effect.promise(() => entered.promise);
        yield* viewer.input({ type: "text", text: "hello" });
        expect(contexts[0]!.sessions.at(-1)!.send).toHaveBeenCalledWith("Input.insertText", {
          text: "hello",
        });
        const corrected = "https://public.example/corrected?mode=dark#anchor";
        if (type === "navigate") {
          const goto = contexts[0]!.page.goto.getMockImplementation()!;
          contexts[0]!.page.goto.mockImplementationOnce(async (url) => {
            await goto(url);
            committed.resolve();
          });
        } else contexts[0]!.page.goBack.mockImplementationOnce(async () => committed.resolve());
        yield* viewer.input({ type, url: corrected, delta: -1 });
        yield* Effect.promise(() => interrupted.promise);
        yield* Effect.promise(() => committed.promise);
        if (type === "navigate")
          expect(contexts[0]!.page.goto).toHaveBeenCalledExactlyOnceWith(
            corrected,
            expect.objectContaining({ waitUntil: "commit" }),
          );
        else {
          expect(contexts[0]!.page.goto).not.toHaveBeenCalled();
          expect(contexts[0]!.page.goBack).toHaveBeenCalledOnce();
        }
        yield* viewer.input({ type: "releaseControl" });
      }),
    ).pipe(Effect.provide(layer)),
);

it.live.each(["navigate", "reload", "history"] as const)(
  "control handoff cancels pending viewer %s preparation before page mutation",
  (type) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { browser, broker, tabId } = yield* ready;
        const url = "http://localhost:5173/qa?mode=dark#anchor";
        hostingPreparation = () => Effect.succeed({ managed: true });
        yield* broker.invoke({ scope, tabId, operation: "navigate", input: { url } });
        if (type === "history")
          yield* broker.invoke({
            scope,
            tabId,
            operation: "navigate",
            input: { url: "https://public.example/other" },
          });
        const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
        yield* viewer.input({ type: "takeControl" });
        const entered = Promise.withResolvers<void>();
        const interrupted = Promise.withResolvers<void>();
        hostingPreparation = () =>
          Effect.sync(() => entered.resolve()).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Effect.sync(() => interrupted.resolve())),
          );
        yield* viewer.input({ type, url, delta: -1 });
        yield* Effect.promise(() => entered.promise);
        yield* viewer.input({ type: "releaseControl" });
        yield* Effect.promise(() => interrupted.promise);
        expect(contexts[0]!.page.goto).toHaveBeenCalledTimes(type === "history" ? 2 : 1);
        expect(contexts[0]!.page.reload).not.toHaveBeenCalled();
        expect(contexts[0]!.page.goBack).not.toHaveBeenCalled();
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

it.live("a cancelled owned preparation cannot navigate or leave recovery running", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const entered = Promise.withResolvers<void>();
      const interrupted = Promise.withResolvers<void>();
      hostingPreparation = () =>
        Effect.sync(() => entered.resolve()).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Effect.sync(() => interrupted.resolve())),
        );
      const request = yield* broker
        .invoke({ scope, tabId, operation: "navigate", input: { url: "http://localhost:5173/qa" } })
        .pipe(Effect.forkScoped);
      yield* Effect.promise(() => entered.promise);
      yield* Fiber.interrupt(request);
      yield* Effect.promise(() => interrupted.promise);
      expect(contexts[0]!.page.goto).not.toHaveBeenCalled();
      expect(contexts[0]!.request.post).not.toHaveBeenCalled();
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("hosting preparation shares the navigation deadline", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const interrupted = Promise.withResolvers<void>();
      hostingPreparation = () =>
        Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => interrupted.resolve())));
      const result = yield* Effect.result(
        broker.invoke({
          scope,
          tabId,
          operation: "navigate",
          input: { url: "http://localhost:5173/qa" },
          timeoutMs: 30,
        }),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure._tag).toBe("PreviewAutomationTimeoutError");
      yield* Effect.promise(() => interrupted.promise);
      expect(contexts[0]!.page.goto).not.toHaveBeenCalled();
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("a failed private browser-session exchange stays out of URLs and error results", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      hostingPreparation = () =>
        Effect.succeed({ managed: true, bootstrapToken: "fixture-private-credential" });
      contexts[0]!.request.post.mockRejectedValueOnce(
        new Error("Rejected fixture-private-credential"),
      );
      const result = yield* Effect.result(
        broker.invoke({
          scope,
          tabId,
          operation: "navigate",
          input: { url: "http://localhost:5173/qa?theme=dark#anchor" },
        }),
      );
      expect(result._tag).toBe("Failure");
      expect(JSON.stringify(result)).not.toContain("fixture-private-credential");
      expect(contexts[0]!.page.goto).not.toHaveBeenCalled();
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect.each([
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
        yield* TestClock.adjust("0 millis");
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
        yield* TestClock.adjust("0 millis");
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
      const corrected = Promise.withResolvers<void>();
      const goto = page.goto.getMockImplementation()!;
      page.goto.mockImplementation(async (url) => {
        await goto(url);
        if (url === "http://localhost:5173/fixed") corrected.resolve();
      });
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
      yield* Effect.promise(() => Promise.all([typed.promise, corrected.promise]));
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

// The fake encoder decodes every frame at 1280x800, so 30 fps hits the bitrate floor.
it.live.each([
  { reports: [], frameRate: 30, bitsPerSecond: 2.5e6 },
  { reports: [30], frameRate: 30, bitsPerSecond: 2.5e6 },
  { reports: [60], frameRate: 60, bitsPerSecond: 1280 * 800 * 60 * 0.05 },
  { reports: [60, undefined], frameRate: 60, bitsPerSecond: 1280 * 800 * 60 * 0.05 },
  { reports: [60, 30], frameRate: 30, bitsPerSecond: 2.5e6 },
] satisfies ReadonlyArray<{
  reports: ReadonlyArray<BrowserRecordingFrameRate | undefined>;
  frameRate: number;
  bitsPerSecond: number;
}>)(
  "agent recordings encode at the last reported frame rate ($reports)",
  ({ reports, frameRate, bitsPerSecond }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { browser, broker, tabId } = yield* ready;
        const reportProfiles = yield* browser.profileReporter;
        for (const recordingFrameRate of reports) {
          yield* reportProfiles({
            profiles: [],
            defaultProfileId: "default",
            ...(recordingFrameRate === undefined ? {} : { recordingFrameRate }),
          });
        }
        yield* broker.invoke({ scope, tabId, operation: "recordingStart", input: {} });
        expect(encoderStreams).toEqual([{ frameRate, bitsPerSecond }]);
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
        .invoke<void>({
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
          ...(native ? { __t3InputSource: "viewer" } : {}),
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

it.live(
  "coalesces queued hover movement and preserves drag points on a slow viewer connection",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { browser, tabId } = yield* ready;
        const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
        yield* viewer.input({ type: "takeControl" });
        const session = contexts[0]!.sessions.at(-1)!;
        const send = session.send.getMockImplementation()!;
        const started = Promise.withResolvers<void>();
        const finish = Promise.withResolvers<void>();
        yield* Effect.addFinalizer(() => Effect.sync(() => finish.resolve()));
        session.send.mockImplementation(async (method, input) => {
          if (method === "Input.dispatchMouseEvent" && (input as { x: number }).x === 0) {
            started.resolve();
            await finish.promise;
          }
          return send(method, input);
        });
        const move = (x: number) => ({
          type: "mouse",
          action: "move",
          x,
          y: 10,
          button: "none",
          buttons: 0,
          modifiers: 0,
        });
        const first = yield* viewer.input(move(0)).pipe(Effect.forkScoped);
        yield* Effect.promise(() => started.promise);
        const pending = yield* Effect.forEach(
          Array.from({ length: 100 }, (_, i) => i + 1),
          (x) => viewer.input(move(x)).pipe(Effect.forkScoped({ startImmediately: true })),
        );
        const click = yield* viewer
          .input({ ...move(100), action: "down", button: "left", buttons: 1 })
          .pipe(Effect.forkScoped({ startImmediately: true }));
        const dragging = yield* Effect.forEach(
          Array.from({ length: 100 }, (_, i) => i + 101),
          (x) =>
            viewer
              .input({ ...move(x), button: "left", buttons: 1 })
              .pipe(Effect.forkScoped({ startImmediately: true })),
        );
        const release = yield* viewer
          .input({ ...move(200), action: "up", button: "left" })
          .pipe(Effect.forkScoped({ startImmediately: true }));
        const typing = yield* viewer
          .input({ type: "text", text: "ready" })
          .pipe(Effect.forkScoped({ startImmediately: true }));
        finish.resolve();
        yield* Fiber.join(first);
        yield* Effect.forEach([...pending, click, ...dragging, release, typing], Fiber.join);
        expect(
          session.send.mock.calls
            .filter(([method]) => method.startsWith("Input."))
            .map(([method, input]) => ({ method, ...(input as object) })),
        ).toEqual([
          expect.objectContaining({ method: "Input.dispatchMouseEvent", type: "mouseMoved", x: 0 }),
          expect.objectContaining({
            method: "Input.dispatchMouseEvent",
            type: "mouseMoved",
            x: 100,
          }),
          expect.objectContaining({
            method: "Input.dispatchMouseEvent",
            type: "mousePressed",
            x: 100,
          }),
          ...Array.from({ length: 100 }, (_, i) =>
            expect.objectContaining({
              method: "Input.dispatchMouseEvent",
              type: "mouseMoved",
              x: i + 101,
              button: "left",
              buttons: 1,
            }),
          ),
          expect.objectContaining({
            method: "Input.dispatchMouseEvent",
            type: "mouseReleased",
            x: 200,
          }),
          expect.objectContaining({ method: "Input.insertText", text: "ready" }),
        ]);
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

it.live.each(["local", "host-a"])(
  "native root viewers apply fill and fixed sizes with measured CSS coordinates (%s)",
  (desktopHostId) =>
    Effect.scoped(
      Effect.gen(function* () {
        profileCatalogue = {
          desktopHostId,
          profiles: [{ id: "default", name: "Default", kind: "persistent" }],
          defaultProfileId: "default",
        };
        desktopRendersNext = true;
        const { browser, broker, tabId } = yield* ready;
        const manager = yield* Manager.PreviewManager;
        const page = desktopConnections[0]!.context.page;
        expect(page.viewportSize()).toBeNull();
        const passive = yield* browser.attachViewer(viewerInput(tabId, false));
        expect(yield* Queue.takeAll(passive.output)).toContainEqual({
          _tag: "viewport",
          width: 1024,
          height: 768,
        });
        yield* passive.input({ type: "resize", width: 333, height: 444 });
        yield* passive.input({
          type: "viewport",
          setting: { _tag: "freeform", width: 333, height: 444 },
        });
        expect(
          (yield* broker.invoke<PreviewAutomationStatus>({
            scope,
            tabId,
            operation: "status",
            input: {},
          })).viewport,
        ).toEqual({ width: 1024, height: 768 });
        const active = yield* browser.attachViewer(viewerInput(tabId, true));
        yield* active.input({ type: "takeControl" });
        yield* active.input({ type: "resize", width: 1200, height: 720 });
        expect(yield* Queue.takeAll(active.output)).toContainEqual({
          _tag: "viewport",
          width: 1200,
          height: 720,
        });
        expect(
          surfaceCalls.find((call) => call.viewport?._tag === "fill" && call.viewportSize),
        ).toMatchObject({ viewportSize: { width: 1200, height: 720 } });
        yield* active.input({
          type: "mouse",
          action: "down",
          button: "left",
          x: 600,
          y: 360,
          buttons: 1,
        });
        expect(desktopConnections[0]!.context.sessions.at(-1)!.send).toHaveBeenCalledWith(
          "Input.dispatchMouseEvent",
          expect.objectContaining({ x: 600, y: 360 }),
        );
        yield* active.input({
          type: "viewport",
          setting: { _tag: "freeform", width: 390, height: 844 },
        });
        yield* active.input({ type: "resize", width: 1400, height: 900 });
        expect(
          (yield* broker.invoke<PreviewAutomationStatus>({
            scope,
            tabId,
            operation: "status",
            input: {},
          })).viewport,
        ).toEqual({ width: 390, height: 844 });
        // Switching back to fill chooses the most recent active viewer, not the passive one.
        yield* active.input({ type: "viewport", setting: { _tag: "fill" } });
        expect(
          (yield* broker.invoke<PreviewAutomationStatus>({
            scope,
            tabId,
            operation: "status",
            input: {},
          })).viewport,
        ).toEqual({ width: 1400, height: 900 });
        expect((yield* manager.list({})).sessions[0]!.viewport).toEqual({ _tag: "fill" });
        expect(page.setViewportSize).not.toHaveBeenCalled();
        yield* active.input({ type: "releaseControl" });
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

it.live("published root zoom keeps measured viewport, pointer and snapshot scale coherent", () =>
  Effect.scoped(
    Effect.gen(function* () {
      desktopRendersNext = true;
      const { browser, broker, tabId } = yield* ready;
      const manager = yield* Manager.PreviewManager;
      const target = { threadId: scope.thread.threadId, tabId };
      const page = desktopConnections[0]!.context.page;
      expect(page.viewportSize()).toBeNull();
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      const session = desktopConnections[0]!.context.sessions[0]!;
      const applied = Promise.withResolvers<void>();
      const send = session.send.getMockImplementation()!;
      session.send.mockImplementation(async (method, input) => {
        if (method === "Page.reload") applied.resolve();
        return send(method, input);
      });
      yield* manager.resize({
        ...target,
        viewport: { _tag: "freeform", width: 1000, height: 750 },
      });
      yield* manager.adjust({ ...target, zoomFactor: 1.25 });
      yield* manager.adjust({ ...target, hardReload: true });
      yield* Effect.promise(() => applied.promise);
      expect(surfaceCalls).toContainEqual(
        expect.objectContaining({ action: "acquire", zoomFactor: 1.25 }),
      );
      expect(yield* Queue.takeAll(viewer.output)).toContainEqual({
        _tag: "viewport",
        width: 800,
        height: 600,
      });
      expect(
        (yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          tabId,
          operation: "status",
          input: {},
        })).viewport,
      ).toEqual({ width: 800, height: 600 });
      const snapshot = yield* broker.invoke<PreviewAutomationSnapshot>({
        scope,
        tabId,
        operation: "snapshot",
        input: { includeImage: true },
      });
      expect(snapshot.screenshot).toMatchObject({ width: 1280, height: 960 });
      expect(session.send).toHaveBeenCalledWith("Page.captureScreenshot", { format: "png" });
      expect(session.send).toHaveBeenCalledWith(
        "Runtime.callFunctionOn",
        expect.objectContaining({
          arguments: [{ value: expect.any(String) }, { value: 1280 }, { value: 960 }],
        }),
      );
      expect(
        session.send.mock.calls.some(([method]) => method === "Emulation.setDeviceMetricsOverride"),
      ).toBe(false);
      expect(page.setViewportSize).not.toHaveBeenCalled();
      yield* viewer.input({ type: "takeControl" });
      yield* viewer.input({
        type: "mouse",
        action: "down",
        button: "left",
        x: 400,
        y: 300,
        buttons: 1,
      });
      expect(desktopConnections[0]!.context.sessions.at(-1)!.send).toHaveBeenCalledWith(
        "Input.dispatchMouseEvent",
        expect.objectContaining({ x: 400, y: 300 }),
      );
      yield* viewer.input({ type: "releaseControl" });
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
        yield* Queue.clear(viewer.output);
        const takeover = yield* viewer.input({ type: "takeControl" }).pipe(Effect.forkScoped);
        let control = yield* Queue.take(viewer.output);
        while (control._tag !== "control") {
          control = yield* Queue.take(viewer.output);
        }
        expect(control).toMatchObject({ controller: "taking-control" });
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

it.live.each(["agent", "viewer"] as const)(
  "reports and resolves a pending dialog (%s)",
  (controller) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { browser, broker, tabId } = yield* ready;
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
        if (controller === "viewer") {
          const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
          yield* Queue.clear(viewer.output);
          const takeover = yield* viewer.input({ type: "takeControl" }).pipe(Effect.forkScoped);
          let control = yield* Queue.take(viewer.output);
          while (control._tag !== "control") control = yield* Queue.take(viewer.output);
          expect(control).toMatchObject({
            controller: "taking-control",
            dialog: { type: "confirm", message: "Delete row?" },
          });
          yield* viewer.input({ type: "dialog", accept: true });
          yield* Fiber.join(takeover);
        } else {
          yield* broker.invoke({ scope, tabId, operation: "dialog", input: { accept: true } });
        }
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
        // Explicit user/native close ends the handoff; lost rendering remains recoverable.
        const closing = yield* manager.subscribeEvents;
        if (native) desktopPopupEvents.emit("closed", popupSource);
        else yield* manager.close({ threadId: scope.thread.threadId, tabId: popupTab.tabId });
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

it.live.each(["desktop attachment", "CDP setup"])(
  "a managed remote native popup retains routing when its opener closes during %s",
  (stage) =>
    Effect.scoped(
      Effect.gen(function* () {
        profileCatalogue = {
          desktopHostId: "fixture-desktop",
          profiles: [{ id: "fixture-profile", name: "Fixture profile", kind: "persistent" }],
          defaultProfileId: "fixture-profile",
        };
        desktopRendersNext = true;
        const { browser, broker, tabId } = yield* ready;
        const prepared: Array<{ threadId: string; url: string; browserUrl?: string }> = [];
        hostingPreparation = (input) =>
          Effect.sync(() => {
            prepared.push(input);
            return new URL(input.url).origin === "http://localhost:5173"
              ? { managed: true, bootstrapToken: "fixture-one-use-credential" }
              : { managed: false };
          });
        const localUrl = "http://localhost:5173/qa/opener";
        yield* broker.invoke({ scope, tabId, operation: "navigate", input: { url: localUrl } });
        const popupLocalUrl = "http://localhost:5173/qa/popup?mode=two#popup";
        const popupBrowserUrl = popupLocalUrl.replace("localhost", "environment.example.test");
        const setupEntered = Promise.withResolvers<void>();
        const setupGate = Promise.withResolvers<void>();
        yield* Effect.addFinalizer(() => Effect.sync(() => setupGate.resolve()));
        if (stage === "CDP setup") {
          recordingStageEntered = setupEntered;
          recordingCdpGate = setupGate;
        }
        desktopPageSetup = async (context) => {
          await context.page.goto(popupBrowserUrl);
          if (stage === "desktop attachment") {
            setupEntered.resolve();
            await setupGate.promise;
          }
        };
        const manager = yield* Manager.PreviewManager;
        const events = yield* manager.subscribeEvents;
        desktopPopupEvents.emit("created", {
          threadId: scope.thread.threadId,
          tabId,
          desktopHostId: "fixture-desktop",
          popupId: "managed-native-popup",
          url: popupBrowserUrl,
        });
        yield* Effect.promise(() => setupEntered.promise);
        yield* Effect.promise(() => desktopConnections[0]!.context.page.close());
        setupGate.resolve();
        const opened = Option.getOrThrow(
          yield* Stream.fromSubscription(events).pipe(
            Stream.filter((event) => event.type === "opened" && event.tabId !== tabId),
            Stream.runHead,
          ),
        );
        if (opened.type !== "opened") throw new Error("Expected managed popup opening");
        const popupTabId = opened.tabId;
        yield* broker.invoke({
          scope,
          tabId: popupTabId,
          operation: "navigate",
          input: { url: popupBrowserUrl },
        });
        const actualPopup = desktopConnections[1]!.context;
        const viewer = yield* browser.attachViewer(viewerInput(popupTabId, true));
        yield* viewer.input({ type: "takeControl" });
        const reloaded = Promise.withResolvers<void>();
        actualPopup.page.reload.mockImplementationOnce(async () => reloaded.resolve());
        yield* viewer.input({ type: "reload", ignoreCache: false });
        yield* Effect.promise(() => reloaded.promise);
        expect(actualPopup.page.url()).toBe(popupBrowserUrl);
        expect(prepared).toEqual([
          {
            threadId: scope.thread.threadId,
            url: localUrl,
            browserUrl: localUrl.replace("localhost", "environment.example.test"),
          },
          ...Array.from({ length: 3 }, () => ({
            threadId: scope.thread.threadId,
            url: popupLocalUrl,
            browserUrl: popupBrowserUrl,
          })),
        ]);
        expect(actualPopup.request.post).toHaveBeenCalledTimes(3);
        expect(actualPopup.request.post).toHaveBeenLastCalledWith(
          "http://environment.example.test:5173/api/auth/browser-session",
          expect.objectContaining({ data: { credential: "fixture-one-use-credential" } }),
        );
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
        automationOwner: `${scope.environmentId}\u0000agent-a\u0000${scope.thread.threadId}`,
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

it.live.each(["reconnect", "deliberate-offline-close"] as const)(
  "an interrupted online native root close handles %s without losing user intent",
  (nextAction) =>
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
        const before = yield* manager.list({ threadId: scope.thread.threadId });
        const snapshot = before.sessions[0]!;
        const source = {
          threadId: scope.thread.threadId,
          tabId,
          desktopHostId: "host-a",
          rootId: snapshot.desktopRootId!,
        };
        expect(snapshot.backingPage).toBe("desktop-root");
        if (nextAction === "deliberate-offline-close") {
          for (let index = 1; index < 8; index++) {
            desktopRendersNext = true;
            yield* broker.invoke({
              scope,
              operation: "open",
              input: { reuseExistingTab: false, show: false },
            });
          }
          expect((yield* manager.list({ threadId: scope.thread.threadId })).sessions).toHaveLength(
            8,
          );
        }
        const context = yield* Layer.build(
          DesktopChannel.layer.pipe(
            Layer.provide(
              ServerConfig.layerTest(process.cwd(), { prefix: "t3-native-root-veto-channel-" }),
            ),
          ),
        );
        const channel = Context.get(context, DesktopChannel.DesktopBrowserChannel);
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
        // Mirror the mock-created server tab into the real channel's published-root registry.
        const creating = yield* channel
          .createRoot(source, {
            profileId: "work",
            serverEpoch: before.serverEpoch,
            url: "about:blank",
          })
          .pipe(Effect.forkScoped);
        const create = yield* Queue.take(first.commands);
        if (create.type !== "createRoot") throw new Error("Expected native root creation");
        yield* channel.receiveEvent("socket-a", "host-a", {
          type: "rootCreated",
          ...source,
          requestId: create.requestId,
          profileId: "work",
        });
        expect(yield* Fiber.join(creating)).toBe(source.rootId);
        const accepting = yield* channel.acceptRoot(source, source.rootId).pipe(Effect.forkScoped);
        const accept = yield* Queue.take(first.commands);
        if (accept.type !== "acceptRoot") throw new Error("Expected native root acceptance");
        yield* channel.receiveEvent("socket-a", "host-a", {
          type: "rootAccepted",
          ...source,
          requestId: accept.requestId,
          profileId: "work",
          accepted: true,
        });
        yield* Fiber.join(accepting);
        yield* channel.publishRoot(source, source.rootId);
        expect((yield* Queue.take(first.commands)).type).toBe("publishRoot");
        nativeRootCloseChannel = channel;
        const closing = yield* manager
          .close({ threadId: scope.thread.threadId, tabId })
          .pipe(Effect.flip, Effect.forkScoped);
        const original = yield* Queue.take(first.commands);
        if (original.type !== "closeRoot") throw new Error("Expected native root close");
        // The native beforeunload veto happened after delivery, but its reply was lost offline.
        desktopTabs.delete(tabId);
        yield* Fiber.interrupt(first.fiber);
        expect((yield* Fiber.join(closing))._tag).toBe("PreviewNativeCloseError");
        expect(rootDiscards).toEqual([]);
        if (nextAction === "deliberate-offline-close") {
          // A fresh deliberate close can release ownership while the host remains offline.
          yield* manager.close({ threadId: scope.thread.threadId, tabId });
          const retained = (yield* manager.list({ threadId: scope.thread.threadId })).sessions;
          expect(retained).toHaveLength(7);
          expect(retained.some((session) => session.tabId === tabId)).toBe(false);
          desktopRendersNext = true;
          const replacement = yield* broker.invoke<PreviewAutomationStatus>({
            scope,
            operation: "open",
            input: { reuseExistingTab: false, show: false },
          });
          expect(replacement.tabId).not.toBe(tabId);
          expect((yield* manager.list({ threadId: scope.thread.threadId })).sessions).toHaveLength(
            8,
          );
          const reconnected = yield* connect("socket-b");
          expect(yield* Queue.size(reconnected.commands)).toBe(0);
          yield* channel.reconcileRoots("host-a", before.serverEpoch);
          expect(yield* Queue.take(reconnected.commands)).toEqual({
            type: "reconcileRoots",
            serverEpoch: before.serverEpoch,
            retainedRootRequestIds: [],
          });
          expect(yield* Queue.size(reconnected.commands)).toBe(0);
          return;
        }
        expect((yield* manager.list({ threadId: scope.thread.threadId })).sessions).toHaveLength(1);
        const reconnected = yield* connect("socket-b");
        expect(yield* Queue.take(reconnected.commands)).toMatchObject({
          type: "publishRoot",
          rootId: source.rootId,
        });
        desktopTabs.add(tabId);
        nativeCloseRejected = Promise.withResolvers<void>();
        desktopPopupEvents.emit("host-connected", "host-a");
        const probe = yield* Queue.take(reconnected.commands);
        if (probe.type !== "probeRoot") throw new Error("Expected native root presence probe");
        yield* channel.receiveEvent("socket-b", "host-a", {
          type: "rootPresence",
          ...source,
          requestId: probe.requestId,
          present: true,
        });
        expect(yield* Queue.take(reconnected.commands)).toEqual(original);
        yield* channel.receiveEvent("socket-b", "host-a", {
          type: "rootCloseCanceled",
          ...source,
          requestId: original.requestId,
        });
        yield* Effect.promise(() => nativeCloseRejected!.promise);
        expect(rootDiscards).toEqual([]);
        expect(yield* Queue.size(reconnected.commands)).toBe(0);
        expect(
          (yield* manager.list({ threadId: scope.thread.threadId })).sessions[0],
        ).toMatchObject({
          tabId,
          backingPage: "desktop-root",
          desktopRootId: source.rootId,
          desktopHostId: "host-a",
          profileId: "work",
          automationOwner: snapshot.automationOwner,
        });
        expect(
          yield* broker.invoke({
            scope,
            tabId,
            operation: "evaluate",
            input: { expression: "stillOpen()" },
          }),
        ).toBe("evaluated");
        const explicit = yield* manager
          .close({ threadId: scope.thread.threadId, tabId })
          .pipe(Effect.forkScoped);
        const fresh = yield* Queue.take(reconnected.commands);
        if (fresh.type !== "closeRoot") throw new Error("Expected deliberate native close");
        expect(fresh.requestId).not.toBe(original.requestId);
        yield* channel.receiveEvent("socket-b", "host-a", { type: "rootClosed", ...source });
        yield* Fiber.join(explicit);
        desktopPopupEvents.emit("root-closed", source);
        expect((yield* manager.list({ threadId: scope.thread.threadId })).sessions).toEqual([]);
        expect(rootDiscards).toEqual([]);
        expect(yield* Queue.size(reconnected.commands)).toBe(0);
      }),
    ).pipe(Effect.provide(layer)),
);

it.live("a failed native reattachment keeps its saved target and retries on the same desktop", () =>
  Effect.scoped(
    Effect.gen(function* () {
      profileCatalogue = {
        desktopHostId: "host-a",
        profiles: [{ id: "work", name: "Work", kind: "persistent" }],
        defaultProfileId: "work",
      };
      desktopRendersNext = true;
      const { broker, browser, tabId } = yield* ready;
      const manager = yield* Manager.PreviewManager;
      yield* broker.invoke({
        scope,
        tabId,
        operation: "navigate",
        input: { url: "https://native.example.test/saved" },
      });
      yield* manager.reportStatus({
        threadId: scope.thread.threadId,
        tabId,
        serverControlled: true,
        navStatus: { _tag: "Success", url: "https://native.example.test/saved", title: "Saved" },
        canGoBack: false,
        canGoForward: false,
      });
      const viewer = yield* browser.attachViewer(viewerInput(tabId, false));
      desktopTabs.delete(tabId);
      desktopDetaches.emit("detach", {
        threadId: scope.thread.threadId,
        tabId,
        desktopHostId: "host-a",
      });
      let ending = yield* Queue.take(viewer.output);
      while (ending._tag !== "reconnect") ending = yield* Queue.take(viewer.output);
      yield* broker
        .invoke<void>({ scope, tabId, operation: "evaluate", input: { expression: "offline()" } })
        .pipe(Effect.flip);
      const saved = (yield* manager.list({})).sessions;
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({
        tabId,
        desktopHostId: "host-a",
        profileId: "work",
        navStatus: { url: "https://native.example.test/saved" },
      });
      expect(rootClosures).toEqual([]);
      desktopTabs.add(tabId);
      expect(
        yield* broker.invoke({
          scope,
          tabId,
          operation: "evaluate",
          input: { expression: "restored()" },
        }),
      ).toBe("evaluated");
      expect(rootCreations).toHaveLength(1);
      expect(contexts).toHaveLength(0);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live(
  "native policy unloading preserves the saved target and ignores a foreign host or obsolete root",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        profileCatalogue = {
          desktopHostId: "host-a",
          profiles: [{ id: "work", name: "Work", kind: "persistent" }],
          defaultProfileId: "work",
        };
        desktopRendersNext = true;
        const { broker, browser, tabId } = yield* ready;
        const manager = yield* Manager.PreviewManager;
        yield* broker.invoke({
          scope,
          tabId,
          operation: "navigate",
          input: { url: "https://native.example.test/saved" },
        });
        const events = yield* manager.subscribeEvents;
        const identity = {
          threadId: scope.thread.threadId,
          tabId,
          desktopHostId: "host-a",
          rootId: `root-${tabId}`,
        };
        desktopPopupEvents.emit("dormant", { ...identity, desktopHostId: "foreign-host" });
        desktopPopupEvents.emit("dormant", { ...identity, rootId: "obsolete-root" });
        desktopPopupEvents.emit("dormant", identity);
        const dormant = Option.getOrThrow(
          yield* Stream.fromSubscription(events).pipe(
            Stream.filter(
              (event) =>
                event.type === "navigated" &&
                event.tabId === tabId &&
                event.snapshot.backingPage === "desktop-root" &&
                event.snapshot.desktopRootId === undefined,
            ),
            Stream.runHead,
          ),
        );
        if (dormant.type !== "navigated") throw new Error("Expected saved dormant target");
        expect(dormant.snapshot).toMatchObject({
          tabId,
          profileId: "work",
          desktopHostId: "host-a",
          backingPage: "desktop-root",
          navStatus: { url: "https://native.example.test/saved" },
        });
        expect(dormant.snapshot.desktopRootId).toBeUndefined();
        expect(rootClosures).toEqual([]);
        expect((yield* manager.list({})).sessions).toHaveLength(1);
        const connectionsBefore = desktopConnections.length;
        const status = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          operation: "status",
          input: {},
        });
        expect(status.available).toBe(false);
        expect(status.tabs).toEqual([
          {
            tabId,
            url: "https://native.example.test/saved",
            owner: "agent",
            ownedByCaller: true,
            visible: false,
            profileId: "work",
          },
        ]);
        const observed = yield* broker.invoke<PreviewAutomationStatus>({
          scope: asSession("other-agent"),
          tabId,
          operation: "status",
          input: {},
        });
        expect(observed.tabs).toEqual([{ ...status.tabs![0], ownedByCaller: false }]);
        expect(desktopConnections).toHaveLength(connectionsBefore);
        expect(rootCreations).toHaveLength(1);
        expect(contexts).toHaveLength(0);
        expect((yield* manager.list({})).sessions).toEqual([dormant.snapshot]);
        yield* browser.attachViewer(viewerInput(tabId, false));
        expect(
          yield* broker.invoke({
            scope,
            tabId,
            operation: "evaluate",
            input: { expression: "restored()" },
          }),
        ).toBe("evaluated");
        expect(
          (yield* broker
            .invoke<void>({
              scope: asSession("other-agent"),
              tabId,
              operation: "close",
              input: {},
            })
            .pipe(Effect.flip)).message,
        ).toContain("another agent session");
        const page = desktopConnections.at(-1)!.context.page;
        page.locator.mockReturnValue({ evaluate: async () => true } as never);
        yield* broker.invoke({
          scope,
          tabId,
          operation: "type",
          input: { locator: "#field", text: "restored root input" },
        });
        yield* broker.invoke({ scope, tabId, operation: "press", input: { key: "Enter" } });
        expect(page.keyboard.insertText).toHaveBeenCalledExactlyOnceWith("restored root input");
        expect(page.keyboard.press).toHaveBeenCalledExactlyOnceWith("Enter");
        expect(rootCreations).toHaveLength(2);
        expect(contexts).toHaveLength(0);
        const saved = (yield* manager.list({})).sessions[0]!;
        expect(saved).toMatchObject({
          tabId,
          backingPage: "desktop-root",
          desktopRootId: `root-${tabId}-2`,
          profileId: "work",
          automationOwner: dormant.snapshot.automationOwner,
        });
        expect(rootCreations[1]).toMatchObject({
          tabId,
          profileId: "work",
          desktopHostId: "host-a",
          url: "https://native.example.test/saved",
        });
        const restored = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          operation: "status",
          input: {},
        });
        expect(restored.tabs?.map((tab) => tab.tabId)).toEqual([tabId]);
        rootCloseFailure = "close-canceled";
        yield* broker
          .invoke<void>({ scope, tabId, operation: "close", input: {} })
          .pipe(Effect.flip);
        expect((yield* manager.list({})).sessions[0]?.desktopRootId).toBe(saved.desktopRootId);
        rootCloseFailure = null;
        yield* broker.invoke({ scope, tabId, operation: "close", input: {} });
        expect((yield* manager.list({})).sessions).toEqual([]);
        expect(rootClosures.map((root) => root.rootId)).toEqual([
          saved.desktopRootId,
          saved.desktopRootId,
        ]);
      }),
    ).pipe(Effect.provide(layer)),
);

it.live(
  "an unloaded dedicated root closes without recreation and preserves its owner restriction",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { broker, manager, tabId, saved } = yield* dormantNativeRoot();
        const connections = desktopConnections.length;
        yield* broker
          .invoke<void>({ scope: asSession("other-agent"), tabId, operation: "close", input: {} })
          .pipe(Effect.flip);
        expect((yield* manager.list({})).sessions).toEqual([saved]);
        yield* broker.invoke({ scope, tabId, operation: "close", input: {} });
        expect((yield* manager.list({})).sessions).toEqual([]);
        expect(rootCreations).toHaveLength(1);
        expect(desktopConnections).toHaveLength(connections);
        expect(rootClosures).toEqual([]);
      }),
    ).pipe(Effect.provide(layer)),
);

it.live(
  "a cold native root prepares its retained hosted destination before viewer navigation",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { browser, manager, tabId } = yield* dormantNativeRoot();
        const url = "http://127.0.0.1:5173/retained";
        yield* manager.reportStatus({
          threadId: scope.thread.threadId,
          tabId,
          serverControlled: true,
          navStatus: { _tag: "Success", url, title: "Retained app" },
          canGoBack: false,
          canGoForward: false,
        });
        const prepared: Array<{ threadId: string; url: string }> = [];
        hostingPreparation = (input) =>
          Effect.sync(() => {
            prepared.push(input);
            return { managed: true, bootstrapToken: "fixture-fresh-credential" };
          });
        yield* browser.attachViewer(viewerInput(tabId, false));
        const restored = desktopConnections.at(-1)!.context;
        expect(prepared).toEqual([{ threadId: scope.thread.threadId, url }]);
        expect(restored.request.post).toHaveBeenCalledExactlyOnceWith(
          "http://127.0.0.1:5173/api/auth/browser-session",
          expect.objectContaining({ data: { credential: "fixture-fresh-credential" } }),
        );
        expect(restored.page.goto).toHaveBeenCalledExactlyOnceWith(url, expect.anything());
      }),
    ).pipe(Effect.provide(layer)),
);

it.live.each(["acceptance", "publication"] as const)(
  "a failed dedicated root restoration at %s retains the destination and permits a single concurrent retry",
  (stage) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { broker, browser, manager, tabId, saved } = yield* dormantNativeRoot();
        const failure = new DesktopBrowserTransportError({ reason: "host-unavailable" });
        if (stage === "acceptance") rootAcceptanceFailure = failure;
        else rootPublicationFailure = failure;
        yield* browser.attachViewer(viewerInput(tabId, false)).pipe(Effect.flip);
        expect((yield* manager.list({})).sessions[0]).toMatchObject({
          tabId,
          backingPage: "desktop-root",
          profileId: saved.profileId,
          automationOwner: saved.automationOwner,
        });
        expect((yield* manager.list({})).sessions[0]).not.toHaveProperty("desktopRootId");
        expect(rootDiscards).toEqual([
          expect.objectContaining({ tabId, rootId: `root-${tabId}-2` }),
        ]);
        expect(rootClosures).toEqual([]);
        const status = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          operation: "status",
          input: {},
        });
        expect(status.available).toBe(false);
        expect(status.tabs?.map((tab) => tab.tabId)).toEqual([tabId]);
        rootAcceptanceFailure = null;
        rootPublicationFailure = null;
        yield* Effect.all(
          [
            browser.attachViewer(viewerInput(tabId, false)),
            browser.attachViewer(viewerInput(tabId, false)),
          ],
          { concurrency: "unbounded" },
        );
        expect(rootCreations).toHaveLength(3);
        expect((yield* manager.list({})).sessions[0]?.desktopRootId).toBe(`root-${tabId}-3`);
        yield* broker.invoke({ scope, tabId, operation: "press", input: { key: "Enter" } });
        expect(
          desktopConnections.at(-1)!.context.page.keyboard.press,
        ).toHaveBeenCalledExactlyOnceWith("Enter");
      }),
    ).pipe(Effect.provide(layer)),
);

it.effect(
  "canceling a dedicated root restoration discards late attachment and allows another return",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { broker, browser, manager, tabId } = yield* dormantNativeRoot();
        const setupEntered = Promise.withResolvers<void>();
        const setupGate = Promise.withResolvers<void>();
        desktopPageSetup = async () => {
          setupEntered.resolve();
          await setupGate.promise;
        };
        releasedDesktopSeen = Promise.withResolvers<void>();
        const opening = yield* broker
          .invoke<PreviewAutomationStatus>({
            scope,
            tabId,
            operation: "open",
            input: { open: false },
            timeoutMs: 200,
          })
          .pipe(Effect.flip, Effect.forkChild);
        yield* Effect.promise(() => setupEntered.promise);
        yield* TestClock.adjust("201 millis");
        expect(yield* Fiber.join(opening)).toMatchObject({ _tag: "PreviewAutomationTimeoutError" });
        setupGate.resolve();
        yield* Effect.promise(() => releasedDesktopSeen!.promise);
        expect(rootDiscards).toEqual([expect.objectContaining({ rootId: `root-${tabId}-2` })]);
        expect((yield* manager.list({})).sessions[0]).not.toHaveProperty("desktopRootId");
        const status = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          operation: "status",
          input: {},
        });
        expect(status.available).toBe(false);
        expect(status.tabs?.map((tab) => tab.tabId)).toEqual([tabId]);
        desktopPageSetup = null;
        yield* browser.attachViewer(viewerInput(tabId, false));
        expect(rootCreations).toHaveLength(3);
        expect((yield* manager.list({})).sessions[0]?.desktopRootId).toBe(`root-${tabId}-3`);
      }),
    ).pipe(Effect.provide(layer)),
);

it.live(
  "status exposes detached roots so their owner can close them without moving their native identity",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        profileCatalogue = {
          desktopHostId: "host-a",
          profiles: [{ id: "work", name: "Work", kind: "persistent" }],
          defaultProfileId: "work",
        };
        desktopRendersNext = true;
        const { broker, browser, tabId } = yield* ready;
        const tabIds = [tabId];
        for (let index = 1; index < 8; index++) {
          desktopRendersNext = true;
          const opened = yield* broker.invoke<PreviewAutomationStatus>({
            scope,
            operation: "open",
            input: { reuseExistingTab: false, show: false },
          });
          tabIds.push(opened.tabId!);
        }
        for (const detachedTabId of tabIds) {
          const viewer = yield* browser.attachViewer(viewerInput(detachedTabId, false));
          desktopTabs.delete(detachedTabId);
          desktopDetaches.emit("detach", {
            threadId: scope.thread.threadId,
            tabId: detachedTabId,
            desktopHostId: "host-a",
          });
          let ending = yield* Queue.take(viewer.output);
          while (ending._tag !== "reconnect") ending = yield* Queue.take(viewer.output);
        }
        const connectionsBefore = desktopConnections.length;
        const status = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          operation: "status",
          input: {},
        });
        expect(status.available).toBe(false);
        expect(status.tabs).toHaveLength(8);
        expect(status.tabs?.map((tab) => tab.tabId)).toEqual(tabIds);
        expect(status.tabs?.every((tab) => tab.ownedByCaller && tab.owner === "agent")).toBe(true);
        expect(status.tabs?.every((tab) => tab.profileId === "work" && !tab.visible)).toBe(true);
        expect(desktopConnections).toHaveLength(connectionsBefore);
        const otherScope = {
          ...scope,
          thread: { ...scope.thread, providerSessionId: "other-agent" },
        };
        const observed = yield* broker.invoke<PreviewAutomationStatus>({
          scope: otherScope,
          operation: "status",
          input: {},
        });
        expect(observed.tabs?.every((tab) => !tab.ownedByCaller)).toBe(true);
        profileCatalogue = { ...profileCatalogue, desktopHostId: "host-b" };
        rootCloseFailure = "host-unavailable";
        const closableTabId = status.tabs![0]!.tabId;
        expect(
          (yield* broker
            .invoke<void>({
              scope: otherScope,
              tabId: closableTabId,
              operation: "close",
              input: {},
            })
            .pipe(Effect.flip)).message,
        ).toContain("another agent session");
        yield* broker.invoke({ scope, tabId: closableTabId, operation: "close", input: {} });
        rootCloseFailure = null;
        desktopRendersNext = true;
        const replacement = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          operation: "open",
          input: { reuseExistingTab: false, show: false },
        });
        expect(replacement.tabId).not.toBe(closableTabId);
        expect(replacement.tabs).toHaveLength(8);
        expect(replacement.tabs?.some((tab) => tab.tabId === closableTabId)).toBe(false);
        expect(rootDiscards).toEqual([
          {
            threadId: scope.thread.threadId,
            tabId: closableTabId,
            desktopHostId: "host-a",
            rootId: `root-${closableTabId}`,
          },
        ]);
      }),
    ).pipe(Effect.provide(layer)),
);

it.live.each(["agent", "client"] as const)(
  "explicit %s close retires an offline root without reopening it or consuming tab capacity",
  (entry) =>
    Effect.scoped(
      Effect.gen(function* () {
        profileCatalogue = {
          desktopHostId: "host-a",
          profiles: [{ id: "work", name: "Work", kind: "persistent" }],
          defaultProfileId: "work",
        };
        desktopRendersNext = true;
        const { broker, browser, tabId } = yield* ready;
        const manager = yield* Manager.PreviewManager;
        const viewer = yield* browser.attachViewer(viewerInput(tabId, false));
        desktopTabs.delete(tabId);
        desktopDetaches.emit("detach", {
          threadId: scope.thread.threadId,
          tabId,
          desktopHostId: "host-a",
        });
        let ending = yield* Queue.take(viewer.output);
        while (ending._tag !== "reconnect") ending = yield* Queue.take(viewer.output);
        for (let index = 1; index < 8; index++) {
          desktopRendersNext = true;
          yield* broker.invoke({
            scope,
            operation: "open",
            input: { reuseExistingTab: false, show: false },
          });
        }
        rootCloseFailure = "host-unavailable";
        const mismatch = yield* broker
          .invoke<void>({
            scope: { ...scope, thread: { ...scope.thread, providerSessionId: "other-agent" } },
            tabId,
            operation: "close",
            input: {},
          })
          .pipe(Effect.flip);
        expect(mismatch.message).toContain("another agent session");
        expect(rootDiscards).toEqual([]);
        const connectionsBefore = desktopConnections.length;
        if (entry === "agent")
          yield* broker.invoke({ scope, tabId, operation: "close", input: {} });
        else yield* manager.close({ threadId: scope.thread.threadId, tabId });
        expect(desktopConnections).toHaveLength(connectionsBefore);
        expect(rootDiscards).toEqual([
          {
            threadId: scope.thread.threadId,
            tabId,
            desktopHostId: "host-a",
            rootId: `root-${tabId}`,
          },
        ]);
        expect((yield* manager.list({})).sessions).toHaveLength(7);
        rootCloseFailure = null;
        desktopRendersNext = true;
        const replacement = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          operation: "open",
          input: { reuseExistingTab: false, show: false },
        });
        expect(replacement.tabId).not.toBe(tabId);
        expect((yield* manager.list({})).sessions).toHaveLength(8);
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

it.effect.each([
  {
    name: "hover burst before a click",
    inputs: [
      ...Array.from({ length: 120 }, (_, x) => ({
        type: "mouse",
        action: "move",
        x,
        buttons: 0,
        button: "none",
      })),
      { type: "mouse", action: "down", x: 119, buttons: 1, button: "left" },
      { type: "mouse", action: "up", x: 119, buttons: 0, button: "left" },
    ],
    expected: [
      { type: "mouseMoved", x: -1 },
      { type: "mouseMoved", x: 119 },
      { type: "mousePressed", x: 119 },
      { type: "mouseReleased", x: 119 },
    ],
  },
  {
    name: "modifier changes and drag points",
    inputs: [
      { type: "mouse", action: "move", x: 1, buttons: 0, button: "none" },
      { type: "mouse", action: "move", x: 2, buttons: 0, button: "none", modifiers: 2 },
      { type: "mouse", action: "move", x: 3, buttons: 0, button: "none", modifiers: 2 },
      { type: "mouse", action: "down", x: 3, buttons: 1, button: "left" },
      { type: "mouse", action: "move", x: 4, buttons: 1, button: "left" },
      { type: "mouse", action: "move", x: 5, buttons: 1, button: "left" },
      { type: "mouse", action: "up", x: 5, buttons: 0, button: "left" },
    ],
    expected: [
      { type: "mouseMoved", x: -1 },
      { type: "mouseMoved", x: 1, modifiers: 0 },
      { type: "mouseMoved", x: 3, modifiers: 2 },
      { type: "mousePressed", x: 3 },
      { type: "mouseMoved", x: 4 },
      { type: "mouseMoved", x: 5 },
      { type: "mouseReleased", x: 5 },
    ],
  },
  {
    name: "wheel and keyboard boundaries",
    inputs: [
      { type: "mouse", action: "move", x: 1, buttons: 0, button: "none" },
      { type: "wheel", x: 1, deltaY: 20 },
      { type: "wheel", x: 1, deltaY: 30 },
      { type: "mouse", action: "move", x: 2, buttons: 0, button: "none" },
      { type: "key", action: "down", key: "a", code: "KeyA", text: "a" },
      { type: "mouse", action: "move", x: 3, buttons: 0, button: "none" },
    ],
    expected: [
      { type: "mouseMoved", x: -1 },
      { type: "mouseMoved", x: 1 },
      { type: "mouseWheel", deltaY: 20 },
      { type: "mouseWheel", deltaY: 30 },
      { type: "mouseMoved", x: 2 },
      { type: "keyDown", key: "a" },
      { type: "mouseMoved", x: 3 },
    ],
  },
  {
    name: "text, navigation and resize boundaries",
    inputs: [
      { type: "mouse", action: "move", x: 1, buttons: 0, button: "none" },
      { type: "text", text: "typed" },
      { type: "mouse", action: "move", x: 2, buttons: 0, button: "none" },
      { type: "navigate", url: "http://localhost:5173/next" },
      { type: "mouse", action: "move", x: 3, buttons: 0, button: "none" },
      { type: "resize", width: 640, height: 480 },
      { type: "mouse", action: "move", x: 4, buttons: 0, button: "none" },
    ],
    expected: [
      { type: "mouseMoved", x: -1 },
      { type: "mouseMoved", x: 1 },
      { text: "typed" },
      { type: "mouseMoved", x: 2 },
      { type: "mouseMoved", x: 3 },
      { type: "mouseMoved", x: 4 },
    ],
  },
  {
    name: "ambiguous button fields",
    inputs: [
      { type: "mouse", action: "move", x: 1, button: "none" },
      { type: "mouse", action: "move", x: 2, button: "none" },
      { type: "mouse", action: "move", x: 3, buttons: 0 },
      { type: "mouse", action: "move", x: 4, buttons: 0 },
    ],
    expected: [-1, 1, 2, 3, 4].map((x) => ({ type: "mouseMoved", x })),
  },
])("orders streamed input correctly for $name", (testCase) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, tabId } = yield* ready;
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* viewer.input({ type: "takeControl" });
      const session = contexts[0]!.sessions.at(-1)!;
      const send = session.send.getMockImplementation()!;
      const started = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      yield* Effect.addFinalizer(() => Effect.sync(() => finish.resolve()));
      session.send.mockClear();
      session.send.mockImplementationOnce(async (method, input) => {
        started.resolve();
        await finish.promise;
        return send(method, input);
      });
      const running = yield* viewer
        .input({ type: "mouse", action: "move", x: -1, button: "none", buttons: 0 })
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Effect.promise(() => started.promise);
      const waiting = yield* Effect.forEach(testCase.inputs, (input) =>
        viewer.input(input).pipe(Effect.forkScoped({ startImmediately: true })),
      );
      finish.resolve();
      yield* Effect.forEach([running, ...waiting], Fiber.join);
      const dispatched = session.send.mock.calls.flatMap(([method, input]) =>
        method.startsWith("Input.") ? [input] : [],
      );
      expect(dispatched).toHaveLength(testCase.expected.length);
      expect(dispatched).toMatchObject(testCase.expected);
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

it.live("a restarted server removes the previous run's downloads and keeps its profiles", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const previousTab = path.join(stateDir, "server-browser", "downloads", "previous-tab");
      const profile = path.join(stateDir, "server-browser", "profiles", "default");
      yield* fs.makeDirectory(previousTab, { recursive: true });
      yield* fs.makeDirectory(profile, { recursive: true });
      yield* fs.writeFileString(path.join(previousTab, "report.csv"), "a,b");
      yield* fs.writeFileString(path.join(profile, "Preferences"), "{}");

      yield* Layer.build(ServerBrowser.layer);

      expect(yield* fs.exists(previousTab)).toBe(false);
      expect(yield* fs.readFileString(path.join(profile, "Preferences"))).toBe("{}");
    }),
  ).pipe(Effect.provide(dependencies)),
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
        element: () => fileChooserElement(".csv"),
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

it.live("overlapping file pickers keep the newer offer answerable", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, tabId } = yield* ready;
      const page = contexts[0]!.page;
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* viewer.input({ type: "takeControl" });
      const accept = Promise.withResolvers<string | null>();
      const firstFiles = vi.fn(async (_files: unknown) => {});
      const secondFiles = vi.fn(async (_files: unknown) => {});
      page.emit("filechooser", {
        isMultiple: () => false,
        element: () => ({ ...fileChooserElement(""), getAttribute: () => accept.promise }),
        setFiles: firstFiles,
      });
      page.emit("filechooser", {
        isMultiple: () => false,
        element: () => fileChooserElement(".csv"),
        setFiles: secondFiles,
      });
      accept.resolve(".txt");
      let first = yield* Queue.take(viewer.output);
      while (first._tag !== "fileChooser") first = yield* Queue.take(viewer.output);
      let second = yield* Queue.take(viewer.output);
      while (second._tag !== "fileChooser") second = yield* Queue.take(viewer.output);
      expect(second.accept).toBe(".csv");
      expect(
        yield* browser.answerFileChooser({
          threadId: scope.thread.threadId,
          tabId,
          chooserId: second.id,
          files: [{ name: "a.csv", mimeType: "text/csv", buffer: Buffer.from("a") }],
        }),
      ).toBe(true);
      expect(firstFiles).not.toHaveBeenCalled();
      expect(secondFiles).toHaveBeenCalledOnce();
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("a detached file picker stays open across same-document navigation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, tabId } = yield* ready;
      const page = contexts[0]!.page;
      const pageDocument = {};
      vi.stubGlobal("document", pageDocument);
      yield* Effect.addFinalizer(() => Effect.sync(() => vi.unstubAllGlobals()));
      const detachedInput = { isConnected: false, ownerDocument: pageDocument };
      const navigationProbe = Promise.withResolvers<boolean>();
      const navigationProbeStarted = Promise.withResolvers<void>();
      const navigationProbeFinished = Promise.withResolvers<void>();
      let probeCount = 0;
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* viewer.input({ type: "takeControl" });
      page.emit("filechooser", {
        isMultiple: () => false,
        element: () => ({
          getAttribute: async () => "",
          evaluate: (probe: (element: typeof detachedInput) => boolean) => {
            probeCount++;
            if (probeCount === 1) return Promise.resolve(probe(detachedInput));
            navigationProbeStarted.resolve();
            return navigationProbe.promise.then((current) => {
              const result = probe(detachedInput);
              navigationProbeFinished.resolve();
              return current && result;
            });
          },
        }),
        setFiles: vi.fn(async (_files: unknown) => {}),
      });
      let offered = yield* Queue.take(viewer.output);
      while (offered._tag !== "fileChooser") offered = yield* Queue.take(viewer.output);

      page.emit("framenavigated", page);
      yield* Effect.promise(() => navigationProbeStarted.promise);
      navigationProbe.resolve(true);
      yield* Effect.promise(() => navigationProbeFinished.promise);
      yield* viewer.input({ type: "releaseControl" });
      let closedAfterNavigation = false;
      let control = yield* Queue.take(viewer.output);
      while (control._tag !== "control" || control.controller === "you") {
        if (control._tag === "fileChooserClosed") closedAfterNavigation = true;
        control = yield* Queue.take(viewer.output);
      }
      expect(closedAfterNavigation).toBe(false);
      yield* viewer.input({ type: "takeControl" });
      let restoredControl = yield* Queue.take(viewer.output);
      while (restoredControl._tag !== "control" || restoredControl.controller !== "you") {
        restoredControl = yield* Queue.take(viewer.output);
      }

      expect(
        yield* browser.answerFileChooser({
          threadId: scope.thread.threadId,
          tabId,
          chooserId: offered.id,
          files: [{ name: "a.csv", mimeType: "text/csv", buffer: Buffer.from("a") }],
        }),
      ).toBe(true);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live.each(["main", "iframe"])(
  "a file picker closes at %s document commit before DOMContentLoaded",
  (frame) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { browser, tabId } = yield* ready;
        const page = contexts[0]!.page;
        const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
        yield* viewer.input({ type: "takeControl" });
        const setFiles = vi.fn(async (_files: unknown) => {});
        const probeStarted = Promise.withResolvers<void>();
        const probeSettled = Promise.withResolvers<void>();
        let probeCount = 0;
        page.emit("filechooser", {
          isMultiple: () => false,
          element: () => ({
            getAttribute: async () => "",
            evaluate: () => {
              probeCount++;
              if (probeCount === 1) return Promise.resolve(true);
              probeStarted.resolve();
              return Promise.reject(new Error("Execution context was destroyed")).finally(() =>
                probeSettled.resolve(),
              );
            },
          }),
          setFiles,
        });
        let offered = yield* Queue.take(viewer.output);
        while (offered._tag !== "fileChooser") offered = yield* Queue.take(viewer.output);

        page.emit("framenavigated", frame === "main" ? page : makeFrame());
        yield* Effect.promise(() => probeStarted.promise);
        yield* Effect.promise(() => probeSettled.promise);
        let closed = yield* Queue.take(viewer.output);
        while (closed._tag !== "fileChooserClosed") closed = yield* Queue.take(viewer.output);
        expect(closed.id).toBe(offered.id);
        expect(
          yield* browser.answerFileChooser({
            threadId: scope.thread.threadId,
            tabId,
            chooserId: offered.id,
            files: [{ name: "a.csv", mimeType: "text/csv", buffer: Buffer.from("a") }],
          }),
        ).toBe(false);
        expect(setFiles).not.toHaveBeenCalled();
      }),
    ).pipe(Effect.provide(layer)),
);

it.live("a file picker closes when its page is replaced while control changes hands", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, browser, tabId } = yield* ready;
      const page = contexts[0]!.page;
      const first = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* first.input({ type: "takeControl" });
      const current = Promise.withResolvers<boolean>();
      const probeStarted = Promise.withResolvers<void>();
      let probeCount = 0;
      page.emit("filechooser", {
        isMultiple: () => false,
        element: () => ({
          getAttribute: async () => "",
          evaluate: () => {
            probeCount++;
            if (probeCount === 1) return Promise.resolve(true);
            probeStarted.resolve();
            return current.promise;
          },
        }),
        setFiles: vi.fn(async (_files: unknown) => {}),
      });
      let offered = yield* Queue.take(first.output);
      while (offered._tag !== "fileChooser") offered = yield* Queue.take(first.output);

      page.emit("framenavigated", page);
      yield* Effect.promise(() => probeStarted.promise);
      const second = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* first.input({ type: "releaseControl" });
      yield* second.input({ type: "takeControl" });
      let reoffered = yield* Queue.take(second.output);
      while (reoffered._tag !== "fileChooser") reoffered = yield* Queue.take(second.output);
      current.resolve(false);
      let closed = yield* Queue.take(second.output);
      while (closed._tag !== "fileChooserClosed") closed = yield* Queue.take(second.output);
      expect(closed.id).toBe(reoffered.id);
      const status = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId,
        operation: "status",
        input: {},
      });
      expect(status.fileChooser).toBeNull();
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("a file picker is not offered after its document changes while reading accept", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, browser, tabId } = yield* ready;
      const page = contexts[0]!.page;
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* viewer.input({ type: "takeControl" });
      const accept = Promise.withResolvers<string | null>();
      const acceptRead = Promise.withResolvers<void>();
      const current = Promise.withResolvers<boolean>();
      const probeStarted = Promise.withResolvers<void>();
      page.emit("filechooser", {
        isMultiple: () => false,
        element: () => ({
          getAttribute: () => {
            acceptRead.resolve();
            return accept.promise;
          },
          evaluate: () => {
            probeStarted.resolve();
            return current.promise;
          },
        }),
        setFiles: vi.fn(async (_files: unknown) => {}),
      });

      yield* Effect.promise(() => acceptRead.promise);
      page.emit("framenavigated", page);
      accept.resolve("");
      yield* Effect.promise(() => accept.promise);
      yield* Effect.promise(() => probeStarted.promise);
      current.resolve(false);
      yield* Effect.promise(() => current.promise);
      const status = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId,
        operation: "status",
        input: {},
      });
      expect(status.fileChooser).toBeNull();
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
        element: () => fileChooserElement(""),
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

it.effect(
  "desktop viewers get the page's CSS size and keep the last one a read cannot measure",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        // Each page size read waits here for its answer.
        const reads = yield* Queue.unbounded<PromiseWithResolvers<Record<string, unknown>>>();
        const deferReads = () => {
          desktopSizeAnswer = () => {
            const read = Promise.withResolvers<Record<string, unknown>>();
            Queue.offerUnsafe(reads, read);
            return read.promise;
          };
        };
        deferReads();
        const { viewer, cdp, context } = yield* openDesktopViewer;
        const answer = (width: number, height: number) => ({
          result: { value: { width, height } },
        });
        const resized = () => cdp.emitAsync("Page.frameResized");
        // The read on attach never answers and gives up with no size to send.
        const blocked = yield* Queue.take(reads);
        yield* TestClock.adjust("1 second");
        // The next page load measures again.
        desktopSizeAnswer = null;
        yield* Effect.promise(() => cdp.emitAsync("Page.loadEventFired"));
        expect(viewportSizes(yield* Queue.takeAll(viewer.output))).toEqual(["1920x1080"]);
        // While a dialog is open nothing reads. The host closing it clears it, and since
        // closing resizes nothing, the close itself remeasures.
        deferReads();
        context.page.emit("dialog", {
          type: () => "alert",
          message: () => "",
          defaultValue: () => "",
        });
        yield* Effect.promise(resized);
        expect(yield* Queue.size(reads)).toBe(0);
        desktopSizeAnswer = null;
        yield* Effect.promise(() => cdp.emitAsync("Page.javascriptDialogClosed"));
        expect(viewportSizes(yield* Queue.takeAll(viewer.output))).toEqual([
          "1920x1080",
          "1920x1080",
        ]);
        // The late answer, a read a navigation breaks and a hidden webview keep the last size.
        blocked.resolve(answer(100, 100));
        deferReads();
        const navigated = resized();
        (yield* Queue.take(reads)).reject(new Error("Cannot find context with specified id"));
        yield* Effect.promise(() => navigated);
        const hidden = resized();
        (yield* Queue.take(reads)).resolve(answer(0, 0));
        yield* Effect.promise(() => hidden);
        expect(viewportSizes(yield* Queue.takeAll(viewer.output))).toEqual([
          "1920x1080",
          "1920x1080",
        ]);
        // Resizes during a read share one more read, so the newest size arrives last.
        const first = resized();
        const firstRead = yield* Queue.take(reads);
        const burst = Promise.all([resized(), resized()]);
        firstRead.resolve(answer(800, 500));
        (yield* Queue.take(reads)).resolve(answer(1000, 600));
        expect(yield* Queue.size(reads)).toBe(0);
        yield* Effect.promise(() => Promise.all([first, burst]));
        expect(viewportSizes(yield* Queue.takeAll(viewer.output))).toEqual([
          "800x500",
          "1000x600",
          "1000x600",
        ]);
      }),
    ).pipe(Effect.provide(layer)),
);

it.effect("a stalled desktop viewer still gets its size, control and reconnect", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { tabId, viewer, context, resize } = yield* openDesktopViewer;
      const output =
        viewer.output as unknown as Queue.Queue<ServerBrowser.ServerBrowserViewerOutput>;
      // Ready once the sizes measured on attach and on a first resize both arrived.
      yield* resize(1920, 1080);
      expect(viewportSizes(yield* Queue.takeAll(viewer.output))).toEqual([
        "1920x1080",
        "1920x1080",
      ]);
      yield* Effect.promise(() => desktopDetachReady.promise);
      yield* viewer.input({ type: "takeControl" });
      context.page.emit("filechooser", {
        isMultiple: () => false,
        element: () => fileChooserElement(".csv"),
        setFiles: vi.fn(async () => {}),
      });
      let chooser = yield* Queue.take(viewer.output);
      while (chooser._tag !== "fileChooser") chooser = yield* Queue.take(viewer.output);
      yield* Queue.clear(viewer.output);
      // A resize compacts a full backlog but keeps control, the open picker and
      // one-time notifications in order.
      yield* viewer.input({ type: "takeControl" });
      const notifications: Array<ServerBrowser.ServerBrowserViewerOutput> = [
        { _tag: "fileChooserClosed", id: "chooser-0" },
        { _tag: "popup", tabId: "popup-1" },
        { _tag: "download", id: "download-1", fileName: "report.csv", sizeBytes: 3 },
        { _tag: "clipboard", text: "copied" },
      ];
      for (const item of notifications) Queue.offerUnsafe(output, item);
      let acked = stallViewer(viewer);
      yield* resize(1000, 600);
      expect(yield* Queue.takeAll(viewer.output)).toEqual([
        chooser,
        ...notifications,
        expect.objectContaining({ _tag: "control", controller: "you" }),
        { _tag: "viewport", width: 1000, height: 600 },
      ]);
      yield* acked;
      // A control change keeps only the newest size.
      yield* resize(900, 500);
      yield* resize(1200, 700);
      acked = stallViewer(viewer);
      yield* viewer.input({ type: "releaseControl" });
      expect(yield* Queue.takeAll(viewer.output)).toEqual([
        expect.objectContaining({ _tag: "control", controller: "unclaimed" }),
        { _tag: "viewport", width: 1200, height: 700 },
      ]);
      yield* acked;
      // Notifications that no longer fit go oldest first, never the size.
      let copies = 0;
      while (Queue.offerUnsafe(output, { _tag: "clipboard", text: `copy ${copies}` })) copies++;
      yield* resize(1000, 600);
      const compacted = yield* Queue.takeAll(viewer.output);
      expect(compacted.at(0)).toEqual({ _tag: "clipboard", text: "copy 1" });
      expect(compacted.at(-1)).toEqual({ _tag: "viewport", width: 1000, height: 600 });
      // The desktop takes the page back; a resize after it cannot bury the reconnect.
      acked = stallViewer(viewer);
      desktopDetaches.emit("detach", { threadId: scope.thread.threadId, tabId });
      yield* Effect.promise(() => desktopReleased.promise);
      yield* resize(1000, 600);
      expect(yield* Queue.takeAll(viewer.output)).toEqual([{ _tag: "reconnect" }]);
      yield* acked;
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
      const expired = initial + 25 * 60 * 60_000;
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

it.live("an agent's tabs stop at the limit until unwatched idle pages are released", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, broker, tabId } = yield* ready;
      const visibleScope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(visibleScope, Exit.void));
      yield* browser.attachViewer(viewerInput(tabId, false)).pipe(Scope.provide(visibleScope));
      const open = broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "open",
        input: { reuseExistingTab: false, show: false },
      });
      for (let count = 1; count < 8; count += 1) {
        const opened = yield* open;
        yield* browser
          .attachViewer(viewerInput(opened.tabId!, false))
          .pipe(Scope.provide(visibleScope));
      }
      expect(yield* Effect.flip(open)).toMatchObject({
        _tag: "PreviewAutomationControlInterruptedError",
        reason: "tabLimit",
      });
      yield* Scope.close(visibleScope, Exit.void);
      yield* broker.invoke({
        scope: asSession("agent-b"),
        operation: "open",
        input: { reuseExistingTab: false, show: false },
      });
      const later = (yield* Clock.currentTimeMillis) + 25 * 60 * 60 * 1000;
      const clock = vi.spyOn(Date, "now").mockReturnValue(later);
      yield* Effect.addFinalizer(() => Effect.sync(() => clock.mockRestore()));
      yield* browser.attachViewer(viewerInput(tabId, false));
      const reopened = yield* open;
      const manager = yield* Manager.PreviewManager;
      const { sessions } = yield* manager.list({ threadId: scope.thread.threadId });
      expect(sessions).toHaveLength(10);
      expect(sessions.map((session) => session.tabId)).toEqual(
        expect.arrayContaining([tabId, reopened.tabId]),
      );
      expect(contexts.filter((context) => !context.page.isClosed())).toHaveLength(2);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("an idle agent tab the desktop renders stays open for the person browsing it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* Broker.PreviewAutomationBroker;
      yield* Effect.yieldNow;
      const open = broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "open",
        input: { reuseExistingTab: false, show: false },
      });
      desktopRendersNext = true;
      const desktopTab = yield* open;
      const openHeadless = broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "open",
        input: { browserHost: "environment", reuseExistingTab: false, show: false },
      });
      const headlessTab = yield* openHeadless;
      const later = (yield* Clock.currentTimeMillis) + 25 * 60 * 60 * 1000;
      const clock = vi.spyOn(Date, "now").mockReturnValue(later);
      yield* Effect.addFinalizer(() => Effect.sync(() => clock.mockRestore()));
      // Opening releases unwatched headless pages without forgetting their tabs.
      const reopened = yield* openHeadless;
      const manager = yield* Manager.PreviewManager;
      const { sessions } = yield* manager.list({ threadId: scope.thread.threadId });
      const openTabIds = sessions.map((session) => session.tabId);
      expect(openTabIds).toContain(desktopTab.tabId);
      expect(openTabIds).toContain(reopened.tabId);
      expect(openTabIds).toContain(headlessTab.tabId);
      expect(contexts[0]!.page.isClosed()).toBe(true);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live.each(["human", "agent"] as const)(
  "a %s environment page stays warm for24h and resets its idle window after viewing",
  (owner) =>
    Effect.scoped(
      Effect.gen(function* () {
        const browser = yield* ServerBrowser.ServerBrowser;
        const broker = yield* Broker.PreviewAutomationBroker;
        const manager = yield* Manager.PreviewManager;
        yield* Effect.yieldNow;
        const initial = yield* Clock.currentTimeMillis;
        const clock = vi.spyOn(Date, "now").mockReturnValue(initial);
        yield* Effect.addFinalizer(() => Effect.sync(() => clock.mockRestore()));
        const opened =
          owner === "human"
            ? yield* manager.open({
                threadId: scope.thread.threadId,
                runtime: "server",
                environmentHosted: true,
                profileId: "incognito",
              })
            : yield* broker.invoke<PreviewAutomationStatus>({
                scope,
                operation: "open",
                input: { browserHost: "environment", open: false },
              });
        const tabId = PreviewTabId.make(opened.tabId!);
        yield* Effect.scoped(browser.attachViewer(viewerInput(tabId, false)));
        const original = contexts[0]!;
        expect(original.sessions[0]!.send).toHaveBeenLastCalledWith("Page.setWebLifecycleState", {
          state: "frozen",
        });
        const sweep = broker.invoke({
          scope: asSession("sweep-agent"),
          operation: "open",
          input: { browserHost: "environment", open: false, reuseExistingTab: false },
        });
        clock.mockReturnValue(initial + 23 * 60 * 60_000);
        yield* sweep;
        expect(original.page.isClosed()).toBe(false);
        yield* Effect.scoped(browser.attachViewer(viewerInput(tabId, false)));
        expect(contexts).toHaveLength(2);
        expect(original.sessions[0]!.send).toHaveBeenCalledWith("Page.setWebLifecycleState", {
          state: "active",
        });
        clock.mockReturnValue(initial + 25 * 60 * 60_000);
        yield* sweep;
        expect(original.page.isClosed()).toBe(false);
        clock.mockReturnValue(initial + 48 * 60 * 60_000);
        yield* sweep;
        expect(original.page.isClosed()).toBe(true);
        expect(original.close).toHaveBeenCalledTimes(1);
        expect((yield* manager.list({ threadId: scope.thread.threadId })).sessions).toContainEqual(
          expect.objectContaining({ tabId, runtime: "server", backingPage: "server" }),
        );
      }),
    ).pipe(Effect.provide(layer)),
);

it.live("human-created pages use the same live-page budget and retain overflow destinations", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* ServerBrowser.ServerBrowser;
      const manager = yield* Manager.PreviewManager;
      for (let count = 0; count < 32; count += 1) {
        const opened = yield* manager.open({
          threadId: scope.thread.threadId,
          runtime: "server",
          environmentHosted: true,
        });
        yield* browser.attachViewer(viewerInput(opened.tabId, false));
      }
      const events = yield* manager.subscribeEvents;
      const opened = yield* manager.open({
        threadId: scope.thread.threadId,
        runtime: "server",
        environmentHosted: true,
        url: "http://127.0.0.1:5173/retained",
      });
      const failure = Option.getOrThrow(
        yield* Stream.fromSubscription(events).pipe(
          Stream.filter((event) => event.type === "failed" && event.tabId === opened.tabId),
          Stream.runHead,
        ),
      );
      expect(failure).toMatchObject({
        type: "failed",
        url: "http://127.0.0.1:5173/retained",
        description: expect.stringContaining("The browser is at capacity"),
      });
      expect(contexts).toHaveLength(32);
      expect((yield* manager.list({ threadId: scope.thread.threadId })).sessions).toContainEqual(
        expect.objectContaining({ tabId: opened.tabId, backingPage: "server" }),
      );
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("retained signed documents renew automatically on warm and cold viewer returns", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* ServerBrowser.ServerBrowser;
      const broker = yield* Broker.PreviewAutomationBroker;
      yield* Effect.yieldNow;
      const initial = yield* Clock.currentTimeMillis;
      const clock = vi.spyOn(Date, "now").mockReturnValue(initial);
      yield* Effect.addFinalizer(() => Effect.sync(() => clock.mockRestore()));
      const claims = {
        version: 1,
        kind: "media-file-exact",
        filePath: "/workspace/report.html",
        device: "1",
        inode: "42",
        expiresAt: initial - 1000,
      };
      const payload = base64UrlEncode(JSON.stringify(claims));
      const token = `${payload}.${signPayload(payload, new Uint8Array(32).fill(7))}`;
      const originalUrl = `http://127.0.0.1:3773/api/assets/${token}/report.html?mode=preview#top`;
      const opened = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "open",
        input: { browserHost: "environment", url: originalUrl, open: false },
      });
      const tabId = PreviewTabId.make(opened.tabId!);
      expect(opened.url).not.toBe(originalUrl);
      const firstUrl = opened.url!;
      clock.mockReturnValue(initial + 24 * 60 * 60_000 - 30_000);
      yield* Effect.scoped(browser.attachViewer(viewerInput(tabId, false)));
      expect(contexts[0]!.page.url()).toBe(firstUrl);
      clock.mockReturnValue(initial + 24 * 60 * 60_000 + 30_000);
      yield* Effect.scoped(browser.attachViewer(viewerInput(tabId, false)));
      const warmUrl = contexts[0]!.page.url();
      expect(warmUrl).not.toBe(firstUrl);
      clock.mockReturnValue(initial + 50 * 60 * 60_000);
      yield* broker.invoke({
        scope: asSession("sweep-agent"),
        operation: "open",
        input: { browserHost: "environment", open: false },
      });
      expect(contexts[0]!.page.isClosed()).toBe(true);
      yield* browser.attachViewer(viewerInput(tabId, false));
      const returned = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId,
        operation: "open",
        input: { open: false },
      });
      expect(returned.url).not.toBe(warmUrl);
      const renewed = new URL(returned.url!);
      expect(renewed.origin).toBe("http://127.0.0.1:3773");
      expect(renewed.search).toBe("?mode=preview");
      expect(renewed.hash).toBe("#top");
      const renewedClaims = JSON.parse(
        base64UrlDecodeUtf8(renewed.pathname.split("/")[3]!.split(".")[0]!),
      );
      expect(renewedClaims).toEqual({ ...claims, expiresAt: initial + 74 * 60 * 60_000 });
    }),
  ).pipe(Effect.provide(layer)),
);

it.live.each(
  ["http:", "https:"].flatMap((protocol) => [true, false].map((owned) => ({ protocol, owned }))),
)(
  "native roots renew only their environment's signed documents on cold and warm returns ($protocol, owned=$owned)",
  ({ protocol, owned }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const initial = yield* Clock.currentTimeMillis;
        using clock = vi.spyOn(Date, "now").mockReturnValue(initial);
        const { browser, manager, tabId } = yield* dormantNativeRoot();
        const claims = {
          version: 1,
          kind: "media-file-exact",
          filePath: "/workspace/report.html",
          device: "1",
          inode: "42",
          expiresAt: initial - 1000,
        };
        const payload = base64UrlEncode(JSON.stringify(claims));
        const token = `${payload}.${signPayload(payload, new Uint8Array(32).fill(owned ? 7 : 8))}`;
        const originalUrl = `${protocol}//environment.example.test:3773/api/assets/${token}/report.html?mode=preview#top`;
        yield* manager.reportStatus({
          threadId: scope.thread.threadId,
          tabId,
          serverControlled: true,
          navStatus: { _tag: "Success", url: originalUrl, title: "Saved document" },
          canGoBack: false,
          canGoForward: false,
        });
        let previousUrl = originalUrl;
        for (const hours of [0, 25]) {
          clock.mockReturnValue(initial + hours * 60 * 60_000);
          yield* Effect.scoped(browser.attachViewer(viewerInput(tabId, false)));
          const destination = desktopConnections.at(-1)!.context.page.url();
          expect(new URL(destination).origin).toBe(new URL(originalUrl).origin);
          expect(new URL(destination).search).toBe("?mode=preview");
          expect(new URL(destination).hash).toBe("#top");
          if (owned) {
            expect(destination).not.toBe(previousUrl);
            const renewed = JSON.parse(
              base64UrlDecodeUtf8(new URL(destination).pathname.split("/")[3]!.split(".")[0]!),
            );
            expect(renewed).toEqual({ ...claims, expiresAt: initial + (hours + 24) * 60 * 60_000 });
          } else expect(destination).toBe(originalUrl);
          previousUrl = destination;
        }
        expect(rootCreations).toHaveLength(2);
        expect(contexts).toHaveLength(0);
      }),
    ).pipe(Effect.provide(layer)),
);

it.live(
  "returning to a dormant handoff releases the oldest inactive rendering without deleting destinations",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { browser, broker, tabId } = yield* ready;
        const later = (yield* Clock.currentTimeMillis) + 25 * 60 * 60_000;
        const clock = vi.spyOn(Date, "now").mockReturnValue(later);
        yield* Effect.addFinalizer(() => Effect.sync(() => clock.mockRestore()));
        const openedIds: Array<PreviewTabId> = [];
        for (let count = 0; count < 32; count += 1) {
          const opened = yield* broker.invoke<PreviewAutomationStatus>({
            scope: count < 8 ? scope : asSession(`capacity-agent-${Math.floor(count / 8)}`),
            operation: "open",
            input: { browserHost: "environment", open: false, reuseExistingTab: false },
          });
          openedIds.push(PreviewTabId.make(opened.tabId!));
        }
        expect(contexts[0]!.page.isClosed()).toBe(true);
        yield* browser.attachViewer(viewerInput(openedIds[0]!, false));
        expect(contexts).toHaveLength(33);
        expect(contexts.filter((context) => !context.page.isClosed())).toHaveLength(32);
        yield* browser.attachViewer(viewerInput(tabId, false));
        expect(contexts).toHaveLength(34);
        expect(contexts.filter((context) => !context.page.isClosed())).toHaveLength(32);
        expect(contexts[1]!.page.isClosed()).toBe(false);
        expect(contexts[2]!.page.isClosed()).toBe(true);
        const manager = yield* Manager.PreviewManager;
        const { sessions } = yield* manager.list({ threadId: scope.thread.threadId });
        expect(sessions).toHaveLength(33);
        expect(sessions.map((session) => session.tabId)).toEqual(
          expect.arrayContaining([tabId, ...openedIds]),
        );
      }),
    ).pipe(Effect.provide(layer)),
);

it.live.each([1, 32])(
  "an owner closes a dormant environment tab without reopening it with %s live pages",
  (livePages) =>
    Effect.scoped(
      Effect.gen(function* () {
        const prepared: Array<{ threadId: string; url: string }> = [];
        hostingPreparation = (input) =>
          Effect.sync(() => {
            prepared.push(input);
            return { managed: true, bootstrapToken: "fixture-close-credential" };
          });
        const broker = yield* Broker.PreviewAutomationBroker;
        const manager = yield* Manager.PreviewManager;
        yield* ServerBrowser.ServerBrowser;
        yield* Effect.yieldNow;
        const opened = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          operation: "open",
          input: {
            browserHost: "environment",
            url: "http://127.0.0.1:5173/fixture",
            open: false,
          },
        });
        const tabId = PreviewTabId.make(opened.tabId!);
        const later = (yield* Clock.currentTimeMillis) + 25 * 60 * 60_000;
        const clock = vi.spyOn(Date, "now").mockReturnValue(later);
        yield* Effect.addFinalizer(() => Effect.sync(() => clock.mockRestore()));
        for (let count = 0; count < livePages; count += 1) {
          yield* broker.invoke({
            scope: asSession(`capacity-agent-${Math.floor(count / 8)}`),
            operation: "open",
            input: { browserHost: "environment", open: false, reuseExistingTab: false },
          });
        }
        expect(contexts[0]!.page.isClosed()).toBe(true);
        const contextsBefore = contexts.length;
        const credentialsBefore = contexts.map((context) => context.request.post.mock.calls.length);
        prepared.length = 0;
        const unauthorized = yield* broker
          .invoke<void>({
            scope: asSession("another-agent"),
            tabId,
            operation: "close",
            input: {},
          })
          .pipe(Effect.flip);
        expect(unauthorized).toMatchObject({
          _tag: "PreviewAutomationControlInterruptedError",
          reason: "agentMismatch",
        });
        expect((yield* manager.list({ threadId: scope.thread.threadId })).sessions).toContainEqual(
          expect.objectContaining({ tabId }),
        );
        yield* broker.invoke({ scope, tabId, operation: "close", input: {} });
        expect(
          (yield* manager.list({ threadId: scope.thread.threadId })).sessions,
        ).not.toContainEqual(expect.objectContaining({ tabId }));
        expect(contexts).toHaveLength(contextsBefore);
        expect(prepared).toEqual([]);
        expect(contexts.map((context) => context.request.post.mock.calls.length)).toEqual(
          credentialsBefore,
        );
      }),
    ).pipe(Effect.provide(layer)),
);

it.live.each(["cold", "visible previous app"])(
  "%s destination stays protected during credential preparation and competing admission",
  (mode) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { browser, broker, tabId } = yield* ready;
        const previousUrl = "http://127.0.0.1:61001/previous";
        const destinationUrl = "http://127.0.0.1:61002/next#preview";
        const competingUrl = "http://127.0.0.1:61003/competing";
        hostingPreparation = () => Effect.succeed({ managed: true });
        if (mode !== "cold") {
          yield* broker.invoke({
            scope,
            tabId,
            operation: "navigate",
            input: { url: previousUrl },
          });
          yield* browser.attachViewer(viewerInput(tabId, false));
        }
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        yield* Effect.addFinalizer(() => Effect.sync(() => release.resolve()));
        credentialPreparation = async (url) => {
          if (!url.startsWith("http://127.0.0.1:61002/")) return;
          entered.resolve();
          await release.promise;
        };
        let competingAdmissions = 0;
        hostingPreparation = ({ url }) =>
          Effect.sync(() => {
            if (url === competingUrl) {
              competingAdmissions += 1;
              expect([...hostingActivities.values()]).toContainEqual(
                expect.objectContaining({ url: destinationUrl, active: true }),
              );
              if (mode !== "cold")
                expect([...hostingActivities.values()]).toContainEqual(
                  expect.objectContaining({ url: previousUrl, active: true }),
                );
              return { managed: false };
            }
            expect([...hostingActivities.values()]).toContainEqual(
              expect.objectContaining({ url: destinationUrl, active: true }),
            );
            return { managed: true, bootstrapToken: "fixture-destination-credential" };
          });
        const pending = yield* (
          mode === "cold"
            ? broker.invoke({
                scope,
                operation: "open",
                input: {
                  browserHost: "environment",
                  url: destinationUrl,
                  open: false,
                  reuseExistingTab: false,
                },
              })
            : broker.invoke({ scope, tabId, operation: "navigate", input: { url: destinationUrl } })
        ).pipe(Effect.forkScoped);
        yield* Effect.promise(() => entered.promise);
        yield* broker.invoke({
          scope,
          operation: "open",
          input: {
            browserHost: "environment",
            url: competingUrl,
            open: false,
            reuseExistingTab: false,
          },
        });
        expect(competingAdmissions).toBeGreaterThan(0);
        release.resolve();
        yield* Fiber.join(pending);
        expect(
          [...hostingActivities.entries()].filter(
            ([id, activity]) =>
              id.startsWith("server-browser-destination:") && activity.url === destinationUrl,
          ),
        ).toEqual([]);
      }),
    ).pipe(Effect.provide(layer)),
);

it.live(
  "native viewer demand protects the managed local listener until the last viewer leaves",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        profileCatalogue = {
          desktopHostId: "fixture-desktop",
          profiles: [{ id: "work", name: "Work", kind: "persistent" }],
          defaultProfileId: "work",
        };
        desktopRendersNext = true;
        const { browser, broker, tabId } = yield* ready;
        const url = "http://localhost:5173/retained?mode=fixture#preview";
        hostingPreparation = () => Effect.succeed({ managed: true });
        yield* broker.invoke({ scope, tabId, operation: "navigate", input: { url } });
        const preparing = Promise.withResolvers<void>();
        const prepared = Promise.withResolvers<void>();
        yield* Effect.addFinalizer(() => Effect.sync(() => prepared.resolve()));
        hostingPreparation = () =>
          Effect.promise(async () => {
            preparing.resolve();
            await prepared.promise;
            return { managed: true };
          });
        const navigation = yield* broker
          .invoke({ scope, tabId, operation: "navigate", input: { url } })
          .pipe(Effect.forkScoped);
        yield* Effect.promise(() => preparing.promise);
        expect([...hostingActivities.values()]).toContainEqual(
          expect.objectContaining({ active: true, url }),
        );
        prepared.resolve();
        yield* Fiber.join(navigation);
        hostingPreparation = () => Effect.succeed({ managed: true });
        let activityId: string;
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* browser.attachViewer(viewerInput(tabId, false));
            activityId = [...hostingActivities.keys()].find((id) =>
              id.startsWith(`server-browser-page:${scope.thread.threadId}\u0000${tabId}:`),
            )!;
            expect(hostingActivities.get(activityId)).toMatchObject({ active: true, url });
            yield* Effect.scoped(browser.attachViewer(viewerInput(tabId, false)));
            expect(hostingActivities.get(activityId)).toMatchObject({ active: true, url });
          }),
        );
        expect(hostingActivities.has(activityId!)).toBe(false);
      }),
    ).pipe(Effect.provide(layer)),
);

it.live.each(["visible", "hidden recording"])(
  "native %s protects a saved private listener without attaching a server browser page",
  (mode) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* ServerBrowser.ServerBrowser;
        const manager = yield* Manager.PreviewManager;
        yield* Effect.yieldNow;
        const localUrl = "http://localhost:5173/form";
        hostingLeases = [
          {
            id: "fixture-lease",
            threadId: scope.thread.threadId,
            terminalId: "fixture-terminal",
            command: "fixture-command",
            cwd: "/tmp/fixture-project",
            worktreePath: null,
            url: localUrl,
            handedOffAt: "2026-01-01T00:00:00.000Z",
            expiresAt: "2026-01-02T00:00:00.000Z",
            status: "active",
          },
        ];
        const snapshot = yield* manager.open({
          threadId: scope.thread.threadId,
          runtime: "desktop",
          desktopHostId: "local",
          url: "http://10.0.0.10:5173/form",
        });
        const activityId = `server-browser-presentation:${scope.thread.threadId}\u0000${snapshot.tabId}`;
        const visible = Promise.withResolvers<void>();
        const hidden = Promise.withResolvers<void>();
        let wasActive = false;
        hostingActivityObserved = (input) => {
          if (input.activityId !== activityId) return;
          if (input.active) {
            wasActive = true;
            visible.resolve();
          } else if (wasActive) hidden.resolve();
        };
        const activeTabs = mode === "visible" ? presentedDesktopTabs : renderingDesktopTabs;
        activeTabs.add(snapshot.tabId);
        desktopPresentations.emit("presentation", {
          threadId: scope.thread.threadId,
          tabId: snapshot.tabId,
          desktopHostId: "local",
        });
        yield* Effect.promise(() => visible.promise);
        expect(hostingActivities.get(activityId)).toMatchObject({ url: localUrl, active: true });
        expect(presentedDesktopTabs.has(snapshot.tabId)).toBe(mode === "visible");
        activeTabs.delete(snapshot.tabId);
        desktopPresentations.emit("presentation", {
          threadId: scope.thread.threadId,
          tabId: snapshot.tabId,
          desktopHostId: "local",
        });
        yield* Effect.promise(() => hidden.promise);
        expect(hostingActivities.has(activityId)).toBe(false);
        expect(contexts).toHaveLength(0);
        expect(desktopConnections).toHaveLength(0);
      }),
    ).pipe(Effect.provide(layer)),
);

it.live("a streamed embedded native guest delegates ordinary return to its existing renderer", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* ServerBrowser.ServerBrowser;
      const manager = yield* Manager.PreviewManager;
      yield* Effect.yieldNow;
      const url = "http://127.0.0.1:5173/native-embedded";
      desktopRendersNext = true;
      desktopPageSetup = async (context) => {
        await context.page.goto(url);
        context.page.goto.mockClear();
      };
      const prepared = vi.fn(() => Effect.succeed({ managed: true, runId: "renderer-owned-run" }));
      hostingPreparation = prepared;
      const snapshot = yield* manager.open({
        threadId: scope.thread.threadId,
        runtime: "server",
        desktopHostId: "local",
        url,
      });
      yield* browser.attachViewer(viewerInput(snapshot.tabId, false));
      yield* browser.attachViewer(viewerInput(snapshot.tabId, false));
      expect(snapshot.backingPage).toBe("desktop");
      expect(prepared).not.toHaveBeenCalled();
      expect(desktopConnections[0]!.context.page.goto).not.toHaveBeenCalled();
      expect(desktopConnections).toHaveLength(1);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live.each([false, true])(
  "adopting a prepared native page reloads only after an actual first-visit restart (%s)",
  (restarted) =>
    Effect.scoped(
      Effect.gen(function* () {
        desktopRendersNext = true;
        const url = "http://127.0.0.1:5173/native-retained";
        desktopPageSetup = async (context) => {
          await context.page.goto(url);
          context.page.goto.mockClear();
        };
        hostingPreparation = () =>
          Effect.succeed({ managed: true, runId: "native-rendered-run", restarted });
        const { browser, tabId } = yield* ready;
        const page = desktopConnections[0]!.context.page;
        yield* browser.attachViewer(viewerInput(tabId, false));
        expect(page.reload).toHaveBeenCalledTimes(restarted ? 1 : 0);
        expect(page.goto).not.toHaveBeenCalled();
        page.reload.mockClear();
        hostingPreparation = () => Effect.succeed({ managed: true, runId: "native-new-run" });
        yield* browser.attachViewer(viewerInput(tabId, false));
        expect(page.reload).toHaveBeenCalledExactlyOnceWith(expect.anything());
        expect(page.goto).not.toHaveBeenCalled();
      }),
    ).pipe(Effect.provide(layer)),
);

it.live.each([
  ...[false, true].flatMap((restarted) =>
    ["saved", "changed"].map((fragment) => ({
      destination: `/check?case=return#${fragment}`,
      previousRunId: "first-run",
      runId: "next-run",
      restarted,
      reload: true,
      documentRun: "next-run",
    })),
  ),
  {
    destination: "/check?case=return#changed",
    previousRunId: "first-run",
    runId: "first-run",
    restarted: false,
    reload: false,
    documentRun: "first-run",
  },
  {
    destination: "/other?case=return#saved",
    previousRunId: "first-run",
    runId: "next-run",
    restarted: false,
    reload: false,
    documentRun: "next-run",
  },
  {
    destination: "/check?case=return#saved",
    previousRunId: undefined,
    runId: undefined,
    restarted: true,
    reload: true,
    documentRun: "next-run",
  },
])(
  "reused native automation loads $documentRun at $destination (restarted: $restarted)",
  ({ destination, previousRunId, runId, restarted, reload, documentRun: expectedRun }) =>
    Effect.scoped(
      Effect.gen(function* () {
        desktopRendersNext = true;
        const { browser, broker, tabId } = yield* ready;
        const url = "http://127.0.0.1:5173/check?case=return#saved";
        hostingPreparation = () => Effect.succeed({ managed: true, runId: previousRunId });
        yield* broker.invoke({ scope, tabId, operation: "navigate", input: { url } });
        const page = desktopConnections[0]!.context.page;
        let documentRun = "first-run";
        let input = "edited";
        const goto = page.goto.getMockImplementation()!;
        page.goto.mockImplementation(async (next) => {
          const sameDocument = next.split("#")[0] === page.url().split("#")[0];
          await goto(next);
          if (sameDocument) return null;
          documentRun = "next-run";
          input = "";
        });
        page.reload.mockImplementation(async () => {
          documentRun = "next-run";
          input = "";
        });
        hostingPreparation = () => Effect.succeed({ managed: true, runId, restarted });
        const target = new URL(destination, url).href;
        yield* broker.invoke({ scope, tabId, operation: "navigate", input: { url: target } });
        expect(page.url()).toBe(target);
        expect(documentRun).toBe(expectedRun);
        expect(input).toBe(expectedRun === "first-run" ? "edited" : "");
        expect(page.reload).toHaveBeenCalledTimes(reload ? 1 : 0);
        page.reload.mockClear();
        hostingPreparation = () => Effect.succeed({ managed: true, runId });
        yield* browser.attachViewer(viewerInput(tabId, false));
        expect(page.reload).not.toHaveBeenCalled();
      }),
    ).pipe(Effect.provide(layer)),
);

it.live("a failed same-document recovery keeps the old run for an automation retry", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, broker, tabId } = yield* ready;
      const url = "http://127.0.0.1:5173/check#saved";
      hostingPreparation = () => Effect.succeed({ managed: true, runId: "first-run" });
      yield* broker.invoke({ scope, tabId, operation: "navigate", input: { url } });
      const page = contexts[0]!.page;
      page.goto.mockResolvedValue(null);
      page.reload.mockRejectedValueOnce(new Error("net::ERR_CONNECTION_REFUSED"));
      hostingPreparation = () => Effect.succeed({ managed: true, runId: "next-run" });
      const failed = yield* broker
        .invoke({ scope, tabId, operation: "navigate", input: { url } })
        .pipe(Effect.exit);
      expect(Exit.isFailure(failed)).toBe(true);
      yield* broker.invoke({ scope, tabId, operation: "navigate", input: { url } });
      expect(page.reload).toHaveBeenCalledTimes(2);
      page.reload.mockClear();
      yield* browser.attachViewer(viewerInput(tabId, false));
      expect(page.reload).not.toHaveBeenCalled();
    }),
  ).pipe(Effect.provide(layer)),
);

it.live.each([
  "about:blank",
  "http://127.0.0.1:5175/original",
  "http://127.0.0.1:5173/delayed#saved",
])("a nonblocking navigation from %s records its run after the destination commits", (original) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, broker, tabId } = yield* ready;
      hostingPreparation = () => Effect.succeed({ managed: true, runId: "first-run" });
      const page = contexts[0]!.page;
      if (original !== "about:blank")
        yield* broker.invoke({ scope, tabId, operation: "navigate", input: { url: original } });
      const commit = Promise.withResolvers<void>();
      yield* Effect.addFinalizer(() => Effect.sync(() => commit.resolve()));
      const destination = "http://127.0.0.1:5173/delayed#saved";
      const sameDocument = original === destination;
      if (sameDocument) {
        hostingPreparation = () => Effect.succeed({ managed: true, runId: "next-run" });
        page.goto.mockResolvedValue(null);
        const reload = page.reload.getMockImplementation()!;
        page.reload.mockImplementationOnce(async () => {
          await commit.promise;
          await reload();
        });
      } else {
        const goto = page.goto.getMockImplementation()!;
        page.goto.mockImplementationOnce(async (url) => {
          await commit.promise;
          await goto(url);
        });
      }
      yield* broker.invoke({
        scope,
        tabId,
        operation: "navigate",
        input: { url: destination, readiness: "none" },
      });
      expect(page.url()).toBe(original);
      commit.resolve();
      yield* broker.invoke({ scope, tabId, operation: "evaluate", input: { expression: "1" } });
      expect(page.url()).toBe(destination);
      expect(page.reload).toHaveBeenCalledTimes(sameDocument ? 1 : 0);
      page.goto.mockClear();
      page.reload.mockClear();
      hostingPreparation = () => Effect.succeed({ managed: true, runId: "recovered-run" });
      yield* browser.attachViewer(viewerInput(tabId, false));
      expect(page.goto).not.toHaveBeenCalled();
      expect(page.reload).toHaveBeenCalledExactlyOnceWith(expect.anything());
    }),
  ).pipe(Effect.provide(layer)),
);

it.live.each([5_000, 10_000])(
  "same-document recovery shares its timeout after navigation consumes %s ms",
  (elapsed) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { broker, tabId } = yield* ready;
        const url = "http://127.0.0.1:5173/check#saved";
        hostingPreparation = () => Effect.succeed({ managed: true, runId: "first-run" });
        yield* broker.invoke({ scope, tabId, operation: "navigate", input: { url } });
        const clock = yield* Clock.Clock;
        let monotonic = clock.monotonicTimeNanosUnsafe();
        using _clock = vi
          .spyOn(clock, "monotonicTimeNanosUnsafe")
          .mockImplementation(() => monotonic);
        const page = contexts[0]!.page;
        page.goto.mockImplementation(async () => {
          monotonic += BigInt(elapsed) * 1_000_000n;
          return null;
        });
        hostingPreparation = () => Effect.succeed({ managed: true, runId: "next-run" });
        const result = yield* broker
          .invoke({ scope, tabId, operation: "navigate", input: { url, timeoutMs: 10_000 } })
          .pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(elapsed === 10_000);
        if (elapsed === 10_000) expect(page.reload).not.toHaveBeenCalled();
        else
          expect(page.reload).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ timeout: 5_000 }),
          );
      }),
    ).pipe(Effect.provide(layer)),
);

it.live("a redirect to another managed listener preserves its healthy page on return", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, broker, tabId } = yield* ready;
      const original = "http://127.0.0.1:5173/redirect";
      const destination = "http://127.0.0.1:5174/form";
      hostingPreparation = ({ url }) =>
        Effect.succeed({
          managed: true,
          runId:
            new URL(url).origin === new URL(original).origin ? "original-run" : "destination-run",
        });
      const page = contexts[0]!.page;
      const goto = page.goto.getMockImplementation()!;
      page.goto.mockImplementationOnce(async () => goto(destination));
      yield* broker.invoke({ scope, tabId, operation: "navigate", input: { url: original } });
      expect(page.url()).toBe(destination);
      page.goto.mockClear();
      yield* browser.attachViewer(viewerInput(tabId, false));
      expect(page.goto).not.toHaveBeenCalled();
      expect(page.reload).not.toHaveBeenCalled();
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("a same-listener path change retains the baseline for a run recovered elsewhere", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, broker, tabId } = yield* ready;
      hostingPreparation = () => Effect.succeed({ managed: true, runId: "original-run" });
      yield* broker.invoke({
        scope,
        tabId,
        operation: "navigate",
        input: { url: "http://127.0.0.1:5173/original" },
      });
      const page = contexts[0]!.page;
      const destination = "http://127.0.0.1:5173/form#edited";
      yield* Effect.promise(() => page.goto(destination));
      page.goto.mockClear();
      hostingPreparation = () => Effect.succeed({ managed: true, runId: "recovered-run" });
      yield* browser.attachViewer(viewerInput(tabId, false));
      expect(page.goto).not.toHaveBeenCalled();
      expect(page.reload).toHaveBeenCalledExactlyOnceWith(expect.anything());
      expect(page.url()).toBe(destination);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live.each(["http://127.0.0.1:5174/form#details", "http://127.0.0.1:5173/other-app#details"])(
  "a warm viewer preserves a healthy page after in-page navigation to %s",
  (destination) =>
    Effect.scoped(
      Effect.gen(function* () {
        const browser = yield* ServerBrowser.ServerBrowser;
        const broker = yield* Broker.PreviewAutomationBroker;
        yield* Effect.yieldNow;
        const original = "http://127.0.0.1:5173/retained";
        let destinationRun = "destination-run";
        hostingPreparation = ({ url }) =>
          Effect.succeed({
            managed: true,
            runId:
              new URL(url).origin === new URL(destination).origin ? destinationRun : "original-run",
            bootstrapToken: "fixture-navigation-credential",
          });
        const opened = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          operation: "open",
          input: { browserHost: "environment", url: original, open: false },
        });
        const tabId = PreviewTabId.make(opened.tabId!);
        const page = contexts[0]!.page;
        yield* Effect.promise(() => page.goto(destination));
        page.goto.mockClear();
        yield* Effect.scoped(browser.attachViewer(viewerInput(tabId, false)));
        expect(page.goto).not.toHaveBeenCalled();
        expect(page.reload).not.toHaveBeenCalled();

        const fragmentDestination = destination.replace("#details", "#edited");
        yield* Effect.promise(() => page.goto(fragmentDestination));
        page.emit("framenavigated", page);
        page.goto.mockClear();
        yield* Effect.scoped(browser.attachViewer(viewerInput(tabId, false)));
        expect(page.goto).not.toHaveBeenCalled();
        expect(page.reload).not.toHaveBeenCalled();

        destinationRun = "restarted-destination-run";
        const restartedDestination = destination.replace("#details", "#latest");
        yield* Effect.promise(() => page.goto(restartedDestination));
        page.emit("framenavigated", page);
        page.goto.mockClear();
        yield* Effect.scoped(browser.attachViewer(viewerInput(tabId, false)));
        expect(page.goto).not.toHaveBeenCalled();
        expect(page.reload).toHaveBeenCalledExactlyOnceWith(expect.anything());
        expect(page.url()).toBe(restartedDestination);
        expect(contexts[0]!.request.post).toHaveBeenLastCalledWith(
          `${new URL(destination).origin}/api/auth/browser-session`,
          expect.objectContaining({ data: { credential: "fixture-navigation-credential" } }),
        );
        expect(contexts).toHaveLength(1);
      }),
    ).pipe(Effect.provide(layer)),
);

it.live.each([
  { previousRunId: undefined, runId: undefined, restarted: false, reload: false },
  { previousRunId: undefined, runId: undefined, restarted: true, reload: true },
  { previousRunId: "previous-run", runId: "previous-run", restarted: false, reload: false },
  { previousRunId: undefined, runId: "first-replayed-run", restarted: false, reload: true },
  {
    previousRunId: "previous-run",
    runId: "resource-restarted-run",
    restarted: false,
    reload: true,
  },
])(
  "a warm viewer reloads after a changed app run even when another preparer restarted it ($runId)",
  ({ previousRunId, runId, restarted, reload }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const browser = yield* ServerBrowser.ServerBrowser;
        const broker = yield* Broker.PreviewAutomationBroker;
        yield* Effect.yieldNow;
        hostingPreparation = () => Effect.succeed({ managed: true, runId: previousRunId });
        const url = "http://127.0.0.1:5173/retained";
        const opened = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          operation: "open",
          input: { browserHost: "environment", url, open: false },
        });
        const tabId = PreviewTabId.make(opened.tabId!);
        const page = contexts[0]!.page;
        page.goto.mockClear();
        hostingPreparation = () =>
          Effect.succeed({
            managed: true,
            restarted,
            runId,
            bootstrapToken: "fixture-return-credential",
          });
        yield* browser.attachViewer(viewerInput(tabId, false));
        expect(page.goto).not.toHaveBeenCalled();
        expect(page.reload).toHaveBeenCalledTimes(reload ? 1 : 0);
        expect(contexts[0]!.request.post).toHaveBeenCalledWith(
          "http://127.0.0.1:5173/api/auth/browser-session",
          expect.objectContaining({ data: { credential: "fixture-return-credential" } }),
        );
        expect(contexts).toHaveLength(1);
      }),
    ).pipe(Effect.provide(layer)),
);

it.live(
  "cold preparation failures report LoadFailed and the same viewer target retries automatically",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const browser = yield* ServerBrowser.ServerBrowser;
        const broker = yield* Broker.PreviewAutomationBroker;
        const manager = yield* Manager.PreviewManager;
        yield* Effect.yieldNow;
        const url = "http://127.0.0.1:5173/retained";
        const opened = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          operation: "open",
          input: { browserHost: "environment", url, open: false },
        });
        const tabId = PreviewTabId.make(opened.tabId!);
        const later = (yield* Clock.currentTimeMillis) + 25 * 60 * 60_000;
        const clock = vi.spyOn(Date, "now").mockReturnValue(later);
        yield* Effect.addFinalizer(() => Effect.sync(() => clock.mockRestore()));
        yield* broker.invoke({
          scope: asSession("sweep-agent"),
          operation: "open",
          input: { browserHost: "environment", open: false },
        });
        hostingPreparation = () =>
          Effect.fail(
            new HostingAuth.PreviewHostingAuthError({
              reason: "bootstrap_failed",
              boundary: "browser_descriptor",
            }),
          );
        const result = yield* browser.attachViewer(viewerInput(tabId, false)).pipe(Effect.result);
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "ServerBrowserLaunchError" },
        });
        expect(contexts[2]!.page.goto).not.toHaveBeenCalled();
        expect((yield* manager.list({ threadId: scope.thread.threadId })).sessions).toContainEqual(
          expect.objectContaining({
            tabId,
            navStatus: expect.objectContaining({ _tag: "LoadFailed", url }),
          }),
        );
        expect(contexts[2]!.page.isClosed()).toBe(true);
        hostingPreparation = () =>
          Effect.succeed({ managed: true, bootstrapToken: "fixture-retry-credential" });
        yield* browser.attachViewer(viewerInput(tabId, false));
        expect(contexts[3]!.page.goto).toHaveBeenCalledWith(url, expect.anything());
        expect(contexts[3]!.request.post).toHaveBeenCalledWith(
          "http://127.0.0.1:5173/api/auth/browser-session",
          expect.objectContaining({ data: { credential: "fixture-retry-credential" } }),
        );
      }),
    ).pipe(Effect.provide(layer)),
);

it.live.each(["page", "context"] as const)(
  "an unexpected %s failure preserves a cold-recoverable handoff",
  (failure) =>
    Effect.scoped(
      Effect.gen(function* () {
        const browser = yield* ServerBrowser.ServerBrowser;
        const broker = yield* Broker.PreviewAutomationBroker;
        const manager = yield* Manager.PreviewManager;
        yield* Effect.yieldNow;
        const url = "http://127.0.0.1:5173/retained";
        const opened = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          operation: "open",
          input: { browserHost: "environment", url, open: false },
        });
        const tabId = PreviewTabId.make(opened.tabId!);
        const viewer = yield* browser.attachViewer(viewerInput(tabId, false));
        if (failure === "page") contexts[0]!.page.emit("crash");
        else yield* Effect.promise(() => contexts[0]!.close());
        let ending = yield* Queue.take(viewer.output);
        while (ending._tag !== "reconnect") ending = yield* Queue.take(viewer.output);
        expect((yield* manager.list({ threadId: scope.thread.threadId })).sessions).toContainEqual(
          expect.objectContaining({ tabId }),
        );
        yield* browser.attachViewer(viewerInput(tabId, false));
        expect(contexts[1]!.page.goto).toHaveBeenCalledWith(url, expect.anything());
      }),
    ).pipe(Effect.provide(layer)),
);

it.live("browser shutdown preserves targets and restarting its host keeps pages dormant", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const manager = yield* Manager.PreviewManager;
      const broker = yield* Broker.PreviewAutomationBroker;
      const url = "http://127.0.0.1:5173/retained";
      const opened = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* ServerBrowser.ServerBrowser;
          yield* Effect.yieldNow;
          return yield* broker.invoke<PreviewAutomationStatus>({
            scope,
            operation: "open",
            input: { browserHost: "environment", url, open: false },
          });
        }).pipe(Effect.provide(ServerBrowser.layer)),
      );
      const tabId = PreviewTabId.make(opened.tabId!);
      expect(contexts[0]!.page.isClosed()).toBe(true);
      expect((yield* manager.list({ threadId: scope.thread.threadId })).sessions).toContainEqual(
        expect.objectContaining({ tabId }),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const browser = yield* ServerBrowser.ServerBrowser;
          expect(contexts).toHaveLength(1);
          yield* browser.attachViewer(viewerInput(tabId, false));
          expect(contexts).toHaveLength(2);
          expect(contexts[1]!.page.goto).toHaveBeenCalledWith(url, expect.anything());
        }).pipe(Effect.provide(ServerBrowser.layer)),
      );
    }),
  ).pipe(Effect.provide(observedManager)),
);

it.live.each(["managed", "public", "unknown"] as const)(
  "a fresh server returns to a remote HTTP native session using only retained verified ownership: %s",
  (kind) =>
    Effect.scoped(
      Effect.gen(function* () {
        profileCatalogue = {
          desktopHostId: "fixture-desktop",
          profiles: [{ id: "work", name: "Work", kind: "persistent" }],
          defaultProfileId: "work",
        };
        desktopRendersNext = true;
        const localUrl = "http://localhost:5173/retained?q=1#anchor";
        const browserUrl = localUrl.replace("localhost", remoteUrlHostname);
        const url =
          kind === "managed"
            ? localUrl
            : kind === "public"
              ? "http://public.example.test:5173/retained?q=1#anchor"
              : browserUrl;
        let cold = false;
        let recoveries = 0;
        const prepared: Array<{ threadId: string; url: string; browserUrl?: string }> = [];
        hostingPreparation = (input) =>
          Effect.sync(() => {
            prepared.push(input);
            // Production rejects remote HTTP before considering any owned listener.
            if (input.threadId !== testThread.threadId || input.url !== localUrl)
              return { managed: false };
            if (cold) recoveries += 1;
            return {
              managed: true,
              restarted: cold,
              runId: cold ? "recovered-run" : "initial-run",
              bootstrapToken: cold ? "fixture-fresh-credential" : "fixture-initial-credential",
            };
          });
        const broker = yield* Broker.PreviewAutomationBroker;
        const manager = yield* Manager.PreviewManager;
        const opened = yield* Effect.scoped(
          Effect.gen(function* () {
            yield* ServerBrowser.ServerBrowser;
            yield* Effect.yieldNow;
            return yield* broker.invoke<PreviewAutomationStatus>({
              scope,
              operation: "open",
              input: { url, open: false },
            });
          }).pipe(Effect.provide(ServerBrowser.layer)),
        );
        const savedUrl = kind === "managed" ? browserUrl : url;
        expect(opened.url).toBe(savedUrl);
        expect((yield* manager.list({})).sessions[0]?.navStatus).toMatchObject({ url: savedUrl });
        const restarted = yield* Manager.make;
        expect((yield* restarted.list({})).serverEpoch).not.toBe(
          (yield* manager.list({})).serverEpoch,
        );
        prepared.length = 0;
        cold = true;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const browser = yield* ServerBrowser.ServerBrowser;
            const broker = yield* Broker.PreviewAutomationBroker;
            yield* Effect.yieldNow;
            expect(rootCreations).toHaveLength(1);
            const invoked = vi.spyOn(broker, "invoke");
            yield* Effect.addFinalizer(() => Effect.sync(() => invoked.mockRestore()));
            yield* browser.attachViewer(viewerInput(opened.tabId!, false));
            expect(invoked).not.toHaveBeenCalled();
            expect(prepared).toEqual([
              {
                threadId: testThread.threadId,
                url: kind === "managed" ? localUrl : savedUrl,
                ...(kind === "managed" ? { browserUrl } : {}),
              },
            ]);
            const selected = desktopConnections.at(-1)!.context;
            expect(selected.page.goto).toHaveBeenCalledExactlyOnceWith(savedUrl, expect.anything());
            if (kind === "managed") {
              expect(recoveries).toBe(1);
              expect(selected.request.post).toHaveBeenCalledExactlyOnceWith(
                "http://environment.example.test:5173/api/auth/browser-session",
                expect.objectContaining({ data: { credential: "fixture-fresh-credential" } }),
              );
            } else {
              expect(recoveries).toBe(0);
              expect(selected.request.post).not.toHaveBeenCalled();
            }
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const config = yield* ServerConfig.ServerConfig;
            const stored = yield* fs.readFileString(
              path.join(config.stateDir, "preview-sessions.json"),
            );
            expect(stored).not.toContain("fixture-initial-credential");
            expect(stored).not.toContain("fixture-fresh-credential");
            expect((yield* restarted.list({})).sessions[0]).not.toHaveProperty("hostedOrigins");
          }).pipe(
            Effect.provide(ServerBrowser.layer.pipe(Layer.provideMerge(Broker.layer))),
            Effect.provideService(Manager.PreviewManager, restarted),
          ),
        );
      }),
    ).pipe(Effect.provide(observedManager)),
);

it.live(
  "a restarted server restores a dedicated native root on viewer return with working keyboard input",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        profileCatalogue = {
          desktopHostId: "host-a",
          profiles: [{ id: "work", name: "Work", kind: "persistent" }],
          defaultProfileId: "work",
        };
        desktopRendersNext = true;
        const broker = yield* Broker.PreviewAutomationBroker;
        const manager = yield* Manager.PreviewManager;
        const url = "https://native.example.test/retained";
        const opened = yield* Effect.scoped(
          Effect.gen(function* () {
            yield* ServerBrowser.ServerBrowser;
            yield* Effect.yieldNow;
            return yield* broker.invoke<PreviewAutomationStatus>({
              scope,
              operation: "open",
              input: { url, open: false },
            });
          }).pipe(Effect.provide(ServerBrowser.layer)),
        );
        const original = (yield* manager.list({})).sessions[0]!;
        const restarted = yield* Manager.make;
        const before = yield* restarted.list({});
        expect(before.serverEpoch).not.toBe((yield* manager.list({})).serverEpoch);
        expect(before.sessions[0]).not.toHaveProperty("desktopRootId");
        yield* Effect.scoped(
          Effect.gen(function* () {
            const browser = yield* ServerBrowser.ServerBrowser;
            yield* Effect.yieldNow;
            const status = yield* broker.invoke<PreviewAutomationStatus>({
              scope,
              operation: "status",
              input: {},
            });
            expect(status.tabs?.map((tab) => tab.tabId)).toEqual([opened.tabId]);
            expect(rootCreations).toHaveLength(1);
            yield* browser.attachViewer(viewerInput(opened.tabId!, false));
            const page = desktopConnections.at(-1)!.context.page;
            page.locator.mockReturnValue({ evaluate: async () => true } as never);
            yield* broker.invoke({
              scope,
              tabId: opened.tabId!,
              operation: "type",
              input: { locator: "#field", text: "after restart" },
            });
            yield* broker.invoke({
              scope,
              tabId: opened.tabId!,
              operation: "press",
              input: { key: "Enter" },
            });
            expect(page.keyboard.insertText).toHaveBeenCalledExactlyOnceWith("after restart");
            expect(page.keyboard.press).toHaveBeenCalledExactlyOnceWith("Enter");
            expect(rootCreations).toHaveLength(2);
            expect(rootCreations[1]).toMatchObject({
              tabId: opened.tabId,
              desktopHostId: "host-a",
              profileId: "work",
              url,
              serverEpoch: before.serverEpoch,
            });
            expect((yield* restarted.list({})).sessions[0]).toMatchObject({
              tabId: opened.tabId,
              backingPage: "desktop-root",
              desktopRootId: `root-${opened.tabId}-2`,
              profileId: "work",
              desktopHostId: "host-a",
              automationOwner: original.automationOwner,
            });
            expect(contexts).toHaveLength(0);
            yield* broker.invoke({ scope, tabId: opened.tabId!, operation: "close", input: {} });
            expect(rootClosures.at(-1)?.rootId).toBe(`root-${opened.tabId}-2`);
            expect((yield* restarted.list({})).sessions).toEqual([]);
          }).pipe(
            Effect.provide(ServerBrowser.layer),
            Effect.provideService(Manager.PreviewManager, restarted),
          ),
        );
      }),
    ).pipe(Effect.provide(observedManager)),
);

it.live.each([
  ["Success", "incognito"],
  ["LoadFailed", "incognito"],
  ["Success", "default"],
  ["LoadFailed", "default"],
] as const)(
  "an idle environment tab resumes its saved %s page in profile %s",
  ([status, profileId]) =>
    Effect.scoped(
      Effect.gen(function* () {
        profileCatalogue = {
          desktopHostId: "fixture-desktop",
          profiles: [{ id: "work", name: "Work", kind: "persistent" }],
          defaultProfileId: "work",
        };
        const prepared: Array<{ threadId: string; url: string }> = [];
        hostingPreparation = (input) =>
          Effect.sync(() => {
            prepared.push(input);
            return { managed: true, bootstrapToken: "fixture-fresh-credential" };
          });
        const browser = yield* ServerBrowser.ServerBrowser;
        const broker = yield* Broker.PreviewAutomationBroker;
        const manager = yield* Manager.PreviewManager;
        yield* Effect.yieldNow;
        const url = "http://127.0.0.1:5173/fixture?q=1#anchor";
        const opened = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          operation: "open",
          input: { browserHost: "environment", profileId, url, open: false },
        });
        const tabId = PreviewTabId.make(opened.tabId!);
        yield* manager.reportStatus({
          threadId: scope.thread.threadId,
          tabId,
          serverControlled: true,
          navStatus:
            status === "Success"
              ? { _tag: "Success", url, title: "Retained fixture" }
              : {
                  _tag: "LoadFailed",
                  url,
                  title: "",
                  code: -102,
                  description: "ERR_CONNECTION_REFUSED",
                },
          canGoBack: false,
          canGoForward: false,
        });
        const saved = (yield* manager.list({ threadId: scope.thread.threadId })).sessions[0]!;
        const later = (yield* Clock.currentTimeMillis) + 25 * 60 * 60_000;
        const clock = vi.spyOn(Date, "now").mockReturnValue(later);
        yield* Effect.addFinalizer(() => Effect.sync(() => clock.mockRestore()));
        yield* broker.invoke({
          scope: asSession("sweep-agent"),
          operation: "open",
          input: { browserHost: "environment", reuseExistingTab: false, open: false },
        });
        expect(contexts[0]!.page.isClosed()).toBe(true);
        expect(contexts[0]!.close).toHaveBeenCalledTimes(profileId === "incognito" ? 1 : 0);
        expect((yield* manager.list({ threadId: scope.thread.threadId })).sessions).toContainEqual(
          saved,
        );
        const dormant = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          operation: "status",
          input: {},
        });
        expect(dormant).toMatchObject({
          available: false,
          browserHost: "environment",
          tabId,
          url,
          profileId,
          defaultProfileId: "incognito",
          tabs: expect.arrayContaining([
            expect.objectContaining({ tabId, url, profileId, ownedByCaller: true, visible: false }),
          ]),
        });
        expect(contexts).toHaveLength(2);
        prepared.length = 0;
        yield* browser.attachViewer(viewerInput(tabId, false));
        const resumed = contexts[2]!;
        yield* broker.invoke({ scope, operation: "snapshot", input: {} });
        expect(prepared).toEqual([{ threadId: scope.thread.threadId, url }]);
        expect(resumed.request.post).toHaveBeenCalledExactlyOnceWith(
          "http://127.0.0.1:5173/api/auth/browser-session",
          expect.objectContaining({ data: { credential: "fixture-fresh-credential" } }),
        );
        expect(resumed.page.goto).toHaveBeenCalledExactlyOnceWith(url, expect.anything());
        expect(contextRequests[2]).toEqual({ profileId, isolated: profileId === "incognito" });
        const reopened = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          operation: "open",
          input: { open: false },
        });
        expect(reopened).toMatchObject({ tabId, url, browserHost: "environment", profileId });
        expect(contexts).toHaveLength(3);
        expect(profileRequests).toEqual([]);
        expect(rootCreations).toEqual([]);
        expect((yield* manager.list({ threadId: scope.thread.threadId })).sessions).toContainEqual(
          expect.objectContaining({
            tabId,
            runtime: "server",
            backingPage: "server",
            automationOwner: saved.automationOwner,
            profileId,
          }),
        );
      }),
    ).pipe(Effect.provide(layer)),
);

it.effect.each([
  "layout-timeout",
  "surface-unsupported",
  "guest-unavailable",
  "host-unavailable",
] as const)(
  "reports native %s without dispatching the page mutation or evicting the host",
  (reason) =>
    Effect.scoped(
      Effect.gen(function* () {
        desktopRendersNext = true;
        const { broker, tabId } = yield* ready;
        surfaceCalls.length = 0;
        surfaceFailure = new DesktopBrowserTransportError({ reason });
        for (const request of [
          { operation: "click", input: { locator: "button" } },
          { operation: "navigate", input: { url: "https://page.example/" } },
          { operation: "waitFor", input: { text: "ready" } },
          { operation: "evaluate", input: { expression: "1" } },
        ] as const) {
          const error = yield* broker.invoke<void>({ scope, tabId, ...request }).pipe(Effect.flip);
          expect(error).toMatchObject({
            _tag: "PreviewAutomationRemoteUnavailableError",
            operation: request.operation,
            requestId: expect.stringMatching(/^preview-\d+$/),
            connectionId: expect.any(String),
            reason,
            cause: { detail: { reason } },
          });
          expect(surfaceCalls.slice(-2).map((call) => call.action)).toEqual(["acquire", "release"]);
          if (request.operation === "click")
            expect(surfaceCalls.map((call) => call.action)).toEqual(["acquire", "release"]);
        }
        expect(desktopConnections[0]!.context.page.locator).not.toHaveBeenCalled();
        expect(surfaceCalls.map((call) => call.action)).toEqual([
          "acquire",
          "release",
          "acquire",
          "release",
          "acquire",
          "release",
          "acquire",
          "release",
        ]);
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
          automationOwner: `${scope.environmentId}\u0000${scope.thread.providerSessionId}\u0000${scope.thread.threadId}`,
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
          automationOwner: `${scope.environmentId}\u0000${scope.thread.providerSessionId}\u0000${scope.thread.threadId}`,
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

it.live.each(["absent", "present", "unavailable"] as const)(
  "reconnect reconciles an ordinary offline root close without consuming headless capacity (%s)",
  (presence) =>
    Effect.scoped(
      Effect.gen(function* () {
        profileCatalogue = {
          desktopHostId: "host-a",
          profiles: [{ id: "work", name: "Work", kind: "persistent" }],
          defaultProfileId: "work",
        };
        desktopRendersNext = true;
        const { broker, browser, tabId } = yield* ready;
        const manager = yield* Manager.PreviewManager;
        const viewer = yield* browser.attachViewer(viewerInput(tabId, false));
        desktopDetaches.emit("detach", {
          threadId: scope.thread.threadId,
          tabId,
          desktopHostId: "host-a",
        });
        let ending = yield* Queue.take(viewer.output);
        while (ending._tag !== "reconnect") ending = yield* Queue.take(viewer.output);
        for (let index = 1; index < 8; index++) {
          desktopRendersNext = true;
          yield* broker.invoke<PreviewAutomationStatus>({
            scope,
            operation: "open",
            input: { reuseExistingTab: false, show: false },
          });
        }
        const before = yield* manager.list({});
        expect(before.sessions).toHaveLength(8);
        expect(rootCreations.every((root) => root.serverEpoch === before.serverEpoch)).toBe(true);
        nativeRootPresence.set(`root-${tabId}`, presence !== "absent");
        nativeRootProbeUnavailable = presence === "unavailable";
        nativeRootProbeEntered = Promise.withResolvers<void>();
        nativeRootProbeProcessed = Promise.withResolvers<void>();
        nativeRootProbeGate = Promise.withResolvers<void>();
        nativeCloseProcessed = Promise.withResolvers<void>();
        yield* Effect.addFinalizer(() => Effect.sync(() => nativeRootProbeGate?.resolve()));
        desktopPopupEvents.emit("host-connected", "other-host");
        desktopPopupEvents.emit("host-connected", "host-a");
        yield* Effect.promise(() => nativeRootProbeEntered!.promise);
        expect(nativeRootProbes).toEqual([
          {
            threadId: scope.thread.threadId,
            tabId,
            desktopHostId: "host-a",
            rootId: `root-${tabId}`,
          },
        ]);
        expect(rootOwnerReconciliations).toEqual([
          { desktopHostId: "other-host", serverEpoch: before.serverEpoch },
          { desktopHostId: "host-a", serverEpoch: before.serverEpoch },
        ]);
        nativeRootProbeGate.resolve();
        yield* Effect.promise(() =>
          presence === "absent" ? nativeCloseProcessed!.promise : nativeRootProbeProcessed!.promise,
        );
        const after = (yield* manager.list({})).sessions;
        expect(after.some((session) => session.tabId === tabId)).toBe(presence !== "absent");
        expect(after.filter((session) => session.tabId !== tabId)).toEqual(
          before.sessions.filter((session) => session.tabId !== tabId),
        );
        expect(rootClosures).toEqual([]);
        desktopRendersNext = true;
        const replacement = broker.invoke<PreviewAutomationStatus>({
          scope,
          operation: "open",
          input: { reuseExistingTab: false, show: false },
        });
        const opened = yield* replacement;
        expect(opened.tabId).not.toBe(tabId);
        expect((yield* manager.list({})).sessions).toHaveLength(presence === "absent" ? 8 : 9);
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

it.effect("native root acceptance failure retains the unavailable error classification", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* ServerBrowser.ServerBrowser;
      const broker = yield* Broker.PreviewAutomationBroker;
      const manager = yield* Manager.PreviewManager;
      yield* Effect.yieldNow;
      desktopRendersNext = true;
      rootAcceptanceFailure = new DesktopBrowserTransportError({ reason: "guest-unavailable" });
      const failure = yield* broker
        .invoke<PreviewAutomationStatus>({
          scope,
          operation: "open",
          input: { reuseExistingTab: false, show: false },
        })
        .pipe(Effect.flip);
      expect(failure).toMatchObject({ _tag: "PreviewAutomationRemoteUnavailableError" });
      expect((yield* manager.list({})).sessions).toEqual([]);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live.each(["acceptance", "publication"] as const)(
  "failed native root %s releases capacity and reconnect ownership without an acknowledgment",
  (stage) =>
    Effect.scoped(
      Effect.gen(function* () {
        profileCatalogue = {
          desktopHostId: "host-a",
          profiles: [{ id: "work", name: "Work", kind: "persistent" }],
          defaultProfileId: "work",
        };
        desktopRendersNext = true;
        const { broker, browser, tabId: retainedTabId } = yield* ready;
        const manager = yield* Manager.PreviewManager;
        const retained = (yield* manager.list({})).sessions[0]!;
        const serverEpoch = (yield* manager.list({})).serverEpoch;
        const viewer = yield* browser.attachViewer(viewerInput(retainedTabId, false));
        desktopDetaches.emit("detach", {
          threadId: scope.thread.threadId,
          tabId: retainedTabId,
          desktopHostId: "host-a",
        });
        let ending = yield* Queue.take(viewer.output);
        while (ending._tag !== "reconnect") ending = yield* Queue.take(viewer.output);
        const context = yield* Layer.build(
          DesktopChannel.layer.pipe(
            Layer.provide(
              ServerConfig.layerTest(process.cwd(), { prefix: "t3-failed-root-channel-" }),
            ),
          ),
        );
        const channel = Context.get(context, DesktopChannel.DesktopBrowserChannel);
        const connect = (owner: string) =>
          Effect.gen(function* () {
            const commands = yield* Queue.unbounded<DesktopBrowserCommand>();
            const fiber = yield* channel.subscribeCommands(owner, "host-a").pipe(
              Stream.runForEach((command) => Queue.offer(commands, command)),
              Effect.forkScoped,
            );
            expect(yield* Queue.take(commands)).toEqual({ type: "announce" });
            return { commands, fiber, owner };
          });
        nativeRootCreationChannel = channel;
        let connection = yield* connect("socket-0");
        // More than the eight-tab agent limit must fail for the original reason,
        // even though this owner never acknowledges destruction of a failed root.
        for (let index = 0; index < 9; index++) {
          desktopRendersNext = true;
          if (stage === "publication") {
            rootPublicationEntered = Promise.withResolvers<void>();
            rootPublicationGate = Promise.withResolvers<void>();
            rootPublicationFailure = new DesktopBrowserTransportError({
              reason: "host-unavailable",
            });
          }
          const opening = yield* broker
            .invoke<PreviewAutomationStatus>({
              scope,
              operation: "open",
              input: { reuseExistingTab: false, show: false },
            })
            .pipe(Effect.flip, Effect.forkChild);
          const create = yield* Queue.take(connection.commands).pipe(
            Effect.raceFirst(
              Fiber.join(opening).pipe(
                Effect.flatMap((failure) => Effect.die(new Error(failure.message))),
              ),
            ),
          );
          if (create.type !== "createRoot") throw new Error("Expected native root creation");
          const rootId = `root-${create.tabId}`;
          const source = {
            threadId: create.threadId,
            tabId: create.tabId,
            desktopHostId: "host-a",
          };
          yield* channel.receiveEvent(connection.owner, "host-a", {
            type: "rootCreated",
            ...source,
            rootId,
            requestId: create.requestId,
            profileId: create.profileId,
          });
          const accept = yield* Queue.take(connection.commands);
          if (accept.type !== "acceptRoot") throw new Error("Expected native root acceptance");
          if (stage === "publication") {
            yield* channel.receiveEvent(connection.owner, "host-a", {
              type: "rootAccepted",
              ...source,
              rootId,
              requestId: accept.requestId,
              profileId: accept.profileId,
              accepted: true,
            });
            yield* Effect.promise(() => rootPublicationEntered!.promise);
          }
          yield* Fiber.interrupt(connection.fiber);
          rootPublicationGate?.resolve();
          const failure = yield* Fiber.join(opening);
          expect(failure).toMatchObject({ _tag: "PreviewAutomationRemoteUnavailableError" });
          expect((yield* manager.list({})).sessions).toEqual([retained]);
          connection = yield* connect(`socket-${index + 1}`);
          // No cancel replay or hidden owned root remains on the returning host.
          yield* channel.reconcileRoots("host-a", serverEpoch);
          expect(yield* Queue.take(connection.commands)).toEqual({
            type: "reconcileRoots",
            serverEpoch,
            retainedRootRequestIds: [],
          });
          expect(rootDiscards).toContainEqual({ ...source, rootId });
          expect(rootClosures).toEqual([]);
        }
        expect(rootDiscards).toHaveLength(9);
        nativeRootCreationChannel = null;
        rootPublicationFailure = null;
        rootPublicationGate = null;
        desktopRendersNext = true;
        const replacement = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          operation: "open",
          input: { reuseExistingTab: false, show: false },
        });
        expect(replacement.tabId).not.toBe(retainedTabId);
        expect((yield* manager.list({})).sessions).toHaveLength(2);
        // The unrelated published offline root remains discoverable and closable.
        desktopTabs.delete(retainedTabId);
        rootCloseFailure = "host-unavailable";
        yield* broker.invoke({ scope, tabId: retainedTabId, operation: "close", input: {} });
        expect((yield* manager.list({})).sessions.map((session) => session.tabId)).toEqual([
          replacement.tabId,
        ]);
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
      setupGate.resolve();
      yield* Effect.promise(() => releasedDesktopSeen!.promise);
      expect((yield* manager.list({ threadId: scope.thread.threadId })).sessions).toEqual([]);
      expect(yield* PubSub.takeUpTo(events, 100)).toEqual([]);
      expect(rootClosures).toEqual([]);
      expect(rootDiscards).toEqual([
        expect.objectContaining({ rootId: `root-${rootCreations[0]!.tabId}` }),
      ]);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("shared native pages reject agent keyboard input while allowing a controlling viewer", () =>
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
        automationOwner: `${scope.environmentId}\u0000${scope.thread.providerSessionId}\u0000${scope.thread.threadId}`,
      });
      const viewer = yield* browser.attachViewer(viewerInput(shared.tabId, true));
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
      expect((yield* manager.list({ threadId: scope.thread.threadId })).sessions).toEqual([shared]);
      yield* viewer.input({ type: "takeControl" });
      yield* viewer.input({ type: "text", text: "viewer text" });
      yield* viewer.input({ type: "key", action: "down", key: "Enter", code: "Enter" });
      const commands = desktopConnections[0]!.context.sessions.flatMap(
        (session) => session.send.mock.calls,
      );
      expect(commands).toEqual(
        expect.arrayContaining([
          ["Input.insertText", { text: "viewer text", __t3InputSource: "viewer" }],
          [
            "Input.dispatchKeyEvent",
            expect.objectContaining({
              type: "rawKeyDown",
              key: "Enter",
              code: "Enter",
              __t3InputSource: "viewer",
            }),
          ],
        ]),
      );
      yield* viewer.input({ type: "mouse", action: "down", button: "left", x: 10, y: 20 });
      yield* viewer.input({ type: "releaseControl" });
      expect(desktopConnections[0]!.context.sessions.at(-1)!.send).toHaveBeenCalledWith(
        "Input.dispatchKeyEvent",
        { type: "keyUp", key: "Enter", code: "Enter", __t3InputSource: "viewer" },
      );
      expect(desktopConnections[0]!.context.sessions.at(-1)!.send).toHaveBeenCalledWith(
        "Input.dispatchMouseEvent",
        {
          type: "mouseReleased",
          button: "left",
          x: 10,
          y: 20,
          buttons: 0,
          clickCount: 1,
          __t3InputSource: "viewer",
        },
      );
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
        const reportProfiles = yield* browser.profileReporter;
        yield* reportProfiles({
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

it.live("profiles reported by one client survive another client's report", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, broker } = yield* ready;
      contextRequests.length = 0;
      const work = { id: "profile-work", name: "Work", kind: "persistent" } as const;
      const shared = { id: "profile-shared", name: "Shared", kind: "persistent" } as const;
      const openWork = () =>
        broker.invoke<PreviewAutomationStatus>({
          scope,
          operation: "open",
          input: { reuseExistingTab: false, show: false, profileId: work.id },
        });
      const reportFromA = yield* browser.profileReporter;
      const clientB = yield* Scope.make();
      const reportFromB = yield* browser.profileReporter.pipe(
        Effect.provideService(Scope.Scope, clientB),
      );
      yield* reportFromA({ profiles: [work, shared], defaultProfileId: work.id });
      yield* reportFromB({ profiles: [shared], defaultProfileId: shared.id });
      expect(yield* openWork()).toMatchObject({
        defaultProfileId: shared.id,
        profiles: [
          { id: "default", name: "Default" },
          { id: "incognito", name: "Incognito", incognito: true },
          { id: work.id, name: work.name },
          { id: shared.id, name: shared.name },
        ],
      });
      expect(contextRequests).toEqual([{ profileId: work.id, isolated: false }]);
      yield* Scope.close(clientB, Exit.void);
      expect(yield* openWork()).toMatchObject({ defaultProfileId: work.id });
      yield* reportFromA({ profiles: [shared], defaultProfileId: shared.id });
      const removed = yield* openWork().pipe(Effect.flip);
      expect(removed).toMatchObject({
        _tag: "PreviewAutomationExecutionError",
        reason:
          'No browser profile is named "profile-work". Use one of: Default (id default), Incognito (id incognito), Shared (id profile-shared).',
      });
    }),
  ).pipe(Effect.provide(layer)),
);

it.live.each([
  { budget: "agent", limit: 8 },
  { budget: "server", limit: 32 },
])("opens and popups reserve the $budget budget before session creation", ({ budget, limit }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, browser, tabId } = yield* ready;
      const manager = yield* Manager.PreviewManager;
      yield* browser.attachViewer(viewerInput(tabId, false));
      const open = (target = scope) =>
        broker
          .invoke<PreviewAutomationStatus>({
            scope: target,
            operation: "open",
            input: { reuseExistingTab: false, show: false },
          })
          .pipe(Effect.tap((opened) => browser.attachViewer(viewerInput(opened.tabId!, false))));
      for (let index = 1; index < limit - 3; index++) {
        yield* open(budget === "agent" ? scope : asSession(`other-${Math.floor(index / 8)}`));
      }

      const sessionGate = Promise.withResolvers<void>();
      const launchGate = (contextGate = Promise.withResolvers<void>());
      const sessionStarted = Promise.withResolvers<void>();
      const realOpen = manager.open;
      const delayedOpen = vi.spyOn(manager, "open").mockImplementation((input) =>
        Effect.promise(() => {
          sessionStarted.resolve();
          return sessionGate.promise;
        }).pipe(Effect.andThen(realOpen(input))),
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          sessionGate.resolve();
          launchGate.resolve();
          delayedOpen.mockRestore();
        }),
      );
      const events = yield* manager.subscribeEvents;
      const first = yield* open().pipe(Effect.result, Effect.forkScoped);
      yield* Effect.promise(() => sessionStarted.promise);
      const popup = makeContext();
      const resized = Promise.withResolvers<void>();
      const setViewportSize = popup.page.setViewportSize;
      popup.page.setViewportSize = vi.fn(async (size) => {
        await setViewportSize(size);
        if (size?.width === 900) resized.resolve();
      });
      const newCDPSession = popup.newCDPSession;
      popup.newCDPSession = async (target) => {
        await launchGate.promise;
        return newCDPSession(target);
      };
      contexts[0]!.page.emit("popup", popup.page);
      const last = yield* open().pipe(Effect.result, Effect.forkScoped);
      const overflow = yield* open().pipe(Effect.result, Effect.forkScoped);
      // The host processes this after the opens, while manager creation is blocked.
      const reused = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId,
        operation: "open",
        input: { show: false },
      });
      expect(reused.tabId).toBe(tabId);
      expect((yield* manager.list({ threadId: scope.thread.threadId })).sessions).toHaveLength(
        limit - 3,
      );

      sessionGate.resolve();
      for (let count = 0; count < 3; count++) {
        let event = yield* PubSub.take(events);
        while (event.type !== "opened") event = yield* PubSub.take(events);
        yield* manager.resize({
          threadId: scope.thread.threadId,
          tabId: event.tabId,
          viewport: { _tag: "freeform", width: 900, height: 700 },
        });
      }
      // The same slots must stay reserved after publication, while pages are still opening.
      const duringLaunch = yield* open().pipe(Effect.result, Effect.forkScoped);
      const rejectedPopup = makeContext();
      contexts[0]!.page.emit("popup", rejectedPopup.page);
      yield* broker.invoke({ scope, tabId, operation: "status", input: {} });
      launchGate.resolve();

      expect((yield* Fiber.join(first))._tag).toBe("Success");
      expect((yield* Fiber.join(last))._tag).toBe("Success");
      for (const fiber of [overflow, duringLaunch]) {
        expect(yield* Fiber.join(fiber)).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "PreviewAutomationControlInterruptedError", reason: "tabLimit" },
        });
      }
      yield* Effect.promise(() => resized.promise);
      const { sessions } = yield* manager.list({ threadId: scope.thread.threadId });
      for (const session of sessions)
        yield* browser.attachViewer(viewerInput(session.tabId, false));
      expect(sessions).toHaveLength(limit);
      expect(popup.page.isClosed()).toBe(false);
      expect(rejectedPopup.page.isClosed()).toBe(true);
      const status = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId,
        operation: "status",
        input: {},
      });
      expect(status.tabs).toHaveLength(limit);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("failed session and browser launches release capacity, as does closing a tab", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, browser, tabId } = yield* ready;
      const manager = yield* Manager.PreviewManager;
      yield* browser.attachViewer(viewerInput(tabId, false));
      const open = broker
        .invoke<PreviewAutomationStatus>({
          scope,
          operation: "open",
          input: { reuseExistingTab: false, show: false },
        })
        .pipe(Effect.tap((opened) => browser.attachViewer(viewerInput(opened.tabId!, false))));
      for (let count = 1; count < 7; count++) yield* open;
      const failSession = vi
        .spyOn(manager, "open")
        .mockImplementationOnce(() => Effect.die(new Error("session creation failed")));
      yield* Effect.addFinalizer(() => Effect.sync(() => failSession.mockRestore()));
      expect(yield* open.pipe(Effect.result)).toMatchObject({ _tag: "Failure" });
      failSession.mockRestore();
      const events = yield* manager.subscribeEvents;
      contextFailure = new Error("Chromium launch failed");
      expect(yield* open.pipe(Effect.result)).toMatchObject({ _tag: "Failure" });
      let failedSession = yield* PubSub.take(events);
      while (failedSession.type !== "opened") failedSession = yield* PubSub.take(events);
      // A failed launch must not leave a session a viewer can relaunch past the budget.
      expect((yield* manager.list({ threadId: scope.thread.threadId })).sessions).toHaveLength(7);
      contextFailure = null;
      expect((yield* open).available).toBe(true);
      expect(yield* open.pipe(Effect.flip)).toMatchObject({ reason: "tabLimit" });
      expect(
        yield* broker
          .invoke<PreviewAutomationStatus>({
            scope,
            tabId: PreviewTabId.make(failedSession.tabId),
            operation: "open",
            input: { show: false },
          })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "PreviewAutomationTabNotFoundError" });
      expect(
        yield* browser.attachViewer(viewerInput(failedSession.tabId, false)).pipe(Effect.flip),
      ).toMatchObject({ _tag: "ServerBrowserTabNotFoundError" });
      yield* broker.invoke({ scope, tabId, operation: "close", input: {} });
      expect((yield* open).available).toBe(true);
      const status = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "status",
        input: {},
      });
      expect(status.tabs).toHaveLength(8);
    }),
  ).pipe(Effect.provide(layer)),
);
it.live.each([undefined, "incognito"])(
  "a host-omitted existing tab retains reported defaults (profile=%s)",
  (profileId) =>
    Effect.scoped(
      Effect.gen(function* () {
        const browser = yield* ServerBrowser.ServerBrowser;
        const reportProfiles = yield* browser.profileReporter;
        const broker = yield* Broker.PreviewAutomationBroker;
        const manager = yield* Manager.PreviewManager;
        yield* Effect.yieldNow;
        if (profileId !== undefined)
          yield* reportProfiles({ profiles: [], defaultProfileId: profileId });
        const opened = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          operation: "open",
          input: { open: false },
        });
        const tabId = PreviewTabId.make(opened.tabId!);
        yield* reportProfiles({
          profiles: [{ id: "work", name: "Work", kind: "persistent" }],
          defaultProfileId: "work",
        });
        const reportedStatus = {
          profileId: profileId ?? null,
          defaultProfileId: "work",
          profiles: [
            { id: "default", name: "Default" },
            { id: "incognito", name: "Incognito", incognito: true },
            { id: "work", name: "Work" },
          ],
        };
        expect(
          yield* broker.invoke<PreviewAutomationStatus>({
            scope,
            tabId,
            operation: "status",
            input: {},
          }),
        ).toMatchObject(reportedStatus);
        expect(
          yield* broker.invoke<PreviewAutomationStatus>({
            scope,
            tabId,
            operation: "open",
            input: { open: false },
          }),
        ).toMatchObject({ tabId, ...reportedStatus });
        const events = yield* manager.subscribeEvents;
        contexts[0]!.page.emit("popup", makeContext().page);
        const event = Option.getOrThrow(
          yield* Stream.fromSubscription(events).pipe(
            Stream.filter((event) => event.type === "opened" && event.tabId !== tabId),
            Stream.runHead,
          ),
        );
        expect(
          yield* broker.invoke<PreviewAutomationStatus>({
            scope,
            tabId: event.tabId,
            operation: "status",
            input: {},
          }),
        ).toMatchObject(reportedStatus);
        const fresh = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          operation: "open",
          input: { open: false, reuseExistingTab: false },
        });
        expect(fresh).toMatchObject({ profileId: "work", defaultProfileId: "work" });
        expect(contextRequests).toEqual([
          { profileId: profileId ?? "default", isolated: true },
          { profileId: "work", isolated: false },
        ]);
      }),
    ).pipe(Effect.provide(layer)),
);

it.live("explicit environment hosting opens loopback without consulting a connected desktop", () =>
  Effect.scoped(
    Effect.gen(function* () {
      localDesktopAvailable = true;
      profileCatalogue = {
        desktopHostId: "remote-desktop",
        profiles: [{ id: "work", name: "Logged in Developer", kind: "persistent" }],
        defaultProfileId: "work",
      };
      remoteUrlAvailable = false;
      const broker = yield* Broker.PreviewAutomationBroker;
      yield* ServerBrowser.ServerBrowser;
      yield* Effect.yieldNow;
      const opened = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "open",
        input: {
          browserHost: "environment",
          url: "http://127.0.0.1:5173/fixture",
          reuseExistingTab: false,
          open: false,
        },
      });
      expect(opened).toMatchObject({
        available: true,
        browserHost: "environment",
        profileId: "incognito",
        profileName: "Incognito",
        control: { owner: "agent", ownedByCaller: true },
      });
      expect(profileRequests).toEqual([]);
      expect(rootCreations).toEqual([]);
      expect(contexts[0]!.page.goto).toHaveBeenCalledWith(
        "http://127.0.0.1:5173/fixture",
        expect.anything(),
      );
      const manager = yield* Manager.PreviewManager;
      expect((yield* manager.list({ threadId: scope.thread.threadId })).sessions).toEqual([
        expect.objectContaining({
          backingPage: "server",
          automationOwner: `${scope.environmentId}\u0000${scope.thread.providerSessionId}\u0000${scope.thread.threadId}`,
        }),
      ]);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("environment hosting refuses desktop sign-ins instead of substituting a cookie jar", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* Broker.PreviewAutomationBroker;
      yield* ServerBrowser.ServerBrowser;
      yield* Effect.yieldNow;
      const failure = yield* broker
        .invoke<PreviewAutomationStatus>({
          scope,
          operation: "openWithProfile",
          input: { browserHost: "environment", profileName: "Logged in Developer", open: false },
        })
        .pipe(Effect.flip);
      expect(failure).toMatchObject({ _tag: "PreviewAutomationExecutionError" });
      expect(contexts).toEqual([]);
      expect(profileRequests).toEqual([]);
      expect(rootCreations).toEqual([]);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live.each([
  { desktopAvailable: false, mode: "reuse" },
  { desktopAvailable: false, mode: "new" },
  { desktopAvailable: false, mode: "profile" },
  { desktopAvailable: true, mode: "reuse" },
  { desktopAvailable: true, mode: "new" },
  { desktopAvailable: true, mode: "profile" },
] as const)(
  "an omitted host retains environment policy (desktop=$desktopAvailable, open=$mode)",
  ({ desktopAvailable, mode }) =>
    Effect.scoped(
      Effect.gen(function* () {
        localDesktopAvailable = desktopAvailable;
        const browser = yield* ServerBrowser.ServerBrowser;
        const reportProfiles = yield* browser.profileReporter;
        const broker = yield* Broker.PreviewAutomationBroker;
        yield* reportProfiles({
          profiles: [{ id: "work", name: "Work", kind: "persistent" }],
          defaultProfileId: "work",
        });
        yield* Effect.yieldNow;
        const first = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          operation: "open",
          input: { browserHost: "environment", open: false },
        });
        const next = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          operation: mode === "profile" ? "openWithProfile" : "open",
          input: {
            open: false,
            ...(mode === "new" ? { reuseExistingTab: false } : {}),
            ...(mode === "profile" ? { profileName: "Default" } : {}),
          },
        });
        expect(next).toMatchObject({
          browserHost: "environment",
          profileId: mode === "profile" ? "default" : "incognito",
          defaultProfileId: "incognito",
        });
        if (mode === "reuse") expect(next.tabId).toBe(first.tabId);
        else expect(next.tabId).not.toBe(first.tabId);
        expect(profileRequests).toEqual([]);
        expect(rootCreations).toEqual([]);
        expect(contextRequests).toEqual([
          { profileId: "incognito", isolated: true },
          ...(mode === "reuse"
            ? []
            : [
                {
                  profileId: mode === "profile" ? "default" : "incognito",
                  isolated: mode !== "profile",
                },
              ]),
        ]);
      }),
    ).pipe(Effect.provide(layer)),
);

it.live("an explicit desktop choice overrides retained environment policy", () =>
  Effect.scoped(
    Effect.gen(function* () {
      localDesktopAvailable = true;
      const broker = yield* Broker.PreviewAutomationBroker;
      yield* ServerBrowser.ServerBrowser;
      yield* Effect.yieldNow;
      const first = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "open",
        input: { browserHost: "environment", open: false },
      });
      desktopRendersNext = true;
      const next = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "open",
        input: { browserHost: "desktop", open: false },
      });
      expect(next).toMatchObject({ browserHost: "desktop", profileId: "default" });
      expect(next.tabId).not.toBe(first.tabId);
      expect(rootCreations).toHaveLength(1);
      expect(contextRequests).toEqual([{ profileId: "incognito", isolated: true }]);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("an explicit host mismatch cannot replace a requested desktop tab", () =>
  Effect.scoped(
    Effect.gen(function* () {
      desktopRendersNext = true;
      const { broker, tabId } = yield* ready;
      const failure = yield* broker
        .invoke<PreviewAutomationStatus>({
          scope,
          tabId,
          operation: "open",
          input: { browserHost: "environment", open: false },
        })
        .pipe(Effect.flip);
      expect(failure).toMatchObject({ _tag: "PreviewAutomationExecutionError" });
      expect(rootCreations).toHaveLength(1);
      expect(contextRequests).toEqual([]);
      expect(
        (yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          tabId,
          operation: "status",
          input: {},
        })).browserHost,
      ).toBe("desktop");
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("an environment choice creates a new tab instead of reusing the current desktop tab", () =>
  Effect.scoped(
    Effect.gen(function* () {
      desktopRendersNext = true;
      const { broker, tabId } = yield* ready;
      const opened = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "open",
        input: { browserHost: "environment", open: false },
      });
      expect(opened).toMatchObject({ browserHost: "environment", profileId: "incognito" });
      expect(opened.tabId).not.toBe(tabId);
      expect(rootCreations).toHaveLength(1);
      expect(contextRequests).toEqual([{ profileId: "incognito", isolated: true }]);
      expect(opened.tabs).toHaveLength(2);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live.each([false, true])(
  "checks a detached tab's retained host before attachment (explicit=%s)",
  (explicit) =>
    Effect.scoped(
      Effect.gen(function* () {
        desktopRendersNext = true;
        const { broker, browser, tabId } = yield* ready;
        const viewer = yield* browser.attachViewer(viewerInput(tabId, false));
        desktopTabs.delete(tabId);
        desktopDetaches.emit("detach", {
          threadId: scope.thread.threadId,
          tabId,
          desktopHostId: "local",
        });
        let ending = yield* Queue.take(viewer.output);
        while (ending._tag !== "reconnect") ending = yield* Queue.take(viewer.output);
        const connectionsBefore = desktopConnections.length;
        const open = broker.invoke<PreviewAutomationStatus>({
          scope,
          ...(explicit ? { tabId } : {}),
          operation: "open",
          input: { browserHost: "environment", open: false },
        });
        if (explicit) {
          const failure = yield* open.pipe(Effect.flip);
          expect(failure).toMatchObject({
            _tag: "PreviewAutomationExecutionError",
            reason: expect.stringContaining("different browser host"),
          });
          expect(contextRequests).toEqual([]);
        } else {
          const opened = yield* open;
          expect(opened).toMatchObject({ browserHost: "environment", profileId: "incognito" });
          expect(opened.tabId).not.toBe(tabId);
          expect(opened.tabs).toHaveLength(2);
          expect(contextRequests).toEqual([{ profileId: "incognito", isolated: true }]);
        }
        expect(desktopConnections).toHaveLength(connectionsBefore);
        expect(rootCreations).toHaveLength(1);
      }),
    ).pipe(Effect.provide(layer)),
);

it.live("environment status advertises its own profiles instead of the desktop's catalogue", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* ServerBrowser.ServerBrowser;
      const reportProfiles = yield* browser.profileReporter;
      const broker = yield* Broker.PreviewAutomationBroker;
      yield* reportProfiles({
        profiles: [{ id: "work", name: "Work", kind: "persistent" }],
        defaultProfileId: "work",
      });
      yield* Effect.yieldNow;
      const opened = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "open",
        input: { browserHost: "environment", open: false, reuseExistingTab: false },
      });
      const tabId = PreviewTabId.make(opened.tabId!);
      const status = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId,
        operation: "status",
        input: {},
      });
      expect(status).toMatchObject({
        profileId: "incognito",
        defaultProfileId: "incognito",
        profiles: [
          { id: "default", name: "Default" },
          { id: "incognito", name: "Incognito", incognito: true },
        ],
      });
      const reused = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId,
        operation: "open",
        input: { open: false },
      });
      expect(reused).toMatchObject({
        tabId,
        profileId: "incognito",
        defaultProfileId: "incognito",
        profiles: status.profiles,
      });
      const rejected = yield* broker
        .invoke<PreviewAutomationStatus>({
          scope,
          operation: "openWithProfile",
          input: { browserHost: "environment", profileId: "work", open: false },
        })
        .pipe(Effect.flip);
      expect(rejected).toMatchObject({ _tag: "PreviewAutomationExecutionError" });
      expect(contextRequests).toEqual([{ profileId: "incognito", isolated: true }]);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("a retained environment session keeps its profile policy after failed attachment", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* ServerBrowser.ServerBrowser;
      const reportProfiles = yield* browser.profileReporter;
      const broker = yield* Broker.PreviewAutomationBroker;
      const manager = yield* Manager.PreviewManager;
      yield* reportProfiles({
        profiles: [{ id: "work", name: "Work", kind: "persistent" }],
        defaultProfileId: "work",
      });
      yield* Effect.yieldNow;
      contextFailure = new Error("Test context unavailable");
      const failure = yield* broker
        .invoke<PreviewAutomationStatus>({
          scope,
          operation: "open",
          input: { browserHost: "environment", open: false },
        })
        .pipe(Effect.flip);
      expect(failure).toMatchObject({ _tag: "PreviewAutomationExecutionError" });
      const { sessions } = yield* manager.list({ threadId: scope.thread.threadId });
      expect(sessions).toHaveLength(1);
      const tabId = sessions[0]!.tabId;
      contextFailure = null;
      const status = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId,
        operation: "open",
        input: { open: false },
      });
      expect(status).toMatchObject({
        tabId,
        profileId: "incognito",
        defaultProfileId: "incognito",
        profiles: [
          { id: "default", name: "Default" },
          { id: "incognito", name: "Incognito", incognito: true },
        ],
      });
    }),
  ).pipe(Effect.provide(layer)),
);

it.live(
  "environment profile selection preserves reused storage and rejects an exact mismatch",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* Broker.PreviewAutomationBroker;
        yield* ServerBrowser.ServerBrowser;
        yield* Effect.yieldNow;
        const opened = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          operation: "openWithProfile",
          input: { browserHost: "environment", profileName: "Incognito", open: false },
        });
        const tabId = PreviewTabId.make(opened.tabId!);
        expect(opened).toMatchObject({ browserHost: "environment", profileId: "incognito" });
        const reused = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          tabId,
          operation: "open",
          input: { browserHost: "environment", open: false },
        });
        expect(reused).toMatchObject({ tabId, profileId: "incognito" });
        const failure = yield* broker
          .invoke<PreviewAutomationStatus>({
            scope,
            tabId,
            operation: "openWithProfile",
            input: { browserHost: "environment", profileId: "default", open: false },
          })
          .pipe(Effect.flip);
        expect(failure).toMatchObject({ _tag: "PreviewAutomationProfileError" });
        expect(contextRequests).toEqual([{ profileId: "incognito", isolated: true }]);
        expect(profileRequests).toEqual([]);
      }),
    ).pipe(Effect.provide(layer)),
);

it.live.each([false, true])(
  "an attached desktop tab can be reused without its catalogue (explicit=%s)",
  (explicit) =>
    Effect.scoped(
      Effect.gen(function* () {
        desktopRendersNext = true;
        const { broker, tabId } = yield* ready;
        profileCatalogueUnavailable = true;
        const reused = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          ...(explicit ? { tabId } : {}),
          operation: "open",
          input: { browserHost: "desktop", open: false, url: "https://reuse.example.test/" },
        });
        expect(reused).toMatchObject({
          tabId,
          browserHost: "desktop",
          url: "https://reuse.example.test/",
        });
        for (const input of [
          { reuseExistingTab: false },
          { profileId: "default" },
          { profileName: "Default" },
        ]) {
          const failure = yield* broker
            .invoke<PreviewAutomationStatus>({
              scope,
              ...(explicit ? { tabId } : {}),
              operation: "open",
              input: { browserHost: "desktop", open: false, ...input },
            })
            .pipe(Effect.flip);
          expect(failure).toMatchObject({ _tag: "PreviewAutomationRemoteUnavailableError" });
        }
        expect(rootCreations).toHaveLength(1);
        expect(contextRequests).toEqual([]);
      }),
    ).pipe(Effect.provide(layer)),
);

it.live("an explicit desktop choice never falls back to an environment cookie jar", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* Broker.PreviewAutomationBroker;
      const browser = yield* ServerBrowser.ServerBrowser;
      const reportProfiles = yield* browser.profileReporter;
      yield* reportProfiles({ profiles: [], defaultProfileId: "default" });
      yield* Effect.yieldNow;
      const failure = yield* broker
        .invoke<PreviewAutomationStatus>({
          scope,
          operation: "open",
          input: { browserHost: "desktop", open: false },
        })
        .pipe(Effect.flip);
      expect(failure).toMatchObject({ _tag: "PreviewAutomationRemoteUnavailableError" });
      expect(contextRequests).toEqual([]);
      expect(rootCreations).toEqual([]);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("an environment choice cannot replace an explicitly missing tab", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* Broker.PreviewAutomationBroker;
      yield* ServerBrowser.ServerBrowser;
      yield* Effect.yieldNow;
      const failure = yield* broker
        .invoke<PreviewAutomationStatus>({
          scope,
          tabId: PreviewTabId.make("missing-environment-tab"),
          operation: "open",
          input: { browserHost: "environment", open: false },
        })
        .pipe(Effect.flip);
      expect(failure).toMatchObject({ _tag: "PreviewAutomationTabNotFoundError" });
      expect(contextRequests).toEqual([]);
      expect(rootCreations).toEqual([]);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("an environment popup stays on the server when local native IPC is available", () =>
  Effect.scoped(
    Effect.gen(function* () {
      localDesktopAvailable = true;
      const broker = yield* Broker.PreviewAutomationBroker;
      const browser = yield* ServerBrowser.ServerBrowser;
      const reportProfiles = yield* browser.profileReporter;
      yield* reportProfiles({
        profiles: [{ id: "work", name: "Work", kind: "persistent" }],
        defaultProfileId: "work",
      });
      yield* Effect.yieldNow;
      const opened = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "open",
        input: { browserHost: "environment", open: false, reuseExistingTab: false },
      });
      const manager = yield* Manager.PreviewManager;
      const events = yield* manager.subscribeEvents;
      const popup = makeContext();
      contexts[0]!.page.emit("popup", popup.page);
      const event = Option.getOrThrow(
        yield* Stream.fromSubscription(events).pipe(
          Stream.filter((event) => event.type === "opened" && event.tabId !== opened.tabId),
          Stream.runHead,
        ),
      );
      if (event.type !== "opened") throw new Error("Expected popup opening");
      expect(event.snapshot).toMatchObject({
        backingPage: "server",
        profileId: "incognito",
        automationOwner: `${scope.environmentId}\u0000${scope.thread.providerSessionId}\u0000${scope.thread.threadId}`,
        reveal: false,
      });
      expect(event.snapshot.desktopHostId).toBeUndefined();
      const status = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId: event.tabId,
        operation: "status",
        input: {},
      });
      expect(status).toMatchObject({
        browserHost: "environment",
        profileId: "incognito",
        defaultProfileId: "incognito",
        profiles: [
          { id: "default", name: "Default" },
          { id: "incognito", name: "Incognito", incognito: true },
        ],
        control: { owner: "agent", ownedByCaller: true },
      });
      expect(rootCreations).toEqual([]);
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
  },
  {
    name: "desktop resized to a phone",
    desktop: true,
    page: { ratio: 1, width: 390, height: 844, zoom: 1 },
    scrollY: 0,
    size: { width: 390, height: 844 },
  },
  {
    name: "desktop zoom changes during a scrolled snapshot",
    desktop: true,
    page: { ratio: 3, width: 640, height: 400, zoom: 2 },
    scrollY: 100,
    size: { width: 1280, height: 800 },
  },
  {
    name: "headless",
    desktop: false,
    page: { ratio: 2, width: 1280, height: 800, zoom: 1 },
    scrollY: 0,
    size: { width: 640, height: 400 },
  },
])("snapshot captures the page's own viewport: $name", ({ desktop, page, scrollY, size }) =>
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
      expect(clips).toEqual([undefined]);
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
        yield* Effect.promise(() => desktopDetachSubscribed.promise);
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

it.live("an older desktop fails new native opens before creating or publishing a tab", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* ServerBrowser.ServerBrowser;
      const manager = yield* Manager.PreviewManager;
      const broker = yield* Broker.PreviewAutomationBroker;
      yield* Effect.yieldNow;
      for (const desktopHostId of ["local", "remote-host"]) {
        profileCatalogue = {
          desktopHostId,
          supportsNativeRoots: false,
          profiles: [{ id: "work", name: "Work", kind: "persistent" }],
          defaultProfileId: "work",
        };
        expect(yield* broker.invoke({ scope, operation: "profiles", input: {} })).toMatchObject({
          defaultProfileId: "work",
        });
        for (const operation of ["open", "openWithProfile"] as const) {
          const failure = yield* broker
            .invoke<void>({
              scope,
              operation,
              input: {
                ...(operation === "openWithProfile" ? { profileId: "work" } : {}),
                url: "https://auth.example.test/start",
                reuseExistingTab: false,
                show: false,
              },
            })
            .pipe(Effect.flip);
          expect(failure).toMatchObject({
            _tag: "PreviewAutomationRemoteUnavailableError",
            cause: {
              message: expect.stringContaining("Update the desktop app"),
              detail: { reason: "root-unsupported" },
            },
          });
          expect((yield* manager.list({ threadId: scope.thread.threadId })).sessions).toEqual([]);
          expect(rootCreations).toEqual([]);
          expect(contexts).toHaveLength(0);
          expect(desktopConnections).toHaveLength(0);
        }
      }
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
      profileCatalogueUnavailable = true;
      const retained = yield* manager.open({
        threadId: scope.thread.threadId,
        runtime: "server",
      });
      yield* broker
        .invoke<void>({ scope, operation: "open", input: { reuseExistingTab: false, show: false } })
        .pipe(Effect.flip);
      const { sessions } = yield* manager.list({ threadId: scope.thread.threadId });
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.tabId).toBe(retained.tabId);
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
        yield* Effect.promise(() => desktopPresentationSubscribed.promise);
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
      desktopPageSetup = async ({ page }) => {
        expect(page.goto).not.toHaveBeenCalled();
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
