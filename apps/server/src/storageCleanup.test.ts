import { observeDependencyActivity } from "@t3tools/shared/dependencyActivity";
import {
  createGeneratedBuildStage,
  generatedBuildActivity,
} from "@t3tools/shared/generatedBuildOwnership";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";
import {
  DEFAULT_SERVER_SETTINGS,
  GitCommandError,
  OrchestrationV2AppThreadJson,
  StorageCleanupReport,
  type WorktreeKeepWhen,
} from "@t3tools/contracts";
import * as ServerConfig from "./config.ts";
import * as StorageCleanup from "./storageCleanup.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as VcsProcess from "./vcs/VcsProcess.ts";
import * as PreviewHosting from "./preview/Hosting.ts";
import * as ProviderSessionManager from "./orchestration-v2/ProviderSessionManager.ts";
import * as GitManager from "./git/GitManager.ts";
import * as Settings from "./serverSettings.ts";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import { CodexProviderCapabilitiesV2 } from "./orchestration-v2/Adapters/CodexAdapterV2.ts";
import { ServerActivation } from "./serverActivation.ts";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Inject native deletion failures and verify the allocated-byte estimate.
import * as NodeFSP from "node:fs/promises";
import * as GeneratedDependencies from "./workspace/GeneratedDependencies.ts";
import * as DependencyMounts from "./workspace/DependencyMounts.ts";
import * as WorktreeConsumers from "./workspace/WorktreeConsumers.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof NodeFSP>();
  return { ...original, rm: vi.fn(original.rm) };
});
import {
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import {
  storageCleanupActivityAt,
  storageCleanupDeletedActivityAt,
  storageCleanupPullRequestMerged,
  storageCleanupThreadIdle,
} from "./storageCleanup.ts";

const NOW_MS = Date.parse("2026-06-10T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1_000;
const decodeCleanupReport = Schema.decodeSync(StorageCleanupReport);
const decodeFullThread = Schema.decodeUnknownSync(OrchestrationV2AppThreadJson);
const encodeFullThread = Schema.encodeSync(Schema.fromJsonString(OrchestrationV2AppThreadJson));
const encodeCleanupReport = Schema.encodeSync(StorageCleanupReport);
const decodeLegacyCleanupReport = Schema.decodeUnknownSync(
  Schema.Struct({
    ...StorageCleanupReport.fields,
    entries: Schema.Array(
      Schema.Struct({
        kind: Schema.Literals(["worktree", "browser-artifacts", "logs"]),
        outcome: Schema.Literals(["removed", "kept", "failed"]),
        reason: Schema.String,
        path: Schema.NullOr(Schema.String),
        threadId: Schema.NullOr(ThreadId),
        threadTitle: Schema.NullOr(Schema.String),
        bytes: Schema.NullOr(Schema.Number),
        files: Schema.NullOr(Schema.Number),
      }),
    ),
  }),
);

function at(offsetMs: number): DateTime.Utc {
  return DateTime.makeUnsafe(NOW_MS + offsetMs);
}

function shell(overrides: Partial<OrchestrationV2ThreadShell> = {}): OrchestrationV2ThreadShell {
  return {
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      rootThreadId: ThreadId.make("thread-1"),
      parentThreadId: null,
      relationshipToParent: null,
    },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestVisibleMessage: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    lastVisitedAt: null,
    deletedAt: null,
    branch: null,
    linkedPullRequest: null,
    status: "idle",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestRunId: null,
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: null,
    latestUserMessageAt: null,
    createdAt: at(-30 * DAY_MS),
    updatedAt: at(-10 * DAY_MS),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    ...overrides,
  };
}

describe("V2 storage cleanup eligibility", () => {
  const candidate = () => shell({ branch: "feature", worktreePath: "/worktrees/feature" });

  it("allows an idle worktree and rejects the project checkout", () => {
    expect(storageCleanupThreadIdle(candidate(), NOW_MS)).toBe(true);
    expect(storageCleanupThreadIdle(shell(), NOW_MS)).toBe(false);
  });

  it.each(["running", "starting", "preparing", "waiting", "queued"] as const)(
    "retains a worktree while its thread is %s",
    (status) => {
      expect(storageCleanupThreadIdle(candidateWithStatus(status), NOW_MS)).toBe(false);
    },
  );

  it.each(["idle", "completed", "interrupted", "failed", "cancelled", "rolled_back"] as const)(
    "allows cleanup once its thread is %s",
    (status) => {
      expect(storageCleanupThreadIdle(candidateWithStatus(status), NOW_MS)).toBe(true);
    },
  );

  it.each(["completed", "interrupted", "cancelled", "rolled_back"] as const)(
    "retains %s while background work is pending",
    (status) => {
      expect(
        storageCleanupThreadIdle(
          {
            ...candidateWithStatus(status),
            pendingBackgroundTasks: [{ taskId: "task-1", kind: "command" }],
          },
          NOW_MS,
        ),
      ).toBe(false);
    },
  );

  it.each(["completed", "interrupted", "cancelled", "rolled_back"] as const)(
    "retains %s while a runtime request is pending",
    (status) => {
      expect(
        storageCleanupThreadIdle(
          {
            ...candidateWithStatus(status),
            pendingRuntimeRequest: {
              id: RuntimeRequestId.make("request-1"),
              kind: "command",
              createdAt: at(0),
            },
          },
          NOW_MS,
        ),
      ).toBe(false);
    },
  );

  it("retains an active run even if the shell status is idle", () => {
    expect(
      storageCleanupThreadIdle({ ...candidate(), activeRunId: RunId.make("run") }, NOW_MS),
    ).toBe(false);
  });

  it("retains a queued prompt before the new run has been projected", () => {
    expect(
      storageCleanupThreadIdle({ ...candidate(), latestUserMessageAt: at(-1_000) }, NOW_MS),
    ).toBe(false);
  });

  it("uses V2 run activity instead of metadata refreshes for retention", () => {
    const thread = candidate();
    const runTime = at(-3 * DAY_MS);
    expect(
      storageCleanupActivityAt({ ...thread, latestRunCompletedAt: runTime, updatedAt: at(0) }),
    ).toBe(DateTime.toEpochMillis(runTime));
  });

  it("uses deletion and later durable events as the deleted-thread inactivity boundary", () => {
    const thread = { deletedAt: at(-10 * DAY_MS), updatedAt: at(-12 * DAY_MS) };
    expect(storageCleanupDeletedActivityAt(thread, null)).toBe(NOW_MS - 10 * DAY_MS);
    expect(storageCleanupDeletedActivityAt(thread, DateTime.formatIso(at(-DAY_MS)))).toBe(
      NOW_MS - DAY_MS,
    );
    expect(storageCleanupDeletedActivityAt({ ...thread, deletedAt: null }, null)).toBeNull();
    expect(storageCleanupDeletedActivityAt(thread, "invalid")).toBeNull();
  });

  function candidateWithStatus(status: OrchestrationV2ThreadShell["status"]) {
    return { ...candidate(), status };
  }
});

describe("merged pull request cleanup", () => {
  const HEAD_SHA = "a".repeat(40);
  const integrated = {
    branch: "feature",
    defaultBranch: "main",
    headSha: HEAD_SHA,
    integrated: true,
  };
  const squashed = { ...integrated, integrated: false };
  const pullRequest = (
    overrides: Partial<NonNullable<Parameters<typeof storageCleanupPullRequestMerged>[0]>> = {},
  ) => ({
    state: "merged" as const,
    headRef: "feature",
    baseRef: "main",
    headSha: HEAD_SHA,
    ...overrides,
  });

  it("removes a worktree whose head reached the default branch through a merged pull request", () => {
    expect(storageCleanupPullRequestMerged(pullRequest({ headSha: null }), integrated)).toBe(true);
  });

  it("removes a squash-merged worktree when the pull request names its exact head", () => {
    expect(storageCleanupPullRequestMerged(pullRequest(), squashed)).toBe(true);
  });

  it.each([
    ["has a later commit than the merged head", { headSha: "c".repeat(40) }],
    ["was merged into a release branch", { baseRef: "release" }],
    ["was merged into its stack parent", { baseRef: "stack-parent" }],
    ["was merged without a reported head commit", { headSha: null }],
    ["belongs to a different branch", { headRef: "other" }],
    ["is still open", { state: "open" }],
    ["was closed without merging", { state: "closed" }],
  ] as const)("keeps a squash worktree whose pull request %s", (_name, overrides) => {
    expect(storageCleanupPullRequestMerged(pullRequest(overrides), squashed)).toBe(false);
  });

  it("keeps a worktree with no pull request, or one that is not merged", () => {
    expect(storageCleanupPullRequestMerged(null, squashed)).toBe(false);
    expect(storageCleanupPullRequestMerged(null, integrated)).toBe(false);
    expect(storageCleanupPullRequestMerged(pullRequest({ state: "open" }), integrated)).toBe(false);
  });
});

const cleanupFixture = Effect.gen(function* () {
  const fixtureNow = yield* Clock.currentTimeMillis;
  const fs = yield* FileSystem.FileSystem;
  const initialConfig = yield* ServerConfig.ServerConfig;
  // macOS temporary directories can be reached through /var's symlink. Use
  // canonical roots so these tests exercise cleanup rather than its link guard.
  const baseDir = yield* fs.realPath(initialConfig.baseDir);
  const config = {
    ...initialConfig,
    baseDir,
    ...(yield* ServerConfig.deriveServerPaths(baseDir, undefined)),
  };
  const git = yield* GitVcsDriver.GitVcsDriver;
  const repo = yield* fs.makeTempDirectoryScoped({ prefix: "cleanup-repo-" });
  const command = (cwd: string, args: string[]) =>
    git.execute({ operation: "cleanup-test", cwd, args });
  yield* command(repo, ["init", "-b", "main"]);
  yield* command(repo, ["config", "user.email", "cleanup@example.test"]);
  yield* command(repo, ["config", "user.name", "Cleanup test"]);
  const globalExcludes = `${baseDir}/empty-global-excludes`;
  yield* fs.writeFileString(globalExcludes, "");
  yield* command(repo, ["config", "core.excludesFile", globalExcludes]);
  yield* fs.writeFileString(`${repo}/tracked.txt`, "original\n");
  yield* fs.writeFileString(`${repo}/.gitignore`, ".env\ndist/\nnode_modules/\n.t3/\ntarget/\n");
  yield* command(repo, ["add", "."]);
  yield* command(repo, ["commit", "-m", "initial"]);
  yield* fs.makeDirectory(config.worktreesDir, { recursive: true });
  let worktree = `${config.worktreesDir}/feature`;
  yield* command(repo, ["worktree", "add", "-b", "feature", worktree]);
  const seedAgedDependencyUse = Effect.gen(function* () {
    const location = yield* command(worktree, ["rev-parse", "--absolute-git-dir"]);
    yield* Effect.sync(() =>
      observeDependencyActivity(location.stdout.trim(), worktree, NOW_MS - 30 * DAY_MS, true),
    );
  });
  let settings: import("@t3tools/contracts").ServerSettings = {
    ...DEFAULT_SERVER_SETTINGS,
    storageCleanup: { ...DEFAULT_SERVER_SETTINGS.storageCleanup, worktreeAfterDays: 8 },
  };
  let threads = [shell({ branch: "feature", worktreePath: worktree })];
  let projectRoots = [{ id: ProjectId.make("project-1"), workspaceRoot: repo }];
  let editBeforeRemoval = false;
  let onDependencyInspection: (() => void) | null = null;
  let onWorktreeInventory: (() => void) | null = null;
  let worktreeInventoryCalls = 0;
  let failManagedRootCanonicalization = false;
  let failNextGitInventory = false;
  let inventoryIdentityMode: "command-error" | "malformed" | "missing-git-dir" | "not-git" | null =
    null;
  let failProjectInventory = false;
  const activation = yield* Deferred.make<void>();
  let failDependencyRead = false;
  let failWorktreeRead = false;
  let failEligibilityRevalidation = false;
  let deletedDependencyRows: Array<{
    payload_json: string;
    workspaceRoot: string;
    latestEventAt: string | null;
  }> = [];
  let openSessionCwd: string | null = null;
  let sessionLive = true;
  let unpersistedWorkspace: { cwd: string; threadIds: ThreadId[] } | null = null;
  let sessionStatus: import("@t3tools/contracts").OrchestrationV2ProviderSessionJson["status"] =
    "ready";
  let sessionBindings: ThreadId[] = [];
  let providerEventSequence = 0;
  let onSessionLiveRead: (() => void) | null = null;
  let fullStatusCalls = 0;
  let previewPaths: ReadonlyArray<string> = [];
  let ownershipRevision = 0;
  let dependencyInspectionHook: Effect.Effect<void> | null = null;
  const terminalListeners: Parameters<
    TerminalManager.TerminalManager["Service"]["subscribeMetadata"]
  >[0][] = [];
  const context = yield* Layer.build(StorageCleanup.layer).pipe(
    Effect.provideService(ServerConfig.ServerConfig, config),
    Effect.provideService(FileSystem.FileSystem, {
      ...fs,
      exists: (target: string) =>
        failManagedRootCanonicalization && target === config.worktreesDir
          ? Effect.sync(() => {
              failManagedRootCanonicalization = false;
            }).pipe(
              Effect.flatMap(() => fs.remove(target, { recursive: true })),
              Effect.as(true),
            )
          : fs.exists(target),
    }),
    Effect.provideService(GitVcsDriver.GitVcsDriver, {
      ...git,
      execute: (input) =>
        Effect.gen(function* () {
          if (
            input.operation === "GeneratedDependencies.inspect" &&
            dependencyInspectionHook !== null
          ) {
            const hook = dependencyInspectionHook;
            dependencyInspectionHook = null;
            yield* hook;
          }
          if (editBeforeRemoval && input.args.includes("remove"))
            yield* fs.writeFileString(`${worktree}/tracked.txt`, "late edit\n");
          if (input.operation === "GeneratedDependencies.inspect" && onDependencyInspection) {
            const callback = onDependencyInspection;
            onDependencyInspection = null;
            callback();
          }
          if (input.operation === "StorageCleanup.inventoryRepository" && inventoryIdentityMode) {
            const mode = inventoryIdentityMode;
            inventoryIdentityMode = null;
            if (mode === "command-error")
              return yield* Effect.fail(
                new GitCommandError({
                  operation: input.operation,
                  command: "git rev-parse --git-common-dir",
                  cwd: input.cwd,
                  detail: "Fixture Git identity execution failure",
                }),
              );
            if (mode === "malformed")
              return {
                exitCode: 0,
                stdout: "",
                stderr: "",
                stdoutTruncated: false,
                stderrTruncated: false,
              };
            if (mode === "missing-git-dir")
              return {
                exitCode: 0,
                stdout: "missing-git-dir",
                stderr: "",
                stdoutTruncated: false,
                stderrTruncated: false,
              };
            if (mode === "not-git")
              return {
                exitCode: 128,
                stdout: "",
                stderr: "fatal: not a git repository (or any parent up to mount point)",
                stdoutTruncated: false,
                stderrTruncated: false,
              };
          }
          return yield* git.execute(input);
        }),
      statusDetailsLocal: (...args) => {
        fullStatusCalls++;
        return git.statusDetailsLocal(...args);
      },
      listWorktreePaths: (cwd) =>
        (failNextGitInventory
          ? Effect.sync(() => {
              failNextGitInventory = false;
            }).pipe(
              Effect.flatMap(() =>
                Effect.fail(
                  new GitCommandError({
                    operation: "listWorktreePaths",
                    command: "git worktree list",
                    cwd,
                    detail: "Fixture Git inventory failure",
                  }),
                ),
              ),
            )
          : git.listWorktreePaths(cwd)
        ).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              worktreeInventoryCalls++;
              const callback = onWorktreeInventory;
              onWorktreeInventory = null;
              callback?.();
            }),
          ),
        ),
    }),
    Effect.provideService(Settings.ServerSettingsService, {
      getSettings: Effect.sync(() => settings),
      subscribeChanges: Effect.succeed(Stream.empty),
    } as unknown as Settings.ServerSettingsService["Service"]),
    Effect.provideService(ProjectStore.ProjectStoreV2, {
      listShells: () =>
        failProjectInventory
          ? Effect.fail(
              new ProjectStore.ProjectStoreV2Error({
                operation: "listShells",
                cause: new Error("Fixture project inventory failure"),
              }),
            )
          : Effect.sync(() => projectRoots),
    } as unknown as ProjectStore.ProjectStoreV2["Service"]),
    Effect.provideService(ProjectionStore.ProjectionStoreV2, {
      getThreadShell: (threadId: ThreadId) =>
        Effect.sync(() => threads.find((thread) => thread.id === threadId) ?? null),
      getShellSnapshot: (input?: { location?: string }) =>
        Effect.sync(() => ({
          threads: input?.location === "archive" ? [] : threads,
          archivedThreads: [],
        })),
    } as unknown as ProjectionStore.ProjectionStoreV2["Service"]),
    Effect.provideService(Orchestrator.OrchestratorV2, {
      streamDomainEvents: Stream.empty,
    } as unknown as Orchestrator.OrchestratorV2["Service"]),
    Effect.provideService(
      SqlClient.SqlClient,
      Object.assign(
        (strings: TemplateStringsArray, ...values: unknown[]) => {
          const query = strings.join("");
          if (failDependencyRead && query.includes("FROM orchestration_v2_projection_threads t")) {
            failDependencyRead = false;
            return Effect.fail(
              new SqlError.SqlError({
                reason: new SqlError.SqlSyntaxError({
                  cause: new Error("Fixture dependency query failure"),
                  message: "Fixture dependency query failure",
                }),
              }),
            );
          }
          if (failWorktreeRead && query.includes("WHERE t.deleted_at IS NOT NULL")) {
            failWorktreeRead = false;
            return Effect.fail(
              new SqlError.SqlError({
                reason: new SqlError.SqlSyntaxError({
                  cause: new Error("Fixture worktree query failure"),
                  message: "Fixture worktree query failure",
                }),
              }),
            );
          }
          if (
            failEligibilityRevalidation &&
            query.includes("OR (aggregate_kind = 'thread' AND stream_id")
          ) {
            failEligibilityRevalidation = false;
            return Effect.fail(
              new SqlError.SqlError({
                reason: new SqlError.SqlSyntaxError({
                  cause: new Error("Fixture eligibility revalidation failure"),
                  message: "Failed to execute statement",
                }),
              }),
            );
          }
          return Effect.sync(() => {
            if (query.includes("COALESCE(MAX(sequence)"))
              return [{ sequence: providerEventSequence }];
            if (query.includes("event_type LIKE 'provider-session.%'"))
              return providerEventSequence > Number(values[0]) ? [{ changed: 1 }] : [];
            if (query.includes("projection_provider_session_bindings"))
              return sessionBindings.map((thread_id) => ({
                provider_session_id: "session-1",
                thread_id,
              }));
            if (query.includes("SELECT t.payload_json, p.workspace_root"))
              return deletedDependencyRows;
            return openSessionCwd !== null && query.includes("projection_provider_sessions")
              ? [
                  {
                    payload_json: JSON.stringify({
                      id: "session-1",
                      driver: "codex",
                      providerInstanceId: "codex",
                      status: sessionStatus,
                      cwd: openSessionCwd,
                      model: null,
                      capabilities: CodexProviderCapabilitiesV2,
                      createdAt: "2026-06-01T12:00:00.000Z",
                      updatedAt: "2026-06-01T12:00:00.000Z",
                      lastError: null,
                    }),
                  },
                ]
              : [];
          });
        },
        { in: (values: ReadonlyArray<unknown>) => values },
      ) as unknown as SqlClient.SqlClient,
    ),
    Effect.provideService(ProviderSessionManager.ProviderSessionManagerV2, {
      ownershipRevision: Effect.sync(() => ownershipRevision),
      workspaceOwnership: Effect.sync(() =>
        unpersistedWorkspace !== null
          ? [unpersistedWorkspace]
          : openSessionCwd !== null && sessionLive
            ? [{ cwd: openSessionCwd, threadIds: sessionBindings }]
            : [],
      ),
      isLive: () =>
        Effect.sync(() => {
          const live = openSessionCwd !== null && sessionLive;
          const callback = onSessionLiveRead;
          onSessionLiveRead = null;
          callback?.();
          return live;
        }),
    } as unknown as ProviderSessionManager.ProviderSessionManagerV2["Service"]),
    Effect.provideService(PreviewHosting.PreviewHosting, {
      protectedWorkspacePaths: () => Effect.sync(() => previewPaths),
    } as unknown as PreviewHosting.PreviewHosting["Service"]),
    Effect.provideService(GitManager.GitManager, {
      invalidateStatus: () => Effect.void,
    } as unknown as GitManager.GitManager["Service"]),
    Effect.provideService(TerminalManager.TerminalManager, {
      subscribeMetadata: (listener: (typeof terminalListeners)[number]) =>
        Effect.sync(() => {
          terminalListeners.push(listener);
          return () => {};
        }),
    } as unknown as TerminalManager.TerminalManager["Service"]),
    Effect.provideService(ServerActivation, Deferred.await(activation)),
  );
  return {
    service: Context.get(context, StorageCleanup.StorageCleanup),
    activate: () => Deferred.succeed(activation, undefined),
    worktreeInventoryCalls: () => worktreeInventoryCalls,
    now: fixtureNow,
    at: (offset: number) => DateTime.makeUnsafe(fixtureNow + offset),
    setPreviewPaths: (paths: ReadonlyArray<string>) => {
      previewPaths = paths;
    },
    acquireProviderOwnership: () => {
      openSessionCwd = worktree;
      sessionLive = true;
      ownershipRevision++;
    },
    protectUnpersistedWorkspace: () => {
      unpersistedWorkspace = { cwd: worktree, threadIds: [ThreadId.make("thread-1")] };
      ownershipRevision++;
    },
    publishProviderChange: () => {
      providerEventSequence++;
      ownershipRevision++;
    },
    setSessionLive: (live: boolean) => {
      sessionLive = live;
    },
    setSessionStatus: (status: typeof sessionStatus) => {
      sessionStatus = status;
    },
    setSessionBindings: (bindings: ThreadId[]) => {
      sessionBindings = bindings;
    },
    onSessionLiveRead: (callback: () => void) => {
      onSessionLiveRead = callback;
    },
    editBeforeRemoval: () => {
      editBeforeRemoval = true;
    },
    fs,
    get worktree() {
      return worktree;
    },
    repo,
    config,
    command,
    enableDependencies: Effect.gen(function* () {
      yield* fs.writeFileString(
        `${worktree}/package.json`,
        '{"name":"cleanup-fixture","private":true}\n',
      );
      yield* fs.writeFileString(`${worktree}/package-lock.json`, "{}\n");
      yield* command(worktree, ["add", "package.json", "package-lock.json"]);
      yield* command(worktree, ["commit", "-m", "add package"]);
      yield* fs.makeDirectory(`${worktree}/node_modules/package`, { recursive: true });
      yield* fs.writeFileString(`${worktree}/node_modules/.package-lock.json`, "{}\n");
      yield* fs.writeFileString(
        `${worktree}/node_modules/package/index.js`,
        "module.exports = 1;\n",
      );
      yield* seedAgedDependencyUse;
      settings = {
        ...settings,
        storageCleanup: {
          ...settings.storageCleanup,
          worktreeAfterDays: null,
          worktreeDependenciesAfterDays: 8,
        },
      };
    }),
    moveDependencies: (
      location: "configured" | "previous",
      removeDefault = false,
      aliasParent = false,
    ) =>
      Effect.gen(function* () {
        const directory = `${baseDir}/alternate-worktrees`;
        const moved = `${directory}/feature`;
        yield* fs.makeDirectory(directory, { recursive: true });
        yield* command(repo, ["worktree", "move", worktree, moved]);
        worktree = moved;
        const cleanupDirectory = aliasParent ? `${baseDir}/aliased-worktrees` : directory;
        if (aliasParent) {
          yield* fs.symlink(directory, cleanupDirectory);
          worktree = `${cleanupDirectory}/feature`;
        }
        threads = threads.map((thread) => ({ ...thread, worktreePath: worktree }));
        settings = {
          ...settings,
          ...(location === "configured"
            ? { worktreesDirectory: cleanupDirectory }
            : { previousWorktreesDirectories: [cleanupDirectory] }),
        };
        if (removeDefault) yield* fs.remove(config.worktreesDir, { recursive: true });
        // Moving the checkout changes its usage identity; guard tests need an aged observation at the final location.
        yield* seedAgedDependencyUse;
        return { canonicalPath: moved, recordedPath: worktree, cleanupDirectory };
      }),
    onDependencyInspection: (hook: Effect.Effect<void>) => {
      dependencyInspectionHook = hook;
    },
    setTerminalCwd: (cwd: string) =>
      terminalListeners[0]!({
        type: "upsert",
        terminal: {
          threadId: "unrelated-terminal",
          terminalId: "terminal-1",
          cwd,
          worktreePath: null,
          status: "starting",
          pid: null,
          exitCode: null,
          exitSignal: null,
          hasRunningSubprocess: false,
          label: "Shell",
          updatedAt: "2026-06-10T12:00:00.000Z",
        },
      }),
    enableFiles: () => {
      settings = {
        ...settings,
        storageCleanup: {
          ...settings.storageCleanup,
          browserArtifactsAfterDays: 8,
          logsAfterDays: 8,
        },
      };
    },
    setPolicy: (worktreeKeepWhen: WorktreeKeepWhen) => {
      settings = { ...settings, storageCleanup: { ...settings.storageCleanup, worktreeKeepWhen } };
    },
    setDependencyPolicy: (days: number | null) => {
      settings = {
        ...settings,
        storageCleanup: { ...settings.storageCleanup, worktreeDependenciesAfterDays: days },
      };
    },
    setRetention: (worktreeAfterDays: number | null) => {
      settings = { ...settings, storageCleanup: { ...settings.storageCleanup, worktreeAfterDays } };
    },
    setDependencyRetention: (days: number | null) => {
      settings = {
        ...settings,
        storageCleanup: {
          ...settings.storageCleanup,
          worktreeAfterDays: null,
          worktreeDependenciesAfterDays: days,
        },
      };
    },
    setProjectDependencyRetention: (projectId: ProjectId, days: number | null) => {
      settings = {
        ...settings,
        projectSettingsOverrides: {
          ...settings.projectSettingsOverrides,
          [projectId]: {
            worktreeCleanup: {
              mode: "custom",
              rules: { worktreeDependenciesAfterDays: days, worktreeAfterDays: null },
            },
          },
        },
      };
    },
    setProjectWholeCleanupOff: (projectId: ProjectId) => {
      settings = {
        ...settings,
        projectSettingsOverrides: {
          ...settings.projectSettingsOverrides,
          [projectId]: { worktreeCleanup: { mode: "off" } },
        },
      };
    },
    disable: () => {
      settings = {
        ...settings,
        storageCleanup: { ...settings.storageCleanup, worktreeAfterDays: null },
      };
    },
    setThreads: (next: typeof threads) => {
      threads = next;
    },
    setProjectRoots: (next: typeof projectRoots) => {
      projectRoots = next;
    },
    addThreadOnDependencyInspection: (thread: OrchestrationV2ThreadShell) => {
      onDependencyInspection = () => {
        threads = [...threads, thread];
      };
    },
    addThreadOnWorktreeInventory: (thread: OrchestrationV2ThreadShell) => {
      onWorktreeInventory = () => {
        threads = [...threads, thread];
      };
    },
    failNextDependencyRead: () => {
      failDependencyRead = true;
    },
    failNextWorktreeRead: () => {
      failWorktreeRead = true;
    },
    failNextGitInventory: () => {
      failNextGitInventory = true;
    },
    setInventoryIdentityMode: (mode: typeof inventoryIdentityMode) => {
      inventoryIdentityMode = mode;
    },
    failProjectInventory: () => {
      failProjectInventory = true;
    },
    failManagedRootCanonicalization: () => {
      failManagedRootCanonicalization = true;
    },
    failEligibilityRevalidation: () => {
      failEligibilityRevalidation = true;
    },
    setDeletedDependencyRows: (rows: typeof deletedDependencyRows) => {
      deletedDependencyRows = rows;
    },
    setProjectWorktreeCleanupOff: (projectId: ProjectId) => {
      settings = {
        ...settings,
        projectSettingsOverrides: {
          ...settings.projectSettingsOverrides,
          [projectId]: { worktreeCleanup: { mode: "off" } },
        },
      };
    },
    setManagedWorktreeDirectories: (current: string, previous: ReadonlyArray<string>) => {
      settings = {
        ...settings,
        worktreesDirectory: current,
        previousWorktreesDirectories: previous,
      };
    },
    setOpenSessionCwd: (cwd: string | null) => {
      openSessionCwd = cwd;
    },
    fullStatusCalls: () => fullStatusCalls,
  };
});
const cleanupTestLayer = GitVcsDriver.layer.pipe(
  Layer.provide(VcsProcess.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "storage-cleanup-" })),
  Layer.provideMerge(NodeServices.layer),
);
const runCleanupTest = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | FileSystem.FileSystem
    | ServerConfig.ServerConfig
    | GitVcsDriver.GitVcsDriver
    | Path.Path
    | Scope.Scope
  >,
) =>
  effect.pipe(
    // Context.Reference falls back to the real host inventory. Keep this test
    // default outside the fixture so individual tests can override it.
    Effect.provideService(GeneratedDependencies.ProcessWorkingDirectories, Effect.succeed([])),
    Effect.provideService(WorktreeConsumers.ProcessPaths, Effect.succeed([])),
    Effect.provideService(DependencyMounts.MountPoints, Effect.succeed([])),
    Effect.provide(cleanupTestLayer),
    Effect.scoped,
  );

