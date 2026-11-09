import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
// @effect-diagnostics nodeBuiltinImport:off -- Owned real-Git fixtures exercise the service and its durable native store together.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  GitCommandError,
  OrchestrationV2ThreadShell,
  ProjectId,
  RunId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type WorktreeSuspensionTransitionInput,
  type ServerSettings as SettingsValue,
} from "@t3tools/contracts";
import {
  createWorktreeSuspensionStore,
  type WorktreeSuspensionStoreOptions,
} from "@t3tools/shared/worktreeSuspension";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import { ChildProcessSpawner } from "effect/process";
import { TestClock } from "effect/testing";

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
import { withProjectRootLease } from "./projectRootLease.ts";

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
  await NodeFSP.appendFile(
    NodePath.join(repository, ".git", "config"),
    "\n[user]\n\temail = fixture@example.invalid\n\tname = Fixture\n",
  );
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
    scratch?: boolean;
    failAfterPublication?: "suspended" | "active";
    cleanupThreads?: boolean;
    historicalOwners?: Effect.Success<
      Cleanup.WorktreeCleanupService["Service"]["historicalWorktreeOwners"]
    >;
    settings?: SettingsValue;
    adoptOnCaptured?: boolean;
    pauseCaptured?: { entered: Deferred.Deferred<void>; release: Deferred.Deferred<void> };
    pauseCaptureIntent?: { entered: Deferred.Deferred<void>; release: Deferred.Deferred<void> };
    pauseRestored?: { entered: Deferred.Deferred<void>; release: Deferred.Deferred<void> };
    unreadableCatalog?: boolean;
    failDiscardPrepareAt?: number;
    occupyRestoreOnBarrier?: boolean;
    occupyRecoveryOnBarrier?: boolean;
    deleteRecoveryAfterPublication?: boolean;
    previews?: Array<{ threadId: string; workspacePath: string }>;
    onPreviewScan?: (leases: Array<{ threadId: string; workspacePath: string }>) => void;
    pausePreviewLocks?: { entered: Deferred.Deferred<void>; release: Deferred.Deferred<void> };
    pausePreviewRemoval?: { entered: Deferred.Deferred<void>; release: Deferred.Deferred<void> };
    onStoreBoundary?: WorktreeSuspensionStoreOptions["onBoundary"];
    terminals?: Effect.Success<TerminalManager.TerminalManager["Service"]["refreshMetadata"]>;
  } = {},
) =>
  Effect.gen(function* () {
    const original = yield* Registry.WorktreeSuspensionRegistry;
    const fs = yield* FileSystem.FileSystem;
    const acquisition = yield* Acquisition.WorkspaceAcquisition;
    const lifecycle = yield* Lifecycle.WorkspaceLifecycle;
    const updates = yield* Queue.unbounded<Registry.CheckoutAuthority>();
    const commandReceipts = new Map<CommandId, CommandReceipts.CommandReceiptV2>();
    const threads = new Map<ThreadId, OrchestrationV2ThreadShell>([
      [firstId, shell(firstId, fixture.workspace)],
      [secondId, shell(secondId, fixture.workspace)],
    ]);
    if (options.scratch)
      for (const [id, thread] of threads) threads.set(id, { ...thread, branch: null });
    const current = () => [...threads.values()].filter((thread) => thread.deletedAt === null);
    const project: ProjectStore.ProjectRow = {
      projectId,
      title: "Fixture",
      workspaceRoot: fixture.repository,
      pinnedAt: null,
      archivedAt: null,
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
    const projects = [project];
    const previewLeases = [...(options.previews ?? [])];
    const terminalRecords = [...(options.terminals ?? [])];
    const hostingLeases = () =>
      previewLeases.map((lease) => ({
        id: `preview-${lease.threadId}`,
        threadId: lease.threadId,
        terminalId: `preview-${lease.threadId}`,
        command: "fixture",
        cwd: lease.workspacePath,
        worktreePath: lease.workspacePath,
        url: "http://127.0.0.1:1234/",
        handedOffAt: DateTime.formatIso(at),
        expiresAt: DateTime.formatIso(at),
        status: "active" as const,
      }));
    const previewReleases: string[] = [];
    let onPreviewRelease: ((threadId: string) => void) | undefined;
    let settings = options.settings ?? DEFAULT_SERVER_SETTINGS;
    let registerWhenIsolated: string | null = null;
    let failedPublication = false;
    let pausedCapture = false;
    let pausedCaptureIntent = false;
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
              options.pauseCaptureIntent !== undefined &&
              !pausedCaptureIntent &&
              next.operation?.kind === "capture"
            ) {
              pausedCaptureIntent = true;
              return Deferred.succeed(options.pauseCaptureIntent.entered, undefined).pipe(
                Effect.andThen(Deferred.await(options.pauseCaptureIntent.release)),
              );
            }
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
    const service = yield* Suspension.makeWithStoreOptions(
      options.onStoreBoundary === undefined ? {} : { onBoundary: options.onStoreBoundary },
    ).pipe(
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
                threads: current().filter((thread) => thread.archivedAt === null),
                archivedThreads: current().filter((thread) => thread.archivedAt !== null),
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
            get: (id) =>
              Effect.sync(() =>
                Option.fromUndefinedOr(projects.find((entry) => entry.projectId === id)),
              ),
            list: () =>
              Effect.gen(function* () {
                if (
                  registerWhenIsolated !== null &&
                  !(yield* fs.exists(fixture.workspace).pipe(Effect.orDie))
                ) {
                  projects.push({
                    ...project,
                    projectId: ProjectId.make("fixture:registered"),
                    workspaceRoot: registerWhenIsolated,
                  });
                  registerWhenIsolated = null;
                }
                return [...projects];
              }),
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
            historicalWorktreeOwners: Effect.sync(() => options.historicalOwners ?? []),
          }),
          Layer.mock(TerminalManager.TerminalManager)({
            refreshMetadata: Effect.sync(() => [...terminalRecords]),
          }),
          Layer.mock(PreviewHosting.PreviewHosting)({
            protectedWorkspacePaths: () =>
              Effect.sync(() => previewLeases.map((lease) => lease.workspacePath)),
            list: () => Effect.sync(hostingLeases),
            protectedWorkspaceLeases: () =>
              Effect.sync(() => {
                const observed = hostingLeases();
                options.onPreviewScan?.(previewLeases);
                return observed;
              }),
            withThreadPreviewLocks: (_threadIds, use) =>
              Effect.gen(function* () {
                if (options.pausePreviewLocks !== undefined) {
                  yield* Deferred.succeed(options.pausePreviewLocks.entered, undefined);
                  yield* Deferred.await(options.pausePreviewLocks.release);
                }
                return yield* use((threadId, workspacePath) =>
                  Effect.gen(function* () {
                    if (options.pausePreviewRemoval !== undefined) {
                      yield* Deferred.succeed(options.pausePreviewRemoval.entered, undefined);
                      yield* Deferred.await(options.pausePreviewRemoval.release);
                    }
                    previewReleases.push(threadId);
                    for (let index = previewLeases.length - 1; index >= 0; index--)
                      if (
                        previewLeases[index]!.threadId === threadId &&
                        previewLeases[index]!.workspacePath === workspacePath
                      ) {
                        previewLeases.splice(index, 1);
                        const terminal = terminalRecords.findIndex(
                          (entry) =>
                            entry.threadId === threadId &&
                            entry.terminalId === `preview-${threadId}`,
                        );
                        if (terminal >= 0) terminalRecords.splice(terminal, 1);
                      }
                    onPreviewRelease?.(threadId);
                  }),
                );
              }),
          }),
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.sync(() => settings),
          }),
          Layer.mock(GitVcsDriver.GitVcsDriver)({
            execute: (input) =>
              Effect.tryPromise({
                try: async () => {
                  gitRequests.push(input.operation);
                  return {
                    stdout: await git(input.cwd, ...input.args),
                    stderr: "",
                    stdoutTruncated: false,
                    stderrTruncated: false,
                    exitCode: ChildProcessSpawner.ExitCode(0),
                  };
                },
                catch: (cause) =>
                  new GitCommandError({
                    operation: input.operation,
                    command: "git",
                    cwd: input.cwd,
                    detail: "Fixture Git command failed",
                    cause,
                  }),
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
      previewLeases,
      previewReleases,
      onPreviewRelease: (callback: (threadId: string) => void) => {
        onPreviewRelease = callback;
      },
      setSettings: (next: SettingsValue) => {
        settings = next;
      },
      registerProjectRoot: (workspaceRoot: string) => {
        projects.push({
          ...project,
          projectId: ProjectId.make("fixture:registered"),
          workspaceRoot,
        });
      },
      registerProjectWhenIsolated: (workspaceRoot: string) => {
        registerWhenIsolated = workspaceRoot;
      },
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
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
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

it.effect.each([
  "device-only",
  "owner-alias",
  "unproven-alias",
  "moved-alias",
  "current-alias",
  "alias-save",
  "source-inode",
  "git-inode",
  "common-inode",
  "git-path",
  "common-path",
  "source-device",
  "git-device",
] as const)("revalidates an active checkout after device renumbering: %s", (change) =>
  realGit((f) =>
    Effect.gen(function* () {
      const h = yield* harness(f);
      yield* h.service.previewSuspend({ threadId: firstId });
      const record = (yield* h.registry.list)[0]!;
      const original = record.nativeIdentity!;
      const aliased = [
        "owner-alias",
        "unproven-alias",
        "moved-alias",
        "current-alias",
        "alias-save",
      ].includes(change);
      const destination = aliased
        ? NodePath.join(NodePath.dirname(f.workspace), "alias")
        : f.workspace;
      if (aliased) {
        yield* Effect.promise(() => NodeFSP.symlink(f.workspace, destination, "dir"));
        for (const [id, thread] of h.threads)
          h.threads.set(id, { ...thread, worktreePath: destination });
      }
      if (change === "moved-alias") {
        const moved = NodePath.join(NodePath.dirname(f.workspace), "moved");
        yield* Effect.promise(async () => {
          await git(f.repository, "worktree", "move", f.workspace, moved);
          await NodeFSP.unlink(destination);
          await NodeFSP.symlink(moved, destination, "dir");
        });
      }
      const deviceDelta = change === "current-alias" ? 0 : 1;
      const stale = {
        ...original,
        sourceIdentity: {
          dev: original.sourceIdentity.dev + (change === "source-device" ? 2 : deviceDelta),
          ino: original.sourceIdentity.ino + (change === "source-inode" ? 1 : 0),
        },
        gitDirectory: original.gitDirectory + (change === "git-path" ? "-other" : ""),
        gitDirectoryIdentity: {
          dev: original.gitDirectoryIdentity.dev + (change === "git-device" ? 0 : deviceDelta),
          ino: original.gitDirectoryIdentity.ino + (change === "git-inode" ? 1 : 0),
        },
        commonIdentity: {
          dev: original.commonIdentity.dev + deviceDelta,
          ino: original.commonIdentity.ino + (change === "common-inode" ? 1 : 0),
        },
        commonDirectory: original.commonDirectory + (change === "common-path" ? "-other" : ""),
      };
      yield* h.registry.put(
        {
          ...record,
          path: ["unproven-alias", "moved-alias", "current-alias"].includes(change)
            ? destination
            : record.path,
          aliases: [...new Set([...record.aliases, destination])],
          nativeIdentity: stale,
        },
        record,
      );
      const acquired = yield* h.acquisition
        .acquire({ path: destination, threadId: firstId, purpose: "provider" })
        .pipe(Effect.result);
      if (change === "alias-save") {
        expect(acquired._tag).toBe("Success");
        expect((yield* h.suspend).summary.state).toBe("suspended");
      } else if (
        change === "device-only" ||
        change === "owner-alias" ||
        change === "current-alias"
      ) {
        expect(acquired).toMatchObject({ _tag: "Success", success: { path: f.workspace } });
        expect((yield* h.registry.list)[0]!.nativeIdentity).toEqual(original);
        expect((yield* h.registry.list)[0]!.summary).toEqual(record.summary);
        expect((yield* h.registry.list)[0]!.path).toBe(f.workspace);
        expect((yield* h.registry.list)[0]!.aliases).toContain(destination);
        expect(
          yield* h.acquisition.acquire({
            path: destination,
            threadId: firstId,
            purpose: "provider",
          }),
        ).toEqual({ path: f.workspace, branch: "topic", restored: false });
        expect((yield* h.registry.list)[0]!.aliases).toContain(destination);
        expect(
          yield* h.acquisition.acquire({
            path: f.workspace,
            threadId: firstId,
            purpose: "provider",
          }),
        ).toEqual({ path: f.workspace, branch: "topic", restored: false });
        expect(yield* h.registry.list).toHaveLength(1);
      } else {
        expect(acquired).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "WorkspaceUnavailableError" },
        });
        expect((yield* h.registry.list)[0]!.nativeIdentity).toEqual(stale);
      }
    }),
  ),
);

const realScratch = <A, E, R>(test: (fixture: Fixture) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(async () => {
      const root = await NodeFSP.realpath(
        await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scratch-controller-")),
      );
      const repository = NodePath.join(root, "scratch");
      const workspace = NodePath.join(repository, "notes");
      await NodeFSP.mkdir(workspace, { recursive: true });
      await NodeFSP.writeFile(NodePath.join(workspace, "draft.txt"), "scratch draft\n");
      return {
        root,
        repository,
        workspace,
        async [Symbol.asyncDispose]() {
          await NodeFSP.rm(root, { recursive: true, force: true });
        },
      };
    }),
    (fixture) => provide(test(fixture), fixture),
    (fixture) => Effect.promise(() => fixture[Symbol.asyncDispose]()),
  );

it.live("saves scratch synchronously and restores on use without Git", () =>
  realScratch((f) =>
    Effect.gen(function* () {
      const h = yield* harness(f, { scratch: true });
      yield* h.acquisition.acquire({ path: f.workspace, purpose: "editor" });
      const checks: string[] = [];
      const result = yield* h.service.suspendScratch({
        path: f.workspace,
        owners: [...h.threads.values()],
        recheck: (physicalPath) =>
          Effect.sync(() => {
            checks.push(physicalPath);
            return null;
          }),
      });
      expect(result.bytes).toBeGreaterThan(0);
      expect(result.files).toBe(1);
      const saved = (yield* h.registry.list)[0]!;
      expect(saved.summary.state).toBe("suspended");
      expect(saved.kind).toBe("scratch");
      expect(saved.repositoryRoot).toBeNull();
      expect(checks).toHaveLength(4);
      expect(checks.slice(0, 2)).toEqual([f.workspace, f.workspace]);
      expect(
        checks.slice(2).every((candidate) => candidate.includes(".suspended-workspaces")),
      ).toBe(true);
      yield* Effect.promise(async () => {
        await expect(NodeFSP.lstat(f.workspace)).rejects.toMatchObject({ code: "ENOENT" });
      });
      const acquired = yield* h.acquisition.acquire({
        path: f.workspace,
        purpose: "editor",
        threadId: firstId,
      });
      expect(acquired).toEqual({ path: f.workspace, branch: null, restored: true });
      expect(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(f.workspace, "draft.txt"), "utf8"),
        ),
      ).toBe("scratch draft\n");
      expect(h.gitRequests).toEqual([]);
      // Starting a repository must not prevent normal use of the active folder.
      yield* Effect.promise(() => NodeFSP.mkdir(NodePath.join(f.workspace, ".git")));
      expect(
        yield* h.acquisition.acquire({ path: f.workspace, purpose: "editor", threadId: firstId }),
      ).toEqual({ path: f.workspace, branch: null, restored: false });
      yield* Effect.promise(() =>
        NodeFSP.rm(NodePath.join(f.workspace, ".git"), { recursive: true }),
      );
      h.registerProjectRoot(f.workspace);
      for (const [id, thread] of h.threads)
        h.threads.set(id, {
          ...thread,
          projectId: ProjectId.make("fixture:registered"),
          worktreePath: null,
        });
      expect(
        yield* h.acquisition.acquire({ path: f.workspace, purpose: "editor", threadId: firstId }),
      ).toEqual({ path: f.workspace, branch: null, restored: false });
      expect((yield* h.registry.list)[0]).toMatchObject({ detached: true, owners: [] });
      expect(h.gitRequests).toEqual([]);
    }),
  ),
);

