import * as Queue from "effect/Queue";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
// @effect-diagnostics nodeBuiltinImport:off - Stands in for an Electron debugger.
import { describe, expect, it } from "@effect/vitest";
import { DesktopBrowserEvent, type DesktopBrowserSurfaceRequest } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";

import * as DesktopBrowserHost from "./DesktopBrowserHost.ts";
import { resolvePartitionScope } from "./BrowserProfileScope.ts";

const profileResolver = (environmentId: string) => (profileId: string) =>
  Effect.succeed(resolvePartitionScope(environmentId, profileId, "primary-environment"));

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
  let destroyed = false;
  const window = Object.assign(events, {
    isDestroyed: () => destroyed,
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
    close: () => {
      destroyed = true;
      events.emit("closed");
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
  let closeCount = 0;
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
      closeCount += 1;
      destroyed = true;
      events.emit("closed");
    },
  });
  return {
    window: window as unknown as Electron.BrowserWindow,
    contents,
    attachCount: () => attachCount,
    closeCount: () => closeCount,
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

const makeRoot = () => {
  const root = makePopup(false);
  let size = [390, 844];
  Object.assign(root.window, {
    isFocused: () => false,
    isFocusable: () => false,
    loadURL: async () => undefined,
    setContentSize: (width: number, height: number) => {
      size = [width, height];
    },
    getContentSize: () => size,
    destroy: root.window.close,
  });
  let zoomFactor = 1;
  const contents = Object.assign(root.contents, {
    setWindowOpenHandler: () => undefined,
    setZoomFactor: (value: number) => {
      zoomFactor = value;
    },
    getZoomFactor: () => zoomFactor,
  });
  return { ...root, contents };
};

/** Observes actual attempt retirement without adding a production diagnostics API. */
const observeCreationRecords = (marker: string) =>
  Effect.gen(function* () {
    const settlements: string[] = [];
    let awaiting: ((value: string) => void) | undefined;
    const settled = Effect.callback<string>((resume) => {
      const value = settlements.shift();
      if (value !== undefined) {
        resume(Effect.succeed(value));
        return;
      }
      const notify = (value: string) => resume(Effect.succeed(value));
      awaiting = notify;
      return Effect.sync(() => {
        if (awaiting === notify) awaiting = undefined;
      });
    });
    const pendingMaps = new Set<Map<unknown, unknown>>();
    const cancellationSets = new Set<Set<unknown>>();
    const deleting: string[] = [];
    const set = Map.prototype.set;
    const deleteMap = Map.prototype.delete;
    const add = Set.prototype.add;
    const deleteSet = Set.prototype.delete;
    const matches = (value: unknown): value is string =>
      typeof value === "string" && value.startsWith("[") && value.includes(marker);
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        // eslint-disable-next-line no-extend-native -- Scoped collection observation, restored on exit.
        Map.prototype.set = function (this: Map<unknown, unknown>, key: unknown, value: unknown) {
          if (matches(key)) pendingMaps.add(this);
          return set.call(this, key, value);
        };
        // eslint-disable-next-line no-extend-native -- Observe the creation finalizer's pending deletion.
        Map.prototype.delete = function (this: Map<unknown, unknown>, key: unknown) {
          const deleted = deleteMap.call(this, key);
          if (deleted && pendingMaps.has(this) && matches(key)) deleting.push(key);
          return deleted;
        };
        // eslint-disable-next-line no-extend-native -- Observe cancellation records only for this fixture.
        Set.prototype.add = function (this: Set<unknown>, value: unknown) {
          if (matches(value)) cancellationSets.add(this);
          return add.call(this, value);
        };
        // eslint-disable-next-line no-extend-native -- The final cancellation deletion marks settlement.
        Set.prototype.delete = function (this: Set<unknown>, value: unknown) {
          const deleted = deleteSet.call(this, value);
          if (matches(value)) {
            const index = deleting.indexOf(value);
            if (index !== -1) {
              deleting.splice(index, 1);
              if (awaiting) {
                const notify = awaiting;
                awaiting = undefined;
                notify(value);
              } else settlements.push(value);
            }
          }
          return deleted;
        };
      }),
      () =>
        Effect.sync(() => {
          // eslint-disable-next-line no-extend-native -- Restore all original collection methods.
          Map.prototype.set = set;
          // eslint-disable-next-line no-extend-native -- Restore all original collection methods.
          Map.prototype.delete = deleteMap;
          // eslint-disable-next-line no-extend-native -- Restore all original collection methods.
          Set.prototype.add = add;
          // eslint-disable-next-line no-extend-native -- Restore all original collection methods.
          Set.prototype.delete = deleteSet;
        }),
    );
    return {
      pending: () => [...pendingMaps].flatMap((records) => [...records.keys()].filter(matches)),
      canceled: () => [...cancellationSets].flatMap((records) => [...records].filter(matches)),
      settled,
    };
  });

