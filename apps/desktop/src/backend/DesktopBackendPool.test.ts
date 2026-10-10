import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Sink from "effect/Sink";
import * as Path from "effect/Path";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import { DesktopBrowserEvent } from "@t3tools/contracts";
import * as NodeEvents from "node:events";
import { ChildProcessSpawner } from "effect/process";

import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopTelemetryPublisher from "../telemetry/DesktopTelemetryPublisher.ts";
import * as DesktopBrowserHost from "../preview/DesktopBrowserHost.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopWslEnvironment from "../wsl/DesktopWslEnvironment.ts";
import * as DesktopBackendConfiguration from "./DesktopBackendConfiguration.ts";
import * as DesktopBackendPool from "./DesktopBackendPool.ts";
import type { DesktopBackendSnapshot, DesktopBackendStartConfig } from "./DesktopBackendManager.ts";

const decodeBrowserEvent = Schema.decodeEffect(Schema.fromJsonString(DesktopBrowserEvent));

function makeStubInstance(
  id: DesktopBackendPool.BackendInstanceId,
  label: string,
): DesktopBackendPool.DesktopBackendInstance {
  const snapshot: DesktopBackendSnapshot = {
    desiredRunning: false,
    ready: false,
    activePid: Option.none(),
    restartAttempt: 0,
    restartScheduled: false,
  };
  return {
    id,
    label: Effect.succeed(label),
    start: Effect.void,
    stop: () => Effect.void,
    currentConfig: Effect.succeed(Option.none<DesktopBackendStartConfig>()),
    snapshot: Effect.succeed(snapshot),
    waitForReady: (_timeout: Duration.Duration) => Effect.succeed(false),
  };
}

function makeHiddenBrowserRoot() {
  let destroyed = false;
  let attached = false;
  const debuggerApi = Object.assign(new NodeEvents.EventEmitter(), {
    isAttached: () => attached,
    attach: () => {
      attached = true;
    },
    detach: () => {
      attached = false;
    },
    sendCommand: async () => ({}),
  });
  const webContents = Object.assign(new NodeEvents.EventEmitter(), {
    debugger: debuggerApi,
    isDestroyed: () => destroyed,
    getURL: () => "about:blank",
    getTitle: () => "",
    setWindowOpenHandler: () => undefined,
    setZoomFactor: () => undefined,
    getZoomFactor: () => 1,
  });
  const window = Object.assign(new NodeEvents.EventEmitter(), {
    webContents,
    isDestroyed: () => destroyed,
    isVisible: () => false,
    isFocused: () => false,
    isFocusable: () => false,
    isMinimized: () => false,
    getContentSize: () => [390, 844],
    loadURL: async () => undefined,
    destroy: () => {
      destroyed = true;
      window.emit("closed");
    },
  });
  return window as unknown as Electron.BrowserWindow;
}

