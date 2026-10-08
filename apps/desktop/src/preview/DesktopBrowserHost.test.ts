import * as Queue from "effect/Queue";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
// @effect-diagnostics nodeBuiltinImport:off - Stands in for an Electron debugger.
import { describe, expect, it } from "@effect/vitest";
import { DesktopBrowserEvent, type DesktopBrowserSurfaceRequest } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";

import * as DesktopBrowserHost from "./DesktopBrowserHost.ts";

const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(DesktopBrowserEvent));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeCdpReply = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ id: Schema.Number })),
);
const decodeCdpTargetsReply = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.Number,
      result: Schema.Struct({
        targetInfos: Schema.Array(Schema.Struct({ targetId: Schema.String, url: Schema.String })),
      }),
    }),
  ),
);
const key = { threadId: "thread-1", tabId: "tab-1" };

const makePresentationWindow = (initialVisible = true) => {
  const events = new NodeEvents.EventEmitter();
  let visible = initialVisible;
  let minimized = false;
  const window = Object.assign(events, {
    isDestroyed: () => false,
    isVisible: () => visible,
    isMinimized: () => minimized,
    webContents: { id: 77 },
  });
  return {
    window: window as unknown as Electron.BrowserWindow,
    show: () => {
      visible = true;
      events.emit("show");
    },
    hide: () => {
      visible = false;
      events.emit("hide");
    },
    minimize: () => {
      minimized = true;
      events.emit("minimize");
    },
    restore: () => {
      minimized = false;
      events.emit("restore");
    },
  };
};

/** A tab's webContents and debugger, with the debugger's commands left pending until released. */
const makeRenderingContents = (initial = true) => {
  let throttled = initial;
  let destroyed = false;
  const throttleChanges: boolean[] = [];
  return {
    isDestroyed: () => destroyed,
    destroy: () => {
      destroyed = true;
    },
    getBackgroundThrottling: () => throttled,
    setBackgroundThrottling: (enabled: boolean) => {
      throttleChanges.push(enabled);
      throttled = enabled;
    },
    throttleChanges,
  };
};

const makeDebuggee = () => {
  const emitter = new NodeEvents.EventEmitter();
  const pending: Array<() => void> = [];
  const debuggee = Object.assign(emitter, {
    sendCommand: (method: string) =>
      new Promise((resolve) => {
        if (method === "Target.getTargetInfo") {
          resolve({ targetInfo: { targetId: "GUEST" } });
          return;
        }
        pending.push(() => resolve({ method }));
      }),
  });
  const surfaceRequests: DesktopBrowserSurfaceRequest[] = [];
  const hostContents = {
    ...makeRenderingContents(),
    id: 77,
    send: (_channel: string, request: DesktopBrowserSurfaceRequest) => {
      surfaceRequests.push(request);
    },
  };
  const webContents = {
    ...makeRenderingContents(),
    hostWebContents: hostContents,
    getURL: () => "http://localhost/",
    getTitle: () => "Page",
    getUserAgent: () => "Electron",
  };
  return {
    surfaceRequests,
    hostContents,
    webContents,
    tab: {
      webContents: webContents as unknown as Electron.WebContents,
      debugger: debuggee as unknown as Electron.Debugger,
    },
    emit: (method: string, params: unknown) => emitter.emit("message", {}, method, params, ""),
    release: () => pending.splice(0).forEach((resolve) => resolve()),
  };
};

const makePopup = (initialVisible = true, initiallyAttached = false) => {
  const events = new NodeEvents.EventEmitter();
  const debuggee = new NodeEvents.EventEmitter();
  let attached = initiallyAttached;
  let attachCount = 0;
  let destroyed = false;
  let visible = initialVisible;
  let minimized = false;
  const rendering = makeRenderingContents();
  const debuggerApi = Object.assign(debuggee, {
    isAttached: () => attached,
    attach: () => {
      attachCount += 1;
      attached = true;
    },
    detach: () => {
      attached = false;
      debuggee.emit("detach", {}, "target_closed");
    },
    sendCommand: async (method: string) =>
      method === "Target.getTargetInfo" ? { targetInfo: { targetId: "CHILD" } } : {},
  });
  const contents = Object.assign(new NodeEvents.EventEmitter(), {
    ...rendering,
    isDestroyed: () => destroyed,
    debugger: debuggerApi,
    getURL: () => "https://popup.example/",
    getTitle: () => "Child page",
    getUserAgent: () => "Electron",
  });
  const window = Object.assign(events, {
    webContents: contents,
    isDestroyed: () => destroyed,
    isVisible: () => visible,
    isMinimized: () => minimized,
    getContentSize: () => [640, 480],
    close: () => {
      destroyed = true;
      events.emit("closed");
    },
  });
  return {
    window: window as unknown as Electron.BrowserWindow,
    contents,
    attachCount: () => attachCount,
    show: () => {
      visible = true;
      events.emit("show");
    },
    hide: () => {
      visible = false;
      events.emit("hide");
    },
    minimize: () => {
      minimized = true;
      events.emit("minimize");
    },
    restore: () => {
      minimized = false;
      events.emit("restore");
    },
  };
};

/** Reads `count` events from one backend's subscription. */
const takeEvents = (host: DesktopBrowserHost.DesktopBrowserHost["Service"], count: number) =>
  host.events.pipe(
    Stream.take(count),
    Stream.runCollect,
    Effect.map((lines) => lines.map((line) => decodeEvent(new TextDecoder().decode(line)))),
  );