it.effect.each(["local", "remote"] as const)(
  "%s serial transport handles profiles, existing-tab CDP and cancellation during root creation",
  (transport) =>
    Effect.gen(function* () {
      const marker = `serial-root-${transport}`;
      const records = yield* observeCreationRecords(marker);
      const host = yield* DesktopBrowserHost.make.pipe(
        Effect.provide(DesktopClientSettings.layerTest()),
      );
      const desktopHostId = transport === "local" ? "local" : "host-a";
      const events = yield* Queue.unbounded<DesktopBrowserEvent>();
      yield* (
        transport === "local"
          ? host.events.pipe(Stream.map((line) => decodeEvent(new TextDecoder().decode(line))))
          : host.remoteEvents.pipe(Stream.map(({ event }) => event))
      ).pipe(
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* host.bindEnvironment(desktopHostId, "environment-a", profileResolver("environment-a"));
      const debuggee = makeDebuggee();
      debuggee.tab.debugger.sendCommand = async (method) => ({ method });
      host.attach({ ...key, desktopHostId }, debuggee.tab, "existing-runtime");
      expect((yield* Queue.take(events)).type).toBe("attached");
      const entered = yield* Deferred.make<void>();
      const returned = yield* Deferred.make<Electron.BrowserWindow>();
      const factorySettled = yield* Deferred.make<void>();
      const root = makeRoot();
      host.setRootFactory(() =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(returned)),
          Effect.ensuring(Deferred.succeed(factorySettled, undefined)),
        ),
      );
      type Command = Parameters<typeof host.handleRemoteCommand>[0]["command"];
      const commands = yield* Queue.unbounded<Command>();
      const input = Stream.fromQueue(commands).pipe(Stream.take(4));
      // Match each production transport's sequential command consumer.
      const consumer = yield* (
        transport === "local"
          ? input.pipe(Stream.runForEach((command) => host.handleCommandLine(encodeJson(command))))
          : input.pipe(
              Stream.mapEffect((command) => host.handleRemoteCommand({ desktopHostId, command })),
              Stream.runDrain,
            )
      ).pipe(Effect.forkScoped({ startImmediately: true }));
      const attempt = { ...key, tabId: "slow-root", requestId: marker, profileId: "default" };
      yield* Queue.offer(commands, {
        type: "createRoot",
        ...attempt,
        serverEpoch: "epoch-a",
        url: "about:blank",
      });
      yield* Deferred.await(entered);
      expect(records.pending()).toHaveLength(1);
      yield* Queue.offer(commands, { type: "profiles", requestId: "profiles" });
      yield* Queue.offer(commands, {
        type: "cdp",
        ...key,
        message: encodeJson({
          id: 1,
          method: "Page.getLayoutMetrics",
          sessionId: "t3-preview-page",
        }),
      });
      yield* Queue.offer(commands, { type: "cancelRootCreation", ...attempt });
      const replies = [
        yield* Queue.take(events),
        yield* Queue.take(events),
        yield* Queue.take(events),
      ];
      expect(replies.find((event) => event.type === "profiles")).toMatchObject({
        requestId: "profiles",
        supportsNativeRoots: true,
      });
      const cdp = replies.find((event) => event.type === "cdp");
      if (cdp?.type !== "cdp") throw new Error("Expected existing-tab CDP reply");
      expect(decodeCdpReply(cdp.message).id).toBe(1);
      expect(replies.find((event) => event.type === "rootCreated")).toMatchObject({
        ...attempt,
        rootId: null,
      });
      yield* Fiber.join(consumer);
      expect(yield* Deferred.isDone(factorySettled)).toBe(false);
      expect(root.window.isDestroyed()).toBe(false);
      expect(records.pending()).toHaveLength(1);
      expect(records.canceled()).toHaveLength(1);
      yield* Deferred.succeed(returned, root.window);
      yield* Deferred.await(factorySettled);
      yield* records.settled;
      expect(root.window.isDestroyed()).toBe(true);
      expect(root.attachCount()).toBe(0);
      expect(records.pending()).toHaveLength(0);
      expect(records.canceled()).toHaveLength(0);
      expect(yield* Queue.size(events)).toBe(0);
    }),
);

it.effect.each([
  ["epoch-a", true],
  ["epoch-b", true],
  ["epoch-a", false],
] as const)(
  "reconciles an in-flight root against owner epoch and inventory %s before its factory returns",
  ([serverEpoch, retained]) =>
    Effect.gen(function* () {
      const survives = serverEpoch === "epoch-a" && retained;
      const marker = `pending-epoch-${serverEpoch}-${retained}`;
      const records = yield* observeCreationRecords(marker);
      const host = yield* DesktopBrowserHost.make.pipe(
        Effect.provide(DesktopClientSettings.layerTest()),
      );
      const main = makePresentationWindow();
      host.setMainWindow(main.window);
      const events = yield* Queue.unbounded<DesktopBrowserEvent>();
      yield* host.remoteEvents.pipe(
        Stream.runForEach(({ event }) => Queue.offer(events, event)),
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* host.bindEnvironment("host-a", "environment-a", profileResolver("environment-a"));
      const entered = yield* Deferred.make<void>();
      const returned = yield* Deferred.make<Electron.BrowserWindow>();
      const root = makeRoot();
      host.setRootFactory(() =>
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(returned))),
      );
      yield* host.handleRemoteCommand({
        desktopHostId: "host-a",
        command: {
          type: "createRoot",
          ...key,
          serverEpoch: "epoch-a",
          requestId: marker,
          profileId: "default",
          url: "about:blank",
        },
      });
      yield* Deferred.await(entered);
      // Another desktop's restart cannot cancel this pending window.
      yield* host.handleRemoteCommand({
        desktopHostId: "host-b",
        command: { type: "reconcileRoots", serverEpoch: "epoch-b", retainedRootRequestIds: [] },
      });
      expect(records.canceled()).toHaveLength(0);
      yield* host.handleRemoteCommand({
        desktopHostId: "host-a",
        command: {
          type: "reconcileRoots",
          serverEpoch,
          retainedRootRequestIds: retained ? [marker] : [],
        },
      });
      expect(records.pending()).toHaveLength(1);
      expect(records.canceled()).toHaveLength(survives ? 0 : 1);
      expect(main.window.isDestroyed()).toBe(false);
      yield* Deferred.succeed(returned, root.window);
      yield* records.settled;
      expect(records.pending()).toHaveLength(0);
      expect(records.canceled()).toHaveLength(0);
      expect(root.window.isDestroyed()).toBe(!survives);
      expect(root.attachCount()).toBe(survives ? 1 : 0);
      if (survives) {
        expect((yield* Queue.take(events)).type).toBe("attached");
        expect(yield* Queue.take(events)).toMatchObject({
          type: "rootCreated",
          requestId: marker,
          rootId: expect.any(String),
        });
      }
      expect(yield* Queue.size(events)).toBe(0);
    }),
);

it.effect(
  "keeps native root profile/environment ownership fixed across simultaneous transports",
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
      const created: Array<{ environmentId: string; profileId: string }> = [];
      const windows: Array<ReturnType<typeof makeRoot>> = [];
      host.setRootFactory((input) =>
        Effect.sync(() => {
          created.push({ environmentId: input.environmentId, profileId: input.profileId });
          const root = makeRoot();
          windows.push(root);
          return root.window;
        }),
      );
      for (const [desktopHostId, environmentId] of [
        ["host-a", "environment-a"],
        ["host-b", "environment-b"],
      ]) {
        yield* host.bindEnvironment(
          desktopHostId!,
          environmentId!,
          profileResolver(environmentId!),
        );
        yield* host.handleRemoteCommand({
          desktopHostId: desktopHostId!,
          command: {
            type: "createRoot",
            serverEpoch: "server-epoch-a",
            ...key,
            requestId: "create",
            profileId: "default",
            url: "https://fixture.example/",
          },
        });
        expect((yield* Queue.take(events)).event.type).toBe("attached");
        const acknowledged = yield* Queue.take(events);
        expect(acknowledged.desktopHostId).toBe(desktopHostId);
        expect(acknowledged.event.type).toBe("rootCreated");
        if (acknowledged.event.type !== "rootCreated") throw new Error("Expected root identity");
        expect(acknowledged.event.rootId).not.toBeNull();
        const rootId = acknowledged.event.rootId!;
        yield* host.handleRemoteCommand({
          desktopHostId: desktopHostId!,
          command: {
            type: "createRoot",
            serverEpoch: "server-epoch-a",
            ...key,
            requestId: "create",
            profileId: "default",
            url: "https://fixture.example/",
          },
        });
        expect((yield* Queue.take(events)).event).toMatchObject({ type: "rootCreated", rootId });
        yield* host.handleRemoteCommand({
          desktopHostId: desktopHostId!,
          command: {
            type: "createRoot",
            serverEpoch: "server-epoch-a",
            ...key,
            requestId: "retry",
            profileId: "default",
            url: "https://fixture.example/",
          },
        });
        expect((yield* Queue.take(events)).event).toMatchObject({
          type: "rootCreated",
          rootId: null,
        });
        yield* host.handleRemoteCommand({
          desktopHostId: desktopHostId!,
          command: { type: "cancelRootCreation", ...key, requestId: "retry", profileId: "default" },
        });
        expect((yield* Queue.take(events)).event).toMatchObject({
          type: "rootCreated",
          rootId: null,
        });
        expect(windows.at(-1)!.window.isDestroyed()).toBe(false);
        const rebound = yield* host
          .bindEnvironment(
            desktopHostId!,
            "another-environment",
            profileResolver("another-environment"),
          )
          .pipe(Effect.flip);
        expect(rebound.reason).toBe("host-unavailable");
      }
      expect(created).toEqual([
        { environmentId: "environment-a", profileId: "default" },
        { environmentId: "environment-b", profileId: "default" },
      ]);
      expect(windows).toHaveLength(2);
    }),
);

