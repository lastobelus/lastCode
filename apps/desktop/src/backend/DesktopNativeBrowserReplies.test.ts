import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSink from "@effect/platform-node/NodeSink";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- This test injects a native Writable callback error into NodeSink.
import * as NodeStream from "node:stream";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/process";
import * as NodeURL from "node:url";
import { assert, it } from "@effect/vitest";
import { DEFAULT_CLIENT_SETTINGS, EnvironmentId } from "@t3tools/contracts";
import { makeLocalFileTracer, makeTraceSink } from "@t3tools/shared/observability";
import * as Logger from "effect/Logger";
import * as Tracer from "effect/Tracer";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as DesktopBackendManager from "./DesktopBackendManager.ts";
import * as DesktopBrowserHost from "../preview/DesktopBrowserHost.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopTelemetryPublisher from "../telemetry/DesktopTelemetryPublisher.ts";
import * as DesktopWslEnvironment from "../wsl/DesktopWslEnvironment.ts";

const baseConfig: DesktopBackendManager.DesktopBackendStartConfig = {
  executablePath: process.execPath,
  args: [],
  entryPath: "fixture.mjs",
  cwd: process.cwd(),
  env: {},
  bootstrap: {
    mode: "desktop",
    noBrowser: true,
    port: 8111,
    t3Home: process.cwd(),
    host: "127.0.0.1",
    desktopBootstrapToken: "fixture-token",
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  },
  bootstrapDelivery: "fd3",
  extendEnv: true,
  httpBaseUrl: new URL("http://127.0.0.1:8111"),
  captureOutput: true,
  preflightFailure: Option.none(),
};

function makeTestInstance(input: {
  readonly config: DesktopBackendManager.DesktopBackendStartConfig;
  readonly desktopBrowserHost: DesktopBrowserHost.DesktopBrowserHost["Service"];
  readonly prepareDesktopBrowser: Effect.Effect<void>;
  readonly spawnerLayer?: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>;
  readonly backendOutputLog: Pick<
    DesktopObservability.DesktopBackendOutputLogShape,
    "writeOutputChunk"
  >;
}) {
  return DesktopBackendManager.makeBackendInstance({
    id: DesktopBackendManager.PRIMARY_INSTANCE_ID,
    label: Effect.succeed("Fixture"),
    configResolve: Effect.succeed(input.config),
    prepareDesktopBrowser: input.prepareDesktopBrowser,
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        input.spawnerLayer ?? NodeServices.layer,
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response(null, { status: 200 })),
            ),
          ),
        ),
        Layer.succeed(DesktopBrowserHost.DesktopBrowserHost, input.desktopBrowserHost),
        Layer.succeed(DesktopObservability.DesktopBackendOutputLogFactory, {
          forInstance: () =>
            Effect.succeed({
              beginSession: () => Effect.void,
              discardSession: Effect.void,
              persistFailureSnapshot: () => Effect.void,
              persistFailure: () => Effect.void,
              ...input.backendOutputLog,
            }),
        }),
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
        DesktopWslEnvironment.layerTest(),
      ),
    ),
  );
}

const decodeEnvironmentId = Schema.decodeEffect(EnvironmentId);

const decodeTraceRecord = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      name: Schema.String,
      attributes: Schema.Record(Schema.String, Schema.Unknown),
      events: Schema.Array(Schema.Unknown),
      exit: Schema.Struct({ _tag: Schema.String, cause: Schema.optionalKey(Schema.String) }),
    }),
  ),
);