it.live("retains deleted scratch owners in receipts and creates a new recovery thread", () =>
  realScratch((f) =>
    Effect.gen(function* () {
      const h = yield* harness(f, { scratch: true });
      yield* h.acquisition.acquire({ path: f.workspace, purpose: "editor" });
      for (const [id, thread] of h.threads) h.threads.set(id, { ...thread, deletedAt: at });
      yield* h.service.suspendScratch({
        path: f.workspace,
        owners: [...h.threads.values()],
        recheck: () => Effect.succeed(null),
      });
      const saved = (yield* h.registry.list)[0]!;
      expect(saved.owners).toEqual([]);
      expect(saved.snapshots![0]!.owners.map((owner) => owner.threadId)).toEqual([
        firstId,
        secondId,
      ]);
      expect((yield* h.service.list({})).entries).toEqual([]);
      const entry = (yield* h.service.list({}, { allowOrphans: true })).entries[0]!;
      expect(entry).toMatchObject({ kind: "scratch", head: null, branch: null, orphaned: true });
      expect(
        (yield* h.service
          .restore({ checkoutId: saved.checkoutId, snapshotId: entry.snapshotId })
          .pipe(Effect.flip)).reason,
      ).toBe("protected");
      yield* h.service.restore(
        { checkoutId: saved.checkoutId, snapshotId: entry.snapshotId },
        { allowOrphans: true },
      );
      const active = yield* h.awaitRecord(
        (record) => record.sourceCheckoutId === saved.checkoutId && record.operation === undefined,
      );
      const recovered = h.threads.get(active.owners[0]!.threadId)!;
      expect(recovered.branch).toBeNull();
      expect(NodePath.dirname(recovered.worktreePath!)).toBe(f.repository);
      expect(recovered.id).not.toBe(firstId);
      expect(h.threads.get(firstId)!.deletedAt).not.toBeNull();
      expect(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(active.path, "draft.txt"), "utf8"),
        ),
      ).toBe("scratch draft\n");
      expect(h.gitRequests).toEqual([]);
    }),
  ),
);

it.live("preserves an isolated scratch folder when the boundary recheck blocks removal", () =>
  realScratch((f) =>
    Effect.gen(function* () {
      const h = yield* harness(f, { scratch: true });
      const error = yield* h.service
        .suspendScratch({
          path: f.workspace,
          owners: [...h.threads.values()],
          recheck: (physicalPath) =>
            Effect.succeed(
              physicalPath === f.workspace ? null : "A terminal uses the isolated folder.",
            ),
        })
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        reason: "protected",
        message: "A terminal uses the isolated folder.",
      });
      const saved = (yield* h.registry.list)[0]!;
      const journal = yield* Effect.promise(() =>
        h.store.readJournal(saved.operation!.snapshotIds[0]!),
      );
      expect(journal.phase).toBe("isolated");
      expect(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(journal.isolatedPath!, "draft.txt"), "utf8"),
        ),
      ).toBe("scratch draft\n");
      expect(saved.blockedReason).toBe(error.message);
      expect(h.gitRequests).toEqual([]);
    }),
  ),
);

it.live("rejects nested and symlink scratch restore destinations", () =>
  realScratch((f) =>
    Effect.gen(function* () {
      const h = yield* harness(f, { scratch: true });
      yield* h.service.suspendScratch({
        path: f.workspace,
        owners: [...h.threads.values()],
        recheck: () => Effect.succeed(null),
      });
      const saved = (yield* h.registry.list)[0]!;
      const nested = NodePath.join(f.repository, "parent", "child");
      const linked = NodePath.join(f.repository, "linked");
      yield* Effect.promise(() => NodeFSP.symlink(f.root, linked));
      for (const destinationPath of [nested, linked]) {
        expect(
          (yield* h.service
            .restore({
              checkoutId: saved.checkoutId,
              snapshotId: saved.summary.snapshotId!,
              destinationPath,
            })
            .pipe(Effect.flip)).reason,
        ).toBe("protected");
      }
      expect((yield* h.registry.list)[0]!.summary.state).toBe("suspended");
      expect(h.gitRequests).toEqual([]);
    }),
  ),
);

it.live("creates an empty fresh scratch workspace after disposal without Git", () =>
  realScratch((f) =>
    Effect.gen(function* () {
      const h = yield* harness(f, { scratch: true });
      yield* h.service.suspendScratch({
        path: f.workspace,
        owners: [...h.threads.values()],
        recheck: () => Effect.succeed(null),
      });
      const saved = (yield* h.registry.list)[0]!;
      const preview = yield* h.service.previewDiscard({
        checkoutId: saved.checkoutId,
        snapshotIds: [saved.summary.snapshotId!],
      });
      yield* h.service.discard({ previewToken: preview.token });
      yield* h.awaitRecord(
        (record) =>
          record.summary.state === "discarded" &&
          record.operation === undefined &&
          record.pendingProjection === undefined,
      );
      yield* h.service.createFresh({ threadId: firstId });
      const active = yield* h.awaitRecord(
        (record) =>
          record.summary.state === "active" &&
          record.operation === undefined &&
          record.pendingProjection === undefined,
      );
      expect(yield* Effect.promise(() => NodeFSP.readdir(f.workspace))).toEqual([]);
      expect(active).toMatchObject({
        kind: "scratch",
        lastHead: null,
        summary: { state: "active", keepWorkspace: true, snapshotId: null },
      });
      expect(h.threads.get(firstId)!.branch).toBeNull();
      expect(h.threads.get(secondId)!.branch).toBeNull();
      expect(h.gitRequests).toEqual([]);
    }),
  ),
);