describe("provider protection during storage cleanup", () => {
  it.live.each(["stopped", "error"] as const)(
    "keeps an unfinished runtime close even when the durable session is %s",
    (status) =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* cleanupFixture;
          fixture.setOpenSessionCwd(fixture.repo);
          fixture.setSessionBindings([ThreadId.make("thread-1")]);
          fixture.setSessionStatus(status);
          fixture.setSessionLive(true);
          const report = yield* fixture.service.runNow;
          expect(report.entries[0]).toMatchObject({
            outcome: "kept",
            reason: "Provider session is still open",
          });
          expect(yield* fixture.fs.exists(fixture.worktree)).toBe(true);
        }),
      ),
  );

  it.live.each(["missing", "older cwd"] as const)(
    "keeps runtime ownership when its durable row is %s",
    (row) =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* cleanupFixture;
          if (row === "older cwd") fixture.setOpenSessionCwd(fixture.repo);
          fixture.protectUnpersistedWorkspace();
          const report = yield* fixture.service.runNow;
          expect(report.entries[0]).toMatchObject({
            outcome: "kept",
            reason: "Provider session is still open",
          });
          expect(yield* fixture.fs.exists(fixture.worktree)).toBe(true);
        }),
      ),
  );

  it.live("ignores a stale ready projection without a live runtime", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture;
        fixture.setOpenSessionCwd(fixture.worktree);
        fixture.setSessionLive(false);
        const report = yield* fixture.service.runNow;
        expect(report.counts).toEqual({ removed: 1, kept: 1, failed: 0 });
        expect(yield* fixture.fs.exists(fixture.worktree)).toBe(false);
      }),
    ),
  );

  it.live("refreshes unrelated provider activity while measuring an idle worktree", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        let onMeasurement: (() => void) | null = null;
        let measuredPath: string | null = null;
        const fixture = yield* cleanupFixture.pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            readDirectory: (directory, options) =>
              Effect.gen(function* () {
                if (directory === measuredPath) {
                  onMeasurement?.();
                  onMeasurement = null;
                }
                return yield* fs.readDirectory(directory, options);
              }),
          }),
        );
        fixture.setOpenSessionCwd(fixture.repo);
        measuredPath = yield* fs.realPath(fixture.worktree);
        onMeasurement = fixture.publishProviderChange;
        const report = yield* fixture.service.runNow;
        expect(report.counts).toEqual({ removed: 1, kept: 1, failed: 0 });
        expect(yield* fs.exists(fixture.worktree)).toBe(false);
      }),
    ),
  );

  it.live.each(["binding", "cwd"] as const)(
    "keeps a worktree when a provider %s changes during protection capture",
    (owner) =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* cleanupFixture;
          fixture.setOpenSessionCwd(fixture.repo);
          fixture.onSessionLiveRead(() => {
            if (owner === "binding") fixture.setSessionBindings([ThreadId.make("thread-1")]);
            else fixture.setOpenSessionCwd(fixture.worktree);
            fixture.publishProviderChange();
          });
          const report = yield* fixture.service.runNow;
          expect(report.entries[0]).toMatchObject({
            outcome: "kept",
            reason: "Provider session is still open",
          });
          expect(yield* fixture.fs.exists(fixture.worktree)).toBe(true);
        }),
      ),
  );
});