it.effect("discards a published offline root only for its exact desktop, tab and identity", () =>
  Effect.gen(function* () {
    const host = yield* DesktopBrowserHost.make.pipe(
      Effect.provide(DesktopClientSettings.layerTest()),
    );
    const events = yield* Queue.unbounded<DesktopBrowserEvent>();
    yield* host.remoteEvents.pipe(
      Stream.runForEach(({ event }) => Queue.offer(events, event)),
      Effect.forkScoped({ startImmediately: true }),
    );
    const root = makeRoot();
    host.setRootFactory(() => Effect.succeed(root.window));
    yield* host.bindEnvironment("host-a", "environment-a", profileResolver("environment-a"));
    const send = (
      command: Parameters<typeof host.handleRemoteCommand>[0]["command"],
      desktopHostId = "host-a",
    ) => host.handleRemoteCommand({ desktopHostId, command });
    yield* send({
      type: "createRoot",
      serverEpoch: "server-epoch-a",
      ...key,
      requestId: "create",
      profileId: "default",
      url: "about:blank",
    });
    yield* Queue.take(events);
    const created = yield* Queue.take(events);
    if (created.type !== "rootCreated" || created.rootId === null) throw new Error("Expected root");
    const attempt = { ...key, rootId: created.rootId, requestId: "create", profileId: "default" };
    yield* send({ type: "acceptRoot", ...attempt });
    yield* Queue.take(events);
    yield* send({ type: "publishRoot", ...attempt });
    yield* send({ type: "discardRoot", ...key, rootId: created.rootId }, "host-b");
    yield* send({ type: "discardRoot", ...key, tabId: "other-tab", rootId: created.rootId });
    yield* send({ type: "discardRoot", ...key, rootId: "other-root" });
    expect(root.window.isDestroyed()).toBe(false);
    // A disconnected tab's explicit retirement is destruction, not a vetoable close.
    root.window.close = () => undefined;
    yield* send({ type: "discardRoot", ...key, rootId: created.rootId });
    expect(root.window.isDestroyed()).toBe(true);
    expect(root.closeCount()).toBe(1);
  }),
);

it.effect(
  "cancels only its in-flight root creation without announcing or retaining a late window",
  () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make.pipe(
        Effect.provide(DesktopClientSettings.layerTest()),
      );
      const events = yield* Queue.unbounded<DesktopBrowserEvent>();
      yield* host.remoteEvents.pipe(
        Stream.runForEach(({ event }) => Queue.offer(events, event)),
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* host.bindEnvironment("host-a", "environment-a", profileResolver("environment-a"));
      const entered = yield* Deferred.make<void>();
      const created = yield* Deferred.make<Electron.BrowserWindow>();
      host.setRootFactory(() =>
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(created))),
      );
      const root = makeRoot();
      const closed = Promise.withResolvers<void>();
      root.window.once("closed", () => closed.resolve());
      yield* host.handleRemoteCommand({
        desktopHostId: "host-a",
        command: {
          type: "createRoot",
          serverEpoch: "server-epoch-a",
          ...key,
          requestId: "create",
          profileId: "default",
          url: "https://fixture.example/",
        },
      });
      yield* Deferred.await(entered);
      yield* host.handleRemoteCommand({
        desktopHostId: "host-a",
        command: { type: "cancelRootCreation", ...key, requestId: "create", profileId: "default" },
      });
      expect(yield* Queue.take(events)).toMatchObject({ type: "rootCreated", rootId: null });
      yield* Deferred.succeed(created, root.window);
      yield* Effect.promise(() => closed.promise);
      expect(root.window.isDestroyed()).toBe(true);
      expect(root.attachCount()).toBe(0);
      expect(yield* Queue.size(events)).toBe(0);
    }),
);

it.effect(
  "retires cancellation records after late creation settles or a completed root is destroyed",
  () =>
    Effect.gen(function* () {
      const marker = "cancellation-retirement";
      const records = yield* observeCreationRecords(marker);
      const host = yield* DesktopBrowserHost.make.pipe(
        Effect.provide(DesktopClientSettings.layerTest()),
      );
      yield* host.bindEnvironment("host-a", "environment-a", profileResolver("environment-a"));
      const events = yield* Queue.unbounded<DesktopBrowserEvent>();
      yield* host.remoteEvents.pipe(
        Stream.runForEach(({ event }) => Queue.offer(events, event)),
        Effect.forkScoped({ startImmediately: true }),
      );
      const send = (command: Parameters<typeof host.handleRemoteCommand>[0]["command"]) =>
        host.handleRemoteCommand({ desktopHostId: "host-a", command });
      for (const [index, mode] of ["cancel", "disconnect"].entries()) {
        const entered = yield* Deferred.make<void>();
        const returned = yield* Deferred.make<Electron.BrowserWindow>();
        const root = makeRoot();
        host.setRootFactory(() =>
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(returned))),
        );
        const attempt = { ...key, requestId: `${marker}-${index}`, profileId: "default" };
        yield* send({
          type: "createRoot",
          ...attempt,
          serverEpoch: "epoch-a",
          url: "about:blank",
        });
        yield* Deferred.await(entered);
        yield* send(
          mode === "cancel" ? { type: "cancelRootCreation", ...attempt } : { type: "disconnect" },
        );
        if (mode === "cancel") yield* Queue.take(events);
        expect(records.pending()).toHaveLength(1);
        expect(records.canceled()).toHaveLength(1);
        yield* Deferred.succeed(returned, root.window);
        yield* records.settled;
        expect(root.window.isDestroyed()).toBe(true);
        expect(root.attachCount()).toBe(0);
        expect(records.pending()).toHaveLength(0);
        expect(records.canceled()).toHaveLength(0);
        // A repeated cancellation acknowledgment has no late creation left to guard.
        yield* send({ type: "cancelRootCreation", ...attempt });
        yield* Queue.take(events);
        expect(records.canceled()).toHaveLength(0);
      }
      for (const mode of ["cancel", "disconnect"]) {
        const root = makeRoot();
        const attempt = { ...key, requestId: `${marker}-${mode}-completed`, profileId: "default" };
        host.setRootFactory(() => Effect.succeed(root.window));
        yield* send({ type: "createRoot", ...attempt, serverEpoch: "epoch-a", url: "about:blank" });
        expect((yield* Queue.take(events)).type).toBe("attached");
        expect((yield* Queue.take(events)).type).toBe("rootCreated");
        yield* records.settled;
        yield* send(
          mode === "cancel" ? { type: "cancelRootCreation", ...attempt } : { type: "disconnect" },
        );
        expect((yield* Queue.take(events)).type).toBe("detached");
        expect((yield* Queue.take(events)).type).toBe("rootClosed");
        if (mode === "cancel") yield* Queue.take(events);
        expect(root.window.isDestroyed()).toBe(true);
        expect(records.pending()).toHaveLength(0);
        expect(records.canceled()).toHaveLength(0);
      }
    }),
);

