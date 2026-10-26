// @effect-diagnostics nodeBuiltinImport:off -- Owned real-Git fixtures exercise the service and its durable native store together.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  OrchestrationV2ThreadShell,
  ProjectId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type WorktreeSuspensionTransitionInput,
  type ServerSettings as SettingsValue,
} from "@t3tools/contracts";
import { createWorktreeSuspensionStore } from "@t3tools/shared/worktreeSuspension";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import { ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as CommandReceipts from "../orchestration-v2/CommandReceiptStore.ts";
import * as ProviderSessions from "../orchestration-v2/ProviderSessionManager.ts";
import * as Cleanup from "../orchestration-v2/WorktreeCleanupService.ts";
import * as PreviewHosting from "../preview/Hosting.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as Acquisition from "./WorkspaceAcquisition.ts";
import * as Lifecycle from "./WorkspaceLifecycle.ts";
import * as Suspension from "./WorktreeSuspension.ts";
import * as Registry from "./WorktreeSuspensionRegistry.ts";
import * as Consumers from "./WorktreeConsumers.ts";
import * as Mounts from "./DependencyMounts.ts";
import { withWorkspaceLease, resolveWorkspaceLeaseRoot } from "./workspaceLease.ts";

const execute = NodeUtil.promisify(NodeChildProcess.execFile);
const git = async (cwd: string, ...args: readonly string[]) =>
  (await execute("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd })).stdout.trim();
const at = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
const firstId = ThreadId.make("fixture:first");
const secondId = ThreadId.make("fixture:second");
const projectId = ProjectId.make("fixture:project");
const decodeShell = Schema.decodeUnknownSync(OrchestrationV2ThreadShell);
const shell = (id: ThreadId, worktreePath: string) =>
  decodeShell({
    id,
    projectId,
    title: "Workspace owner",
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "fixture" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath,
    branch: "topic",
    activeProviderThreadId: null,
    lineage: { rootThreadId: id, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    workspaceUserAdopted: true,
    activeRunId: null,
    latestVisibleMessage: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    latestRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestUserMessageAt: null,
    latestUserAuthoredMessageAt: null,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    settledOverride: null,
    settledAt: at,
    deletedAt: null,
  });
const fixture = async () => {
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "workspace-controller-")),
  );
  const repository = NodePath.join(root, "repository");
  const workspace = NodePath.join(root, "worktrees", "repository", "topic");
  await NodeFSP.mkdir(repository);
  await NodeFSP.mkdir(NodePath.dirname(workspace), { recursive: true });
  await git(repository, "init", "--initial-branch=main");
  await git(repository, "config", "user.email", "fixture@example.invalid");
  await git(repository, "config", "user.name", "Fixture");
  await NodeFSP.writeFile(NodePath.join(repository, "tracked"), "base\n");
  await NodeFSP.writeFile(NodePath.join(repository, ".gitignore"), "notes/\n");
  await git(repository, "add", ".");
  await git(repository, "commit", "-m", "fixture");
  await git(repository, "worktree", "add", "-b", "topic", workspace, "HEAD");
  await NodeFSP.writeFile(NodePath.join(workspace, "tracked"), "staged\n");
  await git(workspace, "add", "tracked");
  await NodeFSP.writeFile(NodePath.join(workspace, "tracked"), "working\n");
  await NodeFSP.mkdir(NodePath.join(workspace, "notes"));
  await NodeFSP.writeFile(NodePath.join(workspace, "notes", "private"), "ignored note\n");
  return {
    root,
    repository,
    workspace,
    async [Symbol.asyncDispose]() {
      await NodeFSP.rm(root, { recursive: true, force: true });
    },
  };
};
type Fixture = Awaited<ReturnType<typeof fixture>>;
const harness = (
  fixture: Fixture,
  options: {
    failAfterPublication?: "suspended" | "active";
    cleanupThreads?: boolean;
    settings?: SettingsValue;
    adoptOnCaptured?: boolean;
    pauseCaptured?: { entered: Deferred.Deferred<void>; release: Deferred.Deferred<void> };
    pauseRestored?: { entered: Deferred.Deferred<void>; release: Deferred.Deferred<void> };
    unreadableCatalog?: boolean;
    failDiscardPrepareAt?: number;
    occupyRestoreOnBarrier?: boolean;
    occupyRecoveryOnBarrier?: boolean;
    deleteRecoveryAfterPublication?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const original = yield* Registry.WorktreeSuspensionRegistry;
    const acquisition = yield* Acquisition.WorkspaceAcquisition;
    const lifecycle = yield* Lifecycle.WorkspaceLifecycle;
    const updates = yield* Queue.unbounded<Registry.CheckoutAuthority>();
    const commandReceipts = new Map<CommandId, CommandReceipts.CommandReceiptV2>();
    const threads = new Map<ThreadId, OrchestrationV2ThreadShell>([
      [firstId, shell(firstId, fixture.workspace)],
      [secondId, shell(secondId, fixture.workspace)],
    ]);
    const current = () => [...threads.values()].filter((thread) => thread.deletedAt === null);
    const project: ProjectStore.ProjectRow = {
      projectId,
      title: "Fixture",
      workspaceRoot: fixture.repository,
      defaultModelSelection: null,
      defaultThreadEnvMode: null,
      autoPull: false,
      faviconPath: null,
      projectIcon: null,
      scripts: [],
      createdAt: DateTime.formatIso(at),
      updatedAt: DateTime.formatIso(at),
      deletedAt: null,
    };
    let failedPublication = false;
    let pausedCapture = false;
    let discardPreparations = 0;
    let occupiedRestore = false;
    let pausedRestore = false;
    const transition = (input: WorktreeSuspensionTransitionInput) =>
      Effect.sync(() => {
        const owners = current().filter(
          (thread) => thread.worktreePath !== null && input.aliases.includes(thread.worktreePath),
        );
        expect(owners.map((owner) => owner.id).sort()).toEqual(
          input.expectedOwners.map((owner) => owner.threadId).sort(),
        );
        for (const owner of owners) {
          expect(owner.worktreeSuspension ?? null).toEqual(input.expected);
          threads.set(owner.id, {
            ...owner,
            worktreeSuspension: input.next,
            ...(input.workspace === undefined
              ? {}
              : { worktreePath: input.workspace.worktreePath, branch: input.workspace.branch }),
          });
        }
        if (
          options.deleteRecoveryAfterPublication &&
          owners.some((owner) => owner.id !== firstId && owner.id !== secondId)
        ) {
          for (const owner of owners)
            threads.set(owner.id, { ...threads.get(owner.id)!, deletedAt: at });
          throw new Error("fixture deleted recovery after publication");
        }
        if (!failedPublication && options.failAfterPublication === input.next.state) {
          failedPublication = true;
          throw new Error("fixture stopped after projection publication");
        }
        return { sequence: 1, storedEvents: [] };
      });
    const dispatch = (command: OrchestrationV2ServerCommand) =>
      Effect.sync(() => {
        if (command.type !== "thread.create")
          throw new Error(`Unexpected fixture command ${command.type}`);
        threads.set(command.threadId, {
          ...shell(command.threadId, command.worktreePath!),
          projectId: command.projectId,
          branch: command.branch,
          title: command.title,
          modelSelection: command.modelSelection,
        });
        return { sequence: 1, storedEvents: [] };
      });
    const gitRequests: string[] = [];
    const registry: Registry.WorktreeSuspensionRegistry["Service"] = {
      ...original,
      put: (next, expected) =>
        original.put(next, expected).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              if (
                options.adoptOnCaptured &&
                next.operation?.kind === "capture" &&
                next.history.length > 0
              )
                threads.set(firstId, { ...threads.get(firstId)!, workspaceUserAdopted: true });
            }),
          ),
          Effect.tap(() => {
            if (
              options.pauseRestored !== undefined &&
              !pausedRestore &&
              next.operation?.kind === "restore" &&
              next.pendingProjection?.next.state === "active"
            ) {
              pausedRestore = true;
              return Deferred.succeed(options.pauseRestored.entered, undefined).pipe(
                Effect.andThen(Deferred.await(options.pauseRestored.release)),
              );
            }
            if (
              ((options.occupyRestoreOnBarrier && next.operation?.kind === "restore") ||
                (options.occupyRecoveryOnBarrier && next.operation?.kind === "recovery")) &&
              !occupiedRestore &&
              next.operation !== undefined
            ) {
              occupiedRestore = true;
              return Effect.promise(async () => {
                await NodeFSP.mkdir(next.operation!.destinationPath!, { recursive: true });
                await NodeFSP.writeFile(
                  NodePath.join(next.operation!.destinationPath!, "unrelated-note"),
                  "unrelated checkout\n",
                );
              });
            }
            if (
              next.operation?.kind === "discard" &&
              next.operation.lifecycle !== undefined &&
              ++discardPreparations === options.failDiscardPrepareAt
            )
              return Effect.die(new Error("fixture preparation interrupted after durable intent"));
            if (
              options.pauseCaptured === undefined ||
              pausedCapture ||
              next.operation?.kind !== "capture" ||
              next.history.length === 0
            )
              return Effect.void;
            pausedCapture = true;
            return Deferred.succeed(options.pauseCaptured.entered, undefined).pipe(
              Effect.andThen(Deferred.await(options.pauseCaptured.release)),
            );
          }),
          Effect.andThen(Queue.offer(updates, next)),
          Effect.asVoid,
        ),
    };
    if (options.unreadableCatalog) {
      yield* original.list;
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(original.root, "authority.json"), "{"),
      );
    }
    const service = yield* Suspension.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(Registry.WorktreeSuspensionRegistry, registry),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThreadShell: (id) =>
              Effect.sync(() => {
                const thread = threads.get(id);
                return thread?.deletedAt === null ? thread : null;
              }),
            getThread: (id) =>
              Effect.suspend(() => {
                const thread = threads.get(id);
                return thread === undefined
                  ? Effect.fail(
                      new ProjectionStore.ProjectionStoreThreadNotFoundError({ threadId: id }),
                    )
                  : Effect.succeed(
                      thread as unknown as ReturnType<
                        typeof ProjectionStore.emptyProjection
                      >["thread"],
                    );
              }),
            getThreadWorktreePaths: () =>
              Effect.sync(() =>
                current()
                  .filter((thread) => thread.worktreePath !== null)
                  .map((thread) => ({ threadId: thread.id, worktreePath: thread.worktreePath! })),
              ),
            getOwnedThreadIds: (id) => Effect.succeed([id]),
            getArchiveFamilyThreadIds: (id) => Effect.succeed([id]),
            getShellSnapshot: () =>
              Effect.sync(() => ({
                schemaVersion: 2 as const,
                snapshotSequence: 0,
                threads: current(),
                archivedThreads: [],
              })),
            getWorktreeCleanupThreads: Effect.sync(() =>
              options.cleanupThreads
                ? (current() as unknown as readonly ReturnType<
                    typeof ProjectionStore.emptyProjection
                  >["thread"][])
                : [],
            ),
          }),
          Layer.mock(ProjectStore.ProjectStoreV2)({
            get: (id) => Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
            list: () => Effect.succeed([project]),
          }),
          Layer.mock(Orchestrator.OrchestratorV2)({
            transitionWorktreeSuspension: transition,
            dispatch,
          }),
          Layer.mock(CommandReceipts.CommandReceiptStoreV2)({
            getByCommandId: (id) =>
              Effect.sync(() => Option.fromUndefinedOr(commandReceipts.get(id))),
            getProjectByCommandId: () => Effect.succeedNone,
          }),
          Layer.mock(ProviderSessions.ProviderSessionManagerV2)({
            workspaceOwnership: Effect.succeed([]),
          }),
          Layer.mock(Cleanup.WorktreeCleanupService)({
            historicalWorktreeOwners: Effect.succeed([]),
          }),
          Layer.mock(TerminalManager.TerminalManager)({ refreshMetadata: Effect.succeed([]) }),
          Layer.mock(PreviewHosting.PreviewHosting)({
            protectedWorkspacePaths: () => Effect.succeed([]),
          }),
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed(options.settings ?? DEFAULT_SERVER_SETTINGS),
          }),
          Layer.mock(GitVcsDriver.GitVcsDriver)({
            execute: (input) =>
              Effect.promise(async () => {
                gitRequests.push(input.operation);
                return {
                  stdout: await git(input.cwd, ...input.args),
                  stderr: "",
                  stdoutTruncated: false,
                  stderrTruncated: false,
                  exitCode: ChildProcessSpawner.ExitCode(0),
                };
              }),
          }),
        ),
      ),
      Effect.provideService(Consumers.ProcessPaths, Effect.succeed([])),
      Effect.provideService(Mounts.MountPoints, Effect.succeed([])),
    );
    const awaitRecord = (predicate: (record: Registry.CheckoutAuthority) => boolean) =>
      Stream.fromQueue(updates).pipe(
        Stream.filter((record) => predicate(record) || record.blockedReason !== null),
        Stream.take(1),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
        Effect.tap((record) => Effect.sync(() => expect(record.blockedReason).toBeNull())),
      );
    const suspend = Effect.gen(function* () {
      const preview = yield* service.previewSuspend({ threadId: firstId });
      const operation = yield* service.suspend({ threadId: firstId, previewToken: preview.token });
      const barrier = (yield* original.list).find(
        (entry) => entry.checkoutId === operation.checkoutId,
      )!;
      expect(barrier.operation?.id).toBe(operation.operationId);
      const saved = yield* awaitRecord(
        (record) =>
          record.checkoutId === operation.checkoutId &&
          record.summary.state === "suspended" &&
          record.operation === undefined &&
          record.pendingProjection === undefined,
      );
      return saved;
    });
    return {
      service,
      acquisition,
      lifecycle,
      threads,
      commandReceipts,
      registry,
      awaitRecord,
      updates,
      gitRequests,
      suspend,
      store: createWorktreeSuspensionStore({
        storeRoot: NodePath.join(original.root, "snapshots"),
      }),
    };
  });