function layerPool(
  labelRef: Ref.Ref<string>,
  options?: {
    readonly spawn: ChildProcessSpawner.ChildProcessSpawner["Service"];
    readonly config: DesktopBackendStartConfig;
    readonly showErrorBox: ElectronDialog.ElectronDialog["Service"]["showErrorBox"];
    readonly persistFailure: Effect.Effect<void>;
    readonly readFileString?: FileSystem.FileSystem["readFileString"];
  },
): Layer.Layer<DesktopBackendPool.DesktopBackendPool | DesktopBrowserHost.DesktopBrowserHost> {
  return DesktopBackendPool.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        FileSystem.layerNoop({
          exists: () => Effect.succeed(true),
          ...(options?.readFileString ? { readFileString: options.readFileString } : {}),
        }),
        Path.layer,
        NodeCrypto.layer,
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          options?.spawn ??
            ChildProcessSpawner.make(() => Effect.die("unexpected child process spawn")),
        ),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.never),
        ),
        Layer.succeed(DesktopObservability.DesktopBackendOutputLogFactory, {
          forInstance: () =>
            Effect.succeed({
              beginSession: () => Effect.void,
              writeOutputChunk: () => Effect.void,
              persistFailureSnapshot: () => Effect.void,
              persistFailure: () => options?.persistFailure ?? Effect.void,
              discardSession: Effect.void,
            } satisfies DesktopObservability.DesktopBackendOutputLogShape),
        } satisfies DesktopObservability.DesktopBackendOutputLogFactory["Service"]),
        Layer.succeed(DesktopTelemetryPublisher.DesktopTelemetryPublisher, {
          latest: Effect.succeedNone,
          changes: Stream.empty,
          encoded: Stream.empty,
          handleControlForSource: () => Effect.void,
          removeControlSource: () => Effect.void,
          publishUpdateReport: () => Effect.void,
          updateRequests: Stream.empty,
          updateCommits: Stream.empty,
          updateCancellations: Stream.empty,
        }),
        DesktopBrowserHost.layer.pipe(Layer.provide(DesktopClientSettings.layerTest())),
        Layer.succeed(DesktopBackendConfiguration.DesktopBackendConfiguration, {
          resolvePrimary: options
            ? Effect.succeed(options.config)
            : Effect.die("unexpected primary config resolve"),
          resolvePrimaryLabel: Ref.get(labelRef),
          resolveWsl: () => Effect.die("unexpected WSL config resolve"),
          currentBootstrapToken: Effect.die("unexpected bootstrap token read"),
        } satisfies DesktopBackendConfiguration.DesktopBackendConfiguration["Service"]),
        DesktopEnvironment.layer({
          dirname: "/repo/apps/desktop/src",
          homeDirectory: "/home/example",
          platform: "darwin",
          processArch: "arm64",
          appVersion: "1.2.3",
          appPath: "/repo",
          isPackaged: true,
          resourcesPath: "/resources",
          runningUnderArm64Translation: false,
        }).pipe(
          Layer.provide(Layer.mergeAll(Path.layer, DesktopConfig.layerTest({}))),
          Layer.orDie,
        ),
        DesktopAppSettings.layerTest(),
        DesktopWslEnvironment.layerTest(),
        Layer.succeed(ElectronDialog.ElectronDialog, {
          ...ElectronDialog.make,
          showErrorBox: options?.showErrorBox ?? ElectronDialog.make.showErrorBox,
        }),
        Layer.succeed(DesktopWindow.DesktopWindow, {
          createMain: Effect.die("unexpected window create"),
          ensureMain: Effect.die("unexpected window ensure"),
          revealOrCreateMain: Effect.die("unexpected window reveal"),
          activate: Effect.die("unexpected window activate"),
          createMainIfBackendReady: Effect.die("unexpected window create"),
          showConnectingSplash: Effect.void,
          handleBackendReady: () => Effect.void,
          handleBackendNotReady: Effect.void,
          flushMainWindowBounds: Effect.void,
          prepareCaptureReveal: Effect.void,
          dispatchMenuAction: () => Effect.die("unexpected menu action"),
          dispatchSnapShotEvent: () => Effect.void,
          zoomMain: () => Effect.die("unexpected zoom"),
          runMainContentsCommand: () => Effect.die("unexpected main contents command"),
          runningActionCount: Effect.succeed(0),
          reportRunningActionCount: () => Effect.void,
          acknowledgeRunningActionQuitWarning: Effect.void,
          consumeRunningActionQuitWarningAcknowledgment: Effect.succeed(false),
          syncAppearance: Effect.void,
        } satisfies DesktopWindow.DesktopWindow["Service"]),
      ),
    ),
  );
}