it.effect.each(["created", "accepted", "published"] as const)(
  "disconnect and stale creation cancellation respect native root ownership (%s)",
  (stage) =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make.pipe(
        Effect.provide(DesktopClientSettings.layerTest()),
      );
      const events = yield* Queue.unbounded<DesktopBrowserEvent>();
      yield* host.remoteEvents.pipe(
        Stream.runForEach(({ event }) => Queue.offer(events, event)),
        Effect.forkScoped({ startImmediately: true }),
      );
      const root = makeRoot();
      host.setRootFactory(() => Effect.succeed(root.window));
      yield* host.bindEnvironment("host-a", "environment-a", profileResolver("environment-a"));
      const send = (command: Parameters<typeof host.handleRemoteCommand>[0]["command"]) =>
        host.handleRemoteCommand({ desktopHostId: "host-a", command });
      yield* send({
        type: "createRoot",
        serverEpoch: "server-epoch-a",
        ...key,
        requestId: "create",
        profileId: "default",
        url: "about:blank",
      });
      yield* Queue.take(events);
      const created = yield* Queue.take(events);
      if (created.type !== "rootCreated" || created.rootId === null)
        throw new Error("Expected root");
      const attempt = { ...key, rootId: created.rootId, requestId: "create", profileId: "default" };
      yield* send({ type: "acceptRoot", ...attempt, profileId: "different-profile" });
      expect(yield* Queue.take(events)).toMatchObject({ type: "rootAccepted", accepted: false });
      if (stage !== "created") {
        yield* send({ type: "acceptRoot", ...attempt });
        expect(yield* Queue.take(events)).toMatchObject({ type: "rootAccepted", accepted: true });
      }
      if (stage === "published") yield* send({ type: "publishRoot", ...attempt });
      yield* send({ type: "disconnect" });
      expect(root.window.isDestroyed()).toBe(stage === "created");
      if (stage !== "created") {
        yield* send({ type: "announce" });
        expect(yield* Queue.take(events)).toMatchObject({
          type: "attached",
          ...key,
          supportsNativeSurface: true,
        });
        yield* send({
          type: "reconcileRoots",
          serverEpoch: "server-epoch-a",
          retainedRootRequestIds: ["create"],
        });
        expect(root.window.isDestroyed()).toBe(false);
      }
      yield* send({
        type: "cancelRootCreation",
        ...key,
        requestId: "create",
        profileId: "default",
      });
      expect(root.window.isDestroyed()).toBe(stage !== "published");
      if (stage === "published") {
        yield* send({ type: "acceptRoot", ...attempt });
        expect(yield* Queue.take(events)).toMatchObject({ type: "rootAccepted", accepted: true });
      }
    }),
);

it.effect(
  "same-epoch reconnect destroys omitted roots and preserves retained and foreign roots",
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
      const roots: Array<ReturnType<typeof makeRoot>> = [];
      host.setRootFactory(() =>
        Effect.sync(() => {
          const root = makeRoot();
          roots.push(root);
          return root.window;
        }),
      );
      const definitions = [
        { desktopHostId: "host-a", tabId: "discarded", requestId: "discarded-request" },
        { desktopHostId: "host-a", tabId: "retained", requestId: "retained-request" },
        { desktopHostId: "host-b", tabId: "foreign", requestId: "discarded-request" },
      ];
      for (const { desktopHostId, tabId, requestId } of definitions) {
        yield* host.bindEnvironment(desktopHostId, desktopHostId, profileResolver(desktopHostId));
        const send = (command: Parameters<typeof host.handleRemoteCommand>[0]["command"]) =>
          host.handleRemoteCommand({ desktopHostId, command });
        yield* send({
          type: "createRoot",
          ...key,
          tabId,
          requestId,
          profileId: "default",
          serverEpoch: "same-epoch",
          url: "about:blank",
        });
        yield* Queue.take(events);
        const created = (yield* Queue.take(events)).event;
        if (created.type !== "rootCreated" || created.rootId === null)
          throw new Error("Expected native root");
        const attempt = { ...key, tabId, requestId, rootId: created.rootId, profileId: "default" };
        yield* send({ type: "acceptRoot", ...attempt });
        yield* Queue.take(events);
        yield* send({ type: "publishRoot", ...attempt });
        yield* send({ type: "disconnect" });
      }
      yield* TestClock.adjust("365 days");
      yield* host.handleRemoteCommand({
        desktopHostId: "host-a",
        command: {
          type: "reconcileRoots",
          serverEpoch: "same-epoch",
          retainedRootRequestIds: ["retained-request"],
        },
      });
      expect(roots.map((root) => root.window.isDestroyed())).toEqual([true, false, false]);
      expect((yield* Queue.take(events)).event).toMatchObject({
        type: "detached",
        tabId: "discarded",
      });
      expect(yield* Queue.take(events)).toMatchObject({
        desktopHostId: "host-a",
        event: { type: "rootClosed", tabId: "discarded" },
      });
      expect(yield* Queue.size(events)).toBe(0);
    }),
);

