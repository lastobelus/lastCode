import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { DesktopUpdateState } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import * as LastCodeLocalUpdates from "./LastCodeLocalUpdates.ts";

interface UpdatesHarnessOptions {
  readonly checkForUpdates?: Effect.Effect<
    void,
    ElectronUpdater.ElectronUpdaterCheckForUpdatesError
  >;
  readonly setUpdateChannelError?: DesktopAppSettings.DesktopSettingsWriteError;
  readonly setDisableDifferentialDownload?: Effect.Effect<void>;
  readonly backends?: ReadonlyArray<{
    readonly desiredRunning: boolean;
    readonly stop?: Effect.Effect<void>;
  }>;
  readonly env?: Record<string, string | undefined>;
  readonly localNightliesEnabled?: boolean;
  readonly localInspection?: LastCodeLocalUpdates.LastCodeLocalUpdateInspection;
  readonly localInspect?: (
    currentVersion: string,
  ) => Effect.Effect<LastCodeLocalUpdates.LastCodeLocalUpdateInspection>;
  readonly localBuild?: LastCodeLocalUpdates.LastCodeLocalUpdateBuild;
  readonly localPrepareInstall?: (
    args: Parameters<LastCodeLocalUpdates.LastCodeLocalUpdates["Service"]["prepareInstall"]>[0],
  ) => Effect.Effect<
    LastCodeLocalUpdates.LastCodeLocalInstallHandoff,
    LastCodeLocalUpdates.LastCodeLocalUpdateError
  >;
}

const flushCallbacks = Effect.yieldNow;

