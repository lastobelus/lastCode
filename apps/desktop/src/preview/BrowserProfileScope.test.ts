import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { DEFAULT_BROWSER_PROFILE_ID, INCOGNITO_BROWSER_PROFILE_ID } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import type { DesktopBackendStartConfig } from "../backend/DesktopBackendManager.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopWslEnvironment from "../wsl/DesktopWslEnvironment.ts";
import * as BrowserProfileScope from "./BrowserProfileScope.ts";

const primaryConfig: DesktopBackendStartConfig = {
  executablePath: "wsl.exe",
  entryPath: "/app/bin.mjs",
  cwd: "/app",
  args: ["--", "node", "/app/bin.mjs"],
  env: {},
  extendEnv: false,
  bootstrap: {
    mode: "desktop",
    noBrowser: true,
    port: 3774,
    host: "0.0.0.0",
    desktopBootstrapToken: "test-bootstrap",
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  },
  bootstrapDelivery: "stdin",
  httpBaseUrl: new URL("http://127.0.0.1:3774"),
  captureOutput: true,
  preflightFailure: Option.none(),
};

function layerPrimary(config: Option.Option<DesktopBackendStartConfig>) {
  return DesktopBackendPool.layerTest([
    {
      id: DesktopBackendPool.PRIMARY_INSTANCE_ID,
      label: Effect.succeed("Primary"),
      start: Effect.void,
      stop: () => Effect.void,
      currentConfig: Effect.succeed(config),
      snapshot: Effect.succeed({
        desiredRunning: Option.isSome(config),
        ready: Option.isSome(config),
        activePid: Option.none(),
        restartAttempt: 0,
        restartScheduled: false,
      }),
      waitForReady: () => Effect.succeed(Option.isSome(config)),
    },
  ]);
}

const withState = <A, E, R>(
  program: Effect.Effect<A, E, R>,
  options: {
    readonly platform?: NodeJS.Platform;
    readonly settings?: Partial<DesktopAppSettings.DesktopSettings>;
    readonly config?: DesktopBackendStartConfig;
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "desktop-profile-scope-" });
    yield* fs.makeDirectory(`${baseDir}/userdata`, { recursive: true });
    return yield* program.pipe(
      Effect.provide(
        Layer.mergeAll(
          DesktopEnvironment.layer({
            dirname: "/repo/apps/desktop/src",
            homeDirectory: baseDir,
            platform: options.platform ?? "darwin",
            processArch: "x64",
            appVersion: "1.2.3",
            appPath: "/repo",
            isPackaged: true,
            resourcesPath: "/missing/resources",
            runningUnderArm64Translation: false,
          }).pipe(
            Layer.provide(
              Layer.merge(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: baseDir })),
            ),
          ),
          DesktopAppSettings.layerTest({
            ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
            localEnvironmentEnabled: false,
            ...options.settings,
          }),
          layerPrimary(Option.fromUndefinedOr(options.config)),
          DesktopWslEnvironment.layerTest({
            isAvailable: true,
            distros: [{ name: "ExampleDistro", isDefault: true, version: 2 }],
            getUserHome: () => Option.some("/home/developer"),
          }),
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("Offline identity resolution must not request HTTP")),
          ),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

const statePath = Effect.gen(function* () {
  return (yield* DesktopEnvironment.DesktopEnvironment).stateDir;
});
const named = (environmentId: string) =>
  BrowserProfileScope.browserProfileScope(environmentId, "work");

