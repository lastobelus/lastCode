// @effect-diagnostics nodeBuiltinImport:off - Bridges Playwright's WebSocket transport to the desktop's fds.
/**
 * The server end of the desktop browser channel (see `DesktopBrowserEvent`).
 *
 * Playwright connects over CDP only through a WebSocket URL, so each attached
 * desktop tab gets a loopback endpoint with an unguessable path. Its frames
 * cross the bootstrap file descriptors to the desktop's relay, which owns the
 * tab's `webContents.debugger`. The endpoint only bridges to that one tab.
 */
import * as NodeStream from "@effect/platform-node/NodeStream";
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import {
  DESKTOP_BROWSER_DOWNLOAD_MAX_BYTES,
  DesktopBrowserCommand,
  DesktopBrowserEvent,
  DesktopBrowserTransportError,
  type DesktopBrowserEvent as DesktopBrowserEventType,
  type PreviewAutomationProfiles,
  type PreviewViewportSetting,
  type DesktopBrowserCommand as DesktopBrowserCommandType,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Ndjson from "effect/encoding/Ndjson";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as ServerConfig from "../config.ts";
import { writeAllToFileDescriptor } from "../resourceTelemetry/DesktopTelemetryReceiver.ts";

const decodeEvent = Schema.decodeUnknownEffect(DesktopBrowserEvent);
const decodeCdpEvent = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      method: Schema.String,
      params: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const encodeCommand = Schema.encodeEffect(Schema.fromJsonString(DesktopBrowserCommand));

export interface DesktopTabKey {
  readonly threadId: string;
  readonly tabId: string;
  readonly desktopHostId?: string | undefined;
}

const keyOf = ({ threadId, tabId, desktopHostId = "local" }: DesktopTabKey) =>
  JSON.stringify([desktopHostId, threadId, tabId]);

export class DesktopBrowserChannel extends Context.Service<
  DesktopBrowserChannel,
  {
    /** False when this server was not started by a desktop app. */
    readonly available: boolean;
    readonly resolveUrl: (input: {
      readonly desktopHostId: string;
      readonly threadId: string;
      readonly url: string;
    }) => Effect.Effect<string | null>;
    readonly getProfiles: (input: {
      readonly threadId: string;
      readonly agentSessionId: string;
    }) => Effect.Effect<(PreviewAutomationProfiles & { readonly desktopHostId: string }) | null>;
    readonly subscribeCommands: (
      owner: string,
      desktopHostId: string,
    ) => Stream.Stream<DesktopBrowserCommandType, DesktopBrowserTransportError>;
    readonly receiveEvent: (
      owner: string,
      desktopHostId: string,
      event: DesktopBrowserEventType,
    ) => Effect.Effect<void, DesktopBrowserTransportError>;
    /**
     * Waits for a tab to be attached. Subscribes before it checks, so an
     * attach landing in between is never missed. False after `timeout`.
     */
    readonly awaitAttached: (key: DesktopTabKey, timeout: Duration.Input) => Effect.Effect<boolean>;
    /** Desktop tabs as they detach. */
    readonly detached: Stream.Stream<DesktopTabKey>;
    readonly isAttached: (key: DesktopTabKey) => Effect.Effect<boolean>;
    /** Keeps a native guest paintable until the matching lease is released. */
    readonly surface: (
      key: DesktopTabKey,
      input: {
        readonly leaseId: string;
        readonly action: "acquire" | "release";
        readonly viewport?: PreviewViewportSetting;
        readonly timeoutMs?: number;
      },
      timeoutMs?: number,
    ) => Effect.Effect<
      { readonly width: number; readonly height: number } | null,
      DesktopBrowserTransportError
    >;
    /**
     * A one-connection CDP endpoint for an attached tab. Closing the scope
     * releases the tab on the desktop and stops the endpoint.
     */
    readonly endpoint: (key: DesktopTabKey) => Effect.Effect<string, never, Scope.Scope>;
    /** Draws the agent's cursor over a tab the desktop renders. */
    readonly pointer: (
      key: DesktopTabKey,
      pointer: { readonly phase: "move" | "click"; readonly x: number; readonly y: number },
    ) => Effect.Effect<void>;
  }
>()("t3/preview/DesktopBrowserChannel") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const inputFd = config.desktopBrowserFd;
  const controlFd = config.desktopBrowserControlFd;
  const changes = yield* PubSub.unbounded<{ key: DesktopTabKey; attached: boolean }>();
  const attachedTabs = new Map<string, DesktopTabKey & { supportsNativeSurface: boolean }>();
  const profileRequests = new Map<string, Deferred.Deferred<PreviewAutomationProfiles | null>>();
  /** CDP frames from the desktop, per tab, for the endpoint connected to it. */
  const inbound = new Map<string, Queue.Queue<string>>();
  const writeLock = yield* Semaphore.make(1);

  const localAvailable = inputFd !== undefined && controlFd !== undefined;
  const hosts = new Map<
    string,
    { owner: string; queue: Queue.Queue<DesktopBrowserCommandType>; lock: Semaphore.Semaphore }
  >();
  const profileOwners = new Map<string, string>();
  const urlRequests = new Map<
    string,
    { desktopHostId: string; deferred: Deferred.Deferred<string | null> }
  >();
  const downloadDirectories = new Map<string, string>();
  const downloadOffsets = new Map<string, Map<string, number>>();
  const completedDownloads = new Map<string, Set<string>>();
  const failedDownloads = new Map<string, Set<string>>();
  const surfaceRequests = new Map<
    string,
    {
      key: DesktopTabKey;
      deferred: Deferred.Deferred<
        { readonly width: number; readonly height: number } | null,
        DesktopBrowserTransportError
      >;
    }
  >();

  const command = (message: DesktopBrowserCommandType, desktopHostId = "local") => {
    if (desktopHostId !== "local") {
      const host = hosts.get(desktopHostId);
      return host ? Queue.offer(host.queue, message).pipe(Effect.asVoid) : Effect.void;
    }
    if (controlFd === undefined) return Effect.void;
    return writeLock.withPermits(1)(
      encodeCommand(message).pipe(
        Effect.flatMap((line) => writeAllToFileDescriptor(controlFd, Buffer.from(`${line}\n`))),
        Effect.catchCause((cause) =>
          Effect.logWarning("desktop browser command failed", { cause }),
        ),
      ),
    );
  };

  const failSurfaceRequests = (id: string) =>
    Effect.forEach(
      [...surfaceRequests.values()].filter((pending) => keyOf(pending.key) === id),
      (pending) =>
        Deferred.fail(
          pending.deferred,
          new DesktopBrowserTransportError({ reason: "guest-unavailable" }),
        ),
      { discard: true },
    );

  const handleEvent = (
    desktopHostId: string,
    event: DesktopBrowserEventType,
  ): Effect.Effect<void, DesktopBrowserTransportError> => {
    if (event.type === "resolvedUrl") {
      const pending = urlRequests.get(event.requestId);
      return pending?.desktopHostId === desktopHostId
        ? Deferred.succeed(pending.deferred, event.url).pipe(Effect.asVoid)
        : Effect.void;
    }
    if (event.type === "profiles") {
      const pending = profileRequests.get(event.requestId);
      return pending && profileOwners.get(event.requestId) === desktopHostId
        ? Deferred.succeed(pending, event.profiles).pipe(Effect.asVoid)
        : Effect.void;
    }
    const key = { threadId: event.threadId, tabId: event.tabId, desktopHostId };
    const id = keyOf(key);
    if (event.type === "surfaceReady") {
      const pending = surfaceRequests.get(event.requestId);
      if (!pending || keyOf(pending.key) !== id) return Effect.void;
      return (
        event.reason
          ? Deferred.fail(
              pending.deferred,
              new DesktopBrowserTransportError({ reason: event.reason }),
            )
          : Deferred.succeed(pending.deferred, event.viewport)
      ).pipe(Effect.asVoid);
    }
    switch (event.type) {
      case "download": {
        const directory = downloadDirectories.get(id);
        const offsets = downloadOffsets.get(id) ?? new Map<string, number>();
        const offset = offsets.get(event.guid) ?? 0;
        // A remote host may only write the current connection's download, in
        // the directory requested by Playwright, with bounded ordered chunks.
        const bytes = Buffer.from(event.data, "base64");
        if (
          !directory ||
          failedDownloads.get(id)?.has(event.guid) ||
          !attachedTabs.has(id) ||
          !/^[a-zA-Z0-9-]{1,128}$/.test(event.guid) ||
          event.offset !== offset ||
          bytes.toString("base64") !== event.data ||
          offset + bytes.length > DESKTOP_BROWSER_DOWNLOAD_MAX_BYTES
        ) {
          return Effect.fail(
            new DesktopBrowserTransportError({ reason: "download-transfer-failed" }),
          );
        }
        return Effect.tryPromise({
          try: async () => {
            await NodeFSP.mkdir(directory, { recursive: true });
            await NodeFSP.writeFile(NodePath.join(directory, event.guid), bytes, {
              flag: offset === 0 ? "w" : "a",
            });
            if (event.done) {
              offsets.delete(event.guid);
              const completed = completedDownloads.get(id) ?? new Set<string>();
              completed.add(event.guid);
              completedDownloads.set(id, completed);
            } else offsets.set(event.guid, offset + bytes.length);
            downloadOffsets.set(id, offsets);
          },
          catch: () => new DesktopBrowserTransportError({ reason: "download-transfer-failed" }),
        });
      }
      case "cdp": {
        const queue = inbound.get(id);
        if (!queue) return Effect.void;
        const decoded = decodeCdpEvent(event.message);
        if (
          desktopHostId !== "local" &&
          Option.isSome(decoded) &&
          decoded.value.method === "Browser.downloadProgress" &&
          decoded.value.params?.state === "completed"
        ) {
          const guid = decoded.value.params.guid;
          if (typeof guid !== "string" || !completedDownloads.get(id)?.has(guid)) {
            return Queue.offer(
              queue,
              encodeJson({
                ...decoded.value,
                params: { ...decoded.value.params, state: "canceled" },
              }),
            ).pipe(Effect.asVoid);
          }
        }
        return Queue.offer(queue, event.message).pipe(Effect.asVoid);
      }
      case "attached": {
        // A replacement or re-announcement must not inherit the previous guest's capability or lease.
        const pending = failSurfaceRequests(id);
        attachedTabs.set(id, {
          ...key,
          supportsNativeSurface: event.supportsNativeSurface === true,
        });
        return pending.pipe(
          Effect.andThen(PubSub.publish(changes, { key, attached: true })),
          Effect.asVoid,
        );
      }
      case "detached": {
        attachedTabs.delete(id);
        downloadDirectories.delete(id);
        downloadOffsets.delete(id);
        completedDownloads.delete(id);
        failedDownloads.delete(id);
        const queue = inbound.get(id);
        return failSurfaceRequests(id).pipe(
          Effect.andThen(queue ? Queue.shutdown(queue) : Effect.void),
          Effect.andThen(PubSub.publish(changes, { key, attached: false })),
          Effect.asVoid,
        );
      }
    }
  };

  const releaseHost = (desktopHostId: string) =>
    Effect.gen(function* () {
      for (const key of [...attachedTabs.values()]) {
        if (key.desktopHostId === desktopHostId) {
          yield* handleEvent(desktopHostId, {
            type: "detached",
            threadId: key.threadId,
            tabId: key.tabId,
          });
        }
      }
      for (const pending of urlRequests.values()) {
        if (pending.desktopHostId === desktopHostId)
          yield* Deferred.succeed(pending.deferred, null);
      }
      for (const [requestId, host] of profileOwners) {
        const pending = profileRequests.get(requestId);
        if (host === desktopHostId && pending) yield* Deferred.succeed(pending, null);
      }
    });

  if (localAvailable) {
    const readable = yield* Effect.acquireRelease(
      Effect.sync(() => NodeFS.createReadStream("", { fd: inputFd, autoClose: true })),
      (stream) => Effect.sync(() => stream.destroy()),
    );
    yield* NodeStream.fromReadable<Uint8Array, Error>({
      evaluate: () => readable,
      closeOnDone: true,
      onError: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    }).pipe(
      Stream.pipeThroughChannel(Ndjson.decode({ ignoreEmptyLines: true })),
      Stream.mapEffect((value) => decodeEvent(value).pipe(Effect.option)),
      Stream.runForEach((decoded) =>
        Option.isSome(decoded) ? handleEvent("local", decoded.value) : Effect.void,
      ),
      Effect.catchCause((cause) => Effect.logWarning("desktop browser channel stopped", { cause })),
      Effect.forkScoped,
    );
  }

  const relayFrame = (key: DesktopTabKey, message: string) => {
    if (key.desktopHostId && key.desktopHostId !== "local") {
      try {
        const frame = JSON.parse(message) as {
          method?: string;
          params?: { downloadPath?: unknown; behavior?: string };
        };
        if (frame.method === "Browser.setDownloadBehavior") {
          const directory = frame.params?.downloadPath;
          if (
            typeof directory === "string" &&
            NodePath.isAbsolute(directory) &&
            frame.params?.behavior !== "deny"
          ) {
            downloadDirectories.set(keyOf(key), directory);
          } else downloadDirectories.delete(keyOf(key));
        }
      } catch {
        /* Malformed CDP frames are handled by the desktop relay. */
      }
    }
    return command(
      { type: "cdp", threadId: key.threadId, tabId: key.tabId, message },
      key.desktopHostId,
    );
  };

  const endpoint = (key: DesktopTabKey) =>
    Effect.gen(function* () {
      const id = keyOf(key);
      const secret = NodeCrypto.randomBytes(24).toString("base64url");
      const server = yield* NodeSocketServer.makeWebSocket({
        host: "127.0.0.1",
        port: 0,
        path: `/${secret}`,
      }).pipe(Effect.orDie);
      const queue = yield* Queue.unbounded<string>();
      inbound.set(id, queue);
      // A detach before this registration shut down no queue, so check again.
      if (!attachedTabs.has(id)) {
        inbound.delete(id);
        return yield* Effect.die("The desktop tab detached before the server connected.");
      }
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          if (inbound.get(id) === queue) {
            inbound.delete(id);
            downloadDirectories.delete(id);
          }
          yield* Queue.shutdown(queue);
          yield* command(
            { type: "release", threadId: key.threadId, tabId: key.tabId },
            key.desktopHostId,
          );
        }),
      );
      // The relay serves one Playwright connection; a second would see the first's sessions.
      let connected = false;
      yield* server
        .run((socket) =>
          Effect.gen(function* () {
            if (connected) return;
            connected = true;
            const writer = yield* socket.writer;
            const reader = yield* socket.reader;
            const outgoing = Stream.fromQueue(queue).pipe(
              Stream.runForEach((message) => writer.write(message)),
            );
            const decoder = new TextDecoder();
            const incoming = reader.pull.pipe(
              Effect.flatMap((frames) =>
                Effect.forEach(
                  frames,
                  (frame) =>
                    relayFrame(key, typeof frame === "string" ? frame : decoder.decode(frame)),
                  { discard: true },
                ),
              ),
              Effect.forever,
            );
            return yield* Effect.raceFirst(incoming, outgoing);
          }).pipe(Effect.scoped, Effect.ignore),
        )
        .pipe(Effect.forkScoped);
      const address = server.address;
      if (address._tag !== "InetAddressV4") return yield* Effect.die("Unexpected relay address.");
      return `ws://127.0.0.1:${address.port}/${secret}`;
    });

  return DesktopBrowserChannel.of({
    get available() {
      return localAvailable || hosts.size > 0;
    },
    subscribeCommands: (owner, desktopHostId) =>
      Stream.unwrap(
        Effect.gen(function* () {
          if (desktopHostId === "local" || hosts.has(desktopHostId)) {
            return yield* new DesktopBrowserTransportError({ reason: "host-unavailable" });
          }
          const queue = yield* Queue.unbounded<DesktopBrowserCommandType>();
          const lock = yield* Semaphore.make(1);
          const host = { owner, queue, lock };
          hosts.set(desktopHostId, host);
          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              if (hosts.get(desktopHostId) !== host) return;
              hosts.delete(desktopHostId);
              yield* releaseHost(desktopHostId).pipe(Effect.ignore);
              yield* Queue.shutdown(queue);
            }),
          );
          yield* Queue.offer(queue, { type: "announce" });
          return Stream.fromQueue(queue);
        }),
      ),
    receiveEvent: (owner, desktopHostId, event) =>
      Effect.suspend(() => {
        const host = hosts.get(desktopHostId);
        if (host?.owner !== owner) {
          return Effect.fail(new DesktopBrowserTransportError({ reason: "host-unavailable" }));
        }
        return host.lock.withPermits(1)(
          Effect.suspend(() => handleEvent(desktopHostId, event)).pipe(
            Effect.tapError(() => {
              if (event.type !== "download") return Effect.void;
              const id = keyOf({ ...event, desktopHostId });
              const failed = failedDownloads.get(id) ?? new Set<string>();
              failed.add(event.guid);
              failedDownloads.set(id, failed);
              completedDownloads.get(id)?.delete(event.guid);
              downloadOffsets.get(id)?.delete(event.guid);
              const directory = downloadDirectories.get(id);
              const queue = inbound.get(id);
              return Effect.gen(function* () {
                if (directory && /^[a-zA-Z0-9-]{1,128}$/.test(event.guid)) {
                  yield* Effect.promise(() =>
                    NodeFSP.rm(NodePath.join(directory, event.guid), { force: true }).catch(
                      () => undefined,
                    ),
                  );
                }
                if (queue)
                  yield* Queue.offer(
                    queue,
                    encodeJson({
                      method: "Browser.downloadProgress",
                      params: { guid: event.guid, state: "canceled" },
                    }),
                  );
              });
            }),
          ),
        );
      }),
    resolveUrl: ({ desktopHostId, url }) =>
      Effect.gen(function* () {
        if (desktopHostId === "local") return url;
        if (!hosts.has(desktopHostId)) return null;
        const requestId = NodeCrypto.randomUUID();
        const deferred = yield* Deferred.make<string | null>();
        urlRequests.set(requestId, { desktopHostId, deferred });
        return yield* command({ type: "resolveUrl", requestId, url }, desktopHostId).pipe(
          Effect.andThen(Deferred.await(deferred)),
          Effect.timeoutOption("5 seconds"),
          Effect.map((result) => Option.getOrElse(result, () => null)),
          Effect.ensuring(Effect.sync(() => urlRequests.delete(requestId))),
        );
      }),
    getProfiles: () =>
      Effect.gen(function* () {
        const desktopHostId = localAvailable
          ? "local"
          : hosts.size === 1
            ? [...hosts.keys()][0]
            : undefined;
        if (!desktopHostId) return null;
        const requestId = NodeCrypto.randomUUID();
        const deferred = yield* Deferred.make<PreviewAutomationProfiles | null>();
        profileRequests.set(requestId, deferred);
        profileOwners.set(requestId, desktopHostId);
        return yield* command({ type: "profiles", requestId }, desktopHostId).pipe(
          Effect.andThen(Deferred.await(deferred)),
          Effect.timeoutOption("5 seconds"),
          Effect.map((result) => {
            const profiles = Option.getOrElse(result, () => null);
            return profiles ? { ...profiles, desktopHostId } : null;
          }),
          Effect.ensuring(
            Effect.sync(() => {
              profileRequests.delete(requestId);
              profileOwners.delete(requestId);
            }),
          ),
        );
      }),
    awaitAttached: (key, timeout) =>
      Effect.scoped(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          if (attachedTabs.has(keyOf(key))) return true;
          return yield* Stream.fromSubscription(subscription).pipe(
            Stream.filter((change) => change.attached && keyOf(change.key) === keyOf(key)),
            Stream.runHead,
            Effect.map(Option.isSome),
            Effect.timeoutOption(timeout),
            Effect.map((result) => Option.getOrElse(result, () => false)),
          );
        }),
      ),
    detached: Stream.fromPubSub(changes).pipe(
      Stream.filter((change) => !change.attached),
      Stream.map((change) => change.key),
    ),
    isAttached: (key) => Effect.sync(() => attachedTabs.has(keyOf(key))),
    surface: (key, input, timeoutMs = 2_500) =>
      Effect.gen(function* () {
        const attached = attachedTabs.get(keyOf(key));
        if (!attached) {
          return yield* new DesktopBrowserTransportError({ reason: "guest-unavailable" });
        }
        if (!attached.supportsNativeSurface) {
          return yield* new DesktopBrowserTransportError({ reason: "surface-unsupported" });
        }
        const requestId = NodeCrypto.randomUUID();
        const deferred = yield* Deferred.make<
          { readonly width: number; readonly height: number } | null,
          DesktopBrowserTransportError
        >();
        surfaceRequests.set(requestId, { key, deferred });
        return yield* command(
          { type: "surface", ...key, ...input, requestId },
          key.desktopHostId,
        ).pipe(
          Effect.andThen(Deferred.await(deferred)),
          Effect.timeoutOrElse({
            duration: Duration.millis(Math.max(1, timeoutMs)),
            orElse: () =>
              Effect.fail(new DesktopBrowserTransportError({ reason: "layout-timeout" })),
          }),
          Effect.onError(() =>
            input.action === "acquire" && attachedTabs.get(keyOf(key)) === attached
              ? command(
                  {
                    type: "surface",
                    ...key,
                    requestId: NodeCrypto.randomUUID(),
                    leaseId: input.leaseId,
                    action: "release",
                  },
                  key.desktopHostId,
                )
              : Effect.void,
          ),
          Effect.ensuring(Effect.sync(() => surfaceRequests.delete(requestId))),
        );
      }),
    endpoint,
    pointer: (key, pointer) =>
      command(
        { type: "pointer", threadId: key.threadId, tabId: key.tabId, ...pointer },
        key.desktopHostId,
      ),
  });
});

export const layer = Layer.effect(DesktopBrowserChannel, make);
