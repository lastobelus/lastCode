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
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as NodePath from "node:path";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import { DESKTOP_BROWSER_SURFACE_REQUEST_CHANNEL } from "../ipc/channels.ts";

import { createCdpRelayConnection, type CdpRelayConnection } from "./CdpRelay.ts";

const encodeEvent = Schema.encodeSync(Schema.fromJsonString(DesktopBrowserEvent));
const decodeCommand = Schema.decodeUnknownOption(Schema.fromJsonString(DesktopBrowserCommand));
const lineEncoder = new TextEncoder();

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
  readonly surfaceLeases: Map<string, number | null>;
  readonly renderingLeases: Map<string, () => void>;
  relay: CdpRelayConnection | null;
  /** Where the server wants this tab's downloads; null keeps Electron's own handling. */
  downloadDirectory: string | null;
  /** The guid CDP gave the download that is about to start. */
  pendingDownloadGuid: string | null;
  remoteDownloadDirectory: Promise<string> | null;
  readonly onMessage: (
    event: Electron.Event,
    method: string,
    params: unknown,
    sessionId: string,
  ) => void;
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
    /** Offers a server tab's `<webview>` to the server. */
    readonly attach: (
      key: DesktopBrowserTabKey,
      debuggee: DesktopBrowserTabDebugger,
      runtimeTabId: string,
    ) => void;
    readonly surfaceResponse: (response: DesktopBrowserSurfaceResponse, senderId: number) => void;
    /** Shares the preview manager's base policy with temporary automation rendering leases. */
    readonly setBackgroundThrottling: (contents: Electron.WebContents, enabled: boolean) => void;
    /** Withdraws it: closed, swapped, crashed, or devtools needs the debugger. */
    readonly detach: (key: DesktopBrowserTabKey) => void;
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
  const emit = (event: DesktopBrowserEventType, desktopHostId = "local") =>
    runFork(PubSub.publish(outbox, { desktopHostId, event }));
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
    if (!host || host.isDestroyed() || guest.isDestroyed()) return null;
    const releases: Array<() => void> = [];
    try {
      for (const contents of new Set([host, guest]))
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
  ) => {
    const id = keyOf(key);
    if (tabs.get(id)?.debuggee.webContents === debuggee.webContents) return;
    detach(key);
    const tab: AttachedTab = {
      key,
      debuggee,
      runtimeTabId,
      surfaceLeases: new Map(),
      renderingLeases: new Map(),
      relay: null,
      downloadDirectory: null,
      pendingDownloadGuid: null,
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
      { type: "attached", threadId: key.threadId, tabId: key.tabId, supportsNativeSurface: true },
      key.desktopHostId,
    );
  };

  const handleCommand = (command: DesktopBrowserCommand, desktopHostId = "local") =>
    Effect.suspend(() => {
      if (command.type === "resolveUrl") return Effect.void;
      if (command.type === "announce") return announceAll(desktopHostId);
      if (command.type === "disconnect") {
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
          Effect.flatMap((profiles) =>
            PubSub.publish(outbox, {
              desktopHostId,
              event: { type: "profiles", requestId, profiles },
            }),
          ),
          Effect.asVoid,
        );
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
      relayFor(tab).receive(command.message);
      return Effect.void;
    });

  // Read when a backend starts, not when the host is built.
  const announceAll = (desktopHostId: string) =>
    Effect.suspend(() =>
      Effect.forEach(
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
            },
          });
        },
        { discard: true },
      ),
    );

  return DesktopBrowserHost.of({
    pointers: Stream.fromPubSub(pointers),
    // Subscribes before announcing, so no attach falls between the two.
    events: Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(outbox);
        yield* announceAll("local");
        return Stream.fromSubscription(subscription);
      }),
    ).pipe(
      Stream.filter((entry) => entry.desktopHostId === "local"),
      Stream.map(({ event }) => lineEncoder.encode(`${encodeEvent(event)}\n`)),
    ),
    remoteEvents: Stream.fromPubSub(outbox).pipe(
      Stream.filter((entry) => entry.desktopHostId !== "local"),
    ),
    handleRemoteCommand: ({ desktopHostId, command }) =>
      desktopHostId === "local" ? Effect.void : handleCommand(command, desktopHostId),
    handleCommandLine: (line) => {
      const decoded = decodeCommand(line);
      return Option.isSome(decoded) ? handleCommand(decoded.value) : Effect.void;
    },
    attach,
    surfaceResponse,
    setBackgroundThrottling,
    detach,
    placeDownload,
  });
});

export const layer = Layer.effect(DesktopBrowserHost, make);