function runNativeBrowser(
  mode: "healthy" | "preparation-failure" | "catalogue-failure" | "sink-failure",
) {
  let output = "";
  let preparationCount = 0;
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "native-browser-replies-" });
    const identityPath = `${directory}/environment-id`;
    yield* fs.writeFileString(identityPath, "11111111-1111-4111-8111-111111111111\n");
    if (mode === "catalogue-failure") {
      yield* fs.makeDirectory(`${directory}/userdata`);
      yield* fs.writeFileString(
        `${directory}/userdata/client-settings.json`,
        JSON.stringify({
          browserProfiles: [
            {
              id: "fixture-profile-id",
              name: "private-profile-name-sentinel",
              kind: "private-profile-parse-sentinel",
            },
          ],
        }),
      );
    }
    const filePath = `${directory}/desktop.trace.ndjson`;
    const stoppedReader = yield* Deferred.make<void>();
    const sink = yield* makeTraceSink({
      filePath,
      maxBytes: 1_000_000,
      maxFiles: 1,
      batchWindowMs: 60_000,
    });
    const tracer = yield* makeLocalFileTracer({
      filePath,
      maxBytes: 1_000_000,
      maxFiles: 1,
      batchWindowMs: 60_000,
      sink: {
        ...sink,
        push: (record) => {
          sink.push(record);
          if (
            record.type === "effect-span" &&
            record.name ===
              (mode === "sink-failure"
                ? "desktop.browser.replyStream"
                : "desktop.browser.commandStream") &&
            record.exit._tag === "Failure"
          ) {
            Deferred.doneUnsafe(stoppedReader, Effect.void);
          }
        },
      },
    });
    yield* Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make.pipe(
        Effect.provide(
          mode === "catalogue-failure"
            ? DesktopClientSettings.layer.pipe(
                Layer.provide(
                  DesktopEnvironment.layer({
                    dirname: directory,
                    homeDirectory: directory,
                    platform: "linux",
                    processArch: "x64",
                    appVersion: "1.0.0",
                    appPath: directory,
                    isPackaged: true,
                    resourcesPath: directory,
                    runningUnderArm64Translation: false,
                  }).pipe(Layer.provide(DesktopConfig.layerTest({ T3CODE_HOME: directory }))),
                ),
              )
            : DesktopClientSettings.layerTest(
                Option.some({
                  ...DEFAULT_CLIENT_SETTINGS,
                  browserProfiles: [
                    {
                      id: "fixture-profile-id",
                      name: "private-profile-name-sentinel",
                      kind: "persistent",
                    },
                  ],
                }),
              ),
        ),
      );
      const verified = yield* Deferred.make<void>();
      const fixture = NodeURL.fileURLToPath(
        new URL("./testing/NativeBrowserReplies.fixture.mjs", import.meta.url),
      );
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      // Inject an actual Writable callback error at the production sink boundary.
      // Other descriptors and the child lifecycle still use the real Node spawner.
      const failingSpawner = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) =>
          spawner.spawn(command).pipe(
            Effect.map((handle) =>
              ChildProcessSpawner.makeHandle({
                ...handle,
                getInputFd: (fd) =>
                  fd === 6
                    ? NodeSink.fromWritable({
                        evaluate: () =>
                          new NodeStream.Writable({
                            write(_chunk, _encoding, callback) {
                              callback(new Error("fixture-reply-write-failure"));
                            },
                          }),
                        onError: (cause) =>
                          new PlatformError.PlatformError(
                            new PlatformError.SystemError({
                              _tag: "Unknown",
                              module: "ChildProcess",
                              method: "fixtureWrite",
                              description: "fixture-reply-write-failure",
                              cause,
                            }),
                          ),
                      })
                    : handle.getInputFd(fd),
              }),
            ),
          ),
        ),
      );
      const instance = yield* makeTestInstance({
        desktopBrowserHost: host,
        ...(mode === "sink-failure" ? { spawnerLayer: failingSpawner } : {}),
        config: {
          ...baseConfig,
          args: [fixture, mode],
          entryPath: fixture,
          cwd: directory,
          bootstrap: {
            ...baseConfig.bootstrap,
            t3Home: directory,
            desktopBrowserFd: 6,
            desktopBrowserControlFd: 7,
          },
        },
        prepareDesktopBrowser: Effect.gen(function* () {
          preparationCount += 1;
          if (mode === "preparation-failure")
            return yield* Effect.die(new Error("fixture-preparation-failure"));
          const raw = yield* fs.readFileString(identityPath);
          const environmentId = yield* decodeEnvironmentId(raw.trim());
          yield* host.bindEnvironment("local", environmentId, () =>
            Effect.succeed({ scope: "fixture-profile", persistent: true }),
          );
        }).pipe(Effect.orDie),
        backendOutputLog: {
          writeOutputChunk: (_stream, chunk) =>
            Effect.gen(function* () {
              output += chunk;
              if (
                output.includes("verified") ||
                (mode === "sink-failure" && output.includes("sink-failure-ready"))
              )
                yield* Deferred.succeed(verified, void 0);
            }),
        },
      });
      yield* instance.start;
      // Completion is a completed span milestone or the child's verified replies, never a delay.
      yield* Deferred.await(
        mode === "preparation-failure" || mode === "sink-failure" ? stoppedReader : verified,
      ).pipe(Effect.timeout("7 seconds"));
      if (mode === "sink-failure")
        yield* Deferred.await(verified).pipe(Effect.timeout("7 seconds"));
      yield* instance.stop();
    }).pipe(
      Effect.provideService(Tracer.Tracer, tracer),
      Effect.provide(
        Logger.layer(mode === "catalogue-failure" ? [Logger.tracerLogger] : [], {
          mergeWithExisting: false,
        }),
      ),
    );
    yield* sink.flush;
    const trace = yield* fs.readFileString(filePath);
    return {
      output,
      preparationCount,
      trace,
      records: trace
        .trim()
        .split("\n")
        .map((line) => decodeTraceRecord(line)),
    };
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));
}