const provide = <A, E, R>(test: Effect.Effect<A, E, R>, fixture: Fixture) =>
  test.pipe(
    Effect.provide(
      Layer.mergeAll(Registry.layer, Acquisition.layer, Lifecycle.layer).pipe(
        Layer.provideMerge(ServerConfig.layerTest(fixture.repository, fixture.root)),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
    Effect.provideService(Consumers.ProcessPaths, Effect.succeed([])),
    Effect.provideService(Mounts.MountPoints, Effect.succeed([])),
    Effect.scoped,
  );

const realGit = <A, E, R>(test: (fixture: Fixture) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(fixture),
    (fixture) => provide(test(fixture), fixture),
    (fixture) => Effect.promise(() => fixture[Symbol.asyncDispose]()),
  );

it.live("keeps a workspace with an actionable dashboard request until it is resolved", () =>
  realGit((f) =>
    Effect.gen(function* () {
      const h = yield* harness(f);
      const owner = h.threads.get(firstId)!;
      const request = {
        id: "review-request",
        title: "Review the result",
        body: "Review is still needed.",
        kind: "review" as const,
        status: "open" as const,
        priority: "normal" as const,
        effort: "quick" as const,
        requiresComputer: false,
        createdAt: DateTime.formatIso(at),
        updatedAt: DateTime.formatIso(at),
      };
      h.threads.set(firstId, { ...owner, dashboardItems: [request] });
      expect(
        (yield* h.service.previewSuspend({ threadId: firstId }).pipe(Effect.flip)).reason,
      ).toBe("protected");
      expect(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(f.workspace, "tracked"), "utf8"),
        ),
      ).toBe("working\n");
      h.threads.set(firstId, {
        ...owner,
        dashboardItems: [{ ...request, status: "resolved" }],
      });
      expect((yield* h.service.previewSuspend({ threadId: firstId })).token).toBeTruthy();
    }),
  ),
);

it.live(
  "saves two real owners, survives GC, and restores the exact index and ignored notes before acquisition",
  () =>
    realGit((f) =>
      Effect.gen(function* () {
        const h = yield* harness(f);
        const saved = yield* h.suspend;
        yield* Effect.promise(async () => {
          await expect(NodeFSP.lstat(f.workspace)).rejects.toMatchObject({ code: "ENOENT" });
          await git(f.repository, "branch", "-D", "topic");
          await git(f.repository, "reflog", "expire", "--expire=now", "--all");
          await git(f.repository, "gc", "--prune=now");
        });
        const restored = yield* h.acquisition.acquire({
          path: NodePath.join(f.workspace, "notes"),
          threadId: firstId,
          purpose: "file-write",
        });
        expect(restored.restored).toBe(true);
        expect(restored.path).toBe(NodePath.join(f.workspace, "notes"));
        yield* Effect.promise(async () => {
          expect(await git(f.workspace, "show", ":tracked")).toBe("staged");
          expect(await NodeFSP.readFile(NodePath.join(f.workspace, "tracked"), "utf8")).toBe(
            "working\n",
          );
          expect(
            await NodeFSP.readFile(NodePath.join(f.workspace, "notes", "private"), "utf8"),
          ).toBe("ignored note\n");
        });
        expect(h.threads.get(firstId)?.worktreeSuspension).toEqual(
          h.threads.get(secondId)?.worktreeSuspension,
        );
        expect(h.threads.get(firstId)?.worktreeSuspension?.snapshotId).toBeNull();
        expect(
          (yield* Effect.promise(() => h.store.readJournal(saved.summary.snapshotId!))).phase,
        ).toBe("active");
      }),
    ),
);