it.live("suspends exact historical migration duplicates of current owners", () =>
  realGit((f) =>
    Effect.gen(function* () {
      const historicalOwners = [firstId, secondId].map((threadId) => ({
        threadId,
        projectId,
        worktreePath: f.workspace,
        branch: "topic",
      }));
      const h = yield* harness(f, { historicalOwners });
      const saved = yield* h.suspend;
      expect(saved.summary.state).toBe("suspended");
      expect(
        yield* Effect.promise(() =>
          NodeFSP.stat(f.workspace).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false);
      yield* h.acquisition.acquire({ path: f.workspace, purpose: "file-write" });
      expect(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(f.workspace, "tracked"), "utf8"),
        ),
      ).toBe("working\n");
      expect(historicalOwners).toHaveLength(2);
      yield* h.suspend;
    }),
  ),
);

it.live("ignores an unrelated historical path that cannot be resolved", () =>
  realGit((f) =>
    Effect.gen(function* () {
      const loop = NodePath.join(f.root, "historical-loop");
      yield* Effect.promise(() => NodeFSP.symlink(loop, loop));
      const h = yield* harness(f, {
        historicalOwners: [
          {
            threadId: "fixture:unrelated-history",
            projectId: "fixture:unrelated-project",
            worktreePath: loop,
            branch: "unrelated",
          },
        ],
      });
      const saved = yield* h.suspend;
      expect(saved.summary.state).toBe("suspended");
      yield* Effect.promise(async () => {
        await expect(NodeFSP.lstat(f.workspace)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await NodeFSP.readlink(loop)).toBe(loop);
      });
    }),
  ),
);

it.live.each([
  "thread",
  "project",
  "branch",
  "missing branch",
  "path",
  "malformed",
  "moved",
  "current branch",
  "deleted",
  "unavailable",
  "extra owner",
  "symlink",
] as const)("retains a workspace with %s historical ownership", (mismatch) =>
  realGit((f) =>
    Effect.gen(function* () {
      const duplicate = {
        threadId: firstId,
        projectId,
        worktreePath: f.workspace,
        branch: "topic" as string | null,
      };
      const historicalOwners: Array<{
        threadId: string;
        projectId: string;
        worktreePath: string;
        branch: string | null;
      }> = [duplicate];
      const h = yield* harness(f, { historicalOwners });
      switch (mismatch) {
        case "thread":
          historicalOwners[0] = { ...duplicate, threadId: "fixture:other" };
          break;
        case "project":
          historicalOwners[0] = {
            ...duplicate,
            projectId: ProjectId.make("fixture:other-project"),
          };
          break;
        case "branch":
          historicalOwners[0] = { ...duplicate, branch: "other" };
          break;
        case "missing branch":
          historicalOwners[0] = { ...duplicate, branch: null };
          break;
        case "path":
          historicalOwners[0] = { ...duplicate, worktreePath: `${f.workspace}/.` };
          break;
        case "malformed":
          historicalOwners[0] = { ...duplicate, threadId: "" };
          break;
        case "moved":
          h.threads.set(firstId, { ...h.threads.get(firstId)!, worktreePath: f.repository });
          break;
        case "current branch":
          h.threads.set(firstId, { ...h.threads.get(firstId)!, branch: "renamed" });
          break;
        case "deleted":
          h.threads.set(firstId, { ...h.threads.get(firstId)!, deletedAt: at });
          break;
        case "unavailable":
          h.threads.delete(firstId);
          break;
        case "extra owner":
          historicalOwners.push({ ...duplicate, threadId: ThreadId.make("fixture:unknown") });
          break;
        case "symlink": {
          const alias = NodePath.join(f.root, "alias");
          yield* Effect.promise(() => NodeFSP.symlink(f.workspace, alias));
          historicalOwners[0] = { ...duplicate, worktreePath: alias };
          break;
        }
      }
      const error = yield* h.service
        .previewSuspend({
          threadId: secondId,
        })
        .pipe(Effect.flip);
      expect(error.reason).toBe("protected");
      expect(error.message).toContain("Historical workspace ownership needs review.");
      expect(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(f.workspace, "tracked"), "utf8"),
        ),
      ).toBe("working\n");
      expect(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(f.workspace, "notes", "private"), "utf8"),
        ),
      ).toBe("ignored note\n");
    }),
  ),
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
  allowBlocked = false,
) =>
  Stream.fromQueue(updates).pipe(
    Stream.filter((record) => predicate(record) && (allowBlocked || record.blockedReason === null)),
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
          true,
        );
        expect(kept.owners[0]!.threadId).toBe(secondId);
        expect(kept.history).toEqual([]);
        expect(kept.captureFailure?.reason).toBe(kept.blockedReason);
        expect(yield* h.registry.automaticProtection(f.workspace)).not.toBeNull();
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
          true,
        );
        expect(kept.captureFailure).toBeDefined();
        expect(kept.blockedReason).not.toBeNull();
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

it.live.each([false, true])(
  "retains an interrupted owned trial without trapping a verified original (failed: %s)",
  (failed) =>
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
          ...(failed
            ? { captureFailure: { operationId: id, reason: "fixture stopped capture" } }
            : {}),
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
          await NodeFSP.writeFile(
            NodePath.join(trial, failed ? ".DS_Store" : "unknown-note"),
            "keep trial addition\n",
          );
          return trial;
        });
        yield* h.service.sweep;
        if (failed) {
          const active = (yield* h.registry.list)[0]!;
          expect(active.summary.state).toBe("active");
          expect(active.operation).toBeUndefined();
          expect(active.captureFailure?.operationId).toBe(id);
          expect(active.captureFailure?.retryOnce).toBeUndefined();
          expect(active.history).toContain(id);
          expect(yield* h.registry.automaticProtection(f.workspace)).not.toBeNull();
          const retained = yield* Effect.promise(() => h.store.readJournal(id));
          expect(retained.phase).toBe("active");
          expect(retained.trialPath).toBe(trial);
          expect(retained.trialIdentity).toBeDefined();
          expect(retained.trialGitDirectory).toBeDefined();
          const restarted = yield* harness(f);
          for (const [threadId, thread] of h.threads) restarted.threads.set(threadId, thread);
          expect(
            (yield* restarted.acquisition.acquire({ path: f.workspace, purpose: "git" })).path,
          ).toBe(f.workspace);
          yield* restarted.service.sweep;
          const refusal = yield* restarted.service
            .previewDiscard({ checkoutId: active.checkoutId, snapshotIds: [id] })
            .pipe(Effect.flip);
          expect(refusal.reason).toBe("protected");
          expect((yield* restarted.registry.list)[0]!.operation).toBeUndefined();
          yield* Effect.promise(async () => {
            expect(await NodeFSP.readFile(NodePath.join(trial, ".DS_Store"), "utf8")).toBe(
              "keep trial addition\n",
            );
            expect(
              await NodeFSP.readFile(NodePath.join(f.workspace, "notes", "private"), "utf8"),
            ).toBe("ignored note\n");
            expect((await restarted.store.readJournal(id)).trialPath).toBe(trial);
            await expect(restarted.store.beginDiscard(id)).rejects.toThrow(
              "trial recovery still needs reconciliation",
            );
            expect(await NodeFSP.readdir(NodePath.join(h.registry.root, "snapshots"))).toEqual([
              id,
            ]);
          });
          const saved = yield* restarted.suspend;
          expect(saved.summary.state).toBe("suspended");
          expect(saved.summary.snapshotId).not.toBe(id);
          expect(saved.captureFailure).toBeUndefined();
          expect(saved.history).toContain(id);
          expect(
            (yield* restarted.service
              .previewDiscard({ checkoutId: active.checkoutId, snapshotIds: [id] })
              .pipe(Effect.flip)).reason,
          ).toBe("protected");
          expect((yield* restarted.registry.list)[0]!.operation).toBeUndefined();
          yield* Effect.promise(async () =>
            expect(await NodeFSP.readFile(NodePath.join(trial, ".DS_Store"), "utf8")).toBe(
              "keep trial addition\n",
            ),
          );
          return;
        }
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
        expect(active.captureFailure?.operationId).toBe(id);
        expect(yield* h.registry.automaticProtection(f.workspace)).not.toBeNull();
        expect((yield* Effect.promise(() => h.store.readJournal(id))).trialPath).toBeUndefined();
        yield* Stream.fromQueue(h.updates).pipe(
          Stream.filter(
            (record) =>
              record.summary.state === "active" &&
              record.operation === undefined &&
              record.pendingProjection === undefined &&
              record.captureFailure?.operationId === id,
          ),
          Stream.take(1),
          Stream.runHead,
        );
        const discard = yield* h.service.previewDiscard({
          checkoutId: original.checkoutId,
          snapshotIds: [id],
        });
        yield* h.service.discard({ previewToken: discard.token });
        yield* awaitRecovered(
          h.updates,
          (record) =>
            record.operation === undefined &&
            record.history.length === 0 &&
            record.summary.generation === summary.generation,
          true,
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

it.live("rejects historical recovery into another checkout's reserved path", () =>
  realGit((f) =>
    Effect.gen(function* () {
      const h = yield* harness(f);
      const saved = yield* h.suspend;
      const snapshotId = saved.summary.snapshotId!;
      yield* h.acquisition.acquire({ path: f.workspace, purpose: "file-write" });
      const source = (yield* h.registry.list)[0]!;
      const destination = NodePath.join(NodePath.dirname(f.workspace), "reserved-workspace");
      yield* h.registry.put(
        {
          ...source,
          checkoutId: "fixture:reserved",
          path: destination,
          aliases: [destination],
          owners: [],
          history: [],
          snapshots: [],
          summary: { ...source.summary, checkoutId: "fixture:reserved", state: "suspended" },
        },
        null,
      );
      const result = yield* h.service
        .restore({
          checkoutId: saved.checkoutId,
          snapshotId,
          projectId,
          destinationPath: destination,
        })
        .pipe(Effect.flip);
      expect(result.reason).toBe("protected");
      expect(
        (yield* h.registry.list).find((entry) => entry.checkoutId === saved.checkoutId)!.operation,
      ).toBeUndefined();
      expect(
        yield* Effect.promise(() =>
          NodeFSP.stat(destination).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false);
    }),
  ),
);

it.live("rejects an ordinary restore into another saved checkout's path", () =>
  realGit((f) =>
    Effect.gen(function* () {
      const h = yield* harness(f);
      const saved = yield* h.suspend;
      const source = (yield* h.registry.list)[0]!;
      const destination = NodePath.join(NodePath.dirname(f.workspace), "reserved-workspace");
      const other = {
        ...source,
        checkoutId: "fixture:reserved",
        path: destination,
        aliases: [destination],
        owners: [],
        history: [],
        snapshots: [],
        summary: { ...source.summary, checkoutId: "fixture:reserved" },
      };
      yield* h.registry.put(other, null);
      const result = yield* h.service
        .restore({
          checkoutId: saved.checkoutId,
          snapshotId: saved.summary.snapshotId!,
          destinationPath: destination,
        })
        .pipe(Effect.flip);
      expect(result.reason).toBe("protected");
      expect(
        (yield* h.registry.list).find((entry) => entry.checkoutId === saved.checkoutId),
      ).toEqual(source);
      expect(
        yield* Effect.promise(() =>
          NodeFSP.stat(destination).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false);
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

it.effect.each([false, true])(
  "keeps scratch outside Git suspension policy with preview %s",
  (preview) =>
    realScratch((f) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-06-10T12:00:00.000Z"));
        const h = yield* harness(f, {
          scratch: true,
          cleanupThreads: true,
          settings: automaticSettings,
          previews: preview ? [{ threadId: firstId, workspacePath: f.workspace }] : [],
        });
        untouchedOwners(h.threads);
        yield* h.service.sweep;
        expect(
          yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(f.workspace, "draft.txt"), "utf8"),
          ),
        ).toBe("scratch draft\n");
        expect(h.previewReleases).toEqual([]);
      }),
    ),
);

it.live("refuses manual scratch suspension outside storage cleanup", () =>
  realScratch((f) =>
    Effect.gen(function* () {
      const h = yield* harness(f, { scratch: true });
      expect(
        (yield* h.service.previewSuspend({ threadId: firstId }).pipe(Effect.flip)).reason,
      ).toBe("protected");
      expect(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(f.workspace, "draft.txt"), "utf8"),
        ),
      ).toBe("scratch draft\n");
    }),
  ),
);

it.live("automatically saves a shared workspace after unsettled archived owners age out", () =>
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
      const now = yield* DateTime.now;
      h.threads.set(firstId, { ...h.threads.get(firstId)!, archivedAt: at, settledAt: null });
      h.threads.set(secondId, {
        ...h.threads.get(secondId)!,
        createdBy: "agent",
        creatorThreadId: firstId,
        workspaceUserAdopted: false,
        lineage: {
          rootThreadId: firstId,
          parentThreadId: firstId,
          relationshipToParent: "subagent",
        },
        archivedAt: now,
        settledAt: null,
      });
      yield* h.service.previewSuspend({ threadId: firstId });
      yield* h.service.sweep;
      expect((yield* h.registry.list)[0]?.summary.state).toBe("active");
      h.threads.set(secondId, { ...h.threads.get(secondId)!, archivedAt: at });
      const record = (yield* h.registry.list)[0]!;
      yield* h.registry.put({ ...record, lastWorkspaceUseAt: DateTime.formatIso(now) }, record);
      yield* h.service.sweep;
      expect((yield* h.registry.list)[0]!.summary.state).toBe("active");
      const used = (yield* h.registry.list)[0]!;
      yield* h.registry.put({ ...used, lastWorkspaceUseAt: DateTime.formatIso(at) }, used);
      yield* h.service.sweep;
      expect((yield* h.registry.list)[0]!.summary.state).toBe("suspended");
      expect(h.threads.get(firstId)?.worktreeSuspension?.state).toBe("suspended");
      expect(h.threads.get(secondId)?.worktreeSuspension?.state).toBe("suspended");
    }),
  ),
);