function makeHarness(options: UpdatesHarnessOptions = {}) {
  let checkCount = 0;
  let allowDowngrade = false;
  let fullChangelog = false;
  const installEvents: string[] = [];
  const localInstallArgs: Array<{
    readonly dmgPath: string;
    readonly dmgSha256: string;
    readonly expectedVersion: string;
  }> = [];
  const differentialDownloadValues: boolean[] = [];
  const feedUrls: ElectronUpdater.ElectronUpdaterFeedUrl[] = [];
  const listeners = new Map<string, Set<(...args: readonly unknown[]) => void>>();
  const sentStates: DesktopUpdateState[] = [];

  const addListener = (eventName: string, listener: (...args: readonly unknown[]) => void) => {
    const eventListeners = listeners.get(eventName) ?? new Set();
    eventListeners.add(listener);
    listeners.set(eventName, eventListeners);
  };

  const removeListener = (eventName: string, listener: (...args: readonly unknown[]) => void) => {
    const eventListeners = listeners.get(eventName);
    if (!eventListeners) {
      return;
    }
    eventListeners.delete(listener);
    if (eventListeners.size === 0) {
      listeners.delete(eventName);
    }
  };

  const updaterLayer = Layer.succeed(ElectronUpdater.ElectronUpdater, {
    setFeedURL: (options) =>
      Effect.sync(() => {
        feedUrls.push(options);
      }),
    setAutoDownload: () => Effect.void,
    setAutoInstallOnAppQuit: () => Effect.void,
    setChannel: () => Effect.void,
    setAllowPrerelease: () => Effect.void,
    allowDowngrade: Effect.sync(() => allowDowngrade),
    setAllowDowngrade: (value) =>
      Effect.sync(() => {
        allowDowngrade = value;
      }),
    setFullChangelog: (value) =>
      Effect.sync(() => {
        fullChangelog = value;
      }),
    setDisableDifferentialDownload: (value) =>
      Effect.sync(() => {
        differentialDownloadValues.push(value);
      }).pipe(Effect.andThen(options.setDisableDifferentialDownload ?? Effect.void)),
    checkForUpdates: Effect.sync(() => {
      checkCount += 1;
    }).pipe(Effect.andThen(options.checkForUpdates ?? Effect.void)),
    downloadUpdate: Effect.sync(() => {
      if (options.localNightliesEnabled) {
        for (const listener of listeners.get("update-downloaded") ?? []) {
          listener({ version: options.localInspection?.availableVersion });
        }
      }
    }),
    quitAndInstall: () =>
      Effect.sync(() => {
        installEvents.push("squirrel-install");
      }),
    on: (eventName, listener) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          addListener(eventName, listener as unknown as (...args: readonly unknown[]) => void);
        }),
        () =>
          Effect.sync(() => {
            removeListener(eventName, listener as unknown as (...args: readonly unknown[]) => void);
          }),
      ).pipe(Effect.asVoid),
  } satisfies ElectronUpdater.ElectronUpdater["Service"]);

  const windowLayer = Layer.succeed(ElectronWindow.ElectronWindow, {
    create: () => Effect.die("unexpected BrowserWindow creation"),
    main: Effect.succeed(Option.none()),
    currentMainOrFirst: Effect.succeed(Option.none()),
    focusedMainOrFirst: Effect.succeed(Option.none()),
    setMain: () => Effect.void,
    clearMain: () => Effect.void,
    reveal: () => Effect.void,
    sendAll: (_channel, state) =>
      Effect.sync(() => {
        sentStates.push(state as DesktopUpdateState);
      }),
    destroyAll: Effect.sync(() => {
      installEvents.push("destroy-windows");
    }),
    syncAllAppearance: () => Effect.void,
  } satisfies ElectronWindow.ElectronWindow["Service"]);

  const backendOptions = options.backends ?? [{ desiredRunning: true }];
  const stubBackendInstances = backendOptions.map(
    ({ desiredRunning, stop }, index): DesktopBackendPool.DesktopBackendInstance => {
      const suffix = index === 0 ? "" : `-${index + 1}`;
      return {
        id:
          index === 0
            ? DesktopBackendPool.PRIMARY_INSTANCE_ID
            : DesktopBackendPool.BackendInstanceId(`test-backend-${index + 1}`),
        label: Effect.succeed(index === 0 ? "Windows" : `Backend ${index + 1}`),
        start: Effect.sync(() => {
          installEvents.push(`start-backend${suffix}`);
        }),
        stop: () =>
          Effect.sync(() => {
            installEvents.push(`stop-backend${suffix}`);
          }).pipe(Effect.andThen(stop ?? Effect.void)),
        currentConfig: Effect.succeed(Option.none()),
        snapshot: Effect.succeed({
          desiredRunning,
          ready: desiredRunning,
          activePid: Option.none(),
          restartAttempt: 0,
          restartScheduled: false,
        }),
        waitForReady: () => Effect.succeed(true),
      };
    },
  );
  const backendLayer = DesktopBackendPool.layerTest(stubBackendInstances);

  const environmentLayer = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: `/tmp/t3-desktop-updates-home-${process.pid}`,
    platform: "darwin",
    processArch: "x64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        DesktopConfig.layerTest({
          T3CODE_HOME: `/tmp/t3-desktop-updates-test-${process.pid}`,
          T3CODE_DESKTOP_MOCK_UPDATES: "true",
          T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT: "4141",
          ...options.env,
        }),
      ),
    ),
  );

  const setUpdateChannelError = options.setUpdateChannelError;
  const settingsLayer = setUpdateChannelError
    ? Layer.succeed(DesktopAppSettings.DesktopAppSettings, {
        get: Effect.succeed(DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS),
        load: Effect.succeed(DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS),
        setMainWindowBounds: () => Effect.die("unexpected main window bounds update"),
        setServerExposureMode: () => Effect.die("unexpected server exposure update"),
        setTailscaleServe: () => Effect.die("unexpected Tailscale Serve update"),
        setUpdateChannel: () => Effect.fail(setUpdateChannelError),
        setShowAndInstallLocalNightlies: () => Effect.die("unexpected local nightly toggle"),
        setWslBackendEnabled: () => Effect.die("unexpected WSL backend toggle"),
        setWslDistro: () => Effect.die("unexpected WSL distro change"),
        setWslOnly: () => Effect.die("unexpected WSL-only toggle"),
        applyWslWindowsFallback: Effect.die("unexpected WSL Windows fallback"),
        applyWslWindowsFallbackInMemory: Effect.die("unexpected WSL Windows fallback"),
      } satisfies DesktopAppSettings.DesktopAppSettings["Service"])
    : options.localNightliesEnabled
      ? DesktopAppSettings.layerTest({
          ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
          showAndInstallLocalNightlies: true,
        })
      : DesktopAppSettings.layer;

  const localUpdatesLayer = LastCodeLocalUpdates.layerTest({
    supported: options.localNightliesEnabled ?? false,
    inspect: (currentVersion) =>
      options.localInspect
        ? options.localInspect(currentVersion)
        : options.localInspection
          ? Effect.succeed(options.localInspection)
          : Effect.die("unexpected local update inspection"),
    build: () =>
      options.localBuild
        ? Effect.succeed(options.localBuild)
        : Effect.die("unexpected local update build"),
    prepareInstall: (args) => {
      localInstallArgs.push(args);
      installEvents.push("prepare-install");
      if (options.localPrepareInstall) return options.localPrepareInstall(args);
      let commanded = false;
      return Effect.succeed({
        commit: Effect.sync(() => {
          if (commanded) return;
          commanded = true;
          installEvents.push("commit-handoff");
        }),
        cancel: Effect.sync(() => {
          if (commanded) return;
          commanded = true;
          installEvents.push("cancel-handoff");
        }),
      });
    },
  });

  const electronAppLayer = Layer.mock(ElectronApp.ElectronApp)({
    quit: Effect.sync(() => {
      installEvents.push("quit-app");
    }),
  });

  const layer = DesktopUpdates.layer.pipe(
    Layer.provideMerge(updaterLayer),
    Layer.provideMerge(windowLayer),
    Layer.provideMerge(backendLayer),
    Layer.provideMerge(DesktopState.layer),
    Layer.provideMerge(settingsLayer),
    Layer.provideMerge(
      DesktopConfig.layerTest({
        T3CODE_HOME: `/tmp/t3-desktop-updates-test-${process.pid}`,
        T3CODE_DESKTOP_MOCK_UPDATES: "true",
        T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT: "4141",
        ...options.env,
      }),
    ),
    Layer.provideMerge(environmentLayer),
    Layer.provideMerge(localUpdatesLayer),
    Layer.provideMerge(electronAppLayer),
    Layer.provideMerge(NodeServices.layer),
  );

  return {
    layer,
    checkCount: () => checkCount,
    feedUrls: () => feedUrls,
    differentialDownloadValues: () => differentialDownloadValues,
    fullChangelog: () => fullChangelog,
    installEvents: () => installEvents,
    localInstallArgs: () => localInstallArgs,
    listenerCount: () =>
      Array.from(listeners.values()).reduce(
        (total, eventListeners) => total + eventListeners.size,
        0,
      ),
    sentStates,
    emit: (eventName: string, payload?: unknown) => {
      for (const listener of listeners.get(eventName) ?? []) {
        listener(payload);
      }
    },
  };
}

