// @effect-diagnostics nodeBuiltinImport:off - Names download files on the shared disk.
/**
 * The desktop end of the desktop browser channel (see `DesktopBrowserEvent` in
 * contracts). The primary backend gets two file descriptors at spawn: this
 * service writes events for the desktop's tabs to one and reads commands from
 * the other. Each attached tab is reachable only through its `CdpRelay`.
 *
 * A tab is attached once its `<webview>` registers with a key the web app
 * gave it. The preview manager owns the tab's single debugger session and hands
 * it here; the relay shares it.
 */
import {
  DESKTOP_BROWSER_DOWNLOAD_MAX_BYTES,
  DESKTOP_BROWSER_DOWNLOAD_CHUNK_BYTES,
  DesktopBrowserCommand,
  DesktopBrowserTransportError,
  DEFAULT_BROWSER_PROFILE_ID,
  resolveBrowserProfiles,
  DesktopBrowserEvent,
  type DesktopBrowserSurfaceRequest,
  type DesktopBrowserSurfaceResponse,
  type DesktopBrowserEvent as DesktopBrowserEventType,
  type PreviewViewportSetting,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as NodePath from "node:path";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";

import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import type { resolvePartitionScope } from "./BrowserProfileScope.ts";
import { DESKTOP_BROWSER_SURFACE_REQUEST_CHANNEL } from "../ipc/channels.ts";

import { createCdpRelayConnection, type CdpRelayConnection } from "./CdpRelay.ts";

const encodeEvent = Schema.encodeSync(Schema.fromJsonString(DesktopBrowserEvent));
const decodeCommand = Schema.decodeUnknownOption(Schema.fromJsonString(DesktopBrowserCommand));
const lineEncoder = new TextEncoder();
/** CDP commands through which an agent clicks, types, or navigates the page. */
const AGENT_INPUT_COMMAND =
  /"method":"(?:Input\.|Page\.navigate"|Runtime\.(?:evaluate|callFunctionOn)")/;
/** How long after an agent's input a download still counts as the agent's. */
const AGENT_DOWNLOAD_WINDOW_MS = 5_000;

const BOUNDED_SURFACE_COMMANDS = new Set([
  "Page.captureScreenshot",
  "Page.getLayoutMetrics",
  "DOMSnapshot.captureSnapshot",
  "Page.startScreencast",
  "Page.stopScreencast",
]);

class DesktopBrowserCommandError extends Schema.TaggedError<DesktopBrowserCommandError>()(
  "DesktopBrowserCommandError",
  {
    method: Schema.String,
    reason: Schema.Literals(["command-failed", "timeout"]),
    timeoutMs: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return this.reason === "timeout"
      ? `Desktop browser ${this.method} exceeded its ${this.timeoutMs}ms deadline.`
      : `Desktop browser ${this.method} failed: ${this.cause instanceof Error ? this.cause.message : String(this.cause)}`;
  }
}

export interface DesktopBrowserTabKey {
  readonly threadId: string;
  readonly tabId: string;
  readonly desktopHostId?: string | undefined;
}

/** A tab's debugger, as the preview manager lends it to the relay. */
export interface DesktopBrowserTabDebugger {
  readonly webContents: Electron.WebContents;
  readonly debugger: Electron.Debugger;
}

const keyOf = ({ threadId, tabId, desktopHostId = "local" }: DesktopBrowserTabKey) =>
  JSON.stringify([desktopHostId, threadId, tabId]);

interface AttachedTab {
  readonly key: DesktopBrowserTabKey;
  readonly debuggee: DesktopBrowserTabDebugger;
  readonly runtimeTabId: string;
  readonly popup: NativePopup | undefined;
  readonly surfaceLeases: Map<string, number | null>;
  readonly renderingLeases: Map<string, () => void>;
  relay: CdpRelayConnection | null;
  presented: boolean;
  /** Where the server wants this tab's downloads; null keeps Electron's own handling. */
  downloadDirectory: string | null;
  /** The guid CDP gave the download that is about to start. */
  pendingDownloadGuid: string | null;
  /** When the server last sent this page input, which only an agent does. */
  agentInputAt: number;
  remoteDownloadDirectory: Promise<string> | null;
  readonly onMessage: (
    event: Electron.Event,
    method: string,
    params: unknown,
    sessionId: string,
  ) => void;
}

interface NativePopup {
  readonly kind: "popup" | "root";
  readonly creation:
    | {
        readonly profileId: string;
        readonly environmentId: string;
        readonly serverEpoch: string;
        readonly url: string;
        readonly requestId: string;
        // Cancellation ends when the server commits tab ownership; no page backing ever migrates.
        stage: "created" | "accepted" | "published";
      }
    | undefined;
  readonly id: string;
  readonly source: DesktopBrowserTabKey;
  readonly window: Electron.BrowserWindow;
  readonly contents: Electron.WebContents;
  readonly release: () => void;
  boundKey: DesktopBrowserTabKey | undefined;
  closeRequest: { readonly requestId: string; canceled: boolean } | undefined;
}

export class DesktopBrowserHost extends Context.Service<
  DesktopBrowserHost,
  {
    /**
     * Newline-delimited events for a backend's browser fd. Each run starts by
     * announcing the tabs already attached, so a restarted backend hears them.
     */
    readonly events: Stream.Stream<Uint8Array>;
    readonly remoteEvents: Stream.Stream<{
      readonly desktopHostId: string;
      readonly event: DesktopBrowserEventType;
    }>;
    readonly handleRemoteCommand: (input: {
      readonly desktopHostId: string;
      readonly command: DesktopBrowserCommand;
    }) => Effect.Effect<void>;
    /** One line from the backend's browser control fd. */
    readonly handleCommandLine: (line: string) => Effect.Effect<void>;
    readonly bindEnvironment: (
      desktopHostId: string,
      environmentId: string,
      resolveProfile: (
        profileId: string,
      ) => Effect.Effect<ReturnType<typeof resolvePartitionScope>, DesktopBrowserTransportError>,
    ) => Effect.Effect<void, DesktopBrowserTransportError>;
    readonly setRootFactory: (
      create: (input: {
        readonly environmentId: string;
        readonly profileId: string;
        readonly partition: ReturnType<typeof resolvePartitionScope>;
        readonly viewport?: PreviewViewportSetting;
      }) => Effect.Effect<Electron.BrowserWindow, DesktopBrowserTransportError>,
    ) => void;
    /** Offers a server tab's `<webview>` to the server. */
    readonly attach: (
      key: DesktopBrowserTabKey,
      debuggee: DesktopBrowserTabDebugger,
      runtimeTabId: string,
    ) => void;
    /** Registers only the actual child window delivered by Electron's did-create-window. */
    readonly registerPopup: (source: DesktopBrowserTabKey, window: Electron.BrowserWindow) => void;
    readonly surfaceResponse: (response: DesktopBrowserSurfaceResponse, senderId: number) => void;
    readonly setPresentation: (
      input: { readonly runtimeTabId: string; readonly presented: boolean },
      senderId: number,
    ) => void;
    readonly setMainWindow: (window: Electron.BrowserWindow) => void;
    readonly setPictureInPictureWindow: (
      runtimeTabId: string,
      window: Electron.BrowserWindow | null,
    ) => void;
    /** Shares the preview manager's base policy with temporary automation rendering leases. */
    readonly setBackgroundThrottling: (contents: Electron.WebContents, enabled: boolean) => void;
    /** Withdraws it: closed, swapped, crashed, or devtools needs the debugger. */
    readonly detach: (key: DesktopBrowserTabKey) => void;
    /**
     * Whether a server tab's download came from the person at this desktop:
     * the server sent the page no input just before it started.
     */
    readonly humanStartedDownload: (source: Electron.WebContents) => boolean;
    /** Points a server tab's download at the server; false for any other download. */
    readonly placeDownload: (source: Electron.WebContents, item: Electron.DownloadItem) => boolean;
    /** The agent's cursor positions for attached tabs, keyed by their server tab. */
    readonly pointers: Stream.Stream<{
      readonly key: DesktopBrowserTabKey;
      readonly phase: "move" | "click";
      readonly x: number;
      readonly y: number;
    }>;
  }
>()("@t3tools/desktop/preview/DesktopBrowserHost") {}

export const make = Effect.gen(function* () {
  const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
  const clock = yield* Clock.Clock;
  const now = () => Number(clock.monotonicTimeNanosUnsafe()) / 1_000_000;
  const outbox = yield* PubSub.unbounded<{
    desktopHostId: string;
    event: DesktopBrowserEventType;
  }>();
  const pointers = yield* PubSub.sliding<{
    readonly key: DesktopBrowserTabKey;
    readonly phase: "move" | "click";
    readonly x: number;
    readonly y: number;
  }>(16);
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  const runPromise = Effect.runPromiseWith(context);
  /** Native capture and stream commands must settle before the server releases their surface. */
  const sendBoundedSurfaceCommand = <T>(
    tab: AttachedTab,
    method: string,
    send: () => Promise<T>,
  ): Promise<T> => {
    if (!BOUNDED_SURFACE_COMMANDS.has(method)) return send();
    const deadlines = [...tab.surfaceLeases.values()].filter((deadline) => deadline !== null);
    const remainingMs = Math.max(
      0,
      Math.min(8000, ...deadlines.map((deadline) => deadline - now())),
    );
    // Leave the relay time to report failure before the server's request deadline releases the surface.
    const timeoutMs =
      deadlines.length === 0
        ? remainingMs
        : Math.max(0, remainingMs - Math.min(25, remainingMs / 10));
    const timeout = () =>
      Effect.fail(
        new DesktopBrowserCommandError({ method, reason: "timeout", cause: null, timeoutMs }),
      );
    return runPromise(
      timeoutMs <= 0
        ? timeout()
        : Effect.tryPromise({
            try: (_signal) => send(),
            catch: (cause) =>
              new DesktopBrowserCommandError({
                method,
                reason: "command-failed",
                cause,
                timeoutMs,
              }),
          }).pipe(
            Effect.timeoutOrElse({
              duration: timeoutMs,
              orElse: timeout,
            }),
          ),
    );
  };
  const tabs = new Map<string, AttachedTab>();
  const popups = new Map<string, NativePopup>();
  const environmentBindings = new Map<
    string,
    {
      readonly environmentId: string;
      readonly resolveProfile: Parameters<DesktopBrowserHost["Service"]["bindEnvironment"]>[2];
    }
  >();
  let createRootWindow: Parameters<DesktopBrowserHost["Service"]["setRootFactory"]>[0] | undefined;
  const rootCreationLock = yield* Semaphore.make(1);
  const canceledCreations = new Set<string>();
  const pendingRootCreations = new Map<
    string,
    DesktopBrowserTabKey & { readonly serverEpoch: string; readonly requestId: string }
  >();
  const creationKey = (key: DesktopBrowserTabKey, requestId: string, profileId: string) =>
    JSON.stringify([keyOf(key), requestId, profileId]);
  const presentedSlots = new Map<string, number>();
  const emit = (event: DesktopBrowserEventType, desktopHostId = "local") =>
    runFork(PubSub.publish(outbox, { desktopHostId, event }));
  let mainWindow: Electron.BrowserWindow | null = null;
  let releaseMainWindow: (() => void) | undefined;
  const makeAutomationLifetime = () => ({
    closed: false,
    windows: new Set<Electron.BrowserWindow>(),
  });
  let automationLifetime = makeAutomationLifetime();
  const closeAutomationLifetime = (lifetime: ReturnType<typeof makeAutomationLifetime>) => {
    lifetime.closed = true;
    for (const window of lifetime.windows) {
      if (!window.isDestroyed()) window.destroy();
    }
    lifetime.windows.clear();
  };
  const ownAutomationWindow = (
    lifetime: ReturnType<typeof makeAutomationLifetime>,
    window: Electron.BrowserWindow,
  ) => {
    if (lifetime.closed) {
      if (!window.isDestroyed()) window.destroy();
      return false;
    }
    lifetime.windows.add(window);
    window.once("closed", () => lifetime.windows.delete(window));
    return true;
  };
  const pictureInPictureWindows = new Map<
    string,
    { window: Electron.BrowserWindow; release: () => void }
  >();
  const windowVisible = (window: Electron.BrowserWindow | null | undefined) =>
    window !== null &&
    window !== undefined &&
    !window.isDestroyed() &&
    window.isVisible() &&
    !window.isMinimized();
  const nativePresented = (runtimeTabId: string, senderId: number | undefined) =>
    (senderId !== undefined &&
      mainWindow !== null &&
      windowVisible(mainWindow) &&
      mainWindow.webContents.id === senderId &&
      presentedSlots.get(runtimeTabId) === senderId) ||
    windowVisible(pictureInPictureWindows.get(runtimeTabId)?.window);
  const updatePresentation = (tab: AttachedTab) => {
    const presented = tab.popup
      ? windowVisible(tab.popup.window)
      : nativePresented(tab.runtimeTabId, tab.debuggee.webContents.hostWebContents?.id);
    if (tab.presented === presented) return;
    tab.presented = presented;
    emit(
      { type: "presentation", threadId: tab.key.threadId, tabId: tab.key.tabId, presented },
      tab.key.desktopHostId,
    );
  };
  const observeWindow = (window: Electron.BrowserWindow, changed: () => void) => {
    window.on("show", changed);
    window.on("hide", changed);
    window.on("minimize", changed);
    window.on("restore", changed);
    window.on("closed", changed);
    return () => {
      window.off("show", changed);
      window.off("hide", changed);
      window.off("minimize", changed);
      window.off("restore", changed);
      window.off("closed", changed);
    };
  };
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      releaseMainWindow?.();
      closeAutomationLifetime(automationLifetime);
      for (const entry of pictureInPictureWindows.values()) entry.release();
      for (const popup of popups.values()) {
        if (popup.boundKey) detach(popup.boundKey);
        popup.release();
        if (popup.kind === "root" && !popup.window.isDestroyed()) popup.window.destroy();
      }
      popups.clear();
    }),
  );
  const unthrottledContents = new Map<
    Electron.WebContents,
    { references: number; restore: boolean }
  >();
  const setBackgroundThrottling = (contents: Electron.WebContents, enabled: boolean) => {
    const active = unthrottledContents.get(contents);
    if (active && enabled) {
      active.restore = enabled;
      return;
    }
    contents.setBackgroundThrottling(enabled);
    if (active) active.restore = enabled;
  };
  const acquireUnthrottledContents = (contents: Electron.WebContents) => {
    if (contents.isDestroyed()) throw new Error("Browser rendering guest is unavailable.");
    let active = unthrottledContents.get(contents);
    if (active) active.references += 1;
    else {
      const restore = contents.getBackgroundThrottling();
      contents.setBackgroundThrottling(false);
      active = { references: 1, restore };
      unthrottledContents.set(contents, active);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--active.references > 0) return;
      unthrottledContents.delete(contents);
      if (contents.isDestroyed()) return;
      try {
        contents.setBackgroundThrottling(active.restore);
      } catch (cause) {
        runFork(Effect.logWarning("Failed to restore browser surface throttling.", { cause }));
      }
    };
  };
  const acquireRendering = (tab: AttachedTab) => {
    const guest = tab.debuggee.webContents;
    const host = guest.hostWebContents;
    if (guest.isDestroyed() || (!tab.popup && (!host || host.isDestroyed()))) return null;
    const releases: Array<() => void> = [];
    try {
      for (const contents of new Set(tab.popup ? [guest] : [host!, guest]))
        releases.push(acquireUnthrottledContents(contents));
      return () => {
        for (const release of releases.toReversed()) release();
      };
    } catch {
      for (const release of releases.toReversed()) release();
      return null;
    }
  };
  const releaseSurfaceLease = (tab: AttachedTab, leaseId: string) => {
    tab.surfaceLeases.delete(leaseId);
    tab.renderingLeases.get(leaseId)?.();
    tab.renderingLeases.delete(leaseId);
  };
  let nextSurfaceRequest = 0;
  const pendingSurfaces = new Map<
    string,
    {
      readonly tab: AttachedTab;
      readonly request: DesktopBrowserSurfaceRequest;
      readonly serverRequestId: string;
      readonly senderId: number;
      readonly timer: Fiber.Fiber<void>;
    }
  >();
  const sendSurface = (tab: AttachedTab, request: DesktopBrowserSurfaceRequest) => {
    if (tab.popup) return false;
    const host = tab.debuggee.webContents.hostWebContents;
    if (!host || host.isDestroyed()) return false;
    try {
      host.send(DESKTOP_BROWSER_SURFACE_REQUEST_CHANNEL, request);
      return true;
    } catch {
      return false;
    }
  };
  const finishSurface = (requestId: string, response: DesktopBrowserSurfaceResponse) => {
    const pending = pendingSurfaces.get(requestId);
    if (!pending) return;
    pendingSurfaces.delete(requestId);
    runFork(Fiber.interrupt(pending.timer));
    const { tab, request } = pending;
    if (tabs.get(keyOf(tab.key)) !== tab) return;
    if (request.action === "acquire" && response.viewport === null) {
      releaseSurfaceLease(tab, request.leaseId);
      sendSurface(tab, { ...request, action: "release" });
    }
    emit(
      {
        ...response,
        type: "surfaceReady",
        threadId: tab.key.threadId,
        tabId: tab.key.tabId,
        requestId: pending.serverRequestId,
      },
      tab.key.desktopHostId,
    );
  };
  const cancelSurfaceRequests = (tab: AttachedTab, leaseId?: string) => {
    for (const [id, pending] of pendingSurfaces) {
      if (pending.tab !== tab || (leaseId !== undefined && pending.request.leaseId !== leaseId))
        continue;
      pendingSurfaces.delete(id);
      runFork(Fiber.interrupt(pending.timer));
    }
  };
  const clearSurfaceLeases = (tab: AttachedTab) => {
    cancelSurfaceRequests(tab);
    for (const leaseId of tab.surfaceLeases.keys()) {
      sendSurface(tab, {
        type: "surface",
        ...tab.key,
        runtimeTabId: tab.runtimeTabId,
        requestId: `surface-cleanup:${++nextSurfaceRequest}`,
        leaseId,
        action: "release",
      });
      releaseSurfaceLease(tab, leaseId);
    }
    tab.surfaceLeases.clear();
  };
  const surfaceResponse = (response: DesktopBrowserSurfaceResponse, senderId: number) => {
    const pending = pendingSurfaces.get(response.requestId);
    if (!pending || pending.senderId !== senderId) return;
    finishSurface(response.requestId, response);
  };

  const relayFor = (tab: AttachedTab) => {
    if (tab.relay) return tab.relay;
    const { webContents, debugger: debuggee } = tab.debuggee;
    const relay: CdpRelayConnection = createCdpRelayConnection(
      {
        send: async (method, params, sessionId) => {
          let localParams = params;
          if (
            tab.key.desktopHostId &&
            tab.key.desktopHostId !== "local" &&
            method === "Browser.setDownloadBehavior"
          ) {
            if (typeof params.downloadPath === "string" && params.behavior !== "deny") {
              tab.remoteDownloadDirectory ??= NodeFSP.mkdtemp(
                NodePath.join(NodeOS.tmpdir(), "t3-browser-download-"),
              );
              const directory = await tab.remoteDownloadDirectory;
              tab.downloadDirectory = directory;
              localParams = { ...params, downloadPath: directory };
            }
          }
          return sendBoundedSurfaceCommand(tab, method, () =>
            sessionId === undefined
              ? debuggee.sendCommand(method, localParams)
              : debuggee.sendCommand(method, localParams, sessionId),
          );
        },
        targetId: () =>
          debuggee
            .sendCommand("Target.getTargetInfo")
            .then((result: { targetInfo: { targetId: string } }) => result.targetInfo.targetId),
        url: () => webContents.getURL(),
        title: () => webContents.getTitle(),
        userAgent: () => webContents.getUserAgent(),
        setDownloadDirectory: (directory) => {
          tab.downloadDirectory = directory;
        },
      },
      // A released relay's late replies belong to a connection that is gone.
      (message) => {
        if (tab.relay === relay && tabs.get(keyOf(tab.key)) === tab) {
          emit(
            { type: "cdp", threadId: tab.key.threadId, tabId: tab.key.tabId, message },
            tab.key.desktopHostId,
          );
        }
      },
    );
    tab.relay = relay;
    return relay;
  };

  /**
   * Saves a download from a server tab where the server's Playwright expects
   * it. Without a path Electron would open its Save dialog over the app for a
   * file the agent asked for. CDP names the download just before this runs.
   */
  const placeDownload = (source: Electron.WebContents, item: Electron.DownloadItem) => {
    const tab = [...tabs.values()].find(
      (candidate) => candidate.debuggee.webContents === source && candidate.downloadDirectory,
    );
    if (!tab?.downloadDirectory || !tab.pendingDownloadGuid) return false;
    item.setSavePath(NodePath.join(tab.downloadDirectory, tab.pendingDownloadGuid));
    tab.pendingDownloadGuid = null;
    return true;
  };

  const transferDownload = (tab: AttachedTab, guid: unknown, relay: CdpRelayConnection | null) =>
    Effect.gen(function* () {
      const directory = tab.downloadDirectory;
      if (!directory || typeof guid !== "string" || !/^[a-zA-Z0-9-]{1,128}$/.test(guid)) {
        return yield* Effect.fail(
          new DesktopBrowserTransportError({ reason: "download-transfer-failed" }),
        );
      }
      const path = NodePath.join(directory, guid);
      const file = yield* Effect.acquireRelease(
        Effect.tryPromise(() => NodeFSP.open(path, "r")),
        (file) => Effect.promise(() => file.close().catch(() => undefined)),
      );
      const stat = yield* Effect.tryPromise(() => file.stat());
      if (stat.size > DESKTOP_BROWSER_DOWNLOAD_MAX_BYTES)
        return yield* Effect.fail(
          new DesktopBrowserTransportError({ reason: "download-transfer-failed" }),
        );
      const buffer = Buffer.alloc(DESKTOP_BROWSER_DOWNLOAD_CHUNK_BYTES);
      let offset = 0;
      do {
        const { bytesRead } = yield* Effect.tryPromise(() =>
          file.read(buffer, 0, buffer.length, offset),
        );
        if (
          offset + bytesRead > DESKTOP_BROWSER_DOWNLOAD_MAX_BYTES ||
          tabs.get(keyOf(tab.key)) !== tab ||
          tab.relay !== relay ||
          (bytesRead === 0 && offset < stat.size)
        ) {
          return yield* Effect.fail(
            new DesktopBrowserTransportError({ reason: "download-transfer-failed" }),
          );
        }
        yield* PubSub.publish(outbox, {
          desktopHostId: tab.key.desktopHostId!,
          event: {
            type: "download",
            threadId: tab.key.threadId,
            tabId: tab.key.tabId,
            guid,
            offset,
            data: buffer.subarray(0, bytesRead).toString("base64"),
            done: offset + bytesRead >= stat.size,
          },
        });
        offset += bytesRead;
        if (bytesRead === 0) break;
      } while (offset < stat.size);
      yield* Effect.tryPromise(() => NodeFSP.rm(path, { force: true }));
    }).pipe(Effect.scoped);

  const detach = (key: DesktopBrowserTabKey) => {
    const id = keyOf(key);
    const tab = tabs.get(id);
    if (!tab) return;
    clearSurfaceLeases(tab);
    tabs.delete(id);
    if (tab.remoteDownloadDirectory) {
      void tab.remoteDownloadDirectory
        .then((directory) => NodeFSP.rm(directory, { recursive: true, force: true }))
        .catch(() => undefined);
    }
    tab.debuggee.debugger.off("message", tab.onMessage);
    emit({ type: "detached", threadId: key.threadId, tabId: key.tabId }, key.desktopHostId);
  };

  const attach = (
    key: DesktopBrowserTabKey,
    debuggee: DesktopBrowserTabDebugger,
    runtimeTabId: string,
    popup?: NativePopup,
  ) => {
    const id = keyOf(key);
    const existing = tabs.get(id);
    if (existing?.debuggee.webContents === debuggee.webContents) return;
    if (existing?.popup?.kind === "root" && existing.popup !== popup) return;
    detach(key);
    const tab: AttachedTab = {
      key,
      debuggee,
      runtimeTabId,
      popup,
      surfaceLeases: new Map(),
      renderingLeases: new Map(),
      relay: null,
      presented: popup
        ? windowVisible(popup.window)
        : nativePresented(runtimeTabId, debuggee.webContents.hostWebContents?.id),
      downloadDirectory: null,
      pendingDownloadGuid: null,
      agentInputAt: Number.NEGATIVE_INFINITY,
      remoteDownloadDirectory: null,
      onMessage: (_event, method, params, sessionId) => {
        if (method === "Browser.downloadWillBegin") {
          const guid = (params as { guid?: unknown } | undefined)?.guid;
          tab.pendingDownloadGuid = typeof guid === "string" ? guid : null;
        }
        const progress = params as { guid?: unknown; state?: unknown } | undefined;
        if (
          tab.key.desktopHostId &&
          tab.key.desktopHostId !== "local" &&
          method === "Browser.downloadProgress" &&
          progress?.state === "completed"
        ) {
          const relay = tab.relay;
          runFork(
            transferDownload(tab, progress.guid, relay).pipe(
              Effect.match({
                onFailure: () => {
                  if (tab.relay === relay)
                    relay?.event(method, { ...(params as object), state: "canceled" }, sessionId);
                },
                onSuccess: () => {
                  if (tab.relay === relay) relay?.event(method, params, sessionId);
                },
              }),
            ),
          );
          return;
        }
        tab.relay?.event(method, params, sessionId);
      },
    };
    tabs.set(id, tab);
    debuggee.debugger.on("message", tab.onMessage);
    emit(
      {
        type: "attached",
        threadId: key.threadId,
        tabId: key.tabId,
        supportsNativeSurface: true,
        ...(tab.presented ? { presented: true } : {}),
      },
      key.desktopHostId,
    );
  };

  const registerNativePage = (
    source: DesktopBrowserTabKey,
    window: Electron.BrowserWindow,
    creation?: NonNullable<NativePopup["creation"]>,
  ) => {
    if ((!creation && !tabs.has(keyOf(source))) || window.isDestroyed()) return;
    const contents = window.webContents;
    if (contents.isDestroyed()) return;
    if ([...popups.values()].some((popup) => popup.contents === contents)) return;
    const debuggee = contents.debugger;
    // Do not take over a debugger owned by DevTools or another controller.
    if (debuggee.isAttached()) return;
    try {
      debuggee.attach("1.3");
    } catch {
      return;
    }
    const id = NodeCrypto.randomUUID();
    const cleanup = () => {
      if (popups.get(id) !== popup) return;
      popups.delete(id);
      if (popup.kind === "root") {
        if (popup.boundKey) detach(popup.boundKey);
        popup.release();
        // A debugger detach can precede BrowserWindow's closed event. This hidden
        // window belongs to automation, so confirm its destruction before acknowledging close.
        if (!window.isDestroyed()) window.destroy();
      }
      emit(
        popup.kind === "root"
          ? { type: "rootClosed", threadId: source.threadId, tabId: source.tabId, rootId: id }
          : { type: "popupClosed", threadId: source.threadId, tabId: source.tabId, popupId: id },
        source.desktopHostId,
      );
      if (popup.kind === "popup") {
        if (popup.boundKey) detach(popup.boundKey);
        popup.release();
      }
    };
    const changed = () => {
      const tab = popup.boundKey ? tabs.get(keyOf(popup.boundKey)) : undefined;
      if (tab) updatePresentation(tab);
    };
    const canceled = (requestId: string | undefined) => {
      const request = popup.closeRequest;
      if (
        !request ||
        request.requestId !== requestId ||
        request.canceled ||
        popups.get(id) !== popup
      )
        return;
      request.canceled = true;
      emit(
        popup.kind === "root"
          ? {
              type: "rootCloseCanceled",
              threadId: source.threadId,
              tabId: source.tabId,
              rootId: id,
              requestId: request.requestId,
            }
          : {
              type: "popupCloseCanceled",
              threadId: source.threadId,
              tabId: source.tabId,
              popupId: id,
              requestId: request.requestId,
            },
        source.desktopHostId,
      );
    };
    const windowClosing = (event: Electron.Event) => {
      const requestId = popup.closeRequest?.requestId;
      queueMicrotask(() => {
        if (event.defaultPrevented) canceled(requestId);
      });
    };
    const unloadPrevented = (event: Electron.Event) => {
      const requestId = popup.closeRequest?.requestId;
      queueMicrotask(() => {
        // Electron reverses preventDefault here: it permits the unload.
        if (!event.defaultPrevented) canceled(requestId);
      });
    };
    const stopObserving = observeWindow(window, changed);
    const popup: NativePopup = {
      kind: creation ? "root" : "popup",
      creation,
      id,
      source: { ...source },
      window,
      contents,
      boundKey: creation ? source : undefined,
      closeRequest: undefined,
      release: () => {
        stopObserving();
        window.off("closed", cleanup);
        window.off("close", windowClosing);
        contents.off("destroyed", cleanup);
        contents.off("will-prevent-unload", unloadPrevented);
        debuggee.off("detach", cleanup);
        if (!contents.isDestroyed() && debuggee.isAttached()) debuggee.detach();
      },
    };
    popups.set(id, popup);
    window.on("closed", cleanup);
    window.on("close", windowClosing);
    contents.on("destroyed", cleanup);
    contents.on("will-prevent-unload", unloadPrevented);
    debuggee.on("detach", cleanup);
    if (!creation)
      emit(
        {
          type: "popupCreated",
          threadId: source.threadId,
          tabId: source.tabId,
          popupId: id,
          url: contents.getURL(),
        },
        source.desktopHostId,
      );
    return popup;
  };
  const registerPopup = (source: DesktopBrowserTabKey, window: Electron.BrowserWindow) => {
    registerNativePage(source, window);
  };

  const configureAutomationPage = (
    page: NativePopup,
    lifetime: ReturnType<typeof makeAutomationLifetime>,
  ) => {
    page.contents.setWindowOpenHandler((details) => {
      // Auth callers may obtain their URL after creating a blank child with an opener.
      try {
        if (
          details.url === "" ||
          details.url === "about:blank" ||
          (["new-window", "foreground-tab", "background-tab"].includes(details.disposition) &&
            ["https:", "http:"].includes(new URL(details.url).protocol))
        )
          return {
            action: "allow",
            overrideBrowserWindowOptions: {
              show: false,
              focusable: false,
              skipTaskbar: true,
              webPreferences: {
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true,
              },
            },
          };
      } catch {
        /* Invalid native navigation is rejected below. */
      }
      void page.contents.loadURL(details.url).catch(() => undefined);
      return { action: "deny" };
    });
    page.contents.on("did-create-window", (child) => {
      if (!ownAutomationWindow(lifetime, child)) return;
      child.webContents.setIgnoreMenuShortcuts(true);
      const registered = registerNativePage(page.boundKey ?? page.source, child);
      if (registered) configureAutomationPage(registered, lifetime);
      else child.destroy();
    });
  };

  const createRoot = (
    command: Extract<DesktopBrowserCommand, { type: "createRoot" }>,
    desktopHostId: string,
  ) =>
    Effect.suspend(() => {
      // Capture the owner before waiting on profile resolution or window creation.
      // A replacement main window must not adopt an old owner's late result.
      const lifetime = automationLifetime;
      const key = { threadId: command.threadId, tabId: command.tabId, desktopHostId };
      const attempt = creationKey(key, command.requestId, command.profileId);
      pendingRootCreations.set(attempt, {
        ...key,
        serverEpoch: command.serverEpoch,
        requestId: command.requestId,
      });
      return rootCreationLock
        .withPermits(1)(
          Effect.gen(function* () {
            const binding = environmentBindings.get(desktopHostId);
            const respond = (
              rootId: string | null,
              reason?: "guest-unavailable" | "profile-unavailable",
            ) =>
              emit(
                {
                  type: "rootCreated",
                  ...key,
                  requestId: command.requestId,
                  profileId: command.profileId,
                  rootId,
                  ...(reason ? { reason } : {}),
                },
                desktopHostId,
              );
            if (canceledCreations.has(attempt)) return;
            if (lifetime.closed || !binding || !createRootWindow) {
              respond(null, "guest-unavailable");
              return;
            }
            const { environmentId, resolveProfile } = binding;
            const existing = tabs.get(keyOf(key));
            if (existing) {
              const root = existing.popup;
              const matches =
                root?.kind === "root" &&
                root.creation?.environmentId === environmentId &&
                root.creation.profileId === command.profileId &&
                root.creation.serverEpoch === command.serverEpoch &&
                root.creation.url === command.url &&
                root.creation.requestId === command.requestId;
              respond(matches ? root.id : null, matches ? undefined : "guest-unavailable");
              return;
            }
            const settings = yield* clientSettings.get.pipe(Effect.option);
            if (Option.isNone(settings)) {
              respond(null, "profile-unavailable");
              return;
            }
            const profiles = resolveBrowserProfiles(
              Option.getOrUndefined(settings.value)?.browserProfiles ?? [],
            );
            if (!profiles.some((profile) => profile.id === command.profileId)) {
              respond(null, "profile-unavailable");
              return;
            }
            const partition = yield* resolveProfile(command.profileId).pipe(Effect.option);
            if (Option.isNone(partition)) {
              respond(null, "profile-unavailable");
              return;
            }
            if (lifetime.closed) {
              respond(null, "guest-unavailable");
              return;
            }
            let window: Electron.BrowserWindow | undefined;
            const created = yield* createRootWindow({
              environmentId,
              profileId: command.profileId,
              partition: partition.value,
              ...(command.viewport ? { viewport: command.viewport } : {}),
            }).pipe(
              Effect.flatMap((value) => {
                window = value;
                if (!ownAutomationWindow(lifetime, value))
                  return Effect.fail(
                    new DesktopBrowserTransportError({ reason: "host-unavailable" }),
                  );
                return Effect.tryPromise({
                  try: () => value.loadURL("about:blank"),
                  catch: () => new DesktopBrowserTransportError({ reason: "guest-unavailable" }),
                });
              }),
              Effect.option,
            );
            if (Option.isNone(created) || canceledCreations.has(attempt) || lifetime.closed) {
              if (window && !window.isDestroyed()) window.destroy();
              if (!canceledCreations.has(attempt)) respond(null, "guest-unavailable");
              return;
            }
            if (
              !window ||
              window.isDestroyed() ||
              window.isVisible() ||
              window.isFocused() ||
              window.isFocusable()
            ) {
              if (window && !window.isDestroyed()) window.destroy();
              respond(null, "guest-unavailable");
              return;
            }
            const root = registerNativePage(key, window, {
              environmentId,
              serverEpoch: command.serverEpoch,
              profileId: command.profileId,
              url: command.url,
              requestId: command.requestId,
              stage: "created",
            });
            if (!root) {
              window.destroy();
              respond(null, "guest-unavailable");
              return;
            }
            attach(
              key,
              { webContents: root.contents, debugger: root.contents.debugger },
              `root:${root.id}`,
              root,
            );
            configureAutomationPage(root, lifetime);
            respond(root.id);
          }),
        )
        .pipe(
          Effect.ensuring(
            Effect.sync(() => {
              pendingRootCreations.delete(attempt);
              canceledCreations.delete(attempt);
            }),
          ),
        );
    });

  const handleCommand = (command: DesktopBrowserCommand, desktopHostId = "local") =>
    Effect.suspend(() => {
      if (command.type === "resolveUrl") return Effect.void;
      if (command.type === "createRoot") {
        // Register the attempt before the next serial command can cancel it.
        // Completion is acknowledged by rootCreated, not by command dispatch.
        runFork(createRoot(command, desktopHostId));
        return Effect.void;
      }
      if (command.type === "acceptRoot" || command.type === "publishRoot") {
        const key = { threadId: command.threadId, tabId: command.tabId, desktopHostId };
        const root = tabs.get(keyOf(key))?.popup;
        const matches =
          root?.kind === "root" &&
          root.id === command.rootId &&
          root.creation?.requestId === command.requestId &&
          root.creation.profileId === command.profileId &&
          !canceledCreations.has(creationKey(key, command.requestId, command.profileId)) &&
          !root.window.isDestroyed();
        if (matches && root.creation) {
          if (command.type === "acceptRoot" && root.creation.stage === "created")
            root.creation.stage = "accepted";
          if (command.type === "publishRoot" && root.creation.stage === "accepted")
            root.creation.stage = "published";
        }
        if (command.type === "acceptRoot")
          emit(
            {
              type: "rootAccepted",
              ...key,
              rootId: command.rootId,
              requestId: command.requestId,
              profileId: command.profileId,
              accepted: matches,
            },
            desktopHostId,
          );
        return Effect.void;
      }
      if (command.type === "cancelRootCreation") {
        const key = { threadId: command.threadId, tabId: command.tabId, desktopHostId };
        const root = tabs.get(keyOf(key))?.popup;
        if (
          root?.kind === "root" &&
          root.creation?.requestId === command.requestId &&
          root.creation.profileId === command.profileId &&
          root.creation.stage === "published"
        )
          return Effect.void;
        const attempt = creationKey(key, command.requestId, command.profileId);
        // Only an in-flight creation can still return a window after this acknowledgment.
        if (pendingRootCreations.has(attempt)) canceledCreations.add(attempt);
        if (
          root?.kind === "root" &&
          root.creation?.requestId === command.requestId &&
          root.creation.profileId === command.profileId &&
          root.creation.stage !== "published" &&
          !root.window.isDestroyed()
        )
          root.window.destroy();
        emit(
          {
            type: "rootCreated",
            ...key,
            requestId: command.requestId,
            profileId: command.profileId,
            rootId: null,
            reason: "guest-unavailable",
          },
          desktopHostId,
        );
        return Effect.void;
      }
      if (command.type === "discardRoot") {
        const key = { threadId: command.threadId, tabId: command.tabId, desktopHostId };
        const root = popups.get(command.rootId);
        if (
          root?.kind === "root" &&
          keyOf(root.source) === keyOf(key) &&
          !root.window.isDestroyed()
        )
          root.window.destroy();
        else emit({ type: "rootClosed", ...key, rootId: command.rootId }, desktopHostId);
        return Effect.void;
      }
      if (command.type === "reconcileRoots") {
        const retained = new Set(command.retainedRootRequestIds);
        for (const [attempt, key] of pendingRootCreations)
          if (
            (key.desktopHostId ?? "local") === desktopHostId &&
            (key.serverEpoch !== command.serverEpoch || !retained.has(key.requestId))
          )
            canceledCreations.add(attempt);
        for (const root of popups.values())
          if (
            root.kind === "root" &&
            (root.source.desktopHostId ?? "local") === desktopHostId &&
            (root.creation === undefined ||
              root.creation.serverEpoch !== command.serverEpoch ||
              !retained.has(root.creation.requestId)) &&
            !root.window.isDestroyed()
          )
            root.window.destroy();
        return Effect.void;
      }
      if (command.type === "announce") return announceAll(desktopHostId);
      if (command.type === "disconnect") {
        for (const [attempt, key] of pendingRootCreations)
          if ((key.desktopHostId ?? "local") === desktopHostId) canceledCreations.add(attempt);
        for (const root of popups.values())
          if (
            root.kind === "root" &&
            (root.source.desktopHostId ?? "local") === desktopHostId &&
            root.creation?.stage === "created" &&
            !root.window.isDestroyed()
          ) {
            root.window.destroy();
          }
        for (const tab of tabs.values()) {
          if ((tab.key.desktopHostId ?? "local") !== desktopHostId) continue;
          clearSurfaceLeases(tab);
          tab.relay = null;
          tab.downloadDirectory = null;
          tab.pendingDownloadGuid = null;
          const directory = tab.remoteDownloadDirectory;
          tab.remoteDownloadDirectory = null;
          if (directory)
            void directory
              .then((path) => NodeFSP.rm(path, { recursive: true, force: true }))
              .catch(() => undefined);
        }
        return Effect.void;
      }
      if (command.type === "profiles") {
        const requestId = command.requestId;
        return clientSettings.get.pipe(
          Effect.map((settings) => {
            const value = Option.getOrUndefined(settings);
            const profiles = resolveBrowserProfiles(value?.browserProfiles ?? []);
            const defaultProfileId =
              profiles.find(
                (profile) =>
                  profile.id === value?.browserDefaultProfileId && profile.kind !== "incognito",
              )?.id ?? DEFAULT_BROWSER_PROFILE_ID;
            return { profiles, defaultProfileId };
          }),
          Effect.orElseSucceed(() => null),
          // Read warnings may contain profile data. The marker executes after
          // the read, outside its logging scope, and records availability only.
          Effect.tap((profiles) =>
            Effect.void.pipe(
              Effect.withSpan("desktop.browser.readProfileSettings", {
                attributes: { requestId, desktopHostId, available: profiles !== null },
              }),
            ),
          ),
          Effect.flatMap((profiles) =>
            PubSub.publish(outbox, {
              desktopHostId,
              event: { type: "profiles", requestId, profiles, supportsNativeRoots: true },
            }).pipe(
              Effect.withSpan("desktop.browser.publishProfiles", {
                attributes: { requestId, desktopHostId, available: profiles !== null },
              }),
            ),
          ),
          Effect.asVoid,
        );
      }
      if (command.type === "probeRoot") {
        const root = popups.get(command.rootId);
        const source = { threadId: command.threadId, tabId: command.tabId, desktopHostId };
        if (root && (root.kind !== "root" || keyOf(root.source) !== keyOf(source)))
          return Effect.void;
        emit(
          {
            type: "rootPresence",
            threadId: command.threadId,
            tabId: command.tabId,
            rootId: command.rootId,
            requestId: command.requestId,
            present:
              root !== undefined && !root.window.isDestroyed() && !root.contents.isDestroyed(),
          },
          desktopHostId,
        );
        return Effect.void;
      }
      if (command.type === "probePopup") {
        const popup = popups.get(command.popupId);
        const source = { threadId: command.threadId, tabId: command.tabId, desktopHostId };
        if (popup && keyOf(popup.source) !== keyOf(source)) return Effect.void;
        emit(
          {
            type: "popupPresence",
            threadId: command.threadId,
            tabId: command.tabId,
            popupId: command.popupId,
            requestId: command.requestId,
            present:
              popup !== undefined &&
              !popup.window.isDestroyed() &&
              !popup.contents.isDestroyed() &&
              popup.contents.debugger.isAttached(),
          },
          desktopHostId,
        );
        return Effect.void;
      }
      if (
        command.type === "bindPopup" ||
        command.type === "closePopup" ||
        command.type === "closeRoot"
      ) {
        const nativeId = command.type === "closeRoot" ? command.rootId : command.popupId;
        const popup = popups.get(nativeId);
        const source = {
          threadId: command.threadId,
          tabId: command.type === "bindPopup" ? command.openerTabId : command.tabId,
          desktopHostId,
        };
        if (!popup && command.type !== "bindPopup") {
          // A close acknowledgement can be lost while the owner is offline.
          // Repeated close confirms the registration is already withdrawn.
          emit(
            command.type === "closeRoot"
              ? {
                  type: "rootClosed",
                  threadId: source.threadId,
                  tabId: source.tabId,
                  rootId: nativeId,
                }
              : {
                  type: "popupClosed",
                  threadId: source.threadId,
                  tabId: source.tabId,
                  popupId: nativeId,
                },
            desktopHostId,
          );
          return Effect.void;
        }
        if (
          !popup ||
          popup.kind !== (command.type === "closeRoot" ? "root" : "popup") ||
          keyOf(popup.source) !== keyOf(source) ||
          popup.window.isDestroyed() ||
          popup.contents.isDestroyed() ||
          !popup.contents.debugger.isAttached()
        )
          return Effect.void;
        if (command.type !== "bindPopup") {
          if (popup.closeRequest?.requestId === command.requestId) {
            if (popup.closeRequest.canceled)
              emit(
                command.type === "closeRoot"
                  ? {
                      type: "rootCloseCanceled",
                      threadId: source.threadId,
                      tabId: source.tabId,
                      rootId: popup.id,
                      requestId: command.requestId,
                    }
                  : {
                      type: "popupCloseCanceled",
                      threadId: source.threadId,
                      tabId: source.tabId,
                      popupId: popup.id,
                      requestId: command.requestId,
                    },
                desktopHostId,
              );
            return Effect.void;
          }
          if (popup.closeRequest && !popup.closeRequest.canceled) return Effect.void;
          // A retry replays its outcome; only a fresh request can ask the user again.
          const request = { requestId: command.requestId, canceled: false };
          popup.closeRequest = request;
          try {
            popup.window.close();
          } catch {
            request.canceled = true;
            emit(
              command.type === "closeRoot"
                ? {
                    type: "rootCloseCanceled",
                    threadId: source.threadId,
                    tabId: source.tabId,
                    rootId: popup.id,
                    requestId: command.requestId,
                  }
                : {
                    type: "popupCloseCanceled",
                    threadId: source.threadId,
                    tabId: source.tabId,
                    popupId: popup.id,
                    requestId: command.requestId,
                  },
              desktopHostId,
            );
          }
          return Effect.void;
        }
        const key = { threadId: command.threadId, tabId: command.tabId, desktopHostId };
        if (keyOf(key) === keyOf(source)) return Effect.void;
        if (popup.boundKey && keyOf(popup.boundKey) !== keyOf(key)) return Effect.void;
        const existing = tabs.get(keyOf(key));
        if (existing && existing.popup !== popup) return Effect.void;
        popup.boundKey = key;
        attach(
          key,
          { webContents: popup.contents, debugger: popup.contents.debugger },
          `popup:${popup.id}`,
          popup,
        );
        return Effect.void;
      }
      const tab = tabs.get(keyOf({ ...command, desktopHostId }));
      if (command.type === "surface") {
        if (!tab) {
          emit(
            {
              type: "surfaceReady",
              threadId: command.threadId,
              tabId: command.tabId,
              requestId: command.requestId,
              viewport: null,
              reason: "guest-unavailable",
            },
            desktopHostId,
          );
          return Effect.void;
        }
        cancelSurfaceRequests(tab, command.leaseId);
        if (command.action === "release") {
          releaseSurfaceLease(tab, command.leaseId);
        } else {
          if (!tab.renderingLeases.has(command.leaseId)) {
            const release = acquireRendering(tab);
            if (!release) {
              emit(
                {
                  type: "surfaceReady",
                  threadId: command.threadId,
                  tabId: command.tabId,
                  requestId: command.requestId,
                  viewport: null,
                  reason: "guest-unavailable",
                },
                desktopHostId,
              );
              return Effect.void;
            }
            tab.renderingLeases.set(command.leaseId, release);
          }
          tab.surfaceLeases.set(
            command.leaseId,
            command.timeoutMs === undefined ? null : now() + command.timeoutMs,
          );
        }
        if (tab.popup) {
          let viewport: DesktopBrowserSurfaceResponse["viewport"] = null;
          try {
            if (tab.popup.kind === "root" && command.action === "acquire") {
              const size =
                command.viewport && command.viewport._tag !== "fill"
                  ? command.viewport
                  : command.viewportSize;
              if (size) tab.popup.window.setContentSize(size.width, size.height);
              if (command.zoomFactor !== undefined)
                tab.popup.contents.setZoomFactor(command.zoomFactor);
            }
            const [width, height] = tab.popup.window.getContentSize();
            if (
              !tab.popup.window.isDestroyed() &&
              width !== undefined &&
              height !== undefined &&
              width > 0 &&
              height > 0
            )
              viewport = { width, height };
          } catch {
            // The popup can close between the command and sampling its bounds.
          }
          if (viewport === null) releaseSurfaceLease(tab, command.leaseId);
          emit(
            {
              type: "surfaceReady",
              threadId: command.threadId,
              tabId: command.tabId,
              requestId: command.requestId,
              viewport,
              ...(viewport === null ? { reason: "guest-unavailable" as const } : {}),
            },
            desktopHostId,
          );
          return Effect.void;
        }
        // Renderer request IDs belong to this process, avoiding collisions between backends.
        const requestId = `surface:${++nextSurfaceRequest}`;
        const request = { ...command, requestId, runtimeTabId: tab.runtimeTabId };
        const timer = runFork(
          Effect.sleep(2500).pipe(
            Effect.andThen(() =>
              Effect.sync(() =>
                finishSurface(requestId, {
                  requestId,
                  viewport: null,
                  reason: "layout-timeout",
                }),
              ),
            ),
          ),
        );
        pendingSurfaces.set(requestId, {
          tab,
          request,
          serverRequestId: command.requestId,
          senderId: tab.debuggee.webContents.hostWebContents?.id ?? -1,
          timer,
        });
        if (!sendSurface(tab, request))
          finishSurface(requestId, {
            requestId,
            viewport: null,
            reason: "guest-unavailable",
          });
        return Effect.void;
      }
      if (!tab) return Effect.void;
      if (command.type === "pointer") {
        const { threadId, tabId, phase, x, y } = command;
        runFork(PubSub.publish(pointers, { key: { threadId, tabId, desktopHostId }, phase, x, y }));
        return Effect.void;
      }
      if (command.type === "release") {
        clearSurfaceLeases(tab);
        // A new server connection starts with a fresh relay and fresh sessions.
        tab.relay = null;
        return Effect.void;
      }
      if (AGENT_INPUT_COMMAND.test(command.message))
        tab.agentInputAt =
          command.inputSource === "viewer" ? Number.NEGATIVE_INFINITY : performance.now();
      relayFor(tab).receive(command.message);
      return Effect.void;
    });

  const humanStartedDownload = (source: Electron.WebContents) => {
    const tab = [...tabs.values()].find((candidate) => candidate.debuggee.webContents === source);
    return tab !== undefined && performance.now() - tab.agentInputAt > AGENT_DOWNLOAD_WINDOW_MS;
  };

  // Read when a backend starts, not when the host is built.
  const announceAll = (desktopHostId: string) =>
    Effect.suspend(() =>
      Effect.gen(function* () {
        yield* Effect.forEach(
          [...tabs.values()].filter((tab) => (tab.key.desktopHostId ?? "local") === desktopHostId),
          (tab) => {
            clearSurfaceLeases(tab);
            tab.relay = null;
            return PubSub.publish(outbox, {
              desktopHostId,
              event: {
                type: "attached",
                threadId: tab.key.threadId,
                tabId: tab.key.tabId,
                supportsNativeSurface: true,
                ...(tab.presented ? { presented: true } : {}),
              },
            });
          },
          { discard: true },
        );
        for (const popup of popups.values()) {
          if ((popup.source.desktopHostId ?? "local") !== desktopHostId || popup.kind === "root")
            continue;
          yield* PubSub.publish(outbox, {
            desktopHostId,
            event: {
              type: "popupCreated",
              threadId: popup.source.threadId,
              tabId: popup.source.tabId,
              popupId: popup.id,
              ...(popup.boundKey === undefined ? {} : { boundTabId: popup.boundKey.tabId }),
              url: popup.contents.getURL(),
            },
          });
        }
      }),
    );

  return DesktopBrowserHost.of({
    pointers: Stream.fromPubSub(pointers),
    bindEnvironment: (desktopHostId, environmentId, resolveProfile) =>
      Effect.suspend(() => {
        const existing = environmentBindings.get(desktopHostId);
        if (existing !== undefined && existing.environmentId !== environmentId)
          return Effect.fail(new DesktopBrowserTransportError({ reason: "host-unavailable" }));
        environmentBindings.set(desktopHostId, { environmentId, resolveProfile });
        return Effect.void;
      }),
    setRootFactory: (create) => {
      createRootWindow = create;
    },
    // Subscribes before announcing, so no attach falls between the two.
    events: Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(outbox);
        yield* announceAll("local");
        return Stream.fromSubscription(subscription);
      }),
    ).pipe(
      Stream.filter((entry) => entry.desktopHostId === "local"),
      Stream.tap(({ event }) =>
        event.type === "profiles"
          ? Effect.void.pipe(
              Effect.withSpan("desktop.browser.dequeueProfiles", {
                attributes: { requestId: event.requestId, desktopHostId: "local" },
              }),
            )
          : Effect.void,
      ),
      Stream.map(({ event }) => lineEncoder.encode(`${encodeEvent(event)}\n`)),
    ),
    remoteEvents: Stream.fromPubSub(outbox).pipe(
      Stream.filter((entry) => entry.desktopHostId !== "local"),
    ),
    handleRemoteCommand: ({ desktopHostId, command }) =>
      desktopHostId === "local" ? Effect.void : handleCommand(command, desktopHostId),
    handleCommandLine: (line) => {
      const decoded = decodeCommand(line);
      if (Option.isNone(decoded))
        return Effect.void.pipe(Effect.withSpan("desktop.browser.invalidCommand"));
      const command = decoded.value;
      return command.type === "profiles" || command.type === "reconcileRoots"
        ? Effect.void.pipe(
            Effect.withSpan("desktop.browser.commandReceived", {
              attributes: {
                commandType: command.type,
                ...(command.type === "profiles" ? { requestId: command.requestId } : {}),
                desktopHostId: "local",
              },
            }),
            Effect.andThen(handleCommand(command)),
          )
        : handleCommand(command);
    },
    attach,
    registerPopup,
    setPresentation: (input, senderId) => {
      const tab = [...tabs.values()].find((tab) => tab.runtimeTabId === input.runtimeTabId);
      if (tab && (tab.popup || tab.debuggee.webContents.hostWebContents?.id !== senderId)) return;
      // Registration and relay attachment are asynchronous. Retain the slot
      // state so an attach cannot lose a presentation reported before it.
      if (input.presented) presentedSlots.set(input.runtimeTabId, senderId);
      else if (presentedSlots.get(input.runtimeTabId) === senderId)
        presentedSlots.delete(input.runtimeTabId);
      if (!tab) return;
      updatePresentation(tab);
    },
    setMainWindow: (window) => {
      if (mainWindow === window) return;
      releaseMainWindow?.();
      if (mainWindow !== null) {
        closeAutomationLifetime(automationLifetime);
        automationLifetime = makeAutomationLifetime();
      }
      mainWindow = window;
      const lifetime = automationLifetime;
      const changed = () => {
        for (const tab of tabs.values()) updatePresentation(tab);
      };
      const closed = () => closeAutomationLifetime(lifetime);
      window.on("closed", closed);
      const stopObserving = observeWindow(window, changed);
      releaseMainWindow = () => {
        stopObserving();
        window.off("closed", closed);
      };
      if (window.isDestroyed()) closed();
      changed();
    },
    setPictureInPictureWindow: (runtimeTabId, window) => {
      const previous = pictureInPictureWindows.get(runtimeTabId);
      if (previous?.window === window) return;
      previous?.release();
      pictureInPictureWindows.delete(runtimeTabId);
      const changed = () => {
        const tab = [...tabs.values()].find((tab) => tab.runtimeTabId === runtimeTabId);
        if (tab) updatePresentation(tab);
      };
      if (window)
        pictureInPictureWindows.set(runtimeTabId, {
          window,
          release: observeWindow(window, changed),
        });
      changed();
    },
    surfaceResponse,
    setBackgroundThrottling,
    detach,
    placeDownload,
    humanStartedDownload,
  });
});

export const layer = Layer.effect(DesktopBrowserHost, make);
