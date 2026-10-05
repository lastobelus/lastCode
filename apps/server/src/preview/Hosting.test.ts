import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as Duration from "effect/Duration";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";

import {
  PreviewHostingLeaseId,
  ThreadId,
  type DiscoveredLocalServer,
  type PreviewHostingLeaseMetadata,
  type TerminalOpenInput,
  type TerminalSummary,
} from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import * as PortScanner from "./PortScanner.ts";
import * as PreviewHosting from "./Hosting.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import type * as PtyAdapter from "../terminal/PtyAdapter.ts";
import * as ProcessRunner from "../processRunner.ts";

const PREVIEW_URL = "http://localhost:5173/field-examples";
const encodePersistedHostingState = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      version: Schema.Literal(1),
      leases: Schema.Array(PreviewHosting.PreviewHostingLease),
    }),
  ),
);
const encodeUnknownJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

interface TerminalHarness {
  readonly opens: TerminalOpenInput[];
  readonly writes: Array<{
    readonly threadId: string;
    readonly terminalId: string;
    readonly data: string;
  }>;
  readonly closes: Array<{ readonly threadId: string; readonly terminalId: string }>;
  readonly historyDeletes: Array<{ readonly threadId: string; readonly terminalId: string }>;
  readonly summaries: TerminalSummary[];
  readonly liveSummaries?: TerminalSummary[];
  readonly failWrite?: boolean;
  readonly failClose?:
    | boolean
    | ((input: { readonly threadId: string; readonly terminalId?: string | undefined }) => boolean);
  readonly onWrite?: () => Effect.Effect<void, TerminalManager.TerminalError>;
  readonly onOpen?: (input: TerminalOpenInput) => Effect.Effect<void>;
  readonly onRefreshMetadata?: () => Effect.Effect<void>;
  readonly onCloseAttempt?: (input: {
    readonly threadId: string;
    readonly terminalId?: string | undefined;
  }) => Effect.Effect<void>;
  readonly onClose?: () => Effect.Effect<void, TerminalManager.TerminalError>;
  readonly onWaitForThreadShutdown?: (
    threadId: string,
  ) => Effect.Effect<void, TerminalManager.TerminalShutdownError>;
}

