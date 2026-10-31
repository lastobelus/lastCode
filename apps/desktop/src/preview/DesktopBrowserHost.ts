// @effect-diagnostics nodeBuiltinImport:off - Names download files on the shared disk.
/** The manager owns the single debugger attachment; the relay shares it. */
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
import * as NodeCrypto from "node:crypto";
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
import { sendPageCommand } from "./GuestInput.ts";

const encodeEvent = Schema.encodeSync(Schema.fromJsonString(DesktopBrowserEvent));
const decodeCommand = Schema.decodeUnknownOption(Schema.fromJsonString(DesktopBrowserCommand));
const lineEncoder = new TextEncoder();
const AGENT_INPUT_COMMAND =
  /"method":"(?:Input\.|Page\.navigate"|Runtime\.(?:evaluate|callFunctionOn)")/;
/** The same commands as above, by method, for the relay's sends. */
const AGENT_INPUT_METHOD = /^(?:Input\.|Page\.navigate$|Runtime\.(?:evaluate|callFunctionOn)$)/;
const AGENT_DOWNLOAD_WINDOW_MS = 5_000;
const FOCUS_IDLE = "5 seconds";

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
  screenshotTurn: object | null;
  /** Each holds focus and painting while `held` and whoever queued it still waits on it. */
  readonly waitingScreenshots: Array<{
    readonly start: () => void;
    readonly live: () => boolean;
    held: boolean;
  }>;
  presented: boolean;
  downloadDirectory: string | null;
  pendingDownloadGuid: string | null;
  agentInputAt: number;
  focusEmulated: boolean;
  focusChange: Promise<void> | null;
  focusUses: number;
  /** Each pending command, by the extra session waiting on it; the main connection's have none. */
  readonly focusPending: Map<
    object,
    { readonly owner: string | undefined; readonly paints: boolean }
  >;
  /** Whether the client keeps the guest painting, as published on `painting`. */
  painting: boolean;
  /**
   * Driven by the agent since its thread's last turn ended or the guest last throttled. A
   * turn's start can reach us after its first command, so this holds focus once it does.
   */
  agentUsed: boolean;
  focusReleasing: boolean;
  /** The sessions streaming the guest; one stopping leaves the others' screencasts running. */
  readonly screencasts: Set<string | undefined>;
  remoteDownloadDirectory: Promise<string> | null;
  readonly onMessage: (
    event: Electron.Event,
    method: string,
    params: unknown,
    sessionId: string,
  ) => void;
  readonly onNewDocument: () => void;
}

