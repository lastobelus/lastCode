import * as Queue from "effect/Queue";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
// @effect-diagnostics nodeBuiltinImport:off - Stands in for an Electron debugger.
import { describe, expect, it } from "@effect/vitest";
import { DesktopBrowserEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";

import * as DesktopBrowserHost from "./DesktopBrowserHost.ts";

const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(DesktopBrowserEvent));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeCdpReply = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ id: Schema.Number })),
);
const key = { threadId: "thread-1", tabId: "tab-1" };

/** A tab's webContents and debugger, with the debugger's commands left pending until released. */
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
  const webContents = {
    getURL: () => "http://localhost/",
    getTitle: () => "Page",
    getUserAgent: () => "Electron",
  };
  return {
    tab: {
      webContents: webContents as unknown as Electron.WebContents,
      debugger: debuggee as unknown as Electron.Debugger,
    },
    emit: (method: string, params: unknown) => emitter.emit("message", {}, method, params, ""),
    release: () => pending.splice(0).forEach((resolve) => resolve()),
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
  it.effect("announces tabs already attached to a backend that starts later", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make.pipe(
        Effect.provide(DesktopClientSettings.layerTest()),
      );
      host.attach(key, makeDebuggee().tab);
      // A restarted backend subscribes after the attach and still hears it.
      expect(yield* takeEvents(host, 1)).toEqual([{ type: "attached", ...key }]);
      expect(yield* takeEvents(host, 1)).toEqual([{ type: "attached", ...key }]);
    }),
  );

  it.effect("drops replies from a relay the server released", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make.pipe(
        Effect.provide(DesktopClientSettings.layerTest()),
      );
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
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
      host.attach(key, debuggee.tab);
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
      host.attach(remoteKey, makeDebuggee().tab);
      yield* host.handleRemoteCommand({ desktopHostId: "remote-a", command: { type: "announce" } });
      expect((yield* pull).every((event) => event.desktopHostId === "remote-a")).toBe(true);
      // Local FD announcements must never expose a remote environment's tabs.
      host.attach(key, makeDebuggee().tab);
      expect(yield* takeEvents(host, 1)).toEqual([{ type: "attached", ...key }]);
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
    host.attach(remoteKey, { webContents, debugger: debuggee as unknown as Electron.Debugger });
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