describe("DesktopBackendPool", () => {
  it.effect("creates inherited-fd browser roots before a main window or renderer mounts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const label = yield* Ref.make("Local");
        const identityRequested = yield* Deferred.make<void>();
        const identity = yield* Deferred.make<string>();
        const roots =
          yield* Queue.unbounded<Extract<DesktopBrowserEvent, { type: "rootCreated" }>>();
        const remoteRoots = yield* Queue.unbounded<DesktopBrowserEvent>();
        const created: Array<{
          environmentId: string;
          profileId: string;
          partition: { scope: string; persistent: boolean };
        }> = [];
        let factoryInstalled = false;
        let identityReads = 0;
        const root = makeHiddenBrowserRoot();
        const command = {
          type: "createRoot" as const,
          threadId: "thread-1",
          tabId: "tab-1",
          serverEpoch: "server-epoch-1",
          requestId: "create-root",
          profileId: "default",
          url: "https://fixture.example/",
        };
        const poolLayer = layerPool(label, {
          config: {
            executablePath: "/electron",
            args: ["/server/bin.mjs"],
            entryPath: "/server/bin.mjs",
            cwd: "/server",
            env: {},
            extendEnv: true,
            captureOutput: true,
            httpBaseUrl: new URL("http://127.0.0.1:3773"),
            preflightFailure: Option.none(),
            bootstrapDelivery: "fd3",
            bootstrap: {
              mode: "desktop",
              noBrowser: true,
              port: 3773,
              t3Home: "/home/example/.lastcode",
              host: "127.0.0.1",
              desktopBootstrapToken: "test-token",
              tailscaleServeEnabled: false,
              tailscaleServePort: 443,
              desktopBrowserFd: 6,
              desktopBrowserControlFd: 7,
            },
          },
          readFileString: (path) =>
            Effect.gen(function* () {
              assert.equal(path, "/home/example/.lastcode/userdata/environment-id");
              identityReads += 1;
              yield* Deferred.succeed(identityRequested, void 0);
              return yield* Deferred.await(identity);
            }),
          spawn: ChildProcessSpawner.make((process) =>
            Effect.gen(function* () {
              const closed = yield* Deferred.make<void>();
              yield* Effect.addFinalizer(() => Deferred.succeed(closed, void 0));
              assert.isTrue(factoryInstalled);
              if (process._tag !== "StandardCommand") throw new Error("Expected standard command");
              const browserEvents = process.options.additionalFds?.fd6;
              if (browserEvents?.type !== "input")
                throw new Error("Expected inherited browser input fd");
              const browserSink = Sink.forEach((chunk: Uint8Array) =>
                decodeBrowserEvent(new TextDecoder().decode(chunk).trim()).pipe(
                  Effect.flatMap((event) =>
                    event.type === "rootCreated" ? Queue.offer(roots, event) : Effect.void,
                  ),
                  Effect.asVoid,
                  Effect.orDie,
                ),
              );
              return ChildProcessSpawner.makeHandle({
                pid: ChildProcessSpawner.ProcessId(123),
                stdout: Stream.empty,
                stderr: Stream.empty,
                all: Stream.empty,
                exitCode: Deferred.await(closed).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
                isRunning: Effect.succeed(false),
                kill: () => Effect.void,
                stdin: Sink.drain,
                getInputFd: (fd) => (fd === 6 ? browserSink : Sink.drain),
                getOutputFd: (fd) =>
                  fd === 7
                    ? Stream.encodeText(Stream.make(`${JSON.stringify(command)}\n`))
                    : Stream.empty,
                unref: Effect.succeed(Effect.void),
              });
            }),
          ),
          persistFailure: Effect.void,
          showErrorBox: () => Effect.die("Unexpected startup failure"),
        });
        yield* Effect.gen(function* () {
          const pool = yield* DesktopBackendPool.DesktopBackendPool;
          const host = yield* DesktopBrowserHost.DesktopBrowserHost;
          host.setRootFactory((input) =>
            Effect.sync(() => {
              created.push(input);
              return root;
            }),
          );
          factoryInstalled = true;
          yield* host.remoteEvents.pipe(
            Stream.runForEach(({ event }) => Queue.offer(remoteRoots, event)),
            Effect.forkScoped({ startImmediately: true }),
          );
          yield* host.handleRemoteCommand({ desktopHostId: "remote-unbound", command });
          assert.deepInclude(yield* Queue.take(remoteRoots), {
            type: "rootCreated",
            rootId: null,
            reason: "guest-unavailable",
          });
          yield* (yield* pool.primary).start;
          yield* Deferred.await(identityRequested);
          assert.lengthOf(created, 0);
          yield* Deferred.succeed(identity, "native-environment\n");
          const event = yield* Queue.take(roots);
          assert.isString(event.rootId);
          assert.isUndefined(event.reason);
          assert.deepEqual(created, [
            {
              environmentId: "native-environment",
              profileId: "default",
              partition: { scope: "native-environment", persistent: true },
            },
          ]);
          assert.equal(identityReads, 1);
          assert.isFalse(root.isDestroyed());
          host.setMainWindow(makeHiddenBrowserRoot());
          assert.isFalse(root.isDestroyed());
          host.setMainWindow(makeHiddenBrowserRoot());
          assert.isTrue(root.isDestroyed());
        }).pipe(Effect.provide(poolLayer));
      }),
    ),
  );

  it.effect("shows the saved diagnostic log when the primary exits before readiness", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const label = yield* Ref.make("Local");
        const notification = yield* Deferred.make<{ title: string; content: string }>();
        let persisted = false;
        const poolLayer = layerPool(label, {
          config: {
            executablePath: "/electron",
            args: ["/server/bin.mjs"],
            entryPath: "/server/bin.mjs",
            cwd: "/server",
            env: {},
            extendEnv: true,
            captureOutput: true,
            httpBaseUrl: new URL("http://127.0.0.1:3773"),
            preflightFailure: Option.none(),
            bootstrapDelivery: "fd3",
            bootstrap: {
              mode: "desktop",
              noBrowser: true,
              port: 3773,
              t3Home: "/home/example/.lastcode",
              host: "127.0.0.1",
              desktopBootstrapToken: "test-token",
              tailscaleServeEnabled: false,
              tailscaleServePort: 443,
            },
          },
          spawn: ChildProcessSpawner.make(() =>
            Effect.succeed(
              ChildProcessSpawner.makeHandle({
                pid: ChildProcessSpawner.ProcessId(123),
                stdout: Stream.empty,
                stderr: Stream.empty,
                all: Stream.empty,
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
                isRunning: Effect.succeed(false),
                kill: () => Effect.void,
                stdin: Sink.drain,
                getInputFd: () => Sink.drain,
                getOutputFd: () => Stream.empty,
                unref: Effect.succeed(Effect.void),
              }),
            ),
          ),
          persistFailure: Effect.sync(() => {
            persisted = true;
          }),
          showErrorBox: (title, content) =>
            Effect.gen(function* () {
              assert.isTrue(persisted);
              yield* Deferred.succeed(notification, { title, content });
            }),
        });
        yield* Effect.gen(function* () {
          const pool = yield* DesktopBackendPool.DesktopBackendPool;
          const primary = yield* pool.primary;
          yield* primary.start;
          const dialog = yield* Deferred.await(notification);
          assert.include(dialog.title, "could not start");
          assert.include(dialog.content, "code=1");
          assert.include(dialog.content, "server-child.log");
          assert.include(dialog.content, "/home/example/");
          assert.include(dialog.content, "quit and reopen");
        }).pipe(Effect.provide(poolLayer));
      }),
    ),
  );

  it.effect("layerTest exposes registered instances by id", () =>
    Effect.gen(function* () {
      const pool = yield* DesktopBackendPool.DesktopBackendPool;
      const fetchedPrimary = yield* pool.get(DesktopBackendPool.PRIMARY_INSTANCE_ID);
      const fetchedWsl = yield* pool.get(DesktopBackendPool.BackendInstanceId("wsl:ubuntu"));
      const fetchedMissing = yield* pool.get(DesktopBackendPool.BackendInstanceId("missing"));
      const all = yield* pool.list;
      const resolvedPrimary = yield* pool.primary;

      assert.equal(yield* Option.getOrThrow(fetchedPrimary).label, "Windows");
      assert.equal(yield* Option.getOrThrow(fetchedWsl).label, "WSL (Ubuntu)");
      assert.isTrue(Option.isNone(fetchedMissing));
      assert.lengthOf(all, 2);
      // First instance becomes primary in layerTest so single-instance
      // stubs don't have to wire an explicit primary.
      assert.equal(resolvedPrimary.id, DesktopBackendPool.PRIMARY_INSTANCE_ID);
    }).pipe(
      Effect.provide(
        DesktopBackendPool.layerTest([
          makeStubInstance(DesktopBackendPool.PRIMARY_INSTANCE_ID, "Windows"),
          makeStubInstance(DesktopBackendPool.BackendInstanceId("wsl:ubuntu"), "WSL (Ubuntu)"),
        ]),
      ),
    ),
  );

  it.effect("layerTest dies when no instances are supplied", () =>
    Effect.exit(
      DesktopBackendPool.DesktopBackendPool.pipe(Effect.provide(DesktopBackendPool.layerTest([]))),
    ).pipe(Effect.map((exit) => assert.equal(exit._tag, "Failure"))),
  );

  it.effect("resolves the primary label lazily after pool layer construction", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const labelRef = yield* Ref.make("Windows");
        const pool = yield* DesktopBackendPool.DesktopBackendPool.pipe(
          Effect.provide(layerPool(labelRef)),
        );
        const primary = yield* pool.primary;

        yield* Ref.set(labelRef, "WSL (Ubuntu)");

        assert.equal(yield* primary.label, "WSL (Ubuntu)");
      }),
    ),
  );
});