describe("dependency cleanup reports", () => {
  it.live.each(["configured", "previous"] as const)(
    "removes dependencies through a symlinked parent in the %s location",
    (location) =>
      runCleanupTest(
        isolatedDependencies(
          Effect.gen(function* () {
            const fixture = yield* cleanupFixture;
            yield* fixture.enableDependencies;
            const paths = yield* fixture.moveDependencies(location, false, true);
            const report = yield* fixture.service.runNow;
            expect(report.entries[0]).toMatchObject({
              kind: "worktree",
              worktreeResource: "dependencies",
              outcome: "removed",
              path: `${paths.canonicalPath}/node_modules`,
            });
            expect(yield* fixture.fs.exists(`${paths.recordedPath}/node_modules`)).toBe(false);
            expect(yield* fixture.fs.exists(`${paths.recordedPath}/tracked.txt`)).toBe(true);
          }),
        ),
      ),
  );

  it.live("refuses a symlinked worktree leaf", () =>
    runCleanupTest(
      isolatedDependencies(
        Effect.gen(function* () {
          const fixture = yield* cleanupFixture;
          yield* fixture.enableDependencies;
          const alias = `${fixture.config.worktreesDir}/linked-feature`;
          yield* fixture.fs.symlink(fixture.worktree, alias);
          fixture.setThreads([shell({ branch: "feature", worktreePath: alias })]);
          const report = yield* fixture.service.runNow;
          expect(report.entries[0]).toMatchObject({
            outcome: "kept",
            reason: "Dependencies: Worktree path is a symlink or its location changed",
          });
          expect(yield* fixture.fs.exists(`${fixture.worktree}/node_modules`)).toBe(true);
        }),
      ),
    ),
  );

  it.live("keeps a worktree shared by canonical and aliased owners", () =>
    runCleanupTest(
      isolatedDependencies(
        Effect.gen(function* () {
          const fixture = yield* cleanupFixture;
          yield* fixture.enableDependencies;
          const paths = yield* fixture.moveDependencies("configured", false, true);
          fixture.setThreads([
            shell({ branch: "feature", worktreePath: paths.recordedPath }),
            shell({
              id: ThreadId.make("other"),
              branch: "feature",
              worktreePath: paths.canonicalPath,
            }),
          ]);
          const report = yield* fixture.service.runNow;
          expect(report.entries).toMatchObject([
            {
              outcome: "kept",
              reason: "Dependencies: An unarchived thread still shares this worktree",
            },
          ]);
          expect(yield* fixture.fs.exists(`${paths.canonicalPath}/node_modules`)).toBe(true);
        }),
      ),
    ),
  );

  it.live.each(["terminal", "provider", "preview", "process"] as const)(
    "keeps dependencies protected by an aliased %s workspace",
    (owner) =>
      runCleanupTest(
        Effect.gen(function* () {
          let processCwds: string[] = [];
          const fixture = yield* cleanupFixture.pipe(
            Effect.provideService(
              GeneratedDependencies.ProcessWorkingDirectories,
              Effect.sync(() => processCwds),
            ),
            Effect.provideService(DependencyMounts.MountPoints, Effect.succeed([])),
          );
          yield* fixture.enableDependencies;
          const paths = yield* fixture.moveDependencies("configured", false, true);
          // The candidate uses the real path while its owner uses the parent alias.
          fixture.setThreads([shell({ branch: "feature", worktreePath: paths.canonicalPath })]);
          if (owner === "terminal") yield* fixture.setTerminalCwd(paths.recordedPath);
          else if (owner === "provider") fixture.setOpenSessionCwd(paths.recordedPath);
          else if (owner === "preview") fixture.setPreviewPaths([paths.recordedPath]);
          else processCwds = [paths.recordedPath];
          const report = yield* fixture.service.runNow;
          expect(report.counts).toEqual({ removed: 0, kept: 1, failed: 0 });
          expect(report.entries[0]?.reason.toLowerCase()).toContain(
            owner === "provider" ? "provider session" : owner,
          );
          expect(yield* fixture.fs.exists(`${paths.canonicalPath}/node_modules`)).toBe(true);
        }),
      ),
  );

  it.live("keeps dependencies when a parent alias retargets during inspection", () =>
    runCleanupTest(
      isolatedDependencies(
        Effect.gen(function* () {
          const fixture = yield* cleanupFixture;
          yield* fixture.enableDependencies;
          const paths = yield* fixture.moveDependencies("configured", false, true);
          const replacement = yield* fixture.fs.makeTempDirectoryScoped();
          yield* fixture.fs.makeDirectory(`${replacement}/feature`);
          fixture.onDependencyInspection(
            Effect.gen(function* () {
              yield* fixture.fs.remove(paths.cleanupDirectory);
              yield* fixture.fs.symlink(replacement, paths.cleanupDirectory);
            }).pipe(Effect.orDie),
          );
          const report = yield* fixture.service.runNow;
          expect(report.entries[0]).toMatchObject({
            outcome: "kept",
            reason: "Dependencies: Worktree path is a symlink or its location changed",
          });
          expect(yield* fixture.fs.exists(`${paths.canonicalPath}/node_modules`)).toBe(true);
        }),
      ),
    ),
  );

  it.live.each([
    ["configured", false],
    ["previous", false],
    ["configured", true],
  ] as const)(
    "removes dependencies in the %s location with missing default %s",
    ([location, missing]) =>
      runCleanupTest(
        isolatedDependencies(
          Effect.gen(function* () {
            const fixture = yield* cleanupFixture;
            yield* fixture.enableDependencies;
            yield* fixture.moveDependencies(location, missing);
            const report = yield* fixture.service.runNow;
            expect(report.entries[0]).toMatchObject({
              kind: "worktree",
              worktreeResource: "dependencies",
              outcome: "removed",
              path: `${fixture.worktree}/node_modules`,
            });
            expect(yield* fixture.fs.exists(`${fixture.worktree}/node_modules`)).toBe(false);
            expect(yield* fixture.fs.exists(`${fixture.worktree}/tracked.txt`)).toBe(true);
          }),
        ),
      ),
  );
  const isolatedDependencies = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(GeneratedDependencies.ProcessWorkingDirectories, Effect.succeed([])),
      Effect.provideService(DependencyMounts.MountPoints, Effect.succeed([])),
    );

  it.live("counts removed dependency installs and their allocated-byte estimate", () =>
    runCleanupTest(
      isolatedDependencies(
        Effect.gen(function* () {
          const fixture = yield* cleanupFixture;
          yield* fixture.enableDependencies;
          const dependencyPath = `${fixture.worktree}/node_modules`;
          const sizes = yield* Effect.promise(() =>
            Promise.all(
              [
                dependencyPath,
                `${dependencyPath}/.package-lock.json`,
                `${dependencyPath}/package`,
                `${dependencyPath}/package/index.js`,
              ].map((file) => NodeFSP.lstat(file)),
            ),
          );
          const estimatedBytes = sizes.reduce((bytes, stat) => bytes + stat.blocks * 512, 0);
          const report = yield* fixture.service.runNow;
          expect(report.counts).toEqual({ removed: 1, kept: 0, failed: 0 });
          expect(report.entries).toMatchObject([
            {
              kind: "worktree",
              worktreeResource: "dependencies",
              outcome: "removed",
              path: dependencyPath,
              threadId: "thread-1",
              threadTitle: "Thread",
              bytes: estimatedBytes,
              files: null,
            },
          ]);
          expect(report.bytesFreed).toBe(estimatedBytes);
          expect(report.entries[0]?.reason).toContain("estimated");
          const legacyReport = decodeLegacyCleanupReport(encodeCleanupReport(report));
          expect(legacyReport.entries[0]).toMatchObject({
            kind: "worktree",
            path: dependencyPath,
            reason: expect.stringMatching(/^Dependencies:/),
            bytes: estimatedBytes,
          });
          expect(legacyReport.entries[0]).not.toHaveProperty("worktreeResource");
          expect(yield* fixture.fs.exists(dependencyPath)).toBe(false);
          expect(yield* fixture.fs.exists(`${fixture.worktree}/tracked.txt`)).toBe(true);
          expect((yield* fixture.service.runNow).entries).toEqual([]);
        }),
      ),
    ),
  );

  it.live("reports a native dependency deletion failure instead of a removal", () =>
    runCleanupTest(
      isolatedDependencies(
        Effect.gen(function* () {
          const fixture = yield* cleanupFixture;
          yield* fixture.enableDependencies;
          vi.mocked(NodeFSP.rm).mockRejectedValueOnce(new Error("test deletion denied"));
          const report = yield* fixture.service.runNow;
          expect(report.counts).toEqual({ removed: 0, kept: 0, failed: 1 });
          expect(report.entries[0]).toMatchObject({
            kind: "worktree",
            worktreeResource: "dependencies",
            outcome: "failed",
            bytes: null,
          });
          expect(report.entries[0]?.reason).toContain("test deletion denied");
          expect(report.bytesFreed).toBe(0);
          expect(yield* fixture.fs.exists(`${fixture.worktree}/node_modules`)).toBe(true);
        }),
      ),
    ),
  );

  it.live("explains when an old install is protected by a preview", () =>
    runCleanupTest(
      isolatedDependencies(
        Effect.gen(function* () {
          const fixture = yield* cleanupFixture;
          yield* fixture.enableDependencies;
          fixture.setPreviewPaths([fixture.worktree]);
          const report = yield* fixture.service.runNow;
          expect(report.counts).toEqual({ removed: 0, kept: 1, failed: 0 });
          expect(report.entries[0]).toMatchObject({
            kind: "worktree",
            worktreeResource: "dependencies",
            outcome: "kept",
            bytes: null,
            reason:
              "Dependencies: A preview is using this worktree, or preview ownership could not be checked",
          });
          expect(report.bytesFreed).toBe(0);
          expect(yield* fixture.fs.exists(`${fixture.worktree}/node_modules`)).toBe(true);
        }),
      ),
    ),
  );

  it.live("reports a final process-inventory refusal as kept", () =>
    runCleanupTest(
      Effect.gen(function* () {
        let inventories = 0;
        const fixture = yield* cleanupFixture.pipe(
          Effect.provideService(
            GeneratedDependencies.ProcessWorkingDirectories,
            Effect.sync(() => (++inventories === 1 ? [] : null)),
          ),
          Effect.provideService(DependencyMounts.MountPoints, Effect.succeed([])),
        );
        yield* fixture.enableDependencies;
        const report = yield* fixture.service.runNow;
        expect(report.counts).toEqual({ removed: 0, kept: 1, failed: 0 });
        expect(report.entries[0]).toMatchObject({
          kind: "worktree",
          worktreeResource: "dependencies",
          outcome: "kept",
          bytes: null,
          reason: "Dependencies: Active process inspection is unavailable",
        });
        expect(report.bytesFreed).toBe(0);
        expect(yield* fixture.fs.exists(`${fixture.worktree}/node_modules`)).toBe(true);
      }),
    ),
  );
});

