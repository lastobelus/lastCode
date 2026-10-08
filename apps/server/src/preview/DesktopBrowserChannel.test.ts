import type { DesktopBrowserCommand } from "@t3tools/contracts";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
// @effect-diagnostics nodeBuiltinImport:off - The channel reads real file descriptors.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as DesktopBrowserChannel from "./DesktopBrowserChannel.ts";

const key = { threadId: "thread-1", tabId: "tab-1" };

/** The channel over two files: what the desktop sent, and where commands go. */
const channelOver = (events: ReadonlyArray<Record<string, unknown>>) =>
  Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(
      Effect.sync(() =>
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-desktop-browser-channel-")),
      ),
      (directory) => Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
    );
    const inbound = NodePath.join(directory, "events.ndjson");
    NodeFS.writeFileSync(inbound, events.map((event) => `${JSON.stringify(event)}\n`).join(""));
    const control = yield* Effect.acquireRelease(
      Effect.sync(() => NodeFS.openSync(NodePath.join(directory, "commands.ndjson"), "w")),
      (fd) => Effect.sync(() => NodeFS.closeSync(fd)),
    );
    const base = yield* ServerConfig.ServerConfig.pipe(
      Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-desktop-browser-" })),
    );
    const config = Layer.succeed(ServerConfig.ServerConfig, {
      ...base,
      desktopBrowserFd: NodeFS.openSync(inbound, "r"),
      desktopBrowserControlFd: control,
    });
    // Built in the caller's scope, so the channel outlives this setup.
    const context = yield* Layer.build(DesktopBrowserChannel.layer.pipe(Layer.provide(config)));
    return Context.get(context, DesktopBrowserChannel.DesktopBrowserChannel);
  });

it.layer(NodeServices.layer)("DesktopBrowserChannel", (it) => {
  it.effect("refuses an endpoint for a tab that is no longer attached", () =>
    Effect.gen(function* () {
      const channel = yield* channelOver([
        { type: "attached", ...key },
        { type: "detached", ...key },
      ]);
      // Whether or not the reader has reached these lines yet, the tab is not attached.
      const exit = yield* Effect.exit(Effect.scoped(channel.endpoint(key)));
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.scoped),
  );
});

const remoteChannel = Effect.gen(function* () {
  const context = yield* Layer.build(
    DesktopBrowserChannel.layer.pipe(
      Layer.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-desktop-browser-remote-" }),
      ),
    ),
  );
  return Context.get(context, DesktopBrowserChannel.DesktopBrowserChannel);
});

const connectHost = (
  channel: DesktopBrowserChannel.DesktopBrowserChannel["Service"],
  owner: string,
  hostId: string,
) =>
  Effect.gen(function* () {
    const commands = yield* Queue.unbounded<DesktopBrowserCommand>();
    const fiber = yield* channel.subscribeCommands(owner, hostId).pipe(
      Stream.runForEach((command) => Queue.offer(commands, command)),
      Effect.forkScoped,
    );
    expect(yield* Queue.take(commands)).toEqual({ type: "announce" });
    return { commands, fiber };
  });

