import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { LOCAL_PACKAGE_READY_FILE } from "../../../../scripts/lib/lastcode-build-progress.ts";
import { completeLocalBuild } from "../../../../scripts/lastcode-local-update.mjs";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import { LastCodeLocalUpdateError, watchLocalPackageReady } from "./LastCodeLocalUpdates.ts";
import { makeHarness } from "./updatesTestHarness.ts";

it.live.each(["during startup", "after startup"] as const)(
  "offers a completed external build without requesting a checkpoint (%s)",
  (timing) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const artifactsDir = path.join(home, ".lastcode", "local-updates", "artifacts");
      yield* fs.makeDirectory(artifactsDir, { recursive: true });

      const watcherStarting = yield* Deferred.make<void>();
      const allowWatcher = yield* Deferred.make<void>();
      const version = "1.2.4-nightly.20261124.5178";
      const checkpointTag = `lastcode/checkpoint/v${version}`;
      const commit = "a".repeat(40);
      const artifact = {
        outputDir: artifactsDir,
        manifestPath: path.join(artifactsDir, "build-manifest.json"),
        dmgPath: path.join(artifactsDir, "LastCode-arm64.dmg"),
        dmgSha256: "b".repeat(64),
      };
      let built: ReturnType<typeof completeLocalBuild> | undefined;
      const publish = Effect.sync(() => {
        built = completeLocalBuild({ home, repoRoot: home, checkpointTag }, commit, artifact);
      }).pipe(
        Effect.andThen(
          fs.writeFileString(path.join(artifactsDir, LOCAL_PACKAGE_READY_FILE), commit),
        ),
      );
      const harness = makeHarness({
        localNightliesEnabled: true,
        localPackageReady: (onReady) =>
          watchLocalPackageReady(fs, artifactsDir, onReady).pipe(
            Stream.onStart(
              Deferred.succeed(watcherStarting, undefined).pipe(
                Effect.andThen(Deferred.await(allowWatcher)),
              ),
            ),
          ),
        localInspect: (_currentVersion, requestCheckpoint) =>
          Effect.sync(() => {
            assert.isFalse(requestCheckpoint);
            return built
              ? {
                  schemaVersion: 2,
                  status: "available",
                  checkpointRequested: false,
                  checkpointTag,
                  availableVersion: version,
                  releaseNotes: {
                    lastCode: { status: "known", items: [], omittedItems: 0 },
                    upstream: { groups: [], omittedGroups: 0 },
                  },
                  build: built,
                }
              : {
                  schemaVersion: 2,
                  status: "up-to-date",
                  checkpointRequested: false,
                  checkpointTag: "lastcode/checkpoint/v1.2.3-nightly.20261123.5124",
                  availableVersion: "1.2.3-nightly.20261123.5124",
                };
          }),
      });

      yield* Effect.gen(function* () {
        const updater = yield* DesktopUpdates.DesktopUpdates;
        const configure = yield* updater.configure.pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* Deferred.await(watcherStarting);
        if (timing === "during startup") yield* publish;
        yield* Deferred.succeed(allowWatcher, undefined);
        yield* Fiber.join(configure);
        const { latest, changes } = yield* updater.subscribe;
        if (timing === "during startup") {
          assert.equal(latest.status, "downloaded");
          assert.equal(latest.downloadedVersion, version);
          return;
        }
        assert.equal(latest.status, "up-to-date");
        assert.isNull(latest.downloadedVersion);

        yield* publish;

        const ready = yield* changes.pipe(
          Stream.filter((state) => state.status === "downloaded"),
          Stream.runHead,
        );
        assert.equal(ready.valueOrUndefined?.downloadedVersion, version);
        assert.deepEqual(harness.installEvents(), []);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("refreshes the retry artifact when a rebuild finishes during install preflight", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const packageReady = yield* Queue.unbounded<void>();
      const preflightStarted = yield* Deferred.make<void>();
      const failPreflight = yield* Deferred.make<void>();
      const version = "1.2.4-nightly.20260101.100";
      const checkpointTag = `lastcode/checkpoint/v${version}`;
      const build = {
        schemaVersion: 1 as const,
        status: "built" as const,
        checkpointTag,
        outputDir: "/tmp/local-package",
        manifestPath: "/tmp/local-package/build-manifest.json",
        dmgPath: "/tmp/local-package/LastCode-arm64.dmg",
        dmgSha256: "a".repeat(64),
      };
      const rebuilt = { ...build, dmgSha256: "b".repeat(64) };
      let availableBuild = build;
      const harness = makeHarness({
        localNightliesEnabled: true,
        localPackageReady: (onReady) =>
          Stream.fromQueue(packageReady).pipe(Stream.onStart(Effect.sync(onReady))),
        localInspect: (_version, requestCheckpoint) =>
          Effect.sync(() => {
            assert.isFalse(requestCheckpoint);
            return {
              schemaVersion: 2,
              status: "available",
              checkpointRequested: false,
              checkpointTag,
              availableVersion: version,
              build: availableBuild,
              releaseNotes: {
                lastCode: { status: "known", items: [], omittedItems: 0 },
                upstream: { groups: [], omittedGroups: 0 },
              },
            };
          }),
        localPrepareInstall: ({ dmgSha256 }) =>
          dmgSha256 === rebuilt.dmgSha256
            ? Effect.succeed({ commit: Effect.void, cancel: Effect.void })
            : Deferred.succeed(preflightStarted, undefined).pipe(
                Effect.andThen(Deferred.await(failPreflight)),
                Effect.andThen(
                  Effect.fail(
                    new LastCodeLocalUpdateError({
                      operation: "install",
                      message: "The package checksum changed.",
                    }),
                  ),
                ),
              ),
      });

      yield* Effect.gen(function* () {
        const updater = yield* DesktopUpdates.DesktopUpdates;
        yield* updater.configure;
        const { latest, changes } = yield* updater.subscribe;

        const install = yield* updater.install.pipe(Effect.forkScoped);
        yield* Deferred.await(preflightStarted);
        availableBuild = rebuilt;
        yield* Queue.offer(packageReady, undefined);
        yield* TestClock.adjust("1 second");
        yield* Deferred.succeed(failPreflight, undefined);
        assert.isFalse((yield* Fiber.join(install)).completed);

        const refreshed = yield* changes.pipe(
          Stream.filter(
            (state) => state.errorContext === "install" && state.checkedAt !== latest.checkedAt,
          ),
          Stream.runHead,
        );
        assert.equal(refreshed.valueOrUndefined?.downloadedVersion, version);
        assert.equal(refreshed.valueOrUndefined?.message, "The package checksum changed.");
        assert.isTrue(refreshed.valueOrUndefined?.canRetry);

        assert.isTrue((yield* updater.install).accepted);
        assert.deepEqual(
          harness.localInstallArgs().map(({ dmgSha256 }) => dmgSha256),
          [build.dmgSha256, rebuilt.dmgSha256],
        );
      }).pipe(Effect.provide(harness.layer));
    }),
  ),
);