describe("DesktopBrowserHost", () => {
  it.effect("withdraws a popup whose debugger is lost without closing its native window", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make.pipe(
        Effect.provide(DesktopClientSettings.layerTest()),
      );
      const remoteKey = { ...key, desktopHostId: "remote-a" };
      const events = yield* Queue.unbounded<{
        desktopHostId: string;
        event: DesktopBrowserEvent;
      }>();
      yield* host.remoteEvents.pipe(
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkScoped({ startImmediately: true }),
      );
      host.attach(remoteKey, makeDebuggee().tab, "runtime-a");
      yield* Queue.take(events);
      const popup = makePopup(false);
      host.registerPopup(remoteKey, popup.window);
      const created = (yield* Queue.take(events)).event;
      if (created.type !== "popupCreated") throw new Error("Missing popup registration.");
      const boundKey = { threadId: key.threadId, tabId: "child-tab" };
      yield* host.handleRemoteCommand({
        desktopHostId: "remote-a",
        command: {
          type: "bindPopup",
          ...boundKey,
          openerTabId: key.tabId,
          popupId: created.popupId,
        },
      });
      yield* Queue.take(events);
      yield* host.handleRemoteCommand({
        desktopHostId: "remote-a",
        command: {
          type: "surface",
          ...boundKey,
          requestId: "capture",
          leaseId: "capture",
          action: "acquire",
        },
      });
      yield* Queue.take(events);
      popup.contents.debugger.detach();
      expect((yield* Queue.take(events)).event).toEqual({
        type: "popupClosed",
        ...key,
        popupId: created.popupId,
      });
      expect((yield* Queue.take(events)).event).toEqual({ type: "detached", ...boundKey });
      expect(popup.window.isDestroyed()).toBe(false);
      expect(popup.contents.throttleChanges).toEqual([false, true]);
      yield* host.handleRemoteCommand({ desktopHostId: "remote-a", command: { type: "announce" } });
      expect((yield* Queue.take(events)).event).toMatchObject({ type: "attached", ...key });
      yield* host.handleRemoteCommand({
        desktopHostId: "remote-a",
        command: {
          type: "surface",
          ...boundKey,
          requestId: "after-detach",
          leaseId: "capture",
          action: "acquire",
        },
      });
      expect((yield* Queue.take(events)).event).toMatchObject({
        type: "surfaceReady",
        requestId: "after-detach",
        viewport: null,
        reason: "guest-unavailable",
      });
    }),
  );

  it.effect(
    "binds an actual popup once, samples its own visibility, and retains it across reconnect",
    () =>
      Effect.gen(function* () {
        const host = yield* DesktopBrowserHost.make.pipe(
          Effect.provide(DesktopClientSettings.layerTest()),
        );
        const events = yield* Queue.unbounded<{
          desktopHostId: string;
          event: typeof DesktopBrowserEvent.Type;
        }>();
        yield* host.remoteEvents.pipe(
          Stream.runForEach((event) => Queue.offer(events, event)),
          Effect.forkScoped({ startImmediately: true }),
        );
        const remoteKey = { ...key, desktopHostId: "remote-a" };
        host.attach(remoteKey, makeDebuggee().tab, "runtime-a");
        yield* Queue.take(events);
        const popup = makePopup(false);
        host.registerPopup(remoteKey, popup.window);
        const created = (yield* Queue.take(events)).event;
        expect(created).toMatchObject({
          type: "popupCreated",
          ...key,
          url: "https://popup.example/",
        });
        if (created.type !== "popupCreated") throw new Error("Missing popup registration.");
        host.registerPopup(remoteKey, popup.window);
        expect(popup.attachCount()).toBe(1);
        const boundKey = { threadId: key.threadId, tabId: "child-tab" };
        const bind = {
          type: "bindPopup" as const,
          ...boundKey,
          openerTabId: key.tabId,
          popupId: created.popupId,
        };
        yield* host.handleRemoteCommand({ desktopHostId: "remote-a", command: bind });
        expect((yield* Queue.take(events)).event).toEqual({
          type: "attached",
          ...boundKey,
          supportsNativeSurface: true,
        });
        yield* host.handleRemoteCommand({ desktopHostId: "remote-a", command: bind });
        expect(popup.attachCount()).toBe(1);
        yield* host.handleRemoteCommand({
          desktopHostId: "remote-a",
          command: {
            type: "cdp",
            ...boundKey,
            message: encodeJson({ id: 1, method: "Target.getTargets" }),
          },
        });
        const reply = (yield* Queue.take(events)).event;
        expect(reply.type).toBe("cdp");
        if (reply.type !== "cdp") throw new Error("Missing popup CDP response.");
        expect(decodeCdpTargetsReply(reply.message)).toEqual({
          id: 1,
          result: { targetInfos: [{ targetId: "CHILD", url: "https://popup.example/" }] },
        });
        host.setMainWindow(makePresentationWindow().window);
        host.setPresentation({ runtimeTabId: `popup:${created.popupId}`, presented: true }, 77);
        yield* host.handleRemoteCommand({
          desktopHostId: "remote-a",
          command: {
            type: "surface",
            ...boundKey,
            requestId: "capture",
            leaseId: "capture",
            action: "acquire",
          },
        });
        expect((yield* Queue.take(events)).event).toEqual({
          type: "surfaceReady",
          ...boundKey,
          requestId: "capture",
          viewport: { width: 640, height: 480 },
        });
        expect(popup.contents.throttleChanges).toEqual([false]);
        yield* host.handleRemoteCommand({
          desktopHostId: "remote-a",
          command: {
            type: "surface",
            ...boundKey,
            requestId: "capture-2",
            leaseId: "capture-2",
            action: "acquire",
          },
        });
        expect((yield* Queue.take(events)).event).toMatchObject({
          type: "surfaceReady",
          requestId: "capture-2",
        });
        yield* host.handleRemoteCommand({
          desktopHostId: "remote-a",
          command: {
            type: "surface",
            ...boundKey,
            requestId: "release-1",
            leaseId: "capture",
            action: "release",
          },
        });
        expect((yield* Queue.take(events)).event).toMatchObject({
          type: "surfaceReady",
          requestId: "release-1",
        });
        expect(popup.contents.throttleChanges).toEqual([false]);
        popup.show();
        expect((yield* Queue.take(events)).event).toMatchObject({
          ...boundKey,
          type: "presentation",
          presented: true,
        });
        popup.hide();
        expect((yield* Queue.take(events)).event).toMatchObject({ ...boundKey, presented: false });
        popup.show();
        expect((yield* Queue.take(events)).event).toMatchObject({ presented: true });
        popup.minimize();
        expect((yield* Queue.take(events)).event).toMatchObject({ presented: false });
        popup.restore();
        expect((yield* Queue.take(events)).event).toMatchObject({ presented: true });
        yield* host.handleRemoteCommand({
          desktopHostId: "remote-a",
          command: { type: "release", ...boundKey },
        });
        expect(popup.contents.throttleChanges).toEqual([false, true]);
        expect(popup.window.isDestroyed()).toBe(false);
        yield* host.handleRemoteCommand({
          desktopHostId: "remote-a",
          command: {
            type: "surface",
            ...boundKey,
            requestId: "disconnect-capture",
            leaseId: "disconnect",
            action: "acquire",
          },
        });
        yield* Queue.take(events);
        yield* host.handleRemoteCommand({
          desktopHostId: "remote-a",
          command: { type: "disconnect" },
        });
        expect(popup.contents.throttleChanges).toEqual([false, true, false, true]);
        yield* host.handleRemoteCommand({
          desktopHostId: "remote-a",
          command: { type: "announce" },
        });
        const announcements = [
          (yield* Queue.take(events)).event,
          (yield* Queue.take(events)).event,
        ];
        expect(announcements).toContainEqual({
          type: "attached",
          ...boundKey,
          supportsNativeSurface: true,
          presented: true,
        });
        expect(popup.attachCount()).toBe(1);
        yield* host.handleRemoteCommand({
          desktopHostId: "remote-a",
          command: { type: "closePopup", ...key, popupId: created.popupId },
        });
        expect((yield* Queue.take(events)).event).toEqual({
          type: "presentation",
          ...boundKey,
          presented: false,
        });
        expect((yield* Queue.take(events)).event).toEqual({
          type: "popupClosed",
          ...key,
          popupId: created.popupId,
        });
        expect((yield* Queue.take(events)).event).toEqual({ type: "detached", ...boundKey });
      }),
  );

  it.effect(
    "rejects foreign popup owners and existing debugger attachments, and reannounces unbound children",
    () =>
      Effect.gen(function* () {
        const host = yield* DesktopBrowserHost.make.pipe(
          Effect.provide(DesktopClientSettings.layerTest()),
        );
        const remoteKey = { ...key, desktopHostId: "remote-a" };
        const events = yield* Queue.unbounded<{
          desktopHostId: string;
          event: typeof DesktopBrowserEvent.Type;
        }>();
        yield* host.remoteEvents.pipe(
          Stream.runForEach((event) => Queue.offer(events, event)),
          Effect.forkScoped({ startImmediately: true }),
        );
        host.attach(remoteKey, makeDebuggee().tab, "runtime-a");
        yield* Queue.take(events);
        const taken = makePopup(true, true);
        host.registerPopup(remoteKey, taken.window);
        expect(taken.attachCount()).toBe(0);
        const popup = makePopup();
        host.registerPopup(remoteKey, popup.window);
        const created = (yield* Queue.take(events)).event;
        if (created.type !== "popupCreated") throw new Error("Missing popup registration.");
        for (const owner of ["remote-b", "remote-a"]) {
          yield* host.handleRemoteCommand({
            desktopHostId: owner,
            command: {
              type: "bindPopup",
              threadId: key.threadId,
              tabId: "child-tab",
              openerTabId: owner === "remote-a" ? "wrong-tab" : key.tabId,
              popupId: created.popupId,
            },
          });
          yield* host.handleRemoteCommand({
            desktopHostId: owner,
            command: {
              type: "closePopup",
              threadId: key.threadId,
              tabId: owner === "remote-a" ? "wrong-tab" : key.tabId,
              popupId: created.popupId,
            },
          });
        }
        expect(popup.window.isDestroyed()).toBe(false);
        yield* host.handleRemoteCommand({
          desktopHostId: "remote-a",
          command: { type: "announce" },
        });
        expect((yield* Queue.take(events)).event.type).toBe("attached");
        expect((yield* Queue.take(events)).event).toEqual(created);
        yield* host.handleRemoteCommand({
          desktopHostId: "remote-a",
          command: { type: "closePopup", ...key, popupId: created.popupId },
        });
        expect((yield* Queue.take(events)).event).toEqual({
          type: "popupClosed",
          ...key,
          popupId: created.popupId,
        });
        expect(popup.window.isDestroyed()).toBe(true);
      }),
  );

  it.effect(
    "reports visible slots across late attachment and reconnect without treating capture as visible",
    () =>
      Effect.gen(function* () {
        const host = yield* DesktopBrowserHost.make.pipe(
          Effect.provide(DesktopClientSettings.layerTest()),
        );
        const events = yield* Queue.unbounded<{
          desktopHostId: string;
          event: typeof DesktopBrowserEvent.Type;
        }>();
        yield* host.remoteEvents.pipe(
          Stream.runForEach((event) => Queue.offer(events, event)),
          Effect.forkScoped({ startImmediately: true }),
        );
        const debuggee = makeDebuggee();
        const remoteKey = { ...key, desktopHostId: "remote-a" };
        host.setMainWindow(makePresentationWindow().window);
        host.setPresentation({ runtimeTabId: "runtime-a", presented: true }, 77);
        host.attach(remoteKey, debuggee.tab, "runtime-a");
        expect((yield* Queue.take(events)).event).toMatchObject({
          type: "attached",
          presented: true,
        });
        host.setPresentation({ runtimeTabId: "runtime-a", presented: false }, 78);
        yield* host.handleRemoteCommand({
          desktopHostId: "remote-a",
          command: { type: "announce" },
        });
        expect((yield* Queue.take(events)).event).toMatchObject({
          type: "attached",
          presented: true,
        });
        host.setPresentation({ runtimeTabId: "runtime-a", presented: false }, 77);
        expect((yield* Queue.take(events)).event).toEqual({
          type: "presentation",
          ...key,
          presented: false,
        });
        yield* host.handleRemoteCommand({
          desktopHostId: "remote-a",
          command: {
            type: "surface",
            ...key,
            requestId: "capture",
            leaseId: "qa",
            action: "acquire",
          },
        });
        host.surfaceResponse(
          {
            requestId: debuggee.surfaceRequests[0]!.requestId,
            viewport: { width: 1280, height: 800 },
          },
          77,
        );
        expect((yield* Queue.take(events)).event.type).toBe("surfaceReady");
        yield* host.handleRemoteCommand({
          desktopHostId: "remote-a",
          command: { type: "announce" },
        });
        expect((yield* Queue.take(events)).event).toEqual({
          type: "attached",
          ...key,
          supportsNativeSurface: true,
        });
      }),
  );

  it.effect(
    "native window hide/show controls PiP and main-slot visibility without closing either",
    () =>
      Effect.gen(function* () {
        const host = yield* DesktopBrowserHost.make.pipe(
          Effect.provide(DesktopClientSettings.layerTest()),
        );
        const events = yield* Queue.unbounded<{
          desktopHostId: string;
          event: typeof DesktopBrowserEvent.Type;
        }>();
        yield* host.remoteEvents.pipe(
          Stream.runForEach((event) => Queue.offer(events, event)),
          Effect.forkScoped({ startImmediately: true }),
        );
        const main = makePresentationWindow(false);
        const pip = makePresentationWindow(false);
        host.setMainWindow(main.window);
        host.attach({ ...key, desktopHostId: "remote-a" }, makeDebuggee().tab, "runtime-a");
        expect((yield* Queue.take(events)).event).toMatchObject({ type: "attached" });
        host.setPictureInPictureWindow("runtime-a", pip.window);
        pip.show();
        expect((yield* Queue.take(events)).event).toMatchObject({
          type: "presentation",
          presented: true,
        });
        // macOS Hide hides the windows while keeping the PiP session open.
        pip.hide();
        expect((yield* Queue.take(events)).event).toMatchObject({
          type: "presentation",
          presented: false,
        });
        pip.show();
        expect((yield* Queue.take(events)).event).toMatchObject({ presented: true });
        main.show();
        pip.hide();
        // An open main window with no selected Browser slot is still invisible.
        expect((yield* Queue.take(events)).event).toMatchObject({ presented: false });
        host.setPresentation({ runtimeTabId: "runtime-a", presented: true }, 77);
        expect((yield* Queue.take(events)).event).toMatchObject({ presented: true });
        main.hide();
        expect((yield* Queue.take(events)).event).toMatchObject({ presented: false });
        main.show();
        expect((yield* Queue.take(events)).event).toMatchObject({ presented: true });
        main.minimize();
        expect((yield* Queue.take(events)).event).toMatchObject({ presented: false });
        main.restore();
        expect((yield* Queue.take(events)).event).toMatchObject({ presented: true });
        host.setPictureInPictureWindow("runtime-a", null);
      }),
  );

  it.effect("announces tabs already attached to a backend that starts later", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make.pipe(
        Effect.provide(DesktopClientSettings.layerTest()),
      );
      host.attach(key, makeDebuggee().tab, "runtime-local");
      // A restarted backend subscribes after the attach and still hears it.
      expect(yield* takeEvents(host, 1)).toEqual([
        { type: "attached", ...key, supportsNativeSurface: true },
      ]);
      expect(yield* takeEvents(host, 1)).toEqual([
        { type: "attached", ...key, supportsNativeSurface: true },
      ]);
    }),
  );

  it.effect("drops replies from a relay the server released", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make.pipe(
        Effect.provide(DesktopClientSettings.layerTest()),
      );
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab, "runtime-local");
      const reader = yield* takeEvents(host, 2).pipe(Effect.forkScoped);
      // Wait until the reader has received the announcement.
      yield* Effect.yieldNow;
      const command = (id: number, method: string) =>
        host.handleCommandLine(
          encodeJson({
            type: "cdp",
            ...key,
            message: encodeJson({ id, method, sessionId: "t3-preview-page" }),
          }),
        );
      yield* command(1, "Page.captureScreenshot");
      yield* host.handleCommandLine(encodeJson({ type: "release", ...key }));
      yield* command(2, "DOM.enable");
      debuggee.release();
      yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));
      const [, reply] = yield* Fiber.join(reader);
      // Only the new connection's reply arrives; the old one's id could collide.
      expect(reply).toMatchObject({ type: "cdp" });
      expect(decodeCdpReply((reply as { message: string }).message).id).toBe(2);
    }).pipe(Effect.scoped),
  );

  it.effect("saves a server tab's download under its CDP guid where the server asked", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make.pipe(
        Effect.provide(DesktopClientSettings.layerTest()),
      );
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab, "runtime-local");
      const paths: Array<string> = [];
      const item = {
        setSavePath: (path: string) => void paths.push(path),
      } as unknown as Electron.DownloadItem;
      // Before the server sets a directory, Electron keeps its own handling.
      expect(host.placeDownload(debuggee.tab.webContents, item)).toBe(false);
      yield* host.handleCommandLine(
        encodeJson({
          type: "cdp",
          ...key,
          message: encodeJson({
            id: 1,
            method: "Browser.setDownloadBehavior",
            params: { behavior: "allowAndName", downloadPath: "/srv/downloads" },
          }),
        }),
      );
      debuggee.emit("Browser.downloadWillBegin", { guid: "guid-1", suggestedFilename: "r.csv" });
      expect(host.placeDownload(debuggee.tab.webContents, item)).toBe(true);
      expect(paths).toEqual(["/srv/downloads/guid-1"]);
    }),
  );
});

