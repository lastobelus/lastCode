// @effect-diagnostics nodeBuiltinImport:off - Exercises the real inherited descriptor lifecycle in a subprocess.
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import type { DesktopBrowserCommand } from "@t3tools/contracts";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
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

it("receives desktop messages and exits while the parent keeps both input pipes open", async () => {
  const child = NodeChildProcess.spawn(
    process.execPath,
    [NodeURL.fileURLToPath(new URL("./testing/DesktopPipeLifecycle.fixture.ts", import.meta.url))],
    { stdio: ["ignore", "pipe", "pipe", "pipe", "pipe", "pipe", "pipe"] },
  );
  // A failed exit must not leave a test process running. This never fires on success.
  // @effect-diagnostics-next-line globalTimers:off -- Bounds the native subprocess on failure; success waits for process exit.
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 8_000);
  let output = "";
  let errors = "";
  let verified = false;
  child.stderr?.on("data", (chunk: Buffer) => {
    errors += chunk.toString();
  });
  const write = (fd: number, value: Record<string, unknown>) => {
    const stream = child.stdio[fd];
    if (!stream || !("write" in stream)) throw new Error(`Missing pipe ${fd}`);
    stream.write(`${JSON.stringify(value)}\n`);
  };
  const controlCommands: Array<unknown> = [];
  let controlBuffer = "";
  child.stdio[4]?.on("data", (chunk: Buffer) => {
    controlBuffer += chunk.toString();
    let end: number;
    while ((end = controlBuffer.indexOf("\n")) >= 0) {
      controlCommands.push(JSON.parse(controlBuffer.slice(0, end)));
      controlBuffer = controlBuffer.slice(end + 1);
    }
  });
  const key = { threadId: "thread-1", tabId: "tab-1" };
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
    let end: number;
    while ((end = output.indexOf("\n")) >= 0) {
      const line = output.slice(0, end);
      output = output.slice(end + 1);
      if (line === "ready") {
        write(3, { type: "attached", ...key });
        write(5, { version: 1, type: "desktopTelemetryHello", electronPid: process.pid });
      } else if (line === "attached") {
        write(3, { type: "detached", ...key });
      } else if (line === "verified") {
        verified = true;
      }
    }
  });
  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
      },
    );
    expect(errors).not.toContain("Error");
    expect(verified).toBe(true);
    expect(controlCommands).toContainEqual({
      type: "reconcileRoots",
      serverEpoch: "fixture-server-epoch",
    });
    expect(result).toEqual({ code: 0, signal: null });
  } finally {
    clearTimeout(watchdog);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    for (const stream of child.stdio) stream?.destroy();
  }
});