it.live(
  "recovers an unstarted restore collision at an alternate path and retires the original live alias",
  () =>
    realGit((f) =>
      Effect.gen(function* () {
        const h = yield* harness(f, { occupyRestoreOnBarrier: true });
        const saved = yield* h.suspend;
        const id = saved.summary.snapshotId!;
        yield* h.service.restore({ checkoutId: saved.checkoutId, snapshotId: id });
        const stopped = yield* Stream.fromQueue(h.updates).pipe(
          Stream.filter((record) => record.blockedReason !== null),
          Stream.take(1),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
        expect(stopped.summary.state).toBe("suspended");
        expect(stopped.operation).toBeUndefined();
        expect((yield* Effect.promise(() => h.store.readJournal(id))).phase).toBe("suspended");
        const alternate = NodePath.join(NodePath.dirname(f.workspace), "alternate");
        yield* h.service.restore({
          checkoutId: saved.checkoutId,
          snapshotId: id,
          destinationPath: alternate,
        });
        const active = yield* h.awaitRecord(
          (record) =>
            record.summary.state === "active" &&
            record.operation === undefined &&
            record.pendingProjection === undefined,
        );
        expect(active.path).toBe(alternate);
        expect(active.aliases).toEqual([alternate]);
        const retiredTransition = saved.aliases.find((alias) => alias !== f.workspace)!;
        expect(yield* h.acquisition.acquire({ path: retiredTransition, purpose: "git" })).toEqual({
          path: retiredTransition,
          branch: null,
          restored: false,
        });
        yield* Effect.promise(() => git(f.workspace, "init", "--initial-branch=unrelated"));
        const unrelatedId = ThreadId.make("fixture:unrelated");
        h.threads.set(unrelatedId, {
          ...shell(unrelatedId, f.workspace),
          branch: "unrelated",
          projectId: ProjectId.make("fixture:unrelated-project"),
        });
        const rebound = (yield* h.registry.list)[0]!;
        yield* h.registry.put({ ...rebound, aliases: [...rebound.aliases, f.workspace] }, rebound);
        expect(
          yield* h.acquisition.acquire({
            path: f.workspace,
            threadId: unrelatedId,
            purpose: "file-write",
          }),
        ).toEqual({ path: f.workspace, branch: null, restored: false });
        expect((yield* h.registry.list)[0]!.aliases).not.toContain(f.workspace);
        expect(
          (yield* h.acquisition.acquire({ path: alternate, threadId: firstId, purpose: "git" }))
            .path,
        ).toBe(alternate);
        expect(yield* resolveWorkspaceLeaseRoot(f.workspace)).toBe(f.workspace);
        expect(yield* resolveWorkspaceLeaseRoot(alternate)).toBe(alternate);
        yield* Effect.promise(async () => {
          expect(await NodeFSP.readFile(NodePath.join(f.workspace, "unrelated-note"), "utf8")).toBe(
            "unrelated checkout\n",
          );
          expect(await NodeFSP.readFile(NodePath.join(alternate, "notes", "private"), "utf8")).toBe(
            "ignored note\n",
          );
          expect(await git(alternate, "show", ":tracked")).toBe("staged");
        });
      }),
    ),
);

it.live(
  "retargets a historical recovery collision without mistaking prior restored metadata for a new stage",
  () =>
    realGit((f) =>
      Effect.gen(function* () {
        const h = yield* harness(f, { occupyRecoveryOnBarrier: true });
        const saved = yield* h.suspend;
        const snapshotId = saved.summary.snapshotId!;
        yield* h.acquisition.acquire({ path: f.workspace, purpose: "file-write" });
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(f.workspace, "current-note"), "keep active copy\n"),
        );
        const journalBefore = yield* Effect.promise(() => h.store.readJournal(snapshotId));
        expect(journalBefore.phase).toBe("active");
        expect(journalBefore.destinationPath).toBe(f.workspace);
        const occupied = NodePath.join(NodePath.dirname(f.workspace), "history-occupied");
        yield* Effect.promise(() => NodeFSP.mkdir(occupied));
        expect(
          (yield* h.service
            .restore({ checkoutId: saved.checkoutId, snapshotId, destinationPath: occupied })
            .pipe(Effect.flip)).reason,
        ).toBe("protected");
        expect((yield* h.registry.list)[0]!.operation).toBeUndefined();
        const late = NodePath.join(NodePath.dirname(f.workspace), "history-late-collision");
        yield* h.service.restore({
          checkoutId: saved.checkoutId,
          snapshotId,
          destinationPath: late,
        });
        const stopped = yield* Stream.fromQueue(h.updates).pipe(
          Stream.filter((record) => record.blockedReason !== null),
          Stream.take(1),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
        expect(stopped.summary.state).toBe("active");
        expect(stopped.operation).toBeUndefined();
        expect(yield* Effect.promise(() => h.store.readJournal(snapshotId))).toEqual(journalBefore);
        const alternate = NodePath.join(NodePath.dirname(f.workspace), "history-alternate");
        yield* h.service.restore({
          checkoutId: saved.checkoutId,
          snapshotId,
          destinationPath: alternate,
        });
        yield* h.awaitRecord(
          (record) =>
            record.sourceCheckoutId === saved.checkoutId &&
            record.operation === undefined &&
            record.pendingProjection === undefined,
        );
        yield* h.awaitRecord(
          (record) =>
            record.checkoutId === saved.checkoutId &&
            record.operation === undefined &&
            record.pendingProjection === undefined,
        );
        yield* Effect.promise(async () => {
          expect(await NodeFSP.readFile(NodePath.join(late, "unrelated-note"), "utf8")).toBe(
            "unrelated checkout\n",
          );
          expect(await NodeFSP.readFile(NodePath.join(f.workspace, "current-note"), "utf8")).toBe(
            "keep active copy\n",
          );
          expect(await NodeFSP.readFile(NodePath.join(alternate, "notes", "private"), "utf8")).toBe(
            "ignored note\n",
          );
          expect(await git(alternate, "show", ":tracked")).toBe("staged");
        });
      }),
    ),
);

const awaitRecovered = (
  updates: Queue.Queue<Registry.CheckoutAuthority>,
  predicate: (record: Registry.CheckoutAuthority) => boolean,
) =>
  Stream.fromQueue(updates).pipe(
    Stream.filter((record) => predicate(record) && record.blockedReason === null),
    Stream.take(1),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

it.live(
  "deleting one owner with no disposition releases an unstarted save barrier without waiting on itself",
  () =>
    realGit((f) =>
      Effect.gen(function* () {
        const h = yield* harness(f);
        const preview = yield* h.service.previewSuspend({ threadId: firstId });
        yield* withWorkspaceLease(
          f.workspace,
          Effect.gen(function* () {
            yield* h.service.suspend({ threadId: firstId, previewToken: preview.token });
            yield* h.lifecycle.run(
              {
                operation: "delete",
                target: { kind: "threads", threadIds: [firstId] },
                commandId: CommandId.make("delete:queued-save"),
              },
              Effect.sync(() =>
                h.threads.set(firstId, { ...h.threads.get(firstId)!, deletedAt: at }),
              ),
            );
            expect(h.threads.get(firstId)!.deletedAt).toBe(at);
          }),
        );
        const kept = yield* awaitRecovered(
          h.updates,
          (record) =>
            record.summary.state === "active" &&
            record.summary.generation === 1 &&
            record.operation === undefined &&
            record.pendingProjection === undefined &&
            record.owners.length === 1,
        );
        expect(kept.owners[0]!.threadId).toBe(secondId);
        expect(kept.history).toEqual([]);
        expect(
          (yield* h.acquisition.acquire({
            path: f.workspace,
            threadId: secondId,
            purpose: "file-write",
          })).restored,
        ).toBe(false);
        yield* Effect.promise(async () =>
          expect(
            await NodeFSP.readFile(NodePath.join(f.workspace, "notes", "private"), "utf8"),
          ).toBe("ignored note\n"),
        );
      }),
    ),
);

it.live.each(["retain", "discard"] as const)(
  "deletion during capture with %s keeps recoverable data and reconciles deleted owners",
  (mode) =>
    realGit((f) =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const h = yield* harness(f, { pauseCaptured: { entered, release } });
        const preview = yield* h.service.previewSuspend({ threadId: firstId });
        yield* h.service.suspend({ threadId: firstId, previewToken: preview.token });
        yield* Deferred.await(entered);
        const target = {
          kind: "threads" as const,
          threadIds: mode === "retain" ? [firstId] : [firstId, secondId],
        };
        const confirmation =
          mode === "discard"
            ? yield* h.lifecycle.preview({ operation: "delete", target })
            : undefined;
        if (confirmation !== undefined) {
          expect(confirmation.snapshots).toEqual([]);
          expect(confirmation.retainedSnapshots).toHaveLength(1);
        }
        yield* h.lifecycle.run(
          {
            operation: "delete",
            target,
            commandId: CommandId.make(`delete:capturing:${mode}`),
            savedWorkspace:
              confirmation === undefined
                ? { mode: "retain" }
                : { mode: "discard", previewToken: confirmation.token },
          },
          Effect.sync(() => {
            for (const id of target.threadIds)
              h.threads.set(id, { ...h.threads.get(id)!, deletedAt: at });
          }),
        );
        expect(yield* Deferred.isDone(release)).toBe(false);
        yield* Deferred.succeed(release, undefined);
        const kept = yield* awaitRecovered(
          h.updates,
          (record) =>
            record.checkoutId === preview.checkoutId &&
            record.summary.state === "active" &&
            record.operation === undefined &&
            record.pendingProjection === undefined &&
            record.owners.length === (mode === "retain" ? 1 : 0),
        );
        expect(kept.history).toHaveLength(1);
        expect(kept.aliases).toEqual([f.workspace]);
        expect(kept.snapshots![0]!.owners.map((owner) => owner.threadId).sort()).toEqual(
          [firstId, secondId].sort(),
        );
        const id = kept.history[0]!;
        expect((yield* Effect.promise(() => h.store.readJournal(id))).phase).toBe("active");
        yield* Effect.promise(async () => {
          expect(
            await NodeFSP.readFile(NodePath.join(f.workspace, "notes", "private"), "utf8"),
          ).toBe("ignored note\n");
          expect(await git(f.workspace, "show", ":tracked")).toBe("staged");
          expect(
            await git(f.repository, "for-each-ref", `refs/lastcode/suspension/${id}/`),
          ).not.toBe("");
        });
      }),
    ),
);

it.live(
  "finishes restoration after all owners are deleted and explicitly releases the orphan hold before disposal",
  () =>
    realGit((f) =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const h = yield* harness(f, { pauseRestored: { entered, release } });
        const saved = yield* h.suspend;
        const id = saved.summary.snapshotId!;
        expect(
          (yield* h.service
            .setKeepWorkspace({ checkoutId: saved.checkoutId, keep: false }, { allowOrphans: true })
            .pipe(Effect.flip)).reason,
        ).toBe("protected");
        yield* h.service.restore({ checkoutId: saved.checkoutId, snapshotId: id });
        yield* Deferred.await(entered);
        const target = { kind: "threads" as const, threadIds: [firstId, secondId] };
        yield* h.lifecycle.run(
          {
            operation: "delete",
            target,
            commandId: CommandId.make("delete:restoring"),
            savedWorkspace: { mode: "retain" },
          },
          Effect.sync(() => {
            for (const id of target.threadIds)
              h.threads.set(id, { ...h.threads.get(id)!, deletedAt: at });
          }),
        );
        yield* Deferred.succeed(release, undefined);
        const held = yield* awaitRecovered(
          h.updates,
          (record) =>
            record.checkoutId === saved.checkoutId &&
            record.summary.state === "active" &&
            record.operation === undefined &&
            record.pendingProjection === undefined &&
            record.owners.length === 0,
        );
        expect(held.summary.keepWorkspace).toBe(true);
        expect((yield* Effect.promise(() => h.store.readJournal(id))).phase).toBe("active");
        expect(
          (yield* h.service
            .setKeepWorkspace({ checkoutId: saved.checkoutId, keep: false })
            .pipe(Effect.flip)).reason,
        ).toBe("protected");
        expect((yield* h.registry.list)[0]!.summary.keepWorkspace).toBe(true);
        expect(
          (yield* h.service
            .previewDiscard({ checkoutId: saved.checkoutId, snapshotIds: [id] })
            .pipe(Effect.flip)).reason,
        ).toBe("protected");
        yield* h.service.setKeepWorkspace(
          { checkoutId: saved.checkoutId, keep: false },
          { allowOrphans: true },
        );
        expect((yield* h.registry.list)[0]!.history).toEqual(held.history);
        const discard = yield* h.service.previewDiscard({
          checkoutId: saved.checkoutId,
          snapshotIds: [id],
        });
        yield* h.service.discard({ previewToken: discard.token });
        yield* awaitRecovered(
          h.updates,
          (record) =>
            record.checkoutId === saved.checkoutId &&
            record.operation === undefined &&
            record.history.length === 0,
        );
        expect((yield* Effect.promise(() => h.store.readJournal(id))).phase).toBe("discarded");
        yield* Effect.promise(async () => {
          expect(
            await NodeFSP.readFile(NodePath.join(f.workspace, "notes", "private"), "utf8"),
          ).toBe("ignored note\n");
          expect(await git(f.repository, "for-each-ref", `refs/lastcode/suspension/${id}/`)).toBe(
            "",
          );
        });
      }),
    ),
);