describe("remote desktop browser host", () => {
  it.effect("isolates native tab commands and announcements by desktop host", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make.pipe(
        Effect.provide(DesktopClientSettings.layerTest()),
      );
      const events = yield* Queue.unbounded<{
        desktopHostId: string;
        event: DesktopBrowserEvent;
      }>();
      yield* host.remoteEvents.pipe(
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkScoped({ startImmediately: true }),
      );
      const pull = yield* Stream.toPull(Stream.fromQueue(events));
      // Start the subscriber immediately, before publishing any native event.
      const remoteKey = { ...key, desktopHostId: "remote-a" };
      host.attach(remoteKey, makeDebuggee().tab, "runtime-remote");
      yield* host.handleRemoteCommand({ desktopHostId: "remote-a", command: { type: "announce" } });
      expect(
        (yield* pull).every(
          (event) =>
            event.desktopHostId === "remote-a" &&
            event.event.type === "attached" &&
            event.event.supportsNativeSurface === true,
        ),
      ).toBe(true);
      // Local FD announcements must never expose a remote environment's tabs.
      host.attach(key, makeDebuggee().tab, "runtime-local");
      expect(yield* takeEvents(host, 1)).toEqual([
        { type: "attached", ...key, supportsNativeSurface: true },
      ]);
      yield* host.handleRemoteCommand({
        desktopHostId: "remote-a",
        command: { type: "profiles", requestId: "profiles-a" },
      });
      const profileEvent = (yield* pull).find((entry) => entry.event.type === "profiles");
      expect(profileEvent).toMatchObject({
        desktopHostId: "remote-a",
        event: {
          type: "profiles",
          requestId: "profiles-a",
          profiles: { defaultProfileId: "default" },
        },
      });
    }).pipe(Effect.scoped),
  );
});