const seedCompilerOutput = Effect.fnUntraced(function* (
  fixture: Effect.Success<typeof cleanupFixture>,
  root: string,
  usedAt: number,
) {
  const configRoot = root.startsWith("apps/")
    ? root.split("/").slice(0, 2).join("/")
    : "native/resource-monitor";
  yield* fixture.fs.makeDirectory(`${fixture.worktree}/${configRoot}`, { recursive: true });
  const sources = root.startsWith("apps/")
    ? [
        ["package.json", '{"name":"generic-app"}\n'],
        ["vite.config.ts", 'export default { build: { outDir: "dist" } };\n'],
      ]
    : [
        ["Cargo.toml", '[package]\nname = "generic-monitor"\nversion = "0.1.0"\n'],
        ["Cargo.lock", "version = 4\n"],
      ];
  for (const [file, content] of sources)
    yield* fixture.fs.writeFileString(`${fixture.worktree}/${configRoot}/${file}`, content!);
  yield* fixture.command(fixture.worktree, ["add", configRoot]);
  yield* fixture.command(fixture.worktree, [
    "commit",
    "--allow-empty",
    "-m",
    "generic compiler sources",
  ]);
  const stage = yield* Effect.sync(() => createGeneratedBuildStage(fixture.worktree, root)!);
  yield* fixture.fs.makeDirectory(`${stage.directory}/assets`);
  yield* fixture.fs.writeFileString(
    `${stage.directory}/assets/emitted.bin`,
    "compiler-emitted bytes\n",
  );
  yield* Effect.sync(() => stage.publish(usedAt));
});

describe("verified build sweep shares the dependency rule", () => {
  it.live(
    "reclaims verified ownerless output using its actual clock, then protects regenerated output and Off",
    () =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* cleanupFixture;
          fixture.setDependencyRetention(3);
          yield* seedCompilerOutput(fixture, "apps/web/dist", fixture.now - 4 * DAY_MS);
          fixture.setThreads([]);
          expect(
            (yield* fixture.service.runNow).entries.filter(
              (entry) => entry.kind === "generated-builds",
            ),
          ).toMatchObject([{ outcome: "removed" }]);
          yield* seedCompilerOutput(fixture, "apps/web/dist", fixture.now);
          expect(
            (yield* fixture.service.runNow).entries.filter(
              (entry) => entry.kind === "generated-builds",
            ),
          ).toMatchObject([{ outcome: "kept" }]);
          fixture.setProjectWholeCleanupOff(ProjectId.make("project-1"));
          expect(
            (yield* fixture.service.runNow).entries.filter(
              (entry) => entry.kind === "generated-builds",
            ),
          ).toMatchObject([{ outcome: "kept", reason: expect.stringContaining("off") }]);
          expect(
            yield* fixture.fs.exists(`${fixture.worktree}/apps/web/dist/assets/emitted.bin`),
          ).toBe(true);
        }),
      ),
  );
  it.live(
    "handles shared archived output deliberately and protects an Off or unarchived sibling",
    () =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* cleanupFixture;
          fixture.setDependencyRetention(14);
          yield* seedCompilerOutput(fixture, "apps/web/dist", fixture.now);
          const first = shell({
            branch: "feature",
            worktreePath: fixture.worktree,
            archivedAt: fixture.at(-1),
          });
          const sibling = shell({
            id: ThreadId.make("sibling"),
            branch: "feature",
            worktreePath: fixture.worktree,
            archivedAt: fixture.at(-1),
          });
          fixture.setThreads([first, { ...sibling, archivedAt: null }]);
          expect(
            (yield* fixture.service.runNow).entries.filter(
              (entry) => entry.kind === "generated-builds",
            ),
          ).toMatchObject([{ outcome: "kept", reason: expect.stringContaining("unarchived") }]);
          const offProject = ProjectId.make("off-owner");
          fixture.setProjectWholeCleanupOff(offProject);
          fixture.setThreads([first, { ...sibling, projectId: offProject }]);
          expect(
            (yield* fixture.service.runNow).entries.filter(
              (entry) => entry.kind === "generated-builds",
            ),
          ).toMatchObject([{ outcome: "kept", reason: expect.stringContaining("off") }]);
          fixture.setThreads([first, sibling]);
          expect(
            (yield* fixture.service.runNow).entries.filter(
              (entry) => entry.kind === "generated-builds",
            ),
          ).toMatchObject([{ outcome: "removed" }]);
          expect(yield* fixture.fs.exists(fixture.worktree)).toBe(true);
        }),
      ),
  );
  it.live.each(["apps/web/dist", "apps/server/dist", "native/resource-monitor/target/debug"])(
    "removes archived verified %s immediately while retaining additions and source",
    (root) =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* cleanupFixture;
          fixture.setDependencyRetention(90);
          fixture.setThreads([
            shell({
              branch: "feature",
              worktreePath: fixture.worktree,
              archivedAt: fixture.at(-1),
              latestUserMessageAt: fixture.at(-1),
              latestRunCompletedAt: fixture.at(-1),
            }),
          ]);
          yield* seedCompilerOutput(fixture, root, fixture.now);
          yield* fixture.fs.writeFileString(
            `${fixture.worktree}/${root}/retained-note.txt`,
            "unique notes\n",
          );
          const report = yield* fixture.service.runNow;
          expect(report.entries.filter((entry) => entry.kind === "generated-builds")).toMatchObject(
            [{ outcome: "removed", files: 1 }],
          );
          expect(yield* fixture.fs.exists(`${fixture.worktree}/${root}/assets/emitted.bin`)).toBe(
            false,
          );
          expect(
            yield* fixture.fs.readFileString(`${fixture.worktree}/${root}/retained-note.txt`),
          ).toBe("unique notes\n");
          expect(yield* fixture.fs.exists(`${fixture.worktree}/tracked.txt`)).toBe(true);
        }),
      ),
  );
  it.live.each([
    [3, 4, "removed"],
    [14, 4, "kept"],
  ] as const)(
    "uses configured dependency delay %s for outputs idle %s days",
    (days, idleDays, outcome) =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* cleanupFixture;
          fixture.setDependencyRetention(days);
          yield* seedCompilerOutput(fixture, "apps/web/dist", fixture.now - idleDays * DAY_MS);
          const report = yield* fixture.service.runNow;
          expect(report.entries.filter((entry) => entry.kind === "generated-builds")).toMatchObject(
            [{ outcome }],
          );
          expect(yield* fixture.fs.exists(fixture.worktree)).toBe(true);
        }),
      ),
  );
  it.live(
    "inherits the environment delay, respects project Custom and Off, and retains legacy outputs",
    () =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* cleanupFixture;
          fixture.setDependencyRetention(3);
          yield* seedCompilerOutput(fixture, "apps/web/dist", fixture.now - 4 * DAY_MS);
          fixture.setProjectDependencyRetention(ProjectId.make("project-1"), 14);
          expect(
            (yield* fixture.service.runNow).entries.filter(
              (entry) => entry.kind === "generated-builds",
            ),
          ).toMatchObject([{ outcome: "kept" }]);
          fixture.setProjectWholeCleanupOff(ProjectId.make("project-1"));
          expect(
            (yield* fixture.service.runNow).entries.filter(
              (entry) => entry.kind === "generated-builds",
            ),
          ).toEqual([]);
          expect(
            yield* fixture.fs.exists(`${fixture.worktree}/apps/web/dist/assets/emitted.bin`),
          ).toBe(true);
          // A different fixture establishes a legacy root without compiler provenance.
          const legacy = yield* cleanupFixture;
          legacy.setDependencyRetention(3);
          legacy.setThreads([
            shell({ branch: "feature", worktreePath: legacy.worktree, archivedAt: legacy.at(-1) }),
          ]);
          yield* legacy.fs.makeDirectory(`${legacy.worktree}/apps/web/dist`, { recursive: true });
          yield* legacy.fs.writeFileString(
            `${legacy.worktree}/apps/web/package.json`,
            '{"name":"generic-legacy-app"}\n',
          );
          yield* legacy.fs.writeFileString(
            `${legacy.worktree}/apps/web/vite.config.ts`,
            'export default { build: { outDir: "dist" } };\n',
          );
          yield* legacy.command(legacy.worktree, [
            "add",
            "apps/web/package.json",
            "apps/web/vite.config.ts",
          ]);
          yield* legacy.command(legacy.worktree, ["commit", "-m", "generic legacy build sources"]);
          yield* legacy.fs.writeFileString(
            `${legacy.worktree}/apps/web/dist/unknown.bin`,
            "retained legacy output\n",
          );
          const report = yield* legacy.service.runNow;
          expect(report.entries.filter((entry) => entry.kind === "generated-builds")).toMatchObject(
            [{ outcome: "kept", reason: expect.stringContaining("review") }],
          );
          expect(yield* legacy.fs.exists(`${legacy.worktree}/apps/web/dist/unknown.bin`)).toBe(
            true,
          );
        }),
      ),
  );
  it.live("status-only activity does not renew build use but genuine output consumers do", () =>
    runCleanupTest(
      Effect.gen(function* () {
        let paths: readonly string[] = [];
        const fixture = yield* cleanupFixture.pipe(
          Effect.provideService(
            WorktreeConsumers.ProcessPaths,
            Effect.sync(() => paths),
          ),
        );
        fixture.setDependencyRetention(3);
        yield* seedCompilerOutput(fixture, "apps/web/dist", fixture.now - 4 * DAY_MS);
        fixture.setThreads([
          shell({
            branch: "feature",
            worktreePath: fixture.worktree,
            latestUserMessageAt: fixture.at(-1),
            latestRunCompletedAt: fixture.at(-1),
          }),
        ]);
        paths = [`${fixture.worktree}/apps/web/dist/assets/emitted.bin`];
        expect(
          (yield* fixture.service.runNow).entries.filter(
            (entry) => entry.kind === "generated-builds",
          ),
        ).toMatchObject([{ outcome: "kept" }]);
        expect(
          yield* Effect.sync(
            () => generatedBuildActivity(fixture.worktree, "apps/web/dist")?.lastUsedAt,
          ),
        ).toBeGreaterThan(fixture.now - 4 * DAY_MS);
        paths = [];
        expect(
          (yield* fixture.service.runNow).entries.filter(
            (entry) => entry.kind === "generated-builds",
          ),
        ).toMatchObject([{ outcome: "kept" }]);
        const statusOnly = yield* cleanupFixture;
        statusOnly.setDependencyRetention(3);
        yield* seedCompilerOutput(statusOnly, "apps/web/dist", statusOnly.now - 4 * DAY_MS);
        statusOnly.setThreads([
          shell({
            branch: "feature",
            worktreePath: statusOnly.worktree,
            latestUserMessageAt: statusOnly.at(-1),
            latestRunCompletedAt: statusOnly.at(-1),
          }),
        ]);
        expect(
          (yield* statusOnly.service.runNow).entries.filter(
            (entry) => entry.kind === "generated-builds",
          ),
        ).toMatchObject([{ outcome: "removed" }]);
      }),
    ),
  );
});