it.live(
  "reconciles deletion of one shared owner after projection publication was interrupted",
  () =>
    realGit((f) =>
      Effect.gen(function* () {
        const h = yield* harness(f, { failAfterPublication: "suspended" });
        const preview = yield* h.service.previewSuspend({ threadId: firstId });
        yield* h.service.suspend({ threadId: firstId, previewToken: preview.token });
        yield* Stream.fromQueue(h.updates).pipe(
          Stream.filter((record) => record.blockedReason !== null),
          Stream.take(1),
          Stream.runHead,
        );
        yield* h.lifecycle.run(
          {
            operation: "delete",
            target: { kind: "threads", threadIds: [firstId] },
            commandId: CommandId.make("delete:pending-publication"),
          },
          Effect.sync(() => h.threads.set(firstId, { ...h.threads.get(firstId)!, deletedAt: at })),
        );
        const retained = yield* awaitRecovered(
          h.updates,
          (record) =>
            record.checkoutId === preview.checkoutId &&
            record.summary.state === "suspended" &&
            record.operation === undefined &&
            record.pendingProjection === undefined &&
            record.owners.length === 1,
        );
        expect(retained.owners[0]!.threadId).toBe(secondId);
        expect(retained.snapshots![0]!.owners).toHaveLength(2);
        expect(
          (yield* h.acquisition.acquire({
            path: f.workspace,
            threadId: secondId,
            purpose: "file-write",
          })).restored,
        ).toBe(true);
        yield* Effect.promise(async () =>
          expect(
            await NodeFSP.readFile(NodePath.join(f.workspace, "notes", "private"), "utf8"),
          ).toBe("ignored note\n"),
        );
      }),
    ),
);

it.live("cancels every exact deletion intent if preparation fails before dispatch begins", () =>
  realGit((f) =>
    Effect.gen(function* () {
      const h = yield* harness(f, { failDiscardPrepareAt: 2 });
      const first = yield* h.suspend;
      const otherPath = NodePath.join(NodePath.dirname(f.workspace), "other-delete");
      const otherId = ThreadId.make("fixture:other-delete");
      yield* Effect.promise(() =>
        git(f.repository, "worktree", "add", "-b", "other-delete", otherPath, "HEAD"),
      );
      h.threads.set(otherId, { ...shell(otherId, otherPath), branch: "other-delete" });
      const previewOther = yield* h.service.previewSuspend({ threadId: otherId });
      yield* h.service.suspend({ threadId: otherId, previewToken: previewOther.token });
      const other = yield* h.awaitRecord(
        (record) =>
          record.checkoutId === previewOther.checkoutId &&
          record.summary.state === "suspended" &&
          record.operation === undefined &&
          record.pendingProjection === undefined,
      );
      const target = { kind: "threads" as const, threadIds: [firstId, secondId, otherId] };
      const preview = yield* h.lifecycle.preview({ operation: "delete", target });
      expect(preview.snapshots).toHaveLength(2);
      let dispatched = false;
      const outcome = yield* h.lifecycle
        .run(
          {
            operation: "delete",
            target,
            commandId: CommandId.make("delete:prepare-failed"),
            savedWorkspace: { mode: "discard", previewToken: preview.token },
          },
          Effect.sync(() => {
            dispatched = true;
          }),
        )
        .pipe(Effect.exit);
      expect(outcome._tag).toBe("Failure");
      expect(dispatched).toBe(false);
      for (const saved of [first, other]) {
        const fresh = (yield* h.registry.list).find(
          (record) => record.checkoutId === saved.checkoutId,
        )!;
        expect(fresh.operation).toBeUndefined();
        expect(fresh.summary.snapshotId).toBe(saved.summary.snapshotId);
        expect(
          (yield* Effect.promise(() => h.store.readJournal(saved.summary.snapshotId!))).phase,
        ).toBe("suspended");
      }
      expect((yield* h.lifecycle.preview({ operation: "delete", target })).snapshots).toHaveLength(
        2,
      );
      yield* h.acquisition.acquire({ path: f.workspace, purpose: "file-write" });
      yield* h.acquisition.acquire({ path: otherPath, purpose: "file-write" });
      yield* Effect.promise(async () =>
        expect(await NodeFSP.readFile(NodePath.join(f.workspace, "notes", "private"), "utf8")).toBe(
          "ignored note\n",
        ),
      );
    }),
  ),
);

it.live(
  "retains an interrupted owned trial until it can resume safely, then permits disposal",
  () =>
    realGit((f) =>
      Effect.gen(function* () {
        const h = yield* harness(f);
        yield* h.service.previewSuspend({ threadId: firstId });
        const original = (yield* h.registry.list)[0]!;
        const id = "interrupted-trial";
        const summary = {
          ...original.summary,
          generation: 1,
          state: "capturing" as const,
          snapshotId: id,
        };
        const capturing: Registry.CheckoutAuthority = {
          ...original,
          summary,
          owners: original.owners.map((owner) => ({ ...owner, generation: 1 })),
          operation: {
            id,
            kind: "capture",
            snapshotIds: [id],
            manual: true,
            acceptedAt: DateTime.formatIso(at),
          },
        };
        for (const [ownerId, thread] of h.threads)
          h.threads.set(ownerId, { ...thread, worktreeSuspension: summary });
        yield* h.registry.put(capturing, original);
        let verifications = 0;
        const interrupted = createWorktreeSuspensionStore({
          storeRoot: NodePath.join(h.registry.root, "snapshots"),
          onBoundary: async (phase) => {
            if (phase === "verifying" && ++verifications === 3)
              throw new Error("fixture trial interrupted");
          },
        });
        const trial = yield* Effect.promise(async () => {
          await interrupted.capture({
            sourcePath: f.workspace,
            snapshotId: id,
            operationId: id,
            ownerBinding: original.checkoutId,
          });
          await expect(interrupted.trialRestore(id)).rejects.toThrow("fixture trial interrupted");
          const trial = (await interrupted.readJournal(id)).trialPath!;
          await NodeFSP.writeFile(NodePath.join(trial, "unknown-note"), "keep trial addition\n");
          return trial;
        });
        yield* h.service.sweep;
        expect((yield* h.registry.list)[0]!.operation?.kind).toBe("capture");
        yield* Stream.fromQueue(h.updates).pipe(
          Stream.filter((record) => record.blockedReason !== null),
          Stream.take(1),
          Stream.runHead,
        );
        yield* Effect.promise(async () => {
          expect(await NodeFSP.readFile(NodePath.join(trial, "unknown-note"), "utf8")).toBe(
            "keep trial addition\n",
          );
          expect(
            await NodeFSP.readFile(NodePath.join(f.workspace, "notes", "private"), "utf8"),
          ).toBe("ignored note\n");
          await NodeFSP.unlink(NodePath.join(trial, "unknown-note"));
        });
        yield* h.service.sweep;
        const active = (yield* h.registry.list)[0]!;
        expect(active.operation).toBeUndefined();
        expect(active.summary.state).toBe("active");
        expect((yield* Effect.promise(() => h.store.readJournal(id))).trialPath).toBeUndefined();
        yield* Stream.fromQueue(h.updates).pipe(
          Stream.filter(
            (record) =>
              record.summary.state === "active" &&
              record.operation === undefined &&
              record.pendingProjection === undefined &&
              record.blockedReason === null,
          ),
          Stream.take(1),
          Stream.runHead,
        );
        const discard = yield* h.service.previewDiscard({
          checkoutId: original.checkoutId,
          snapshotIds: [id],
        });
        yield* h.service.discard({ previewToken: discard.token });
        yield* h.awaitRecord(
          (record) =>
            record.operation === undefined &&
            record.history.length === 0 &&
            record.summary.generation === summary.generation,
        );
        expect((yield* Effect.promise(() => h.store.readJournal(id))).phase).toBe("discarded");
        yield* Effect.promise(async () =>
          expect(
            await NodeFSP.readFile(NodePath.join(f.workspace, "notes", "private"), "utf8"),
          ).toBe("ignored note\n"),
        );
      }),
    ),
);

it.live("confirmed deletion discards the absent current copy without restoring it", () =>
  realGit((f) =>
    Effect.gen(function* () {
      const h = yield* harness(f);
      const saved = yield* h.suspend;
      const id = saved.summary.snapshotId!;
      const target = { kind: "threads" as const, threadIds: [firstId, secondId] };
      const preview = yield* h.lifecycle.preview({ operation: "delete", target });
      expect(preview.snapshots.map((entry) => entry.snapshotId)).toEqual([id]);
      yield* h.lifecycle.run(
        {
          operation: "delete",
          target,
          commandId: CommandId.make("delete:fixture"),
          savedWorkspace: { mode: "discard", previewToken: preview.token },
        },
        Effect.sync(() => {
          for (const ownerId of target.threadIds)
            h.threads.set(ownerId, { ...h.threads.get(ownerId)!, deletedAt: at });
        }),
      );
      const discarded = (yield* h.registry.list).find(
        (entry) => entry.checkoutId === saved.checkoutId,
      )!;
      expect(discarded.summary.state).toBe("discarded");
      expect(discarded.summary.snapshotId).toBeNull();
      expect(discarded.history).toEqual([]);
      expect((yield* Effect.promise(() => h.store.readJournal(id))).phase).toBe("discarded");
      yield* Effect.promise(async () => {
        await expect(NodeFSP.lstat(f.workspace)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await git(f.repository, "for-each-ref", `refs/lastcode/suspension/${id}/`)).toBe("");
      });
    }),
  ),
);

