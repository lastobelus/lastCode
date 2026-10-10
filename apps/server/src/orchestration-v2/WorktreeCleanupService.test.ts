import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ThreadId,
  ProviderSessionId,
  type OrchestrationV2AppThread,
  type OrchestrationProjectShell,
  type GitCommandError,
  type OrchestrationV2Command,
  type VcsError,
  VcsUnsupportedOperationError,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { TestClock } from "effect/testing";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as EventStore from "../persistence/OrchestrationEventStore.ts";
import * as Terminal from "../terminal/Manager.ts";
import * as Vcs from "../vcs/VcsDriverRegistry.ts";
import * as LegacyImporter from "./legacy/LegacyV1ThreadImporter.ts";
import * as Projection from "./ProjectionStore.ts";
import * as Project from "./ProjectStore.ts";
import * as Sessions from "./ProviderSessionManager.ts";
import * as PreviewHosting from "../preview/Hosting.ts";
import * as Threads from "./ThreadManagementService.ts";
import * as Cleanup from "./WorktreeCleanupService.ts";
import { OrchestratorDispatchError, type OrchestratorV2Error } from "./Orchestrator.ts";

type CleanupUpdate = Extract<
  OrchestrationV2Command,
  { readonly type: "thread.worktree-cleanup.update" }
>;

const now = "2026-10-02T00:00:00.000Z";
const pending = (id: string, repositoryRoot = "/work/repo"): OrchestrationV2AppThread =>
  ({
    id: ThreadId.make(id),
    deletedAt: now,
    worktreePath: `/work/${id}`,
    worktreeCleanup: {
      status: "deleting",
      repositoryRoot,
      worktreePath: `/work/${id}`,
      startedAt: now,
    },
  }) as unknown as OrchestrationV2AppThread;

const makeHarness = Effect.fn(function* (
  initial: ReadonlyArray<OrchestrationV2AppThread>,
  remove?: (path: string) => Effect.Effect<void, GitCommandError>,
  beforeUpdate?: (command: CleanupUpdate) => Effect.Effect<void, OrchestratorV2Error>,
  resolve?: (cwd: string) => Effect.Effect<Vcs.VcsDriverHandle, VcsError>,
  removePreviews?: (
    threadId: ThreadId,
    append: (value: string) => Effect.Effect<void>,
  ) => Effect.Effect<void, PreviewHosting.PreviewHostingError | Terminal.TerminalError>,
  protectedPreviewPaths: ReadonlyArray<string> = [],
) {
  const state = yield* Ref.make(initial);
  const timeline = yield* Ref.make<ReadonlyArray<string>>([]);
  const projectRoots = yield* Ref.make<ReadonlyArray<OrchestrationProjectShell>>([]);
  const updates = yield* Ref.make<ReadonlyArray<CleanupUpdate>>([]);
  const append = (value: string) => Ref.update(timeline, (values) => [...values, value]);
  const getThread = (threadId: ThreadId) =>
    Ref.get(state).pipe(Effect.map((rows) => rows.find((row) => row.id === threadId)!));
  const layer = Cleanup.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(Projection.ProjectionStoreV2)({
          getThread,
          getWorktreeCleanupThreads: Ref.get(state).pipe(
            Effect.map((rows) => rows.filter((row) => row.worktreeCleanup != null)),
          ),
          getThreadRecords: ((threadId: ThreadId) =>
            getThread(threadId).pipe(
              Effect.map((thread) => ({
                thread,
                providerSessions: [{ id: ProviderSessionId.make(`session:${threadId}`) }],
              })),
            )) as Projection.ProjectionStoreV2Shape["getThreadRecords"],
          getShellSnapshot: () =>
            Effect.succeed({
              schemaVersion: 2,
              snapshotSequence: 0,
              threads: [],
              archivedThreads: [],
            }),
        }),
        Layer.mock(Project.ProjectStoreV2)({ listShells: () => Ref.get(projectRoots) }),
        Layer.mock(Threads.ThreadManagementService)({
          dispatch: (command) =>
            Effect.gen(function* () {
              if (command.type !== "thread.worktree-cleanup.update")
                return yield* Effect.die("Unexpected command.");
              const current = yield* getThread(command.threadId);
              assert.deepStrictEqual(current.worktreeCleanup, command.expectedCleanup);
              yield* Ref.update(updates, (commands) => [...commands, command]);
              if (beforeUpdate !== undefined) yield* beforeUpdate(command);
              yield* append(`persist:${command.threadId}:${command.cleanup?.status ?? "complete"}`);
              yield* Ref.update(state, (rows) =>
                rows.map((row) =>
                  row.id === command.threadId ? { ...row, worktreeCleanup: command.cleanup } : row,
                ),
              );
              return { sequence: 1, storedEvents: [] };
            }),
        }),
        Layer.mock(Sessions.ProviderSessionManagerV2)({
          teardownThread: ({ threadId }) => append(`detach:${threadId}`),
        }),
        Layer.mock(PreviewHosting.PreviewHosting)({
          launch: () => Effect.die("Unexpected preview launch"),
          recover: () => Effect.die("Unexpected preview recovery"),
          list: () => Effect.succeed([]),
          ownsTerminal: () => Effect.succeed(false),
          removeThread: (threadId) =>
            removePreviews === undefined
              ? Effect.void
              : removePreviews(ThreadId.make(threadId), append),
          protectedWorkspacePaths: () => Effect.succeed(protectedPreviewPaths),
        }),
        Layer.mock(Terminal.TerminalManager)({
          close: ({ threadId }) => append(`terminal:${threadId}`),
        }),
        Layer.mock(GitWorkflow.GitWorkflowService)({
          removeWorktree: ({ path, allowMissing, force }) =>
            Effect.gen(function* () {
              assert.equal(allowMissing, true);
              assert.equal(force, true);
              yield* append(`remove:${path}`);
              if (remove !== undefined) yield* remove(path);
            }),
        }),
        Layer.mock(EventStore.OrchestrationEventStore)({}),
        FileSystem.layerNoop({ realPath: (path) => Effect.succeed(path) }),
        Layer.mock(Vcs.VcsDriverRegistry)({
          resolve: ({ cwd }) =>
            resolve === undefined
              ? Effect.succeed({
                  kind: "git",
                  repository: { metadataPath: ".git" },
                } as unknown as Vcs.VcsDriverHandle)
              : resolve(cwd),
        }),
        Layer.mock(LegacyImporter.LegacyV1ThreadImporter)({
          reconcileShells: append("import").pipe(
            Effect.as({ importedThreadCount: 0, importedMessageCount: 0 }),
          ),
        }),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );
  return { state, timeline, projectRoots, updates, layer };
});