it.live(
  "replies to consecutive native profile requests and persists safe catalogue diagnostics over inherited pipes",
  () =>
    Effect.gen(function* () {
      const result = yield* runNativeBrowser("healthy");
      assert.equal(result.preparationCount, 1);
      assert.include(result.output, "received:profiles-first");
      assert.include(result.output, "received:profiles-second");
      // The helper stops the live backend before flushing its trace. Neither
      // indefinite transport stream should report that scoped stop as a fault.
      for (const name of ["desktop.browser.replyStream", "desktop.browser.commandStream"])
        assert.isFalse(
          result.records.some((record) => record.name === name && record.exit._tag === "Failure"),
          `${name} excludes ordinary backend shutdown`,
        );
      for (const requestId of ["profiles-first", "profiles-second"]) {
        for (const name of [
          "commandReceived",
          "readProfileSettings",
          "publishProfiles",
          "dequeueProfiles",
        ]) {
          const record = result.records.find(
            (record) =>
              record.name === `desktop.browser.${name}` &&
              record.attributes.requestId === requestId,
          );
          assert.isDefined(record, `${name} saved for ${requestId}`);
          assert.equal(record?.exit._tag, "Success");
        }
      }
      for (const forbidden of [
        "private-profile-name-sentinel",
        "fixture-profile-id",
        "retainedRootRequestIds",
        "fixture-epoch",
      ])
        assert.notInclude(result.trace, forbidden);
      for (const record of result.records.filter((record) =>
        record.name.startsWith("desktop.browser."),
      )) {
        assert.isEmpty(record.events);
        for (const key of Object.keys(record.attributes))
          assert.include(["fd", "commandType", "requestId", "desktopHostId", "available"], key);
      }
    }),
);

it.live("persists the native reply-stream failure from its actual Writable sink boundary", () =>
  Effect.gen(function* () {
    const result = yield* runNativeBrowser("sink-failure");
    assert.include(result.output, "sink-failure-ready");
    assert.equal(result.preparationCount, 1);
    const failure = result.records.find((record) => record.name === "desktop.browser.replyStream");
    assert.equal(failure?.exit._tag, "Failure");
    assert.include(failure?.exit.cause ?? "", "fixture-reply-write-failure");
    assert.isTrue(
      result.records.some(
        (record) =>
          record.name === "desktop.browser.dequeueProfiles" &&
          record.attributes.requestId === "profiles-first" &&
          record.exit._tag === "Success",
      ),
    );
    assert.isFalse(
      result.records.some(
        (record) =>
          record.name === "desktop.browser.forwardProfiles" && record.exit._tag === "Success",
      ),
    );
    for (const forbidden of [
      "private-profile-name-sentinel",
      "fixture-profile-id",
      "retainedRootRequestIds",
      "fixture-epoch",
    ])
      assert.notInclude(result.trace, forbidden);
  }),
);

it.live("keeps settings warnings outside native browser diagnostics", () =>
  Effect.gen(function* () {
    const result = yield* runNativeBrowser("catalogue-failure");
    assert.include(result.output, "received:profiles-first");
    assert.include(result.output, "received:profiles-second");
    // Prove the real settings reader and tracer logger emitted the warning.
    const settingsRead = result.records.find(
      (record) => record.name === "desktop.clientSettings.get",
    );
    assert.isNotEmpty(settingsRead?.events ?? []);
    assert.equal(settingsRead?.exit._tag, "Failure");
    assert.include(
      JSON.stringify(settingsRead?.events),
      "Could not decode desktop client settings",
    );
    // None of the new browser diagnostics encloses that warning or its cause.
    const browserRecords = result.records.filter((record) =>
      record.name.startsWith("desktop.browser."),
    );
    assert.notInclude(JSON.stringify(browserRecords), "private-profile-parse-sentinel");
    assert.notInclude(JSON.stringify(browserRecords), "private-profile-name-sentinel");
    for (const record of browserRecords) assert.isEmpty(record.events);
    const availabilityRecords = result.records.filter(
      (record) =>
        record.name === "desktop.browser.readProfileSettings" ||
        record.name === "desktop.browser.publishProfiles",
    );
    assert.lengthOf(availabilityRecords, 4);
    for (const record of availabilityRecords) {
      assert.equal(record.exit._tag, "Success");
      assert.equal(record.attributes.available, false);
    }
  }),
);

it.live(
  "persists the native preparation defect and stopped-reader cause with console logging discarded",
  () =>
    Effect.gen(function* () {
      const result = yield* runNativeBrowser("preparation-failure");
      assert.equal(result.preparationCount, 1);
      const marker = result.records.find(
        (record) => record.name === "desktop.browser.prepareStarted",
      );
      assert.equal(marker?.exit._tag, "Success");
      for (const name of ["desktop.browser.prepare", "desktop.browser.commandStream"]) {
        const record = result.records.find((record) => record.name === name);
        assert.equal(record?.exit._tag, "Failure", `${name} failure saved`);
        assert.include(record?.exit.cause ?? "", "fixture-preparation-failure");
      }
    }),
);