it.effect.each(["host-a", "host-b"])(
  "a new owner epoch destroys stale roots only on that host (%s)",
  (restartedHost) =>
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
      const windows = new Map<string, ReturnType<typeof makeRoot>>();
      const identities = new Map<string, string>();
      host.setRootFactory(({ environmentId }) =>
        Effect.sync(() => {
          const root = makeRoot();
          windows.set(environmentId, root);
          return root.window;
        }),
      );
      for (const desktopHostId of ["host-a", "host-b"]) {
        yield* host.bindEnvironment(desktopHostId, desktopHostId, profileResolver(desktopHostId));
        const send = (command: Parameters<typeof host.handleRemoteCommand>[0]["command"]) =>
          host.handleRemoteCommand({ desktopHostId, command });
        yield* send({
          type: "createRoot",
          ...key,
          serverEpoch: `epoch:${desktopHostId}`,
          requestId: "create",
          profileId: "default",
          url: "about:blank",
        });
        yield* Queue.take(events);
        const created = (yield* Queue.take(events)).event;
        if (created.type !== "rootCreated" || created.rootId === null)
          throw new Error("Expected root");
        identities.set(desktopHostId, created.rootId);
        const attempt = {
          ...key,
          rootId: created.rootId,
          requestId: "create",
          profileId: "default",
        };
        yield* send({ type: "acceptRoot", ...attempt });
        yield* Queue.take(events);
        yield* send({ type: "publishRoot", ...attempt });
        yield* send({ type: "disconnect" });
        yield* send({ type: "announce" });
        expect((yield* Queue.take(events)).event.type).toBe("attached");
        yield* send({
          type: "reconcileRoots",
          serverEpoch: `epoch:${desktopHostId}`,
          retainedRootRequestIds: ["create"],
        });
        expect(windows.get(desktopHostId)!.window.isDestroyed()).toBe(false);
      }
      yield* host.handleRemoteCommand({
        desktopHostId: restartedHost,
        command: {
          type: "reconcileRoots",
          serverEpoch: "replacement-server-epoch",
          retainedRootRequestIds: [],
        },
      });
      expect((yield* Queue.take(events)).event.type).toBe("detached");
      expect(yield* Queue.take(events)).toEqual({
        desktopHostId: restartedHost,
        event: { type: "rootClosed", ...key, rootId: identities.get(restartedHost)! },
      });
      for (const [desktopHostId, root] of windows)
        expect(root.window.isDestroyed()).toBe(desktopHostId === restartedHost);
      yield* host.handleRemoteCommand({
        desktopHostId: restartedHost,
        command: { type: "announce" },
      });
      expect(yield* Queue.size(events)).toBe(0);
    }),
);

it.effect("root presence survives transport disconnect and detects an ordinary lost close", () =>
  Effect.gen(function* () {
    const host = yield* DesktopBrowserHost.make.pipe(
      Effect.provide(DesktopClientSettings.layerTest()),
    );
    const events = yield* Queue.unbounded<DesktopBrowserEvent>();
    yield* host.remoteEvents.pipe(
      Stream.runForEach(({ event }) => Queue.offer(events, event)),
      Effect.forkScoped({ startImmediately: true }),
    );
    const root = makeRoot();
    host.setRootFactory(() => Effect.succeed(root.window));
    yield* host.bindEnvironment("host-a", "environment-a", profileResolver("environment-a"));
    const send = (command: Parameters<typeof host.handleRemoteCommand>[0]["command"]) =>
      host.handleRemoteCommand({ desktopHostId: "host-a", command });
    yield* send({
      type: "createRoot",
      ...key,
      serverEpoch: "server-epoch-a",
      requestId: "create",
      profileId: "default",
      url: "about:blank",
    });
    yield* Queue.take(events);
    const created = yield* Queue.take(events);
    if (created.type !== "rootCreated" || created.rootId === null) throw new Error("Expected root");
    const attempt = { ...key, rootId: created.rootId, requestId: "create", profileId: "default" };
    yield* send({ type: "acceptRoot", ...attempt });
    yield* Queue.take(events);
    yield* send({ type: "publishRoot", ...attempt });
    yield* send({ type: "disconnect" });
    const probe = {
      type: "probeRoot" as const,
      ...key,
      rootId: created.rootId,
      requestId: "probe",
    };
    yield* host.handleRemoteCommand({ desktopHostId: "other-host", command: probe });
    yield* send({ ...probe, threadId: "other-thread" });
    yield* send({ ...probe, tabId: "other-tab" });
    expect(yield* Queue.size(events)).toBe(0);
    yield* send(probe);
    expect(yield* Queue.take(events)).toEqual({
      type: "rootPresence",
      ...key,
      rootId: created.rootId,
      requestId: "probe",
      present: true,
    });
    expect(root.closeCount()).toBe(0);
    root.window.close();
    expect((yield* Queue.take(events)).type).toBe("detached");
    expect((yield* Queue.take(events)).type).toBe("rootClosed");
    yield* send({ ...probe, requestId: "after-offline-close" });
    expect(yield* Queue.take(events)).toEqual({
      type: "rootPresence",
      ...key,
      rootId: created.rootId,
      requestId: "after-offline-close",
      present: false,
    });
    expect(root.closeCount()).toBe(1);
  }),
);

it.effect("main-window closure destroys published automation roots and their children only", () =>
  Effect.gen(function* () {
    const host = yield* DesktopBrowserHost.make.pipe(
      Effect.provide(DesktopClientSettings.layerTest()),
    );
    const events = yield* Queue.unbounded<DesktopBrowserEvent>();
    yield* host.remoteEvents.pipe(
      Stream.runForEach(({ event }) => Queue.offer(events, event)),
      Effect.forkScoped({ startImmediately: true }),
    );
    const main = makePresentationWindow();
    host.setMainWindow(main.window);
    const root = makeRoot();
    host.setRootFactory(() => Effect.succeed(root.window));
    yield* host.bindEnvironment("host-a", "environment-a", profileResolver("environment-a"));
    const send = (command: Parameters<typeof host.handleRemoteCommand>[0]["command"]) =>
      host.handleRemoteCommand({ desktopHostId: "host-a", command });
    yield* send({
      type: "createRoot",
      ...key,
      serverEpoch: "server-epoch-a",
      requestId: "create",
      profileId: "default",
      url: "about:blank",
    });
    yield* Queue.take(events);
    const created = yield* Queue.take(events);
    if (created.type !== "rootCreated" || created.rootId === null) throw new Error("Expected root");
    const attempt = { ...key, rootId: created.rootId, requestId: "create", profileId: "default" };
    yield* send({ type: "acceptRoot", ...attempt });
    yield* Queue.take(events);
    yield* send({ type: "publishRoot", ...attempt });
    const child = makeRoot();
    Object.assign(child.contents, { setIgnoreMenuShortcuts: () => undefined });
    root.contents.emit("did-create-window", child.window);
    expect((yield* Queue.take(events)).type).toBe("popupCreated");
    const sharedKey = { ...key, tabId: "human-tab", desktopHostId: "host-a" };
    host.attach(sharedKey, makeDebuggee().tab, "human-runtime");
    yield* Queue.take(events);
    const humanPopup = makePopup();
    host.registerPopup(sharedKey, humanPopup.window);
    yield* Queue.take(events);

    main.hide();
    main.minimize();
    main.restore();
    yield* send({ type: "disconnect" });
    expect(root.window.isDestroyed()).toBe(false);
    expect(child.window.isDestroyed()).toBe(false);
    main.close();
    expect(root.window.isDestroyed()).toBe(true);
    expect(child.window.isDestroyed()).toBe(true);
    expect(humanPopup.window.isDestroyed()).toBe(false);
    const closed = [
      yield* Queue.take(events),
      yield* Queue.take(events),
      yield* Queue.take(events),
    ];
    expect(closed.map((event) => event.type).sort()).toEqual([
      "detached",
      "popupClosed",
      "rootClosed",
    ]);
    // A child delivered after owner closure is destroyed before registration.
    const lateChild = makeRoot();
    root.contents.emit("did-create-window", lateChild.window);
    expect(lateChild.window.isDestroyed()).toBe(true);
    expect(lateChild.attachCount()).toBe(0);
  }),
);