function terminalLayer(harness: TerminalHarness) {
  const service = {
    open: (input) => {
      harness.opens.push(input);
      return (harness.onOpen?.(input) ?? Effect.void).pipe(
        Effect.as({
          threadId: input.threadId,
          terminalId: input.terminalId,
          cwd: input.cwd,
          worktreePath: input.worktreePath ?? null,
          status: "running" as const,
          pid: 100,
          history: "",
          exitCode: null,
          exitSignal: null,
          label: "zsh",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
    },
    write: (input) => {
      harness.writes.push(input);
      if (harness.failWrite) {
        return Effect.fail(
          new TerminalManager.TerminalWriteError({
            threadId: input.threadId,
            terminalId: input.terminalId,
            terminalPid: 100,
            cause: new Error("synthetic PTY write failure"),
          }),
        );
      }
      const previous = harness.summaries.find(
        (summary) => summary.threadId === input.threadId && summary.terminalId === input.terminalId,
      );
      if (previous) {
        const index = harness.summaries.indexOf(previous);
        harness.summaries[index] = { ...previous, hasRunningSubprocess: true };
      } else {
        harness.summaries.push({
          threadId: input.threadId,
          terminalId: input.terminalId,
          cwd: "/workspace",
          worktreePath: "/workspace",
          status: "running",
          pid: 100,
          exitCode: null,
          exitSignal: null,
          hasRunningSubprocess: true,
          label: "dev-server",
          updatedAt: "2026-01-01T00:00:00.000Z",
        });
      }
      if (harness.liveSummaries !== undefined) {
        const live = harness.liveSummaries.find(
          (summary) =>
            summary.threadId === input.threadId && summary.terminalId === input.terminalId,
        );
        if (live) {
          const index = harness.liveSummaries.indexOf(live);
          harness.liveSummaries[index] = { ...live, hasRunningSubprocess: true };
        } else {
          harness.liveSummaries.push({
            threadId: input.threadId,
            terminalId: input.terminalId,
            cwd: "/workspace",
            worktreePath: "/workspace",
            status: "running",
            pid: 100,
            exitCode: null,
            exitSignal: null,
            hasRunningSubprocess: true,
            label: "dev-server",
            updatedAt: "2026-01-01T00:00:00.000Z",
          });
        }
      }
      return harness.onWrite?.() ?? Effect.void;
    },
    close: (input) => {
      harness.closes.push({ threadId: input.threadId, terminalId: input.terminalId ?? "" });
      if (input.deleteHistory === true) {
        harness.historyDeletes.push({
          threadId: input.threadId,
          terminalId: input.terminalId ?? "",
        });
      }
      const attempt = harness.onCloseAttempt?.(input) ?? Effect.void;
      if (
        harness.failClose === true ||
        (typeof harness.failClose === "function" && harness.failClose(input))
      ) {
        return attempt.pipe(
          Effect.andThen(
            Effect.fail(
              new TerminalManager.TerminalWriteError({
                threadId: input.threadId,
                terminalId: input.terminalId ?? "preview-test",
                terminalPid: 100,
                cause: new Error("synthetic PTY close failure"),
              }),
            ),
          ),
        );
      }
      for (let index = harness.summaries.length - 1; index >= 0; index--) {
        const summary = harness.summaries[index];
        if (
          summary?.threadId === input.threadId &&
          (input.terminalId === undefined || summary.terminalId === input.terminalId)
        ) {
          harness.summaries.splice(index, 1);
        }
      }
      return attempt.pipe(Effect.andThen(harness.onClose?.() ?? Effect.void));
    },
    metadata: Effect.sync(() => harness.liveSummaries ?? harness.summaries),
    history: () => Effect.die("Startup transcripts must remain local."),
    waitForThreadShutdown: (threadId) => harness.onWaitForThreadShutdown?.(threadId) ?? Effect.void,
    refreshMetadata: (harness.onRefreshMetadata?.() ?? Effect.void).pipe(
      Effect.as(harness.summaries),
    ),
  } satisfies Partial<TerminalManager.TerminalManager["Service"]>;
  return Layer.mock(TerminalManager.TerminalManager)({
    ...service,
    shutdownThread: (threadId) =>
      Effect.gen(function* () {
        const sessions = (yield* service.metadata).filter(
          (terminal) => terminal.threadId === threadId,
        );
        const results = yield* Effect.forEach(
          sessions,
          (terminal) =>
            service.close({ threadId, terminalId: terminal.terminalId }).pipe(Effect.result),
          { concurrency: "unbounded" },
        );
        const shutdown = yield* service.waitForThreadShutdown(threadId).pipe(Effect.result);
        const failure = results.find((result) => result._tag === "Failure");
        if (failure?._tag === "Failure") return yield* failure.failure;
        if (shutdown._tag === "Failure") return yield* shutdown.failure;
      }),
  });
}

function discoveryLayer(
  ready: boolean,
  scannedServers: ReadonlyArray<DiscoveredLocalServer>,
  harness: TerminalHarness,
  attributeTerminal = true,
) {
  return Layer.mock(PortScanner.PortDiscovery)({
    scan: () => Effect.succeed(scannedServers),
    subscribe: (input, listener) =>
      Effect.acquireRelease(
        Effect.suspend(() => {
          if (!ready) return Effect.void;
          const url = input.configuredUrls[0] ?? PREVIEW_URL;
          const parsed = new URL(url);
          const server: DiscoveredLocalServer = {
            host: parsed.hostname,
            port: Number(parsed.port),
            url,
            processName: "node",
            pid: 100,
            terminal:
              attributeTerminal && harness.opens.at(-1) !== undefined
                ? {
                    threadId: ThreadId.make(harness.opens.at(-1)!.threadId),
                    terminalId: harness.opens.at(-1)!.terminalId,
                  }
                : null,
          };
          return listener([server]);
        }),
        () => Effect.void,
      ),
    retain: Effect.acquireRelease(Effect.void, () => Effect.void),
  });
}

function testTerminalHarness(overrides: Partial<TerminalHarness> = {}): TerminalHarness {
  return {
    opens: [],
    writes: [],
    closes: [],
    historyDeletes: [],
    summaries: [],
    ...overrides,
  };
}

function terminalFixture(
  threadId: string,
  terminalId: string,
  status: TerminalSummary["status"] = "running",
  hasRunningSubprocess = true,
): TerminalSummary {
  return {
    threadId,
    terminalId,
    cwd: "/workspace",
    worktreePath: "/workspace",
    status,
    pid: status === "running" ? 100 : null,
    exitCode: null,
    exitSignal: null,
    hasRunningSubprocess,
    label: terminalId,
    updatedAt: "1970-01-01T00:00:00.000Z",
  };
}

function leaseFixture(
  overrides: Partial<PreviewHosting.PreviewHostingLease> = {},
): PreviewHosting.PreviewHostingLease {
  return {
    id: "preview-lease",
    threadId: "thread-1",
    terminalId: "preview-terminal",
    command: "pnpm dev --port 5173",
    cwd: "/workspace",
    worktreePath: "/workspace",
    url: PREVIEW_URL,
    handedOffAt: "1970-01-01T00:00:00.000Z",
    expiresAt: "1970-01-02T00:00:00.000Z",
    status: "active",
    ...overrides,
  };
}

function hostingLayer(
  config: ServerConfig.ServerConfig["Service"],
  harness: TerminalHarness,
  ready = true,
  scannedServers: ReadonlyArray<DiscoveredLocalServer> = [],
  attributeTerminal = true,
  fileSystemLayer?: Layer.Layer<FileSystem.FileSystem>,
) {
  const dependencies = Layer.mergeAll(
    NodeServices.layer,
    ServerConfig.layer(config),
    terminalLayer(harness),
    discoveryLayer(ready, scannedServers, harness, attributeTerminal),
  );
  const hosting =
    fileSystemLayer === undefined
      ? PreviewHosting.layer
      : PreviewHosting.layer.pipe(Layer.provide(fileSystemLayer));
  return hosting.pipe(Layer.provideMerge(dependencies));
}

function failFirstExpiredStateWriteLayer(
  failedWrite: Deferred.Deferred<void>,
  releaseFailure: Deferred.Deferred<void>,
  persistedEmptyState: Deferred.Deferred<void>,
) {
  return Layer.effect(
    FileSystem.FileSystem,
    Effect.map(FileSystem.FileSystem, (fs) => {
      let failedOnce = false;
      return new Proxy(fs, {
        get(target, property) {
          if (property === "writeFileString") {
            return (filePath: string, data: string, options?: { readonly mode?: number }) => {
              if (!failedOnce && data.includes('"status":"expired"')) {
                failedOnce = true;
                return Deferred.succeed(failedWrite, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseFailure)),
                  Effect.andThen(
                    Effect.fail(
                      new PlatformError.PlatformError(
                        new PlatformError.SystemError({
                          _tag: "PermissionDenied",
                          module: "FileSystem",
                          method: "writeFileString",
                          pathOrDescriptor: filePath,
                          description: "synthetic transient expiry write failure",
                        }),
                      ),
                    ),
                  ),
                );
              }
              return target
                .writeFileString(filePath, data, options)
                .pipe(
                  Effect.tap(() =>
                    data.includes('"leases":[]')
                      ? Deferred.succeed(persistedEmptyState, undefined)
                      : Effect.void,
                  ),
                );
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as FileSystem.FileSystem;
    }),
  ).pipe(Layer.provide(NodeServices.layer));
}

describe("PreviewHosting", () => {
  it.effect.each([false, true])(
    "waits for thread cleanup before completing even when terminal close fails (%s)",
    (failClose) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "preview-hosting-stop-drain-" });
        const config = yield* Effect.provide(
          ServerConfig.ServerConfig,
          ServerConfig.layerTest(process.cwd(), root),
        );
        const cleanupStarted = yield* Deferred.make<void>();
        const finishCleanup = yield* Deferred.make<void>();
        const otherTerminal = terminalFixture("thread-2", "unrelated-terminal");
        const harness = testTerminalHarness({
          summaries: [terminalFixture("thread-1", "command-terminal"), otherTerminal],
          failClose,
          onWaitForThreadShutdown: (threadId) =>
            Effect.gen(function* () {
              assert.equal(threadId, "thread-1");
              yield* Deferred.succeed(cleanupStarted, undefined);
              yield* Deferred.await(finishCleanup);
            }),
        });
        yield* Effect.scoped(
          Effect.gen(function* () {
            const hosting = yield* PreviewHosting.PreviewHosting;
            const stopping = yield* hosting
              .stopThread("thread-1")
              .pipe(Effect.result, Effect.forkScoped);
            yield* Deferred.await(cleanupStarted);
            assert.isUndefined(stopping.pollUnsafe());
            assert.deepEqual(harness.closes, [
              { threadId: "thread-1", terminalId: "command-terminal" },
            ]);
            assert.include(harness.summaries, otherTerminal);
            yield* Deferred.succeed(finishCleanup, undefined);
            assert.equal((yield* Fiber.join(stopping))._tag, failClose ? "Failure" : "Success");
          }).pipe(Effect.provide(hostingLayer(config, harness))),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("surfaces failed process cleanup instead of reporting a successful stop", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "preview-hosting-stop-kill-failure-",
      });
      const config = yield* Effect.provide(
        ServerConfig.ServerConfig,
        ServerConfig.layerTest(process.cwd(), root),
      );
      const failure = new TerminalManager.TerminalShutdownError({
        threadId: "thread-1",
        terminalIds: ["command-terminal"],
      });
      const harness = testTerminalHarness({
        summaries: [terminalFixture("thread-1", "command-terminal")],
        onWaitForThreadShutdown: () => Effect.fail(failure),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const hosting = yield* PreviewHosting.PreviewHosting;
          const result = yield* hosting.stopThread("thread-1").pipe(Effect.result);
          assert.equal(result._tag, "Failure");
          if (result._tag === "Failure") assert.equal(result.failure, failure);
        }).pipe(Effect.provide(hostingLayer(config, harness))),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("a second Stop retries a failed terminal without touching another thread", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "preview-hosting-stop-retry-" });
      const config = yield* Effect.provide(
        ServerConfig.ServerConfig,
        ServerConfig.layerTest(process.cwd(), root),
      );
      const processes: Array<
        PtyAdapter.PtyProcess & {
          killSignals: Array<string | undefined>;
          killFailure: Error | undefined;
        }
      > = [];
      const terminalsLayer = Layer.effect(
        TerminalManager.TerminalManager,
        TerminalManager.makeWithOptions({
          logsDir: config.terminalLogsDir,
          processKillGraceMs: 0,
          processTable: Effect.succeed([]),
          ptyAdapter: {
            spawn: () =>
              Effect.sync(() => {
                const ptyProcess = {
                  pid: 9000 + processes.length,
                  killSignals: [] as Array<string | undefined>,
                  killFailure: undefined as Error | undefined,
                  write: () => {},
                  resize: () => {},
                  kill: (signal?: string) => {
                    ptyProcess.killSignals.push(signal);
                    if (ptyProcess.killFailure !== undefined) throw ptyProcess.killFailure;
                  },
                  onData: () => () => {},
                  onExit: () => () => {},
                };
                processes.push(ptyProcess);
                return ptyProcess;
              }),
          },
        }),
      ).pipe(Layer.provide(ProcessRunner.layer));
      const dependencies = Layer.mergeAll(
        ServerConfig.layer(config),
        terminalsLayer,
        discoveryLayer(true, [], testTerminalHarness()),
      ).pipe(Layer.provideMerge(NodeServices.layer));
      yield* Effect.scoped(
        Effect.gen(function* () {
          const hosting = yield* PreviewHosting.PreviewHosting;
          const terminals = yield* TerminalManager.TerminalManager;
          yield* terminals.open({
            threadId: "thread-1",
            terminalId: "command-terminal",
            cwd: root,
          });
          yield* terminals.open({
            threadId: "thread-2",
            terminalId: "unrelated-terminal",
            cwd: root,
          });
          const first = processes[0]!;
          const other = processes[1]!;
          first.killFailure = new Error("transient signal failure");

          const failure = yield* hosting.stopThread("thread-1").pipe(Effect.result);
          assert.equal(failure._tag, "Failure");
          if (failure._tag === "Failure") {
            assert.equal(failure.failure._tag, "TerminalShutdownError");
          }
          assert.deepEqual(first.killSignals, ["SIGTERM"]);
          assert.deepEqual(other.killSignals, []);
          assert.sameMembers(
            (yield* terminals.metadata).map((terminal) => terminal.threadId),
            ["thread-1", "thread-2"],
          );

          first.killFailure = undefined;
          yield* hosting.stopThread("thread-1");
          assert.deepEqual(first.killSignals, ["SIGTERM", "SIGTERM", "SIGKILL"]);
          assert.deepEqual(other.killSignals, []);
          assert.deepEqual(
            (yield* terminals.metadata).map((terminal) => terminal.threadId),
            ["thread-2"],
          );
          yield* terminals.close({ threadId: "thread-2" });
          yield* terminals.waitForThreadShutdown("thread-2");
        }).pipe(Effect.provide(PreviewHosting.layer.pipe(Layer.provideMerge(dependencies)))),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "stops a preview immediately while recovery is waiting for a server that never becomes ready",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(1_000);
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "preview-hosting-stop-readiness-",
        });
        const config = yield* Effect.provide(
          ServerConfig.ServerConfig,
          ServerConfig.layerTest(process.cwd(), root),
        );
        const preview = leaseFixture();
        yield* fs.makeDirectory(config.stateDir, { recursive: true });
        yield* fs.writeFileString(
          `${config.stateDir}/preview-hosting.json`,
          encodePersistedHostingState({ version: 1, leases: [preview] }),
        );
        const wrote = yield* Deferred.make<void>();
        const harness = testTerminalHarness({
          summaries: [terminalFixture("thread-1", "ordinary-terminal")],
          onWrite: () => Deferred.succeed(wrote, undefined).pipe(Effect.asVoid),
        });
        yield* Effect.scoped(
          Effect.gen(function* () {
            const hosting = yield* PreviewHosting.PreviewHosting;
            const pendingRecovery = yield* Effect.forkScoped(
              hosting.recover({
                threadId: "thread-1",
                leaseId: PreviewHostingLeaseId.make(preview.id),
                url: preview.url,
              }),
            );
            yield* Deferred.await(wrote);
            yield* hosting.stopThread("thread-1");
            assert.isNull(yield* Fiber.join(pendingRecovery));
            assert.deepEqual(harness.summaries, []);
            assert.deepEqual(yield* hosting.list(), []);
            assert.include(
              harness.closes.map((terminal) => terminal.terminalId),
              "ordinary-terminal",
            );
          }).pipe(Effect.provide(hostingLayer(config, harness, false))),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "subscribes to initial and changing environment-wide lease summaries without launch secrets",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(1_000);
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "preview-hosting-subscribe-" });
        const config = yield* Effect.provide(
          ServerConfig.ServerConfig,
          ServerConfig.layerTest(process.cwd(), root),
        );
        const first = leaseFixture({
          command: "SECRET=fixture-secret pnpm dev",
          env: { SECRET: "fixture-secret" },
        });
        yield* fs.makeDirectory(config.stateDir, { recursive: true });
        yield* fs.writeFileString(
          `${config.stateDir}/preview-hosting.json`,
          encodePersistedHostingState({ version: 1, leases: [first] }),
        );
        const harness = testTerminalHarness();
        const snapshots: Array<ReadonlyArray<PreviewHostingLeaseMetadata>> = [];
        yield* Effect.scoped(
          Effect.gen(function* () {
            const hosting = yield* PreviewHosting.PreviewHosting;
            const unsubscribe = yield* hosting.subscribe((leases) =>
              Effect.sync(() => {
                snapshots.push(leases);
              }),
            );
            assert.deepEqual(snapshots, [
              [
                {
                  leaseId: first.id,
                  threadId: ThreadId.make(first.threadId),
                  terminalId: first.terminalId,
                  url: first.url,
                  handedOffAt: first.handedOffAt,
                  expiresAt: first.expiresAt,
                  status: "active",
                },
              ],
            ]);
            const second = yield* hosting.launch({
              threadId: "thread-2",
              command: "pnpm dev --port 5174",
              cwd: "/workspace/two",
              env: { SECRET: "another-fixture-secret" },
              url: "http://localhost:5174/",
            });
            assert.isTrue(
              snapshots.some((leases) =>
                leases.some((lease) => lease.leaseId === second.id && lease.status === "starting"),
              ),
            );
            assert.isTrue(
              snapshots
                .at(-1)
                ?.some((lease) => lease.leaseId === second.id && lease.status === "active"),
            );
            assert.sameMembers(snapshots.at(-1)?.map((lease) => lease.threadId) ?? [], [
              "thread-1",
              "thread-2",
            ]);
            const serializedSnapshots = yield* encodeUnknownJson(snapshots);
            assert.notInclude(serializedSnapshots, "fixture-secret");
            assert.notInclude(serializedSnapshots, '"command"');
            assert.notInclude(serializedSnapshots, '"env"');
            assert.notInclude(serializedSnapshots, '"cwd"');
            yield* hosting.stopThread("thread-1");
            assert.deepEqual(
              snapshots.at(-1)?.map((lease) => lease.leaseId),
              [second.id],
            );
            unsubscribe();
            const count = snapshots.length;
            yield* hosting.stopThread("thread-2");
            assert.equal(snapshots.length, count);
          }).pipe(Effect.provide(hostingLayer(config, harness))),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "cannot miss a lease mutation while its initial subscription snapshot is being delivered",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(1_000);
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "preview-hosting-subscribe-race-",
        });
        const config = yield* Effect.provide(
          ServerConfig.ServerConfig,
          ServerConfig.layerTest(process.cwd(), root),
        );
        const initialStarted = yield* Deferred.make<void>();
        const releaseInitial = yield* Deferred.make<void>();
        const mutationStarted = yield* Deferred.make<void>();
        const harness = testTerminalHarness();
        const snapshots: Array<ReadonlyArray<PreviewHostingLeaseMetadata>> = [];
        yield* Effect.scoped(
          Effect.gen(function* () {
            const hosting = yield* PreviewHosting.PreviewHosting;
            const pendingSubscription = yield* Effect.forkScoped(
              hosting.subscribe((leases) =>
                Effect.gen(function* () {
                  snapshots.push(leases);
                  if (snapshots.length === 1) {
                    yield* Deferred.succeed(initialStarted, undefined);
                    yield* Deferred.await(releaseInitial);
                  }
                }),
              ),
            );
            yield* Deferred.await(initialStarted);
            const pendingLaunch = yield* Effect.forkScoped(
              Deferred.succeed(mutationStarted, undefined).pipe(
                Effect.andThen(
                  hosting.launch({
                    threadId: "thread-1",
                    command: "pnpm dev --port 5173",
                    cwd: "/workspace",
                    url: PREVIEW_URL,
                  }),
                ),
              ),
            );
            yield* Deferred.await(mutationStarted);
            yield* Deferred.succeed(releaseInitial, undefined);
            const unsubscribe = yield* Fiber.join(pendingSubscription);
            const lease = yield* Fiber.join(pendingLaunch);
            assert.deepEqual(snapshots[0], []);
            assert.equal(snapshots.at(-1)?.[0]?.leaseId, lease.id);
            assert.equal(snapshots.at(-1)?.[0]?.status, "active");
            unsubscribe();
          }).pipe(Effect.provide(hostingLayer(config, harness))),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.each([1, 3])(
    "keeps an in-flight recovery cancelled even if terminal close fails (metadata phase: %s)",
    (pauseAt) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(1_000);
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "preview-hosting-stop-recover-race-",
        });
        const config = yield* Effect.provide(
          ServerConfig.ServerConfig,
          ServerConfig.layerTest(process.cwd(), root),
        );
        const preview = leaseFixture();
        yield* fs.makeDirectory(config.stateDir, { recursive: true });
        yield* fs.writeFileString(
          `${config.stateDir}/preview-hosting.json`,
          encodePersistedHostingState({ version: 1, leases: [preview] }),
        );
        const refreshStarted = yield* Deferred.make<void>();
        const releaseRefresh = yield* Deferred.make<void>();
        const cancelled = yield* Deferred.make<void>();
        let refreshCount = 0;
        const harness = testTerminalHarness({
          summaries: [terminalFixture("thread-1", "ordinary-terminal")],
          failClose: (input) => pauseAt === 3 && input.terminalId === preview.terminalId,
          onRefreshMetadata: () =>
            Effect.suspend(() => {
              refreshCount++;
              return refreshCount === pauseAt
                ? Deferred.succeed(refreshStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseRefresh)),
                  )
                : Effect.void;
            }),
        });
        yield* Effect.scoped(
          Effect.gen(function* () {
            const hosting = yield* PreviewHosting.PreviewHosting;
            const unsubscribe = yield* hosting.subscribe((leases) =>
              leases.length === 0
                ? Deferred.succeed(cancelled, undefined).pipe(Effect.asVoid)
                : Effect.void,
            );
            const pendingRecovery = yield* Effect.forkScoped(
              hosting.recover({
                threadId: "thread-1",
                leaseId: PreviewHostingLeaseId.make(preview.id),
                url: preview.url,
              }),
            );
            yield* Deferred.await(refreshStarted);
            const pendingStop = yield* Effect.forkScoped(
              hosting.stopThread("thread-1").pipe(Effect.result),
            );
            yield* Deferred.await(cancelled);
            yield* Deferred.succeed(releaseRefresh, undefined);
            assert.isNull(yield* Fiber.join(pendingRecovery));
            assert.equal(
              (yield* Fiber.join(pendingStop))._tag,
              pauseAt === 3 ? "Failure" : "Success",
            );
            assert.equal(harness.opens.length, pauseAt === 3 ? 1 : 0);
            assert.equal(harness.writes.length, pauseAt === 3 ? 1 : 0);
            assert.include(
              harness.closes.map((terminal) => terminal.terminalId),
              "ordinary-terminal",
            );
            assert.deepEqual(yield* hosting.list(), []);
            unsubscribe();
          }).pipe(Effect.provide(hostingLayer(config, harness))),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "cancels running and stopped previews and closes every terminal in only the owning thread",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(1_000);
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "preview-hosting-stop-thread-" });
        const config = yield* Effect.provide(
          ServerConfig.ServerConfig,
          ServerConfig.layerTest(process.cwd(), root),
        );
        const running = leaseFixture();
        const stopped = leaseFixture({
          id: "stopped-preview",
          terminalId: "stopped-preview-terminal",
          url: "http://localhost:5174/",
        });
        const other = leaseFixture({
          id: "other-preview",
          threadId: "thread-2",
          terminalId: "other-preview-terminal",
          url: "http://localhost:5175/",
        });
        const otherTerminal = terminalFixture("thread-2", other.terminalId);
        const harness = testTerminalHarness({
          summaries: [
            terminalFixture("thread-1", running.terminalId),
            terminalFixture("thread-1", stopped.terminalId, "exited", false),
            terminalFixture("thread-1", "command-terminal"),
            terminalFixture("thread-1", "idle-shell", "running", false),
            terminalFixture("thread-1", "stopped-shell", "exited", false),
            otherTerminal,
          ],
        });
        yield* fs.makeDirectory(config.stateDir, { recursive: true });
        yield* fs.writeFileString(
          `${config.stateDir}/preview-hosting.json`,
          encodePersistedHostingState({ version: 1, leases: [running, stopped, other] }),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const hosting = yield* PreviewHosting.PreviewHosting;
            assert.equal((yield* hosting.list("thread-1")).length, 2);
            yield* hosting.stopThread("thread-1");
            assert.deepEqual(yield* hosting.list("thread-1"), []);
            assert.deepEqual(yield* hosting.list("thread-2"), [other]);
            for (const lease of [running, stopped]) {
              assert.isNull(
                yield* hosting.recover({
                  threadId: "thread-1",
                  leaseId: PreviewHostingLeaseId.make(lease.id),
                  url: lease.url,
                }),
              );
            }
            assert.deepEqual(harness.summaries, [otherTerminal]);
            assert.sameMembers(
              harness.closes.map((terminal) => terminal.terminalId),
              [
                running.terminalId,
                stopped.terminalId,
                "command-terminal",
                "idle-shell",
                "stopped-shell",
              ],
            );
            assert.isTrue(harness.closes.every((terminal) => terminal.threadId === "thread-1"));
            assert.sameMembers(
              harness.historyDeletes.map((terminal) => terminal.terminalId),
              [running.terminalId, stopped.terminalId],
            );
            assert.deepEqual(harness.opens, []);
            assert.equal(
              yield* fs.readFileString(`${config.stateDir}/preview-hosting.json`),
              `${encodePersistedHostingState({ version: 1, leases: [other] })}\n`,
            );
          }).pipe(Effect.provide(hostingLayer(config, harness))),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const restarted = yield* PreviewHosting.PreviewHosting;
            assert.isNull(
              yield* restarted.recover({
                threadId: "thread-1",
                leaseId: PreviewHostingLeaseId.make(running.id),
                url: running.url,
              }),
            );
          }).pipe(Effect.provide(hostingLayer(config, harness))),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("attempts every ordinary terminal even when preview and terminal cleanup fail", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_000);
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "preview-hosting-stop-failure-" });
      const config = yield* Effect.provide(
        ServerConfig.ServerConfig,
        ServerConfig.layerTest(process.cwd(), root),
      );
      const preview = leaseFixture();
      yield* fs.makeDirectory(config.stateDir, { recursive: true });
      yield* fs.writeFileString(
        `${config.stateDir}/preview-hosting.json`,
        encodePersistedHostingState({ version: 1, leases: [preview] }),
      );
      let shouldFail = true;
      const harness = testTerminalHarness({
        summaries: [
          terminalFixture("thread-1", preview.terminalId),
          terminalFixture("thread-1", "failing-command"),
          terminalFixture("thread-1", "other-command"),
          terminalFixture("thread-2", "unrelated-command"),
        ],
        failClose: (input) =>
          shouldFail &&
          (input.terminalId === preview.terminalId || input.terminalId === "failing-command"),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const hosting = yield* PreviewHosting.PreviewHosting;
          const result = yield* hosting.stopThread("thread-1").pipe(Effect.result);
          assert.equal(result._tag, "Failure");
          assert.include(
            harness.closes.map((terminal) => terminal.terminalId),
            "failing-command",
          );
          assert.include(
            harness.closes.map((terminal) => terminal.terminalId),
            "other-command",
          );
          assert.notInclude(
            harness.closes.map((terminal) => terminal.terminalId),
            "unrelated-command",
          );
          assert.deepEqual(yield* hosting.list("thread-1"), []);
          assert.include(
            yield* fs.readFileString(`${config.stateDir}/preview-hosting.json`),
            '"status":"expired"',
          );
          assert.isNull(
            yield* hosting.recover({
              threadId: "thread-1",
              leaseId: PreviewHostingLeaseId.make(preview.id),
              url: preview.url,
            }),
          );
          shouldFail = false;
          yield* hosting.stopThread("thread-1");
          assert.deepEqual(harness.summaries, [terminalFixture("thread-2", "unrelated-command")]);
          assert.deepEqual(yield* hosting.list(), []);
          assert.notInclude(
            harness.historyDeletes.map((terminal) => terminal.terminalId),
            "failing-command",
          );
        }).pipe(Effect.provide(hostingLayer(config, harness))),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "keeps cancelled previews unrecoverable and stops ordinary terminals after a persistence failure",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(1_000);
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "preview-hosting-stop-persist-" });
        const config = yield* Effect.provide(
          ServerConfig.ServerConfig,
          ServerConfig.layerTest(process.cwd(), root),
        );
        const preview = leaseFixture();
        yield* fs.makeDirectory(config.stateDir, { recursive: true });
        yield* fs.writeFileString(
          `${config.stateDir}/preview-hosting.json`,
          encodePersistedHostingState({ version: 1, leases: [preview] }),
        );
        const failedWrite = yield* Deferred.make<void>();
        const releaseFailure = yield* Deferred.make<void>();
        const persistedEmptyState = yield* Deferred.make<void>();
        yield* Deferred.succeed(releaseFailure, undefined);
        const harness = testTerminalHarness({
          summaries: [
            terminalFixture("thread-1", preview.terminalId),
            terminalFixture("thread-1", "command-terminal"),
          ],
        });
        yield* Effect.scoped(
          Effect.gen(function* () {
            const hosting = yield* PreviewHosting.PreviewHosting;
            const result = yield* hosting.stopThread("thread-1").pipe(Effect.result);
            assert.equal(result._tag, "Failure");
            if (result._tag === "Failure") assert.equal(result.failure._tag, "PreviewHostingError");
            assert.isTrue(yield* Deferred.isDone(failedWrite));
            assert.isTrue(yield* Deferred.isDone(persistedEmptyState));
            assert.sameMembers(
              harness.closes.map((terminal) => terminal.terminalId),
              [preview.terminalId, "command-terminal"],
            );
            assert.deepEqual(harness.summaries, []);
            assert.isNull(
              yield* hosting.recover({
                threadId: "thread-1",
                leaseId: PreviewHostingLeaseId.make(preview.id),
                url: preview.url,
              }),
            );
            assert.equal(
              yield* fs.readFileString(`${config.stateDir}/preview-hosting.json`),
              `${encodePersistedHostingState({ version: 1, leases: [] })}\n`,
            );
          }).pipe(
            Effect.provide(
              hostingLayer(
                config,
                harness,
                true,
                [],
                true,
                failFirstExpiredStateWriteLayer(failedWrite, releaseFailure, persistedEmptyState),
              ),
            ),
          ),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("launches a named terminal and fixes its 24-hour expiry at handoff", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_000);
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "preview-hosting-test-" });
      const configLayer = ServerConfig.layerTest(process.cwd(), root);
      const config = yield* Effect.provide(ServerConfig.ServerConfig, configLayer);
      const harness = testTerminalHarness();
      const layer = hostingLayer(config, harness);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const hosting = yield* PreviewHosting.PreviewHosting;
          const lease = yield* hosting.launch({
            threadId: "thread-1",
            command: "pnpm dev --host 127.0.0.1 --port 5173",
            cwd: "/workspace",
            worktreePath: "/workspace",
            env: { FIXTURE_MODE: "preview" },
            url: PREVIEW_URL,
          });

          assert.equal(lease.status, "active");
          assert.equal(
            Date.parse(lease.expiresAt) - Date.parse(lease.handedOffAt),
            PreviewHosting.PREVIEW_HOSTING_LEASE_MS,
          );
          assert.equal(lease.url, PREVIEW_URL);
          assert.equal(lease.terminalId, `preview-${lease.id}`);
          assert.deepEqual(harness.opens[0], {
            threadId: "thread-1",
            terminalId: lease.terminalId,
            cwd: "/workspace",
            worktreePath: "/workspace",
            env: { FIXTURE_MODE: "preview" },
          });
          assert.equal(harness.writes[0]?.data, "pnpm dev --host 127.0.0.1 --port 5173\n");
          assert.isTrue(yield* hosting.ownsTerminal("thread-1", lease.terminalId));
          assert.isFalse(yield* hosting.ownsTerminal("thread-2", lease.terminalId));
          assert.deepEqual(yield* hosting.list("thread-1"), [lease]);
          if ((yield* HostProcessPlatform) !== "win32") {
            const statePath = `${config.stateDir}/preview-hosting.json`;
            assert.equal((yield* fs.stat(statePath)).mode & 0o777, 0o600);
            // Each atomic replacement must restore private permissions, even if
            // an existing state file has been made more permissive.
            yield* fs.chmod(statePath, 0o644);
          }
          const repeated = yield* hosting.launch({
            threadId: "thread-1",
            command: "pnpm dev --host 127.0.0.1 --port 5173",
            cwd: "/workspace",
            worktreePath: "/workspace",
            env: { FIXTURE_MODE: "preview" },
            url: PREVIEW_URL,
          });
          if ((yield* HostProcessPlatform) !== "win32") {
            assert.equal(
              (yield* fs.stat(`${config.stateDir}/preview-hosting.json`)).mode & 0o777,
              0o600,
            );
          }
          assert.equal(repeated.id, lease.id);
          assert.equal(repeated.expiresAt, lease.expiresAt);
          assert.equal(harness.opens.length, 1);
          assert.equal(harness.writes.length, 1);
        }).pipe(Effect.provide(layer)),
      );
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, TestClock.layer()))),
  );

  it.effect("infers the git worktree root for nested preview launch directories", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_000);
      const fs = yield* FileSystem.FileSystem;
      const tempRoot = yield* fs.makeTempDirectoryScoped({ prefix: "preview-hosting-git-root-" });
      const repositoryRoot = `${tempRoot}/repo`;
      const cwd = `${repositoryRoot}/packages/app`;
      yield* fs.makeDirectory(cwd, { recursive: true });
      // Linked worktrees record their metadata in a `.git` file rather than a directory.
      yield* fs.writeFileString(`${repositoryRoot}/.git`, "gitdir: /git/worktrees/preview-test");
      const canonicalRepositoryRoot = yield* fs.realPath(repositoryRoot);
      const canonicalCwd = yield* fs.realPath(cwd);
      const config = yield* Effect.provide(
        ServerConfig.ServerConfig,
        ServerConfig.layerTest(process.cwd(), tempRoot),
      );
      const harness = testTerminalHarness();

      yield* Effect.scoped(
        Effect.gen(function* () {
          const hosting = yield* PreviewHosting.PreviewHosting;
          const lease = yield* hosting.launch({
            threadId: "thread-nested-preview",
            command: "pnpm dev --port 5173",
            cwd,
            url: PREVIEW_URL,
          });

          assert.equal(lease.cwd, canonicalCwd);
          assert.equal(lease.worktreePath, canonicalRepositoryRoot);
          assert.deepEqual(harness.opens[0], {
            threadId: "thread-nested-preview",
            terminalId: lease.terminalId,
            cwd: canonicalCwd,
            worktreePath: canonicalRepositoryRoot,
          });
          assert.include(
            yield* fs.readFileString(`${config.stateDir}/preview-hosting.json`),
            `"worktreePath":"${canonicalRepositoryRoot}"`,
          );
          assert.include(yield* hosting.protectedWorkspacePaths(), canonicalRepositoryRoot);
        }).pipe(Effect.provide(hostingLayer(config, harness))),
      );
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, TestClock.layer()))),
  );

  it.effect("canonicalizes symlinked launch directories and explicit worktree roots", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tempRoot = yield* fs.makeTempDirectoryScoped({ prefix: "preview-hosting-symlink-" });
      const repositoryRoot = `${tempRoot}/real-repository`;
      const nestedCwd = `${repositoryRoot}/packages/app`;
      const aliasCwd = `${tempRoot}/unrelated-parent/packages/app`;
      const aliasRoot = `${tempRoot}/repository-alias`;
      yield* fs.makeDirectory(nestedCwd, { recursive: true });
      yield* fs.writeFileString(`${repositoryRoot}/.git`, "gitdir: /git/worktrees/preview-test");
      yield* fs.makeDirectory(`${tempRoot}/unrelated-parent/packages`, { recursive: true });
      yield* fs.symlink(nestedCwd, aliasCwd);
      yield* fs.symlink(repositoryRoot, aliasRoot);
      const canonicalRepositoryRoot = yield* fs.realPath(repositoryRoot);
      const canonicalNestedCwd = yield* fs.realPath(nestedCwd);
      const config = yield* Effect.provide(
        ServerConfig.ServerConfig,
        ServerConfig.layerTest(process.cwd(), tempRoot),
      );
      const harness = testTerminalHarness();

      yield* Effect.scoped(
        Effect.gen(function* () {
          const hosting = yield* PreviewHosting.PreviewHosting;
          const inferred = yield* hosting.launch({
            threadId: "thread-symlink-cwd",
            command: "pnpm dev --port 5173",
            cwd: aliasCwd,
            url: PREVIEW_URL,
          });
          const explicit = yield* hosting.launch({
            threadId: "thread-symlink-root",
            command: "pnpm dev --port 5174",
            cwd: nestedCwd,
            worktreePath: aliasRoot,
            url: "http://localhost:5174/field-examples",
          });

          assert.equal(inferred.cwd, canonicalNestedCwd);
          assert.equal(inferred.worktreePath, canonicalRepositoryRoot);
          assert.equal(explicit.cwd, canonicalNestedCwd);
          assert.equal(explicit.worktreePath, canonicalRepositoryRoot);
          assert.deepEqual(harness.opens, [
            {
              threadId: "thread-symlink-cwd",
              terminalId: inferred.terminalId,
              cwd: canonicalNestedCwd,
              worktreePath: canonicalRepositoryRoot,
            },
            {
              threadId: "thread-symlink-root",
              terminalId: explicit.terminalId,
              cwd: canonicalNestedCwd,
              worktreePath: canonicalRepositoryRoot,
            },
          ]);
          const protectedPaths = yield* hosting.protectedWorkspacePaths();
          assert.include(protectedPaths, canonicalRepositoryRoot);
          assert.notInclude(protectedPaths, aliasRoot);
          assert.notInclude(protectedPaths, aliasCwd);
        }).pipe(Effect.provide(hostingLayer(config, harness))),
      );
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, TestClock.layer()))),
  );

  it.effect(
    "canonicalizes symlinked paths from persisted preview leases for cleanup protection",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const tempRoot = yield* fs.makeTempDirectoryScoped({
          prefix: "preview-hosting-saved-alias-",
        });
        const repositoryRoot = `${tempRoot}/real-repository`;
        const nestedCwd = `${repositoryRoot}/packages/app`;
        const aliasRoot = `${tempRoot}/repository-alias`;
        const aliasCwd = `${aliasRoot}/packages/app`;
        yield* fs.makeDirectory(nestedCwd, { recursive: true });
        yield* fs.writeFileString(`${repositoryRoot}/.git`, "gitdir: /git/worktrees/preview-test");
        yield* fs.symlink(repositoryRoot, aliasRoot);
        const canonicalRepositoryRoot = yield* fs.realPath(repositoryRoot);
        const canonicalNestedCwd = yield* fs.realPath(nestedCwd);
        const config = yield* Effect.provide(
          ServerConfig.ServerConfig,
          ServerConfig.layerTest(process.cwd(), tempRoot),
        );
        const persistedLease = {
          id: "saved-symlink-lease",
          threadId: "thread-saved-symlink",
          terminalId: "preview-saved-symlink",
          command: "pnpm dev --port 5173",
          cwd: aliasCwd,
          worktreePath: aliasRoot,
          url: PREVIEW_URL,
          handedOffAt: "1970-01-01T00:00:00.000Z",
          expiresAt: "1970-01-02T00:00:00.000Z",
          status: "active" as const,
        };
        yield* fs.makeDirectory(config.stateDir, { recursive: true });
        yield* fs.writeFileString(
          `${config.stateDir}/preview-hosting.json`,
          encodePersistedHostingState({ version: 1, leases: [persistedLease] }),
        );

        yield* Effect.scoped(
          Effect.gen(function* () {
            const hosting = yield* PreviewHosting.PreviewHosting;
            const protectedPaths = yield* hosting.protectedWorkspacePaths();
            assert.include(protectedPaths, canonicalNestedCwd);
            assert.include(protectedPaths, canonicalRepositoryRoot);
            assert.notInclude(protectedPaths, aliasCwd);
            assert.notInclude(protectedPaths, aliasRoot);
          }).pipe(Effect.provide(hostingLayer(config, testTerminalHarness()))),
        );
      }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, TestClock.layer()))),
  );

  it.effect("rejects canonical URL expansion without damaging existing lease state", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_000);
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "preview-hosting-url-length-" });
      const config = yield* Effect.provide(
        ServerConfig.ServerConfig,
        ServerConfig.layerTest(process.cwd(), root),
      );
      const harness = testTerminalHarness();
      const oversized = `http://localhost:5174/${"漢".repeat(300)}`;
      assert.isBelow(oversized.length, 2_048);
      assert.isAbove(new URL(oversized).href.length, 2_048);
      const lease = yield* Effect.scoped(
        Effect.gen(function* () {
          const hosting = yield* PreviewHosting.PreviewHosting;
          const active = yield* hosting.launch({
            threadId: "thread-1",
            command: "pnpm dev --port 5173",
            cwd: "/workspace",
            url: PREVIEW_URL,
          });
          const rejected = yield* Effect.result(
            hosting.launch({
              threadId: "thread-1",
              command: "pnpm dev --port 5174",
              cwd: "/workspace",
              url: oversized,
            }),
          );
          assert.equal(rejected._tag, "Failure");
          if (rejected._tag === "Failure") {
            assert.equal(rejected.failure._tag, "PreviewHostingError");
            if (rejected.failure._tag === "PreviewHostingError") {
              assert.equal(rejected.failure.operation, "validate");
            }
          }
          assert.deepEqual(yield* hosting.list("thread-1"), [active]);
          assert.equal(harness.opens.length, 1);
          return active;
        }).pipe(Effect.provide(hostingLayer(config, harness))),
      );
      // A rejected new URL must not make a previously valid registry unreadable.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const reopened = yield* PreviewHosting.PreviewHosting;
          assert.deepEqual(yield* reopened.list("thread-1"), [lease]);
        }).pipe(Effect.provide(hostingLayer(config, harness))),
      );
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, TestClock.layer()))),
  );

  it.effect(
    "removes deleted-thread leases only after close and keeps failed-close worktrees protected",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(1_000);
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "preview-hosting-delete-thread-",
        });
        const config = yield* Effect.provide(
          ServerConfig.ServerConfig,
          ServerConfig.layerTest(process.cwd(), root),
        );
        const deletedThreadLease = {
          id: "deleted-thread-lease",
          threadId: "deleted-thread",
          terminalId: "preview-deleted-thread-lease",
          command: "pnpm dev --port 5173",
          cwd: "/workspace/deleted",
          worktreePath: "/worktrees/deleted",
          url: "http://localhost:5173/deleted",
          handedOffAt: "1970-01-01T00:00:00.000Z",
          expiresAt: "1970-01-02T00:00:00.000Z",
          status: "active" as const,
        };
        const archivedThreadLease = {
          ...deletedThreadLease,
          id: "archived-thread-lease",
          threadId: "archived-thread",
          terminalId: "preview-archived-thread-lease",
          cwd: "/workspace/archived",
          worktreePath: "/worktrees/archived",
          url: "http://localhost:5174/archived",
        };
        yield* fs.makeDirectory(config.stateDir, { recursive: true });
        yield* fs.writeFileString(
          `${config.stateDir}/preview-hosting.json`,
          encodePersistedHostingState({
            version: 1,
            leases: [deletedThreadLease, archivedThreadLease],
          }),
        );
        let shouldFailClose = true;
        const harness = testTerminalHarness({ failClose: () => shouldFailClose });

        yield* Effect.scoped(
          Effect.gen(function* () {
            const hosting = yield* PreviewHosting.PreviewHosting;
            const firstAttempt = yield* Effect.result(hosting.removeThread("deleted-thread"));

            assert.equal(firstAttempt._tag, "Failure");
            assert.deepEqual(yield* hosting.list("deleted-thread"), []);
            assert.isNull(
              yield* hosting.recover({
                threadId: "deleted-thread",
                leaseId: PreviewHostingLeaseId.make(deletedThreadLease.id),
                url: deletedThreadLease.url,
              }),
            );
            assert.deepEqual(yield* hosting.protectedWorkspacePaths(), [
              "/workspace/deleted",
              "/worktrees/deleted",
              "/workspace/archived",
              "/worktrees/archived",
            ]);

            shouldFailClose = false;
            yield* hosting.removeThread("deleted-thread");

            assert.deepEqual(yield* hosting.list("deleted-thread"), []);
            assert.deepEqual(yield* hosting.list("archived-thread"), [archivedThreadLease]);
            assert.deepEqual(yield* hosting.protectedWorkspacePaths(), [
              "/workspace/archived",
              "/worktrees/archived",
            ]);
            assert.isTrue(
              harness.closes.some(
                ({ threadId, terminalId }) =>
                  threadId === "deleted-thread" && terminalId === deletedThreadLease.terminalId,
              ),
            );
            assert.isTrue(harness.closes.every(({ threadId }) => threadId === "deleted-thread"));
          }).pipe(Effect.provide(hostingLayer(config, harness))),
        );
      }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, TestClock.layer()))),
  );

  it.effect("reserves a discovery port across threads regardless of path or loopback alias", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "preview-hosting-port-reservation-",
      });
      const config = yield* Effect.provide(
        ServerConfig.ServerConfig,
        ServerConfig.layerTest(process.cwd(), root),
      );
      const harness = testTerminalHarness();

      yield* Effect.scoped(
        Effect.gen(function* () {
          const hosting = yield* PreviewHosting.PreviewHosting;
          const first = yield* hosting.launch({
            threadId: "thread-1",
            command: "pnpm dev --port 5173",
            cwd: "/workspace/one",
            worktreePath: "/workspace/one",
            url: PREVIEW_URL,
          });
          const second = yield* Effect.result(
            hosting.launch({
              threadId: "thread-2",
              command: "pnpm dev --port 5173",
              cwd: "/workspace/two",
              worktreePath: "/workspace/two",
              url: "http://127.0.0.1:5173/another-page",
            }),
          );

          assert.equal(first.status, "active");
          assert.equal(second._tag, "Failure");
          if (second._tag === "Failure") {
            assert.equal(second.failure._tag, "PreviewHostingError");
            if (second.failure._tag === "PreviewHostingError") {
              assert.match(second.failure.detail ?? "", /discovery port 5173/);
            }
          }
          assert.equal(harness.opens.length, 1);
          assert.equal(harness.writes.length, 1);
        }).pipe(Effect.provide(hostingLayer(config, harness))),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("releases the reservation lock before opening its managed terminal", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_000);
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "preview-hosting-workspace-lock-" });
      const config = yield* Effect.provide(
        ServerConfig.ServerConfig,
        ServerConfig.layerTest(process.cwd(), root),
      );
      const openStarted = yield* Deferred.make<void>();
      const terminalLockAcquired = yield* Deferred.make<void>();
      const harness = testTerminalHarness({
        onOpen: (input) =>
          Deferred.succeed(openStarted, undefined).pipe(
            Effect.andThen(
              withWorkspaceLease(
                input.worktreePath ?? input.cwd,
                Deferred.succeed(terminalLockAcquired, undefined),
              ),
            ),
          ),
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const hosting = yield* PreviewHosting.PreviewHosting;
          const pending = yield* Effect.forkScoped(
            hosting.launch({
              threadId: "thread-1",
              command: "pnpm dev --port 5173",
              cwd: "/workspace",
              worktreePath: "/workspace",
              url: PREVIEW_URL,
            }),
          );
          const started = yield* Deferred.await(openStarted).pipe(
            Effect.asSome,
            Effect.timeoutOption(Duration.millis(100)),
          );
          assert.equal(started._tag, "Some");
          const acquired = yield* Deferred.await(terminalLockAcquired).pipe(
            Effect.asSome,
            Effect.timeoutOption(Duration.millis(100)),
          );
          assert.equal(acquired._tag, "Some");
          if (acquired._tag === "None") yield* TestClock.adjust(Duration.millis(100));
          const result = yield* Fiber.join(pending).pipe(Effect.result);
          assert.equal(result._tag, "Success");
          if (result._tag === "Success") assert.equal(result.success.status, "active");
          assert.isTrue(yield* Deferred.isDone(terminalLockAcquired));
        }).pipe(Effect.provide(hostingLayer(config, harness))),
      );
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, TestClock.layer()))),
  );

  it.effect("cleans up a new durable reservation interrupted before terminal open", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_000);
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "preview-hosting-cancel-before-open-",
      });
      const config = yield* Effect.provide(
        ServerConfig.ServerConfig,
        ServerConfig.layerTest(process.cwd(), root),
      );
      const refreshStarted = yield* Deferred.make<void>();
      const holdRefresh = yield* Deferred.make<void>();
      const harness = testTerminalHarness({
        onRefreshMetadata: () =>
          Deferred.succeed(refreshStarted, undefined).pipe(
            Effect.andThen(Deferred.await(holdRefresh)),
          ),
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const hosting = yield* PreviewHosting.PreviewHosting;
          const pending = yield* Effect.forkScoped(
            hosting.launch({
              threadId: "thread-1",
              command: "pnpm dev --port 5173",
              cwd: "/workspace",
              url: PREVIEW_URL,
            }),
          );
          yield* Deferred.await(refreshStarted);
          assert.include(
            yield* fs.readFileString(`${config.stateDir}/preview-hosting.json`),
            '"status":"starting"',
          );

          yield* Fiber.interrupt(pending);
          const exit = yield* Fiber.await(pending);
          assert.isTrue(Exit.isFailure(exit));
          if (Exit.isFailure(exit)) assert.isTrue(Cause.hasInterruptsOnly(exit.cause));
          assert.deepEqual(harness.opens, []);
          assert.equal(harness.closes.length, 1);
          assert.match(harness.closes[0]?.terminalId ?? "", /^preview-/);
          assert.deepEqual(yield* hosting.list("thread-1"), []);
          assert.equal(
            yield* fs.readFileString(`${config.stateDir}/preview-hosting.json`),
            '{"version":1,"leases":[]}\n',
          );
        }).pipe(Effect.provide(hostingLayer(config, harness))),
      );
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, TestClock.layer()))),
  );

  it.effect("cleans up a new lease interrupted after command write before readiness", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_000);
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "preview-hosting-cancel-after-write-",
      });
      const config = yield* Effect.provide(
        ServerConfig.ServerConfig,
        ServerConfig.layerTest(process.cwd(), root),
      );
      const wrote = yield* Deferred.make<void>();
      const holdWrite = yield* Deferred.make<void>();
      const harness = testTerminalHarness({
        onWrite: () =>
          Deferred.succeed(wrote, undefined).pipe(Effect.andThen(Deferred.await(holdWrite))),
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const hosting = yield* PreviewHosting.PreviewHosting;
          const pending = yield* Effect.forkScoped(
            hosting.launch({
              threadId: "thread-1",
              command: "pnpm dev --port 5173",
              cwd: "/workspace",
              url: PREVIEW_URL,
            }),
          );
          yield* Deferred.await(wrote);
          assert.equal(harness.opens.length, 1);
          assert.equal(harness.writes.length, 1);
          assert.include(
            yield* fs.readFileString(`${config.stateDir}/preview-hosting.json`),
            '"status":"starting"',
          );

          yield* Fiber.interrupt(pending);
          const exit = yield* Fiber.await(pending);
          assert.isTrue(Exit.isFailure(exit));
          if (Exit.isFailure(exit)) assert.isTrue(Cause.hasInterruptsOnly(exit.cause));
          assert.equal(harness.closes.length, 1);
          assert.equal(harness.closes[0]?.terminalId, harness.opens[0]?.terminalId);
          assert.deepEqual(yield* hosting.list("thread-1"), []);
          assert.equal(
            yield* fs.readFileString(`${config.stateDir}/preview-hosting.json`),
            '{"version":1,"leases":[]}\n',
          );
        }).pipe(Effect.provide(hostingLayer(config, harness, false))),
      );
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, TestClock.layer()))),
  );

  it.effect("does not clean up an existing lease when recovery is interrupted", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_000);
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "preview-hosting-cancel-recover-" });
      const config = yield* Effect.provide(
        ServerConfig.ServerConfig,
        ServerConfig.layerTest(process.cwd(), root),
      );
      const initialHarness = testTerminalHarness();
      const lease = yield* Effect.scoped(
        Effect.gen(function* () {
          const hosting = yield* PreviewHosting.PreviewHosting;
          return yield* hosting.launch({
            threadId: "thread-1",
            command: "pnpm dev --port 5173",
            cwd: "/workspace",
            url: PREVIEW_URL,
          });
        }).pipe(Effect.provide(hostingLayer(config, initialHarness))),
      );

      const refreshStarted = yield* Deferred.make<void>();
      const holdRefresh = yield* Deferred.make<void>();
      const recovering = testTerminalHarness({
        onRefreshMetadata: () =>
          Deferred.succeed(refreshStarted, undefined).pipe(
            Effect.andThen(Deferred.await(holdRefresh)),
          ),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const hosting = yield* PreviewHosting.PreviewHosting;
          const pending = yield* Effect.forkScoped(
            hosting.recover({ threadId: "thread-1", leaseId: lease.id, url: lease.url }),
          );
          yield* Deferred.await(refreshStarted);
          yield* Fiber.interrupt(pending);
          const exit = yield* Fiber.await(pending);
          assert.isTrue(Exit.isFailure(exit));
          if (Exit.isFailure(exit)) assert.isTrue(Cause.hasInterruptsOnly(exit.cause));
          assert.deepEqual(yield* hosting.list("thread-1"), [lease]);
          assert.deepEqual(recovering.closes, []);
        }).pipe(Effect.provide(hostingLayer(config, recovering))),
      );
      assert.include(
        yield* fs.readFileString(`${config.stateDir}/preview-hosting.json`),
        '"status":"active"',
      );
      assert.deepEqual(recovering.closes, []);
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, TestClock.layer()))),
  );

  it.effect(
    "recovers a persisted lease after service restart without extending or duplicating it",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(1_000);
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "preview-hosting-restart-" });
        const configLayer = ServerConfig.layerTest(process.cwd(), root);
        const config = yield* Effect.provide(ServerConfig.ServerConfig, configLayer);
        const first = testTerminalHarness();
        const firstLayer = hostingLayer(config, first);
        const lease = yield* Effect.scoped(
          Effect.gen(function* () {
            const hosting = yield* PreviewHosting.PreviewHosting;
            return yield* hosting.launch({
              threadId: "thread-1",
              command: "pnpm dev --port 5173",
              cwd: "/workspace",
              worktreePath: "/workspace",
              env: { FIXTURE_MODE: "restart" },
              url: PREVIEW_URL,
            });
          }).pipe(Effect.provide(firstLayer)),
        );
        yield* TestClock.adjust(Duration.hours(1));

        const restarted = testTerminalHarness({
          summaries: [
            {
              threadId: "thread-1",
              terminalId: lease.terminalId,
              cwd: "/workspace",
              worktreePath: "/workspace",
              status: "running",
              pid: 100,
              exitCode: null,
              exitSignal: null,
              hasRunningSubprocess: true,
              label: "terminating-preview",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          liveSummaries: [],
        });
        const secondLayer = hostingLayer(config, restarted);
        const recovered = yield* Effect.scoped(
          Effect.gen(function* () {
            const hosting = yield* PreviewHosting.PreviewHosting;
            const result = yield* hosting.recover({
              threadId: "thread-1",
              leaseId: lease.id,
              url: PREVIEW_URL,
            });
            assert.isNotNull(result);
            assert.equal(result?.id, lease.id);
            assert.equal(result?.expiresAt, lease.expiresAt);
            const repeated = yield* hosting.recover({
              threadId: "thread-1",
              leaseId: lease.id,
              url: PREVIEW_URL,
            });
            assert.equal(repeated?.id, lease.id);
            return result;
          }).pipe(Effect.provide(secondLayer)),
        );

        assert.equal(recovered?.expiresAt, lease.expiresAt);
        assert.equal(restarted.opens.length, 1);
        assert.equal(restarted.writes.length, 1);
        assert.deepEqual(restarted.opens[0], {
          threadId: "thread-1",
          terminalId: lease.terminalId,
          cwd: "/workspace",
          worktreePath: "/workspace",
          env: { FIXTURE_MODE: "restart" },
        });
      }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, TestClock.layer()))),
  );

  it.effect("automatically closes only its terminal at expiry and refuses later recovery", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(10_000);
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "preview-hosting-expiry-" });
      const config = yield* Effect.provide(
        ServerConfig.ServerConfig,
        ServerConfig.layerTest(process.cwd(), root),
      );
      const closed = yield* Deferred.make<void>();
      const ordinaryTerminal: TerminalSummary = {
        threadId: "thread-1",
        terminalId: "ordinary-shell",
        cwd: "/workspace",
        worktreePath: "/workspace",
        status: "running",
        pid: 99,
        exitCode: null,
        exitSignal: null,
        hasRunningSubprocess: false,
        label: "zsh",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      const harness = testTerminalHarness({
        summaries: [ordinaryTerminal],
        onClose: () => Deferred.succeed(closed, undefined).pipe(Effect.asVoid),
      });
      const layer = hostingLayer(config, harness);

      yield* Effect.scoped(
        Effect.gen(function* () {
          const hosting = yield* PreviewHosting.PreviewHosting;
          const lease = yield* hosting.launch({
            threadId: "thread-1",
            command: "pnpm dev --port 5173",
            cwd: "/workspace",
            url: PREVIEW_URL,
          });
          assert.deepEqual(harness.historyDeletes, []);
          assert.isTrue(yield* hosting.ownsTerminal("thread-1", lease.terminalId));
          yield* TestClock.adjust(Duration.millis(PreviewHosting.PREVIEW_HOSTING_LEASE_MS));
          yield* Deferred.await(closed);
          assert.deepEqual(harness.closes, [
            { threadId: "thread-1", terminalId: lease.terminalId },
          ]);
          assert.deepEqual(harness.historyDeletes, [
            { threadId: "thread-1", terminalId: lease.terminalId },
          ]);
          assert.deepEqual(harness.summaries, [ordinaryTerminal]);
          assert.isFalse(yield* hosting.ownsTerminal("thread-1", lease.terminalId));
          assert.deepEqual(yield* hosting.list("thread-1"), []);
          assert.isNull(
            yield* hosting.recover({
              threadId: "thread-1",
              leaseId: lease.id,
              url: PREVIEW_URL,
            }),
          );
          assert.equal(harness.writes.length, 1);
          assert.equal(
            yield* fs.readFileString(`${config.stateDir}/preview-hosting.json`),
            '{"version":1,"leases":[]}\n',
          );
        }).pipe(Effect.provide(layer)),
      );
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, TestClock.layer()))),
  );

  it.effect("does not let a failed close retry delay another lease's expiry", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(10_000);
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "preview-hosting-retry-deadline-" });
      const config = yield* Effect.provide(
        ServerConfig.ServerConfig,
        ServerConfig.layerTest(process.cwd(), root),
      );
      const firstCloseAttempted = yield* Deferred.make<void>();
      const secondClosed = yield* Deferred.make<void>();
      let firstTerminalId = "";
      const harness = testTerminalHarness({
        failClose: (input) => input.terminalId === firstTerminalId,
        onCloseAttempt: (input) =>
          input.terminalId === firstTerminalId
            ? Deferred.succeed(firstCloseAttempted, undefined)
            : Deferred.succeed(secondClosed, undefined),
      });
      const layer = hostingLayer(config, harness);

      yield* Effect.scoped(
        Effect.gen(function* () {
          const hosting = yield* PreviewHosting.PreviewHosting;
          const first = yield* hosting.launch({
            threadId: "thread-1",
            command: "pnpm dev --port 5173",
            cwd: "/workspace/one",
            url: PREVIEW_URL,
          });
          firstTerminalId = first.terminalId;
          yield* TestClock.adjust(Duration.seconds(30));
          const second = yield* hosting.launch({
            threadId: "thread-2",
            command: "pnpm dev --port 5174",
            cwd: "/workspace/two",
            url: "http://localhost:5174/preview",
          });

          yield* TestClock.adjust(
            Duration.millis(PreviewHosting.PREVIEW_HOSTING_LEASE_MS - 30_000),
          );
          yield* Deferred.await(firstCloseAttempted);
          assert.deepEqual(harness.closes, [
            { threadId: "thread-1", terminalId: first.terminalId },
          ]);

          yield* TestClock.adjust(Duration.seconds(30));
          const secondClose = yield* Deferred.await(secondClosed).pipe(
            Effect.asSome,
            Effect.timeoutOption(Duration.millis(1)),
          );
          assert.equal(secondClose._tag, "Some");
          assert.equal(harness.closes.filter((close) => close.threadId === "thread-2").length, 1);
          assert.isAtLeast(
            harness.closes.filter((close) => close.threadId === "thread-1").length,
            1,
          );
          assert.isNull(
            yield* hosting.recover({
              threadId: "thread-2",
              leaseId: second.id,
              url: second.url,
            }),
          );
        }).pipe(Effect.provide(layer)),
      );
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, TestClock.layer()))),
  );

  it.effect("keeps expiry cleanup running after one lease state write fails", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(10_000);
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "preview-hosting-expiry-persist-retry-",
      });
      const config = yield* Effect.provide(
        ServerConfig.ServerConfig,
        ServerConfig.layerTest(process.cwd(), root),
      );
      const failedWrite = yield* Deferred.make<void>();
      const releaseFailure = yield* Deferred.make<void>();
      const persistedEmptyState = yield* Deferred.make<void>();
      const bothClosed = yield* Deferred.make<void>();
      const closedIds = new Set<string>();
      const harness = testTerminalHarness({
        onCloseAttempt: (input) =>
          Effect.gen(function* () {
            closedIds.add(input.terminalId ?? "");
            if (closedIds.size >= 2) yield* Deferred.succeed(bothClosed, undefined);
          }),
      });
      const layer = hostingLayer(
        config,
        harness,
        true,
        [],
        true,
        failFirstExpiredStateWriteLayer(failedWrite, releaseFailure, persistedEmptyState),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const hosting = yield* PreviewHosting.PreviewHosting;
          const first = yield* hosting.launch({
            threadId: "thread-1",
            command: "pnpm dev --port 5173",
            cwd: "/workspace/one",
            url: PREVIEW_URL,
          });
          yield* TestClock.adjust(Duration.seconds(30));
          const second = yield* hosting.launch({
            threadId: "thread-2",
            command: "pnpm dev --port 5174",
            cwd: "/workspace/two",
            url: "http://localhost:5174/preview",
          });
          assert.equal(Date.parse(second.expiresAt) - Date.parse(first.expiresAt), 30_000);

          yield* TestClock.adjust(
            Duration.millis(PreviewHosting.PREVIEW_HOSTING_LEASE_MS - 30_000),
          );
          yield* Deferred.await(failedWrite);

          // The first cleanup is held inside its failed state write while the
          // second lease reaches its fixed deadline. Releasing it must make the
          // worker notice that deadline without another clock advance.
          yield* TestClock.adjust(Duration.seconds(30));
          yield* Deferred.succeed(releaseFailure, undefined);
          yield* Deferred.await(bothClosed);
          yield* Deferred.await(persistedEmptyState);

          assert.deepEqual(
            new Set(harness.closes.map((close) => close.terminalId)),
            new Set([first.terminalId, second.terminalId]),
          );
          assert.deepEqual(yield* hosting.list(), []);
        }).pipe(Effect.provide(layer)),
      );
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, TestClock.layer()))),
  );

  it.effect("serializes concurrent recovery cleanup and releases its lease lock", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(10_000);
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "preview-hosting-lock-release-" });
      const config = yield* Effect.provide(
        ServerConfig.ServerConfig,
        ServerConfig.layerTest(process.cwd(), root),
      );
      const closeStarted = yield* Deferred.make<void>();
      const releaseClose = yield* Deferred.make<void>();
      const firstRecoverStarted = yield* Deferred.make<void>();
      const secondRecoverStarted = yield* Deferred.make<void>();
      const harness = testTerminalHarness({
        onClose: () =>
          Deferred.succeed(closeStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseClose)),
          ),
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const hosting = yield* PreviewHosting.PreviewHosting;
          const lease = yield* hosting.launch({
            threadId: "thread-1",
            command: "pnpm dev --port 5173",
            cwd: "/workspace",
            url: PREVIEW_URL,
          });
          yield* TestClock.adjust(Duration.millis(PreviewHosting.PREVIEW_HOSTING_LEASE_MS));
          yield* Deferred.await(closeStarted);

          const first = yield* Effect.forkScoped(
            Deferred.succeed(firstRecoverStarted, undefined).pipe(
              Effect.andThen(
                hosting.recover({ threadId: "thread-1", leaseId: lease.id, url: lease.url }),
              ),
            ),
          );
          const second = yield* Effect.forkScoped(
            Deferred.succeed(secondRecoverStarted, undefined).pipe(
              Effect.andThen(
                hosting.recover({ threadId: "thread-1", leaseId: lease.id, url: lease.url }),
              ),
            ),
          );
          yield* Deferred.await(firstRecoverStarted);
          yield* Deferred.await(secondRecoverStarted);
          yield* Effect.yieldNow;
          yield* Deferred.succeed(releaseClose, undefined);

          assert.isNull(yield* Fiber.join(first));
          assert.isNull(yield* Fiber.join(second));
          assert.deepEqual(harness.closes, [
            { threadId: "thread-1", terminalId: lease.terminalId },
          ]);
          assert.equal(
            yield* fs.readFileString(`${config.stateDir}/preview-hosting.json`),
            '{"version":1,"leases":[]}\n',
          );
        }).pipe(Effect.provide(hostingLayer(config, harness))),
      );
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, TestClock.layer()))),
  );

  it.effect("does not persist an active lease when writing the launch command fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "preview-hosting-failed-write-" });
      const config = yield* Effect.provide(
        ServerConfig.ServerConfig,
        ServerConfig.layerTest(process.cwd(), root),
      );
      const harness = testTerminalHarness({ failWrite: true });
      const layer = hostingLayer(config, harness);

      yield* Effect.scoped(
        Effect.gen(function* () {
          const hosting = yield* PreviewHosting.PreviewHosting;
          const failed = yield* Effect.result(
            hosting.launch({
              threadId: "thread-1",
              command: "pnpm dev --port 5173",
              cwd: "/workspace",
              url: PREVIEW_URL,
            }),
          );
          assert.equal(failed._tag, "Failure");
          assert.deepEqual(yield* hosting.list("thread-1"), []);
          assert.isAtLeast(harness.closes.length, 1);
          assert.isTrue(
            harness.closes.every((close) => close.terminalId === harness.opens[0]?.terminalId),
          );
          assert.equal(
            yield* fs.readFileString(`${config.stateDir}/preview-hosting.json`),
            '{"version":1,"leases":[]}\n',
          );
        }).pipe(Effect.provide(layer)),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("retires a persisted starting lease when its retried launch fails", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_000);
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "preview-starting-retry-" });
      const config = yield* Effect.provide(
        ServerConfig.ServerConfig,
        ServerConfig.layerTest(process.cwd(), root),
      );
      const saved = {
        id: "unfinished-lease",
        threadId: "thread-1",
        terminalId: "preview-unfinished",
        command: "broken-command",
        cwd: "/workspace",
        worktreePath: null,
        url: PREVIEW_URL,
        handedOffAt: DateTime.formatIso(DateTime.makeUnsafe(1_000)),
        expiresAt: DateTime.formatIso(
          DateTime.makeUnsafe(1_000 + PreviewHosting.PREVIEW_HOSTING_LEASE_MS),
        ),
        status: "starting" as const,
      };
      yield* fs.makeDirectory(config.stateDir, { recursive: true });
      yield* fs.writeFileString(
        `${config.stateDir}/preview-hosting.json`,
        encodePersistedHostingState({ version: 1, leases: [saved] }),
      );
      let failWrite = true;
      const harness = testTerminalHarness({
        onWrite: () =>
          failWrite
            ? Effect.fail(
                new TerminalManager.TerminalWriteError({
                  threadId: saved.threadId,
                  terminalId: saved.terminalId,
                  terminalPid: 100,
                  cause: new Error("synthetic retry write failure"),
                }),
              )
            : Effect.void,
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const hosting = yield* PreviewHosting.PreviewHosting;
          const failed = yield* Effect.result(
            hosting.launch({
              threadId: saved.threadId,
              command: saved.command,
              cwd: saved.cwd,
              url: saved.url,
            }),
          );
          assert.equal(failed._tag, "Failure");
          assert.deepEqual(yield* hosting.list(), []);
          assert.deepEqual(harness.closes, [
            { threadId: saved.threadId, terminalId: saved.terminalId },
          ]);
          assert.equal(
            yield* fs.readFileString(`${config.stateDir}/preview-hosting.json`),
            `${encodePersistedHostingState({ version: 1, leases: [] })}\n`,
          );
          failWrite = false;
          const corrected = yield* hosting.launch({
            threadId: saved.threadId,
            command: "corrected-command",
            cwd: saved.cwd,
            url: saved.url,
          });
          assert.equal(corrected.status, "active");
          assert.notEqual(corrected.id, saved.id);
        }).pipe(Effect.provide(hostingLayer(config, harness))),
      );
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, TestClock.layer()))),
  );

  it.effect("retries failed preview cleanup after restart and removes the lease", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(10_000);
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "preview-hosting-not-ready-" });
      const config = yield* Effect.provide(
        ServerConfig.ServerConfig,
        ServerConfig.layerTest(process.cwd(), root),
      );
      const wrote = yield* Deferred.make<void>();
      const harness = testTerminalHarness({
        failClose: true,
        onWrite: () => Deferred.succeed(wrote, undefined).pipe(Effect.asVoid),
      });
      const layer = hostingLayer(config, harness, false);

      yield* Effect.scoped(
        Effect.gen(function* () {
          const hosting = yield* PreviewHosting.PreviewHosting;
          const pending = yield* Effect.forkScoped(
            Effect.result(
              hosting.launch({
                threadId: "thread-1",
                command: "pnpm dev --port 5173",
                cwd: "/workspace",
                url: PREVIEW_URL,
              }),
            ),
          );
          yield* Deferred.await(wrote);
          yield* Effect.yieldNow;
          yield* TestClock.adjust(Duration.seconds(31));
          const result = yield* Fiber.join(pending);

          assert.equal(result._tag, "Failure");
          assert.deepEqual(yield* hosting.list("thread-1"), []);
          assert.equal(harness.opens.length, 1);
          assert.equal(harness.writes.length, 1);
          if (result._tag === "Failure") {
            assert.include(result.failure.message, "No HTTP response was attributed");
            assert.include(result.failure.message, "Readiness deadline: 30000 ms");
          }
          assert.isAtLeast(harness.closes.length, 1);
          assert.isTrue(
            harness.closes.every((close) => close.terminalId === harness.opens[0]?.terminalId),
          );
        }).pipe(Effect.provide(layer)),
      );
      const failedState = yield* fs.readFileString(`${config.stateDir}/preview-hosting.json`);
      assert.include(failedState, '"status":"expired"');

      const restarted = testTerminalHarness();
      yield* Effect.scoped(
        Effect.gen(function* () {
          const hosting = yield* PreviewHosting.PreviewHosting;
          assert.isNull(
            yield* hosting.recover({
              threadId: "thread-1",
              leaseId: PreviewHostingLeaseId.make("missing-lease"),
              url: PREVIEW_URL,
            }),
          );
          assert.deepEqual(yield* hosting.list("thread-1"), []);
        }).pipe(Effect.provide(hostingLayer(config, restarted))),
      );
      assert.equal(restarted.opens.length, 0);
      assert.equal(restarted.writes.length, 0);
      assert.equal(restarted.closes.length, 1);
      assert.equal(
        yield* fs.readFileString(`${config.stateDir}/preview-hosting.json`),
        '{"version":1,"leases":[]}\n',
      );
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, TestClock.layer()))),
  );

  it.effect("does not treat an unattributed responding URL as preview readiness", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(10_000);
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "preview-hosting-unattributed-" });
      const config = yield* Effect.provide(
        ServerConfig.ServerConfig,
        ServerConfig.layerTest(process.cwd(), root),
      );
      const wrote = yield* Deferred.make<void>();
      const harness = testTerminalHarness({
        onWrite: () => Deferred.succeed(wrote, undefined).pipe(Effect.asVoid),
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const hosting = yield* PreviewHosting.PreviewHosting;
          const pending = yield* Effect.forkScoped(
            Effect.result(
              hosting.launch({
                threadId: "thread-1",
                command: "pnpm dev --port 5173",
                cwd: "/workspace",
                worktreePath: "/workspace",
                url: PREVIEW_URL,
              }),
            ),
          );
          yield* Deferred.await(wrote);
          yield* Effect.yieldNow;
          yield* TestClock.adjust(Duration.seconds(31));
          const result = yield* Fiber.join(pending);

          assert.equal(result._tag, "Failure");
          assert.deepEqual(yield* hosting.list("thread-1"), []);
          assert.equal(harness.opens.length, 1);
          assert.isAtLeast(harness.closes.length, 1);
        }).pipe(Effect.provide(hostingLayer(config, harness, true, [], false))),
      );
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, TestClock.layer()))),
  );

  it.effect("fails closed on malformed persisted lease data", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const persistedLease = (cwd: string, url: string, expiresAt: string) =>
        `{"version":1,"leases":[{"id":"lease-1","threadId":"thread-1","terminalId":"preview-lease-1","command":"node serve.js","cwd":"${cwd}","worktreePath":null,"url":"${url}","handedOffAt":"2026-09-01T00:00:00.000Z","expiresAt":"${expiresAt}","status":"active"}]}`;
      const corruptFiles = [
        " \n\t ",
        persistedLease("/workspace", PREVIEW_URL, "not-a-date"),
        persistedLease("/workspace", "http://example.test/preview", "2026-09-02T00:00:00.000Z"),
        persistedLease("relative/workspace", PREVIEW_URL, "2026-09-02T00:00:00.000Z"),
      ];

      for (const [index, contents] of corruptFiles.entries()) {
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: `preview-hosting-corrupt-state-${index}-`,
        });
        const config = yield* Effect.provide(
          ServerConfig.ServerConfig,
          ServerConfig.layerTest(process.cwd(), root),
        );
        yield* fs.makeDirectory(config.stateDir, { recursive: true });
        yield* fs.writeFileString(`${config.stateDir}/preview-hosting.json`, contents);
        const harness = testTerminalHarness();

        yield* Effect.scoped(
          Effect.gen(function* () {
            const hosting = yield* PreviewHosting.PreviewHosting;
            const result = yield* Effect.result(hosting.list("thread-1"));
            assert.equal(result._tag, "Failure");
            if (result._tag === "Failure") {
              assert.equal(result.failure._tag, "PreviewHostingError");
              if (result.failure._tag === "PreviewHostingError") {
                assert.equal(result.failure.operation, "decode");
              }
            }
            assert.deepEqual(harness.opens, []);
          }).pipe(Effect.provide(hostingLayer(config, harness))),
        );
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does not open a terminal when the first atomic state write fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "preview-hosting-persist-fail-" });
      const config = yield* Effect.provide(
        ServerConfig.ServerConfig,
        ServerConfig.layerTest(process.cwd(), root),
      );
      const harness = testTerminalHarness();
      const layer = hostingLayer(config, harness);

      yield* Effect.scoped(
        Effect.gen(function* () {
          const hosting = yield* PreviewHosting.PreviewHosting;
          yield* fs.remove(config.stateDir, { recursive: true, force: true });
          yield* fs.writeFileString(config.stateDir, "occupying the state directory path");
          const result = yield* Effect.result(
            hosting.launch({
              threadId: "thread-1",
              command: "pnpm dev --port 5173",
              cwd: "/workspace",
              url: PREVIEW_URL,
            }),
          );

          assert.equal(result._tag, "Failure");
          assert.deepEqual(harness.opens, []);
          assert.deepEqual(harness.writes, []);
          assert.deepEqual(harness.closes, []);
          assert.deepEqual(yield* hosting.list("thread-1"), []);
        }).pipe(Effect.provide(layer)),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses to launch on a URL already served by an unowned process", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "preview-hosting-occupied-" });
      const config = yield* Effect.provide(
        ServerConfig.ServerConfig,
        ServerConfig.layerTest(process.cwd(), root),
      );
      const harness = testTerminalHarness();
      const existingServer: DiscoveredLocalServer = {
        host: "localhost",
        port: 5173,
        url: PREVIEW_URL,
        processName: "node",
        pid: 555,
        terminal: null,
      };

      yield* Effect.scoped(
        Effect.gen(function* () {
          const hosting = yield* PreviewHosting.PreviewHosting;
          const result = yield* Effect.result(
            hosting.launch({
              threadId: "thread-1",
              command: "pnpm dev --port 5173",
              cwd: "/workspace",
              url: PREVIEW_URL,
            }),
          );
          assert.equal(result._tag, "Failure");
          assert.deepEqual(yield* hosting.list("thread-1"), []);
        }).pipe(Effect.provide(hostingLayer(config, harness, true, [existingServer]))),
      );

      assert.deepEqual(harness.opens, []);
      assert.deepEqual(harness.writes, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect("does not accept an unattributed HTTP response as managed readiness", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(10_000);
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "preview-hosting-unattributed-" });
      const config = yield* Effect.provide(
        ServerConfig.ServerConfig,
        ServerConfig.layerTest(process.cwd(), root),
      );
      const wrote = yield* Deferred.make<void>();
      const harness = testTerminalHarness({
        onWrite: () => Deferred.succeed(wrote, undefined).pipe(Effect.asVoid),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const hosting = yield* PreviewHosting.PreviewHosting;
          const pending = yield* Effect.forkScoped(
            Effect.result(
              hosting.launch({
                threadId: "thread-1",
                command: "pnpm dev --port 5173",
                cwd: "/workspace",
                url: PREVIEW_URL,
              }),
            ),
          );
          yield* Deferred.await(wrote);
          yield* Effect.yieldNow;
          yield* TestClock.adjust(Duration.seconds(31));
          const result = yield* Fiber.join(pending);
          assert.equal(result._tag, "Failure");
          if (result._tag === "Failure") {
            assert.include(result.failure.message, "HTTP responded, but ownership did not match");
            assert.include(result.failure.message, "Readiness deadline: 30000 ms");
            assert.include(result.failure.message, "Terminal: running; running subprocess: yes");
            assert.include(
              result.failure.message,
              "Terminal output is omitted because it may contain credentials.",
            );
          }
          assert.deepEqual(yield* hosting.list("thread-1"), []);
          assert.equal(harness.closes.length, 1);
        }).pipe(Effect.provide(hostingLayer(config, harness, true, [], false))),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.each([
    { exitCode: 1, exitSignal: null, detail: "exit code: 1" },
    { exitCode: null, exitSignal: 15, detail: "signal: 15" },
  ])("reports failed command metadata without reading startup output ($detail)", (exit) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "preview-hosting-exit-details-" });
      const config = yield* Effect.provide(
        ServerConfig.ServerConfig,
        ServerConfig.layerTest(process.cwd(), root),
      );
      const harness = testTerminalHarness({
        onRefreshMetadata: () =>
          Effect.sync(() => {
            const summary = harness.summaries[0];
            if (summary)
              harness.summaries[0] = {
                ...summary,
                status: "exited",
                hasRunningSubprocess: false,
                exitCode: exit.exitCode,
                exitSignal: exit.exitSignal,
              };
          }),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const hosting = yield* PreviewHosting.PreviewHosting;
          const result = yield* Effect.result(
            hosting.launch({
              threadId: "thread-1",
              command: "source .env; pnpm dev",
              cwd: "/workspace",
              url: "http://operator:url-secret@localhost:5173/private-route?token=query-secret#fragment-secret",
            }),
          );
          assert.equal(result._tag, "Failure");
          if (result._tag === "Failure") {
            assert.include(result.failure.message, "at http://localhost:5173.\n");
            assert.include(result.failure.message, "preview command is no longer running");
            assert.include(result.failure.message, "Terminal: exited; running subprocess: no");
            assert.include(result.failure.message, exit.detail);
            assert.include(
              result.failure.message,
              "Terminal output is omitted because it may contain credentials.",
            );
            assert.isAtMost(result.failure.message.length, 1_024);
            for (const privateText of [
              "source .env",
              "operator",
              "url-secret",
              "private-route",
              "query-secret",
              "fragment-secret",
            ]) {
              assert.notInclude(result.failure.message, privateText);
            }
          }
          assert.deepEqual(yield* hosting.list("thread-1"), []);
          assert.equal(harness.historyDeletes.length, 1);
        }).pipe(Effect.provide(hostingLayer(config, harness))),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