interface NativePopup {
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
    readonly events: Stream.Stream<Uint8Array>;
    readonly remoteEvents: Stream.Stream<{
      readonly desktopHostId: string;
      readonly event: DesktopBrowserEventType;
    }>;
    readonly handleRemoteCommand: (input: {
      readonly desktopHostId: string;
      readonly command: DesktopBrowserCommand;
    }) => Effect.Effect<void>;
    readonly handleCommandLine: (line: string) => Effect.Effect<void>;
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
    readonly detach: (key: DesktopBrowserTabKey) => void;
    readonly humanStartedDownload: (source: Electron.WebContents) => boolean;
    readonly placeDownload: (source: Electron.WebContents, item: Electron.DownloadItem) => boolean;
    readonly pointers: Stream.Stream<{
      readonly key: DesktopBrowserTabKey;
      readonly phase: "move" | "click";
      readonly x: number;
      readonly y: number;
    }>;
    /** Whether a guest needs its frames painted while the panel hides it. */
    readonly painting: Stream.Stream<{
      readonly key: DesktopBrowserTabKey;
      readonly active: boolean;
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
  const painting = yield* PubSub.unbounded<{
    readonly key: DesktopBrowserTabKey;
    readonly active: boolean;
  }>();
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  const runPromise = Effect.runPromiseWith(context);
  /** Native capture and stream commands must settle before the server releases their surface. */
  const sendBoundedSurfaceCommand = <T>(
    tab: AttachedTab,
    method: string,
    send: (signal?: AbortSignal) => Promise<T>,
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
            try: (signal) => send(signal),
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
  /** Threads whose agent turn runs, by the server's account. */
  const agentTurns = new Map<string, Set<string>>();
  const popups = new Map<string, NativePopup>();
  const presentedSlots = new Map<string, number>();
  const emit = (event: DesktopBrowserEventType, desktopHostId = "local") =>
    runFork(PubSub.publish(outbox, { desktopHostId, event }));
  let mainWindow: Electron.BrowserWindow | null = null;
  let releaseMainWindow: (() => void) | undefined;
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
      for (const entry of pictureInPictureWindows.values()) entry.release();
      for (const popup of popups.values()) {
        if (popup.boundKey) detach(popup.boundKey);
        popup.release();
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

  const nextScreenshot = (tab: AttachedTab) => {
    tab.screenshotTurn = null;
    tab.waitingScreenshots.shift()?.start();
    releaseFocusWhenIdle(tab);
    syncPainting(tab);
  };

  /**
   * Chromium below 157 crashes the whole app when a guest's renderer exits with a
   * screenshot copy in flight (crbug.com/567321049). Overlapping screenshots make that
   * far likelier, and one the server gave up on stays pending in Chromium, so each guest
   * gets one at a time. One whose relay or session has since gone is dropped unsent.
   */
  const takeScreenshot = (
    tab: AttachedTab,
    relay: CdpRelayConnection,
    ownerLive: () => boolean,
    /** Sends only while `current` holds; holds focus and painting only while `held`. */
    capture: (current: () => boolean, held: boolean) => Promise<unknown>,
    signal: AbortSignal | undefined,
  ) =>
    new Promise<unknown>((resolve, reject) => {
      const live = () => tab.relay === relay && ownerLive();
      const waiting = {
        start: () => {
          if (!live()) {
            reject(new Error("The preview connection that asked for this screenshot closed."));
            nextScreenshot(tab);
            return;
          }
          if (signal?.aborted) {
            reject(new Error("The preview screenshot deadline expired while waiting."));
            nextScreenshot(tab);
            return;
          }
          const turn = {};
          tab.screenshotTurn = turn;
          capture(() => tab.screenshotTurn === turn && live(), waiting.held)
            .finally(() => {
              if (tab.screenshotTurn === turn) nextScreenshot(tab);
            })
            .then(resolve, reject);
        },
        live,
        held: true,
      };
      if (tab.screenshotTurn === null) waiting.start();
      else {
        // The one ahead may be abandoned mid-capture; it needs frames to finish and free its turn.
        tab.waitingScreenshots.push(waiting);
        setFocusEmulation(tab, true);
        syncPainting(tab);
      }
    });

  /**
   * Chromium counts a focus-emulated guest as captured, so a guest the panel hides would
   * never throttle. Without it, a hidden guest paints no frames and focus() fires no focus
   * events, so the guest is emulated focused while the server drives it or streams it.
   */
  const setFocusEmulation = (tab: AttachedTab, enabled: boolean) => {
    if (tab.focusEmulated === enabled) return;
    tab.focusEmulated = enabled;
    // A guest that refuses it, or a debugger already gone, behaves as unfocused.
    const change: Promise<void> = tab.debuggee.debugger
      .sendCommand("Emulation.setFocusEmulationEnabled", { enabled })
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        if (tab.focusChange === change) tab.focusChange = null;
      });
    tab.focusChange = change;
  };

  const waitingHolds = (tab: AttachedTab) =>
    tab.waitingScreenshots.some((waiting) => waiting.held && waiting.live());

  const releaseFocusWhenIdle = (tab: AttachedTab) => {
    if (tab.focusReleasing) return;
    tab.focusReleasing = true;
    runFork(
      Effect.gen(function* () {
        let uses: number;
        do {
          uses = tab.focusUses;
          yield* Effect.sleep(FOCUS_IDLE);
        } while (uses !== tab.focusUses);
        tab.focusReleasing = false;
        // The last pending command to settle starts another idle wait.
        if (tab.focusPending.size > 0 || tab.screencasts.size > 0 || waitingHolds(tab)) {
          return;
        }
        // The agent pauses to think between steps; its tab stays focused until the turn ends.
        if (tab.agentUsed && agentTurns.get(tab.key.desktopHostId ?? "local")?.has(tab.key.threadId))
          return;
        tab.agentUsed = false;
        if (tabs.get(keyOf(tab.key)) === tab) setFocusEmulation(tab, false);
      }),
    );
  };

  /**
   * Electron composites no offscreen guest, so its screenshot or screencast waits for a frame
   * that never comes. The client paints the guest behind the app while one is pending; the
   * capture then finishes on its own, and the guest goes back offscreen once none is.
   */
  const syncPainting = (tab: AttachedTab) => {
    const active =
      tabs.get(keyOf(tab.key)) === tab &&
      (tab.screencasts.size > 0 ||
        waitingHolds(tab) ||
        [...tab.focusPending.values()].some((hold) => hold.paints));
    if (tab.painting === active) return;
    tab.painting = active;
    runFork(PubSub.publish(painting, { key: tab.key, active }));
  };

  /** A command may wait on the page's next frame, so the guest stays focused until it settles. */
  const holdFocus = <A>(
    tab: AttachedTab,
    method: string,
    owner: string | undefined,
    work: () => Promise<A>,
  ) => {
    const pending = {};
    tab.focusPending.set(pending, { owner, paints: method === "Page.captureScreenshot" });
    tab.focusUses += 1;
    setFocusEmulation(tab, true);
    releaseFocusWhenIdle(tab);
    syncPainting(tab);
    return work().finally(() => {
      if (!tab.focusPending.delete(pending)) return;
      tab.focusUses += 1;
      releaseFocusWhenIdle(tab);
      syncPainting(tab);
    });
  };

  /**
   * Chromium can leave a command unanswered, so the screenshot guard's release points
   * also end every hold: a released relay has no one waiting, and a new document answers
   * nothing pending from the old one. A released relay's screencast has no viewer to stop it.
   */
  const dropFocusHolds = (tab: AttachedTab) => {
    tab.focusPending.clear();
    releaseFocusWhenIdle(tab);
    syncPainting(tab);
  };

  const dropRelay = (tab: AttachedTab) => {
    tab.relay = null;
    tab.screencasts.clear();
    tab.agentUsed = false;
    dropFocusHolds(tab);
  };

  /** A detached session, such as a closed viewer, waits on nothing it sent. */
  const dropSessionHolds = (tab: AttachedTab, owner: string) => {
    tab.screencasts.delete(owner);
    for (const [pending, hold] of tab.focusPending) {
      if (hold.owner === owner) tab.focusPending.delete(pending);
    }
    releaseFocusWhenIdle(tab);
    syncPainting(tab);
  };

  /**
   * A command the server stopped waiting on, such as a timed-out screenshot or evaluation,
   * may never settle; the turn's end ends every hold. The agent also sends on its own extra
   * session, so this cannot spare other sessions; a viewer's screencast still holds.
   */
  const endAgentTurn = (threadId: string, desktopHostId: string) => {
    agentTurns.get(desktopHostId)?.delete(threadId);
    for (const tab of tabs.values()) {
      if (tab.key.threadId !== threadId || (tab.key.desktopHostId ?? "local") !== desktopHostId)
        continue;
      tab.agentUsed = false;
      // Still sent in turn, so the queue keeps moving, but no longer kept painting.
      for (const waiting of tab.waitingScreenshots) waiting.held = false;
      dropFocusHolds(tab);
    }
  };

  const relayFor = (tab: AttachedTab) => {
    if (tab.relay) return tab.relay;
    const { webContents, debugger: debuggee } = tab.debuggee;
    const send = (method: string, params: Record<string, unknown>, sessionId?: string) =>
      sessionId === undefined
        ? sendPageCommand(webContents, debuggee, method, params)
        : debuggee.sendCommand(method, params, sessionId);
    const detachedOwners = new Set<string>();
    /** Viewers and recordings stream; the agent's own sessions never do. */
    const streamingOwners = new Set<string>();
    const relay: CdpRelayConnection = createCdpRelayConnection(
      {
        send: async (method, params, sessionId, owner) => {
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
          return sendBoundedSurfaceCommand(tab, method, (signal) => {
            // A child session's screencast is not the page's, such as a late one on a detached session.
            if (sessionId === undefined && method === "Page.startScreencast") {
              tab.screencasts.add(owner);
              if (owner !== undefined) streamingOwners.add(owner);
            } else if (sessionId === undefined && method === "Page.stopScreencast") {
              tab.screencasts.delete(owner);
            }
            // A person's input through a viewer, or Playwright's own housekeeping, is not the agent's.
            if (
              AGENT_INPUT_METHOD.test(method) &&
              (owner === undefined || !streamingOwners.has(owner))
            ) {
              tab.agentUsed = true;
            }
            // Waits for focus emulation; insertText and other non-CDP input would not queue behind it.
            const forward = (current?: () => boolean) => {
              const change = tab.focusChange;
              const run = () => {
                signal?.throwIfAborted();
                return tab.relay === relay && (current === undefined || current())
                  ? send(method, localParams, sessionId)
                  : Promise.reject(new Error("The page this screenshot was for has moved on."));
              };
              return change === null ? run() : change.then(run);
            };
            return method === "Page.captureScreenshot"
              ? takeScreenshot(
                  tab,
                  relay,
                  () => owner === undefined || !detachedOwners.has(owner),
                  (current, held) =>
                    held ? holdFocus(tab, method, owner, () => forward(current)) : forward(current),
                  signal,
                )
              : method === "Page.startScreencast"
                ? holdFocus(tab, method, owner, forward).catch((cause: unknown) => {
                    // A viewer can outlive a refused stream; nothing is streaming for it.
                    if (sessionId === undefined && tab.relay === relay) tab.screencasts.delete(owner);
                    releaseFocusWhenIdle(tab);
                    syncPainting(tab);
                    throw cause;
                  })
                : holdFocus(tab, method, owner, forward);
          });
        },
        sessionDetached: (owner) => {
          detachedOwners.add(owner);
          dropSessionHolds(tab, owner);
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
      (message) => {
        if (tab.relay === relay && tabs.get(keyOf(tab.key)) === tab) {
          emit(
            { type: "cdp", threadId: tab.key.threadId, tabId: tab.key.tabId, message },
            tab.key.desktopHostId,
          );
        }
      },
      // Announcing the tab again would reconnect Playwright, and the page could
      // replay the same oversized event, so the tab stays detached.
      () => {
        if (tab.relay !== relay || tabs.get(keyOf(tab.key)) !== tab) return;
        // Disabling auto-attach detaches child sessions and releases their debugger pauses.
        void debuggee
          .sendCommand("Target.setAutoAttach", {
            autoAttach: false,
            waitForDebuggerOnStart: false,
            flatten: true,
          })
          .catch(() => {});
        if (tab.screencasts.size > 0) {
          void debuggee.sendCommand("Page.stopScreencast").catch(() => {});
        }
        setFocusEmulation(tab, false);
        detach(tab.key);
      },
    );
    tab.relay = relay;
    return relay;
  };

  // CDP supplies the path before this runs; otherwise Electron opens a Save dialog.
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
    tab.relay = null;
    if (tab.remoteDownloadDirectory) {
      void tab.remoteDownloadDirectory
        .then((directory) => NodeFSP.rm(directory, { recursive: true, force: true }))
        .catch(() => undefined);
    }
    tab.debuggee.debugger.off("message", tab.onMessage);
    tab.debuggee.webContents.off("did-navigate", tab.onNewDocument);
    syncPainting(tab);
    emit({ type: "detached", threadId: key.threadId, tabId: key.tabId }, key.desktopHostId);
  };

  const attach = (
    key: DesktopBrowserTabKey,
    debuggee: DesktopBrowserTabDebugger,
    runtimeTabId: string,
    popup?: NativePopup,
  ) => {
    const id = keyOf(key);
    if (tabs.get(id)?.debuggee.webContents === debuggee.webContents) return;
    detach(key);
    const tab: AttachedTab = {
      key,
      debuggee,
      runtimeTabId,
      popup,
      surfaceLeases: new Map(),
      renderingLeases: new Map(),
      relay: null,
      screenshotTurn: null,
      waitingScreenshots: [],
      presented: popup
        ? windowVisible(popup.window)
        : nativePresented(runtimeTabId, debuggee.webContents.hostWebContents?.id),
      downloadDirectory: null,
      pendingDownloadGuid: null,
      agentInputAt: Number.NEGATIVE_INFINITY,
      focusEmulated: false,
      focusChange: null,
      focusUses: 0,
      focusPending: new Map(),
      painting: false,
      agentUsed: false,
      focusReleasing: false,
      screencasts: new Set(),
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
      // A screenshot pending when the page loads a new document, a reload included, can
      // stay unanswered. A crashed page lands here once it reloads, well after its renderer died.
      onNewDocument: () => {
        // Before the next screenshot starts, so its own hold survives.
        dropFocusHolds(tab);
        if (tab.screenshotTurn !== null) nextScreenshot(tab);
      },
    };
    tabs.set(id, tab);
    debuggee.debugger.on("message", tab.onMessage);
    debuggee.webContents.on("did-navigate", tab.onNewDocument);
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

  const registerPopup = (source: DesktopBrowserTabKey, window: Electron.BrowserWindow) => {
    if (!tabs.has(keyOf(source)) || window.isDestroyed()) return;
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
      emit(
        { type: "popupClosed", threadId: source.threadId, tabId: source.tabId, popupId: id },
        source.desktopHostId,
      );
      if (popup.boundKey) detach(popup.boundKey);
      popup.release();
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
        {
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
      id,
      source: { ...source },
      window,
      contents,
      boundKey: undefined,
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
  };

  const handleCommand = (command: DesktopBrowserCommand, desktopHostId = "local") =>
    Effect.suspend(() => {
      if (command.type === "turn") {
        if (command.active) {
          const turns = agentTurns.get(desktopHostId) ?? new Set<string>();
          turns.add(command.threadId);
          agentTurns.set(desktopHostId, turns);
        } else endAgentTurn(command.threadId, desktopHostId);
        return Effect.void;
      }
      if (command.type === "resolveUrl") return Effect.void;
      if (command.type === "announce") return announceAll(desktopHostId);
      if (command.type === "disconnect") {
        agentTurns.delete(desktopHostId);
        for (const tab of tabs.values()) {
          if ((tab.key.desktopHostId ?? "local") !== desktopHostId) continue;
          clearSurfaceLeases(tab);
          dropRelay(tab);
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
      if (command.type === "bindPopup" || command.type === "closePopup") {
        const popup = popups.get(command.popupId);
        const source = {
          threadId: command.threadId,
          tabId: command.type === "bindPopup" ? command.openerTabId : command.tabId,
          desktopHostId,
        };
        if (!popup && command.type === "closePopup") {
          // A close acknowledgement can be lost while the owner is offline.
          // Repeated close confirms the registration is already withdrawn.
          emit(
            {
              type: "popupClosed",
              threadId: source.threadId,
              tabId: source.tabId,
              popupId: command.popupId,
            },
            desktopHostId,
          );
          return Effect.void;
        }
        if (
          !popup ||
          keyOf(popup.source) !== keyOf(source) ||
          popup.window.isDestroyed() ||
          popup.contents.isDestroyed() ||
          !popup.contents.debugger.isAttached()
        )
          return Effect.void;
        if (command.type === "closePopup") {
          if (popup.closeRequest?.requestId === command.requestId) {
            if (popup.closeRequest.canceled)
              emit(
                {
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
              {
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
        dropRelay(tab);
        return Effect.void;
      }
      if (AGENT_INPUT_COMMAND.test(command.message)) tab.agentInputAt = performance.now();
      relayFor(tab).receive(command.message);
      return Effect.void;
    });

  const humanStartedDownload = (source: Electron.WebContents) => {
    const tab = [...tabs.values()].find((candidate) => candidate.debuggee.webContents === source);
    return tab !== undefined && performance.now() - tab.agentInputAt > AGENT_DOWNLOAD_WINDOW_MS;
  };

  const announceAll = (desktopHostId: string) =>
    Effect.suspend(() =>
      Effect.gen(function* () {
        agentTurns.delete(desktopHostId);
        yield* Effect.forEach(
          [...tabs.values()].filter((tab) => (tab.key.desktopHostId ?? "local") === desktopHostId),
          (tab) => {
            clearSurfaceLeases(tab);
            dropRelay(tab);
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
          if ((popup.source.desktopHostId ?? "local") !== desktopHostId) continue;
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
    painting: Stream.fromPubSub(painting),
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
      mainWindow = window;
      const changed = () => {
        for (const tab of tabs.values()) updatePresentation(tab);
      };
      releaseMainWindow = observeWindow(window, changed);
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