it.live(
  "automatically saves retained source after an oversized dependency install is removed",
  () =>
    realGit((f) =>
      Effect.gen(function* () {
        const h = yield* harness(f, { cleanupThreads: true, settings: automaticSettings });
        untouchedOwners(h.threads);
        const dependencyPath = NodePath.join(f.workspace, "node_modules");
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(dependencyPath);
          await using large = await NodeFSP.open(
            NodePath.join(dependencyPath, "large-binary"),
            "w",
          );
          await large.truncate(64 * 1024 * 1024 + 1);
        });
        yield* h.service.previewSuspend({ threadId: firstId });
        const initial = (yield* h.registry.list)[0]!;
        yield* h.registry.put({ ...initial, lastWorkspaceUseAt: DateTime.formatIso(at) }, initial);
        yield* h.service.sweep;
        const failed = (yield* h.registry.list)[0]!;
        expect(failed.summary.state).toBe("active");
        expect(failed.operation).toBeUndefined();
        expect(failed.captureFailure?.reason).toContain("a file exceeds the preservation limit");
        expect(failed.captureFailure?.retryOnce).toBeUndefined();
        const journals = yield* Effect.promise(() =>
          NodeFSP.readdir(NodePath.join(h.registry.root, "snapshots")),
        );
        yield* h.service.sweep;
        expect(
          yield* Effect.promise(() => NodeFSP.readdir(NodePath.join(h.registry.root, "snapshots"))),
        ).toEqual(journals);
        // The cleanup integration proves removal eligibility separately; this
        // service test verifies the resulting automatic save and recovery.
        yield* withWorkspaceLease(
          f.workspace,
          Effect.gen(function* () {
            yield* Effect.promise(() => NodeFSP.rm(dependencyPath, { recursive: true }));
            yield* h.registry.dependenciesRemoved(f.workspace);
          }),
        );
        expect((yield* h.registry.list)[0]).toEqual({
          ...failed,
          captureFailure: { ...failed.captureFailure!, retryOnce: true },
        });
        expect(yield* h.registry.automaticProtection(f.workspace)).not.toBeNull();
        yield* h.service.sweep;
        const saved = (yield* h.registry.list)[0]!;
        expect(saved.summary.state).toBe("suspended");
        expect(saved.operation).toBeUndefined();
        expect(saved.captureFailure).toBeUndefined();
        expect(
          (yield* Effect.promise(() => h.store.readJournal(saved.summary.snapshotId!))).phase,
        ).toBe("suspended");
        expect(
          yield* Effect.promise(() =>
            NodeFSP.stat(f.workspace).then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false);
        yield* h.acquisition.acquire({
          path: f.workspace,
          purpose: "file-write",
          threadId: firstId,
        });
        yield* Effect.promise(async () => {
          expect(await NodeFSP.readFile(NodePath.join(f.workspace, "tracked"), "utf8")).toBe(
            "working\n",
          );
          expect(await git(f.workspace, "show", ":tracked")).toBe("staged");
          expect(
            await NodeFSP.readFile(NodePath.join(f.workspace, "notes", "private"), "utf8"),
          ).toBe("ignored note\n");
        });
      }),
    ),
);

it.live.each(["manual", "activity"] as const)(
  "settles unsupported captures and allows %s retry after restart",
  (retry) =>
    realGit((f) =>
      Effect.gen(function* () {
        const h = yield* harness(f, { cleanupThreads: true, settings: automaticSettings });
        untouchedOwners(h.threads);
        yield* h.service.previewSuspend({ threadId: firstId });
        const initial = (yield* h.registry.list)[0]!;
        yield* h.registry.put({ ...initial, lastWorkspaceUseAt: DateTime.formatIso(at) }, initial);
        // Internal groups are supported; an outside alias must still block capture.
        yield* Effect.promise(() =>
          NodeFSP.link(
            NodePath.join(f.workspace, "tracked"),
            NodePath.join(f.root, "external-hardlink"),
          ),
        );
        yield* h.service.sweep;
        const stopped = (yield* h.registry.list)[0]!;
        expect(stopped.summary.state).toBe("active");
        expect(stopped.operation).toBeUndefined();
        expect(stopped.blockedReason).toContain("hardlinked");
        const journals = yield* Effect.promise(() =>
          NodeFSP.readdir(NodePath.join(h.registry.root, "snapshots")),
        );
        expect(journals).toHaveLength(1);
        expect((yield* Effect.promise(() => h.store.readJournal(journals[0]!))).phase).toBe(
          "capture-cancelled",
        );
        yield* h.service.sweep;
        // A new service decodes the persisted catalog; the retry veto must survive it.
        const restarted = yield* harness(f, { cleanupThreads: true, settings: automaticSettings });
        for (const [id, thread] of h.threads) restarted.threads.set(id, thread);
        yield* restarted.service.sweep;
        expect(
          yield* Effect.promise(() => NodeFSP.readdir(NodePath.join(h.registry.root, "snapshots"))),
        ).toEqual(journals);
        yield* Effect.promise(() => NodeFSP.unlink(NodePath.join(f.root, "external-hardlink")));
        if (retry === "activity") {
          yield* restarted.acquisition.acquire({
            path: f.workspace,
            purpose: "git",
            threadId: firstId,
          });
          expect((yield* restarted.registry.list)[0]!.captureFailure).toBeDefined();
          yield* restarted.acquisition.acquire({
            path: f.workspace,
            purpose: "editor",
            threadId: firstId,
          });
          const used = (yield* restarted.registry.list)[0]!;
          expect(used.captureFailure?.retryOnce).toBe(true);
          expect(yield* restarted.registry.automaticProtection(f.workspace)).not.toBeNull();
          // Once the normal inactivity period elapses, positive use permits a new attempt.
          yield* restarted.registry.put(
            { ...used, lastWorkspaceUseAt: DateTime.formatIso(at) },
            used,
          );
          yield* restarted.service.sweep;
        } else {
          yield* restarted.suspend;
        }
        const saved = (yield* restarted.registry.list)[0]!;
        expect(saved.summary.state).toBe("suspended");
        expect(saved.blockedReason).toBeNull();
      }),
    ),
);