it.effect("transfers native remote downloads as bytes before reporting CDP completion", () =>
  Effect.gen(function* () {
    const host = yield* DesktopBrowserHost.make.pipe(
      Effect.provide(DesktopClientSettings.layerTest()),
    );
    const emitter = new NodeEvents.EventEmitter();
    const debuggee = Object.assign(emitter, {
      sendCommand: async (method: string) =>
        method === "Target.getTargetInfo" ? { targetInfo: { targetId: "GUEST" } } : {},
    });
    const webContents = {
      getURL: () => "https://example.com/",
      getTitle: () => "Download",
      getUserAgent: () => "Electron",
    } as unknown as Electron.WebContents;
    const desktopHostId = "remote-download-host";
    const remoteKey = { ...key, desktopHostId };
    const events = yield* Queue.unbounded<{ desktopHostId: string; event: DesktopBrowserEvent }>();
    yield* host.remoteEvents.pipe(
      Stream.runForEach((event) => Queue.offer(events, event)),
      Effect.forkScoped({ startImmediately: true }),
    );
    const pull = yield* Stream.toPull(Stream.fromQueue(events));
    host.attach(
      remoteKey,
      { webContents, debugger: debuggee as unknown as Electron.Debugger },
      "runtime-remote",
    );
    yield* pull;
    const send = (id: number, method: string, params: Record<string, unknown>) =>
      host.handleRemoteCommand({
        desktopHostId,
        command: { type: "cdp", ...key, message: encodeJson({ id, method, params }) },
      });
    yield* send(1, "Target.setAutoAttach", {});
    const untilReply = (id: number) =>
      Effect.gen(function* () {
        let replied = false;
        while (!replied) {
          for (const { event } of yield* pull) {
            if (event.type === "cdp" && event.message.includes(`"id":${id}`)) replied = true;
          }
        }
      });
    yield* untilReply(1);
    yield* send(2, "Browser.setDownloadBehavior", {
      behavior: "allowAndName",
      downloadPath: "/remote-environment/downloads",
    });
    yield* untilReply(2);
    emitter.emit("message", {}, "Browser.downloadWillBegin", { guid: "download-1" }, "");
    let savePath = "";
    expect(
      host.placeDownload(webContents, {
        setSavePath: (path: string) => {
          savePath = path;
        },
      } as Electron.DownloadItem),
    ).toBe(true);
    expect(savePath.startsWith("/remote-environment/")).toBe(false);
    yield* Effect.promise(() => NodeFSP.writeFile(savePath, Buffer.from([0, 255, 128, 42])));
    emitter.emit(
      "message",
      {},
      "Browser.downloadProgress",
      { guid: "download-1", state: "completed" },
      "",
    );
    const transferred: number[] = [];
    let completed = false;
    while (!completed) {
      for (const { event } of yield* pull) {
        if (event.type === "download") {
          expect(event.offset).toBe(transferred.length);
          transferred.push(...Buffer.from(event.data, "base64"));
        }
        if (event.type === "cdp" && event.message.includes('"state":"completed"')) {
          expect(transferred).toEqual([0, 255, 128, 42]);
          completed = true;
        }
      }
    }
    host.detach(remoteKey);
  }).pipe(Effect.scoped),
);