it.live(
  "a lifecycle selection retains copies shared with an outside owner and omission retains recovery data",
  () =>
    realGit((f) =>
      Effect.gen(function* () {
        const h = yield* harness(f);
        const saved = yield* h.suspend;
        const id = saved.summary.snapshotId!;
        const target = { kind: "threads" as const, threadIds: [firstId] };
        const preview = yield* h.lifecycle.preview({ operation: "archive", target });
        expect(preview.snapshots).toEqual([]);
        expect(preview.retainedSnapshots.map((entry) => entry.snapshotId)).toEqual([id]);
        yield* h.lifecycle.run(
          { operation: "archive", target, commandId: CommandId.make("archive:retain") },
          Effect.sync(() => h.threads.set(firstId, { ...h.threads.get(firstId)!, archivedAt: at })),
        );
        expect((yield* Effect.promise(() => h.store.readJournal(id))).phase).toBe("suspended");
        expect((yield* h.registry.list)[0]!.summary.snapshotId).toBe(id);
        yield* Effect.promise(
          async () =>
            await expect(NodeFSP.lstat(f.workspace)).rejects.toMatchObject({ code: "ENOENT" }),
        );
      }),
    ),
);

it.live(
  "creates a fresh branch checkout only after explicit disposal, without recovering old notes",
  () =>
    realGit((f) =>
      Effect.gen(function* () {
        const h = yield* harness(f);
        const saved = yield* h.suspend;
        const id = saved.summary.snapshotId!;
        const preview = yield* h.service.previewDiscard({
          checkoutId: saved.checkoutId,
          snapshotIds: [id],
        });
        yield* h.service.discard({ previewToken: preview.token });
        yield* h.awaitRecord(
          (record) =>
            record.summary.state === "discarded" &&
            record.operation === undefined &&
            record.pendingProjection === undefined,
        );
        expect(
          (yield* h.acquisition.acquire({ path: f.workspace, purpose: "git" }).pipe(Effect.flip))
            .reason,
        ).toBe("discarded");
        yield* h.service.createFresh({ threadId: firstId });
        yield* h.awaitRecord(
          (record) =>
            record.summary.state === "active" &&
            record.operation === undefined &&
            record.pendingProjection === undefined,
        );
        yield* Effect.promise(async () => {
          expect(await NodeFSP.readFile(NodePath.join(f.workspace, "tracked"), "utf8")).toBe(
            "base\n",
          );
          await expect(NodeFSP.lstat(NodePath.join(f.workspace, "notes"))).rejects.toMatchObject({
            code: "ENOENT",
          });
          expect(await git(f.workspace, "status", "--porcelain")).toBe("");
        });
        expect(h.threads.get(firstId)?.branch).toMatch(/^suspension\/fresh-/u);
        expect(h.threads.get(firstId)?.worktreeSuspension?.keepWorkspace).toBe(true);
      }),
    ),
);

it.live(
  "restores a historical copy into a separate thread and leaves the active source untouched",
  () =>
    realGit((f) =>
      Effect.gen(function* () {
        const h = yield* harness(f);
        const saved = yield* h.suspend;
        const id = saved.summary.snapshotId!;
        yield* h.acquisition.acquire({
          path: f.workspace,
          purpose: "file-write",
          threadId: firstId,
        });
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(f.workspace, "new-note"), "keep current changes\n"),
        );
        const destination = NodePath.join(NodePath.dirname(f.workspace), "historical");
        yield* h.service.restore({
          checkoutId: saved.checkoutId,
          snapshotId: id,
          projectId,
          destinationPath: destination,
        });
        const recovered = yield* h.awaitRecord(
          (record) =>
            record.sourceCheckoutId === saved.checkoutId &&
            record.operation === undefined &&
            record.pendingProjection === undefined,
        );
        yield* h.awaitRecord(
          (record) =>
            record.checkoutId === saved.checkoutId &&
            record.operation === undefined &&
            record.pendingProjection === undefined,
        );
        expect(recovered.owners).toHaveLength(1);
        expect(recovered.summary.keepWorkspace).toBe(true);
        expect(h.threads.get(firstId)?.worktreePath).toBe(f.workspace);
        yield* Effect.promise(async () => {
          expect(await NodeFSP.readFile(NodePath.join(f.workspace, "new-note"), "utf8")).toBe(
            "keep current changes\n",
          );
          expect(await NodeFSP.readFile(NodePath.join(destination, "tracked"), "utf8")).toBe(
            "working\n",
          );
          expect(await git(destination, "show", ":tracked")).toBe("staged");
          await expect(NodeFSP.lstat(NodePath.join(destination, "new-note"))).rejects.toMatchObject(
            { code: "ENOENT" },
          );
        });
      }),
    ),
);

it.live("recovers a retained orphan only through a separate mapped checkout", () =>
  realGit((f) =>
    Effect.gen(function* () {
      const h = yield* harness(f);
      const saved = yield* h.suspend;
      const id = saved.summary.snapshotId!;
      const target = { kind: "threads" as const, threadIds: [firstId, secondId] };
      yield* h.lifecycle.run(
        { operation: "delete", target, commandId: CommandId.make("delete:retain") },
        Effect.sync(() => {
          for (const ownerId of target.threadIds)
            h.threads.set(ownerId, { ...h.threads.get(ownerId)!, deletedAt: at });
        }),
      );
      expect(
        (yield* h.acquisition.acquire({ path: f.workspace, purpose: "git" }).pipe(Effect.flip))
          .reason,
      ).toBe("owner-changed");
      const destination = NodePath.join(NodePath.dirname(f.workspace), "orphan-recovery");
      expect((yield* h.service.list({})).entries).toEqual([]);
      const orphanTarget = { kind: "project" as const, projectId };
      const hidden = yield* h.lifecycle.preview({ operation: "delete", target: orphanTarget });
      expect(hidden.snapshots).toEqual([]);
      expect(hidden.retainedSnapshots).toEqual([]);
      expect(
        (yield* h.lifecycle.preview(
          { operation: "delete", target: orphanTarget },
          { allowOrphans: true },
        )).snapshots.map((entry) => entry.snapshotId),
      ).toEqual([id]);
      expect(
        (yield* h.service.list({}, { allowOrphans: true })).entries.map(
          (entry) => entry.snapshotId,
        ),
      ).toEqual([id]);
      const before = yield* h.registry.list;
      expect(
        (yield* h.service
          .restore({
            checkoutId: saved.checkoutId,
            snapshotId: id,
            projectId,
            destinationPath: destination,
          })
          .pipe(Effect.flip)).reason,
      ).toBe("protected");
      expect(yield* h.registry.list).toEqual(before);
      expect((yield* Effect.promise(() => h.store.readJournal(id))).phase).toBe("suspended");
      yield* h.service.restore(
        {
          checkoutId: saved.checkoutId,
          snapshotId: id,
          projectId,
          destinationPath: destination,
        },
        { allowOrphans: true },
      );
      const recovered = yield* h.awaitRecord(
        (record) =>
          record.sourceCheckoutId === saved.checkoutId &&
          record.operation === undefined &&
          record.pendingProjection === undefined,
      );
      expect(recovered.owners).toHaveLength(1);
      yield* Effect.promise(async () => {
        await expect(NodeFSP.lstat(f.workspace)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await NodeFSP.readFile(NodePath.join(destination, "notes", "private"), "utf8")).toBe(
          "ignored note\n",
        );
      });
    }),
  ),
);