it.effect.each(["factory", "navigation"] as const)(
  "main-window closure discards in-flight %s and queued root creations across replacement",
  (stage) =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make.pipe(
        Effect.provide(DesktopClientSettings.layerTest()),
      );
      const events = yield* Queue.unbounded<DesktopBrowserEvent>();
      yield* host.remoteEvents.pipe(
        Stream.runForEach(({ event }) => Queue.offer(events, event)),
        Effect.forkScoped({ startImmediately: true }),
      );
      const main = makePresentationWindow();
      host.setMainWindow(main.window);
      yield* host.bindEnvironment("host-a", "environment-a", profileResolver("environment-a"));
      const entered = yield* Deferred.make<void>();
      const returned = yield* Deferred.make<Electron.BrowserWindow>();
      const loadEntered = Promise.withResolvers<void>();
      const loadCompleted = Promise.withResolvers<void>();
      const root = makeRoot();
      let factoryCalls = 0;
      let loads = 0;
      Object.assign(root.window, {
        loadURL: () => {
          loads += 1;
          loadEntered.resolve();
          return loadCompleted.promise;
        },
      });
      host.setRootFactory(() => {
        factoryCalls += 1;
        return stage === "factory"
          ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(returned)))
          : Effect.succeed(root.window);
      });
      const create = (tabId: string) =>
        host.handleRemoteCommand({
          desktopHostId: "host-a",
          command: {
            type: "createRoot",
            ...key,
            tabId,
            serverEpoch: "server-epoch-a",
            requestId: `create-${tabId}`,
            profileId: "default",
            url: "about:blank",
          },
        });
      yield* create("first");
      yield* stage === "factory"
        ? Deferred.await(entered)
        : Effect.promise(() => loadEntered.promise);
      yield* create("queued");
      main.close();
      host.setMainWindow(makePresentationWindow().window);
      yield* Deferred.succeed(returned, root.window);
      loadCompleted.resolve();
      for (let index = 0; index < 2; index += 1)
        expect(yield* Queue.take(events)).toMatchObject({
          type: "rootCreated",
          rootId: null,
          reason: "guest-unavailable",
        });
      expect(root.window.isDestroyed()).toBe(true);
      expect(root.attachCount()).toBe(0);
      expect(factoryCalls).toBe(1);
      expect(loads).toBe(stage === "factory" ? 0 : 1);
    }),
);

it.effect(
  "native root leases apply fill size and native zoom while preserving fixed settings and release",
  () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make.pipe(
        Effect.provide(DesktopClientSettings.layerTest()),
      );
      const events = yield* Queue.unbounded<DesktopBrowserEvent>();
      yield* host.remoteEvents.pipe(
        Stream.runForEach(({ event }) => Queue.offer(events, event)),
        Effect.forkScoped({ startImmediately: true }),
      );
      const root = makeRoot();
      host.setRootFactory(() => Effect.succeed(root.window));
      yield* host.bindEnvironment("host-a", "environment-a", profileResolver("environment-a"));
      const send = (command: Parameters<typeof host.handleRemoteCommand>[0]["command"]) =>
        host.handleRemoteCommand({ desktopHostId: "host-a", command });
      yield* send({
        type: "createRoot",
        ...key,
        serverEpoch: "epoch-a",
        requestId: "create",
        profileId: "default",
        url: "about:blank",
      });
      yield* Queue.take(events);
      yield* Queue.take(events);
      const render = {
        type: "surface" as const,
        ...key,
        requestId: "render",
        leaseId: "viewer",
        action: "acquire" as const,
        viewport: { _tag: "fill" as const },
        viewportSize: { width: 720, height: 480 },
        zoomFactor: 1.25 as const,
      };
      yield* send(render);
      expect(yield* Queue.take(events)).toMatchObject({
        type: "surfaceReady",
        viewport: { width: 720, height: 480 },
      });
      expect(root.window.getContentSize()).toEqual([720, 480]);
      expect(root.contents.getZoomFactor()).toBe(1.25);
      expect(root.window.isVisible()).toBe(false);
      expect(root.window.isFocused()).toBe(false);
      yield* send({
        ...render,
        action: "release",
        viewportSize: { width: 999, height: 999 },
        zoomFactor: 0.5,
      });
      yield* Queue.take(events);
      expect(root.window.getContentSize()).toEqual([720, 480]);
      expect(root.contents.getZoomFactor()).toBe(1.25);
      yield* send({
        ...render,
        viewport: { _tag: "freeform", width: 390, height: 844 },
        zoomFactor: 1,
      });
      expect(yield* Queue.take(events)).toMatchObject({
        type: "surfaceReady",
        viewport: { width: 390, height: 844 },
      });
      expect(root.contents.getZoomFactor()).toBe(1);
    }),
);

it.effect("disconnect retires pending native creation before its factory returns", () =>
  Effect.gen(function* () {
    const host = yield* DesktopBrowserHost.make.pipe(
      Effect.provide(DesktopClientSettings.layerTest()),
    );
    const entered = yield* Deferred.make<void>();
    const returned = yield* Deferred.make<Electron.BrowserWindow>();
    const root = makeRoot();
    const closed = Promise.withResolvers<void>();
    root.window.once("closed", () => closed.resolve());
    host.setRootFactory(() =>
      Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(returned))),
    );
    yield* host.bindEnvironment("host-a", "environment-a", profileResolver("environment-a"));
    yield* host.handleRemoteCommand({
      desktopHostId: "host-a",
      command: {
        type: "createRoot",
        serverEpoch: "server-epoch-a",
        ...key,
        requestId: "create",
        profileId: "default",
        url: "about:blank",
      },
    });
    yield* Deferred.await(entered);
    yield* host.handleRemoteCommand({ desktopHostId: "host-a", command: { type: "disconnect" } });
    yield* Deferred.succeed(returned, root.window);
    yield* Effect.promise(() => closed.promise);
    expect(root.window.isDestroyed()).toBe(true);
    expect(root.attachCount()).toBe(0);
  }),
);