it.effect("acknowledges the owning renderer's local layout without blocking native commands", () =>
  Effect.gen(function* () {
    const host = yield* DesktopBrowserHost.make.pipe(
      Effect.provide(DesktopClientSettings.layerTest()),
    );
    const debuggee = makeDebuggee();
    host.attach(key, debuggee.tab, "local-runtime-tab");
    const reader = yield* takeEvents(host, 2).pipe(Effect.forkScoped);
    yield* Effect.yieldNow;
    yield* host.handleCommandLine(
      encodeJson({
        type: "surface",
        ...key,
        requestId: "server-acquire",
        leaseId: "lease-1",
        action: "acquire",
      }),
    );
    const request = debuggee.surfaceRequests[0]!;
    expect(request.runtimeTabId).toBe("local-runtime-tab");
    host.surfaceResponse(
      { requestId: request.requestId, viewport: { width: 800, height: 600 } },
      12,
    );
    host.surfaceResponse(
      { requestId: request.requestId, viewport: { width: 800, height: 600 } },
      77,
    );
    expect((yield* Fiber.join(reader))[1]).toEqual({
      type: "surfaceReady",
      ...key,
      requestId: "server-acquire",
      viewport: { width: 800, height: 600 },
    });
    yield* host.handleCommandLine(encodeJson({ type: "release", ...key }));
    expect(debuggee.surfaceRequests.at(-1)).toMatchObject({
      action: "release",
      leaseId: "lease-1",
    });
  }).pipe(Effect.scoped),
);

