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
  type TerminalOpenInput,
  type TerminalSummary,
} from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import * as PortScanner from "./PortScanner.ts";
import * as PreviewHosting from "./Hosting.ts";
import * as TerminalManager from "../terminal/Manager.ts";

const PREVIEW_URL = "http://localhost:5173/field-examples";
const encodePersistedHostingState = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      version: Schema.Literal(1),
      leases: Schema.Array(PreviewHosting.PreviewHostingLease),
    }),
  ),
);

interface TerminalHarness {
  readonly opens: TerminalOpenInput[];
  readonly writes: Array<{
    readonly threadId: string;
    readonly terminalId: string;
    readonly data: string;
  }>;
  readonly closes: Array<{ readonly threadId: string; readonly terminalId: string }>;
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
}

function terminalLayer(harness: TerminalHarness) {
  return Layer.mock(TerminalManager.TerminalManager)({
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
    refreshMetadata: (harness.onRefreshMetadata?.() ?? Effect.void).pipe(
      Effect.as(harness.summaries),
    ),
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
    summaries: [],
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

function failFirstExpiredStateWriteLayer(failedWrite: Deferred.Deferred<void>) {
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
              return target.writeFileString(filePath, data, options);
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
      const harness = testTerminalHarness({
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
          assert.isTrue(yield* hosting.ownsTerminal("thread-1", lease.terminalId));
          yield* TestClock.adjust(Duration.millis(PreviewHosting.PREVIEW_HOSTING_LEASE_MS));
          yield* Deferred.await(closed);
          assert.deepEqual(harness.closes, [
            { threadId: "thread-1", terminalId: lease.terminalId },
          ]);
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
        failFirstExpiredStateWriteLayer(failedWrite),
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

          // A failed due lease is retried later, without a zero-delay worker loop;
          // the second lease's nearer fixed deadline still wakes cleanup first.
          yield* TestClock.adjust(0);
          yield* Effect.yieldNow;
          assert.deepEqual(harness.closes, []);
          yield* TestClock.adjust(Duration.seconds(30));
          yield* Deferred.await(bothClosed);

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
          assert.equal((yield* Fiber.join(pending))._tag, "Failure");
          assert.deepEqual(yield* hosting.list("thread-1"), []);
          assert.equal(harness.closes.length, 1);
        }).pipe(Effect.provide(hostingLayer(config, harness, true, [], false))),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