describe("storage cleanup reports and local file policies", () => {
  it.live("reclaims a clean archived checkout immediately and preserves its branch history", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture;
        fixture.setRetention(90);
        fixture.setThreads([
          shell({
            branch: "feature",
            worktreePath: fixture.worktree,
            archivedAt: fixture.at(-1),
            createdAt: fixture.at(-1),
            latestUserMessageAt: fixture.at(-1),
            latestRunCompletedAt: fixture.at(-1),
          }),
        ]);
        yield* fixture.fs.writeFileString(
          `${fixture.worktree}/tracked.txt`,
          "unique branch work\n",
        );
        yield* fixture.command(fixture.worktree, ["add", "tracked.txt"]);
        yield* fixture.command(fixture.worktree, ["commit", "-m", "unique work remains on branch"]);
        const before = (yield* fixture.command(fixture.repo, ["rev-parse", "refs/heads/feature"]))
          .stdout;
        const checkpoint = "refs/t3/orchestration-v2/checkpoints/generic-checkpoint";
        yield* fixture.command(fixture.repo, ["update-ref", checkpoint, before.trim()]);
        const report = yield* fixture.service.runNow;
        expect(report.entries[0]).toMatchObject({
          outcome: "removed",
          reason: "All thread owners are archived",
        });
        expect(yield* fixture.fs.exists(fixture.worktree)).toBe(false);
        expect(
          (yield* fixture.command(fixture.repo, ["rev-parse", "refs/heads/feature"])).stdout,
        ).toBe(before);
        expect((yield* fixture.command(fixture.repo, ["rev-parse", checkpoint])).stdout).toBe(
          before,
        );
      }),
    ),
  );
  it.live.each([3, 90])(
    "keeps a recent unarchived checkout for its configured %s day delay",
    (days) =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* cleanupFixture;
          fixture.setRetention(days);
          fixture.setThreads([
            shell({
              branch: "feature",
              worktreePath: fixture.worktree,
              latestUserMessageAt: fixture.at(-DAY_MS),
            }),
          ]);
          expect((yield* fixture.service.runNow).entries[0]).toMatchObject({ outcome: "kept" });
          expect(yield* fixture.fs.exists(fixture.worktree)).toBe(true);
        }),
      ),
  );
  it.live("reclaims shared archived families but preserves an Off or unarchived owner", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture;
        const first = shell({
          branch: "feature",
          worktreePath: fixture.worktree,
          archivedAt: fixture.at(-1),
        });
        const sibling = shell({
          id: ThreadId.make("sibling"),
          branch: "feature",
          worktreePath: fixture.worktree,
          archivedAt: fixture.at(-1),
        });
        fixture.setThreads([first, { ...sibling, archivedAt: null }]);
        expect((yield* fixture.service.runNow).entries[0]?.reason).toBe("Shared by 2 threads");
        const otherProject = ProjectId.make("off-owner-project");
        fixture.setProjectWholeCleanupOff(otherProject);
        fixture.setThreads([first, { ...sibling, projectId: otherProject }]);
        expect((yield* fixture.service.runNow).entries[0]?.reason).toBe(
          "Whole-worktree cleanup is off for an owner",
        );
        fixture.setThreads([first, sibling]);
        expect((yield* fixture.service.runNow).entries[0]).toMatchObject({ outcome: "removed" });
      }),
    ),
  );
  it.live("protects an archived checkout used through an open output path with cwd elsewhere", () =>
    runCleanupTest(
      Effect.gen(function* () {
        let processPaths: readonly string[] = [];
        const fixture = yield* cleanupFixture.pipe(
          Effect.provideService(
            WorktreeConsumers.ProcessPaths,
            Effect.sync(() => processPaths),
          ),
        );
        fixture.setThreads([
          shell({ branch: "feature", worktreePath: fixture.worktree, archivedAt: fixture.at(-1) }),
        ]);
        processPaths = [`${fixture.worktree}/dist/bin.mjs`];
        const report = yield* fixture.service.runNow;
        expect(report.entries[0]?.reason).toContain("process is using a file");
        expect(yield* fixture.fs.exists(fixture.worktree)).toBe(true);
        processPaths = [];
        expect((yield* fixture.service.runNow).entries[0]).toMatchObject({ outcome: "removed" });
      }),
    ),
  );
  it.live("protects unknown ignored additions made while measuring a clean archived checkout", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        let measuredRoot: string | undefined;
        let additionWritten = false;
        const fixture = yield* cleanupFixture.pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            readDirectory: (directory, options) =>
              Effect.gen(function* () {
                if (directory === measuredRoot && !additionWritten) {
                  additionWritten = true;
                  yield* fs.makeDirectory(`${directory}/.t3`, { recursive: true });
                  yield* fs.writeFileString(
                    `${directory}/.t3/retained-notes.txt`,
                    "new unique notes\n",
                  );
                }
                return yield* fs.readDirectory(directory, options);
              }),
          }),
        );
        measuredRoot = yield* fs.realPath(fixture.worktree);
        fixture.setThreads([
          shell({ branch: "feature", worktreePath: fixture.worktree, archivedAt: fixture.at(-1) }),
        ]);
        expect((yield* fixture.service.runNow).entries[0]).toMatchObject({
          outcome: "kept",
          bytes: null,
        });
        expect(yield* fs.readFileString(`${fixture.worktree}/.t3/retained-notes.txt`)).toBe(
          "new unique notes\n",
        );
      }),
    ),
  );
  it.live.each([".t3/notes.txt", "research/retained.txt", "node_modules/manual.txt"])(
    "preserves unknown ignored %s even for an archived checkout and permissive setting",
    (relative) =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* cleanupFixture;
          fixture.setPolicy("tracked-changes");
          fixture.setThreads([
            shell({
              branch: "feature",
              worktreePath: fixture.worktree,
              archivedAt: fixture.at(-1),
            }),
          ]);
          if (relative.startsWith("research/"))
            yield* fixture.command(fixture.worktree, [
              "config",
              "core.excludesFile",
              `${fixture.repo}/ignore-rules`,
            ]);
          if (relative.startsWith("research/"))
            yield* fixture.fs.writeFileString(`${fixture.repo}/ignore-rules`, "research/\n");
          yield* fixture.fs.makeDirectory(
            `${fixture.worktree}/${relative.split("/").slice(0, -1).join("/")}`,
            { recursive: true },
          );
          yield* fixture.fs.writeFileString(
            `${fixture.worktree}/${relative}`,
            "unique retained bytes\n",
          );
          const report = yield* fixture.service.runNow;
          expect(report.entries[0]).toMatchObject({ outcome: "kept", bytes: null });
          expect(yield* fixture.fs.readFileString(`${fixture.worktree}/${relative}`)).toBe(
            "unique retained bytes\n",
          );
        }),
      ),
  );
  it.live("preserves unrecognized ignored installs without following their links", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, fs, worktree, setPolicy } = yield* cleanupFixture;
        setPolicy("tracked-changes");
        const sizes = yield* Effect.forEach(yield* fs.readDirectory(worktree), (name) =>
          fs.stat(`${worktree}/${name}`).pipe(Effect.map((stat) => Number(stat.size))),
        );
        const outside = yield* fs.makeTempDirectoryScoped();
        yield* fs.writeFileString(`${outside}/external`, "must not count");
        yield* fs.makeDirectory(`${worktree}/node_modules/nested`, { recursive: true });
        yield* fs.writeFileString(`${worktree}/node_modules/nested/file`, "count me");
        yield* fs.symlink(outside, `${worktree}/node_modules/directory-link`);
        yield* fs.symlink(`${outside}/external`, `${worktree}/node_modules/file-link`);
        yield* fs.symlink(`${outside}/missing`, `${worktree}/node_modules/dangling-link`);
        const report = yield* service.runNow;
        expect(sizes.length).toBeGreaterThan(0);
        expect(report.entries[0]).toMatchObject({ outcome: "kept", bytes: null, files: null });
        expect(report.entries[0]?.reason).toContain("ignored files (node_modules/)");
        expect(report.bytesFreed).toBe(0);
        expect(yield* fs.exists(`${worktree}/node_modules/nested/file`)).toBe(true);
        expect(yield* fs.readFileString(`${outside}/external`)).toBe("must not count");
      }),
    ),
  );
  it.live("still removes a worktree when measuring its size fails", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { service, worktree } = yield* cleanupFixture.pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            readDirectory: (directory) => fs.readDirectory(`${directory}/missing-directory`),
          }),
        );
        const report = yield* service.runNow;
        expect(report.entries[0]).toMatchObject({ outcome: "removed", bytes: null, files: null });
        expect(report.bytesFreed).toBe(0);
        expect(yield* fs.exists(worktree)).toBe(false);
      }),
    ),
  );
  it.live.each([
    ["thread", "Thread activity or shared worktree changed since check"],
    ["preview", "Preview is still using the worktree"],
    ["provider", "Provider session is still open"],
  ] as const)("keeps a worktree when %s ownership changes during measurement", ([owner, reason]) =>
    runCleanupTest(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const measuring = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        let measuredPath: string | undefined;
        const fixture = yield* cleanupFixture.pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            readDirectory: (directory) =>
              Effect.gen(function* () {
                if (directory === measuredPath) {
                  yield* Deferred.succeed(measuring, undefined);
                  yield* Deferred.await(resume);
                }
                return yield* fs.readDirectory(directory);
              }),
          }),
        );
        measuredPath = yield* fs.realPath(fixture.worktree);
        fixture.setPolicy("tracked-changes");
        const cleanup = yield* fixture.service.runNow.pipe(Effect.forkChild);
        yield* Deferred.await(measuring);
        if (owner === "thread")
          fixture.setThreads([
            shell({ branch: "feature", worktreePath: fixture.worktree, status: "running" }),
          ]);
        else if (owner === "preview") fixture.setPreviewPaths([fixture.worktree]);
        else fixture.acquireProviderOwnership();
        yield* Deferred.succeed(resume, undefined);
        const report = yield* Fiber.join(cleanup);
        expect(report.entries[0]).toMatchObject({
          outcome: "kept",
          reason,
          bytes: null,
        });
        expect(report.bytesFreed).toBe(0);
        expect(yield* fs.exists(fixture.worktree)).toBe(true);
      }),
    ),
  );
  it.live("does not measure a worktree kept for an open provider session", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const walked: Array<string> = [];
        const fixture = yield* cleanupFixture.pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            readDirectory: (directory, options) => {
              walked.push(directory);
              return fs.readDirectory(directory, options);
            },
          }),
        );
        const root = yield* fs.realPath(fixture.worktree);
        fixture.setOpenSessionCwd(fixture.worktree);
        const kept = yield* fixture.service.runNow;
        expect(kept.entries[0]).toMatchObject({
          outcome: "kept",
          reason: "Provider session is still open",
          bytes: null,
        });
        expect(walked.filter((directory) => directory.startsWith(root))).toEqual([]);
        fixture.setOpenSessionCwd(null);
        const removed = yield* fixture.service.runNow;
        expect(removed.entries[0]).toMatchObject({ outcome: "removed" });
        expect(removed.entries[0]?.bytes).toBeGreaterThan(0);
        expect(walked).toContain(root);
      }),
    ),
  );
  it.live("compares the checked-out branch without a full status", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, fs, worktree, command, setThreads, fullStatusCalls } =
          yield* cleanupFixture;
        const changed = { outcome: "kept", reason: "Repository or branch changed" };
        yield* command(worktree, ["checkout", "--detach"]);
        expect((yield* service.runNow).entries[0]).toMatchObject(changed);
        // A branch that has no commit yet is still a different branch.
        yield* command(worktree, ["switch", "--orphan", "other"]);
        expect((yield* service.runNow).entries[0]).toMatchObject(changed);
        // Status output reserves a leading "(" for a detached HEAD.
        yield* command(worktree, ["switch", "-c", "(feature)", "feature"]);
        setThreads([shell({ branch: "(feature)", worktreePath: worktree })]);
        expect((yield* service.runNow).entries[0]).toMatchObject(changed);
        setThreads([shell({ branch: "feature", worktreePath: worktree })]);
        // Tags named after the branch or HEAD make Git's short names ambiguous.
        yield* command(worktree, ["tag", "feature", "feature"]);
        // Newer Git refuses to create a tag named HEAD, but still reads one.
        yield* command(worktree, ["update-ref", "refs/tags/HEAD", "refs/heads/feature"]);
        yield* command(worktree, ["switch", "feature"]);
        const index = (yield* command(worktree, ["rev-parse", "--git-path", "index"])).stdout;
        yield* fs.writeFileString(`${index.trim()}.lock`, "");
        const locked = (yield* service.runNow).entries[0];
        expect(locked).toMatchObject({ outcome: "failed" });
        expect(locked?.reason).toContain("Git index is locked");
        yield* fs.remove(`${index.trim()}.lock`);
        const gitFile = yield* fs.readFileString(`${worktree}/.git`);
        yield* fs.writeFileString(`${worktree}/.git`, "gitdir: /missing-git-directory\n");
        expect((yield* service.runNow).entries[0]).toMatchObject(changed);
        yield* fs.writeFileString(`${worktree}/.git`, gitFile);
        expect((yield* service.runNow).entries[0]).toMatchObject({ outcome: "removed" });
        expect(fullStatusCalls()).toBe(0);
      }),
    ),
  );
  it("decodes reports from servers without size fields", () => {
    const report = decodeCleanupReport({
      trigger: "manual",
      startedAt: "2026-06-10T12:00:00.000Z",
      finishedAt: "2026-06-10T12:00:01.000Z",
      entries: [
        {
          kind: "worktree",
          outcome: "removed",
          reason: "Removed",
          path: null,
          threadId: null,
          threadTitle: null,
        },
      ],
      counts: { removed: 1, kept: 0, failed: 0 },
      omittedCount: 0,
    });
    expect(report.bytesFreed).toBe(0);
    expect(report.entries[0]).toMatchObject({ bytes: null, files: null });
  });
  it.each([undefined, "dependencies", "future-resource"])(
    "decodes omitted and unfamiliar worktree resource detail: %s",
    (resource) => {
      const report = decodeCleanupReport({
        trigger: "manual",
        startedAt: "2026-06-10T12:00:00.000Z",
        finishedAt: "2026-06-10T12:00:01.000Z",
        entries: [
          {
            kind: "worktree",
            ...(resource === undefined ? {} : { worktreeResource: resource }),
            outcome: "kept",
            reason: "Retained worktree content",
            path: null,
            threadId: null,
            threadTitle: null,
          },
        ],
        counts: { removed: 0, kept: 1, failed: 0 },
        omittedCount: 0,
      });
      expect(report.entries[0]?.worktreeResource).toBe(resource);
      expect(decodeLegacyCleanupReport(encodeCleanupReport(report)).counts).toEqual(report.counts);
    },
  );
  it.live.each([
    ["any-local-files", ".env", "kept"],
    ["uncommitted-changes", ".env", "kept"],
    ["tracked-changes", ".env", "kept"],
    ["any-local-files", "notes.txt", "kept"],
    ["uncommitted-changes", "notes.txt", "kept"],
    ["tracked-changes", "notes.txt", "kept"],
    ["any-local-files", "tracked.txt", "kept"],
    ["uncommitted-changes", "tracked.txt", "kept"],
    ["tracked-changes", "tracked.txt", "kept"],
  ] as const)("applies %j", ([policy, file, outcome]) =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, fs, worktree, setPolicy } = yield* cleanupFixture;
        setPolicy(policy);
        expect(yield* service.latestReport).toBeNull();
        yield* fs.writeFileString(`${worktree}/${file}`, "local data\n");
        const sizes = yield* Effect.forEach(yield* fs.readDirectory(worktree), (name) =>
          fs.stat(`${worktree}/${name}`).pipe(Effect.map((stat) => Number(stat.size))),
        );
        const bytes = sizes.reduce((sum, size) => sum + size, 0);
        const report = yield* service.runNow;
        yield* service.drain;
        expect(report.trigger).toBe("manual");
        expect(
          report.entries.filter(
            (entry) => entry.kind === "worktree" && entry.worktreeResource !== "dependencies",
          ),
        ).toMatchObject([
          {
            outcome,
            path: worktree,
            threadId: "thread-1",
            threadTitle: "Thread",
            bytes: outcome === "removed" ? bytes : null,
            files: null,
          },
        ]);
        expect(report.bytesFreed).toBe(outcome === "removed" ? bytes : 0);
        expect(yield* fs.exists(worktree)).toBe(outcome === "kept");
        expect(yield* service.latestReport).toEqual(report);
        if (outcome === "kept")
          expect(report.entries[0]?.reason).toContain(
            file === ".env" ? "ignored files (.env)" : "uncommitted changes (1 file)",
          );
      }),
    ),
  );
  it.live("preserves tracked edits written after the final status check", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture;
        fixture.setPolicy("tracked-changes");
        fixture.editBeforeRemoval();
        const report = yield* fixture.service.runNow;
        expect(report.entries[0]).toMatchObject({ outcome: "failed", bytes: null, files: null });
        expect(report.bytesFreed).toBe(0);
        expect(report.entries[0]?.reason).toContain("contains modified or untracked files");
        expect(yield* fixture.fs.readFileString(`${fixture.worktree}/tracked.txt`)).toBe(
          "late edit\n",
        );
      }),
    ),
  );
  it.live("streams the current report and subsequent runs", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service } = yield* cleanupFixture;
        const reports = yield* service.reports.pipe(
          Stream.take(2),
          Stream.tap((report) => (report === null ? service.runNow : Effect.void)),
          Stream.runCollect,
        );
        expect(reports[0]).toBeNull();
        expect(reports[1]).toEqual(yield* service.latestReport);
        expect(reports[1]?.counts).toEqual({ removed: 1, kept: 1, failed: 0 });
      }),
    ),
  );
  it.live("caps entries while preserving totals and prioritizing removals", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, fs, worktree, setThreads } = yield* cleanupFixture;
        const threads = [];
        for (let i = 0; i < 205; i++) {
          const worktreePath = `${worktree}-${i}`;
          yield* fs.makeDirectory(worktreePath);
          threads.push(
            shell({
              id: ThreadId.make(`thread-${i + 2}`),
              branch: "feature",
              worktreePath,
              status: "running",
            }),
          );
        }
        threads.push(shell({ branch: "feature", worktreePath: worktree }));
        setThreads(threads);
        const report = yield* service.runNow;
        expect(report.entries).toHaveLength(200);
        expect(report.omittedCount).toBe(7);
        expect(report.counts).toEqual({ removed: 1, kept: 206, failed: 0 });
        expect(report.entries[0]?.outcome).toBe("removed");
        expect(report.entries[0]?.bytes).toBeGreaterThan(0);
        expect(report.bytesFreed).toBe(report.entries[0]?.bytes);
      }),
    ),
  );
  it.live("keeps staged edits in tracked-only mode", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, fs, worktree, setPolicy, command } = yield* cleanupFixture;
        setPolicy("tracked-changes");
        yield* fs.writeFileString(`${worktree}/tracked.txt`, "staged\n");
        yield* command(worktree, ["add", "tracked.txt"]);
        expect((yield* service.runNow).entries[0]).toMatchObject({
          outcome: "kept",
          reason: "Has uncommitted changes (1 file)",
        });
        expect(yield* fs.exists(worktree)).toBe(true);
      }),
    ),
  );
  it.live(
    "reports shared and running worktrees but omits disabled rules and missing directories",
    () =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* cleanupFixture;
          const { service, fs, worktree, setThreads } = fixture;
          setThreads([shell({ branch: "feature", worktreePath: worktree, status: "running" })]);
          expect((yield* service.runNow).entries[0]?.reason).toContain("Thread is running");
          setThreads([
            shell({ branch: "feature", worktreePath: worktree }),
            shell({ id: ThreadId.make("thread-2"), branch: "feature", worktreePath: worktree }),
          ]);
          expect((yield* service.runNow).entries[0]?.reason).toBe("Shared by 2 threads");
          const audit = yield* fs.readFileString(
            `${fixture.config.logsDir}/storage-cleanup.audit.ndjson`,
          );
          expect(audit).toContain('"event":"worktree-decision"');
          expect(audit).toContain('"reason":"Shared by 2 threads"');
          fixture.disable();
          expect(
            (yield* service.runNow).entries.filter(
              (entry) => entry.kind === "worktree" && entry.worktreeResource !== "dependencies",
            ),
          ).toEqual([]);
          yield* fs.remove(worktree, { recursive: true });
          expect(
            (yield* service.runNow).entries.filter(
              (entry) => entry.kind === "worktree" && entry.worktreeResource !== "dependencies",
            ),
          ).toEqual([]);
        }),
      ),
  );
  it.live("persists sweep and dependency decision records in the local audit file", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture;
        fixture.disable();
        fixture.setDependencyPolicy(8);
        yield* fixture.fs.makeDirectory(`${fixture.worktree}/node_modules`, { recursive: true });
        const report = yield* fixture.service.runNow;
        expect(report.entries).toContainEqual(
          expect.objectContaining({
            kind: "worktree",
            worktreeResource: "dependencies",
            outcome: "kept",
            reason: "Dependencies: No dependency install could be safely recognized and measured",
          }),
        );
        const audit = yield* fixture.fs.readFileString(
          `${fixture.config.logsDir}/storage-cleanup.audit.ndjson`,
        );
        expect(audit).toContain('"event":"sweep-start"');
        expect(audit).toContain('"event":"sweep-finish"');
        expect(audit).toContain('"event":"candidate"');
        expect(audit).toContain('"trigger":"manual"');
      }),
    ),
  );
  it.live("removes a supported old dependency install and reports estimated bytes", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture;
        fixture.disable();
        fixture.setDependencyPolicy(8);
        yield* fixture.fs.writeFileString(
          `${fixture.worktree}/package.json`,
          '{"name":"fixture","version":"1.0.0"}',
        );
        yield* fixture.fs.writeFileString(
          `${fixture.worktree}/package-lock.json`,
          '{"name":"fixture","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"fixture","version":"1.0.0"}}}',
        );
        yield* fixture.command(fixture.worktree, [
          "add",
          ".gitignore",
          "package.json",
          "package-lock.json",
        ]);
        yield* fixture.command(fixture.worktree, ["commit", "-m", "add dependency markers"]);
        yield* fixture.fs.makeDirectory(`${fixture.worktree}/node_modules`, { recursive: true });
        yield* fixture.fs.writeFileString(
          `${fixture.worktree}/node_modules/.package-lock.json`,
          '{"name":"fixture","lockfileVersion":3,"packages":{}}',
        );
        const report = yield* fixture.service.runNow;
        expect(report.entries).toContainEqual(
          expect.objectContaining({
            kind: "worktree",
            worktreeResource: "dependencies",
            outcome: "removed",
            reason: "Dependencies: Removed npm dependencies; reclaimed size is estimated",
            path: `${fixture.worktree}/node_modules`,
            bytes: expect.any(Number),
          }),
        );
        expect(yield* fixture.fs.exists(`${fixture.worktree}/node_modules`)).toBe(false);
        const audit = yield* fixture.fs.readFileString(
          `${fixture.config.logsDir}/storage-cleanup.audit.ndjson`,
        );
        expect(audit).toContain('"event":"candidate"');
        expect(audit).toContain('"outcome":"removed"');
      }),
    ),
  );
  it.live("reports revalidation query failures and retains dependency installs", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture;
        fixture.disable();
        fixture.setDependencyPolicy(8);
        yield* fixture.fs.writeFileString(
          `${fixture.worktree}/package.json`,
          '{"name":"fixture","version":"1.0.0"}',
        );
        yield* fixture.fs.writeFileString(
          `${fixture.worktree}/package-lock.json`,
          '{"name":"fixture","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"fixture","version":"1.0.0"}}}',
        );
        yield* fixture.command(fixture.worktree, [
          "add",
          ".gitignore",
          "package.json",
          "package-lock.json",
        ]);
        yield* fixture.command(fixture.worktree, ["commit", "-m", "add dependency markers"]);
        yield* fixture.fs.makeDirectory(`${fixture.worktree}/node_modules`, { recursive: true });
        yield* fixture.fs.writeFileString(
          `${fixture.worktree}/node_modules/.package-lock.json`,
          '{"name":"fixture","lockfileVersion":3,"packages":{}}',
        );
        fixture.failEligibilityRevalidation();
        const report = yield* fixture.service.runNow;
        const detail = "Fixture eligibility revalidation failure";
        const failed = report.entries.find(
          (entry) =>
            entry.kind === "worktree" &&
            entry.worktreeResource === "dependencies" &&
            entry.outcome === "failed",
        );
        expect(failed?.reason).toContain(detail);
        expect(report.counts.failed).toBe(1);
        expect(yield* fixture.fs.exists(`${fixture.worktree}/node_modules`)).toBe(true);
        const auditText = yield* fixture.fs.readFileString(
          `${fixture.config.logsDir}/storage-cleanup.audit.ndjson`,
        );
        expect(auditText).toContain('"event":"candidate"');
        expect(auditText).toContain('"outcome":"failed"');
        expect(auditText).toContain(detail);
      }),
    ),
  );
  it.live("does not report dependency cleanup after its worktree was removed", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture;
        fixture.setDependencyPolicy(8);

        const report = yield* fixture.service.runNow;
        expect(report.entries).toContainEqual(
          expect.objectContaining({
            kind: "worktree",
            outcome: "removed",
            path: fixture.worktree,
          }),
        );
        expect(report.counts).toEqual({ removed: 1, kept: 0, failed: 0 });
        expect(
          report.entries.filter(
            (entry) => entry.kind === "worktree" && entry.worktreeResource === "dependencies",
          ),
        ).toEqual([]);
        const auditText = yield* fixture.fs.readFileString(
          `${fixture.config.logsDir}/storage-cleanup.audit.ndjson`,
        );
        const auditRecords = auditText
          .trim()
          .split("\n")
          .map(
            (line) =>
              JSON.parse(line) as {
                event?: string;
                kind?: string;
                worktreeResource?: string;
              },
          );
        expect(
          auditRecords.filter(
            (record) =>
              record.event === "candidate" &&
              record.kind === "worktree" &&
              record.worktreeResource === "dependencies",
          ),
        ).toEqual([]);
      }),
    ),
  );
  it.live("does not report deleted threads with disabled dependency cleanup", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture;
        fixture.disable();
        fixture.setDependencyPolicy(8);
        const disabledProjectId = ProjectId.make("disabled-dependency-project");
        const deletedThread = shell({
          id: ThreadId.make("deleted-disabled-dependency"),
          projectId: disabledProjectId,
          branch: "feature",
          worktreePath: fixture.worktree,
          createdAt: at(-40 * DAY_MS),
          updatedAt: at(-30 * DAY_MS),
          deletedAt: at(-30 * DAY_MS),
        });
        const payload = encodeFullThread(
          decodeFullThread({
            ...deletedThread,
            createdAt: DateTime.formatIso(deletedThread.createdAt),
            updatedAt: DateTime.formatIso(deletedThread.updatedAt),
            deletedAt: DateTime.formatIso(deletedThread.deletedAt!),
          }),
        );
        fixture.setThreads([]);
        fixture.setProjectWorktreeCleanupOff(disabledProjectId);
        fixture.setDeletedDependencyRows([
          { payload_json: payload, workspaceRoot: fixture.repo, latestEventAt: null },
        ]);

        const report = yield* fixture.service.runNow;
        expect(
          report.entries.some(
            (entry) =>
              entry.kind === "worktree" &&
              entry.worktreeResource === "dependencies" &&
              entry.threadId === deletedThread.id &&
              entry.path === `${fixture.worktree}/node_modules`,
          ),
        ).toBe(false);
        const auditText = yield* fixture.fs.readFileString(
          `${fixture.config.logsDir}/storage-cleanup.audit.ndjson`,
        );
        expect(auditText).not.toContain(String(deletedThread.id));
        expect(yield* fixture.fs.exists(fixture.worktree)).toBe(true);
      }),
    ),
  );
  it.live("reports a preview-protected dependency candidate once", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture;
        fixture.disable();
        fixture.setDependencyPolicy(8);
        fixture.setPreviewPaths([fixture.worktree]);
        yield* fixture.fs.writeFileString(
          `${fixture.worktree}/package.json`,
          '{"name":"fixture","version":"1.0.0"}',
        );
        yield* fixture.fs.writeFileString(
          `${fixture.worktree}/package-lock.json`,
          '{"name":"fixture","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"fixture","version":"1.0.0"}}}',
        );
        yield* fixture.command(fixture.worktree, [
          "add",
          ".gitignore",
          "package.json",
          "package-lock.json",
        ]);
        yield* fixture.command(fixture.worktree, ["commit", "-m", "add dependency markers"]);
        yield* fixture.fs.makeDirectory(`${fixture.worktree}/node_modules`, { recursive: true });
        yield* fixture.fs.writeFileString(
          `${fixture.worktree}/node_modules/.package-lock.json`,
          '{"name":"fixture","lockfileVersion":3,"packages":{}}',
        );

        const report = yield* fixture.service.runNow;
        const dependencyEntries = report.entries.filter(
          (entry) => entry.kind === "worktree" && entry.worktreeResource === "dependencies",
        );
        expect(dependencyEntries).toHaveLength(1);
        expect(dependencyEntries[0]).toMatchObject({
          outcome: "kept",
          reason:
            "Dependencies: A preview is using this worktree, or preview ownership could not be checked",
          path: `${fixture.worktree}/node_modules`,
        });
        expect(yield* fixture.fs.exists(`${fixture.worktree}/node_modules`)).toBe(true);
      }),
    ),
  );
  it.live("skips disabled automatic Git inventories while retaining manual discovery", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture;
        fixture.disable();
        const orphan = `${fixture.config.worktreesDir}/manual-only-orphan`;
        yield* fixture.command(fixture.repo, ["worktree", "add", "--detach", orphan, "HEAD"]);
        const automatic = yield* fixture.service.reports.pipe(
          Stream.filter((report) => report?.trigger === "automatic"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* fixture.activate();
        const [automaticReport] = yield* Fiber.join(automatic);
        expect(automaticReport?.trigger).toBe("automatic");
        expect(fixture.worktreeInventoryCalls()).toBe(0);
        expect(automaticReport?.entries.some((entry) => entry.path === orphan)).toBe(false);

        const manual = yield* fixture.service.runNow;
        expect(fixture.worktreeInventoryCalls()).toBe(1);
        expect(manual.entries).toContainEqual(
          expect.objectContaining({
            path: orphan,
            reason: "No owning thread; retained for review",
          }),
        );
        expect(yield* fixture.fs.exists(orphan)).toBe(true);
      }),
    ),
  );
  it.live("inventories automatic runs when dependency cleanup is enabled", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture;
        fixture.disable();
        fixture.setDependencyPolicy(8);
        const orphan = `${fixture.config.worktreesDir}/automatic-orphan`;
        yield* fixture.command(fixture.repo, ["worktree", "add", "--detach", orphan, "HEAD"]);
        const automatic = yield* fixture.service.reports.pipe(
          Stream.filter((report) => report?.trigger === "automatic"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* fixture.activate();
        const [report] = yield* Fiber.join(automatic);
        expect(fixture.worktreeInventoryCalls()).toBe(1);
        expect(report?.entries).toContainEqual(
          expect.objectContaining({
            path: orphan,
            reason: "No owning thread; retained for review",
          }),
        );
        expect(yield* fixture.fs.exists(orphan)).toBe(true);
      }),
    ),
  );
  it.live("reports and retains a registered worktree without a thread owner", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture;
        const orphan = `${fixture.config.worktreesDir}/orphan`;
        yield* fixture.command(fixture.repo, ["worktree", "add", "--detach", orphan, "HEAD"]);
        const report = yield* fixture.service.runNow;
        expect(report.entries).toContainEqual(
          expect.objectContaining({
            kind: "worktree",
            outcome: "kept",
            path: orphan,
            reason: "No owning thread; retained for review",
            threadId: null,
          }),
        );
        expect(yield* fixture.fs.exists(orphan)).toBe(true);
      }),
    ),
  );
  it.live("matches registered worktrees under a symlinked managed root", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture;
        fixture.disable();
        const realRoot = `${fixture.config.baseDir}/real-worktrees`;
        const linkedRoot = `${fixture.config.baseDir}/linked-worktrees`;
        const orphan = `${realRoot}/orphan`;
        const ownedViaAlias = `${linkedRoot}/owned`;
        const canonicalOwnedPath = `${realRoot}/owned`;
        yield* fixture.fs.makeDirectory(realRoot, { recursive: true });
        yield* fixture.fs.symlink(realRoot, linkedRoot);
        fixture.setManagedWorktreeDirectories(linkedRoot, []);
        yield* fixture.command(fixture.repo, ["worktree", "add", "--detach", orphan, "HEAD"]);
        yield* fixture.command(fixture.repo, [
          "worktree",
          "add",
          "--detach",
          ownedViaAlias,
          "HEAD",
        ]);
        fixture.setThreads([
          shell({ branch: "feature", worktreePath: fixture.worktree }),
          shell({ id: ThreadId.make("symlink-owner"), worktreePath: ownedViaAlias }),
        ]);

        const report = yield* fixture.service.runNow;
        expect(report.entries).toContainEqual(
          expect.objectContaining({
            kind: "worktree",
            outcome: "kept",
            path: orphan,
            reason: "No owning thread; retained for review",
          }),
        );
        expect(
          report.entries.some(
            (entry) =>
              entry.path === canonicalOwnedPath &&
              entry.reason === "No owning thread; retained for review",
          ),
        ).toBe(false);
        expect(yield* fixture.fs.exists(orphan)).toBe(true);
        expect(yield* fixture.fs.exists(canonicalOwnedPath)).toBe(true);
      }),
    ),
  );
  it.live("uses fresh thread ownership after dependency inspection before orphan inventory", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture;
        fixture.disable();
        fixture.setDependencyPolicy(8);
        const newlyOwned = `${fixture.config.worktreesDir}/newly-owned`;
        yield* fixture.command(fixture.repo, ["worktree", "add", "--detach", newlyOwned, "HEAD"]);
        fixture.addThreadOnDependencyInspection(
          shell({
            id: ThreadId.make("new-owner"),
            branch: "main",
            worktreePath: newlyOwned,
          }),
        );
        yield* fixture.fs.writeFileString(
          `${fixture.worktree}/package.json`,
          '{"name":"fixture","version":"1.0.0"}',
        );
        yield* fixture.fs.writeFileString(
          `${fixture.worktree}/package-lock.json`,
          '{"name":"fixture","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"fixture","version":"1.0.0"}}}',
        );
        yield* fixture.command(fixture.worktree, [
          "add",
          ".gitignore",
          "package.json",
          "package-lock.json",
        ]);
        yield* fixture.command(fixture.worktree, ["commit", "-m", "add dependency markers"]);
        yield* fixture.fs.makeDirectory(`${fixture.worktree}/node_modules`, { recursive: true });
        yield* fixture.fs.writeFileString(
          `${fixture.worktree}/node_modules/.package-lock.json`,
          '{"name":"fixture","lockfileVersion":3,"packages":{}}',
        );

        const report = yield* fixture.service.runNow;
        expect(
          report.entries.filter(
            (entry) =>
              entry.path === newlyOwned && entry.reason === "No owning thread; retained for review",
          ),
        ).toEqual([]);
        expect(yield* fixture.fs.exists(newlyOwned)).toBe(true);
      }),
    ),
  );
  it.live("does not label a worktree unowned when ownership appears during Git inventory", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture;
        fixture.disable();
        const ownedDuringInventory = `${fixture.config.worktreesDir}/owned-during-inventory`;
        yield* fixture.command(fixture.repo, [
          "worktree",
          "add",
          "--detach",
          ownedDuringInventory,
          "HEAD",
        ]);
        fixture.addThreadOnWorktreeInventory(
          shell({
            id: ThreadId.make("inventory-owner"),
            branch: "main",
            worktreePath: ownedDuringInventory,
          }),
        );

        const report = yield* fixture.service.runNow;
        expect(
          report.entries.some(
            (entry) =>
              entry.path === ownedDuringInventory &&
              entry.reason === "No owning thread; retained for review",
          ),
        ).toBe(false);
        const auditText = yield* fixture.fs.readFileString(
          `${fixture.config.logsDir}/storage-cleanup.audit.ndjson`,
        );
        const auditRecords = auditText
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { event?: string; path?: string });
        expect(
          auditRecords.some(
            (record) => record.event === "unowned-worktree" && record.path === ownedDuringInventory,
          ),
        ).toBe(false);
        expect(yield* fixture.fs.exists(ownedDuringInventory)).toBe(true);
      }),
    ),
  );
  it.live(
    "finds retained worktrees across configured roots once when projects share a repository",
    () =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* cleanupFixture;
          fixture.disable();
          const current = `${fixture.config.baseDir}/configured-worktrees`;
          const previous = `${fixture.config.baseDir}/previous-worktrees`;
          const first = `${current}/orphan-one`;
          const second = `${previous}/orphan-two`;
          yield* fixture.fs.makeDirectory(current, { recursive: true });
          yield* fixture.fs.makeDirectory(previous, { recursive: true });
          yield* fixture.fs.makeDirectory(`${fixture.repo}/nested-project`, { recursive: true });
          fixture.setManagedWorktreeDirectories(current, [previous]);
          fixture.setProjectRoots([
            { id: ProjectId.make("project-1"), workspaceRoot: fixture.repo },
            { id: ProjectId.make("project-2"), workspaceRoot: `${fixture.repo}/nested-project` },
          ]);
          yield* fixture.command(fixture.repo, ["worktree", "add", "--detach", first, "HEAD"]);
          yield* fixture.command(fixture.repo, ["worktree", "add", "--detach", second, "HEAD"]);

          const report = yield* fixture.service.runNow;
          const orphanEntries = report.entries.filter(
            (entry) => entry.reason === "No owning thread; retained for review",
          );
          expect(orphanEntries.map((entry) => entry.path).sort()).toEqual([first, second].sort());
          expect(fixture.worktreeInventoryCalls()).toBe(1);
          expect(yield* fixture.fs.exists(first)).toBe(true);
          expect(yield* fixture.fs.exists(second)).toBe(true);
        }),
      ),
  );
  it.live("keeps concurrent dependency audit writes valid across rotation", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture;
        fixture.disable();
        fixture.setDependencyPolicy(8);
        const worktrees = Array.from(
          { length: 4 },
          (_, index) => `${fixture.config.worktreesDir}/dependency-${index}`,
        );
        yield* Effect.forEach(worktrees, (worktree, index) =>
          fixture.command(fixture.repo, ["worktree", "add", "-b", `dependency-${index}`, worktree]),
        );
        fixture.setThreads(
          worktrees.map((worktree, index) =>
            shell({
              id: ThreadId.make(`dependency-thread-${index}`),
              branch: `dependency-${index}`,
              worktreePath: worktree,
            }),
          ),
        );
        yield* Effect.forEach(worktrees, (worktree) =>
          fixture.fs.makeDirectory(`${worktree}/node_modules`, { recursive: true }),
        );
        const auditPath = `${fixture.config.logsDir}/storage-cleanup.audit.ndjson`;
        yield* fixture.fs.writeFileString(
          auditPath,
          `${JSON.stringify({ event: "padding", value: "x".repeat(512 * 1024 - 600) })}\n`,
        );

        yield* fixture.service.runNow;
        const files = [auditPath, `${auditPath}.1`];
        const records = yield* Effect.forEach(files, (file) =>
          fixture.fs.readFileString(file).pipe(
            Effect.map((contents) =>
              contents
                .trim()
                .split("\n")
                .filter(Boolean)
                .map((line) => JSON.parse(line) as { event?: string }),
            ),
            Effect.catch(() => Effect.succeed([] as Array<{ event?: string }>)),
          ),
        );
        expect(records.flat().filter((record) => record.event === "candidate")).toHaveLength(4);
      }),
    ),
  );
  it.live("continues cleanup when the durable audit destination cannot be created", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const fixture = yield* cleanupFixture.pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            writeFileString: (target, contents, options) =>
              target.endsWith("storage-cleanup.audit.ndjson")
                ? fs.writeFileString(`${target}/child`, contents, options)
                : fs.writeFileString(target, contents, options),
          }),
        );
        const report = yield* fixture.service.runNow;
        expect(report.entries).toContainEqual(
          expect.objectContaining({ kind: "worktree", outcome: "removed" }),
        );
        expect(
          yield* fixture.fs.exists(`${fixture.config.logsDir}/storage-cleanup.audit.ndjson`),
        ).toBe(false);
      }),
    ),
  );
  it.live("reports and audits a dependency inventory failure while continuing file cleanup", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture;
        fixture.disable();
        fixture.setDependencyPolicy(8);
        fixture.enableFiles();
        fixture.failNextDependencyRead();

        const report = yield* fixture.service.runNow;
        expect(report.entries).toContainEqual(
          expect.objectContaining({
            kind: "worktree",
            worktreeResource: "dependencies",
            outcome: "failed",
            reason: expect.stringContaining("Fixture dependency query failure"),
            path: null,
            threadId: null,
            threadTitle: null,
          }),
        );
        expect(report.counts.failed).toBe(1);
        expect(report.entries.some((entry) => entry.kind === "browser-artifacts")).toBe(true);
        expect(report.entries.some((entry) => entry.kind === "logs")).toBe(true);

        const auditText = yield* fixture.fs.readFileString(
          `${fixture.config.logsDir}/storage-cleanup.audit.ndjson`,
        );
        expect(auditText).toContain('"event":"dependency-cleanup-failed"');
        expect(auditText).toContain('"worktreeResource":"dependencies"');
        expect(auditText).toContain('"Fixture dependency query failure"');
      }),
    ),
  );
  it.live("reports and audits a Git inventory failure without labeling paths unowned", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture;
        fixture.failNextGitInventory();
        const report = yield* fixture.service.runNow;
        const failed = report.entries.find(
          (entry) => entry.kind === "worktree" && entry.outcome === "failed",
        );
        expect(failed).toMatchObject({
          outcome: "failed",
          reason: expect.stringContaining("Fixture Git inventory failure"),
          path: fixture.repo,
        });
        expect(report.counts.failed).toBeGreaterThanOrEqual(1);
        expect(report.entries).not.toContainEqual(
          expect.objectContaining({ reason: "No owning thread; retained for review" }),
        );
        const auditText = yield* fixture.fs.readFileString(
          `${fixture.config.logsDir}/storage-cleanup.audit.ndjson`,
        );
        expect(auditText).toContain('"event":"worktree-inventory-failed"');
        expect(auditText).toContain('"reason":"git worktree list: Fixture Git inventory failure"');
      }),
    ),
  );
  it.live(
    "reports repository identity and canonical path failures but ignores non-Git projects",
    () =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* cleanupFixture;
          fixture.disable();
          for (const [mode, expectedReason] of [
            ["command-error", "Fixture Git identity execution failure"],
            ["malformed", "successful Git identity output was empty or malformed"],
            ["missing-git-dir", "FileSystem.realPath"],
          ] as const) {
            fixture.setInventoryIdentityMode(mode);
            const report = yield* fixture.service.runNow;
            expect(report.entries).toContainEqual(
              expect.objectContaining({
                kind: "worktree",
                outcome: "failed",
                path: fixture.repo,
                reason: expect.stringContaining(expectedReason),
              }),
            );
            const auditText = yield* fixture.fs.readFileString(
              `${fixture.config.logsDir}/storage-cleanup.audit.ndjson`,
            );
            expect(auditText).toContain('"event":"worktree-inventory-failed"');
            expect(auditText).toContain(expectedReason);
          }

          fixture.setInventoryIdentityMode("not-git");
          const auditBefore = yield* fixture.fs.readFileString(
            `${fixture.config.logsDir}/storage-cleanup.audit.ndjson`,
          );
          const report = yield* fixture.service.runNow;
          expect(report.entries).not.toContainEqual(
            expect.objectContaining({
              kind: "worktree",
              outcome: "failed",
              path: fixture.repo,
            }),
          );
          const auditText = yield* fixture.fs.readFileString(
            `${fixture.config.logsDir}/storage-cleanup.audit.ndjson`,
          );
          expect(auditText.match(/"event":"worktree-inventory-failed"/g)?.length).toBe(
            auditBefore.match(/"event":"worktree-inventory-failed"/g)?.length,
          );
        }),
      ),
  );
  it.live("audits managed worktree root canonicalization failures", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture;
        fixture.disable();
        fixture.failManagedRootCanonicalization();
        const report = yield* fixture.service.runNow;
        expect(report.entries).toContainEqual(
          expect.objectContaining({
            kind: "worktree",
            outcome: "failed",
            path: fixture.config.worktreesDir,
            reason: expect.stringContaining("FileSystem.realPath"),
          }),
        );
        expect(report.counts.failed).toBe(1);
        const auditText = yield* fixture.fs.readFileString(
          `${fixture.config.logsDir}/storage-cleanup.audit.ndjson`,
        );
        expect(auditText).toContain('"event":"worktree-inventory-failed"');
        expect(auditText).toContain("FileSystem.realPath (");
      }),
    ),
  );
  it.live(
    "reports and audits outer worktree inventory failures while continuing file cleanup",
    () =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* cleanupFixture;
          fixture.failProjectInventory();
          fixture.enableFiles();
          const report = yield* fixture.service.runNow;
          expect(report.entries).toContainEqual(
            expect.objectContaining({
              kind: "worktree",
              outcome: "failed",
              reason: "Project store operation 'listShells' failed.",
            }),
          );
          expect(report.counts.failed).toBeGreaterThanOrEqual(1);
          expect(report.entries.some((entry) => entry.kind === "browser-artifacts")).toBe(true);
          expect(report.entries.some((entry) => entry.kind === "logs")).toBe(true);
          const auditText = yield* fixture.fs.readFileString(
            `${fixture.config.logsDir}/storage-cleanup.audit.ndjson`,
          );
          expect(auditText).toContain('"event":"worktree-ownership-audit-failed"');
          expect(auditText).toContain("Project store operation 'listShells' failed.");
        }),
      ),
  );
  it.live("serializes concurrent requests and returns each run's report", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service } = yield* cleanupFixture;
        const reports = yield* Effect.all([service.runNow, service.runNow], {
          concurrency: "unbounded",
        });
        yield* service.drain;
        expect(
          reports
            .flatMap((report) => report.entries)
            .filter(
              (entry) => entry.kind === "worktree" && entry.worktreeResource !== "dependencies",
            ),
        ).toMatchObject([{ outcome: "removed" }]);
        expect(yield* service.latestReport).toEqual(reports[1]);
      }),
    ),
  );
  it.live("aggregates expired artifacts and rotated logs while retaining current logs", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, fs, config, enableFiles, disable } = yield* cleanupFixture;
        disable();
        enableFiles();
        yield* fs.makeDirectory(config.browserArtifactsDir, { recursive: true });
        yield* fs.makeDirectory(config.logsDir, { recursive: true });
        for (const name of ["one.png", "two.webm"]) {
          const file = config.browserArtifactsDir + "/" + name;
          yield* fs.writeFileString(file, "capture");
          yield* fs.utimes(file, 1, 1);
        }
        for (const name of ["server.log.1", "server.log.2", "server.log"]) {
          const file = config.logsDir + "/" + name;
          yield* fs.writeFileString(file, "log");
          yield* fs.utimes(file, 1, 1);
        }
        const report = yield* service.runNow;
        expect(
          report.entries.filter(
            (entry) => entry.kind === "browser-artifacts" || entry.kind === "logs",
          ),
        ).toMatchObject([
          {
            kind: "browser-artifacts",
            outcome: "removed",
            reason: "Removed 2 browser artifacts",
            bytes: 14,
            files: 2,
          },
          {
            kind: "logs",
            outcome: "removed",
            reason: "Removed 2 rotated logs",
            bytes: 6,
            files: 2,
          },
        ]);
        expect(report.bytesFreed).toBe(20);
        expect(yield* fs.readDirectory(config.browserArtifactsDir)).toEqual([]);
        expect(yield* fs.exists(config.logsDir + "/server.log")).toBe(true);
        expect(yield* fs.exists(config.logsDir + "/server.log.1")).toBe(false);
        expect(yield* fs.exists(config.logsDir + "/server.log.2")).toBe(false);
      }),
    ),
  );
  it.live("reports git failures without aborting the remaining categories", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture;
        const { service, worktree, command, enableFiles } = fixture;
        enableFiles();
        yield* command(worktree, ["worktree", "lock", worktree]);
        const report = yield* service.runNow;
        expect(report.entries[0]).toMatchObject({ outcome: "failed" });
        expect(report.entries[0]?.reason).toContain("git worktree remove: fatal:");
        expect(report.entries.map((entry) => entry.kind)).toEqual([
          "worktree",
          "worktree",
          "browser-artifacts",
          "logs",
        ]);
        const auditText = yield* fixture.fs.readFileString(
          `${fixture.config.logsDir}/storage-cleanup.audit.ndjson`,
        );
        expect(auditText).toContain('"event":"worktree-decision"');
        expect(auditText).toContain("cannot remove a locked working tree");
      }),
    ),
  );
  it.live("audits top-level worktree cleanup failures and continues file cleanup", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture;
        fixture.failNextWorktreeRead();
        fixture.enableFiles();
        const report = yield* fixture.service.runNow;
        expect(report.entries).toContainEqual(
          expect.objectContaining({
            kind: "worktree",
            outcome: "failed",
            reason: expect.stringContaining("Fixture worktree query failure"),
          }),
        );
        expect(report.counts.failed).toBe(1);
        expect(report.entries.some((entry) => entry.kind === "browser-artifacts")).toBe(true);
        expect(report.entries.some((entry) => entry.kind === "logs")).toBe(true);
        const auditText = yield* fixture.fs.readFileString(
          `${fixture.config.logsDir}/storage-cleanup.audit.ndjson`,
        );
        expect(auditText).toContain('"event":"worktree-cleanup-failed"');
        expect(auditText).toContain('"Fixture worktree query failure"');
      }),
    ),
  );
  it.live("reports and audits file cleanup failures while continuing other categories", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture;
        fixture.disable();
        fixture.enableFiles();
        yield* fixture.fs.makeDirectory(fixture.config.browserArtifactsDir, { recursive: true });
        yield* fixture.fs.remove(fixture.config.browserArtifactsDir, { recursive: true });
        yield* fixture.fs.writeFileString(fixture.config.browserArtifactsDir, "not a directory");

        const report = yield* fixture.service.runNow;
        const failed = report.entries.find(
          (entry) => entry.kind === "browser-artifacts" && entry.outcome === "failed",
        );
        expect(failed?.reason).toEqual(expect.any(String));
        expect(report.counts.failed).toBe(1);
        expect(report.entries.some((entry) => entry.kind === "logs")).toBe(true);
        const auditText = yield* fixture.fs.readFileString(
          `${fixture.config.logsDir}/storage-cleanup.audit.ndjson`,
        );
        expect(auditText).toContain('"event":"file-cleanup-failed"');
        expect(auditText).toContain('"kind":"browser-artifacts"');
        expect(auditText).toContain(JSON.stringify(failed?.reason));
      }),
    ),
  );
});
