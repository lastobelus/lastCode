import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import * as NodeProcess from "node:process";

import {
  beginInstallOutcome,
  retainedBundlePath,
} from "../../../../scripts/lastcode-install-outcome.mjs";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { runBackendProcess } from "../backend/DesktopBackendManager.ts";
import {
  readLocalInstallOutcome,
  recordLocalInstallBackend,
} from "./LastCodeLocalInstallOutcome.ts";

it.live(
  "waits for the replacement backend's real readiness pipe before retiring the old bundle",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const t3Home = path.join(home, ".lastcode");
      const updateDirectory = path.join(t3Home, "local-updates");
      const targetPath = path.join(home, "Example.app");
      const staging = path.join(home, ".staging.app");
      const resourcesPath = path.join(targetPath, "Contents", "Resources");
      const version = "1.2.3";
      yield* fs.makeDirectory(updateDirectory, { recursive: true });
      yield* fs.makeDirectory(targetPath);
      yield* fs.makeDirectory(path.join(staging, "Contents", "Resources"), { recursive: true });

      const outcome = yield* Effect.sync(() =>
        beginInstallOutcome(updateDirectory, { targetPath, staging, version, t3Home }),
      );
      const backup = retainedBundlePath(targetPath, outcome.record.id);
      yield* fs.rename(targetPath, backup);
      yield* fs.rename(staging, targetPath);

      const environment = yield* DesktopEnvironment.DesktopEnvironment.pipe(
        Effect.provide(
          DesktopEnvironment.layer({
            dirname: resourcesPath,
            homeDirectory: home,
            platform: "darwin",
            processArch: "arm64",
            appVersion: version,
            appPath: path.join(resourcesPath, "app.asar"),
            isPackaged: true,
            resourcesPath,
            runningUnderArm64Translation: false,
          }).pipe(Layer.provide(DesktopConfig.layerTest({ T3CODE_HOME: t3Home }))),
        ),
      );
      const read = readLocalInstallOutcome(environment);
      const captured = yield* read;
      assert.equal(captured?.record.id, outcome.record.id);
      assert.equal(captured?.status, "pending");

      const stdoutReady = yield* Deferred.make<void>();
      const allowStartup = yield* Deferred.make<void>();
      const confirmed = yield* Deferred.make<void>();
      const script = `
      const fs = require('node:fs');
      fs.readFileSync(3);
      const message = JSON.stringify({ version: 1, type: 'serverReady' }) + '\\n';
      process.stdout.write(message);
      fs.readSync(4, Buffer.alloc(1));
      fs.writeSync(5, message);
      fs.readSync(4, Buffer.alloc(1));
    `;
      yield* runBackendProcess({
        executablePath: NodeProcess.execPath,
        entryPath: environment.backendEntryPath,
        args: ["--eval", script],
        cwd: home,
        env: {},
        extendEnv: true,
        captureOutput: true,
        bootstrapDelivery: "fd3",
        preflightFailure: Option.none(),
        httpBaseUrl: new URL("http://127.0.0.1:3781"),
        bootstrap: {
          mode: "desktop",
          noBrowser: true,
          port: 3781,
          t3Home,
          host: "127.0.0.1",
          desktopBootstrapToken: "fixture",
          tailscaleServeEnabled: false,
          tailscaleServePort: 443,
          desktopTelemetryFd: 4,
          desktopTelemetryControlFd: 5,
        },
        desktopTelemetryStream: Stream.fromEffect(Deferred.await(allowStartup)).pipe(
          Stream.as(Uint8Array.of(1)),
          Stream.concat(Stream.never),
        ),
        onOutput: (stream) =>
          stream === "stdout"
            ? Deferred.succeed(stdoutReady, undefined).pipe(Effect.asVoid)
            : Effect.void,
        onReady: () =>
          recordLocalInstallBackend(captured, true).pipe(
            Effect.andThen(Deferred.succeed(confirmed, undefined)),
            Effect.asVoid,
          ),
      }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("Unexpected HTTP readiness probe")),
        ),
        Effect.forkScoped,
      );

      yield* Deferred.await(stdoutReady);
      assert.isTrue(yield* fs.exists(backup));
      assert.equal((yield* read)?.status, "pending");
      yield* Deferred.succeed(allowStartup, undefined);
      yield* Deferred.await(confirmed);
      assert.equal((yield* read)?.status, "healthy");
      assert.isFalse(yield* fs.exists(backup));
    }).pipe(Effect.provide(NodeServices.layer)),
);