it.live.each([
  "empty",
  "legacy-empty",
  "empty-retry-allowed",
  "missing",
  "nonempty",
  "file",
  "symlink",
  "dangling-symlink",
  "permissive",
  "known-receipt",
  "changed-source",
  "changed-git",
  "changed-owner",
] as const)("reconciles only verified empty journal-less capture failures: %s", (kind) =>
  realGit((f) =>
    Effect.gen(function* () {
      const h = yield* harness(f, { cleanupThreads: true, settings: automaticSettings });
      untouchedOwners(h.threads);
      yield* h.service.previewSuspend({ threadId: firstId });
      const initial = (yield* h.registry.list)[0]!;
      const id = "536a52d2-212a-4d5a-9ae2-121a331448e5";
      const directory = NodePath.join(h.registry.root, "snapshots", id);
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.dirname(directory), { recursive: true, mode: 0o700 });
        if (kind === "symlink" || kind === "dangling-symlink") {
          const elsewhere = NodePath.join(f.root, "redirected");
          if (kind === "symlink") await NodeFSP.mkdir(elsewhere, { mode: 0o700 });
          await NodeFSP.symlink(elsewhere, directory);
        } else if (kind === "file") {
          await NodeFSP.writeFile(directory, "unrelated file", { mode: 0o600 });
        } else if (kind !== "missing") {
          await NodeFSP.mkdir(directory, { mode: 0o700 });
          if (kind === "nonempty")
            await NodeFSP.writeFile(NodePath.join(directory, "unrelated-note"), "retain me");
          if (kind === "permissive") await NodeFSP.chmod(directory, 0o770);
        }
        if (kind === "changed-source") {
          await NodeFSP.rename(f.workspace, `${f.workspace}-original`);
          await NodeFSP.mkdir(f.workspace);
          await NodeFSP.copyFile(
            NodePath.join(`${f.workspace}-original`, ".git"),
            NodePath.join(f.workspace, ".git"),
          );
        }
        if (kind === "changed-git") {
          const other = NodePath.join(f.root, "other-workspace");
          await git(f.repository, "worktree", "add", "-b", "other", other, "HEAD");
          await NodeFSP.copyFile(NodePath.join(other, ".git"), NodePath.join(f.workspace, ".git"));
        }
      });
      const summary = {
        ...initial.summary,
        state: "capturing" as const,
        snapshotId: id,
        generation: initial.summary.generation + 1,
      };
      const reason = "Workspace kept: the snapshot identity already exists.";
      const interrupted = {
        ...initial,
        summary,
        owners: initial.owners.map((owner) => ({ ...owner, generation: summary.generation })),
        operation: {
          id,
          kind: "capture" as const,
          snapshotIds: [id],
          manual: true,
          acceptedAt: DateTime.formatIso(at),
        },
        ...(kind === "known-receipt" ? { history: [id] } : {}),
        ...(kind === "legacy-empty"
          ? {}
          : {
              captureFailure: {
                operationId: id,
                reason,
                ...(kind === "empty-retry-allowed" ? { retryOnce: true as const } : {}),
              },
            }),
        blockedReason: reason,
      };
      yield* h.registry.put(interrupted, initial);
      for (const [key, thread] of h.threads)
        h.threads.set(key, {
          ...thread,
          worktreeSuspension: summary,
          ...(kind === "changed-owner" && key === firstId ? { worktreePath: f.repository } : {}),
        });
      yield* h.service.sweep;
      const recovered = (yield* h.registry.list)[0]!;
      if (!["empty", "legacy-empty", "empty-retry-allowed", "missing"].includes(kind)) {
        expect(recovered.summary.state).toBe("capturing");
        expect(recovered.operation?.id).toBe(id);
        expect(yield* Effect.promise(() => NodeFSP.lstat(directory))).toBeDefined();
        const catalogPath = NodePath.join(h.registry.root, "authority.json");
        const before = yield* Effect.promise(() => NodeFSP.readFile(catalogPath));
        yield* h.service.sweep;
        expect(yield* Effect.promise(() => NodeFSP.readFile(catalogPath))).toEqual(before);
        return;
      }
      expect(recovered.summary.state).toBe("active");
      expect(recovered.summary.snapshotId).toBeNull();
      expect(recovered.operation).toBeUndefined();
      expect(recovered.captureFailure?.operationId).toBe(id);
      expect(recovered.captureFailure?.retryOnce).toBeUndefined();
      expect(yield* h.registry.automaticProtection(f.workspace)).not.toBeNull();
      yield* Effect.promise(async () => {
        if (kind !== "missing") expect(await NodeFSP.readdir(directory)).toEqual([]);
        expect(await NodeFSP.readFile(NodePath.join(f.workspace, "tracked"), "utf8")).toBe(
          "working\n",
        );
        expect(await git(f.workspace, "show", ":tracked")).toBe("staged");
      });
      const catalogPath = NodePath.join(h.registry.root, "authority.json");
      const before = yield* Effect.promise(() => NodeFSP.readFile(catalogPath));
      yield* h.service.sweep;
      yield* h.service.sweep;
      expect(yield* Effect.promise(() => NodeFSP.readFile(catalogPath))).toEqual(before);
      expect(
        yield* h.acquisition.acquire({ path: f.workspace, purpose: "git", threadId: firstId }),
      ).toMatchObject({ restored: false });
      yield* Queue.takeAll(h.updates);
      const saved = yield* h.suspend;
      expect(saved.summary.state).toBe("suspended");
      expect(saved.summary.snapshotId).not.toBe(id);
      expect(saved.captureFailure).toBeUndefined();
      if (kind !== "missing")
        expect(yield* Effect.promise(() => NodeFSP.readdir(directory))).toEqual([]);
    }),
  ),
);

it.live("allows its own automatic eligibility cancellation to resume after policy admission", () =>
  realGit((f) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const h = yield* harness(f, {
        cleanupThreads: true,
        settings: automaticSettings,
        pauseCaptureIntent: { entered, release },
      });
      untouchedOwners(h.threads);
      const sweep = yield* h.service.sweep.pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      h.threads.set(firstId, { ...h.threads.get(firstId)!, workspaceUserAdopted: true });
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(sweep);
      const cancelled = (yield* h.registry.list)[0]!;
      expect(cancelled.summary.state).toBe("active");
      expect(cancelled.operation).toBeUndefined();
      expect(cancelled.captureFailure?.retryOnce).toBe(true);
      expect(cancelled.blockedReason).not.toContain("Finish the current workspace operation");
      expect(
        yield* Effect.promise(() =>
          h.store.inspectUnstartedCapture(cancelled.captureFailure!.operationId),
        ),
      ).toBe("missing");
      h.threads.set(firstId, { ...h.threads.get(firstId)!, workspaceUserAdopted: false });
      yield* h.service.sweep;
      const saved = (yield* h.registry.list)[0]!;
      expect(saved.summary.state).toBe("suspended");
      expect(saved.captureFailure).toBeUndefined();
      expect(saved.summary.snapshotId).not.toBe(cancelled.captureFailure!.operationId);
    }),
  ),
);

it.live("retains a queued capture until its failed job can settle an empty directory", () =>
  realGit((f) =>
    Effect.gen(function* () {
      const h = yield* harness(f);
      const operation = yield* withWorkspaceLease(
        f.workspace,
        Effect.gen(function* () {
          const preview = yield* h.service.previewSuspend({ threadId: firstId });
          const accepted = yield* h.service.suspend({
            threadId: firstId,
            previewToken: preview.token,
          });
          const listed = yield* h.service.list({});
          expect(listed.entries.some((entry) => entry.snapshotId === accepted.operationId)).toBe(
            true,
          );
          const directory = NodePath.join(h.registry.root, "snapshots", accepted.operationId);
          yield* Effect.promise(async () => {
            await expect(NodeFSP.lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
            await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
          });
          expect(
            (yield* h.service.previewSuspend({ threadId: firstId }).pipe(Effect.flip)).reason,
          ).toBe("busy");
          expect((yield* h.registry.list)[0]!.operation?.id).toBe(accepted.operationId);
          return accepted;
        }),
      );
      const failed = yield* Stream.fromQueue(h.updates).pipe(
        Stream.filter(
          (record) =>
            record.checkoutId === operation.checkoutId &&
            record.captureFailure?.operationId === operation.operationId,
        ),
        Stream.take(1),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
      expect(failed.captureFailure?.reason).toContain("snapshot identity already exists");
      expect(
        yield* h.acquisition.acquire({ path: f.workspace, purpose: "git", threadId: firstId }),
      ).toMatchObject({ restored: false });
      const settled = (yield* h.registry.list)[0]!;
      expect(settled.operation).toBeUndefined();
      expect(settled.summary.state).toBe("active");
      expect(settled.captureFailure?.operationId).toBe(operation.operationId);
      expect(settled.captureFailure?.retryOnce).toBeUndefined();
    }),
  ),
);

it.live.each([false, true])(
  "admits one protected retry for legacy incomplete captures (repaired: %s)",
  (repaired) =>
    realGit((f) =>
      Effect.gen(function* () {
        const h = yield* harness(f, { cleanupThreads: true, settings: automaticSettings });
        untouchedOwners(h.threads);
        yield* h.service.previewSuspend({ threadId: firstId });
        const initial = (yield* h.registry.list)[0]!;
        const id = "30d188de-7851-4d2b-b3e9-ac622221cd26";
        yield* Effect.promise(() =>
          NodeFSP.link(
            NodePath.join(f.workspace, "tracked"),
            NodePath.join(f.root, "external-hardlink"),
          ),
        );
        const result = yield* Effect.tryPromise({
          try: () =>
            h.store.capture({
              sourcePath: f.workspace,
              snapshotId: id,
              operationId: id,
              ownerBinding: initial.checkoutId,
            }),
          catch: (cause) => new Cause.UnknownError(cause, "An error occurred in Effect.tryPromise"),
        }).pipe(Effect.exit);
        expect(result._tag).toBe("Failure");
        const summary = {
          ...initial.summary,
          state: "capturing" as const,
          snapshotId: id,
          generation: initial.summary.generation + 1,
        };
        const interrupted = {
          ...initial,
          summary,
          owners: initial.owners.map((owner) => ({ ...owner, generation: summary.generation })),
          lastWorkspaceUseAt: DateTime.formatIso(at),
          operation: {
            id,
            kind: "capture" as const,
            snapshotIds: [id],
            manual: false,
            acceptedAt: DateTime.formatIso(at),
          },
          blockedReason: "Interrupted capture",
        };
        yield* h.registry.put(interrupted, initial);
        for (const [key, thread] of h.threads)
          h.threads.set(key, { ...thread, worktreeSuspension: summary });
        yield* h.service.sweep;
        const recovered = (yield* h.registry.list)[0]!;
        expect(recovered.summary.state).toBe("active");
        expect(recovered.operation).toBeUndefined();
        expect(recovered.captureFailure?.operationId).toBe(id);
        expect((yield* Effect.promise(() => h.store.readJournal(id))).phase).toBe(
          "capture-cancelled",
        );
        expect(recovered.captureFailure?.retryOnce).toBe(true);
        expect(yield* h.registry.automaticProtection(f.workspace)).not.toBeNull();
        if (repaired)
          yield* Effect.promise(() => NodeFSP.unlink(NodePath.join(f.root, "external-hardlink")));
        yield* h.service.sweep;
        const retried = (yield* h.registry.list)[0]!;
        expect(retried.summary.state).toBe(repaired ? "suspended" : "active");
        expect(retried.captureFailure?.retryOnce).toBeUndefined();
        if (repaired) expect(retried.captureFailure).toBeUndefined();
        else expect(retried.captureFailure?.operationId).not.toBe(id);
        const directories = yield* Effect.promise(() =>
          NodeFSP.readdir(NodePath.join(h.registry.root, "snapshots")),
        );
        expect(directories).toHaveLength(2);
        expect(directories).toContain(id);
        yield* h.service.sweep;
        expect(
          yield* Effect.promise(() => NodeFSP.readdir(NodePath.join(h.registry.root, "snapshots"))),
        ).toEqual(directories);
      }),
    ),
);

it.live(
  "retains a verified snapshot when a consumer appears after capture and allows manual retry",
  () =>
    realGit((f) =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const processPaths: string[] = [];
        const h = yield* harness(f, {
          cleanupThreads: true,
          settings: automaticSettings,
          pauseCaptured: { entered, release },
        });
        untouchedOwners(h.threads);
        yield* h.service.previewSuspend({ threadId: firstId });
        const initial = (yield* h.registry.list)[0]!;
        yield* h.registry.put({ ...initial, lastWorkspaceUseAt: DateTime.formatIso(at) }, initial);
        const pass = yield* Effect.forkChild(
          h.service.sweep.pipe(
            Effect.provideService(
              Consumers.ProcessPaths,
              Effect.sync(() => [...processPaths]),
            ),
          ),
        );
        yield* Deferred.await(entered);
        processPaths.push(NodePath.join(f.workspace, "tracked"));
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(pass);
        const retained = (yield* h.registry.list)[0]!;
        expect(retained.summary.state).toBe("active");
        expect(retained.operation).toBeUndefined();
        expect(retained.captureFailure).toBeDefined();
        expect(retained.history).toHaveLength(1);
        expect((yield* Effect.promise(() => h.store.readJournal(retained.history[0]!))).phase).toBe(
          "active",
        );
        expect(
          yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(f.workspace, "tracked"), "utf8"),
          ),
        ).toBe("working\n");
        yield* h.service.sweep;
        expect((yield* h.registry.list)[0]!.history).toEqual(retained.history);
        processPaths.length = 0;
        yield* Queue.clear(h.updates);
        const saved = yield* h.suspend;
        expect(saved.history).toHaveLength(2);
        expect(saved.captureFailure).toBeUndefined();
      }),
    ),
);