const key = { threadId: "thread-1", tabId: "tab-1" };

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
        expect(channel.isPresented(tab)).toBe(false);
        yield* channel.receiveEvent("owner-a", "host-a", { type: "attached", ...key });
        expect(channel.isPresented(tab)).toBe(false);
        yield* channel.receiveEvent("owner-a", "host-a", {
          type: "presentation",
          ...key,
          presented: true,
        });
        expect(channel.isPresented(tab)).toBe(true);
        const rejected = yield* channel
          .receiveEvent("other-owner", "host-a", { type: "presentation", ...key, presented: false })
          .pipe(Effect.flip);
        expect(rejected.reason).toBe("host-unavailable");
        expect(channel.isPresented(tab)).toBe(true);
        // A replacement announcement must not inherit its predecessor's visibility.
        yield* channel.receiveEvent("owner-a", "host-a", { type: "attached", ...key });
        expect(channel.isPresented(tab)).toBe(false);
        yield* channel.receiveEvent("owner-a", "host-a", {
          type: "attached",
          ...key,
          presented: true,
        });
        expect(channel.isPresented(tab)).toBe(true);
        yield* Fiber.interrupt(host.fiber);
        expect(channel.isPresented(tab)).toBe(false);
        expect(yield* channel.isAttached(tab)).toBe(false);
        // A reconnect starts without any prior guest or presentation.
        yield* connectHost(channel, "owner-b", "host-a");
        expect(channel.isPresented(tab)).toBe(false);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.layer(NodeServices.layer)("remote desktop browser transport", (it) => {
  it.effect(
    "root creation requires the owning host, tab, request, and profile acknowledgment",
    () =>
      Effect.gen(function* () {
        const channel = yield* remoteChannel;
        const host = yield* connectHost(channel, "socket-a", "host-a");
        const other = yield* connectHost(channel, "socket-b", "host-b");
        const opening = yield* channel
          .createRoot(
            { ...key, desktopHostId: "host-a" },
            {
              serverEpoch: "server-epoch-a",
              profileId: "work",
              url: "https://example.test/start",
              viewport: { _tag: "freeform", width: 900, height: 600 },
            },
          )
          .pipe(Effect.forkScoped);
        const command = yield* Queue.take(host.commands);
        expect(command).toMatchObject({
          type: "createRoot",
          ...key,
          profileId: "work",
          url: "https://example.test/start",
        });
        if (command.type !== "createRoot") throw new Error("Expected root creation");
        const response = {
          type: "rootCreated" as const,
          ...key,
          requestId: command.requestId,
          profileId: "work",
          rootId: "root-a",
        };
        expect(
          (yield* channel.receiveEvent("socket-b", "host-a", response).pipe(Effect.flip)).reason,
        ).toBe("host-unavailable");
        yield* channel.receiveEvent("socket-b", "host-b", response);
        yield* channel.receiveEvent("socket-a", "host-a", { ...response, tabId: "other-tab" });
        yield* channel.receiveEvent("socket-a", "host-a", {
          ...response,
          requestId: "other-request",
        });
        yield* channel.receiveEvent("socket-a", "host-a", { ...response, profileId: "default" });
        expect(opening.pollUnsafe()).toBeUndefined();
        expect(yield* Queue.size(other.commands)).toBe(0);
        yield* channel.receiveEvent("socket-a", "host-a", response);
        expect(yield* Fiber.join(opening)).toBe("root-a");
      }).pipe(Effect.scoped),
  );

  it.effect.each(["timeout", "interrupted", "disconnected"] as const)(
    "a %s root creation retries cleanup only for its original creation request",
    (failure) =>
      Effect.gen(function* () {
        const channel = yield* remoteChannel;
        const host = yield* connectHost(channel, "socket-a", "host-a");
        const opening = yield* channel
          .createRoot(
            { ...key, desktopHostId: "host-a" },
            { serverEpoch: "server-epoch-a", profileId: "work", url: "about:blank" },
          )
          .pipe(Effect.flip, Effect.forkScoped);
        const creation = yield* Queue.take(host.commands);
        if (creation.type !== "createRoot") throw new Error("Expected root creation");
        if (failure === "timeout") {
          yield* TestClock.adjust("10 seconds");
          expect((yield* Fiber.join(opening)).reason).toBe("host-unavailable");
        } else if (failure === "interrupted") yield* Fiber.interrupt(opening);
        else {
          yield* Fiber.interrupt(host.fiber);
          expect((yield* Fiber.join(opening)).reason).toBe("host-unavailable");
        }
        const connected =
          failure === "disconnected" ? yield* connectHost(channel, "socket-c", "host-a") : host;
        expect(yield* Queue.take(connected.commands)).toEqual({
          type: "cancelRootCreation",
          ...key,
          requestId: creation.requestId,
          profileId: "work",
        });
        const owner = failure === "disconnected" ? "socket-c" : "socket-a";
        yield* channel.receiveEvent(owner, "host-a", {
          type: "rootCreated",
          ...key,
          requestId: creation.requestId,
          profileId: "other",
          rootId: "unrelated-root",
        });
        expect(yield* Queue.size(connected.commands)).toBe(0);
        yield* channel.receiveEvent(owner, "host-a", {
          type: "rootCreated",
          ...key,
          requestId: creation.requestId,
          profileId: "work",
          rootId: "late-root",
        });
        expect(yield* Queue.take(connected.commands)).toEqual({
          type: "cancelRootCreation",
          ...key,
          requestId: creation.requestId,
          profileId: "work",
        });
      }).pipe(Effect.scoped),
  );

  it.effect("a cancellation acknowledgment retires reconnect cancellation replay", () =>
    Effect.gen(function* () {
      const channel = yield* remoteChannel;
      const host = yield* connectHost(channel, "socket-a", "host-a");
      const opening = yield* channel
        .createRoot(
          { ...key, desktopHostId: "host-a" },
          { serverEpoch: "server-epoch-a", profileId: "default", url: "about:blank" },
        )
        .pipe(Effect.forkScoped);
      const creation = yield* Queue.take(host.commands);
      if (creation.type !== "createRoot") throw new Error("Expected root creation");
      yield* Fiber.interrupt(opening);
      expect((yield* Queue.take(host.commands)).type).toBe("cancelRootCreation");
      yield* channel.receiveEvent("socket-a", "host-a", {
        type: "rootCreated",
        ...key,
        requestId: creation.requestId,
        profileId: "default",
        rootId: null,
        reason: "guest-unavailable",
      });
      yield* Fiber.interrupt(host.fiber);
      const replacement = yield* connectHost(channel, "socket-b", "host-a");
      expect(yield* Queue.size(replacement.commands)).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "discarding an acknowledged but unpublished root cancels its original request after reconnect",
    () =>
      Effect.gen(function* () {
        const channel = yield* remoteChannel;
        const host = yield* connectHost(channel, "socket-a", "host-a");
        const source = { ...key, desktopHostId: "host-a" };
        const opening = yield* channel
          .createRoot(source, {
            serverEpoch: "server-epoch-a",
            profileId: "work",
            url: "about:blank",
          })
          .pipe(Effect.forkScoped);
        const creation = yield* Queue.take(host.commands);
        if (creation.type !== "createRoot") throw new Error("Expected root creation");
        yield* channel.receiveEvent("socket-a", "host-a", {
          type: "rootCreated",
          ...key,
          requestId: creation.requestId,
          profileId: "work",
          rootId: "root-a",
        });
        yield* Fiber.join(opening);
        yield* channel.cancelRootCreation(source, "other-root");
        expect(yield* Queue.size(host.commands)).toBe(0);
        yield* Fiber.interrupt(host.fiber);
        yield* channel.cancelRootCreation(source, "root-a");
        const next = yield* connectHost(channel, "socket-b", "host-a");
        expect(yield* Queue.take(next.commands)).toEqual({
          type: "cancelRootCreation",
          ...key,
          profileId: "work",
          requestId: creation.requestId,
        });
        const closed = yield* channel.closedRoots.pipe(Stream.toQueue({ capacity: "unbounded" }));
        yield* Effect.yieldNow;
        yield* channel.receiveEvent("socket-b", "host-a", {
          type: "rootCreated",
          ...key,
          profileId: "work",
          requestId: creation.requestId,
          rootId: null,
          reason: "guest-unavailable",
        });
        yield* channel.receiveEvent("socket-b", "host-a", {
          type: "rootClosed",
          ...key,
          rootId: "root-a",
        });
        expect(yield* Queue.take(closed)).toEqual({ ...source, rootId: "root-a" });
        expect(yield* Queue.size(next.commands)).toBe(0);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "root close veto retains ownership and destruction only follows the matching root",
    () =>
      Effect.gen(function* () {
        const channel = yield* remoteChannel;
        const host = yield* connectHost(channel, "socket-a", "host-a");
        yield* connectHost(channel, "socket-b", "host-b");
        const source = { ...key, desktopHostId: "host-a" };
        const opening = yield* channel
          .createRoot(source, {
            serverEpoch: "server-epoch-a",
            profileId: "default",
            url: "about:blank",
          })
          .pipe(Effect.forkScoped);
        const creation = yield* Queue.take(host.commands);
        if (creation.type !== "createRoot") throw new Error("Expected root creation");
        yield* channel.receiveEvent("socket-a", "host-a", {
          type: "rootCreated",
          ...key,
          requestId: creation.requestId,
          profileId: "default",
          rootId: "root-a",
        });
        yield* Fiber.join(opening);
        const closed = yield* channel.closedRoots.pipe(Stream.toQueue({ capacity: "unbounded" }));
        const canceled = yield* channel
          .closeRoot(source, "root-a")
          .pipe(Effect.flip, Effect.forkScoped);
        const attempt = yield* Queue.take(host.commands);
        if (attempt.type !== "closeRoot") throw new Error("Expected root close");
        yield* channel.receiveEvent("socket-a", "host-a", {
          type: "rootCloseCanceled",
          ...key,
          rootId: "root-a",
          requestId: attempt.requestId,
        });
        expect((yield* Fiber.join(canceled)).reason).toBe("close-canceled");
        expect(yield* Queue.size(closed)).toBe(0);
        const closing = yield* channel.closeRoot(source, "root-a").pipe(Effect.forkScoped);
        const deliberate = yield* Queue.take(host.commands);
        expect(deliberate).toMatchObject({ type: "closeRoot", rootId: "root-a" });
        if (deliberate.type !== "closeRoot") throw new Error("Expected root close");
        expect(deliberate.requestId).not.toBe(attempt.requestId);
        yield* channel.receiveEvent("socket-b", "host-b", {
          type: "rootClosed",
          ...key,
          rootId: "root-a",
        });
        yield* channel.receiveEvent("socket-a", "host-a", {
          type: "rootClosed",
          ...key,
          rootId: "other-root",
        });
        expect(closing.pollUnsafe()).toBeUndefined();
        expect(yield* Queue.size(closed)).toBe(0);
        yield* channel.receiveEvent("socket-a", "host-a", {
          type: "rootClosed",
          ...key,
          rootId: "root-a",
        });
        yield* Fiber.join(closing);
        expect(yield* Queue.take(closed)).toEqual({ ...source, rootId: "root-a" });
      }).pipe(Effect.scoped),
  );

  it.effect.each([false, true])(
    "correlates native popup presence without closing a window (%s)",
    (present) =>
      Effect.gen(function* () {
        const channel = yield* remoteChannel;
        const host = yield* connectHost(channel, "socket-a", "host-a");
        yield* connectHost(channel, "socket-b", "host-b");
        const source = { ...key, desktopHostId: "host-a" };
        let completed = false;
        const probe = yield* channel.probePopup(source, "child-1").pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              completed = true;
            }),
          ),
          Effect.forkScoped,
        );
        const command = yield* Queue.take(host.commands);
        if (command.type !== "probePopup") throw new Error("Expected native presence probe");
        const response = {
          type: "popupPresence" as const,
          ...key,
          popupId: command.popupId,
          requestId: command.requestId,
          present,
        };
        yield* channel.receiveEvent("socket-b", "host-b", response);
        yield* channel.receiveEvent("socket-a", "host-a", { ...response, tabId: "other-source" });
        yield* channel.receiveEvent("socket-a", "host-a", { ...response, popupId: "other-popup" });
        yield* channel.receiveEvent("socket-a", "host-a", {
          ...response,
          requestId: "other-request",
        });
        expect(completed).toBe(false);
        const rejected = yield* channel
          .receiveEvent("socket-b", "host-a", response)
          .pipe(Effect.flip);
        expect(rejected.reason).toBe("host-unavailable");
        yield* channel.receiveEvent("socket-a", "host-a", response);
        expect(yield* Fiber.join(probe)).toBe(present);
        expect(yield* Queue.size(host.commands)).toBe(0);
      }).pipe(Effect.scoped),
  );

  it.effect.each([false, true])(
    "correlates native root presence with its exact owner, tab, root, request and kind (%s)",
    (present) =>
      Effect.gen(function* () {
        const channel = yield* remoteChannel;
        const host = yield* connectHost(channel, "socket-a", "host-a");
        const other = yield* connectHost(channel, "socket-b", "host-b");
        const source = { ...key, desktopHostId: "host-a" };
        yield* channel.reconcileRoots("host-a", "server-epoch-a");
        expect(yield* Queue.take(host.commands)).toEqual({
          type: "reconcileRoots",
          serverEpoch: "server-epoch-a",
        });
        expect(yield* Queue.size(other.commands)).toBe(0);
        const checking = yield* channel.probeRoot(source, "root-a").pipe(Effect.forkScoped);
        const command = yield* Queue.take(host.commands);
        if (command.type !== "probeRoot") throw new Error("Expected native root presence probe");
        const response = {
          type: "rootPresence" as const,
          ...key,
          rootId: command.rootId,
          requestId: command.requestId,
          present,
        };
        yield* channel.receiveEvent("socket-b", "host-b", response);
        yield* channel.receiveEvent("socket-a", "host-a", {
          ...response,
          threadId: "other-thread",
        });
        yield* channel.receiveEvent("socket-a", "host-a", { ...response, tabId: "other-tab" });
        yield* channel.receiveEvent("socket-a", "host-a", { ...response, rootId: "other-root" });
        yield* channel.receiveEvent("socket-a", "host-a", {
          ...response,
          requestId: "other-request",
        });
        yield* channel.receiveEvent("socket-a", "host-a", {
          type: "popupPresence",
          ...key,
          popupId: command.rootId,
          requestId: command.requestId,
          present,
        });
        expect(checking.pollUnsafe()).toBeUndefined();
        yield* channel.receiveEvent("socket-a", "host-a", response);
        expect(yield* Fiber.join(checking)).toBe(present);
        expect(yield* Queue.size(host.commands)).toBe(0);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "an absent root completes a lost close and retires its published reconnect replay",
    () =>
      Effect.gen(function* () {
        const channel = yield* remoteChannel;
        const host = yield* connectHost(channel, "socket-a", "host-a");
        const source = { ...key, desktopHostId: "host-a" };
        const opening = yield* channel
          .createRoot(source, {
            serverEpoch: "server-epoch-a",
            profileId: "default",
            url: "about:blank",
          })
          .pipe(Effect.forkScoped);
        const creation = yield* Queue.take(host.commands);
        if (creation.type !== "createRoot") throw new Error("Expected native root creation");
        yield* channel.receiveEvent("socket-a", "host-a", {
          type: "rootCreated",
          ...key,
          rootId: "root-a",
          requestId: creation.requestId,
          profileId: "default",
        });
        yield* Fiber.join(opening);
        const accepting = yield* channel.acceptRoot(source, "root-a").pipe(Effect.forkScoped);
        const acceptance = yield* Queue.take(host.commands);
        if (acceptance.type !== "acceptRoot") throw new Error("Expected native root acceptance");
        yield* channel.receiveEvent("socket-a", "host-a", {
          ...acceptance,
          type: "rootAccepted",
          accepted: true,
        });
        yield* Fiber.join(accepting);
        yield* channel.publishRoot(source, "root-a");
        expect((yield* Queue.take(host.commands)).type).toBe("publishRoot");
        const closing = yield* channel.closeRoot(source, "root-a").pipe(Effect.forkScoped);
        expect((yield* Queue.take(host.commands)).type).toBe("closeRoot");
        const checking = yield* channel.probeRoot(source, "root-a").pipe(Effect.forkScoped);
        const probe = yield* Queue.take(host.commands);
        if (probe.type !== "probeRoot") throw new Error("Expected native root probe");
        yield* channel.receiveEvent("socket-a", "host-a", {
          type: "rootPresence",
          ...key,
          rootId: "root-a",
          requestId: probe.requestId,
          present: false,
        });
        expect(yield* Fiber.join(checking)).toBe(false);
        yield* Fiber.join(closing);
        yield* Fiber.interrupt(host.fiber);
        const reconnected = yield* connectHost(channel, "socket-b", "host-a");
        expect(yield* Queue.size(reconnected.commands)).toBe(0);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "an explicit offline discard is replayed only to its owner until destruction acknowledges",
    () =>
      Effect.gen(function* () {
        const channel = yield* remoteChannel;
        const host = yield* connectHost(channel, "socket-a", "host-a");
        const source = { ...key, desktopHostId: "host-a" };
        const opening = yield* channel
          .createRoot(source, {
            serverEpoch: "server-epoch-a",
            profileId: "default",
            url: "about:blank",
          })
          .pipe(Effect.forkScoped);
        const creation = yield* Queue.take(host.commands);
        if (creation.type !== "createRoot") throw new Error("Expected native root creation");
        yield* channel.receiveEvent("socket-a", "host-a", {
          type: "rootCreated",
          ...key,
          rootId: "root-a",
          requestId: creation.requestId,
          profileId: "default",
        });
        yield* Fiber.join(opening);
        const accepting = yield* channel.acceptRoot(source, "root-a").pipe(Effect.forkScoped);
        const acceptance = yield* Queue.take(host.commands);
        if (acceptance.type !== "acceptRoot") throw new Error("Expected native root acceptance");
        yield* channel.receiveEvent("socket-a", "host-a", {
          ...acceptance,
          type: "rootAccepted",
          accepted: true,
        });
        yield* Fiber.join(accepting);
        yield* channel.publishRoot(source, "root-a");
        expect((yield* Queue.take(host.commands)).type).toBe("publishRoot");
        yield* Fiber.interrupt(host.fiber);
        yield* channel.discardRoot(source, "wrong-root");
        expect(yield* channel.closeRoot(source, "root-a", { discardIfOffline: true })).toBe(
          "discarded",
        );
        const other = yield* connectHost(channel, "socket-b", "host-b");
        expect(yield* Queue.size(other.commands)).toBe(0);
        let reconnected = yield* connectHost(channel, "socket-c", "host-a");
        expect(yield* Queue.take(reconnected.commands)).toEqual({
          type: "discardRoot",
          ...key,
          rootId: "root-a",
        });
        expect(yield* Queue.size(reconnected.commands)).toBe(0);
        yield* channel.receiveEvent("socket-c", "host-a", {
          type: "rootClosed",
          ...key,
          rootId: "wrong-root",
        });
        yield* Fiber.interrupt(reconnected.fiber);
        reconnected = yield* connectHost(channel, "socket-d", "host-a");
        expect((yield* Queue.take(reconnected.commands)).type).toBe("discardRoot");
        yield* channel.receiveEvent("socket-d", "host-a", {
          type: "rootClosed",
          ...key,
          rootId: "root-a",
        });
        yield* Fiber.interrupt(reconnected.fiber);
        reconnected = yield* connectHost(channel, "socket-e", "host-a");
        expect(yield* Queue.size(reconnected.commands)).toBe(0);
      }).pipe(Effect.scoped),
  );

  it.effect("disconnect fails an outstanding root probe and ignores its old response", () =>
    Effect.gen(function* () {
      const channel = yield* remoteChannel;
      const host = yield* connectHost(channel, "socket-a", "host-a");
      const source = { ...key, desktopHostId: "host-a" };
      const checking = yield* channel
        .probeRoot(source, "root-a")
        .pipe(Effect.flip, Effect.forkScoped);
      const old = yield* Queue.take(host.commands);
      if (old.type !== "probeRoot") throw new Error("Expected root probe");
      yield* Fiber.interrupt(host.fiber);
      expect((yield* Fiber.join(checking)).reason).toBe("host-unavailable");
      const reconnected = yield* connectHost(channel, "socket-b", "host-a");
      const retry = yield* channel.probeRoot(source, "root-a").pipe(Effect.forkScoped);
      const command = yield* Queue.take(reconnected.commands);
      if (command.type !== "probeRoot") throw new Error("Expected replacement root probe");
      yield* channel.receiveEvent("socket-b", "host-a", {
        type: "rootPresence",
        ...key,
        rootId: "root-a",
        requestId: old.requestId,
        present: false,
      });
      expect(retry.pollUnsafe()).toBeUndefined();
      yield* channel.receiveEvent("socket-b", "host-a", {
        type: "rootPresence",
        ...key,
        rootId: "root-a",
        requestId: command.requestId,
        present: true,
      });
      expect(yield* Fiber.join(retry)).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "presence confirmation completes a pending close whose destruction event was lost",
    () =>
      Effect.gen(function* () {
        const channel = yield* remoteChannel;
        const host = yield* connectHost(channel, "socket-a", "host-a");
        const source = { ...key, desktopHostId: "host-a" };
        const closing = yield* channel.closePopup(source, "gone-offline").pipe(Effect.forkScoped);
        yield* Queue.take(host.commands);
        const checking = yield* channel.probePopup(source, "gone-offline").pipe(Effect.forkScoped);
        const probe = yield* Queue.take(host.commands);
        if (probe.type !== "probePopup") throw new Error("Expected native presence probe");
        yield* channel.receiveEvent("socket-a", "host-a", {
          type: "popupPresence",
          ...key,
          popupId: "gone-offline",
          requestId: probe.requestId,
          present: false,
        });
        expect(yield* Fiber.join(checking)).toBe(false);
        yield* Fiber.join(closing);
      }).pipe(Effect.scoped),
  );

  it.effect.each(["disconnect", "timeout"] as const)(
    "unavailable popup probes preserve an unknown result (%s)",
    (reason) =>
      Effect.gen(function* () {
        const channel = yield* remoteChannel;
        const host = yield* connectHost(channel, "socket-a", "host-a");
        const source = { ...key, desktopHostId: "host-a" };
        const checking = yield* channel
          .probePopup(source, "child-1")
          .pipe(Effect.flip, Effect.forkScoped);
        const original = yield* Queue.take(host.commands);
        if (original.type !== "probePopup") throw new Error("Expected native presence probe");
        if (reason === "disconnect") yield* Fiber.interrupt(host.fiber);
        else yield* TestClock.adjust("5 seconds");
        expect((yield* Fiber.join(checking)).reason).toBe("host-unavailable");
        const next =
          reason === "disconnect" ? yield* connectHost(channel, "socket-c", "host-a") : host;
        const owner = reason === "disconnect" ? "socket-c" : "socket-a";
        const retry = yield* channel.probePopup(source, "child-1").pipe(Effect.forkScoped);
        const command = yield* Queue.take(next.commands);
        if (command.type !== "probePopup") throw new Error("Expected retry presence probe");
        expect(command.requestId).not.toBe(original.requestId);
        yield* channel.receiveEvent(owner, "host-a", {
          type: "popupPresence",
          ...key,
          popupId: "child-1",
          requestId: original.requestId,
          present: false,
        });
        yield* channel.receiveEvent(owner, "host-a", {
          type: "popupPresence",
          ...key,
          popupId: "child-1",
          requestId: command.requestId,
          present: true,
        });
        expect(yield* Fiber.join(retry)).toBe(true);
      }).pipe(Effect.scoped),
  );

  it.effect.each([false, true])(
    "a lost native veto retires the same attempt after reconnect (retry already waiting: %s)",
    (waiting) =>
      Effect.gen(function* () {
        const channel = yield* remoteChannel;
        const source = { ...key, desktopHostId: "host-a" };
        const first = yield* connectHost(channel, "socket-a", "host-a");
        const original = yield* channel
          .closePopup(source, "child-1")
          .pipe(Effect.flip, Effect.forkScoped);
        const command = yield* Queue.take(first.commands);
        if (command.type !== "closePopup") throw new Error("Expected native close request");
        // The host received the command and vetoed closing; its cancellation was lost offline.
        yield* Fiber.interrupt(first.fiber);
        expect((yield* Fiber.join(original)).reason).toBe("host-unavailable");
        const next = yield* connectHost(channel, "socket-b", "host-a");
        const cancellation = {
          type: "popupCloseCanceled" as const,
          ...key,
          popupId: "child-1",
          requestId: command.requestId,
        };
        if (!waiting) yield* channel.receiveEvent("socket-b", "host-a", cancellation);
        const retry = yield* channel
          .closePopup(source, "child-1")
          .pipe(Effect.flip, Effect.forkScoped);
        if (waiting) {
          expect(yield* Queue.take(next.commands)).toEqual(command);
          yield* channel.receiveEvent("socket-b", "host-a", cancellation);
        }
        expect((yield* Fiber.join(retry)).reason).toBe("close-canceled");
        expect(yield* Queue.size(next.commands)).toBe(0);
        let completed = false;
        const deliberate = yield* channel.closePopup(source, "child-1").pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              completed = true;
            }),
          ),
          Effect.forkScoped,
        );
        const newCommand = yield* Queue.take(next.commands);
        if (newCommand.type !== "closePopup") throw new Error("Expected deliberate close request");
        expect(newCommand.requestId).not.toBe(command.requestId);
        // A duplicate/stale veto must not cancel the new deliberate attempt.
        yield* channel.receiveEvent("socket-b", "host-a", cancellation);
        expect(completed).toBe(false);
        yield* channel.receiveEvent("socket-b", "host-a", {
          type: "popupClosed",
          ...key,
          popupId: "child-1",
        });
        yield* Fiber.join(deliberate);
        expect(completed).toBe(true);
      }).pipe(Effect.scoped),
  );

  it.effect("a timed-out transport retry preserves its native close attempt", () =>
    Effect.gen(function* () {
      const channel = yield* remoteChannel;
      const host = yield* connectHost(channel, "socket-a", "host-a");
      const source = { ...key, desktopHostId: "host-a" };
      const first = yield* channel
        .closePopup(source, "child-1")
        .pipe(Effect.flip, Effect.forkScoped);
      const command = yield* Queue.take(host.commands);
      if (command.type !== "closePopup") throw new Error("Expected close request");
      yield* TestClock.adjust("10 seconds");
      expect((yield* Fiber.join(first)).reason).toBe("host-unavailable");
      const retry = yield* channel
        .closePopup(source, "child-1")
        .pipe(Effect.flip, Effect.forkScoped);
      expect(yield* Queue.take(host.commands)).toEqual(command);
      yield* channel.receiveEvent("socket-a", "host-a", {
        type: "popupCloseCanceled",
        ...key,
        popupId: "child-1",
        requestId: command.requestId,
      });
      expect((yield* Fiber.join(retry)).reason).toBe("close-canceled");
    }).pipe(Effect.scoped),
  );

  it.effect(
    "host reconnect notifications include authenticated hosts without any popup replay",
    () =>
      Effect.gen(function* () {
        const channel = yield* remoteChannel;
        const first = yield* connectHost(channel, "socket-a", "host-a");
        const connected = yield* channel.connectedHosts.pipe(
          Stream.toQueue({ capacity: "unbounded" }),
        );
        expect(yield* Queue.take(connected)).toBe("host-a");
        const interruptedClose = yield* channel
          .closePopup({ ...key, desktopHostId: "host-a" }, "gone-offline")
          .pipe(Effect.flip, Effect.forkScoped);
        const firstCommand = yield* Queue.take(first.commands);
        yield* Fiber.interrupt(first.fiber);
        // Reconnect before joining the old failed close and retry the same native identity.
        const next = yield* connectHost(channel, "socket-b", "host-a");
        expect(yield* Queue.take(connected)).toBe("host-a");
        const closing = yield* channel
          .closePopup({ ...key, desktopHostId: "host-a" }, "gone-offline")
          .pipe(Effect.forkScoped);
        expect(yield* Queue.take(next.commands)).toEqual({
          type: "closePopup",
          ...key,
          popupId: "gone-offline",
          requestId: firstCommand.type === "closePopup" ? firstCommand.requestId : "unexpected",
        });
        yield* channel.receiveEvent("socket-b", "host-a", {
          type: "popupClosed",
          ...key,
          popupId: "gone-offline",
        });
        yield* Fiber.join(closing);
        expect((yield* Fiber.join(interruptedClose)).reason).toBe("host-unavailable");
      }).pipe(Effect.scoped),
  );

  it.effect("native close waits for destruction from the matching authenticated host", () =>
    Effect.gen(function* () {
      const channel = yield* remoteChannel;
      const host = yield* connectHost(channel, "socket-a", "host-a");
      yield* connectHost(channel, "socket-b", "host-b");
      const source = { ...key, desktopHostId: "host-a" };
      let completed = false;
      const closing = yield* channel.closePopup(source, "child-1").pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            completed = true;
          }),
        ),
        Effect.forkScoped,
      );
      expect(yield* Queue.take(host.commands)).toEqual({
        type: "closePopup",
        ...key,
        popupId: "child-1",
        requestId: expect.any(String),
      });
      expect(completed).toBe(false);
      // Another authenticated desktop's matching strings are a different window.
      yield* channel.receiveEvent("socket-b", "host-b", {
        type: "popupClosed",
        ...key,
        popupId: "child-1",
      });
      expect(completed).toBe(false);
      const rejected = yield* channel
        .receiveEvent("socket-b", "host-a", {
          type: "popupClosed",
          ...key,
          popupId: "child-1",
        })
        .pipe(Effect.flip);
      expect(rejected.reason).toBe("host-unavailable");
      yield* channel.receiveEvent("socket-a", "host-a", {
        type: "popupClosed",
        ...key,
        popupId: "child-1",
      });
      yield* Fiber.join(closing);
      expect(completed).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect.each(["canceled", "disconnected"] as const)(
    "native close reports a %s window instead of confirming destruction",
    (failure) =>
      Effect.gen(function* () {
        const channel = yield* remoteChannel;
        const host = yield* connectHost(channel, "socket-a", "host-a");
        const closing = yield* channel
          .closePopup({ ...key, desktopHostId: "host-a" }, "child-1")
          .pipe(Effect.flip, Effect.forkScoped);
        const command = yield* Queue.take(host.commands);
        if (command.type !== "closePopup") throw new Error("Expected native close request");
        if (failure === "canceled")
          yield* channel.receiveEvent("socket-a", "host-a", {
            type: "popupCloseCanceled",
            ...key,
            popupId: "child-1",
            requestId: command.requestId,
          });
        else yield* Fiber.interrupt(host.fiber);
        expect((yield* Fiber.join(closing)).reason).toBe(
          failure === "canceled" ? "close-canceled" : "host-unavailable",
        );
        if (failure === "disconnected") {
          const unavailable = yield* channel
            .closePopup({ ...key, desktopHostId: "host-a" }, "child-1")
            .pipe(Effect.flip);
          expect(unavailable.reason).toBe("host-unavailable");
        }
      }).pipe(Effect.scoped),
  );

  it.effect("routes popup bindings only through the attached source's authenticated owner", () =>
    Effect.gen(function* () {
      const channel = yield* remoteChannel;
      const owner = yield* connectHost(channel, "socket-a", "host-a");
      const other = yield* connectHost(channel, "socket-b", "host-b");
      const announcements = yield* channel.popups.pipe(Stream.toQueue({ capacity: "unbounded" }));
      const popup = {
        type: "popupCreated" as const,
        ...key,
        popupId: "child-1",
        url: "https://signin.example.test/",
      };
      yield* channel.receiveEvent("socket-a", "host-a", popup);
      expect(yield* Queue.size(announcements)).toBe(0);
      yield* channel.receiveEvent("socket-a", "host-a", { type: "attached", ...key });
      const rejected = yield* channel.receiveEvent("socket-b", "host-a", popup).pipe(Effect.flip);
      expect(rejected.reason).toBe("host-unavailable");
      yield* channel.receiveEvent("socket-a", "host-a", popup);
      expect(yield* Queue.take(announcements)).toEqual({
        ...key,
        desktopHostId: "host-a",
        popupId: "child-1",
        url: popup.url,
      });
      const child = { threadId: key.threadId, tabId: "child-tab", desktopHostId: "host-a" };
      yield* channel.bindPopup(child, { popupId: "child-1", openerTabId: key.tabId });
      expect(yield* Queue.take(owner.commands)).toEqual({
        type: "bindPopup",
        threadId: key.threadId,
        tabId: "child-tab",
        popupId: "child-1",
        openerTabId: key.tabId,
      });
      expect(yield* Queue.size(other.commands)).toBe(0);
      yield* channel.receiveEvent("socket-a", "host-a", {
        type: "attached",
        threadId: key.threadId,
        tabId: child.tabId,
        presented: true,
        supportsNativeSurface: true,
      });
      expect(channel.isPresented(child)).toBe(true);
      yield* Fiber.interrupt(owner.fiber);
      expect(channel.isPresented(child)).toBe(false);
      expect(yield* channel.isAttached(child)).toBe(false);
      const reconnected = yield* connectHost(channel, "socket-c", "host-a");
      yield* channel.receiveEvent("socket-c", "host-a", {
        type: "attached",
        threadId: key.threadId,
        tabId: child.tabId,
      });
      // The bound window can survive after its original opener has closed.
      yield* channel.receiveEvent("socket-c", "host-a", { ...popup, boundTabId: child.tabId });
      expect(yield* Queue.take(announcements)).toEqual({
        ...key,
        desktopHostId: "host-a",
        popupId: "child-1",
        url: popup.url,
      });
      const closing = yield* channel
        .closePopup({ ...key, desktopHostId: "host-a" }, popup.popupId)
        .pipe(Effect.forkScoped);
      expect(yield* Queue.take(reconnected.commands)).toEqual({
        type: "closePopup",
        ...key,
        popupId: "child-1",
        requestId: expect.any(String),
      });
      yield* channel.receiveEvent("socket-c", "host-a", {
        type: "popupClosed",
        ...key,
        popupId: "child-1",
      });
      yield* Fiber.join(closing);
    }).pipe(Effect.scoped),
  );

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
            viewport: { _tag: "fill" },
            viewportSize: { width: 390, height: 844 },
            zoomFactor: 1.25,
          },
        )
        .pipe(Effect.forkScoped);
      const command = yield* Queue.take(first.commands);
      if (command.type !== "surface") throw new Error("Expected surface request");
      expect(command).toMatchObject({
        viewport: { _tag: "fill" },
        viewportSize: { width: 390, height: 844 },
        zoomFactor: 1.25,
      });
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

  it.effect(
    "selects an exact catalogue owner with two desktops and never substitutes a disconnected owner",
    () =>
      Effect.gen(function* () {
        const channel = yield* remoteChannel;
        const first = yield* connectHost(channel, "socket-a", "host-a");
        const second = yield* connectHost(channel, "socket-b", "host-b");
        const input = { threadId: "thread-1", agentSessionId: "agent-1", desktopHostId: "host-b" };
        const request = yield* channel.getProfiles(input).pipe(Effect.forkScoped);
        const command = yield* Queue.take(second.commands);
        if (command.type !== "profiles") throw new Error("Expected profile catalogue request");
        expect(yield* Queue.size(first.commands)).toBe(0);
        const catalogue = {
          profiles: [{ id: "work", name: "Work", kind: "persistent" as const }],
          defaultProfileId: "work",
        };
        yield* channel.receiveEvent("socket-b", "host-b", {
          type: "profiles",
          requestId: command.requestId,
          profiles: catalogue,
        });
        expect(yield* Fiber.join(request)).toEqual({ ...catalogue, desktopHostId: "host-b" });
        yield* Fiber.interrupt(second.fiber);
        expect(yield* channel.getProfiles(input)).toBeNull();
        expect(yield* Queue.size(first.commands)).toBe(0);
        expect(yield* channel.getProfiles({ ...input, desktopHostId: "local" })).toBeNull();
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