it.effect(
  "isolates colliding remote request IDs and fences released or replaced surface leases",
  () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make.pipe(
        Effect.provide(DesktopClientSettings.layerTest()),
      );
      const events = yield* Queue.unbounded<{
        desktopHostId: string;
        event: DesktopBrowserEvent;
      }>();
      yield* host.remoteEvents.pipe(
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkScoped({ startImmediately: true }),
      );
      const first = makeDebuggee();
      const second = makeDebuggee();
      const send = (desktopHostId: string, action: "acquire" | "release", leaseId = "lease-1") =>
        host.handleRemoteCommand({
          desktopHostId,
          command: { type: "surface", ...key, requestId: "same-server-request", leaseId, action },
        });
      host.attach({ ...key, desktopHostId: "remote-a" }, first.tab, "runtime-a");
      host.attach({ ...key, desktopHostId: "remote-b" }, second.tab, "runtime-b");
      yield* Queue.take(events);
      yield* Queue.take(events);
      yield* send("remote-a", "acquire");
      yield* send("remote-b", "acquire");
      expect(first.surfaceRequests[0]!.requestId).not.toBe(second.surfaceRequests[0]!.requestId);
      yield* send("remote-a", "release");
      host.surfaceResponse(
        { requestId: first.surfaceRequests[0]!.requestId, viewport: { width: 800, height: 600 } },
        77,
      );
      host.detach({ ...key, desktopHostId: "remote-b" });
      yield* Queue.take(events);
      host.attach({ ...key, desktopHostId: "remote-b" }, second.tab, "runtime-b-next");
      yield* Queue.take(events);
      host.surfaceResponse(
        { requestId: second.surfaceRequests[0]!.requestId, viewport: { width: 800, height: 600 } },
        77,
      );
      yield* send("remote-b", "acquire", "lease-2");
      const newest = second.surfaceRequests.at(-1)!;
      host.surfaceResponse(
        { requestId: newest.requestId, viewport: { width: 1280, height: 800 } },
        77,
      );
      expect(yield* Queue.take(events)).toEqual({
        desktopHostId: "remote-b",
        event: {
          type: "surfaceReady",
          ...key,
          requestId: "same-server-request",
          viewport: { width: 1280, height: 800 },
        },
      });
      yield* host.handleRemoteCommand({
        desktopHostId: "remote-b",
        command: { type: "disconnect" },
      });
      expect(second.surfaceRequests.at(-1)).toMatchObject({
        action: "release",
        leaseId: "lease-2",
      });
      host.surfaceResponse(
        { requestId: first.surfaceRequests.at(-1)!.requestId, viewport: null },
        77,
      );
    }).pipe(Effect.scoped),
);

it.effect("times out renderer readiness and relinquishes the exact activity lease", () =>
  Effect.gen(function* () {
    const host = yield* DesktopBrowserHost.make.pipe(
      Effect.provide(DesktopClientSettings.layerTest()),
    );
    const debuggee = makeDebuggee();
    host.attach(key, debuggee.tab, "runtime-tab");
    const reader = yield* takeEvents(host, 2).pipe(Effect.forkScoped);
    yield* Effect.yieldNow;
    yield* host.handleCommandLine(
      encodeJson({
        type: "surface",
        ...key,
        requestId: "readiness-timeout",
        leaseId: "timeout-lease",
        action: "acquire",
      }),
    );
    yield* TestClock.adjust(2500);
    expect((yield* Fiber.join(reader))[1]).toEqual({
      type: "surfaceReady",
      ...key,
      requestId: "readiness-timeout",
      viewport: null,
      reason: "layout-timeout",
    });
    expect(debuggee.surfaceRequests.at(-1)).toMatchObject({
      action: "release",
      leaseId: "timeout-lease",
    });
  }).pipe(Effect.scoped),
);