it.live(
  "reconciles a crash after saved state reached owners but before the private publication committed",
  () =>
    realGit((f) =>
      Effect.gen(function* () {
        const h = yield* harness(f, { failAfterPublication: "suspended" });
        const preview = yield* h.service.previewSuspend({ threadId: firstId });
        yield* h.service.suspend({ threadId: firstId, previewToken: preview.token });
        const stopped = yield* Stream.fromQueue(h.updates).pipe(
          Stream.filter((record) => record.blockedReason !== null),
          Stream.take(1),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
        expect(stopped.pendingProjection?.next.state).toBe("suspended");
        expect(h.threads.get(firstId)?.worktreeSuspension?.state).toBe("suspended");
        yield* h.service.sweep;
        const recovered = (yield* h.registry.list).find(
          (record) => record.checkoutId === stopped.checkoutId,
        )!;
        expect(recovered.pendingProjection).toBeUndefined();
        expect(recovered.operation).toBeUndefined();
        expect(recovered.blockedReason).toBeNull();
        expect(recovered.summary.snapshotId).toBe(stopped.summary.snapshotId);
        yield* Effect.promise(
          async () =>
            await expect(NodeFSP.lstat(f.workspace)).rejects.toMatchObject({ code: "ENOENT" }),
        );
        yield* h.acquisition.acquire({ path: f.workspace, purpose: "file-write" });
        yield* Effect.promise(async () =>
          expect(await NodeFSP.readFile(NodePath.join(f.workspace, "tracked"), "utf8")).toBe(
            "working\n",
          ),
        );
      }),
    ),
);

it.live(
  "finishes a restored checkout after a crash between owner publication and journal finalization",
  () =>
    realGit((f) =>
      Effect.gen(function* () {
        const h = yield* harness(f, { failAfterPublication: "active" });
        const saved = yield* h.suspend;
        const id = saved.summary.snapshotId!;
        yield* h.acquisition
          .acquire({ path: f.workspace, purpose: "file-write" })
          .pipe(Effect.exit);
        expect((yield* Effect.promise(() => h.store.readJournal(id))).phase).toBe("restored");
        yield* h.service.sweep;
        const active = (yield* h.registry.list).find(
          (record) => record.checkoutId === saved.checkoutId,
        )!;
        expect(active.summary.state).toBe("active");
        expect(active.operation).toBeUndefined();
        expect(active.pendingProjection).toBeUndefined();
        expect(active.summary.snapshotId).toBeNull();
        expect((yield* Effect.promise(() => h.store.readJournal(id))).phase).toBe("active");
        yield* Effect.promise(async () => {
          expect(await NodeFSP.readFile(NodePath.join(f.workspace, "tracked"), "utf8")).toBe(
            "working\n",
          );
          expect(await git(f.workspace, "show", ":tracked")).toBe("staged");
        });
      }),
    ),
);

it.live(
  "lets an already leased consumer cancel a queued save before its worker enters the same root",
  () =>
    realGit((f) =>
      Effect.gen(function* () {
        const h = yield* harness(f);
        const preview = yield* h.service.previewSuspend({ threadId: firstId });
        yield* withWorkspaceLease(
          f.workspace,
          Effect.gen(function* () {
            yield* h.service.suspend({ threadId: firstId, previewToken: preview.token });
            const acquired = yield* h.acquisition.acquire({
              path: f.workspace,
              purpose: "file-write",
              threadId: firstId,
            });
            expect(acquired.restored).toBe(false);
            const record = (yield* h.registry.list)[0]!;
            expect(record.summary.state).toBe("active");
            expect(record.summary.snapshotId).toBeNull();
            expect(record.operation).toBeUndefined();
            yield* Effect.promise(async () =>
              expect(
                await NodeFSP.readFile(NodePath.join(f.workspace, "notes", "private"), "utf8"),
              ).toBe("ignored note\n"),
            );
          }),
        );
      }),
    ),
);

it.live(
  "performs no checkout identification or catalog writes when automatic suspension defaults Off",
  () =>
    realGit((f) =>
      Effect.gen(function* () {
        const h = yield* harness(f, { cleanupThreads: true });
        yield* h.service.sweep;
        expect(h.gitRequests).toEqual([]);
        expect(yield* h.registry.list).toEqual([]);
      }),
    ),
);

const automaticSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  worktreeSuspension: {
    mode: "custom" as const,
    afterDays: 1,
    scopes: { subagents: false, untouchedChildren: true, otherThreads: false },
  },
};
const untouchedOwners = (threads: Map<ThreadId, OrchestrationV2ThreadShell>) => {
  for (const [id, thread] of threads)
    threads.set(id, {
      ...thread,
      createdBy: "agent",
      creationSource: "mcp",
      creatorThreadId: id === firstId ? secondId : firstId,
      workspaceUserAdopted: false,
    });
};

it.live(
  "retains promoted and unknown legacy children instead of treating no authored messages as untouched",
  () =>
    realGit((f) =>
      Effect.gen(function* () {
        const h = yield* harness(f, { cleanupThreads: true, settings: automaticSettings });
        untouchedOwners(h.threads);
        yield* h.service.previewSuspend({ threadId: firstId });
        const record = (yield* h.registry.list)[0]!;
        yield* h.registry.put({ ...record, lastWorkspaceUseAt: DateTime.formatIso(at) }, record);
        h.threads.set(firstId, {
          ...h.threads.get(firstId)!,
          subagentPromotion: {
            requestId: CommandId.make("promotion"),
            targetThreadId: secondId,
            status: "promoted",
            error: null,
            requestedAt: at,
            updatedAt: at,
            createdBy: "user",
            creationSource: "web",
          },
        });
        yield* h.service.sweep;
        expect((yield* h.registry.list)[0]!.operation).toBeUndefined();
        const legacy = { ...h.threads.get(firstId)! };
        delete legacy.workspaceUserAdopted;
        delete legacy.subagentPromotion;
        h.threads.set(firstId, legacy);
        yield* h.service.sweep;
        expect((yield* h.registry.list)[0]!.summary.state).toBe("active");
        expect((yield* h.registry.list)[0]!.operation).toBeUndefined();
      }),
    ),
);

it.live(
  "a human adoption recorded during preservation vetoes automatic removal without a generation change",
  () =>
    realGit((f) =>
      Effect.gen(function* () {
        const h = yield* harness(f, {
          cleanupThreads: true,
          settings: automaticSettings,
          adoptOnCaptured: true,
        });
        untouchedOwners(h.threads);
        yield* h.service.previewSuspend({ threadId: firstId });
        const initial = (yield* h.registry.list)[0]!;
        yield* h.registry.put({ ...initial, lastWorkspaceUseAt: DateTime.formatIso(at) }, initial);
        yield* h.service.sweep;
        const stopped = yield* Stream.fromQueue(h.updates).pipe(
          Stream.filter((record) => record.blockedReason !== null),
          Stream.take(1),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
        expect(stopped.blockedReason).toContain("participation changed");
        yield* h.service.sweep;
        const retained = (yield* h.registry.list)[0]!;
        expect(retained.summary.state).toBe("active");
        expect(retained.operation).toBeUndefined();
        yield* Effect.promise(async () =>
          expect(
            await NodeFSP.readFile(NodePath.join(f.workspace, "notes", "private"), "utf8"),
          ).toBe("ignored note\n"),
        );
      }),
    ),
);

it.live("acquires an unrelated checkout while another checkout is being preserved", () =>
  realGit((f) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const h = yield* harness(f, { pauseCaptured: { entered, release } });
      const otherPath = NodePath.join(NodePath.dirname(f.workspace), "other");
      yield* Effect.promise(() =>
        git(f.repository, "worktree", "add", "-b", "other", otherPath, "HEAD"),
      );
      const otherId = ThreadId.make("fixture:other");
      h.threads.set(otherId, { ...shell(otherId, otherPath), branch: "other" });
      yield* h.service.previewSuspend({ threadId: otherId });
      const preview = yield* h.service.previewSuspend({ threadId: firstId });
      yield* h.service.suspend({ threadId: firstId, previewToken: preview.token });
      yield* Deferred.await(entered);
      const acquired = yield* h.acquisition.acquire({
        path: otherPath,
        purpose: "file-write",
        threadId: otherId,
      });
      expect(acquired).toEqual({ path: otherPath, branch: "other", restored: false });
      expect(yield* Deferred.isDone(release)).toBe(false);
      yield* Deferred.succeed(release, undefined);
      yield* h.awaitRecord(
        (entry) =>
          entry.checkoutId === preview.checkoutId &&
          entry.summary.state === "suspended" &&
          entry.operation === undefined,
      );
    }),
  ),
);