it.effect("retries completion persistence with the same command before advancing the queue", () =>
  Effect.gen(function* () {
    const failed = yield* Deferred.make<void>();
    let failOnce = true;
    const harness = yield* makeHarness(
      [pending("receipt-first"), pending("receipt-next")],
      undefined,
      (command) =>
        Effect.gen(function* () {
          if (command.threadId !== "receipt-first" || command.cleanup !== null || !failOnce) return;
          failOnce = false;
          yield* Deferred.succeed(failed, undefined);
          return yield* new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: "Transient persistence failure.",
          });
        }),
    );
    yield* Effect.gen(function* () {
      const service = yield* Cleanup.WorktreeCleanupService;
      yield* service.reconcile;
      yield* Deferred.await(failed);
      assert.isFalse((yield* Ref.get(harness.timeline)).includes("remove:/work/receipt-next"));
      yield* TestClock.adjust("1 second");
      yield* service.drain;
      const attempts = (yield* Ref.get(harness.updates)).filter(
        (command) => command.threadId === "receipt-first",
      );
      assert.equal(attempts.length, 2);
      assert.equal(attempts[0]!.commandId, attempts[1]!.commandId);
      const entries = yield* Ref.get(harness.timeline);
      assert.equal(entries.filter((entry) => entry === "remove:/work/receipt-first").length, 1);
      assert.isTrue(
        entries.indexOf("persist:receipt-first:complete") <
          entries.indexOf("remove:/work/receipt-next"),
      );
    }).pipe(Effect.provide(harness.layer));
  }).pipe(Effect.scoped),
);

it.effect("resumes tombstones and persists completion after provider teardown and removal", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness([pending("resume")]);
    yield* Effect.gen(function* () {
      const service = yield* Cleanup.WorktreeCleanupService;
      yield* service.reconcile;
      yield* service.drain;
      yield* service.reconcile;
      yield* service.drain;
      assert.deepStrictEqual(yield* Ref.get(harness.timeline), [
        "import",
        "detach:resume",
        "terminal:resume",
        "remove:/work/resume",
        "persist:resume:complete",
        "import",
      ]);
      assert.equal((yield* Ref.get(harness.state))[0]!.worktreeCleanup, null);
    }).pipe(Effect.provide(harness.layer));
  }).pipe(Effect.scoped),
);

it.effect("removes preview leases before closing terminals and deleting a worktree", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness(
      [pending("preview-order")],
      undefined,
      undefined,
      undefined,
      (threadId, append) => append(`preview:${threadId}`),
    );
    yield* Effect.gen(function* () {
      const service = yield* Cleanup.WorktreeCleanupService;
      yield* service.reconcile;
      yield* service.drain;
      assert.deepStrictEqual(yield* Ref.get(harness.timeline), [
        "import",
        "preview:preview-order",
        "detach:preview-order",
        "terminal:preview-order",
        "remove:/work/preview-order",
        "persist:preview-order:complete",
      ]);
    }).pipe(Effect.provide(harness.layer));
  }).pipe(Effect.scoped),
);

it.effect("does not close terminals or remove a worktree when preview cleanup fails", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness(
      [pending("preview-stop-failed")],
      undefined,
      undefined,
      undefined,
      (threadId, append) =>
        append(`preview:${threadId}`).pipe(
          Effect.andThen(
            Effect.fail(
              new PreviewHosting.PreviewHostingError({
                operation: "persist",
                statePath: "/state/preview-hosting.json",
                cause: new Error("preview terminal did not stop"),
              }),
            ),
          ),
        ),
    );
    yield* Effect.gen(function* () {
      const service = yield* Cleanup.WorktreeCleanupService;
      yield* service.reconcile;
      yield* service.drain;
      assert.deepStrictEqual(yield* Ref.get(harness.timeline), [
        "import",
        "preview:preview-stop-failed",
        "persist:preview-stop-failed:failed",
      ]);
      assert.equal((yield* Ref.get(harness.state))[0]!.worktreeCleanup?.status, "failed");
    }).pipe(Effect.provide(harness.layer));
  }).pipe(Effect.scoped),
);