it.effect.each(["Input.insertText", "Input.dispatchKeyEvent"])(
  "relays remote viewer keyboard input to its shared guest (%s)",
  (method) =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make.pipe(
        Effect.provide(DesktopClientSettings.layerTest()),
      );
      const events = yield* Queue.unbounded<DesktopBrowserEvent>();
      yield* host.remoteEvents.pipe(
        Stream.runForEach(({ event }) => Queue.offer(events, event)),
        Effect.forkScoped({ startImmediately: true }),
      );
      const debuggee = makeDebuggee();
      const commands: Array<{ method: string; params: unknown; sessionId: string | undefined }> =
        [];
      debuggee.tab.debugger.sendCommand = async (method, params, sessionId) => {
        commands.push({ method, params, sessionId });
        return { method };
      };
      host.attach({ ...key, desktopHostId: "host-a" }, debuggee.tab, "shared-guest");
      yield* Queue.take(events);
      const params =
        method === "Input.insertText" ? { text: "viewer text" } : { type: "keyDown", key: "a" };
      yield* host.handleRemoteCommand({
        desktopHostId: "host-a",
        command: {
          type: "cdp",
          ...key,
          message: JSON.stringify({ id: 1, method, sessionId: "t3-preview-page", params }),
        },
      });
      const event = yield* Queue.take(events);
      if (event.type !== "cdp") throw new Error("Expected keyboard response");
      expect(JSON.parse(event.message)).toMatchObject({ id: 1, result: { method } });
      expect(commands).toEqual([{ method, params, sessionId: undefined }]);
    }),
);

it.effect.each(["window", "unload"] as const)(
  "reports a canceled native popup close and leaves its window live (%s)",
  (veto) =>
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
      const source = { ...key, desktopHostId: "remote-a" };
      host.attach(source, makeDebuggee().tab, "source-runtime");
      yield* Queue.take(events);
      const popup = makePopup(false);
      host.registerPopup(source, popup.window);
      const created = (yield* Queue.take(events)).event;
      if (created.type !== "popupCreated") throw new Error("Expected native popup.");
      const actualClose = popup.window.close;
      popup.window.close = () => {
        if (veto === "unload")
          popup.contents.emit("will-prevent-unload", { defaultPrevented: false });
        else popup.window.emit("close", { defaultPrevented: true });
      };
      const close = {
        type: "closePopup" as const,
        requestId: "close-veto",
        ...key,
        popupId: created.popupId,
      };
      yield* host.handleRemoteCommand({ desktopHostId: "remote-a", command: close });
      expect((yield* Queue.take(events)).event).toEqual({
        type: "popupCloseCanceled",
        requestId: close.requestId,
        ...key,
        popupId: created.popupId,
      });
      expect(popup.window.isDestroyed()).toBe(false);
      popup.window.close = actualClose;
      yield* host.handleRemoteCommand({
        desktopHostId: "remote-a",
        command: { ...close, requestId: "close-final" },
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
  "replays a lost close cancellation after reconnect without closing the user's retained window",
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
      const source = { ...key, desktopHostId: "remote-a" };
      host.attach(source, makeDebuggee().tab, "source-runtime");
      yield* Queue.take(events);
      const popup = makePopup(false);
      host.registerPopup(source, popup.window);
      const created = (yield* Queue.take(events)).event;
      if (created.type !== "popupCreated") throw new Error("Expected native popup.");
      const close = {
        type: "closePopup" as const,
        requestId: "close-kept-window",
        ...key,
        popupId: created.popupId,
      };
      const actualClose = popup.window.close;
      let closeCalls = 0;
      popup.window.close = () => {
        closeCalls += 1;
      };
      yield* host.handleRemoteCommand({ desktopHostId: "remote-a", command: close });
      yield* host.handleRemoteCommand({ desktopHostId: "remote-a", command: close });
      expect(closeCalls).toBe(1);
      yield* host.handleRemoteCommand({
        desktopHostId: "remote-a",
        command: { type: "disconnect" },
      });
      popup.contents.emit("will-prevent-unload", { defaultPrevented: false });
      // This event never reaches the disconnected server.
      expect((yield* Queue.take(events)).event).toEqual({
        type: "popupCloseCanceled",
        ...key,
        popupId: created.popupId,
        requestId: close.requestId,
      });
      popup.window.close = () => {
        closeCalls += 1;
        actualClose();
      };
      yield* host.handleRemoteCommand({ desktopHostId: "remote-a", command: { type: "announce" } });
      expect((yield* Queue.take(events)).event).toMatchObject({ type: "attached", ...key });
      expect((yield* Queue.take(events)).event).toEqual(created);
      yield* host.handleRemoteCommand({
        desktopHostId: "remote-a",
        command: {
          type: "probePopup",
          ...key,
          popupId: created.popupId,
          requestId: "kept-window-presence",
        },
      });
      expect((yield* Queue.take(events)).event).toEqual({
        type: "popupPresence",
        ...key,
        popupId: created.popupId,
        requestId: "kept-window-presence",
        present: true,
      });
      for (const foreign of [
        { desktopHostId: "remote-b", tabId: key.tabId, threadId: key.threadId },
        { desktopHostId: "remote-a", tabId: "foreign-tab", threadId: key.threadId },
        { desktopHostId: "remote-a", tabId: key.tabId, threadId: "foreign-thread" },
      ]) {
        const { desktopHostId, ...foreignKey } = foreign;
        yield* host.handleRemoteCommand({ desktopHostId, command: { ...close, ...foreignKey } });
        yield* host.handleRemoteCommand({
          desktopHostId,
          command: { ...close, ...foreignKey, requestId: "foreign-new-close" },
        });
      }
      yield* host.handleRemoteCommand({ desktopHostId: "remote-a", command: close });
      expect((yield* Queue.take(events)).event).toEqual({
        type: "popupCloseCanceled",
        ...key,
        popupId: created.popupId,
        requestId: close.requestId,
      });
      expect(closeCalls).toBe(1);
      expect(popup.window.isDestroyed()).toBe(false);
      yield* host.handleRemoteCommand({
        desktopHostId: "remote-a",
        command: { ...close, requestId: "deliberate-fresh-close" },
      });
      expect((yield* Queue.take(events)).event).toEqual({
        type: "popupClosed",
        ...key,
        popupId: created.popupId,
      });
      expect(closeCalls).toBe(2);
      expect(popup.window.isDestroyed()).toBe(true);
    }),
);

/** Reads `count` events from one backend's subscription. */
const takeEvents = (host: DesktopBrowserHost.DesktopBrowserHost["Service"], count: number) =>
  host.events.pipe(
    Stream.take(count),
    Stream.runCollect,
    Effect.map((lines) => lines.map((line) => decodeEvent(new TextDecoder().decode(line)))),
  );