it.effect(
  "presentation follows the current native guest and clears when its host disconnects",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const channel = yield* remoteChannel;
        const host = yield* connectHost(channel, "owner-a", "host-a");
        const tab = { ...key, desktopHostId: "host-a" };
        yield* channel.receiveEvent("owner-a", "host-a", {
          type: "presentation",
          ...key,
          presented: true,
        });
        expect(yield* channel.isPresented(tab)).toBe(false);
        yield* channel.receiveEvent("owner-a", "host-a", { type: "attached", ...key });
        expect(yield* channel.isPresented(tab)).toBe(false);
        yield* channel.receiveEvent("owner-a", "host-a", {
          type: "presentation",
          ...key,
          presented: true,
        });
        expect(yield* channel.isPresented(tab)).toBe(true);
        const rejected = yield* channel
          .receiveEvent("other-owner", "host-a", { type: "presentation", ...key, presented: false })
          .pipe(Effect.flip);
        expect(rejected.reason).toBe("host-unavailable");
        expect(yield* channel.isPresented(tab)).toBe(true);
        // A replacement announcement must not inherit its predecessor's visibility.
        yield* channel.receiveEvent("owner-a", "host-a", { type: "attached", ...key });
        expect(yield* channel.isPresented(tab)).toBe(false);
        yield* channel.receiveEvent("owner-a", "host-a", {
          type: "attached",
          ...key,
          presented: true,
        });
        expect(yield* channel.isPresented(tab)).toBe(true);
        yield* Fiber.interrupt(host.fiber);
        expect(yield* channel.isPresented(tab)).toBe(false);
        expect(yield* channel.isAttached(tab)).toBe(false);
        // A reconnect starts without any prior guest or presentation.
        yield* connectHost(channel, "owner-b", "host-a");
        expect(yield* channel.isPresented(tab)).toBe(false);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.layer(NodeServices.layer)("remote desktop browser transport", (it) => {
  it.effect.each([undefined, false])(
    "rejects missing native surface support (%s) immediately without dispatching or disconnecting",
    (supportsNativeSurface) =>
      Effect.gen(function* () {
        const channel = yield* remoteChannel;
        const host = yield* connectHost(channel, "socket-a", "host-a");
        const desktopKey = { ...key, desktopHostId: "host-a" };
        yield* channel.receiveEvent("socket-a", "host-a", {
          type: "attached",
          ...key,
          ...(supportsNativeSurface === undefined ? {} : { supportsNativeSurface }),
        });
        for (const action of ["acquire", "release"] as const) {
          const error = yield* channel
            .surface(desktopKey, { action, leaseId: "unsupported-lease" })
            .pipe(Effect.flip);
          expect(error.reason).toBe("surface-unsupported");
          expect(error.message).toContain("Update the desktop app");
        }
        expect(yield* Queue.size(host.commands)).toBe(0);
        expect(yield* channel.isAttached(desktopKey)).toBe(true);
        expect(channel.available).toBe(true);
      }).pipe(Effect.scoped),
  );

  it.effect("waits for the owning surface acknowledgement and returns its actual viewport", () =>
    Effect.gen(function* () {
      const channel = yield* remoteChannel;
      const first = yield* connectHost(channel, "socket-a", "host-a");
      yield* connectHost(channel, "socket-b", "host-b");
      yield* channel.receiveEvent("socket-a", "host-a", {
        type: "attached",
        ...key,
        supportsNativeSurface: true,
      });
      const request = yield* channel
        .surface(
          { ...key, desktopHostId: "host-a" },
          {
            action: "acquire",
            leaseId: "lease-a",
            viewport: { _tag: "freeform", width: 390, height: 844 },
          },
        )
        .pipe(Effect.forkScoped);
      const command = yield* Queue.take(first.commands);
      if (command.type !== "surface") throw new Error("Expected surface request");
      const response = {
        type: "surfaceReady" as const,
        ...key,
        requestId: command.requestId,
        viewport: { width: 390, height: 844 },
      };
      yield* channel.receiveEvent("socket-b", "host-b", response);
      expect(request.pollUnsafe()).toBeUndefined();
      yield* channel.receiveEvent("socket-a", "host-a", response);
      expect(yield* Fiber.join(request)).toEqual({ width: 390, height: 844 });
      const release = yield* channel
        .surface(
          { ...key, desktopHostId: "host-a" },
          {
            action: "release",
            leaseId: "lease-a",
          },
        )
        .pipe(Effect.forkScoped);
      const released = yield* Queue.take(first.commands);
      if (released.type !== "surface") throw new Error("Expected surface release");
      yield* channel.receiveEvent("socket-a", "host-a", {
        ...response,
        requestId: released.requestId,
        viewport: null,
      });
      expect(yield* Fiber.join(release)).toBeNull();
    }).pipe(Effect.scoped),
  );

  it.effect("releases a timed-out acquire and ignores its late acknowledgement", () =>
    Effect.gen(function* () {
      const channel = yield* remoteChannel;
      const host = yield* connectHost(channel, "socket-a", "host-a");
      yield* channel.receiveEvent("socket-a", "host-a", {
        type: "attached",
        ...key,
        supportsNativeSurface: true,
      });
      const request = yield* channel
        .surface(
          { ...key, desktopHostId: "host-a" },
          {
            action: "acquire",
            leaseId: "expired-lease",
          },
          100,
        )
        .pipe(Effect.flip, Effect.forkScoped);
      const acquire = yield* Queue.take(host.commands);
      if (acquire.type !== "surface") throw new Error("Expected acquire");
      yield* TestClock.adjust("100 millis");
      expect(yield* Fiber.join(request)).toMatchObject({ reason: "layout-timeout" });
      expect(yield* Queue.take(host.commands)).toMatchObject({
        type: "surface",
        action: "release",
        leaseId: "expired-lease",
      });
      yield* channel.receiveEvent("socket-a", "host-a", {
        type: "surfaceReady",
        ...key,
        requestId: acquire.requestId,
        viewport: { width: 1280, height: 800 },
      });
      expect(yield* channel.isAttached({ ...key, desktopHostId: "host-a" })).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("forgets surface support on replacement and detach without affecting another tab", () =>
    Effect.gen(function* () {
      const channel = yield* remoteChannel;
      const host = yield* connectHost(channel, "socket-a", "host-a");
      const desktopKey = { ...key, desktopHostId: "host-a" };
      const otherKey = { ...key, tabId: "tab-2" };
      for (const tab of [key, otherKey]) {
        yield* channel.receiveEvent("socket-a", "host-a", {
          type: "attached",
          ...tab,
          supportsNativeSurface: true,
        });
      }
      const pending = yield* channel
        .surface(desktopKey, { action: "acquire", leaseId: "old-lease" })
        .pipe(Effect.flip, Effect.forkScoped);
      const old = yield* Queue.take(host.commands);
      if (old.type !== "surface") throw new Error("Expected surface request");
      yield* channel.receiveEvent("socket-a", "host-a", { type: "attached", ...key });
      expect(yield* Fiber.join(pending)).toMatchObject({ reason: "guest-unavailable" });
      yield* channel.receiveEvent("socket-a", "host-a", {
        type: "surfaceReady",
        ...key,
        requestId: old.requestId,
        viewport: { width: 1280, height: 800 },
      });
      const acquire = channel.surface(desktopKey, { action: "acquire", leaseId: "new-lease" });
      expect(yield* acquire.pipe(Effect.flip)).toMatchObject({ reason: "surface-unsupported" });
      expect(yield* Queue.size(host.commands)).toBe(0);
      yield* channel.receiveEvent("socket-a", "host-a", { type: "detached", ...key });
      expect(yield* acquire.pipe(Effect.flip)).toMatchObject({ reason: "guest-unavailable" });
      yield* channel.receiveEvent("socket-a", "host-a", { type: "attached", ...key });
      expect(yield* acquire.pipe(Effect.flip)).toMatchObject({ reason: "surface-unsupported" });
      yield* channel.receiveEvent("socket-a", "host-a", {
        type: "attached",
        ...key,
        supportsNativeSurface: true,
      });
      for (const tab of [desktopKey, { ...otherKey, desktopHostId: "host-a" }]) {
        const ready = yield* channel
          .surface(tab, { action: "acquire", leaseId: "current-lease" })
          .pipe(Effect.forkScoped);
        const command = yield* Queue.take(host.commands);
        if (command.type !== "surface") throw new Error("Expected surface request");
        yield* channel.receiveEvent("socket-a", "host-a", {
          type: "surfaceReady",
          threadId: tab.threadId,
          tabId: tab.tabId,
          requestId: command.requestId,
          viewport: { width: 390, height: 844 },
        });
        expect(yield* Fiber.join(ready)).toEqual({ width: 390, height: 844 });
      }
      expect(channel.available).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("does not carry surface support across a disconnected host's replacement", () =>
    Effect.gen(function* () {
      const channel = yield* remoteChannel;
      const first = yield* connectHost(channel, "socket-a", "host-a");
      yield* channel.receiveEvent("socket-a", "host-a", {
        type: "attached",
        ...key,
        supportsNativeSurface: true,
      });
      yield* Fiber.interrupt(first.fiber);
      const replacement = yield* connectHost(channel, "socket-b", "host-a");
      yield* channel.receiveEvent("socket-b", "host-a", { type: "attached", ...key });
      const error = yield* channel
        .surface({ ...key, desktopHostId: "host-a" }, { action: "acquire", leaseId: "lease-b" })
        .pipe(Effect.flip);
      expect(error.reason).toBe("surface-unsupported");
      expect(yield* Queue.size(replacement.commands)).toBe(0);
      expect(channel.available).toBe(true);
    }).pipe(Effect.scoped),
  );
  it.effect("rejects a different socket owner and keeps equal tab IDs on separate hosts", () =>
    Effect.gen(function* () {
      const channel = yield* remoteChannel;
      yield* connectHost(channel, "socket-a", "host-a");
      yield* connectHost(channel, "socket-b", "host-b");
      const forged = yield* Effect.exit(
        channel.receiveEvent("socket-b", "host-a", { type: "attached", ...key }),
      );
      expect(Exit.isFailure(forged)).toBe(true);
      expect(yield* channel.isAttached({ ...key, desktopHostId: "host-a" })).toBe(false);
      yield* channel.receiveEvent("socket-a", "host-a", { type: "attached", ...key });
      expect(yield* channel.isAttached({ ...key, desktopHostId: "host-a" })).toBe(true);
      expect(yield* channel.isAttached({ ...key, desktopHostId: "host-b" })).toBe(false);
      expect(yield* channel.isAttached(key)).toBe(false);
      const duplicate = yield* channel
        .subscribeCommands("socket-b", "host-a")
        .pipe(Stream.runHead, Effect.exit);
      expect(Exit.isFailure(duplicate)).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("pins the catalogue to its responding host and refuses ambiguous selection", () =>
    Effect.gen(function* () {
      const channel = yield* remoteChannel;
      const first = yield* connectHost(channel, "socket-a", "host-a");
      const profiles = channel.getProfiles({ threadId: "thread-1", agentSessionId: "agent-1" });
      const request = yield* profiles.pipe(Effect.forkScoped);
      const command = yield* Queue.take(first.commands);
      if (command.type !== "profiles") throw new Error("Expected profile catalogue request");
      const second = yield* connectHost(channel, "socket-b", "host-b");
      yield* channel.receiveEvent("socket-b", "host-b", {
        type: "profiles",
        requestId: command.requestId,
        profiles: null,
      });
      const catalogue = {
        profiles: [{ id: "work", name: "Work", kind: "persistent" as const }],
        defaultProfileId: "work",
      };
      yield* channel.receiveEvent("socket-a", "host-a", {
        type: "profiles",
        requestId: command.requestId,
        profiles: catalogue,
      });
      expect(yield* Fiber.join(request)).toEqual({ ...catalogue, desktopHostId: "host-a" });
      expect(yield* profiles).toBeNull();
      yield* Fiber.interrupt(first.fiber);
      yield* Fiber.interrupt(second.fiber);
      expect(channel.available).toBe(false);
      expect(yield* profiles).toBeNull();
    }).pipe(Effect.scoped),
  );

  it.effect("releases only the disconnected host's tabs and pending catalogue requests", () =>
    Effect.gen(function* () {
      const channel = yield* remoteChannel;
      const first = yield* connectHost(channel, "socket-a", "host-a");
      const pending = yield* channel
        .getProfiles({ threadId: "thread-1", agentSessionId: "agent-1" })
        .pipe(Effect.forkScoped);
      yield* Queue.take(first.commands);
      yield* connectHost(channel, "socket-b", "host-b");
      yield* channel.receiveEvent("socket-a", "host-a", { type: "attached", ...key });
      yield* channel.receiveEvent("socket-b", "host-b", { type: "attached", ...key });
      yield* Fiber.interrupt(first.fiber);
      expect(yield* Fiber.join(pending)).toBeNull();
      expect(yield* channel.isAttached({ ...key, desktopHostId: "host-a" })).toBe(false);
      expect(yield* channel.isAttached({ ...key, desktopHostId: "host-b" })).toBe(true);
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            channel.receiveEvent("socket-a", "host-a", { type: "attached", ...key }),
          ),
        ),
      ).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("relays CDP frames through the pinned host and closes its socket on disconnect", () =>
    Effect.gen(function* () {
      const channel = yield* remoteChannel;
      const first = yield* connectHost(channel, "socket-a", "host-a");
      const desktopKey = { ...key, desktopHostId: "host-a" };
      yield* channel.receiveEvent("socket-a", "host-a", { type: "attached", ...key });
      const endpoint = yield* channel.endpoint(desktopKey);
      const opened = Promise.withResolvers<void>();
      const received = Promise.withResolvers<string>();
      const closed = Promise.withResolvers<void>();
      const barrier = Promise.withResolvers<void>();
      const frames: string[] = [];
      const socket = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const socket = new WebSocket(endpoint);
          socket.addEventListener("open", () => opened.resolve());
          socket.addEventListener("message", (event) => {
            const frame = String(event.data);
            frames.push(frame);
            received.resolve(frame);
            if (frame === '{"id":99,"result":{}}') barrier.resolve();
          });
          socket.addEventListener("close", () => closed.resolve());
          socket.addEventListener("error", () => opened.reject(new Error("CDP socket failed")));
          return socket;
        }),
        (socket) => Effect.sync(() => socket.close()),
      );
      yield* Effect.promise(() => opened.promise);
      socket.send('{"id":1,"method":"Browser.getVersion"}');
      expect(yield* Queue.take(first.commands)).toEqual({
        type: "cdp",
        ...key,
        message: '{"id":1,"method":"Browser.getVersion"}',
      });
      yield* channel.receiveEvent("socket-a", "host-a", {
        type: "cdp",
        ...key,
        message: '{"id":1,"result":{}}',
      });
      expect(yield* Effect.promise(() => received.promise)).toBe('{"id":1,"result":{}}');
      const directory = yield* Effect.acquireRelease(
        Effect.sync(() =>
          NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-remote-download-")),
        ),
        (directory) =>
          Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
      );
      socket.send(
        JSON.stringify({
          id: 2,
          method: "Browser.setDownloadBehavior",
          params: { behavior: "allowAndName", downloadPath: directory },
        }),
      );
      yield* Queue.take(first.commands);
      const chunk = {
        type: "download" as const,
        ...key,
        guid: "download-1",
        offset: 0,
        data: Buffer.from([0, 255, 128]).toString("base64"),
        done: false,
      };
      yield* channel.receiveEvent("socket-a", "host-a", { ...chunk, guid: "failed-download" });
      const outOfOrder = yield* channel
        .receiveEvent("socket-a", "host-a", { ...chunk, guid: "failed-download", offset: 1 })
        .pipe(Effect.exit);
      expect(Exit.isFailure(outOfOrder)).toBe(true);
      expect(NodeFS.existsSync(NodePath.join(directory, "failed-download"))).toBe(false);
      yield* channel.receiveEvent("socket-a", "host-a", {
        type: "cdp",
        ...key,
        message:
          '{"method":"Browser.downloadProgress","params":{"guid":"failed-download","state":"completed"}}',
      });
      yield* channel.receiveEvent("socket-a", "host-a", {
        type: "cdp",
        ...key,
        message: '{"id":99,"result":{}}',
      });
      yield* Effect.promise(() => barrier.promise);
      expect(
        frames.some(
          (frame) =>
            frame.includes('"guid":"failed-download"') && frame.includes('"state":"completed"'),
        ),
      ).toBe(false);
      expect(
        frames.some(
          (frame) =>
            frame.includes('"guid":"failed-download"') && frame.includes('"state":"canceled"'),
        ),
      ).toBe(true);
      yield* channel.receiveEvent("socket-a", "host-a", chunk);
      yield* channel.receiveEvent("socket-a", "host-a", {
        ...chunk,
        offset: 3,
        data: Buffer.from([42]).toString("base64"),
        done: true,
      });
      expect([...NodeFS.readFileSync(NodePath.join(directory, "download-1"))]).toEqual([
        0, 255, 128, 42,
      ]);
      yield* Fiber.interrupt(first.fiber);
      yield* Effect.promise(() => closed.promise);
    }).pipe(Effect.scoped),
  );
});

it.layer(NodeServices.layer)("desktop browser URL resolution", (it) => {
  it.effect("pins the environment URL response to the selected desktop host", () =>
    Effect.gen(function* () {
      const channel = yield* remoteChannel;
      const host = yield* connectHost(channel, "socket-a", "host-a");
      const input = {
        desktopHostId: "host-a",
        threadId: "thread-1",
        url: "http://localhost:5173/path?q=1#result",
      };
      const resolving = yield* channel.resolveUrl(input).pipe(Effect.forkScoped);
      const command = yield* Queue.take(host.commands);
      if (command.type !== "resolveUrl") throw new Error("Expected URL request");
      expect(command.url).toBe(input.url);
      yield* channel.receiveEvent("socket-a", "host-a", {
        type: "resolvedUrl",
        requestId: command.requestId,
        url: "http://192.168.1.20:5173/path?q=1#result",
      });
      expect(yield* Fiber.join(resolving)).toBe("http://192.168.1.20:5173/path?q=1#result");
      expect(yield* channel.resolveUrl({ ...input, desktopHostId: "missing" })).toBeNull();
      expect(yield* channel.resolveUrl({ ...input, desktopHostId: "local" })).toBe(input.url);
    }).pipe(Effect.scoped),
  );
});