it.live("automatically releases eligible owners' previews before saving their workspace", () =>
  realGit((f) =>
    Effect.gen(function* () {
      const h = yield* harness(f, {
        cleanupThreads: true,
        settings: automaticSettings,
        previews: [{ threadId: firstId, workspacePath: f.workspace }],
        terminals: [
          {
            threadId: firstId,
            terminalId: `preview-${firstId}`,
            cwd: f.workspace,
            worktreePath: f.workspace,
            status: "running",
            pid: 100,
            exitCode: null,
            exitSignal: null,
            hasRunningSubprocess: true,
            label: "preview",
            updatedAt: DateTime.formatIso(at),
          },
        ],
      });
      untouchedOwners(h.threads);
      yield* h.service.sweep;
      expect(h.previewLeases).toEqual([]);
      expect((yield* h.registry.list)[0]!.summary.state).toBe("suspended");
    }),
  ),
);

it.live("keeps previews when a shared owner is ineligible for automatic suspension", () =>
  realGit((f) =>
    Effect.gen(function* () {
      const h = yield* harness(f, {
        cleanupThreads: true,
        settings: automaticSettings,
        previews: [{ threadId: firstId, workspacePath: f.workspace }],
      });
      untouchedOwners(h.threads);
      h.threads.set(secondId, {
        ...h.threads.get(secondId)!,
        createdBy: "user",
        workspaceUserAdopted: true,
      });
      yield* h.service.sweep;
      expect(h.previewLeases).toHaveLength(1);
      expect(h.previewReleases).toEqual([]);
    }),
  ),
);

it.live("keeps previews when historical workspace ownership prevents suspension", () =>
  realGit((f) =>
    Effect.gen(function* () {
      const h = yield* harness(f, {
        cleanupThreads: true,
        settings: automaticSettings,
        historicalOwners: [
          { threadId: "fixture:former", projectId, worktreePath: f.workspace, branch: "former" },
        ],
        previews: [{ threadId: firstId, workspacePath: f.workspace }],
      });
      untouchedOwners(h.threads);
      yield* h.service.sweep;
      expect(h.previewLeases).toHaveLength(1);
      expect(h.previewReleases).toEqual([]);
    }),
  ),
);

it.live("keeps previews while an unrelated terminal uses the workspace", () =>
  realGit((f) =>
    Effect.gen(function* () {
      const h = yield* harness(f, {
        cleanupThreads: true,
        settings: automaticSettings,
        previews: [{ threadId: firstId, workspacePath: f.workspace }],
        terminals: [
          {
            threadId: firstId,
            terminalId: "ordinary-terminal",
            cwd: f.workspace,
            worktreePath: f.workspace,
            status: "running",
            pid: 100,
            exitCode: null,
            exitSignal: null,
            hasRunningSubprocess: true,
            label: "ordinary-terminal",
            updatedAt: DateTime.formatIso(at),
          },
        ],
      });
      untouchedOwners(h.threads);
      yield* h.service.sweep;
      expect(h.previewLeases).toHaveLength(1);
      expect(h.previewReleases).toEqual([]);
    }),
  ),
);

it.live("does not release an unrelated owner's preview of an eligible workspace", () =>
  realGit((f) =>
    Effect.gen(function* () {
      const h = yield* harness(f, {
        cleanupThreads: true,
        settings: automaticSettings,
        previews: [
          { threadId: firstId, workspacePath: f.workspace },
          { threadId: "fixture:other", workspacePath: f.workspace },
        ],
      });
      untouchedOwners(h.threads);
      yield* h.service.sweep;
      expect(h.previewLeases).toHaveLength(2);
      expect(h.previewReleases).toEqual([]);
      expect(h.previewReleases).not.toContain("fixture:other");
      expect((yield* h.registry.list)[0]!.summary.state).toBe("active");
    }),
  ),
);

it.live(
  "keeps an owner preview when another thread reserves the workspace after the first scan",
  () =>
    realGit((f) =>
      Effect.gen(function* () {
        let added = false;
        const h = yield* harness(f, {
          cleanupThreads: true,
          settings: automaticSettings,
          previews: [{ threadId: firstId, workspacePath: f.workspace }],
          onPreviewScan: (leases) => {
            if (added) return;
            added = true;
            leases.push({ threadId: "fixture:other", workspacePath: f.workspace });
          },
        });
        untouchedOwners(h.threads);
        yield* h.service.sweep;
        expect(h.previewLeases).toHaveLength(2);
        expect(h.previewReleases).toEqual([]);
      }),
    ),
);

it.live("keeps a preview when workspace use occurs before cancellation is locked", () =>
  realGit((f) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const h = yield* harness(f, {
        cleanupThreads: true,
        settings: automaticSettings,
        previews: [{ threadId: firstId, workspacePath: f.workspace }],
        pausePreviewLocks: { entered, release },
      });
      untouchedOwners(h.threads);
      const sweep = yield* Effect.forkChild(h.service.sweep);
      yield* Deferred.await(entered);
      yield* h.acquisition.acquire({ path: f.workspace, purpose: "file-write" });
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(sweep);
      expect(h.previewLeases).toHaveLength(1);
      expect(h.previewReleases).toEqual([]);
      expect((yield* h.registry.list)[0]!.summary.state).toBe("active");
    }),
  ),
);

it.live("keeps previews when process inventory is unavailable", () =>
  realGit((f) =>
    Effect.gen(function* () {
      const h = yield* harness(f, {
        cleanupThreads: true,
        settings: automaticSettings,
        previews: [{ threadId: firstId, workspacePath: f.workspace }],
      });
      untouchedOwners(h.threads);
      yield* h.service.sweep.pipe(
        Effect.provideService(Consumers.ProcessPaths, Effect.succeed(null)),
      );
      expect(h.previewLeases).toHaveLength(1);
      expect(h.previewReleases).toEqual([]);
    }),
  ),
);

it.live.each(["root", "nested"] as const)(
  "serializes a %s project claim with preview removal",
  (location) =>
    realGit((f) =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const projectRoot =
          location === "root" ? f.workspace : NodePath.join(f.workspace, "nested");
        if (location === "nested") yield* Effect.promise(() => NodeFSP.mkdir(projectRoot));
        const h = yield* harness(f, {
          cleanupThreads: true,
          settings: automaticSettings,
          previews: [{ threadId: firstId, workspacePath: f.workspace }],
          pausePreviewRemoval: { entered, release },
        });
        untouchedOwners(h.threads);
        const pass = yield* Effect.forkChild(h.service.sweep);
        yield* Deferred.await(entered);
        let registered = false;
        const scope = yield* Effect.scope;
        const claim = yield* Effect.forkIn(
          withProjectRootLease(
            Effect.sync(() => {
              h.registerProjectRoot(projectRoot);
              registered = true;
            }),
          ),
          scope,
          { startImmediately: true },
        );
        const registeredDuringRemoval = registered;
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(claim);
        yield* Fiber.join(pass);
        expect(registeredDuringRemoval).toBe(false);
        expect(registered).toBe(true);
        expect(
          yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(f.workspace, "tracked"), "utf8"),
          ),
        ).toBe("working\n");
      }),
    ),
);

it.live("releases an eligible preview while retaining a checkout used by another process", () =>
  realGit((f) =>
    Effect.gen(function* () {
      const h = yield* harness(f, {
        cleanupThreads: true,
        settings: automaticSettings,
        previews: [{ threadId: firstId, workspacePath: f.workspace }],
      });
      untouchedOwners(h.threads);
      yield* h.service.sweep.pipe(
        Effect.provideService(
          Consumers.ProcessPaths,
          Effect.succeed([NodePath.join(f.workspace, "tracked")]),
        ),
      );
      expect(h.previewLeases).toEqual([]);
      const current = (yield* h.registry.list)[0]!;
      expect(current.summary.state).toBe("active");
      expect(current.operation).toBeUndefined();
      expect(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(f.workspace, "tracked"), "utf8"),
        ),
      ).toBe("working\n");
    }),
  ),
);

it.live.each([false, true])(
  "releases an eligible preview before checking its runtime descriptor, still active=%s",
  (stillActive) =>
    realGit((f) =>
      Effect.gen(function* () {
        const h = yield* harness(f, {
          cleanupThreads: true,
          settings: automaticSettings,
          previews: [{ threadId: firstId, workspacePath: f.workspace }],
        });
        const directory = NodePath.join(f.workspace, ".t3", "dev");
        const descriptor = NodePath.join(directory, "server-runtime.json");
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(directory, { recursive: true });
          await NodeFSP.writeFile(
            descriptor,
            JSON.stringify({
              version: 1,
              pid: process.pid,
              port: 1234,
              origin: "http://workstation.example",
              startedAt: "2026-01-01T00:00:00Z",
            }),
          );
        });
        if (!stillActive) h.onPreviewRelease(() => NodeFS.unlinkSync(descriptor));
        untouchedOwners(h.threads);
        yield* h.service.sweep;
        expect(h.previewLeases).toEqual([]);
        expect((yield* h.registry.list)[0]!.summary.state).toBe(
          stillActive ? "active" : "suspended",
        );
      }),
    ),
);

it.live("stops releasing previews when an owner becomes active during cleanup", () =>
  realGit((f) =>
    Effect.gen(function* () {
      const h = yield* harness(f, {
        cleanupThreads: true,
        settings: automaticSettings,
        previews: [
          { threadId: firstId, workspacePath: f.workspace },
          { threadId: secondId, workspacePath: f.workspace },
        ],
      });
      untouchedOwners(h.threads);
      h.onPreviewRelease((threadId) => {
        if (threadId === firstId)
          h.threads.set(secondId, {
            ...h.threads.get(secondId)!,
            activeRunId: RunId.make("fixture:run"),
          });
      });
      yield* h.service.sweep;
      expect(h.previewLeases.map((lease) => lease.threadId)).toEqual([secondId]);
      expect((yield* h.registry.list)[0]!.summary.state).toBe("active");
    }),
  ),
);