describe("DesktopBrowserHost", () => {
  it.effect.each(["unbound", "bound"] as const)(
    "probes an actual hidden %s popup before its reconnect announcement without changing it",
    (binding) =>
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
        const source = { ...key, desktopHostId: "remote-a" };
        host.attach(source, makeDebuggee().tab, "source-runtime");
        yield* Queue.take(events);
        const popup = makePopup(false);
        host.registerPopup(source, popup.window);
        const created = (yield* Queue.take(events)).event;
        if (created.type !== "popupCreated") throw new Error("Expected native popup.");
        if (binding === "bound") {
          yield* host.handleRemoteCommand({
            desktopHostId: "remote-a",
            command: {
              type: "bindPopup",
              threadId: key.threadId,
              tabId: "child-tab",
              openerTabId: key.tabId,
              popupId: created.popupId,
            },
          });
          yield* Queue.take(events);
        }
        yield* host.handleRemoteCommand({
          desktopHostId: "remote-a",
          command: { type: "disconnect" },
        });
        const probe = {
          type: "probePopup" as const,
          ...key,
          popupId: created.popupId,
          requestId: "before-announcement",
        };
        for (const foreign of [
          { desktopHostId: "remote-b", tabId: key.tabId, threadId: key.threadId },
          { desktopHostId: "remote-a", tabId: "foreign-tab", threadId: key.threadId },
          { desktopHostId: "remote-a", tabId: key.tabId, threadId: "foreign-thread" },
        ]) {
          const { desktopHostId, ...foreignKey } = foreign;
          yield* host.handleRemoteCommand({
            desktopHostId,
            command: { ...probe, ...foreignKey, requestId: "foreign-probe" },
          });
        }
        yield* host.handleRemoteCommand({ desktopHostId: "remote-a", command: probe });
        expect(yield* Queue.take(events)).toEqual({
          desktopHostId: "remote-a",
          event: {
            type: "popupPresence",
            ...key,
            popupId: created.popupId,
            requestId: probe.requestId,
            present: true,
          },
        });
        expect(popup.window.isDestroyed()).toBe(false);
        expect(popup.window.isVisible()).toBe(false);
        expect(popup.closeCount()).toBe(0);
        expect(popup.attachCount()).toBe(1);
        yield* host.handleRemoteCommand({
          desktopHostId: "remote-a",
          command: { type: "announce" },
        });
        expect((yield* Queue.take(events)).event).toMatchObject({ type: "attached", ...key });
        if (binding === "bound")
          expect((yield* Queue.take(events)).event).toMatchObject({
            type: "attached",
            tabId: "child-tab",
          });
        expect((yield* Queue.take(events)).event).toEqual({
          ...created,
          ...(binding === "bound" ? { boundTabId: "child-tab" } : {}),
        });
        yield* host.handleRemoteCommand({
          desktopHostId: "remote-a",
          command: { ...probe, requestId: "after-announcement" },
        });
        expect((yield* Queue.take(events)).event).toMatchObject({
          type: "popupPresence",
          requestId: "after-announcement",
          present: true,
        });
        expect(popup.closeCount()).toBe(0);
        expect(popup.attachCount()).toBe(1);
      }),
  );

  it.effect.each(["closed", "withdrawn"] as const)(
    "probes a %s popup as absent without closing or reattaching any window",
    (withdrawal) =>
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
        host.attach({ ...key, desktopHostId: "remote-a" }, makeDebuggee().tab, "source-runtime");
        yield* Queue.take(events);
        const popup = makePopup(false);
        host.registerPopup({ ...key, desktopHostId: "remote-a" }, popup.window);
        const created = (yield* Queue.take(events)).event;
        if (created.type !== "popupCreated") throw new Error("Expected native popup.");
        yield* host.handleRemoteCommand({
          desktopHostId: "remote-a",
          command: { type: "disconnect" },
        });
        if (withdrawal === "closed") popup.window.close();
        else popup.contents.debugger.detach();
        // The ordinary native close/withdrawal notification was lost offline.
        expect((yield* Queue.take(events)).event).toMatchObject({ type: "popupClosed" });
        const closesBeforeProbe = popup.closeCount();
        for (const popupId of [created.popupId, "unknown-popup"]) {
          const requestId = `presence:${popupId}`;
          yield* host.handleRemoteCommand({
            desktopHostId: "remote-a",
            command: { type: "probePopup", ...key, popupId, requestId },
          });
          expect((yield* Queue.take(events)).event).toEqual({
            type: "popupPresence",
            ...key,
            popupId,
            requestId,
            present: false,
          });
        }
        expect(popup.closeCount()).toBe(closesBeforeProbe);
        expect(popup.attachCount()).toBe(1);
        expect(popup.window.isDestroyed()).toBe(withdrawal === "closed");
      }),
  );

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
        expect((yield* Queue.take(events)).event).toEqual({
          ...created,
          boundTabId: boundKey.tabId,
        });
        expect(popup.attachCount()).toBe(1);
        yield* host.handleRemoteCommand({
          desktopHostId: "remote-a",
          command: {
            type: "closePopup",
            requestId: "close-popup",
            ...key,
            popupId: created.popupId,
          },
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
              requestId: "close-foreign",
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
          command: {
            type: "closePopup",
            requestId: "close-popup",
            ...key,
            popupId: created.popupId,
          },
        });
        expect((yield* Queue.take(events)).event).toEqual({
          type: "popupClosed",
          ...key,
          popupId: created.popupId,
        });
        expect(popup.window.isDestroyed()).toBe(true);
        // Its first close acknowledgement may have been sent while disconnected.
        // A retry confirms absence without recreating a window or debugger.
        yield* host.handleRemoteCommand({
          desktopHostId: "remote-a",
          command: {
            type: "closePopup",
            requestId: "close-popup",
            ...key,
            popupId: created.popupId,
          },
        });
        expect((yield* Queue.take(events)).event).toEqual({
          type: "popupClosed",
          ...key,
          popupId: created.popupId,
        });
        expect(popup.attachCount()).toBe(1);
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

  it.effect("tells a download the person clicked from one the agent's input started", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make.pipe(
        Effect.provide(DesktopClientSettings.layerTest()),
      );
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab, "runtime-download");
      // Reading the page is not acting on it.
      yield* host.handleCommandLine(
        encodeJson({
          type: "cdp",
          ...key,
          message: encodeJson({ id: 1, method: "DOM.getDocument", params: {} }),
        }),
      );
      expect(host.humanStartedDownload(debuggee.tab.webContents)).toBe(true);
      yield* host.handleCommandLine(
        encodeJson({
          type: "cdp",
          ...key,
          message: encodeJson({
            id: 2,
            method: "Input.dispatchMouseEvent",
            params: { type: "mousePressed", x: 1, y: 1 },
          }),
        }),
      );
      expect(host.humanStartedDownload(debuggee.tab.webContents)).toBe(false);
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
          supportsNativeRoots: true,
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