it.effect.each(["Page.captureScreenshot", "Page.startScreencast", "Page.stopScreencast"])(
  "bounds stalled %s, preserves long evaluation, and drops the late reply",
  (method) =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make.pipe(
        Effect.provide(DesktopClientSettings.layerTest()),
      );
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab, "runtime-tab");
      const events = yield* Queue.unbounded<DesktopBrowserEvent>();
      yield* host.events.pipe(
        Stream.runForEach((line) =>
          Queue.offer(events, decodeEvent(new TextDecoder().decode(line))),
        ),
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* Queue.take(events);
      const send = (id: number, method: string) =>
        host.handleCommandLine(
          encodeJson({
            type: "cdp",
            ...key,
            message: encodeJson({ id, method, sessionId: "t3-preview-page" }),
          }),
        );
      yield* send(1, method);
      yield* send(2, "Runtime.evaluate");
      yield* TestClock.adjust(8000);
      const timeout = yield* Queue.take(events);
      expect(timeout).toMatchObject({ type: "cdp" });
      expect(JSON.parse((timeout as { message: string }).message)).toMatchObject({
        id: 1,
        error: { message: expect.stringContaining("8000ms deadline") },
      });
      yield* send(3, "DOM.enable");
      debuggee.release();
      const remaining = [yield* Queue.take(events), yield* Queue.take(events)];
      expect(
        remaining.map((event) => JSON.parse((event as { message: string }).message).id),
      ).toEqual([2, 3]);
      yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));
      expect(yield* Queue.size(events)).toBe(0);
    }).pipe(Effect.scoped),
);

it.effect.each(["Page.captureScreenshot", "Page.startScreencast", "Page.stopScreencast"])(
  "settles %s before a short leased deadline and refreshes reused lease budgets",
  (method) =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make.pipe(
        Effect.provide(DesktopClientSettings.layerTest()),
      );
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab, "runtime-tab");
      const events = yield* Queue.unbounded<DesktopBrowserEvent>();
      yield* host.events.pipe(
        Stream.runForEach((line) =>
          Queue.offer(events, decodeEvent(new TextDecoder().decode(line))),
        ),
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* Queue.take(events);
      const acquire = (timeoutMs: number) =>
        host.handleCommandLine(
          encodeJson({
            type: "surface",
            ...key,
            requestId: "short-read",
            leaseId: "short-read-lease",
            action: "acquire",
            timeoutMs,
          }),
        );
      yield* acquire(100);
      const ready = debuggee.surfaceRequests.at(-1)!;
      host.surfaceResponse(
        { requestId: ready.requestId, viewport: { width: 800, height: 600 } },
        77,
      );
      yield* Queue.take(events);
      const send = (id: number, method: string) =>
        host.handleCommandLine(
          encodeJson({
            type: "cdp",
            ...key,
            message: encodeJson({ id, method, sessionId: "t3-preview-page" }),
          }),
        );
      yield* send(1, method);
      yield* send(2, "Runtime.evaluate");
      yield* TestClock.adjust(90);
      const failed = yield* Queue.take(events);
      expect(JSON.parse((failed as { message: string }).message)).toMatchObject({
        id: 1,
        error: { message: expect.stringContaining("90ms deadline") },
      });
      // Reusing a lease replaces its old budget; the previous deadline must not poison later capture.
      yield* acquire(1000);
      const reacquired = debuggee.surfaceRequests.at(-1)!;
      host.surfaceResponse(
        { requestId: reacquired.requestId, viewport: { width: 800, height: 600 } },
        77,
      );
      yield* Queue.take(events);
      yield* send(3, method);
      yield* TestClock.adjust(20);
      debuggee.release();
      const remaining = [yield* Queue.take(events), yield* Queue.take(events)];
      expect(
        remaining.map((event) => JSON.parse((event as { message: string }).message).id),
      ).toEqual([2, 3]);
      yield* host.handleCommandLine(encodeJson({ type: "release", ...key }));
      yield* send(4, method);
      yield* TestClock.adjust(110);
      debuggee.release();
      const unrestricted = yield* Queue.take(events);
      expect(JSON.parse((unrestricted as { message: string }).message)).toMatchObject({
        id: 4,
        result: { method },
      });
    }).pipe(Effect.scoped),
);

it.effect(
  "retains an indefinite recording surface beyond eight seconds while each capture remains bounded",
  () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make.pipe(
        Effect.provide(DesktopClientSettings.layerTest()),
      );
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab, "runtime-recording");
      const events = yield* Queue.unbounded<DesktopBrowserEvent>();
      yield* host.events.pipe(
        Stream.runForEach((line) =>
          Queue.offer(events, decodeEvent(new TextDecoder().decode(line))),
        ),
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* Queue.take(events);
      yield* host.handleCommandLine(
        encodeJson({
          type: "surface",
          ...key,
          requestId: "recording-start",
          leaseId: "recording-lease",
          action: "acquire",
        }),
      );
      const ready = debuggee.surfaceRequests.at(-1)!;
      host.surfaceResponse(
        { requestId: ready.requestId, viewport: { width: 800, height: 600 } },
        77,
      );
      yield* Queue.take(events);
      yield* TestClock.adjust(9000);
      expect(debuggee.surfaceRequests.at(-1)!.action).toBe("acquire");
      yield* host.handleCommandLine(
        encodeJson({
          type: "cdp",
          ...key,
          message: encodeJson({
            id: 1,
            method: "Page.captureScreenshot",
            sessionId: "t3-preview-page",
          }),
        }),
      );
      yield* TestClock.adjust(8000);
      const failed = yield* Queue.take(events);
      expect(JSON.parse((failed as { message: string }).message)).toMatchObject({
        id: 1,
        error: { message: expect.stringContaining("8000ms deadline") },
      });
      expect(debuggee.surfaceRequests.at(-1)!.action).toBe("acquire");
      yield* host.handleCommandLine(
        encodeJson({
          type: "surface",
          ...key,
          requestId: "recording-stop",
          leaseId: "recording-lease",
          action: "release",
        }),
      );
      const stopped = debuggee.surfaceRequests.at(-1)!;
      expect(stopped).toMatchObject({ action: "release", leaseId: "recording-lease" });
      host.surfaceResponse({ requestId: stopped.requestId, viewport: null }, 77);
      expect(yield* Queue.take(events)).toMatchObject({
        type: "surfaceReady",
        requestId: "recording-stop",
      });
    }).pipe(Effect.scoped),
);