describe("browser profile scope", () => {
  it.effect.each([undefined, "previous-windows-environment"])(
    "retains the actual WSL primary descriptor when native identity is %s",
    (nativeIdentity) => {
      const requestedUrls: string[] = [];
      const http = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            requestedUrls.push(request.url);
            return HttpClientResponse.fromWeb(
              request,
              new Response(
                JSON.stringify({
                  environmentId: "wsl-primary",
                  label: "WSL",
                  platform: { os: "linux", arch: "x64" },
                  serverVersion: "1.2.3",
                  capabilities: {},
                }),
                { headers: { "content-type": "application/json" } },
              ),
            );
          }),
        ),
      );
      return withState(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* statePath;
          if (nativeIdentity !== undefined)
            yield* fs.writeFileString(`${directory}/environment-id`, nativeIdentity);
          const local = yield* named("wsl-primary");
          assert.deepEqual(local, {
            scope: '["wsl-primary","work"]',
            persistent: true,
            namespace: "profile",
          });
          assert.deepEqual(yield* named("remote"), local);
          assert.deepEqual(requestedUrls, ["http://127.0.0.1:3774/.well-known/t3/environment"]);
        }).pipe(Effect.provide(http)),
        {
          platform: "win32",
          config: primaryConfig,
          settings: { localEnvironmentEnabled: true, wslOnly: true, wslBackendEnabled: true },
        },
      );
    },
  );

  it.effect("preserves native signed-in storage while the desktop is remote-only", () =>
    withState(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* statePath;
        yield* fs.writeFileString(`${directory}/environment-id`, "native-primary\n");
        const local = yield* named("native-primary");
        assert.equal(local.scope, '["native-primary","work"]');
        assert.deepEqual(yield* named("remote"), local);
        assert.equal(
          yield* fs.readFileString(`${directory}/browser-profile-environment-id`),
          "native-primary\n",
        );
      }),
    ),
  );

  it.effect.each([null, "ExampleDistro"])(
    "reads only the historical WSL primary while offline (selected distro=%s)",
    (distro) =>
      withState(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* statePath;
          yield* fs.writeFileString(`${directory}/environment-id`, "previous-windows-primary");
          const reads: string[] = [];
          const wslIdentityPath =
            "\\\\wsl.localhost\\ExampleDistro\\home\\developer\\.lastcode\\userdata\\environment-id";
          const scopedFs = {
            ...fs,
            readFileString: (file: string) => {
              reads.push(file);
              return file === wslIdentityPath
                ? Effect.succeed("historical-wsl-primary\n")
                : fs.readFileString(file);
            },
          };
          const resolved = yield* named("remote").pipe(
            Effect.provideService(FileSystem.FileSystem, scopedFs),
          );
          assert.equal(resolved.scope, '["historical-wsl-primary","work"]');
          assert.isTrue(reads.includes(wslIdentityPath));
          assert.isFalse(reads.includes(`${directory}/environment-id`));
          const switched = yield* named("another-remote").pipe(
            Effect.provide(
              DesktopAppSettings.layerTest(DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS),
            ),
            Effect.provide(
              Layer.mock(DesktopBackendPool.DesktopBackendPool)({
                primary: Effect.die("Persisted identity must not read a changed primary"),
              }),
            ),
          );
          assert.deepEqual(switched, resolved);
        }),
        {
          platform: "win32",
          settings: { wslOnly: true, wslBackendEnabled: true, wslDistro: distro },
        },
      ),
  );

  it.effect("gives simultaneous fresh remote-only tabs one durable desktop identity", () =>
    withState(
      Effect.gen(function* () {
        const resolved = yield* Effect.all([named("remote-a"), named("remote-b")], {
          concurrency: "unbounded",
        });
        assert.deepEqual(resolved[0], resolved[1]);
        const fs = yield* FileSystem.FileSystem;
        const identity = (yield* fs.readFileString(
          `${yield* statePath}/browser-profile-environment-id`,
        )).trim();
        assert.equal(resolved[0].scope, JSON.stringify([identity, "work"]));
        assert.notEqual(identity, "remote-a");
        assert.notEqual(identity, "remote-b");
      }),
    ),
  );

  it.effect.each(["browser-profile-environment-id", "environment-id"])(
    "rejects a corrupted %s instead of choosing another cookie jar",
    (file) =>
      withState(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* statePath;
          yield* fs.writeFileString(`${directory}/${file}`, "   \n");
          const error = yield* named("remote").pipe(Effect.flip);
          assert.instanceOf(error, BrowserProfileScope.BrowserProfileScopeError);
          if (file === "environment-id")
            assert.isFalse(yield* fs.exists(`${directory}/browser-profile-environment-id`));
        }),
      ),
  );

  it.effect("rejects an unreadable historical WSL identity without falling back to Windows", () =>
    withState(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* statePath;
        yield* fs.writeFileString(`${directory}/environment-id`, "previous-windows-primary");
        const error = yield* named("remote").pipe(
          Effect.provide(
            DesktopWslEnvironment.layerTest({
              getUserHome: () => Option.none(),
              distros: [{ name: "ExampleDistro", isDefault: true, version: 2 }],
            }),
          ),
          Effect.flip,
        );
        assert.instanceOf(error, BrowserProfileScope.BrowserProfileScopeError);
        assert.isFalse(yield* fs.exists(`${directory}/browser-profile-environment-id`));
      }),
      { platform: "win32", settings: { wslOnly: true, wslBackendEnabled: true } },
    ),
  );

  it.effect("waits for an enabled primary on a fresh desktop before selecting its session", () =>
    withState(
      Effect.gen(function* () {
        const error = yield* named("remote").pipe(Effect.flip);
        assert.instanceOf(error, BrowserProfileScope.BrowserProfileScopeError);
      }),
      { settings: { localEnvironmentEnabled: true } },
    ),
  );

  it.effect("keeps builtins per destination without any anchor dependencies", () =>
    withState(
      Effect.gen(function* () {
        for (const profileId of [
          undefined,
          DEFAULT_BROWSER_PROFILE_ID,
          INCOGNITO_BROWSER_PROFILE_ID,
        ]) {
          const local = yield* BrowserProfileScope.browserProfileScope("local", profileId);
          const remote = yield* BrowserProfileScope.browserProfileScope("remote", profileId);
          assert.notEqual(local.scope, remote.scope);
          assert.equal(remote.persistent, profileId !== INCOGNITO_BROWSER_PROFILE_ID);
        }
      }).pipe(Effect.provideService(DesktopEnvironment.DesktopEnvironment, null as never)),
    ),
  );
});