it.live("recreates an active branch at its latest commit without restoring historical notes", () =>
  realGit((f) =>
    Effect.gen(function* () {
      const h = yield* harness(f);
      const saved = yield* h.suspend;
      yield* h.acquisition.acquire({ path: f.workspace, purpose: "file-write" });
      const head = yield* Effect.promise(async () => {
        await NodeFSP.writeFile(NodePath.join(f.workspace, "tracked"), "commit B\n");
        await git(f.workspace, "add", "tracked");
        await git(f.workspace, "commit", "-m", "later commit");
        const head = await git(f.workspace, "rev-parse", "HEAD");
        await git(f.repository, "worktree", "remove", "--force", f.workspace);
        return head;
      });
      expect(yield* h.acquisition.acquire({ path: f.workspace, purpose: "git" })).toEqual({
        path: f.workspace,
        branch: "topic",
        restored: false,
      });
      yield* Effect.promise(() => git(f.repository, "worktree", "add", f.workspace, "topic"));
      expect(
        (yield* h.acquisition.acquire({ path: f.workspace, purpose: "file-write" })).restored,
      ).toBe(false);
      const active = (yield* h.registry.list)[0]!;
      expect(active.lastHead).toBe(head);
      expect(active.history).toEqual(saved.history);
      expect(active.summary.snapshotId).toBeNull();
      yield* Effect.promise(async () => {
        expect(await git(f.workspace, "rev-parse", "HEAD")).toBe(head);
        expect(await NodeFSP.readFile(NodePath.join(f.workspace, "tracked"), "utf8")).toBe(
          "commit B\n",
        );
        await expect(NodeFSP.lstat(NodePath.join(f.workspace, "notes"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      });
    }),
  ),
);

it.live(
  "reconciles accepted active branch changes and releases history after an owner moves away",
  () =>
    realGit((f) =>
      Effect.gen(function* () {
        const h = yield* harness(f);
        h.threads.set(secondId, { ...h.threads.get(secondId)!, deletedAt: at });
        const saved = yield* h.suspend;
        yield* h.acquisition.acquire({ path: f.workspace, purpose: "file-write" });
        yield* Effect.promise(() => git(f.workspace, "switch", "-c", "renamed"));
        h.threads.set(firstId, { ...h.threads.get(firstId)!, branch: "renamed" });
        expect(
          (yield* h.acquisition.acquire({ path: f.workspace, purpose: "git-mutation" })).branch,
        ).toBe("renamed");
        expect((yield* h.registry.list)[0]!.owners[0]!.branch).toBe("renamed");
        expect((yield* h.registry.list)[0]!.snapshots![0]!.owners[0]!.branch).toBe("topic");
        const moved = NodePath.join(NodePath.dirname(f.workspace), "moved");
        yield* Effect.promise(() => git(f.repository, "worktree", "move", f.workspace, moved));
        h.threads.set(firstId, { ...h.threads.get(firstId)!, worktreePath: moved });
        expect(
          yield* h.acquisition.acquire({ path: moved, purpose: "git", threadId: firstId }),
        ).toEqual({
          path: moved,
          branch: "renamed",
          restored: false,
        });
        expect((yield* h.registry.list)[0]!.path).toBe(moved);
        expect(yield* h.acquisition.acquire({ path: f.workspace, purpose: "git" })).toEqual({
          path: f.workspace,
          branch: null,
          restored: false,
        });
        const independent = NodePath.join(NodePath.dirname(f.workspace), "independent");
        yield* Effect.promise(() => git(f.repository, "worktree", "move", moved, independent));
        const owner = { ...h.threads.get(firstId)!, worktreePath: independent };
        delete owner.worktreeSuspension;
        h.threads.set(firstId, owner);
        yield* h.service.sweep;
        const old = (yield* h.registry.list).find(
          (entry) => entry.checkoutId === saved.checkoutId,
        )!;
        expect(old.detached).toBe(true);
        expect(old.owners).toEqual([]);
        const preview = yield* h.service.previewSuspend({ threadId: firstId });
        expect(preview.checkoutId).not.toBe(saved.checkoutId);
        expect(
          (yield* h.registry.list).find((entry) => entry.checkoutId === saved.checkoutId)!.history,
        ).toEqual(saved.history);
        yield* Effect.promise(async () =>
          expect(
            await NodeFSP.readFile(NodePath.join(independent, "notes", "private"), "utf8"),
          ).toBe("ignored note\n"),
        );
      }),
    ),
);

const deletionReceipt = (
  commandId: CommandId,
  threadId: ThreadId,
  status: "accepted" | "rejected",
): CommandReceipts.CommandReceiptV2 => ({
  commandId,
  threadId,
  commandType: "thread.delete",
  acceptedAt: at,
  resultSequence: 1,
  status,
  error: status === "rejected" ? "fixture rejected" : null,
});

it.live.each(["accepted", "rejected"] as const)(
  "bulk deletion %s preserves one shared snapshot until the complete selection commits",
  (outcome) =>
    realGit((f) =>
      Effect.gen(function* () {
        const h = yield* harness(f);
        const saved = yield* h.suspend;
        const id = saved.summary.snapshotId!;
        const target = { kind: "threads" as const, threadIds: [firstId, secondId] };
        const commandId = CommandId.make("bulk:delete");
        const deleteReceipts = target.threadIds.map((threadId) => ({
          threadId,
          commandId: CommandId.make(`${commandId}:delete:${threadId}`),
        }));
        const preview = yield* h.lifecycle.preview({ operation: "delete", target });
        expect(preview.snapshots.map((entry) => entry.snapshotId)).toEqual([id]);
        const result = yield* h.lifecycle
          .run(
            {
              operation: "delete",
              target,
              commandId,
              deleteReceipts,
              savedWorkspace: { mode: "discard", previewToken: preview.token },
            },
            Effect.gen(function* () {
              h.threads.set(firstId, { ...h.threads.get(firstId)!, deletedAt: at });
              for (const binding of deleteReceipts)
                h.commandReceipts.set(
                  binding.commandId,
                  deletionReceipt(
                    binding.commandId,
                    binding.threadId,
                    binding.threadId === firstId ? "accepted" : outcome,
                  ),
                );
              if (outcome === "rejected") return yield* Effect.fail("fixture second delete failed");
              h.threads.set(secondId, { ...h.threads.get(secondId)!, deletedAt: at });
              return "deleted";
            }),
          )
          .pipe(Effect.exit);
        const after = (yield* h.registry.list)[0]!;
        expect(after.operation).toBeUndefined();
        expect(result._tag).toBe(outcome === "accepted" ? "Success" : "Failure");
        expect((yield* Effect.promise(() => h.store.readJournal(id))).phase).toBe(
          outcome === "accepted" ? "discarded" : "suspended",
        );
        yield* Effect.promise(
          async () =>
            await expect(NodeFSP.lstat(f.workspace)).rejects.toMatchObject({ code: "ENOENT" }),
        );
        if (outcome === "accepted") {
          expect(after.summary.state).toBe("discarded");
          expect(after.summary.snapshotId).toBeNull();
          expect(after.history).toEqual([]);
          expect(
            yield* Effect.promise(() =>
              git(f.repository, "for-each-ref", `refs/lastcode/suspension/${id}/`),
            ),
          ).toBe("");
        } else {
          expect(after.summary.snapshotId).toBe(id);
          yield* h.acquisition.acquire({
            path: f.workspace,
            purpose: "file-write",
            threadId: secondId,
          });
          yield* Effect.promise(async () =>
            expect(
              await NodeFSP.readFile(NodePath.join(f.workspace, "notes", "private"), "utf8"),
            ).toBe("ignored note\n"),
          );
        }
      }),
    ),
);

it.live(
  "a restore retry completes its interrupted current restoration without creating another checkout",
  () =>
    realGit((f) =>
      Effect.gen(function* () {
        const h = yield* harness(f, { failAfterPublication: "active" });
        const saved = yield* h.suspend;
        const snapshotId = saved.summary.snapshotId!;
        yield* h.acquisition
          .acquire({ path: f.workspace, purpose: "file-write" })
          .pipe(Effect.exit);
        const operation = (yield* h.registry.list)[0]!.operation!;
        const retried = yield* h.service.restore({ checkoutId: saved.checkoutId, snapshotId });
        expect(retried.state).toBe("complete");
        expect(retried.operationId).toBe(operation.id);
        expect(yield* h.registry.list).toHaveLength(1);
        expect(h.threads.size).toBe(2);
        expect((yield* h.registry.list)[0]!.operation).toBeUndefined();
        expect((yield* Effect.promise(() => h.store.readJournal(snapshotId))).phase).toBe("active");
      }),
    ),
);

it.live("read-only discovery does not fabricate a workspace-use clock", () =>
  realGit((f) =>
    Effect.gen(function* () {
      const h = yield* harness(f);
      yield* h.service.previewSuspend({ threadId: firstId });
      expect((yield* h.registry.list)[0]!.lastWorkspaceUseAt).toBeUndefined();
      yield* h.acquisition.acquire({ path: f.workspace, purpose: "git" });
      yield* h.acquisition.acquire({ path: f.workspace, purpose: "provider" });
      expect((yield* h.registry.list)[0]!.lastWorkspaceUseAt).toBeUndefined();
      yield* h.acquisition.acquire({ path: f.workspace, purpose: "git-mutation" });
      expect((yield* h.registry.list)[0]!.lastWorkspaceUseAt).toBeDefined();
    }),
  ),
);

it.live("installs fail-closed acquisition when the private catalog is unreadable", () =>
  realGit((f) =>
    Effect.gen(function* () {
      const h = yield* harness(f, { unreadableCatalog: true });
      const refused = yield* h.acquisition
        .acquire({ path: f.workspace, purpose: "git" })
        .pipe(Effect.flip);
      expect(refused.reason).toBe("snapshot-unavailable");
      expect((yield* h.service.list({}).pipe(Effect.exit))._tag).toBe("Failure");
      yield* Effect.promise(async () =>
        expect(await NodeFSP.readFile(NodePath.join(f.workspace, "notes", "private"), "utf8")).toBe(
          "ignored note\n",
        ),
      );
    }),
  ),
);

it.live(
  "retains uncertain deletion consent and cancels it only after an exact rejected receipt",
  () =>
    realGit((f) =>
      Effect.gen(function* () {
        const h = yield* harness(f);
        const saved = yield* h.suspend;
        const id = saved.summary.snapshotId!;
        const target = { kind: "threads" as const, threadIds: [firstId, secondId] };
        const commandId = CommandId.make("bulk:uncertain");
        const deleteReceipts = target.threadIds.map((threadId) => ({
          threadId,
          commandId: CommandId.make(`${commandId}:delete:${threadId}`),
        }));
        const preview = yield* h.lifecycle.preview({ operation: "delete", target });
        yield* h.lifecycle
          .run(
            {
              operation: "delete",
              target,
              commandId,
              deleteReceipts,
              savedWorkspace: { mode: "discard", previewToken: preview.token },
            },
            Effect.gen(function* () {
              h.threads.set(firstId, { ...h.threads.get(firstId)!, deletedAt: at });
              const first = deleteReceipts[0]!;
              h.commandReceipts.set(
                first.commandId,
                deletionReceipt(first.commandId, first.threadId, "accepted"),
              );
              return yield* Effect.fail("fixture disconnected before second receipt");
            }),
          )
          .pipe(Effect.exit);
        expect((yield* h.registry.list)[0]!.operation?.consentCommitted).not.toBe(true);
        expect((yield* Effect.promise(() => h.store.readJournal(id))).phase).toBe("discard-intent");
        yield* h.service.sweep;
        expect((yield* h.registry.list)[0]!.operation?.kind).toBe("discard");
        yield* Effect.promise(async () =>
          expect(
            await git(f.repository, "for-each-ref", `refs/lastcode/suspension/${id}/`),
          ).not.toBe(""),
        );
        const second = deleteReceipts[1]!;
        h.commandReceipts.set(
          second.commandId,
          deletionReceipt(second.commandId, second.threadId, "rejected"),
        );
        yield* h.service.sweep;
        expect((yield* h.registry.list)[0]!.operation).toBeUndefined();
        expect((yield* Effect.promise(() => h.store.readJournal(id))).phase).toBe("suspended");
        yield* h.acquisition.acquire({
          path: f.workspace,
          purpose: "file-write",
          threadId: secondId,
        });
        yield* Effect.promise(async () =>
          expect(
            await NodeFSP.readFile(NodePath.join(f.workspace, "notes", "private"), "utf8"),
          ).toBe("ignored note\n"),
        );
      }),
    ),
);

it.live(
  "reclaims a known incomplete capture before releasing its durable acquisition barrier",
  () =>
    realGit((f) =>
      Effect.gen(function* () {
        const h = yield* harness(f);
        const preview = yield* h.service.previewSuspend({ threadId: firstId });
        yield* withWorkspaceLease(
          f.workspace,
          Effect.gen(function* () {
            yield* h.service.suspend({ threadId: firstId, previewToken: preview.token });
            const capturing = (yield* h.registry.list)[0]!;
            const operation = capturing.operation!;
            const id = operation.snapshotIds[0]!;
            const storeRoot = NodePath.join(h.registry.root, "snapshots");
            let captures = 0;
            const interrupted = createWorktreeSuspensionStore({
              storeRoot,
              onBoundary: async (phase) => {
                if (phase === "capturing" && ++captures === 2)
                  throw new Error("fixture incomplete capture");
              },
            });
            yield* Effect.promise(async () => {
              await expect(
                interrupted.capture({
                  sourcePath: f.workspace,
                  snapshotId: id,
                  operationId: operation.id,
                  ownerBinding: capturing.checkoutId,
                }),
              ).rejects.toThrow("fixture incomplete capture");
              expect(
                (await NodeFSP.readdir(NodePath.join(storeRoot, id, "objects"))).length,
              ).toBeGreaterThan(0);
              const journal = await interrupted.readJournal(id);
              await git(
                f.repository,
                "update-ref",
                journal.captureRefs!.headRef,
                journal.captureRefs!.head,
              );
            });
            expect(
              (yield* h.acquisition.acquire({ path: f.workspace, purpose: "file-write" })).restored,
            ).toBe(false);
            const active = (yield* h.registry.list)[0]!;
            expect(active.operation).toBeUndefined();
            expect(active.summary.state).toBe("active");
            expect(active.summary.snapshotId).toBeNull();
            yield* Effect.promise(async () => {
              expect((await h.store.readJournal(id)).phase).toBe("capture-cancelled");
              expect(await NodeFSP.readdir(NodePath.join(storeRoot, id))).toEqual(["journal.json"]);
              expect(
                await git(f.repository, "for-each-ref", `refs/lastcode/suspension/${id}/`),
              ).toBe("");
              expect(
                await NodeFSP.readFile(NodePath.join(f.workspace, "notes", "private"), "utf8"),
              ).toBe("ignored note\n");
            });
          }),
        );
      }),
    ),
);

it.live.each([false, true])(
  "acquires the actual shared checkout branch with advisory owner drift (restored: %s)",
  (restored) =>
    realGit((f) =>
      Effect.gen(function* () {
        const h = yield* harness(f);
        if (restored) {
          yield* h.suspend;
          yield* h.acquisition.acquire({ path: f.workspace, purpose: "provider" });
        } else yield* h.service.previewSuspend({ threadId: firstId });
        yield* Effect.promise(() => git(f.workspace, "checkout", "-b", "switched"));
        h.threads.set(firstId, { ...h.threads.get(firstId)!, branch: "switched" });
        const acquired = yield* h.acquisition.acquire({
          path: f.workspace,
          purpose: "provider",
          threadId: secondId,
        });
        expect(acquired).toEqual({ path: f.workspace, branch: "switched", restored: false });
        expect(h.threads.get(secondId)!.branch).not.toBe("switched");
        const preview = yield* h.service.previewSuspend({ threadId: firstId });
        yield* h.service.suspend({ threadId: firstId, previewToken: preview.token });
        yield* h.awaitRecord(
          (record) => record.summary.state === "suspended" && record.operation === undefined,
        );
        yield* h.acquisition.acquire({ path: f.workspace, purpose: "provider" });
        expect(h.threads.get(firstId)!.branch).toBe("switched");
        expect(h.threads.get(secondId)!.branch).toBe("switched");
      }),
    ),
);

it.live("editor acquisition records positive use before automatic suspension", () =>
  realGit((f) =>
    Effect.gen(function* () {
      const h = yield* harness(f, { cleanupThreads: true, settings: automaticSettings });
      untouchedOwners(h.threads);
      yield* h.acquisition.acquire({ path: f.workspace, purpose: "editor", threadId: firstId });
      expect((yield* h.registry.list)[0]?.lastWorkspaceUseAt).toBeDefined();
      yield* h.service.sweep;
      expect((yield* h.registry.list)[0]!.summary.state).toBe("active");
    }),
  ),
);

it.live("finishes separate recovery when its published thread is deleted before finalization", () =>
  realGit((f) =>
    Effect.gen(function* () {
      const h = yield* harness(f, { deleteRecoveryAfterPublication: true });
      const saved = yield* h.suspend;
      const id = saved.summary.snapshotId!;
      yield* h.acquisition.acquire({ path: f.workspace, purpose: "provider" });
      const destination = NodePath.join(NodePath.dirname(f.workspace), "deleted-recovery");
      yield* h.service.restore({
        checkoutId: saved.checkoutId,
        snapshotId: id,
        projectId,
        destinationPath: destination,
      });
      yield* Stream.fromQueue(h.updates).pipe(
        Stream.filter(
          (record) => record.checkoutId === saved.checkoutId && record.blockedReason !== null,
        ),
        Stream.take(1),
        Stream.runHead,
      );
      const threadCount = h.threads.size;
      expect(threadCount).toBe(3);
      expect([...h.threads.values()].filter((thread) => thread.deletedAt !== null)).toHaveLength(1);
      yield* h.service.sweep;
      const source = (yield* h.registry.list).find(
        (record) => record.checkoutId === saved.checkoutId,
      )!;
      const recovered = (yield* h.registry.list).find(
        (record) => record.sourceCheckoutId === saved.checkoutId,
      )!;
      expect(source.operation).toBeUndefined();
      expect(source.blockedReason).toBeNull();
      expect(source.history).toContain(id);
      expect(recovered.operation).toBeUndefined();
      expect(recovered.pendingProjection).toBeUndefined();
      expect(recovered.owners).toEqual([]);
      expect(recovered.summary.keepWorkspace).toBe(true);
      expect(h.threads.size).toBe(threadCount);
      expect((yield* Effect.promise(() => h.store.readJournal(id))).phase).toBe("active");
      yield* Effect.promise(async () =>
        expect(await NodeFSP.readFile(NodePath.join(destination, "notes", "private"), "utf8")).toBe(
          "ignored note\n",
        ),
      );
      yield* h.acquisition.acquire({ path: f.workspace, purpose: "provider", threadId: firstId });
      yield* h.service.sweep;
      expect(h.threads.size).toBe(threadCount);
    }),
  ),
);

it.live("bounds and rotates automatic candidates past an inconsistent shared checkout", () =>
  realGit((f) =>
    Effect.gen(function* () {
      const h = yield* harness(f, {
        cleanupThreads: true,
        settings: {
          ...automaticSettings,
          worktreeSuspension: {
            ...automaticSettings.worktreeSuspension,
            scopes: { subagents: false, untouchedChildren: false, otherThreads: true },
          },
        },
      });
      yield* h.service.previewSuspend({ threadId: firstId });
      const original = (yield* h.registry.list)[0]!;
      h.threads.set(secondId, {
        ...h.threads.get(secondId)!,
        worktreeSuspension: { ...original.summary, generation: 99 },
      });
      const paths: string[] = [];
      for (let i = 0; i < 6; i++) {
        const name = `zz-candidate-${i}`;
        const workspace = NodePath.join(NodePath.dirname(f.workspace), name);
        yield* Effect.promise(() =>
          git(f.repository, "worktree", "add", "-b", name, workspace, "HEAD"),
        );
        const id = ThreadId.make(`fixture:${name}`);
        h.threads.set(id, { ...shell(id, workspace), branch: name });
        paths.push(workspace);
      }
      yield* h.service.sweep;
      const first = (yield* h.registry.list).filter((record) => paths.includes(record.path));
      expect(first).toHaveLength(3);
      for (const entry of first)
        yield* h.awaitRecord(
          (record) =>
            record.checkoutId === entry.checkoutId &&
            record.summary.state === "suspended" &&
            record.operation === undefined,
        );
      yield* h.service.sweep;
      const rest = (yield* h.registry.list).filter(
        (record) =>
          paths.includes(record.path) &&
          !first.some((prior) => prior.checkoutId === record.checkoutId),
      );
      expect(rest).toHaveLength(3);
      for (const entry of rest)
        yield* h.awaitRecord(
          (record) =>
            record.checkoutId === entry.checkoutId &&
            record.summary.state === "suspended" &&
            record.operation === undefined,
        );
      expect(
        (yield* h.registry.list).find((record) => record.checkoutId === original.checkoutId)!
          .summary.state,
      ).toBe("active");
    }),
  ),
);

it.live("prefilters ineligible shells before identifying or registering checkouts", () =>
  realGit((f) =>
    Effect.gen(function* () {
      const h = yield* harness(f, { cleanupThreads: true, settings: automaticSettings });
      yield* h.service.sweep;
      expect(h.gitRequests).toEqual([]);
      expect(yield* h.registry.list).toEqual([]);
    }),
  ),
);

it.live("preserves unknown child lineage before automatic scope classification", () =>
  realGit((f) =>
    Effect.gen(function* () {
      const h = yield* harness(f, {
        cleanupThreads: true,
        settings: {
          ...automaticSettings,
          worktreeSuspension: {
            ...automaticSettings.worktreeSuspension,
            scopes: { subagents: true, untouchedChildren: true, otherThreads: true },
          },
        },
      });
      for (const [id, thread] of h.threads)
        h.threads.set(id, { ...thread, createdBy: "agent", workspaceUserAdopted: false });
      yield* h.service.sweep;
      expect(yield* h.registry.list).toEqual([]);
      expect(h.gitRequests).toEqual([]);
    }),
  ),
);

it.live("keeps a recorded recent workspace-use clock in the cheap sweep prefilter", () =>
  realGit((f) =>
    Effect.gen(function* () {
      const h = yield* harness(f, { cleanupThreads: true, settings: automaticSettings });
      untouchedOwners(h.threads);
      yield* h.service.previewSuspend({ threadId: firstId });
      const record = (yield* h.registry.list)[0]!;
      yield* h.registry.put(
        { ...record, lastWorkspaceUseAt: yield* DateTime.now.pipe(Effect.map(DateTime.formatIso)) },
        record,
      );
      const requests = h.gitRequests.length;
      yield* h.service.sweep;
      expect(h.gitRequests).toHaveLength(requests);
      expect((yield* h.registry.list)[0]!.summary.state).toBe("active");
    }),
  ),
);