it.effect("retains a worktree that still contains another thread's preview", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness(
      [pending("preview-shared-worktree")],
      undefined,
      undefined,
      undefined,
      undefined,
      ["/work/preview-shared-worktree/src"],
    );
    yield* Effect.gen(function* () {
      const service = yield* Cleanup.WorktreeCleanupService;
      yield* service.reconcile;
      yield* service.drain;
      const entries = yield* Ref.get(harness.timeline);
      assert.isTrue(entries.includes("detach:preview-shared-worktree"));
      assert.isTrue(entries.includes("terminal:preview-shared-worktree"));
      assert.isFalse(entries.includes("remove:/work/preview-shared-worktree"));
      assert.equal((yield* Ref.get(harness.state))[0]!.worktreeCleanup?.status, "failed");
    }).pipe(Effect.provide(harness.layer));
  }).pipe(Effect.scoped),
);

it.effect("persists removal failures and refuses a worktree that became a project root", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness([pending("protected")]);
    yield* Ref.set(harness.projectRoots, [
      { workspaceRoot: "/work/protected" } as OrchestrationProjectShell,
    ]);
    yield* Effect.gen(function* () {
      const service = yield* Cleanup.WorktreeCleanupService;
      yield* service.reconcile;
      yield* service.drain;
      const cleanup = (yield* Ref.get(harness.state))[0]!.worktreeCleanup;
      assert.equal(cleanup?.status, "failed");
      assert.isFalse(
        (yield* Ref.get(harness.timeline)).some((entry) => entry.startsWith("remove:")),
      );
      yield* service.reconcile;
      yield* service.drain;
      assert.equal(
        (yield* Ref.get(harness.timeline)).filter((entry) => entry.startsWith("detach:")).length,
        1,
      );
    }).pipe(Effect.provide(harness.layer));
  }).pipe(Effect.scoped),
);

it.effect("serializes one repository while another repository continues independently", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const otherDone = yield* Deferred.make<void>();
    const harness = yield* makeHarness(
      [pending("first"), pending("second"), pending("other", "/work/other-repo")],
      (path) =>
        path === "/work/first"
          ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
          : path === "/work/other"
            ? Deferred.succeed(otherDone, undefined).pipe(Effect.asVoid)
            : Effect.void,
    );
    yield* Effect.gen(function* () {
      const service = yield* Cleanup.WorktreeCleanupService;
      yield* service.reconcile;
      yield* Deferred.await(entered);
      yield* Deferred.await(otherDone);
      assert.isFalse((yield* Ref.get(harness.timeline)).includes("remove:/work/second"));
      const drain = yield* service.drain.pipe(Effect.forkChild);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(drain);
      const entries = yield* Ref.get(harness.timeline);
      assert.isTrue(
        entries.indexOf("persist:first:complete") < entries.indexOf("remove:/work/second"),
      );
    }).pipe(Effect.provide(harness.layer));
  }).pipe(Effect.scoped),
);

it.effect("fails repository discovery without creating an alias removal queue", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const second = pending("alias-second", "/work/repo-alias");
    let failResolve = true;
    const harness = yield* makeHarness(
      [pending("alias-first"), second],
      (path) =>
        path === "/work/alias-first"
          ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
          : Effect.void,
      undefined,
      (cwd) =>
        cwd === "/work/repo-alias" && failResolve
          ? Effect.fail(
              new VcsUnsupportedOperationError({
                operation: "resolve",
                kind: "git",
                detail: "Temporary repository discovery failure.",
              }),
            )
          : Effect.succeed({
              kind: "git",
              repository: { metadataPath: "/work/common/.git" },
            } as unknown as Vcs.VcsDriverHandle),
    );
    yield* Effect.gen(function* () {
      const service = yield* Cleanup.WorktreeCleanupService;
      yield* service.reconcile;
      yield* Deferred.await(entered);
      assert.equal((yield* Ref.get(harness.state))[1]!.worktreeCleanup?.status, "failed");
      assert.isFalse((yield* Ref.get(harness.timeline)).includes("remove:/work/alias-second"));
      yield* Deferred.succeed(release, undefined);
      yield* service.drain;
      failResolve = false;
      yield* Ref.update(harness.state, (rows) =>
        rows.map((row) => (row.id === second.id ? second : row)),
      );
      yield* service.reconcile;
      yield* service.drain;
      const entries = yield* Ref.get(harness.timeline);
      assert.isTrue(
        entries.indexOf("persist:alias-first:complete") <
          entries.indexOf("remove:/work/alias-second"),
      );
    }).pipe(Effect.provide(harness.layer));
  }).pipe(Effect.scoped),
);