it.effect("shares host rendering between tabs and restores each exact prior throttle policy", () =>
  Effect.gen(function* () {
    const host = yield* DesktopBrowserHost.make.pipe(
      Effect.provide(DesktopClientSettings.layerTest()),
    );
    const first = makeDebuggee();
    const second = makeDebuggee();
    second.webContents.hostWebContents = first.hostContents;
    second.webContents.setBackgroundThrottling(false);
    second.webContents.throttleChanges.length = 0;
    const secondKey = { ...key, tabId: "tab-2" };
    host.attach(key, first.tab, "runtime-1");
    host.attach(secondKey, second.tab, "runtime-2");
    const surface = (tabKey: typeof key, action: "acquire" | "release", leaseId: string) =>
      host.handleCommandLine(
        encodeJson({ type: "surface", ...tabKey, requestId: leaseId + action, leaseId, action }),
      );
    yield* surface(key, "acquire", "lease-1");
    yield* surface(secondKey, "acquire", "lease-2");
    expect(first.hostContents.throttleChanges).toEqual([false]);
    expect(first.webContents.throttleChanges).toEqual([false]);
    expect(second.webContents.throttleChanges).toEqual([false]);
    yield* surface(key, "release", "lease-1");
    expect(first.hostContents.getBackgroundThrottling()).toBe(false);
    expect(first.webContents.getBackgroundThrottling()).toBe(true);
    yield* surface(secondKey, "release", "lease-2");
    expect(first.hostContents.throttleChanges).toEqual([false, true]);
    expect(second.webContents.throttleChanges).toEqual([false, false]);
    host.detach(key);
    host.detach(secondKey);
  }).pipe(Effect.scoped),
);

it.effect(
  "defers the preview manager's throttle restoration until automation releases host and guest",
  () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make.pipe(
        Effect.provide(DesktopClientSettings.layerTest()),
      );
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab, "runtime-tab");
      yield* host.handleCommandLine(
        encodeJson({
          type: "surface",
          ...key,
          requestId: "acquire",
          leaseId: "lease",
          action: "acquire",
        }),
      );
      host.setBackgroundThrottling(debuggee.hostContents as unknown as Electron.WebContents, false);
      host.setBackgroundThrottling(debuggee.tab.webContents, false);
      // Recording stops while automation still needs host requestAnimationFrame and guest compositing.
      host.setBackgroundThrottling(debuggee.hostContents as unknown as Electron.WebContents, true);
      host.setBackgroundThrottling(debuggee.tab.webContents, true);
      expect(debuggee.hostContents.getBackgroundThrottling()).toBe(false);
      expect(debuggee.webContents.getBackgroundThrottling()).toBe(false);
      yield* host.handleCommandLine(encodeJson({ type: "release", ...key }));
      expect(debuggee.hostContents.getBackgroundThrottling()).toBe(true);
      expect(debuggee.webContents.getBackgroundThrottling()).toBe(true);
      // A recording started during automation must remain unthrottled after automation finishes.
      yield* host.handleCommandLine(
        encodeJson({
          type: "surface",
          ...key,
          requestId: "acquire-2",
          leaseId: "lease-2",
          action: "acquire",
        }),
      );
      host.setBackgroundThrottling(debuggee.hostContents as unknown as Electron.WebContents, false);
      host.setBackgroundThrottling(debuggee.tab.webContents, false);
      yield* host.handleCommandLine(encodeJson({ type: "release", ...key }));
      expect(debuggee.hostContents.getBackgroundThrottling()).toBe(false);
      expect(debuggee.webContents.getBackgroundThrottling()).toBe(false);
      host.detach(key);
    }).pipe(Effect.scoped),
);

it.effect("cleans host rendering after a missing guest and refuses unavailable acquires", () =>
  Effect.gen(function* () {
    const host = yield* DesktopBrowserHost.make.pipe(
      Effect.provide(DesktopClientSettings.layerTest()),
    );
    const debuggee = makeDebuggee();
    host.attach(key, debuggee.tab, "runtime-tab");
    const events = yield* Queue.unbounded<DesktopBrowserEvent>();
    yield* host.events.pipe(
      Stream.runForEach((line) => Queue.offer(events, decodeEvent(new TextDecoder().decode(line)))),
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* Queue.take(events);
    yield* host.handleCommandLine(
      encodeJson({
        type: "surface",
        ...key,
        requestId: "acquire",
        leaseId: "lease",
        action: "acquire",
      }),
    );
    debuggee.webContents.destroy();
    host.detach(key);
    expect(debuggee.hostContents.getBackgroundThrottling()).toBe(true);
    expect(debuggee.webContents.throttleChanges).toEqual([false]);
    yield* Queue.take(events);
    host.attach(key, debuggee.tab, "runtime-tab-next");
    yield* Queue.take(events);
    yield* host.handleCommandLine(
      encodeJson({
        type: "surface",
        ...key,
        requestId: "missing-guest",
        leaseId: "lease-next",
        action: "acquire",
      }),
    );
    expect(yield* Queue.take(events)).toMatchObject({
      type: "surfaceReady",
      requestId: "missing-guest",
      reason: "guest-unavailable",
    });
    expect(debuggee.hostContents.throttleChanges).toEqual([false, true]);
  }).pipe(Effect.scoped),
);