describe("DesktopUpdates", () => {
  it("preserves complete causes for update poller and event failures", () => {
    const cause = Cause.combine(
      Cause.fail(new Error("updater failed")),
      Cause.die(new Error("updater defect")),
    );
    const pollerError = new DesktopUpdates.DesktopUpdatePollerError({
      poller: "startup",
      cause,
    });
    const eventError = new DesktopUpdates.DesktopUpdateEventHandlingError({
      event: "download-progress",
      cause,
    });
    const reportedError = new DesktopUpdates.DesktopUpdaterReportedError({
      operation: "download",
      cause,
    });
    const unexpectedActionError = new DesktopUpdates.DesktopUpdateUnexpectedActionError({
      action: "install",
      cause,
    });

    assert.strictEqual(pollerError.cause, cause);
    assert.equal(pollerError.poller, "startup");
    assert.equal(pollerError.message, "Desktop update startup poller failed.");
    assert.strictEqual(eventError.cause, cause);
    assert.equal(eventError.event, "download-progress");
    assert.equal(eventError.message, "Failed to handle desktop update download-progress event.");
    assert.strictEqual(reportedError.cause, cause);
    assert.equal(reportedError.operation, "download");
    assert.equal(reportedError.message, "Desktop updater download operation reported an error.");
    assert.strictEqual(unexpectedActionError.cause, cause);
    assert.equal(unexpectedActionError.action, "install");
    assert.equal(
      unexpectedActionError.message,
      "Desktop update install action failed unexpectedly.",
    );
  });

  it.effect("configures the updater and runs startup checks on the test clock", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;

          const state = yield* updates.getState;
          assert.equal(state.enabled, true);
          assert.equal(state.status, "idle");
          assert.deepEqual(harness.feedUrls(), [
            { provider: "generic", url: "http://localhost:4141" },
          ]);
          assert.equal(harness.listenerCount(), 6);
          assert.equal(harness.checkCount(), 0);

          yield* TestClock.adjust(Duration.millis(15_000));
          assert.equal(harness.checkCount(), 1);
        }),
      );

      assert.equal(harness.listenerCount(), 0);
    }).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("updates and broadcasts state from updater events", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        harness.emit("update-available", { version: "1.2.4" });
        yield* flushCallbacks;

        const state = yield* updates.getState;
        assert.equal(state.status, "available");
        assert.equal(state.availableVersion, "1.2.4");
        assert.isNotNull(state.checkedAt);
        assert.equal(harness.sentStates.at(-1)?.status, "available");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("builds an opted-in local revision without staging it through electron-updater", () => {
    const checkpointTag = "lastcode/revision/v1.2.4-nightly.20260814.1089.1";
    const harness = makeHarness({
      localNightliesEnabled: true,
      localInspection: {
        schemaVersion: 1,
        status: "available",
        checkpointTag,
        availableVersion: "1.2.4-nightly.20260814.1089.1",
        releaseNotes: ["feat(lastcode): local update"],
      },
      localBuild: {
        schemaVersion: 1,
        status: "built",
        checkpointTag,
        outputDir: "/tmp/lastcode-local-build",
        manifestPath: "/tmp/lastcode-local-build/build-manifest.json",
        dmgPath: "/tmp/lastcode-local-build/LastCode-1.2.4.dmg",
        dmgSha256: "a".repeat(64),
      },
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        const available = yield* updates.getState;
        assert.equal(available.source, "lastcode-local");
        assert.equal(available.status, "available");
        assert.deepEqual(available.releaseNotes[0]?.items, ["feat(lastcode): local update"]);

        const result = yield* updates.download;
        assert.isTrue(result.accepted);
        assert.isTrue(result.completed);
        yield* flushCallbacks;

        const downloaded = yield* updates.getState;
        assert.equal(downloaded.status, "downloaded");
        assert.equal(downloaded.downloadedVersion, "1.2.4-nightly.20260814.1089.1");
        assert.deepEqual(harness.feedUrls(), [
          { provider: "generic", url: "http://localhost:4141" },
        ]);
        assert.deepEqual(harness.installEvents(), []);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("hands the exact local DMG to the helper before stopping backends and quitting", () => {
    const checkpointTag = "lastcode/revision/v1.2.4-nightly.20260814.1089.1";
    const dmgPath = "/tmp/lastcode-local-build/LastCode-1.2.4.dmg";
    const dmgSha256 = "b".repeat(64);
    const harness = makeHarness({
      localNightliesEnabled: true,
      localInspection: {
        schemaVersion: 1,
        status: "available",
        checkpointTag,
        availableVersion: "1.2.4-nightly.20260814.1089.1",
        releaseNotes: [],
      },
      localBuild: {
        schemaVersion: 1,
        status: "built",
        checkpointTag,
        outputDir: "/tmp/lastcode-local-build",
        manifestPath: "/tmp/lastcode-local-build/build-manifest.json",
        dmgPath,
        dmgSha256,
      },
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        yield* updates.download;

        const result = yield* updates.install;
        assert.isTrue(result.accepted);
        assert.deepEqual(harness.localInstallArgs(), [
          {
            dmgPath,
            dmgSha256,
            expectedVersion: "1.2.4-nightly.20260814.1089.1",
          },
        ]);
        assert.deepEqual(harness.installEvents(), [
          "prepare-install",
          "stop-backend",
          "commit-handoff",
          "quit-app",
        ]);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("keeps the current app usable when local install preflight fails", () => {
    const checkpointTag = "lastcode/revision/v1.2.4-nightly.20260814.1089.1";
    const harness = makeHarness({
      localNightliesEnabled: true,
      localInspection: {
        schemaVersion: 1,
        status: "available",
        checkpointTag,
        availableVersion: "1.2.4-nightly.20260814.1089.1",
        releaseNotes: [],
      },
      localBuild: {
        schemaVersion: 1,
        status: "built",
        checkpointTag,
        outputDir: "/tmp/lastcode-local-build",
        manifestPath: "/tmp/lastcode-local-build/build-manifest.json",
        dmgPath: "/tmp/lastcode-local-build/LastCode-1.2.4.dmg",
        dmgSha256: "c".repeat(64),
      },
      localPrepareInstall: () =>
        Effect.fail(
          new LastCodeLocalUpdates.LastCodeLocalUpdateError({
            operation: "install",
            message: "Install preflight failed.",
          }),
        ),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const desktopState = yield* DesktopState.DesktopState;
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        yield* updates.download;

        const result = yield* updates.install;
        assert.isTrue(result.accepted);
        assert.isFalse(result.completed);
        assert.isFalse(yield* Ref.get(desktopState.quitting));
        assert.deepEqual(harness.installEvents(), ["prepare-install"]);
        const failed = yield* updates.getState;
        assert.equal(failed.status, "downloaded");
        assert.equal(failed.errorContext, "install");
        assert.equal(failed.message, "Install preflight failed.");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("cancels the handoff and restores running backends when shutdown fails", () => {
    const checkpointTag = "lastcode/revision/v1.2.4-nightly.20260814.1089.1";
    const harness = makeHarness({
      localNightliesEnabled: true,
      localInspection: {
        schemaVersion: 1,
        status: "available",
        checkpointTag,
        availableVersion: "1.2.4-nightly.20260814.1089.1",
        releaseNotes: [],
      },
      localBuild: {
        schemaVersion: 1,
        status: "built",
        checkpointTag,
        outputDir: "/tmp/lastcode-local-build",
        manifestPath: "/tmp/lastcode-local-build/build-manifest.json",
        dmgPath: "/tmp/lastcode-local-build/LastCode-1.2.4.dmg",
        dmgSha256: "d".repeat(64),
      },
      backends: [
        { desiredRunning: true },
        { desiredRunning: true, stop: Effect.die(new Error("backend stop failed")) },
        { desiredRunning: false },
      ],
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const desktopState = yield* DesktopState.DesktopState;
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        yield* updates.download;
        yield* updates.install;

        assert.isFalse(yield* Ref.get(desktopState.quitting));
        const installEvents = harness.installEvents();
        assert.equal(installEvents[0], "prepare-install");
        assert.include(installEvents, "stop-backend");
        assert.include(installEvents, "stop-backend-2");
        assert.include(installEvents, "cancel-handoff");
        assert.include(installEvents, "start-backend");
        assert.include(installEvents, "start-backend-2");
        assert.notInclude(installEvents, "start-backend-3");
        assert.isBelow(
          installEvents.indexOf("cancel-handoff"),
          installEvents.indexOf("start-backend"),
        );
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("keeps hosted installs on electron-updater", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        yield* updates.install;
        assert.deepEqual(harness.localInstallArgs(), []);
        assert.deepEqual(harness.installEvents(), [
          "stop-backend",
          "destroy-windows",
          "squirrel-install",
        ]);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("restores hosted updates immediately when local nightlies are disabled", () => {
    const harness = makeHarness({
      localNightliesEnabled: true,
      localInspection: {
        schemaVersion: 1,
        status: "up-to-date",
        checkpointTag: "lastcode/checkpoint/v1.2.3-nightly.20260814.1089",
        availableVersion: "1.2.3-nightly.20260814.1089",
      },
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        const local = yield* updates.getState;
        assert.equal(local.source, "lastcode-local");
        assert.equal(local.channel, "nightly");

        const settings = yield* updates.setShowAndInstallLocalNightlies(false);
        const hosted = yield* updates.getState;

        assert.isFalse(settings.showAndInstallLocalNightlies);
        assert.equal(hosted.source, "hosted");
        assert.equal(hosted.channel, "latest");
        assert.isTrue(hosted.enabled);
        assert.equal(harness.checkCount(), 1);
        assert.deepEqual(harness.feedUrls().at(-1), {
          provider: "generic",
          url: "http://localhost:4141",
        });
        assert.deepEqual(harness.differentialDownloadValues(), [false, false]);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("serializes disabling local nightlies with an active checkpoint inspection", () =>
    Effect.gen(function* () {
      const inspectionStarted = yield* Deferred.make<void>();
      const releaseInspection = yield* Deferred.make<void>();
      let blockInspection = false;
      const inspection = {
        schemaVersion: 1 as const,
        status: "up-to-date" as const,
        checkpointTag: "lastcode/checkpoint/v1.2.3-nightly.20260814.1089",
        availableVersion: "1.2.3-nightly.20260814.1089",
      };
      const harness = makeHarness({
        localNightliesEnabled: true,
        localInspect: () =>
          blockInspection
            ? Deferred.succeed(inspectionStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseInspection)),
                Effect.as(inspection),
              )
            : Effect.succeed(inspection),
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          blockInspection = true;

          const checkFiber = yield* updates.check("poll").pipe(Effect.forkScoped);
          yield* Deferred.await(inspectionStarted);
          const toggleFiber = yield* updates
            .setShowAndInstallLocalNightlies(false)
            .pipe(Effect.forkScoped);

          yield* Deferred.succeed(releaseInspection, undefined);
          yield* Fiber.join(checkFiber);
          const settings = yield* Fiber.join(toggleFiber);
          const state = yield* updates.getState;

          assert.isFalse(settings.showAndInstallLocalNightlies);
          assert.equal(state.source, "hosted");
          assert.isTrue(state.enabled);
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
  );

  it.effect("enables nightly full changelog release notes and broadcasts summaries", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        yield* updates.setChannel("nightly");
        assert.equal(harness.fullChangelog(), true);

        harness.emit("update-available", {
          version: "1.2.4-nightly.20260709.766",
          releaseNotes: [
            {
              version: "1.2.4-nightly.20260709.766",
              note: `<h2>What's Changed</h2><ul><li>feat(client): persist offline environment data by <a>@juliusmarminge</a> in <a>#3795</a></li></ul><h2>Full Changelog</h2>`,
            },
            {
              version: "1.2.4-nightly.20260709.765",
              note: "- [codex] Upgrade Clerk stack by @juliusmarminge in #3821",
            },
          ],
        });
        yield* flushCallbacks;

        const state = yield* updates.getState;
        assert.equal(state.status, "available");
        assert.deepEqual(state.releaseNotes, [
          {
            version: "1.2.4-nightly.20260709.766",
            items: ["feat(client): persist offline environment data by @juliusmarminge in #3795"],
          },
          {
            version: "1.2.4-nightly.20260709.765",
            items: ["[codex] Upgrade Clerk stack by @juliusmarminge in #3821"],
          },
        ]);
        assert.deepEqual(harness.sentStates.at(-1)?.releaseNotes, state.releaseNotes);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("keeps raw updater event failures out of update state", () => {
    const harness = makeHarness();
    const cause = new Error(
      "request failed for https://user:secret@example.com/update?token=secret",
    );

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        harness.emit("error", cause);
        yield* flushCallbacks;

        const state = yield* updates.getState;
        assert.equal(state.status, "error");
        assert.equal(state.message, "Desktop updater background operation reported an error.");
        assert.notInclude(state.message ?? "", "secret");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("logs bounded updater failure context without exposing the cause", () => {
    const cause = new Error(
      "request failed for https://user:secret@example.com/update?token=secret",
    );
    const updaterError = new ElectronUpdater.ElectronUpdaterCheckForUpdatesError({
      channel: null,
      cause,
    });
    const harness = makeHarness({ checkForUpdates: Effect.fail(updaterError) });
    const loggedAnnotations: Array<Record<string, unknown>> = [];
    const logger = Logger.make(({ fiber }) => {
      const annotations = fiber.getRef(References.CurrentLogAnnotations);
      if (annotations.errorTag === "ElectronUpdaterCheckForUpdatesError") {
        loggedAnnotations.push(annotations);
      }
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        yield* updates.check("manual");

        const state = yield* updates.getState;
        const loggedAnnotation = loggedAnnotations.at(-1);
        assert.isDefined(loggedAnnotation);
        assert.equal(loggedAnnotation.errorTag, "ElectronUpdaterCheckForUpdatesError");
        assert.isNull(loggedAnnotation.channel);
        assert.notProperty(loggedAnnotation, "error");
        assert.notInclude(Object.values(loggedAnnotation).map(String).join(" "), "secret");
        assert.equal(
          state.message,
          "Electron updater failed to check for updates on channel default.",
        );
        assert.notInclude(state.message ?? "", "secret");
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          TestClock.layer(),
          harness.layer,
          Logger.layer([logger], { mergeWithExisting: false }),
        ),
      ),
    );
  });

  it.effect("recovers download state after an unexpected setup failure", () => {
    let disableDifferentialCalls = 0;
    const harness = makeHarness({
      setDisableDifferentialDownload: Effect.suspend(() => {
        disableDifferentialCalls += 1;
        return disableDifferentialCalls === 1
          ? Effect.void
          : Effect.die(new Error("download setup failed"));
      }),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-available", { version: "1.2.4" });
        yield* flushCallbacks;

        const result = yield* updates.download;
        assert.isTrue(result.accepted);
        assert.isFalse(result.completed);

        const failedState = yield* updates.getState;
        assert.equal(failedState.status, "available");
        assert.equal(failedState.errorContext, "download");
        assert.equal(failedState.message, "Desktop update download action failed unexpectedly.");

        const changedState = yield* updates.setChannel("nightly");
        assert.equal(changedState.channel, "nightly");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("restores download state and permits retry after interruption", () =>
    Effect.gen(function* () {
      const actionStarted = yield* Deferred.make<void>();
      let disableDifferentialCalls = 0;
      const harness = makeHarness({
        setDisableDifferentialDownload: Effect.suspend(() => {
          disableDifferentialCalls += 1;
          if (disableDifferentialCalls === 1) {
            return Effect.void;
          }
          if (disableDifferentialCalls === 2) {
            return Deferred.succeed(actionStarted, undefined).pipe(Effect.andThen(Effect.never));
          }
          return Effect.void;
        }),
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          harness.emit("update-available", { version: "1.2.4" });
          yield* flushCallbacks;

          const downloadFiber = yield* updates.download.pipe(Effect.forkScoped);
          yield* Deferred.await(actionStarted);
          yield* Fiber.interrupt(downloadFiber);

          const interruptedState = yield* updates.getState;
          assert.equal(interruptedState.status, "available");
          assert.isNull(interruptedState.message);

          const retry = yield* updates.download;
          assert.isTrue(retry.accepted);
          assert.isTrue(retry.completed);
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
  );

  it.effect("clears quitting state after an unexpected install setup failure", () => {
    const harness = makeHarness({
      backends: [{ desiredRunning: true, stop: Effect.die(new Error("backend stop failed")) }],
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const desktopState = yield* DesktopState.DesktopState;
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        const result = yield* updates.install;
        assert.isTrue(result.accepted);
        assert.isFalse(result.completed);
        assert.isFalse(yield* Ref.get(desktopState.quitting));

        const failedState = yield* updates.getState;
        assert.equal(failedState.status, "downloaded");
        assert.equal(failedState.errorContext, "install");
        assert.equal(failedState.message, "Desktop update install action failed unexpectedly.");

        const changedState = yield* updates.setChannel("nightly");
        assert.equal(changedState.channel, "nightly");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("persists channel changes through the settings service", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        const state = yield* updates.setChannel("nightly");
        const persistedSettings = yield* settings.get;

        assert.equal(state.channel, "nightly");
        assert.equal(persistedSettings.updateChannel, "nightly");
        assert.equal(persistedSettings.updateChannelConfiguredByUser, true);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("does not persist an unchanged update channel as a user preference", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        const state = yield* updates.setChannel("latest");
        const persistedSettings = yield* settings.get;

        assert.equal(state.channel, "latest");
        assert.equal(persistedSettings.updateChannel, "latest");
        assert.equal(persistedSettings.updateChannelConfiguredByUser, false);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("fails channel changes with a typed error while a check is in progress", () =>
    Effect.gen(function* () {
      const checkStarted = yield* Deferred.make<void>();
      const releaseCheck = yield* Deferred.make<void>();
      const harness = makeHarness({
        checkForUpdates: Deferred.succeed(checkStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseCheck)),
        ),
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;

          const checkFiber = yield* updates.check("manual").pipe(Effect.forkScoped);
          yield* Deferred.await(checkStarted);

          const exit = yield* Effect.exit(updates.setChannel("nightly"));
          assert.equal(exit._tag, "Failure");
          if (exit._tag === "Failure") {
            const error = Cause.squash(exit.cause);
            assert.instanceOf(error, DesktopUpdates.DesktopUpdateActionInProgressError);
            assert.equal(error.action, "check");
            assert.equal(error.requestedChannel, "nightly");
          }

          yield* Deferred.succeed(releaseCheck, undefined);
          yield* Fiber.join(checkFiber);
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
  );

  it.effect("preserves settings failure context when an update channel cannot be persisted", () => {
    const diskFailure = new Error("disk exploded");
    const settingsFailure = new DesktopAppSettings.DesktopSettingsWriteError({
      operation: "replace-settings-file",
      path: "/tmp/settings.json",
      cause: diskFailure,
    });
    const harness = makeHarness({ setUpdateChannelError: settingsFailure });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        const error = yield* updates.setChannel("nightly").pipe(Effect.flip);

        assert.instanceOf(error, DesktopUpdates.DesktopUpdateChannelPersistenceError);
        assert.isTrue(DesktopUpdates.isDesktopUpdateSetChannelError(error));
        assert.equal(error.channel, "nightly");
        assert.strictEqual(error.cause, settingsFailure);
        assert.strictEqual(error.cause.cause, diskFailure);
        assert.equal(error.message, "Failed to persist the nightly desktop update channel.");
        assert.notInclude(error.message, diskFailure.message);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });
});