it.live.each(["original", "isolated"] as const)(
  "retains interrupted isolation when a project claims the %s path",
  (claim) =>
    realGit((f) =>
      Effect.gen(function* () {
        const h = yield* harness(f);
        yield* h.service.previewSuspend({ threadId: firstId });
        const initial = (yield* h.registry.list)[0]!;
        const id = "30d188de-7851-4d2b-b3e9-ac622221cd26";
        yield* Effect.promise(() =>
          h.store.capture({
            sourcePath: f.workspace,
            snapshotId: id,
            operationId: id,
            ownerBinding: initial.checkoutId,
          }),
        );
        yield* Effect.promise(() => h.store.trialRestore(id));
        const journal = yield* Effect.promise(() =>
          h.store.isolate(id, { quarantineParent: NodePath.join(f.root, "quarantine") }),
        );
        const isolated = journal.isolatedPath!;
        const summary = {
          ...initial.summary,
          state: "capturing" as const,
          snapshotId: id,
          generation: initial.summary.generation + 1,
        };
        yield* h.registry.put(
          {
            ...initial,
            summary,
            owners: initial.owners.map((owner) => ({ ...owner, generation: summary.generation })),
            operation: {
              id,
              kind: "capture" as const,
              snapshotIds: [id],
              manual: true,
              acceptedAt: DateTime.formatIso(at),
            },
          },
          initial,
        );
        for (const [key, thread] of h.threads)
          h.threads.set(key, { ...thread, worktreeSuspension: summary });
        h.registerProjectRoot(claim === "original" ? f.workspace : isolated);
        yield* h.service.sweep;
        expect((yield* h.registry.list)[0]!.operation?.id).toBe(id);
        expect((yield* Effect.promise(() => h.store.readJournal(id))).phase).toBe("isolated");
        expect(
          yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(isolated, "tracked"), "utf8")),
        ).toBe("working\n");
      }),
    ),
);

it.live.each([
  "before admission",
  "after capture",
  "after isolation",
  "after isolation via alias",
  "after isolation via leaf link",
] as const)("keeps a newly registered project root %s", (registration) =>
  realGit((f) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const h = yield* harness(f, {
        cleanupThreads: true,
        settings: automaticSettings,
        pauseCaptured: { entered, release },
      });
      untouchedOwners(h.threads);
      for (const [id, owner] of h.threads)
        h.threads.set(id, { ...owner, archivedAt: at, settledAt: null });
      yield* h.service.previewSuspend({ threadId: firstId });
      if (registration === "before admission") h.registerProjectRoot(f.workspace);
      if (registration === "after isolation") h.registerProjectWhenIsolated(f.workspace);
      if (registration === "after isolation via alias") {
        const alias = NodePath.join(f.root, "project-alias");
        yield* Effect.promise(() => NodeFSP.symlink(NodePath.dirname(f.workspace), alias));
        h.registerProjectWhenIsolated(NodePath.join(alias, NodePath.basename(f.workspace)));
      }
      if (registration === "after isolation via leaf link") {
        const alias = NodePath.join(f.root, "project-link");
        yield* Effect.promise(() => NodeFSP.symlink(f.workspace, alias));
        h.registerProjectWhenIsolated(alias);
      }
      const pass = yield* Effect.forkChild(h.service.sweep);
      if (registration === "after capture") {
        yield* Deferred.await(entered);
        h.registerProjectRoot(f.workspace);
      }
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(pass);
      const retained = (yield* h.registry.list)[0]!;
      if (registration.startsWith("after isolation")) {
        expect(retained.summary.state).toBe("capturing");
        const journal = yield* Effect.promise(() =>
          h.store.readJournal(retained.operation!.snapshotIds[0]!),
        );
        expect(journal.phase).toBe("isolated");
        expect(
          yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(journal.isolatedPath!, "tracked"), "utf8"),
          ),
        ).toBe("working\n");
        return;
      }
      expect(retained.summary.state).toBe("active");
      expect(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(f.workspace, "tracked"), "utf8"),
        ),
      ).toBe("working\n");
    }),
  ),
);

it.live("does not capture files after their checkout becomes a project root", () =>
  realGit((f) =>
    Effect.gen(function* () {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let paused = false;
      let captureFinished = false;
      const h = yield* harness(f, {
        onStoreBoundary: async (phase) => {
          if (phase === "capturing" && !paused) {
            paused = true;
            entered.resolve();
            await release.promise;
          }
          if (phase === "verifying") captureFinished = true;
        },
      });
      const preview = yield* h.service.previewSuspend({ threadId: firstId });
      yield* Queue.clear(h.updates);
      yield* h.service.suspend({ threadId: firstId, previewToken: preview.token });
      yield* Effect.promise(() => entered.promise);
      const attempted = yield* Deferred.make<void>();
      let registeredDuringCapture = false;
      const registration = yield* Deferred.succeed(attempted, undefined).pipe(
        Effect.andThen(
          withProjectRootLease(
            Effect.sync(() => {
              registeredDuringCapture = !captureFinished;
              h.registerProjectRoot(f.workspace);
            }),
          ),
        ),
        Effect.forkChild,
      );
      yield* Deferred.await(attempted);
      release.resolve();
      yield* Fiber.join(registration);
      expect(registeredDuringCapture).toBe(false);
      expect(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(f.workspace, "tracked"), "utf8"),
        ),
      ).toBe("working\n");
    }),
  ),
);

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

it.live.each(["current", "historical"] as const)(
  "prevents project registration while a %s restore is being materialized",
  (kind) =>
    realGit((f) =>
      Effect.gen(function* () {
        const staging = Promise.withResolvers<string>();
        const release = Promise.withResolvers<void>();
        let h!: Effect.Success<ReturnType<typeof harness>>;
        let paused = false;
        let armed = false;
        h = yield* harness(f, {
          onStoreBoundary: async (phase, id) => {
            if (phase !== "restoring" || paused || !armed) return;
            const journal = await h.store.readJournal(id);
            if (journal.restoreIdentity === undefined || journal.restorePath === undefined) return;
            paused = true;
            staging.resolve(journal.restorePath);
            await release.promise;
          },
        });
        const saved = yield* h.suspend;
        const destination =
          kind === "current"
            ? f.workspace
            : NodePath.join(NodePath.dirname(f.workspace), "historical");
        if (kind === "historical")
          yield* h.acquisition.acquire({
            path: f.workspace,
            purpose: "file-write",
            threadId: firstId,
          });
        yield* Queue.clear(h.updates);
        armed = true;
        yield* h.service.restore({
          checkoutId: saved.checkoutId,
          snapshotId: saved.summary.snapshotId!,
          destinationPath: destination,
          ...(kind === "historical" ? { projectId } : {}),
        });
        const stagingPath = yield* Effect.promise(() => staging.promise);
        const attempted = yield* Deferred.make<void>();
        let registered = false;
        const claim = yield* Deferred.succeed(attempted, undefined).pipe(
          Effect.andThen(
            withProjectRootLease(
              Effect.sync(() => {
                if (NodeFS.existsSync(stagingPath)) {
                  h.registerProjectRoot(stagingPath);
                  registered = true;
                }
              }),
            ),
          ),
          Effect.forkChild,
        );
        yield* Deferred.await(attempted);
        release.resolve();
        yield* Fiber.join(claim);
        expect(registered).toBe(false);
        const active = yield* h.awaitRecord(
          (record) =>
            (kind === "current"
              ? record.checkoutId === saved.checkoutId
              : record.sourceCheckoutId === saved.checkoutId) &&
            record.summary.state === "active" &&
            record.operation === undefined,
        );
        expect(active.path).toBe(destination);
      }),
    ),
);

it.live("retains a staged restore claimed by another project after interruption", () =>
  realGit((f) =>
    Effect.gen(function* () {
      const h = yield* harness(f);
      const saved = yield* h.suspend;
      const id = saved.summary.snapshotId!;
      const staged = yield* Effect.promise(() =>
        h.store.stageRestore(id, { destinationPath: f.workspace }),
      );
      const summary = { ...saved.summary, state: "restoring" as const };
      yield* h.registry.put(
        {
          ...saved,
          summary,
          operation: {
            id: "fixture:restore",
            kind: "restore",
            snapshotIds: [id],
            manual: true,
            acceptedAt: DateTime.formatIso(at),
            destinationPath: f.workspace,
          },
        },
        saved,
      );
      for (const [key, thread] of h.threads)
        h.threads.set(key, { ...thread, worktreeSuspension: summary });
      h.registerProjectRoot(staged.restorePath!);
      yield* h.service.sweep;
      expect((yield* h.registry.list)[0]!.operation?.kind).toBe("restore");
      expect((yield* Effect.promise(() => h.store.readJournal(id))).phase).toBe("restoring");
      expect(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(staged.restorePath!, "tracked"), "utf8"),
        ),
      ).toBe("working\n");
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

it.live.each(["active", "suspended"] as const)(
  "blocks ordinary acquisition when a published %s checkout loses its recovery catalog",
  (state) =>
    realGit((f) =>
      Effect.gen(function* () {
        const h = yield* harness(f, { settings: automaticSettings });
        const saved = yield* h.suspend;
        if (state === "active")
          yield* h.acquisition.acquire({ path: f.workspace, purpose: "file-write" });
        expect((yield* h.registry.list)[0]!.summary.state).toBe(state);
        yield* Effect.promise(() =>
          NodeFSP.unlink(NodePath.join(h.registry.root, "authority.json")),
        );
        for (const purpose of ["terminal", "editor", "file-write"] as const) {
          const refused = yield* h.acquisition
            .acquire({ path: f.workspace, purpose, threadId: firstId })
            .pipe(Effect.flip);
          expect(refused.reason).toBe("snapshot-unavailable");
        }
        yield* Effect.promise(async () => {
          expect((await h.store.readJournal(saved.summary.snapshotId!)).phase).toBe(
            state === "active" ? "active" : "suspended",
          );
          if (state === "active")
            expect(await NodeFSP.readFile(NodePath.join(f.workspace, "tracked"), "utf8")).toBe(
              "working\n",
            );
          else await expect(NodeFSP.lstat(f.workspace)).rejects.toMatchObject({ code: "ENOENT" });
        });
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

it.live("records workspace use while automatic suspension is disabled", () =>
  realGit((f) =>
    Effect.gen(function* () {
      const h = yield* harness(f, {
        cleanupThreads: true,
        settings: { ...automaticSettings, worktreeSuspension: { mode: "off" } },
      });
      untouchedOwners(h.threads);
      for (const [id, owner] of h.threads)
        h.threads.set(id, { ...owner, archivedAt: at, settledAt: null });
      yield* h.acquisition.acquire({ path: f.workspace, purpose: "editor", threadId: firstId });
      expect((yield* h.registry.list)[0]?.lastWorkspaceUseAt).toBeDefined();
      h.setSettings(automaticSettings);
      yield* h.service.sweep;
      expect((yield* h.registry.list)[0]!.summary.state).toBe("active");
    }),
  ),
);

it.live("allows workspace use while suspension is off when the checkout is a project root", () =>
  realGit((f) =>
    Effect.gen(function* () {
      const h = yield* harness(f, {
        settings: { ...automaticSettings, worktreeSuspension: { mode: "off" } },
      });
      h.registerProjectRoot(f.workspace);
      expect(
        yield* h.acquisition.acquire({ path: f.workspace, purpose: "editor", threadId: firstId }),
      ).toMatchObject({ path: f.workspace, restored: false });
    }),
  ),
);

it.live("allows workspace use while suspension is off if Git metadata is unavailable", () =>
  realGit((f) =>
    Effect.gen(function* () {
      const h = yield* harness(f, {
        settings: { ...automaticSettings, worktreeSuspension: { mode: "off" } },
      });
      yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(f.workspace, ".git"), "broken"));
      expect(
        yield* h.acquisition.acquire({ path: f.workspace, purpose: "editor", threadId: firstId }),
      ).toMatchObject({ path: f.workspace, restored: false });
    }),
  ),
);

it.live("remembers unverified workspace use across restart and later Git repair", () =>
  realGit((f) =>
    Effect.gen(function* () {
      const off = { ...automaticSettings, worktreeSuspension: { mode: "off" as const } };
      const h = yield* harness(f, { cleanupThreads: true, settings: off });
      untouchedOwners(h.threads);
      for (const [id, owner] of h.threads)
        h.threads.set(id, { ...owner, archivedAt: at, settledAt: null });
      const gitPointer = yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(f.workspace, ".git"), "utf8"),
      );
      yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(f.workspace, ".git"), "broken"));
      yield* h.acquisition.acquire({ path: f.workspace, purpose: "editor", threadId: firstId });
      expect(yield* h.registry.list).toEqual([]);
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(f.workspace, ".git"), gitPointer),
      );
      const restarted = yield* harness(f, { cleanupThreads: true, settings: automaticSettings });
      untouchedOwners(restarted.threads);
      for (const [id, owner] of restarted.threads)
        restarted.threads.set(id, { ...owner, archivedAt: at, settledAt: null });
      yield* restarted.service.sweep;
      const record = (yield* restarted.registry.list)[0]!;
      expect(record.summary.state).toBe("active");
      expect(record.lastWorkspaceUseAt).toBeDefined();
    }),
  ),
);

it.live("keeps one checkout record for simultaneous first workspace uses", () =>
  realGit((f) =>
    Effect.gen(function* () {
      const h = yield* harness(f, {
        settings: { ...automaticSettings, worktreeSuspension: { mode: "off" } },
      });
      yield* Effect.forEach(
        [firstId, secondId],
        (threadId) => h.acquisition.acquire({ path: f.workspace, purpose: "editor", threadId }),
        { concurrency: 2 },
      );
      const records = yield* h.registry.list;
      expect(records).toHaveLength(1);
      expect(records[0]!.lastWorkspaceUseAt).toBeDefined();
    }),
  ),
);

it.live("keeps recent use safe when first identification races an automatic sweep", () =>
  realGit((f) =>
    Effect.gen(function* () {
      const h = yield* harness(f, { cleanupThreads: true, settings: automaticSettings });
      untouchedOwners(h.threads);
      yield* Effect.all(
        [
          h.service.sweep,
          h.acquisition.acquire({ path: f.workspace, purpose: "editor", threadId: firstId }),
        ],
        { concurrency: 2 },
      );
      const records = yield* h.registry.list;
      expect(records).toHaveLength(1);
      expect(records[0]!.summary.state).toBe("active");
      expect(records[0]!.lastWorkspaceUseAt).toBeDefined();
      expect(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(f.workspace, "tracked"), "utf8"),
        ),
      ).toBe("working\n");
    }),
  ),
);

it.live("allows use of an active recorded checkout when Git metadata becomes unavailable", () =>
  realGit((f) =>
    Effect.gen(function* () {
      const h = yield* harness(f, {
        settings: { ...automaticSettings, worktreeSuspension: { mode: "off" } },
      });
      yield* h.acquisition.acquire({ path: f.workspace, purpose: "editor", threadId: firstId });
      yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(f.workspace, ".git"), "broken"));
      expect(
        yield* h.acquisition.acquire({ path: f.workspace, purpose: "editor", threadId: firstId }),
      ).toMatchObject({ path: f.workspace, branch: null, restored: false });
      expect((yield* h.registry.list)[0]!.lastWorkspaceUseAt).toBeDefined();
    }),
  ),
);

it.live.each(
  (["shallow", "merge", "rebase"] as const).flatMap((state) =>
    [false, true].map((registered) => ({ state, registered })),
  ),
)(
  "records ordinary workspace use during $state without allowing capture (registered: $registered)",
  ({ state, registered }) =>
    realGit((f) =>
      Effect.gen(function* () {
        const h = yield* harness(f, { cleanupThreads: true, settings: automaticSettings });
        untouchedOwners(h.threads);
        if (registered) yield* h.service.previewSuspend({ threadId: firstId });
        const original = yield* Effect.promise(async () => {
          const gitDirectory = await git(f.workspace, "rev-parse", "--absolute-git-dir");
          const head = await git(f.workspace, "rev-parse", "HEAD");
          const marker =
            state === "shallow"
              ? NodePath.join(f.repository, ".git", "shallow")
              : NodePath.join(gitDirectory, state === "merge" ? "MERGE_HEAD" : "rebase-merge");
          if (state === "rebase") {
            await NodeFSP.mkdir(marker);
            for (const [name, value] of Object.entries({
              "head-name": "refs/heads/topic",
              "orig-head": head,
              onto: head,
              msgnum: "1",
              end: "1",
            }))
              await NodeFSP.writeFile(NodePath.join(marker, name), `${value}\n`);
          } else await NodeFSP.writeFile(marker, `${head}\n`);
          if (state === "shallow")
            expect(await git(f.workspace, "rev-parse", "--is-shallow-repository")).toBe("true");
          else
            expect(await git(f.workspace, "status")).toContain(
              state === "merge" ? "still merging" : "currently rebasing",
            );
          return {
            marker,
            indexPath: NodePath.join(gitDirectory, "index"),
            index: await NodeFSP.readFile(NodePath.join(gitDirectory, "index")),
            tracked: await NodeFSP.readFile(NodePath.join(f.workspace, "tracked")),
            ignored: await NodeFSP.readFile(NodePath.join(f.workspace, "notes", "private")),
          };
        });
        for (const purpose of ["terminal", "editor", "file-write"] as const) {
          const before = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
          expect(
            yield* h.acquisition.acquire({ path: f.workspace, purpose, threadId: firstId }),
          ).toEqual({ path: f.workspace, branch: "topic", restored: false });
          const records = yield* h.registry.list;
          expect(records).toHaveLength(1);
          const record = records[0]!;
          expect(record.lastWorkspaceUseAt).toBeDefined();
          expect(record.lastWorkspaceUseAt! >= before).toBe(true);
          expect(record.summary.state).toBe("active");
          expect(record.summary.snapshotId).toBeNull();
          expect(record.history).toEqual([]);
          expect(record.operation).toBeUndefined();
          expect(record.pendingProjection).toBeUndefined();
          expect(record.blockedReason).toBeNull();
        }
        const refused = yield* h.service.previewSuspend({ threadId: firstId }).pipe(Effect.flip);
        expect(refused.reason).toBe("protected");
        expect(refused.message).toContain("unsupported");
        yield* Effect.promise(async () => {
          expect(await NodeFSP.readFile(original.indexPath)).toEqual(original.index);
          expect(await NodeFSP.readFile(NodePath.join(f.workspace, "tracked"))).toEqual(
            original.tracked,
          );
          expect(await NodeFSP.readFile(NodePath.join(f.workspace, "notes", "private"))).toEqual(
            original.ignored,
          );
          expect(await NodeFSP.stat(original.marker)).toBeDefined();
          await NodeFSP.rm(original.marker, { recursive: state === "rebase" });
        });
        expect((yield* h.service.previewSuspend({ threadId: firstId })).token).toBeTruthy();
        const used = (yield* h.registry.list)[0]!;
        const requests = h.gitRequests.length;
        yield* h.service.sweep;
        const retained = (yield* h.registry.list)[0]!;
        expect(retained.lastWorkspaceUseAt).toBe(used.lastWorkspaceUseAt);
        expect(retained.summary.state).toBe("active");
        expect(retained.operation).toBeUndefined();
        expect(retained.history).toEqual([]);
        expect(h.gitRequests).toHaveLength(requests);
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

it.live(
  "finishes every automatic candidate past inconsistent and missing checkouts in one pass",
  () =>
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
        const awaitSuspended = (entries: readonly Registry.CheckoutAuthority[]) =>
          Stream.fromQueue(h.updates).pipe(
            Stream.filter(
              (record) =>
                entries.some((entry) => entry.checkoutId === record.checkoutId) &&
                (record.blockedReason !== null ||
                  (record.summary.state === "suspended" &&
                    record.operation === undefined &&
                    record.pendingProjection === undefined)),
            ),
            Stream.take(entries.length),
            Stream.runCollect,
            Effect.tap((records) =>
              Effect.sync(() => {
                expect(records.map((record) => record.checkoutId).sort()).toEqual(
                  entries.map((entry) => entry.checkoutId).sort(),
                );
                for (const record of records) expect(record.blockedReason).toBeNull();
              }),
            ),
          );
        yield* h.service.previewSuspend({ threadId: firstId });
        const original = (yield* h.registry.list)[0]!;
        h.threads.set(secondId, {
          ...h.threads.get(secondId)!,
          worktreeSuspension: { ...original.summary, generation: 99 },
        });
        for (let i = 0; i < 5; i++) {
          const id = ThreadId.make(`fixture:missing-${i}`);
          h.threads.set(
            id,
            shell(id, NodePath.join(NodePath.dirname(f.workspace), `missing-${i}`)),
          );
        }
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
        const saved = (yield* h.registry.list).filter((record) => paths.includes(record.path));
        expect(saved).toHaveLength(6);
        yield* awaitSuspended(saved);
        expect(saved.every((record) => record.summary.state === "suspended")).toBe(true);
        yield* Effect.promise(async () => {
          for (const workspace of paths)
            await expect(NodeFSP.lstat(workspace)).rejects.toMatchObject({ code: "ENOENT" });
        });
        expect(
          (yield* h.registry.list).find((record) => record.checkoutId === original.checkoutId)!
            .summary.state,
        ).toBe("active");
      }),
    ),
);

it.live("waits for each automatic save and ignores overlapping sweep requests", () =>
  realGit((f) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const h = yield* harness(f, {
        cleanupThreads: true,
        pauseCaptured: { entered, release },
        settings: {
          ...automaticSettings,
          worktreeSuspension: {
            ...automaticSettings.worktreeSuspension,
            scopes: { subagents: false, untouchedChildren: false, otherThreads: true },
          },
        },
      });
      const workspace = NodePath.join(NodePath.dirname(f.workspace), "zz-next-save");
      yield* Effect.promise(() =>
        git(f.repository, "worktree", "add", "-b", "next-save", workspace, "HEAD"),
      );
      const id = ThreadId.make("fixture:next-save");
      h.threads.set(id, { ...shell(id, workspace), branch: "next-save" });
      const pass = yield* Effect.forkChild(h.service.sweep);
      yield* Deferred.await(entered);
      yield* h.service.sweep;
      expect((yield* h.registry.list).map((record) => record.path)).toEqual([f.workspace]);
      expect(
        yield* Effect.promise(() => NodeFSP.stat(workspace).then((entry) => entry.isDirectory())),
      ).toBe(true);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(pass);
      const records = yield* h.registry.list;
      expect(records).toHaveLength(2);
      expect(records.every((record) => record.summary.state === "suspended")).toBe(true);
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
