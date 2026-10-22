import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { observeDependencyActivity } from "@t3tools/shared/dependencyActivity";
import {
  createGeneratedBuildStage,
  generatedBuildActivity,
  observeLegacyBuild,
  recordGeneratedBuildUse,
} from "@t3tools/shared/generatedBuildOwnership";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { SCAN_CACHE_FILE_NAME } from "./usage/usageScanCache.ts";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";
import {
  DEFAULT_SERVER_SETTINGS,
  GitCommandError,
  OrchestrationV2AppThreadJson,
  StorageCleanupReport,
  type WorktreeKeepWhen,
  type StorageCleanupSettings,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ServerConfig from "./config.ts";
import * as StorageCleanup from "./storageCleanup.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as VcsProcess from "./vcs/VcsProcess.ts";
import * as PreviewHosting from "./preview/Hosting.ts";
import * as ProviderSessionManager from "./orchestration-v2/ProviderSessionManager.ts";
import * as GitManager from "./git/GitManager.ts";
import * as Settings from "./serverSettings.ts";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";
import * as WorktreeCleanup from "./orchestration-v2/WorktreeCleanupService.ts";
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
  type OrchestrationV2DomainEvent,
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
const decodeHistoricalReport = Schema.decodeSync(
  Schema.Struct({
    trigger: Schema.Literals(["automatic", "manual"]),
    startedAt: Schema.String,
    finishedAt: Schema.String,
    entries: Schema.Array(
      Schema.Struct({
        kind: Schema.Literals(["worktree", "browser-artifacts", "logs"]),
        outcome: Schema.Literals(["removed", "kept", "failed"]),
        reason: Schema.String,
        path: Schema.NullOr(Schema.String),
        threadId: Schema.NullOr(Schema.String),
        threadTitle: Schema.NullOr(Schema.String),
      }),
    ),
    counts: Schema.Struct({ removed: Schema.Number, kept: Schema.Number, failed: Schema.Number }),
    omittedCount: Schema.Number,
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

const allocatedBytes = (fs: FileSystem.FileSystem, file: string) =>
  fs.stat(file).pipe(
    Effect.map((stat) =>
      Option.getOrElse(
        Option.map(stat.blocks, (blocks) => Number(blocks) * 512),
        () => Number(stat.size),
      ),
    ),
  );

const projectShells = (roots: ReadonlyArray<string>) =>
  roots.map((workspaceRoot, index) => ({
    id: ProjectId.make(`project-${index + 1}`),
    workspaceRoot,
  }));

const cleanupFixture = (
  storageCleanup: StorageCleanupSettings = {
    ...DEFAULT_SERVER_SETTINGS.storageCleanup,
    worktreeAfterDays: 8,
    worktreeOnDelete: true,
  },
  eventSql?: SqlClient.SqlClient,
) =>
  Effect.gen(function* () {
    const fixtureNow = yield* Clock.currentTimeMillis;
    const fs = yield* FileSystem.FileSystem;
    const initialConfig = yield* ServerConfig.ServerConfig;
    // macOS temporary directories can be reached through /var's symlink. Use
    // canonical roots so these tests exercise cleanup rather than its link guard.
    const baseDir = yield* fs.makeTempDirectory({
      directory: yield* fs.realPath(initialConfig.baseDir),
      prefix: "fixture-",
    });
    const config = {
      ...initialConfig,
      baseDir,
      ...(yield* ServerConfig.deriveServerPaths(baseDir, undefined)),
    };
    yield* fs.makeDirectory(config.logsDir, { recursive: true });
    const git = yield* GitVcsDriver.GitVcsDriver;
    const repo = yield* fs
      .makeTempDirectoryScoped({ prefix: "cleanup-repo-" })
      .pipe(Effect.flatMap((directory) => fs.realPath(directory)));
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
      storageCleanup,
    };
    let threads = [shell({ branch: "feature", worktreePath: worktree })];
    let storedWorktreePaths = [worktree];
    let historicalOwners: Array<{
      threadId: string;
      projectId: string;
      branch: string | null;
      worktreePath: string | null;
    }> = [];
    let failHistoricalOwners = false;
    let projectRoots = [{ id: ProjectId.make("project-1"), workspaceRoot: repo }];
    let editBeforeRemoval = false;
    let onDependencyInspection: (() => void) | null = null;
    let onWorktreeInventory: (() => void) | null = null;
    let worktreeInventoryCalls = 0;
    let failManagedRootCanonicalization = false;
    let failNextGitInventory = false;
    let inventoryIdentityMode:
      | "command-error"
      | "malformed"
      | "missing-git-dir"
      | "not-git"
      | null = null;
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
    let snapshotReads = 0;
    let events: Stream.Stream<OrchestrationV2DomainEvent> = Stream.empty;
    let previewPaths: ReadonlyArray<string> = [];
    let ownershipRevision = 0;
    let dependencyInspectionHook: Effect.Effect<void> | null = null;
    const terminalListeners: Parameters<
      TerminalManager.TerminalManager["Service"]["subscribeMetadata"]
    >[0][] = [];
    const context = yield* Layer.build(StorageCleanup.layer).pipe(
      Effect.provide(
        Layer.mock(WorktreeCleanup.WorktreeCleanupService)({
          historicalWorktreeOwners: Effect.suspend(() =>
            failHistoricalOwners
              ? Effect.fail(
                  new WorktreeCleanup.WorktreeCleanupError({
                    threadId: ThreadId.make("cleanup-owner-scan"),
                    cause: new Error("Historical owner inventory unavailable"),
                  }),
                )
              : Effect.succeed(historicalOwners),
          ),
        }),
      ),
      Effect.provideService(ServerConfig.ServerConfig, config),
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        realPath: (target: string) =>
          failManagedRootCanonicalization && target === config.worktreesDir
            ? fs.realPath(`${target}/unavailable-canonicalization-fixture`)
            : fs.realPath(target),
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
        list: () => Effect.sync(() => projectRoots),
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
        getShellSnapshot: (input?: { location?: string }) =>
          Effect.sync(() => {
            snapshotReads++;
            const active = (thread: OrchestrationV2ThreadShell) =>
              thread.archivedAt === null ||
              (thread.deletedAt !== null && thread.worktreeCleanup != null);
            const visible = threads.filter(
              (thread) =>
                (thread.deletedAt === null || thread.worktreeCleanup != null) &&
                (input?.location === "active"
                  ? active(thread)
                  : input?.location === "archive"
                    ? !active(thread)
                    : true),
            );
            return {
              threads: visible.filter(active),
              archivedThreads: visible.filter((thread) => !active(thread)),
            };
          }),
        getThreadWorktreePaths: (input?: { includeArchived?: boolean }) =>
          Effect.sync(() =>
            threads.flatMap((thread) =>
              thread.deletedAt === null &&
              (input?.includeArchived === true || thread.archivedAt === null) &&
              thread.worktreePath !== null
                ? [{ threadId: thread.id, worktreePath: thread.worktreePath }]
                : [],
            ),
          ),
        getThreadShell: (threadId: ThreadId) =>
          Effect.sync(() => threads.find((thread) => thread.id === threadId) ?? null),
      } as unknown as ProjectionStore.ProjectionStoreV2["Service"]),
      Effect.provideService(Orchestrator.OrchestratorV2, {
        streamDomainEvents: Stream.suspend(() => events),
      } as unknown as Orchestrator.OrchestratorV2["Service"]),
      Effect.provideService(
        SqlClient.SqlClient,
        Object.assign(
          (strings: TemplateStringsArray, ...values: unknown[]) => {
            const query = strings.join("");
            if (
              eventSql !== undefined &&
              query.includes("FROM orchestration_events") &&
              !query.includes("FROM orchestration_v2_projection_threads")
            )
              return eventSql(strings, ...values);
            if (
              failDependencyRead &&
              query.includes("FROM orchestration_v2_projection_threads t")
            ) {
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
            if (
              failWorktreeRead &&
              query.includes("WHERE t.deleted_at IS NOT NULL") &&
              !query.includes('AS "latestEventAt"')
            ) {
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
              query.includes("stream_id IN") &&
              query.includes("event_type NOT IN (")
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
              if (query.includes('AS "threadId"') && query.includes('AS "worktreePath"'))
                return threads.map((thread) => ({
                  threadId: thread.id,
                  worktreePath: thread.worktreePath,
                }));
              if (query.includes('AS "worktreePath"'))
                return [
                  ...threads.flatMap((thread) => thread.worktreePath ?? []),
                  ...storedWorktreePaths,
                ].map((worktreePath) => ({ worktreePath }));
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
          { in: eventSql?.in ?? ((values: ReadonlyArray<unknown>) => values) },
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
      setHistoricalOwners: (owners: typeof historicalOwners) => {
        historicalOwners = owners;
      },
      failHistoricalOwners: () => {
        failHistoricalOwners = true;
      },
      service: Context.get(context, StorageCleanup.StorageCleanup),
      activate: (domainEvents: Stream.Stream<OrchestrationV2DomainEvent> = events) => {
        events = domainEvents;
        return Deferred.succeed(activation, undefined);
      },
      worktreeInventoryCalls: () => worktreeInventoryCalls,
      now: fixtureNow,
      seedAgedDependencyUse,
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
            worktreeOnDelete: false,
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
        settings = {
          ...settings,
          storageCleanup: { ...settings.storageCleanup, worktreeKeepWhen },
        };
      },
      setDependencyPolicy: (days: number | null) => {
        settings = {
          ...settings,
          storageCleanup: { ...settings.storageCleanup, worktreeDependenciesAfterDays: days },
        };
      },
      setRetention: (worktreeAfterDays: number | null) => {
        settings = {
          ...settings,
          storageCleanup: { ...settings.storageCleanup, worktreeAfterDays },
        };
      },
      setDependencyRetention: (days: number | null) => {
        settings = {
          ...settings,
          storageCleanup: {
            ...settings.storageCleanup,
            worktreeAfterDays: null,
            worktreeOnDelete: false,
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
          storageCleanup: {
            ...settings.storageCleanup,
            worktreeAfterDays: null,
            worktreeOnDelete: false,
          },
        };
      },
      setThreads: (next: typeof threads) => {
        threads = next;
      },
      setStoredWorktreePaths: (paths: string[]) => {
        storedWorktreePaths = paths;
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
      setSettings: (next: Partial<typeof settings>) => {
        settings = { ...settings, ...next };
      },
      snapshotReads: () => snapshotReads,
      fullStatusCalls: () => fullStatusCalls,
    };
  });
/** The fixture, with the size walk of its worktree held until `resume` succeeds. */
const pausedMeasurementFixture = (
  storageCleanup?: StorageCleanupSettings,
  eventSql?: SqlClient.SqlClient,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const measuring = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    let measuredPath: string | undefined;
    const fixture = yield* cleanupFixture(storageCleanup, eventSql).pipe(
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        readDirectory: (directory, options) =>
          Effect.gen(function* () {
            if (directory === measuredPath) {
              yield* Deferred.succeed(measuring, undefined);
              yield* Deferred.await(resume);
            }
            return yield* fs.readDirectory(directory, options);
          }),
      }),
    );
    measuredPath = yield* fs.realPath(fixture.worktree);
    return { ...fixture, measuring, resume };
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

const submoduleCleanupFixture = () =>
  Effect.gen(function* () {
    const fixture = yield* cleanupFixture();
    const { command, repo, worktree } = fixture;
    const submodule = `${worktree}/module`;
    const child = `${submodule}/child`;
    for (const [cwd, name] of [
      [worktree, "module"],
      [submodule, "child"],
    ] as const) {
      yield* command(cwd, ["-c", "protocol.file.allow=always", "submodule", "add", repo, name]);
      yield* command(`${cwd}/${name}`, ["config", "user.name", "Cleanup test"]);
      yield* command(`${cwd}/${name}`, ["config", "user.email", "cleanup@example.test"]);
    }
    const recordSubmodules = () =>
      Effect.gen(function* () {
        yield* command(submodule, ["commit", "-am", "record child"]);
        yield* command(submodule, ["push", "origin", "HEAD:submodule"]);
        yield* command(worktree, ["commit", "-am", "record module"]);
      });
    yield* recordSubmodules();
    return { ...fixture, submodule, child, recordSubmodules };
  });

it.live("removes clean submodules recursively, including deinitialized repositories", () =>
  runCleanupTest(
    Effect.gen(function* () {
      const { service, fs, repo, worktree, submodule, command, recordSubmodules } =
        yield* submoduleCleanupFixture();
      yield* command(submodule, [
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        repo,
        "stored",
      ]);
      yield* recordSubmodules();
      yield* command(submodule, ["submodule", "deinit", "stored"]);
      const admin = (yield* command(worktree, ["rev-parse", "--absolute-git-dir"])).stdout.trim();
      const report = yield* service.runNow;
      expect(report.entries.find((entry) => entry.path === worktree)).toMatchObject({
        outcome: "removed",
      });
      expect(report.counts).toEqual({ removed: 1, kept: 1, failed: 0 });
      expect(report.entries).toContainEqual(
        expect.objectContaining({
          worktreeResource: "dependencies",
          outcome: "kept",
          reason: "Dependencies: Dependency cleanup policy is disabled",
        }),
      );
      expect(yield* fs.exists(worktree)).toBe(false);
      expect(yield* fs.exists(admin)).toBe(false);
    }),
  ),
);

it.live("keeps nested submodule files protected by the current keep rule", () =>
  runCleanupTest(
    Effect.gen(function* () {
      const { service, fs, worktree, submodule, child, command, setPolicy } =
        yield* submoduleCleanupFixture();
      setPolicy("tracked-changes");
      yield* fs.writeFileString(`${child}/tracked.txt`, "local edit\n");
      expect(
        (yield* service.runNow).entries.find((entry) => entry.path === worktree),
      ).toMatchObject({ outcome: "kept" });
      expect(yield* fs.readFileString(`${child}/tracked.txt`)).toBe("local edit\n");
      yield* fs.writeFileString(`${child}/tracked.txt`, "original\n");
      setPolicy("any-local-files");
      yield* fs.writeFileString(`${child}/.env`, "local secret\n");
      expect(
        (yield* service.runNow).entries.find((entry) => entry.path === worktree),
      ).toMatchObject({ outcome: "kept" });
      expect(yield* fs.readFileString(`${child}/.env`)).toBe("local secret\n");

      yield* fs.remove(`${child}/.env`);
      yield* command(submodule, ["submodule", "deinit", "child"]);
      yield* fs.writeFileString(`${child}/.env`, "secret after deinit\n");
      const report = yield* service.runNow;
      expect({
        outcome: report.entries.find((entry) => entry.path === worktree)?.outcome,
        contents: (yield* fs.exists(`${child}/.env`))
          ? yield* fs.readFileString(`${child}/.env`)
          : null,
      }).toEqual({ outcome: "kept", contents: "secret after deinit\n" });
      setPolicy("tracked-changes");
      expect(
        (yield* service.runNow).entries.find((entry) => entry.path === worktree),
      ).toMatchObject({ outcome: "kept" });
      expect(yield* fs.readFileString(`${child}/.env`)).toBe("secret after deinit\n");

      yield* fs.remove(`${child}/.env`);
      setPolicy("uncommitted-changes");
      yield* fs.writeFileString(`${child}/notes.txt`, "notes after deinit\n");
      const untrackedReport = yield* service.runNow;
      expect({
        outcome: untrackedReport.entries.find((entry) => entry.path === worktree)?.outcome,
        contents: (yield* fs.exists(`${child}/notes.txt`))
          ? yield* fs.readFileString(`${child}/notes.txt`)
          : null,
      }).toEqual({ outcome: "kept", contents: "notes after deinit\n" });
    }),
  ),
);

it.live("keeps unpushed submodule history after checkout and deinitialization", () =>
  runCleanupTest(
    Effect.gen(function* () {
      const { service, fs, worktree, submodule, child, command, recordSubmodules } =
        yield* submoduleCleanupFixture();
      yield* command(child, ["checkout", "-b", "local-only"]);
      yield* fs.writeFileString(`${child}/tracked.txt`, "unpublished work\n");
      yield* command(child, ["commit", "-am", "local work"]);
      const local = (yield* command(child, ["rev-parse", "HEAD"])).stdout.trim();
      yield* recordSubmodules();
      expect(
        (yield* service.runNow).entries.find((entry) => entry.path === worktree),
      ).toMatchObject({ outcome: "kept", reason: expect.stringContaining("remote-tracking") });
      expect(yield* fs.readFileString(`${child}/tracked.txt`)).toBe("unpublished work\n");

      yield* command(child, ["checkout", "main"]);
      yield* recordSubmodules();
      expect(
        (yield* service.runNow).entries.find((entry) => entry.path === worktree),
      ).toMatchObject({ outcome: "kept", reason: expect.stringContaining("remote-tracking") });
      const childGit = (yield* command(child, ["rev-parse", "--absolute-git-dir"])).stdout.trim();
      yield* command(submodule, ["submodule", "deinit", "child"]);
      expect(
        (yield* service.runNow).entries.find((entry) => entry.path === worktree),
      ).toMatchObject({ outcome: "kept", reason: expect.stringContaining("remote-tracking") });
      expect(
        (yield* command(worktree, [
          "--git-dir",
          childGit,
          "rev-parse",
          "refs/heads/local-only",
        ])).stdout.trim(),
      ).toBe(local);
      expect(
        (yield* command(worktree, ["--git-dir", childGit, "show", "local-only:tracked.txt"]))
          .stdout,
      ).toBe("unpublished work\n");
      yield* command(worktree, ["--git-dir", childGit, "branch", "-D", "local-only"]);
      expect(
        (yield* service.runNow).entries.find((entry) => entry.path === worktree),
      ).toMatchObject({ outcome: "kept", reason: expect.stringContaining("remote-tracking") });
      expect(
        (yield* command(worktree, ["--git-dir", childGit, "show", `${local}:tracked.txt`])).stdout,
      ).toBe("unpublished work\n");
    }),
  ),
);

it.live("keeps submodules when stored repository metadata is malformed", () =>
  runCleanupTest(
    Effect.gen(function* () {
      const { service, fs, worktree, submodule, child, command } = yield* submoduleCleanupFixture();
      const childGit = (yield* command(child, ["rev-parse", "--absolute-git-dir"])).stdout.trim();
      yield* command(submodule, ["submodule", "deinit", "child"]);
      yield* fs.writeFileString(`${childGit}/HEAD`, "not a ref\n");
      expect(
        (yield* service.runNow).entries.find((entry) => entry.path === worktree),
      ).toMatchObject({ outcome: "kept", reason: expect.stringContaining("inspected") });
      expect(yield* fs.exists(worktree)).toBe(true);
      expect(yield* fs.readFileString(`${childGit}/HEAD`)).toBe("not a ref\n");
    }),
  ),
);

it.live("preserves late tracked edits when submodules were never initialized", () =>
  runCleanupTest(
    Effect.gen(function* () {
      const fixture = yield* cleanupFixture();
      const { service, fs, worktree, command } = fixture;
      const head = (yield* command(worktree, ["rev-parse", "HEAD"])).stdout.trim();
      yield* fs.writeFileString(
        `${worktree}/.gitmodules`,
        '[submodule "module"]\n\tpath = module\n\turl = /unused\n',
      );
      yield* command(worktree, ["add", ".gitmodules"]);
      yield* command(worktree, ["update-index", "--add", "--cacheinfo", `160000,${head},module`]);
      yield* command(worktree, ["commit", "-m", "record uninitialized module"]);
      yield* fs.makeDirectory(`${worktree}/module`);
      fixture.editBeforeRemoval();
      expect(
        (yield* service.runNow).entries.find((entry) => entry.path === worktree),
      ).toMatchObject({ outcome: "failed" });
      expect(yield* fs.readFileString(`${worktree}/tracked.txt`)).toBe("late edit\n");
    }),
  ),
);

const cleanupEventSql = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE orchestration_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    aggregate_kind TEXT NOT NULL,
    stream_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL
  )`;
  const append = (type: string, payload: unknown, streamId = "thread-1", kind = "thread") =>
    sql`INSERT INTO orchestration_events (aggregate_kind, stream_id, event_type, payload_json)
      VALUES (${kind}, ${streamId}, ${type}, ${JSON.stringify(payload)})`.pipe(Effect.asVoid);
  return { sql, append };
});

describe("cleanup ownership event revalidation", () => {
  it.live.each([
    "owner visit",
    "owner metadata",
    "unrelated visit",
    "unrelated PR link",
    "unrelated metadata",
    "unrelated creation",
    "new owner",
    "aliased owner",
    "moved owner",
    "owner active",
    "owner unarchived",
    "project metadata",
    "project root",
    "project addition",
  ] as const)("revalidates dependency ownership after %s", (change) =>
    runCleanupTest(
      Effect.gen(function* () {
        const { sql, append } = yield* cleanupEventSql;
        const fixture = yield* cleanupFixture(undefined, sql);
        yield* fixture.enableDependencies;
        const owner = shell({
          branch: "feature",
          worktreePath: fixture.worktree,
          archivedAt: at(-30 * DAY_MS),
        });
        const other = shell({
          id: ThreadId.make("other-thread"),
          branch: "other-feature",
          worktreePath: `${fixture.repo}/other-checkout`,
        });
        fixture.setThreads(change === "moved owner" ? [owner, other] : [owner]);
        let aliasedPath = fixture.worktree;
        if (change === "aliased owner") {
          const alias = `${fixture.config.baseDir}/worktree-alias`;
          yield* fixture.fs.symlink(fixture.config.worktreesDir, alias);
          aliasedPath = `${alias}/feature`;
        }
        fixture.onDependencyInspection(
          Effect.gen(function* () {
            if (change.startsWith("project")) {
              const roots = projectShells(
                change === "project addition"
                  ? [fixture.repo, fixture.repo]
                  : [change === "project root" ? fixture.worktree : fixture.repo],
              );
              fixture.setProjectRoots(roots);
              yield* append("project.updated", roots[0], "project-1", "project");
              return;
            }
            if (change === "unrelated PR link") {
              yield* append(
                "thread.pull-request-link-updated",
                { host: "github.com", repository: "example/project", number: 1 },
                other.id,
              );
              return;
            }
            const next =
              change === "owner active"
                ? { ...owner, status: "running" as const }
                : change === "owner unarchived"
                  ? { ...owner, archivedAt: null }
                  : change === "new owner" || change === "aliased owner" || change === "moved owner"
                    ? { ...other, worktreePath: aliasedPath }
                    : change === "owner visit" || change === "owner metadata"
                      ? owner
                      : other;
            if (change === "owner active" || change === "owner unarchived")
              fixture.setThreads([next]);
            else if (
              ["new owner", "aliased owner", "moved owner", "unrelated creation"].includes(change)
            )
              fixture.setThreads([owner, next]);
            const eventType = change.includes("visit")
              ? "thread.visited"
              : change === "new owner" ||
                  change === "aliased owner" ||
                  change === "unrelated creation"
                ? "thread.created"
                : "thread.metadata-updated";
            yield* append(eventType, next, next.id);
          }).pipe(Effect.orDie),
        );
        const report = yield* fixture.service.runNow;
        const kept = [
          "new owner",
          "aliased owner",
          "moved owner",
          "owner active",
          "owner unarchived",
          "project root",
          "project addition",
        ].includes(change);
        expect(
          report.entries.filter((entry) => entry.worktreeResource === "dependencies"),
        ).toMatchObject([{ outcome: kept ? "kept" : "removed" }]);
        expect(yield* fixture.fs.exists(`${fixture.worktree}/node_modules`)).toBe(kept);
        expect(report.counts.failed).toBe(0);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
    ),
  );

  it.live("keeps ownerless dependencies when new thread history names their branch", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { sql, append } = yield* cleanupEventSql;
        const fixture = yield* cleanupFixture(undefined, sql);
        yield* fixture.enableDependencies;
        fixture.setThreads([]);
        fixture.onDependencyInspection(
          Effect.gen(function* () {
            const owner = shell({ branch: "feature", worktreePath: `${fixture.repo}/elsewhere` });
            fixture.setThreads([owner]);
            yield* append("thread.created", owner);
          }).pipe(Effect.orDie),
        );
        const report = yield* fixture.service.runNow;
        expect(
          report.entries.filter((entry) => entry.worktreeResource === "dependencies"),
        ).toMatchObject([{ outcome: "kept" }]);
        expect(yield* fixture.fs.exists(`${fixture.worktree}/node_modules`)).toBe(true);
        expect(report.counts.failed).toBe(0);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
    ),
  );

  it.live.each(["owner visit", "owner unarchived"] as const)(
    "revalidates dependency ownership after late %s in native removal",
    (change) =>
      runCleanupTest(
        Effect.gen(function* () {
          const { sql, append } = yield* cleanupEventSql;
          let captures = 0;
          let injected = false;
          let inject: Effect.Effect<void> = Effect.void;
          const fixture = yield* cleanupFixture(undefined, sql).pipe(
            Effect.provideService(
              WorktreeConsumers.ProcessPaths,
              Effect.gen(function* () {
                captures++;
                // The third native capture follows canRemove's sequence capture
                // and precedes a final isStillEligible callback.
                if (captures === 3) {
                  yield* inject;
                  injected = true;
                }
                return [];
              }),
            ),
          );
          yield* fixture.enableDependencies;
          const owner = shell({
            branch: "feature",
            worktreePath: fixture.worktree,
            archivedAt: at(-30 * DAY_MS),
          });
          fixture.setThreads([owner]);
          inject = Effect.gen(function* () {
            const latest = change === "owner unarchived" ? { ...owner, archivedAt: null } : owner;
            fixture.setThreads([latest]);
            yield* append(
              change === "owner visit" ? "thread.visited" : "thread.metadata-updated",
              latest,
              owner.id,
            );
          }).pipe(Effect.orDie);
          const report = yield* fixture.service.runNow;
          expect(injected).toBe(true);
          expect(
            report.entries.filter((entry) => entry.worktreeResource === "dependencies"),
          ).toMatchObject([{ outcome: change === "owner visit" ? "removed" : "kept" }]);
          expect(yield* fixture.fs.exists(`${fixture.worktree}/node_modules`)).toBe(
            change === "owner unarchived",
          );
          expect(report.counts.failed).toBe(0);
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
      ),
  );

  it.live.each(["unrelated visit", "new owner"] as const)(
    "revalidates whole-checkout ownership after %s during measurement",
    (change) =>
      runCleanupTest(
        Effect.gen(function* () {
          const { sql, append } = yield* cleanupEventSql;
          const fixture = yield* pausedMeasurementFixture(undefined, sql);
          const owner = shell({ branch: "feature", worktreePath: fixture.worktree });
          const other = shell({
            id: ThreadId.make("other-thread"),
            branch: "other-feature",
            worktreePath: change === "new owner" ? fixture.worktree : `${fixture.repo}/elsewhere`,
          });
          const run = yield* Effect.forkChild(fixture.service.runNow);
          yield* Deferred.await(fixture.measuring);
          if (change === "new owner") fixture.setThreads([owner, other]);
          yield* append(
            change === "new owner" ? "thread.created" : "thread.visited",
            other,
            other.id,
          );
          yield* Deferred.succeed(fixture.resume, undefined);
          const report = yield* Fiber.join(run);
          expect(checkoutEntries(report)[0]?.outcome).toBe(
            change === "new owner" ? "kept" : "removed",
          );
          expect(yield* fixture.fs.exists(fixture.worktree)).toBe(change === "new owner");
          expect(report.counts.failed).toBe(0);
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
      ),
  );

  it.live.each(["unrelated visit", "new owner"] as const)(
    "revalidates generated-build ownership after %s",
    (change) =>
      runCleanupTest(
        Effect.gen(function* () {
          const { sql, append } = yield* cleanupEventSql;
          let outputDirectory = "";
          let inject: Effect.Effect<void> | null = null;
          let observations = 0;
          const fixture = yield* cleanupFixture(undefined, sql).pipe(
            Effect.provideService(
              WorktreeConsumers.ProcessPaths,
              Effect.gen(function* () {
                observations++;
                if (observations === 2 && inject !== null) {
                  const event = inject;
                  inject = null;
                  yield* event;
                }
                return [];
              }),
            ),
          );
          fixture.setDependencyRetention(3);
          yield* seedCompilerOutput(fixture, "apps/web/dist", fixture.now - 4 * DAY_MS);
          outputDirectory = `${fixture.worktree}/apps/web/dist`;
          const owner = shell({ branch: "feature", worktreePath: fixture.worktree });
          const other = shell({
            id: ThreadId.make("other-thread"),
            branch: "other-feature",
            worktreePath: change === "new owner" ? fixture.worktree : `${fixture.repo}/elsewhere`,
          });
          inject = Effect.gen(function* () {
            if (change === "new owner") fixture.setThreads([owner, other]);
            yield* append(
              change === "new owner" ? "thread.created" : "thread.visited",
              other,
              other.id,
            );
          }).pipe(Effect.orDie);
          const report = yield* fixture.service.runNow;
          expect(inject).toBeNull();
          expect(
            report.entries.filter((entry) => entry.worktreeResource === "generated-builds"),
          ).toMatchObject([{ outcome: change === "new owner" ? "kept" : "removed" }]);
          expect(yield* fixture.fs.exists(`${outputDirectory}/assets/emitted.bin`)).toBe(
            change === "new owner",
          );
          expect(report.counts.failed).toBe(0);
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
      ),
  );
});

describe("subagent worktree ownership", () => {
  it.effect.each([
    "idle",
    "grandchild",
    "null-branch",
    "stale-branch",
    "isolated-owner",
    "fork-owner",
    "missing-parent",
    "cycle",
    "two-tops",
    "wrong-root",
    "running",
    "pending",
    "unrelated",
    "fork",
    "recent-activity",
    "recent-inactive",
    "recent-grace",
    "recent-settle",
    "child-settled-now",
    "child-settled-only",
  ] as const)("checks the whole owner group (%s)", (scenario) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const fixture = yield* cleanupFixture();
      fixture.setSettings({
        storageCleanup: {
          ...DEFAULT_SERVER_SETTINGS.storageCleanup,
          worktreeSettledAfterDays: scenario === "recent-inactive" ? null : 8,
          worktreeAfterDays: scenario === "recent-inactive" ? 8 : null,
        },
      });
      const root = shell({
        branch: "feature",
        worktreePath: fixture.worktree,
        settledAt: scenario === "child-settled-only" ? null : at(-20 * DAY_MS),
        ...(scenario === "isolated-owner" || scenario === "fork-owner"
          ? {
              lineage: {
                parentThreadId: ThreadId.make("ancestor"),
                rootThreadId: ThreadId.make("ancestor"),
                relationshipToParent:
                  scenario === "fork-owner" ? ("fork" as const) : ("subagent" as const),
              },
            }
          : {}),
      });
      const child = shell({
        id: ThreadId.make("child"),
        branch:
          scenario === "null-branch"
            ? null
            : scenario === "stale-branch"
              ? "t3/15a6e5ae"
              : "feature",
        worktreePath: fixture.worktree,
        lineage: {
          parentThreadId:
            scenario === "missing-parent"
              ? ThreadId.make("missing")
              : scenario === "cycle"
                ? ThreadId.make("child")
                : scenario === "two-tops"
                  ? null
                  : root.id,
          rootThreadId:
            scenario === "wrong-root" ? ThreadId.make("other-root") : root.lineage.rootThreadId,
          relationshipToParent:
            scenario === "fork" ? "fork" : scenario === "unrelated" ? null : "subagent",
        },
        status: scenario === "running" ? "running" : "completed",
        pendingBackgroundTasks: scenario === "pending" ? [{ taskId: "task", kind: "command" }] : [],
        latestRunCompletedAt:
          scenario === "recent-activity" || scenario === "recent-inactive"
            ? at(-2 * DAY_MS)
            : scenario === "recent-grace"
              ? at(-30_000)
              : null,
        settledAt: scenario === "child-settled-only" ? at(-20 * DAY_MS) : null,
      });
      const grandchild = {
        ...child,
        id: ThreadId.make("grandchild"),
        lineage: { ...child.lineage, parentThreadId: child.id },
      };
      // The worktree owner can follow its children in the snapshot.
      fixture.setThreads(
        scenario === "grandchild"
          ? [grandchild, child, root]
          : scenario === "isolated-owner" || scenario === "fork-owner"
            ? [child, root, shell({ id: ThreadId.make("ancestor") })]
            : [child, root],
      );
      if (scenario === "recent-settle" || scenario === "child-settled-now")
        fixture.setThreads([
          {
            ...child,
            settledAt: scenario === "recent-settle" ? at(0) : at(-20 * DAY_MS),
            updatedAt: at(0),
          },
          root,
        ]);
      const report = yield* fixture.service.runNow;
      const removed = ["idle", "grandchild", "isolated-owner", "fork-owner"].includes(scenario);
      const shared = [
        "unrelated",
        "fork",
        "missing-parent",
        "cycle",
        "two-tops",
        "wrong-root",
      ].includes(scenario);
      expect(yield* fixture.fs.exists(fixture.worktree)).toBe(!removed);
      expect(checkoutEntries(report)[0]).toMatchObject({
        threadId: shared ? child.id : root.id,
        outcome: removed ? "removed" : "kept",
        reason: removed
          ? "Settled for 20 days"
          : scenario === "running" || scenario === "pending"
            ? "Thread is running or has pending work"
            : shared
              ? "Shared by 2 threads"
              : scenario === "null-branch" || scenario === "stale-branch"
                ? "A subagent thread's branch differs from this worktree's branch"
                : scenario === "recent-activity"
                  ? "Settled for 2 of 8 days"
                  : scenario === "recent-inactive"
                    ? "Inactive for 2 of 8 days"
                    : ["recent-grace", "recent-settle", "child-settled-now"].includes(scenario)
                      ? "Settled moments ago"
                      : "Not settled",
      });
    }).pipe(runCleanupTest),
  );

  it.live.each([
    "running",
    "pending",
    "activity",
    "unrelated",
    "settled",
    "resettled",
    "null-branch",
    "stale-branch",
  ] as const)("cancels removal when a child changes during measurement (%s)", (change) =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* pausedMeasurementFixture();
        const root = shell({ branch: "feature", worktreePath: fixture.worktree });
        const child = {
          ...root,
          id: ThreadId.make("child"),
          settledAt: change === "resettled" ? at(-20 * DAY_MS) : null,
          lineage: {
            parentThreadId: root.id,
            rootThreadId: root.id,
            relationshipToParent: "subagent" as const,
          },
        };
        fixture.setThreads([child, root]);
        const run = yield* fixture.service.runNow.pipe(Effect.forkChild);
        yield* Deferred.await(fixture.measuring);
        fixture.setThreads([
          root,
          {
            ...child,
            branch:
              change === "null-branch"
                ? null
                : change === "stale-branch"
                  ? "t3/15a6e5ae"
                  : child.branch,
            settledAt: change === "settled" ? at(-20 * DAY_MS) : child.settledAt,
            updatedAt: change === "settled" || change === "resettled" ? at(0) : child.updatedAt,
            status: change === "running" ? "running" : "idle",
            pendingBackgroundTasks:
              change === "pending" ? [{ taskId: "task", kind: "command" }] : [],
            latestRunCompletedAt: change === "activity" ? at(-DAY_MS) : null,
          },
          ...(change === "unrelated" ? [shell({ ...root, id: ThreadId.make("other") })] : []),
        ]);
        yield* Deferred.succeed(fixture.resume, undefined);
        expect(checkoutEntries(yield* Fiber.join(run))[0]).toMatchObject({
          outcome: "kept",
          reason: "Thread activity or shared worktree changed since check",
        });
        expect(yield* fixture.fs.exists(fixture.worktree)).toBe(true);
      }),
    ),
  );
});

describe("orphan worktree reports", () => {
  const filesystemOrphanEntries = (report: StorageCleanupReport) =>
    report.entries.filter((entry) => entry.reason.startsWith("No thread uses"));
  it.live("keeps orphan results visible when thread results fill the report", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture();
        fixture.setThreads(
          Array.from({ length: 205 }, (_, index) =>
            shell({
              id: ThreadId.make(`busy-${index}`),
              branch: "busy",
              worktreePath: `${fixture.config.worktreesDir}/busy-${index}`,
              status: "running",
            }),
          ),
        );
        for (let index = 0; index < 205; index++) {
          yield* fixture.fs.makeDirectory(`${fixture.config.worktreesDir}/busy-${index}`);
        }
        const orphans = ["one", "two"].map(
          (name) => `${fixture.config.worktreesDir}/repository/${name}`,
        );
        for (const orphan of orphans) {
          yield* fixture.fs.makeDirectory(orphan, { recursive: true });
          yield* fixture.fs.utimes(orphan, 1, 1);
        }
        const report = yield* fixture.service.runNow;
        expect(report.entries).toHaveLength(200);
        expect(
          filesystemOrphanEntries(report)
            .slice(0, 2)
            .map((entry) => entry.path)
            .sort(),
        ).toEqual(orphans);
        expect(report.counts).toEqual({ removed: 0, kept: 208, failed: 0 });
        expect(report.omittedCount).toBe(8);
      }),
    ),
  );

  it.live.each(["canonical", "win32", "linux"] as const)(
    "skips an ancestor of a referenced thread worktree (%s)",
    (platform) =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* cleanupFixture().pipe(
            Effect.provideService(HostProcess.Platform, platform === "win32" ? "win32" : "linux"),
          );
          fixture.setThreads([]);
          const ancestor = `${fixture.config.worktreesDir}/repository/stack`;
          const worktree = `${ancestor}/feature`;
          yield* fixture.command(fixture.repo, ["worktree", "add", "-b", "nested", worktree]);
          const alias = `${fixture.repo}/alias`;
          if (platform === "canonical") yield* fixture.fs.symlink(worktree, alias);
          fixture.setStoredWorktreePaths([
            platform === "canonical"
              ? alias
              : platform === "win32"
                ? worktree.toUpperCase()
                : worktree,
          ]);
          yield* fixture.fs.utimes(ancestor, 1, 1);
          expect(filesystemOrphanEntries(yield* fixture.service.runNow)).toEqual([]);
          expect(yield* fixture.fs.exists(worktree)).toBe(true);
        }),
      ),
  );

  it.live("continues reporting when a project root cannot be probed", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture();
        fixture.setThreads([]);
        const loop = `${fixture.repo}/loop`;
        yield* fixture.fs.symlink(loop, loop);
        fixture.setProjectRoots(projectShells([fixture.repo, loop]));
        const orphan = `${fixture.config.worktreesDir}/repository/orphan`;
        yield* fixture.fs.makeDirectory(orphan, { recursive: true });
        yield* fixture.fs.utimes(orphan, 1, 1);
        expect(filesystemOrphanEntries(yield* fixture.service.runNow)).toEqual([
          expect.objectContaining({ path: orphan, outcome: "kept", bytes: 0 }),
        ]);
      }),
    ),
  );

  it.live.each(["nested", "direct"] as const)(
    "reports a linked orphan's size without removing its files (%s)",
    (location) =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* cleanupFixture();
          fixture.setThreads([]);
          const orphan = `${fixture.config.worktreesDir}/${location === "nested" ? "repository/" : ""}orphan`;
          yield* fixture.command(fixture.repo, ["worktree", "add", "-b", "orphan", orphan]);
          const sizes = yield* Effect.forEach(yield* fixture.fs.readDirectory(orphan), (name) =>
            allocatedBytes(fixture.fs, `${orphan}/${name}`),
          );
          const outside = yield* fixture.fs.makeTempDirectoryScoped();
          yield* fixture.fs.writeFileString(`${outside}/external`, "outside data");
          yield* fixture.fs.symlink(outside, `${orphan}/linked-directory`);
          yield* fixture.fs.symlink(`${outside}/missing`, `${orphan}/dangling-link`);
          yield* fixture.fs.utimes(orphan, 1, 1);
          const report = yield* fixture.service.runNow;
          expect(filesystemOrphanEntries(report)).toEqual([
            {
              kind: "worktree",
              outcome: "kept",
              reason: "No thread uses this worktree",
              path: orphan,
              projectPath: null,
              threadId: null,
              threadTitle: null,
              bytes: sizes.reduce((sum, size) => sum + size, 0),
              files: null,
            },
          ]);
          expect(report.bytesFreed).toBe(0);
          expect(yield* fixture.fs.readFileString(`${orphan}/tracked.txt`)).toBe("original\n");
          expect(yield* fixture.fs.readFileString(`${outside}/external`)).toBe("outside data");
          expect(
            (yield* fixture.command(orphan, ["rev-parse", "--is-inside-work-tree"])).stdout.trim(),
          ).toBe("true");
        }),
      ),
  );

  it.live.each(["active", "outside-active-snapshot"] as const)(
    "does not report a folder referenced by a thread (%s)",
    (location) =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* cleanupFixture();
          const worktreePath = `${fixture.config.worktreesDir}/repository/referenced`;
          yield* fixture.command(fixture.repo, [
            "worktree",
            "add",
            "-b",
            "referenced",
            worktreePath,
          ]);
          fixture.setThreads(
            location === "active"
              ? [shell({ branch: "referenced", worktreePath, status: "running" })]
              : [],
          );
          if (location !== "active")
            fixture.setStoredWorktreePaths([fixture.worktree, worktreePath]);
          yield* fixture.fs.utimes(worktreePath, 1, 1);
          const report = yield* fixture.service.runNow;
          expect(
            filesystemOrphanEntries(report).filter((entry) => entry.threadId === null),
          ).toEqual([]);
          expect(yield* fixture.fs.exists(worktreePath)).toBe(true);
        }),
      ),
  );

  it.live.each(["exact", "nested", "symlink"] as const)(
    "does not report a folder containing a project checkout (%s)",
    (location) =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* cleanupFixture();
          fixture.setThreads([]);
          const worktreePath = `${fixture.config.worktreesDir}/repository/project-checkout`;
          yield* fixture.fs.makeDirectory(`${worktreePath}/nested`, { recursive: true });
          const alias = `${fixture.repo}/alias`;
          if (location === "symlink") yield* fixture.fs.symlink(`${worktreePath}/nested`, alias);
          fixture.setProjectRoots(
            projectShells([
              fixture.repo,
              location === "exact"
                ? worktreePath
                : location === "nested"
                  ? `${worktreePath}/nested`
                  : alias,
            ]),
          );
          yield* fixture.fs.utimes(worktreePath, 1, 1);
          expect(filesystemOrphanEntries(yield* fixture.service.runNow)).toEqual([]);
          expect(yield* fixture.fs.exists(worktreePath)).toBe(true);
        }),
      ),
  );

  it.live.each(["exact", "contains", "symlink"] as const)(
    "does not report project internals under a custom managed root (%s)",
    (location) =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* cleanupFixture();
          fixture.setThreads([]);
          const source = `${fixture.repo}/src`;
          yield* fixture.fs.makeDirectory(`${source}/nested/deep`, { recursive: true });
          const alias = `${fixture.config.worktreesDir}/project-alias`;
          if (location === "symlink") {
            yield* fixture.fs.symlink(fixture.repo, alias);
            fixture.setProjectRoots(projectShells([alias]));
          }
          if (location === "contains")
            fixture.setProjectRoots(projectShells([fixture.repo, `${source}/nested`]));
          fixture.setSettings({
            worktreesDirectory: location === "contains" ? source : fixture.repo,
          });
          expect(filesystemOrphanEntries(yield* fixture.service.runNow)).toEqual([]);
          expect(yield* fixture.fs.exists(`${source}/nested/deep`)).toBe(true);
        }),
      ),
  );

  it.live("skips symbolic links at both directory levels and disabled cleanup", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture();
        fixture.setThreads([]);
        const outside = yield* fixture.fs.makeTempDirectoryScoped();
        yield* fixture.fs.makeDirectory(`${outside}/checkout`);
        const projectDirectory = `${fixture.config.worktreesDir}/repository`;
        yield* fixture.fs.makeDirectory(projectDirectory);
        yield* fixture.fs.symlink(outside, `${fixture.config.worktreesDir}/linked-project`);
        yield* fixture.fs.symlink(`${outside}/checkout`, `${projectDirectory}/linked-checkout`);
        yield* fixture.fs.symlink(`${outside}/missing`, `${projectDirectory}/dangling-link`);
        expect(filesystemOrphanEntries(yield* fixture.service.runNow)).toEqual([]);
        const orphan = `${projectDirectory}/orphan`;
        yield* fixture.fs.makeDirectory(orphan);
        fixture.disable();
        expect(filesystemOrphanEntries(yield* fixture.service.runNow)).toEqual([]);
        expect(yield* fixture.fs.exists(orphan)).toBe(true);
      }),
    ),
  );

  it.live("reports ordinary folders with an honest reason and keeps their files", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture();
        fixture.setThreads([]);
        const folder = `${fixture.config.worktreesDir}/repository/leftover`;
        yield* fixture.fs.makeDirectory(folder, { recursive: true });
        yield* fixture.fs.writeFileString(`${folder}/payload`, "leftover data");
        yield* fixture.fs.utimes(folder, 1, 1);
        const report = yield* fixture.service.runNow;
        expect(filesystemOrphanEntries(report)).toEqual([
          expect.objectContaining({
            path: folder,
            outcome: "kept",
            bytes: yield* allocatedBytes(fixture.fs, `${folder}/payload`),
            reason: "No thread uses this folder, and it isn't a git worktree",
          }),
        ]);
        expect(report.bytesFreed).toBe(0);
        expect(yield* fixture.fs.readFileString(`${folder}/payload`)).toBe("leftover data");
      }),
    ),
  );

  it.live("continues after an inaccessible directory's git probe", (context) =>
    runCleanupTest(
      Effect.gen(function* () {
        if ((yield* HostProcess.isWindows) || (yield* HostProcess.UserId) === 0)
          return context.skip();
        const fixture = yield* cleanupFixture();
        fixture.setThreads([]);
        const blocked = `${fixture.config.worktreesDir}/a-inaccessible`;
        const orphan = `${fixture.config.worktreesDir}/z-repository/orphan`;
        yield* fixture.fs.makeDirectory(blocked);
        yield* fixture.fs.makeDirectory(orphan, { recursive: true });
        yield* fixture.fs.writeFileString(`${orphan}/file`, "x");
        yield* fixture.fs.chmod(blocked, 0);
        yield* fixture.fs.utimes(orphan, 1, 1);
        const report = yield* fixture.service.runNow.pipe(
          Effect.ensuring(fixture.fs.chmod(blocked, 0o700).pipe(Effect.orDie)),
        );
        expect(filesystemOrphanEntries(report)).toEqual([
          expect.objectContaining({
            path: orphan,
            outcome: "kept",
            bytes: yield* allocatedBytes(fixture.fs, `${orphan}/file`),
          }),
        ]);
        expect(yield* fixture.fs.exists(orphan)).toBe(true);
      }),
    ),
  );

  it.live.each(["win32", "linux"] as const)(
    "compares thread paths with host casing rules and excludes existing projects (%s)",
    (platform) =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* cleanupFixture().pipe(
            Effect.provideService(HostProcess.Platform, platform),
          );
          fixture.setThreads([]);
          const parent = `${fixture.config.worktreesDir}/repository`;
          const referenced = `${parent}/Referenced`;
          const project = `${parent}/Project`;
          const nested = `${parent}/Nested`;
          for (const folder of [referenced, project, nested]) {
            yield* fixture.fs.makeDirectory(`${folder}/child`, { recursive: true });
            yield* fixture.fs.utimes(folder, 1, 1);
          }
          fixture.setStoredWorktreePaths([fixture.worktree, referenced.toUpperCase()]);
          fixture.setProjectRoots(projectShells([fixture.repo, project, `${nested}/child`]));
          const report = yield* fixture.service.runNow;
          expect(
            filesystemOrphanEntries(report)
              .map((entry) => entry.path)
              .sort(),
          ).toEqual(platform === "win32" ? [] : [referenced]);
        }),
      ),
  );
});

const checkoutEntries = (report: import("@t3tools/contracts").StorageCleanupReport) =>
  report.entries.filter(
    (entry) => entry.kind === "worktree" && entry.worktreeResource === undefined,
  );

describe("provider protection during storage cleanup", () => {
  it.live.each(["stopped", "error"] as const)(
    "keeps an unfinished runtime close even when the durable session is %s",
    (status) =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* cleanupFixture();
          fixture.setOpenSessionCwd(fixture.repo);
          fixture.setSessionBindings([ThreadId.make("thread-1")]);
          fixture.setSessionStatus(status);
          fixture.setSessionLive(true);
          const report = yield* fixture.service.runNow;
          expect(checkoutEntries(report)[0]).toMatchObject({
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
          const fixture = yield* cleanupFixture();
          if (row === "older cwd") fixture.setOpenSessionCwd(fixture.repo);
          fixture.protectUnpersistedWorkspace();
          const report = yield* fixture.service.runNow;
          expect(checkoutEntries(report)[0]).toMatchObject({
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
        const fixture = yield* cleanupFixture();
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
        const fixture = yield* cleanupFixture().pipe(
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
          const fixture = yield* cleanupFixture();
          fixture.setOpenSessionCwd(fixture.repo);
          fixture.onSessionLiveRead(() => {
            if (owner === "binding") fixture.setSessionBindings([ThreadId.make("thread-1")]);
            else fixture.setOpenSessionCwd(fixture.worktree);
            fixture.publishProviderChange();
          });
          const report = yield* fixture.service.runNow;
          expect(checkoutEntries(report)[0]).toMatchObject({
            outcome: "kept",
            reason: "Provider session is still open",
          });
          expect(yield* fixture.fs.exists(fixture.worktree)).toBe(true);
        }),
      ),
  );
});

describe("dependency cleanup reports", () => {
  it.live.each(["owned", "ownerless"] as const)(
    "remembers installed-file consumers with cwd elsewhere for %s dependencies",
    (ownership) =>
      runCleanupTest(
        Effect.gen(function* () {
          let paths: readonly string[] = [];
          const fixture = yield* cleanupFixture().pipe(
            Effect.provideService(
              WorktreeConsumers.ProcessPaths,
              Effect.sync(() => paths),
            ),
            Effect.provideService(
              GeneratedDependencies.ProcessWorkingDirectories,
              Effect.succeed([]),
            ),
          );
          yield* fixture.enableDependencies;
          if (ownership === "ownerless") fixture.setThreads([]);
          paths = [`${fixture.worktree}/node_modules/package/index.js`];
          const first = yield* fixture.service.runNow;
          expect(
            first.entries.filter((entry) => entry.worktreeResource === "dependencies"),
          ).toMatchObject([{ outcome: "kept" }]);
          const location = yield* fixture.command(fixture.worktree, [
            "rev-parse",
            "--absolute-git-dir",
          ]);
          const activity = yield* Effect.sync(() =>
            observeDependencyActivity(
              location.stdout.trim(),
              fixture.worktree,
              fixture.now,
              false,
              false,
            ),
          );
          expect(activity.lastUsedAt).toBeGreaterThanOrEqual(fixture.now);
          paths = [];
          const afterExit = yield* fixture.service.runNow;
          expect(
            afterExit.entries.filter((entry) => entry.worktreeResource === "dependencies"),
          ).toMatchObject([{ outcome: "kept" }]);
          expect(
            yield* fixture.fs.exists(`${fixture.worktree}/node_modules/package/index.js`),
          ).toBe(true);
        }),
      ),
  );

  it.live.each(["configured", "previous"] as const)(
    "removes dependencies through a symlinked parent in the %s location",
    (location) =>
      runCleanupTest(
        isolatedDependencies(
          Effect.gen(function* () {
            const fixture = yield* cleanupFixture();
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
          const fixture = yield* cleanupFixture();
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
          const fixture = yield* cleanupFixture();
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
          const fixture = yield* cleanupFixture().pipe(
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
          const fixture = yield* cleanupFixture();
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
            const fixture = yield* cleanupFixture();
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

  it.live.each(["path", "branch", "unavailable"] as const)(
    "protects historical ownership through the cleanup boundary: %s",
    (mode) =>
      runCleanupTest(
        isolatedDependencies(
          Effect.gen(function* () {
            const fixture = yield* cleanupFixture();
            yield* fixture.enableDependencies;
            if (mode === "unavailable") fixture.failHistoricalOwners();
            else
              fixture.setHistoricalOwners([
                {
                  threadId: "unresolved-legacy-owner",
                  projectId: mode === "branch" ? "project-1" : "missing-project",
                  branch: mode === "branch" ? "feature" : null,
                  worktreePath: mode === "path" ? fixture.worktree : null,
                },
              ]);
            if (mode === "branch") fixture.setThreads([]);
            const report = yield* fixture.service.runNow;
            expect(yield* fixture.fs.exists(`${fixture.worktree}/node_modules`)).toBe(true);
            expect(report.counts.removed).toBe(0);
            expect(
              report.entries.some((entry) =>
                mode === "unavailable"
                  ? entry.outcome === "failed"
                  : entry.reason.includes(
                      mode === "branch" ? "history still names" : "historical owner",
                    ),
              ),
            ).toBe(true);
          }),
        ),
      ),
  );

  it.live("counts removed dependency installs and their allocated-byte estimate", () =>
    runCleanupTest(
      isolatedDependencies(
        Effect.gen(function* () {
          const fixture = yield* cleanupFixture();
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
          const fixture = yield* cleanupFixture();
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
          const fixture = yield* cleanupFixture();
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
        const fixture = yield* cleanupFixture().pipe(
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
  fixture: Effect.Success<ReturnType<typeof cleanupFixture>>,
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

const seedObservationResources = Effect.fnUntraced(function* (
  fixture: Effect.Success<ReturnType<typeof cleanupFixture>>,
) {
  yield* fixture.enableDependencies;
  fixture.setDependencyRetention(14);
  yield* seedCompilerOutput(fixture, "apps/web/dist", fixture.now - 4 * DAY_MS);
  yield* seedCompilerOutput(fixture, "apps/server/dist", fixture.now - 4 * DAY_MS);
  const other = `${fixture.config.worktreesDir}/observation-other`;
  yield* fixture.command(fixture.repo, [
    "worktree",
    "add",
    "-b",
    "observation-other",
    other,
    "feature",
  ]);
  yield* fixture.fs.makeDirectory(`${other}/node_modules/package`, { recursive: true });
  yield* fixture.fs.writeFileString(`${other}/node_modules/.package-lock.json`, "{}\n");
  yield* fixture.fs.writeFileString(
    `${other}/node_modules/package/index.js`,
    "module.exports = 2;\n",
  );
  yield* seedCompilerOutput(
    { ...fixture, worktree: other },
    "native/resource-monitor/target/debug",
    fixture.now - 4 * DAY_MS,
  );
  for (const cwd of [fixture.worktree, other]) {
    const location = yield* fixture.command(cwd, ["rev-parse", "--absolute-git-dir"]);
    yield* Effect.sync(() =>
      observeDependencyActivity(location.stdout.trim(), cwd, fixture.now - 4 * DAY_MS, true),
    );
  }
  return other;
});

const disposableEntries = (report: import("@t3tools/contracts").StorageCleanupReport) =>
  report.entries.filter(
    (entry) =>
      entry.worktreeResource === "dependencies" || entry.worktreeResource === "generated-builds",
  );

describe("one initial process observation per storage sweep", () => {
  it.live(
    "shares one observation across owned and ownerless installs and emitted roots, resetting each sweep",
    () =>
      runCleanupTest(
        Effect.gen(function* () {
          let captures = 0;
          const fixture = yield* cleanupFixture().pipe(
            Effect.provideService(
              WorktreeConsumers.ProcessPaths,
              Effect.sync(() => {
                captures++;
                return [];
              }),
            ),
          );
          const other = yield* seedObservationResources(fixture);
          for (const expectedCaptures of [1, 2]) {
            const report = yield* fixture.service.runNow;
            expect(disposableEntries(report)).toHaveLength(4);
            expect(disposableEntries(report).every((entry) => entry.outcome === "kept")).toBe(true);
            expect(captures).toBe(expectedCaptures);
          }
          const automatic = yield* fixture.service.reports.pipe(
            Stream.filter((report) => report?.trigger === "automatic"),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkScoped,
          );
          yield* fixture.activate();
          const [report] = yield* Fiber.join(automatic);
          expect(report?.trigger).toBe("automatic");
          expect(disposableEntries(report!)).toHaveLength(4);
          expect(disposableEntries(report!).every((entry) => entry.outcome === "kept")).toBe(true);
          expect(captures).toBe(3);
          for (const cwd of [fixture.worktree, other])
            expect(yield* fixture.fs.exists(`${cwd}/node_modules/package/index.js`)).toBe(true);
          expect(
            yield* fixture.fs.exists(`${fixture.worktree}/apps/web/dist/assets/emitted.bin`),
          ).toBe(true);
          expect(
            yield* fixture.fs.exists(`${fixture.worktree}/apps/server/dist/assets/emitted.bin`),
          ).toBe(true);
          expect(
            yield* fixture.fs.exists(
              `${other}/native/resource-monitor/target/debug/assets/emitted.bin`,
            ),
          ).toBe(true);
        }),
      ),
  );
  it.live.each(["off", "no recognized work"] as const)(
    "does not capture an initial inventory for %s",
    (mode) =>
      runCleanupTest(
        Effect.gen(function* () {
          let captures = 0;
          const fixture = yield* cleanupFixture().pipe(
            Effect.provideService(
              WorktreeConsumers.ProcessPaths,
              Effect.sync(() => {
                captures++;
                return [];
              }),
            ),
          );
          if (mode === "off") {
            yield* seedObservationResources(fixture);
            fixture.setDependencyRetention(null);
          } else fixture.setDependencyRetention(14);
          yield* fixture.service.runNow;
          expect(captures).toBe(0);
          expect(yield* fixture.fs.exists(fixture.worktree)).toBe(true);
        }),
      ),
  );
  it.live("shares unavailable evidence without candidate fallback or renewal", () =>
    runCleanupTest(
      Effect.gen(function* () {
        let captures = 0;
        const fixture = yield* cleanupFixture().pipe(
          Effect.provideService(
            WorktreeConsumers.ProcessPaths,
            Effect.sync(() => {
              captures++;
              return captures === 1 ? null : [];
            }),
          ),
        );
        const other = yield* seedObservationResources(fixture);
        fixture.setDependencyRetention(3);
        const report = yield* fixture.service.runNow;
        expect(disposableEntries(report)).toHaveLength(4);
        expect(disposableEntries(report).every((entry) => entry.outcome === "kept")).toBe(true);
        expect(
          disposableEntries(report).every((entry) =>
            entry.reason.includes("Process file-consumer observation is unavailable"),
          ),
        ).toBe(true);
        expect(report.bytesFreed).toBe(0);
        expect(captures).toBe(1);
        for (const cwd of [fixture.worktree, other]) {
          expect(yield* fixture.fs.exists(`${cwd}/node_modules/package/index.js`)).toBe(true);
          const location = yield* fixture.command(cwd, ["rev-parse", "--absolute-git-dir"]);
          expect(
            yield* Effect.sync(
              () =>
                observeDependencyActivity(location.stdout.trim(), cwd, fixture.now, false, false)
                  .lastUsedAt,
            ),
          ).toBe(fixture.now - 4 * DAY_MS);
        }
        expect(
          yield* Effect.sync(
            () => generatedBuildActivity(fixture.worktree, "apps/web/dist")?.lastUsedAt,
          ),
        ).toBe(fixture.now - 4 * DAY_MS);
        expect(
          yield* fixture.fs.exists(
            `${other}/native/resource-monitor/target/debug/assets/emitted.bin`,
          ),
        ).toBe(true);
      }),
    ),
  );
  it.live.each([
    ["dependencies", "consumer"],
    ["dependencies", "usage mutation"],
    ["generated-builds", "consumer"],
    ["generated-builds", "usage mutation"],
  ] as const)("keeps %s after a late %s with independent final observation", ([resource, change]) =>
    runCleanupTest(
      Effect.gen(function* () {
        let captures = 0;
        let output = "";
        let renew = () => {};
        const fixture = yield* cleanupFixture().pipe(
          Effect.provideService(
            WorktreeConsumers.ProcessPaths,
            Effect.sync(() => {
              captures++;
              if (captures !== 2) return [];
              if (change === "consumer") return [output];
              renew();
              return [];
            }),
          ),
        );
        if (resource === "dependencies") {
          yield* fixture.enableDependencies;
          fixture.setDependencyRetention(3);
          output = `${fixture.worktree}/node_modules/package/index.js`;
          const location = yield* fixture.command(fixture.worktree, [
            "rev-parse",
            "--absolute-git-dir",
          ]);
          renew = () => {
            observeDependencyActivity(location.stdout.trim(), fixture.worktree, fixture.now, true);
          };
        } else {
          fixture.setDependencyRetention(3);
          yield* seedCompilerOutput(fixture, "apps/web/dist", fixture.now - 4 * DAY_MS);
          output = `${fixture.worktree}/apps/web/dist/assets/emitted.bin`;
          renew = () => recordGeneratedBuildUse(fixture.worktree, "apps/web/dist", fixture.now);
        }
        const report = yield* fixture.service.runNow;
        expect(report.entries.filter((entry) => entry.worktreeResource === resource)).toMatchObject(
          [{ outcome: "kept" }],
        );
        expect(captures).toBeGreaterThanOrEqual(2);
        expect(yield* fixture.fs.exists(output)).toBe(true);
        if (resource === "dependencies") {
          const location = yield* fixture.command(fixture.worktree, [
            "rev-parse",
            "--absolute-git-dir",
          ]);
          expect(
            yield* Effect.sync(
              () =>
                observeDependencyActivity(
                  location.stdout.trim(),
                  fixture.worktree,
                  fixture.now,
                  false,
                  false,
                ).lastUsedAt,
            ),
          ).toBeGreaterThanOrEqual(fixture.now);
        } else
          expect(
            yield* Effect.sync(
              () => generatedBuildActivity(fixture.worktree, "apps/web/dist")?.lastUsedAt,
            ),
          ).toBeGreaterThanOrEqual(fixture.now);
        const beforeNextSweep = captures;
        expect(
          (yield* fixture.service.runNow).entries.filter(
            (entry) => entry.worktreeResource === resource,
          ),
        ).toMatchObject([{ outcome: "kept" }]);
        expect(captures).toBe(beforeNextSweep + 1);
        expect(yield* fixture.fs.exists(output)).toBe(true);
      }),
    ),
  );
});

describe("verified build sweep shares the dependency rule", () => {
  it.live(
    "service-generated build reports remain readable by the historical three-kind client",
    () =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* cleanupFixture();
          fixture.setDependencyRetention(3);
          yield* seedCompilerOutput(fixture, "apps/web/dist", fixture.now - 4 * DAY_MS);
          const report = yield* fixture.service.runNow;
          const historical = decodeHistoricalReport(report);
          expect(historical.counts).toEqual(report.counts);
          expect(historical.entries).toMatchObject([
            {
              kind: "worktree",
              outcome: "removed",
              reason: expect.stringContaining("Build outputs:"),
            },
          ]);
          expect(report.entries[0]?.worktreeResource).toBe("generated-builds");
        }),
      ),
  );
  it("new report decoding accepts missing and unknown open resource details", () => {
    const report = {
      trigger: "manual",
      startedAt: "2026-06-10T12:00:00.000Z",
      finishedAt: "2026-06-10T12:00:01.000Z",
      entries: [
        {
          kind: "worktree",
          outcome: "kept",
          reason: "Retained worktree resource",
          path: null,
          threadId: null,
          threadTitle: null,
        },
      ],
      counts: { removed: 0, kept: 1, failed: 0 },
      omittedCount: 0,
    } as const;
    expect(decodeCleanupReport(report).entries[0]?.worktreeResource).toBeUndefined();
    expect(
      decodeCleanupReport({
        ...report,
        entries: [{ ...report.entries[0], worktreeResource: "future-resource" }],
      }).entries[0]?.worktreeResource,
    ).toBe("future-resource");
  });
  it.live(
    "reclaims verified ownerless output using its actual clock, then protects regenerated output and Off",
    () =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* cleanupFixture();
          fixture.setDependencyRetention(3);
          yield* seedCompilerOutput(fixture, "apps/web/dist", fixture.now - 4 * DAY_MS);
          fixture.setThreads([]);
          expect(
            (yield* fixture.service.runNow).entries.filter(
              (entry) => entry.worktreeResource === "generated-builds",
            ),
          ).toMatchObject([{ outcome: "removed" }]);
          yield* seedCompilerOutput(fixture, "apps/web/dist", fixture.now);
          expect(
            (yield* fixture.service.runNow).entries.filter(
              (entry) => entry.worktreeResource === "generated-builds",
            ),
          ).toMatchObject([{ outcome: "kept" }]);
          fixture.setProjectWholeCleanupOff(ProjectId.make("project-1"));
          expect(
            (yield* fixture.service.runNow).entries.filter(
              (entry) => entry.worktreeResource === "generated-builds",
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
          const fixture = yield* cleanupFixture();
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
              (entry) => entry.worktreeResource === "generated-builds",
            ),
          ).toMatchObject([{ outcome: "kept", reason: expect.stringContaining("unarchived") }]);
          const offProject = ProjectId.make("off-owner");
          fixture.setProjectWholeCleanupOff(offProject);
          fixture.setThreads([first, { ...sibling, projectId: offProject }]);
          expect(
            (yield* fixture.service.runNow).entries.filter(
              (entry) => entry.worktreeResource === "generated-builds",
            ),
          ).toMatchObject([{ outcome: "kept", reason: expect.stringContaining("off") }]);
          fixture.setThreads([first, sibling]);
          expect(
            (yield* fixture.service.runNow).entries.filter(
              (entry) => entry.worktreeResource === "generated-builds",
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
          const fixture = yield* cleanupFixture();
          fixture.setDependencyRetention(90);
          fixture.setThreads([
            shell({
              branch: "feature",
              worktreePath: fixture.worktree,
              archivedAt: fixture.at(-1),
              latestUserMessageAt: fixture.at(-1),
              latestRunCompletedAt: fixture.at(-1),
              latestRunId: RunId.make("completed-administrative-run"),
            }),
          ]);
          yield* seedCompilerOutput(fixture, root, fixture.now);
          yield* fixture.fs.writeFileString(
            `${fixture.worktree}/${root}/retained-note.txt`,
            "unique notes\n",
          );
          const report = yield* fixture.service.runNow;
          expect(
            report.entries.filter((entry) => entry.worktreeResource === "generated-builds"),
          ).toMatchObject([{ outcome: "removed", files: 1 }]);
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
    ([days, idleDays, outcome]) =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* cleanupFixture();
          fixture.setDependencyRetention(days);
          yield* seedCompilerOutput(fixture, "apps/web/dist", fixture.now - idleDays * DAY_MS);
          const report = yield* fixture.service.runNow;
          expect(
            report.entries.filter((entry) => entry.worktreeResource === "generated-builds"),
          ).toMatchObject([{ outcome }]);
          expect(yield* fixture.fs.exists(fixture.worktree)).toBe(true);
        }),
      ),
  );
  it.live(
    "inherits the environment delay, respects project Custom and Off, and retains legacy outputs",
    () =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* cleanupFixture();
          fixture.setDependencyRetention(3);
          yield* seedCompilerOutput(fixture, "apps/web/dist", fixture.now - 4 * DAY_MS);
          fixture.setProjectDependencyRetention(ProjectId.make("project-1"), 14);
          expect(
            (yield* fixture.service.runNow).entries.filter(
              (entry) => entry.worktreeResource === "generated-builds",
            ),
          ).toMatchObject([{ outcome: "kept" }]);
          fixture.setProjectWholeCleanupOff(ProjectId.make("project-1"));
          expect(
            (yield* fixture.service.runNow).entries.filter(
              (entry) => entry.worktreeResource === "generated-builds",
            ),
          ).toMatchObject([{ outcome: "kept", reason: expect.stringContaining("off") }]);
          expect(
            yield* fixture.fs.exists(`${fixture.worktree}/apps/web/dist/assets/emitted.bin`),
          ).toBe(true);
          // A different fixture establishes a legacy root without compiler provenance.
          const legacy = yield* cleanupFixture();
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
          expect(
            report.entries.filter((entry) => entry.worktreeResource === "generated-builds"),
          ).toMatchObject([{ outcome: "kept", reason: expect.stringContaining("review") }]);
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
        const fixture = yield* cleanupFixture().pipe(
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
            latestRunId: RunId.make("completed-administrative-run"),
          }),
        ]);
        paths = [`${fixture.worktree}/apps/web/dist/assets/emitted.bin`];
        expect(
          (yield* fixture.service.runNow).entries.filter(
            (entry) => entry.worktreeResource === "generated-builds",
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
            (entry) => entry.worktreeResource === "generated-builds",
          ),
        ).toMatchObject([{ outcome: "kept" }]);
        const statusOnly = yield* cleanupFixture();
        statusOnly.setDependencyRetention(3);
        yield* seedCompilerOutput(statusOnly, "apps/web/dist", statusOnly.now - 4 * DAY_MS);
        statusOnly.setThreads([
          shell({
            branch: "feature",
            worktreePath: statusOnly.worktree,
            latestUserMessageAt: statusOnly.at(-1),
            latestRunCompletedAt: statusOnly.at(-1),
            latestRunId: RunId.make("completed-administrative-run"),
          }),
        ]);
        expect(
          (yield* statusOnly.service.runNow).entries.filter(
            (entry) => entry.worktreeResource === "generated-builds",
          ),
        ).toMatchObject([{ outcome: "removed" }]);
      }),
    ),
  );
});

describe("storage cleanup reports and local file policies", () => {
  it.effect("automatically removes an eligible archived thread checkout", () =>
    runCleanupTest(
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW_MS);
        const fixture = yield* cleanupFixture();
        fixture.setThreads([
          shell({
            branch: "feature",
            worktreePath: fixture.worktree,
            archivedAt: at(-DAY_MS),
          }),
        ]);
        yield* fixture.activate(Stream.empty);
        const [report] = yield* fixture.service.reports.pipe(
          Stream.filter((report) => report !== null),
          Stream.take(1),
          Stream.runCollect,
        );
        yield* fixture.service.drain;
        expect(report).toMatchObject({
          trigger: "automatic",
          counts: { removed: 1, kept: 1, failed: 0 },
        });
        expect(checkoutEntries(report!)).toMatchObject([
          {
            threadId: "thread-1",
            path: fixture.worktree,
            outcome: "removed",
            reason: "All thread owners are archived",
          },
        ]);
        expect(yield* fixture.fs.exists(fixture.worktree)).toBe(false);
      }),
    ),
  );
  it.live.each(["before-check", "while-measuring"] as const)(
    "keeps a worktree protected by a missing project root (%s)",
    (timing) =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* pausedMeasurementFixture();
          if (timing === "before-check")
            fixture.setProjectRoots(
              projectShells([fixture.repo, `${fixture.worktree}/removed-checkout`]),
            );
          const cleanup = yield* fixture.service.runNow.pipe(Effect.forkChild);
          if (timing === "while-measuring") {
            yield* Deferred.await(fixture.measuring);
            fixture.setProjectRoots(
              projectShells([fixture.repo, `${fixture.worktree}/removed-checkout`]),
            );
          }
          yield* Deferred.succeed(fixture.resume, undefined);
          const report = yield* Fiber.join(cleanup);
          expect(report.entries.find((entry) => entry.path === fixture.worktree)).toMatchObject({
            outcome: "kept",
            reason: "Contains a project checkout",
          });
          expect(yield* fixture.fs.readFileString(`${fixture.worktree}/tracked.txt`)).toBe(
            "original\n",
          );
        }),
      ),
  );

  it.live("reports allocated bytes of single-link files without following symlinks", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, fs, worktree, command } = yield* cleanupFixture();
        const sizes = yield* Effect.forEach(yield* fs.readDirectory(worktree), (name) =>
          allocatedBytes(fs, `${worktree}/${name}`),
        );
        const outside = yield* fs.makeTempDirectoryScoped();
        yield* fs.writeFileString(`${outside}/external`, "must not count");
        yield* fs.writeFileString(`${outside}/store-file`, "shared ".repeat(10_000));
        yield* fs.makeDirectory(`${worktree}/nested/nested`, { recursive: true });
        yield* fs.writeFileString(`${worktree}/nested/nested/file`, "count me");
        sizes.push(yield* allocatedBytes(fs, `${worktree}/nested/nested/file`));
        yield* fs.link(`${outside}/store-file`, `${worktree}/nested/hardlinked`);
        yield* fs.symlink(outside, `${worktree}/nested/directory-link`);
        yield* fs.symlink(`${outside}/external`, `${worktree}/nested/file-link`);
        yield* fs.symlink(`${outside}/missing`, `${worktree}/nested/dangling-link`);
        yield* command(worktree, ["add", "nested"]);
        yield* command(worktree, ["commit", "-m", "record allocation fixtures"]);
        const report = yield* service.runNow;
        const bytes = sizes.reduce((sum, size) => sum + size, 0);
        expect(checkoutEntries(report)[0]).toMatchObject({
          outcome: "removed",
          bytes,
          files: null,
        });
        expect(report.bytesFreed).toBe(bytes);
        expect(yield* fs.readFileString(`${outside}/external`)).toBe("must not count");
        expect(yield* fs.readFileString(`${outside}/store-file`)).toBe("shared ".repeat(10_000));
        expect(yield* fs.exists(worktree)).toBe(false);
      }),
    ),
  );
  it.live("still removes a worktree when measuring its size fails", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { service, worktree } = yield* cleanupFixture().pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            readDirectory: (directory) => fs.readDirectory(`${directory}/missing-directory`),
          }),
        );
        const report = yield* service.runNow;
        expect(checkoutEntries(report)[0]).toMatchObject({
          outcome: "removed",
          bytes: null,
          files: null,
        });
        expect(report.bytesFreed).toBe(0);
        expect(yield* fs.exists(worktree)).toBe(false);
      }),
    ),
  );
  it.live.each([
    [
      "its owner's branch is cleared",
      (worktree: string) => [shell({ branch: null, worktreePath: worktree, updatedAt: at(0) })],
    ],
    [
      "its owner's branch changes",
      (worktree: string) => [shell({ branch: "other", worktreePath: worktree, updatedAt: at(0) })],
    ],
    [
      "its thread starts",
      (worktree: string) => [
        shell({ branch: "feature", worktreePath: worktree, status: "running" }),
      ],
    ],
    [
      "another thread starts using it",
      (worktree: string) => [
        shell({ branch: "feature", worktreePath: worktree }),
        shell({ id: ThreadId.make("thread-2"), branch: "feature", worktreePath: worktree }),
      ],
    ],
    [
      "an archived thread starts using it",
      (worktree: string) => [
        shell({ branch: "feature", worktreePath: worktree }),
        shell({
          id: ThreadId.make("thread-2"),
          branch: "feature",
          worktreePath: worktree,
          archivedAt: at(-DAY_MS),
        }),
      ],
    ],
  ] as const)("keeps a worktree when %s during size measurement", ([, threadsWhileMeasuring]) =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* pausedMeasurementFixture();
        const { fs, worktree } = fixture;
        fixture.setPolicy("tracked-changes");
        const cleanup = yield* fixture.service.runNow.pipe(Effect.forkChild);
        yield* Deferred.await(fixture.measuring);
        fixture.setThreads(threadsWhileMeasuring(worktree));
        yield* Deferred.succeed(fixture.resume, undefined);
        const report = yield* Fiber.join(cleanup);
        expect(checkoutEntries(report)[0]).toMatchObject({
          outcome: "kept",
          reason: "Thread activity or shared worktree changed since check",
          bytes: null,
        });
        expect(report.bytesFreed).toBe(0);
        expect(yield* fs.exists(worktree)).toBe(true);
      }),
    ),
  );
  it.live("reclaims a clean archived checkout immediately and preserves its branch history", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture();
        fixture.setRetention(90);
        fixture.setThreads([
          shell({
            branch: "feature",
            worktreePath: fixture.worktree,
            archivedAt: fixture.at(-1),
            createdAt: fixture.at(-1),
            latestUserMessageAt: fixture.at(-1),
            latestRunCompletedAt: fixture.at(-1),
            latestRunId: RunId.make("completed-administrative-run"),
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
        expect(checkoutEntries(report)[0]).toMatchObject({
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
  it.live("reclaims an archived checkout containing only ignored Finder metadata", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture();
        fixture.setThreads([
          shell({ branch: "feature", worktreePath: fixture.worktree, archivedAt: fixture.at(-1) }),
        ]);
        yield* fixture.fs.makeDirectory(`${fixture.worktree}/assets`);
        yield* fixture.fs.writeFileString(`${fixture.worktree}/assets/tracked.txt`, "source\n");
        yield* fixture.command(fixture.worktree, ["add", "assets/tracked.txt"]);
        yield* fixture.command(fixture.worktree, ["commit", "-m", "record nested source"]);
        yield* fixture.fs.writeFileString(`${fixture.repo}/.git/info/exclude`, ".DS_Store\n");
        for (const relative of [".DS_Store", "assets/.DS_Store"])
          yield* fixture.fs.writeFileString(`${fixture.worktree}/${relative}`, "Finder metadata");
        const before = (yield* fixture.command(fixture.repo, ["rev-parse", "refs/heads/feature"]))
          .stdout;

        expect(checkoutEntries(yield* fixture.service.runNow)[0]).toMatchObject({
          outcome: "removed",
          reason: "All thread owners are archived",
        });
        expect(yield* fixture.fs.exists(fixture.worktree)).toBe(false);
        expect(
          (yield* fixture.command(fixture.repo, ["rev-parse", "refs/heads/feature"])).stdout,
        ).toBe(before);
      }),
    ),
  );
  it.live.each([".env", ".DS_Store.backup"])(
    "preserves ignored %s alongside Finder metadata",
    (relative) =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* cleanupFixture();
          yield* fixture.fs.writeFileString(`${fixture.repo}/.git/info/exclude`, ".DS_Store*\n");
          yield* fixture.fs.writeFileString(`${fixture.worktree}/.DS_Store`, "Finder metadata");
          yield* fixture.fs.writeFileString(`${fixture.worktree}/${relative}`, "retained bytes");
          expect(checkoutEntries(yield* fixture.service.runNow)[0]).toMatchObject({
            outcome: "kept",
          });
          expect(yield* fixture.fs.readFileString(`${fixture.worktree}/${relative}`)).toBe(
            "retained bytes",
          );
        }),
      ),
  );
  it.live.each(["directory", "symlink", "tracked-edit"] as const)(
    "preserves a %s named .DS_Store",
    (kind) =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* cleanupFixture();
          yield* fixture.fs.writeFileString(`${fixture.repo}/.git/info/exclude`, ".DS_Store\n");
          const target = `${fixture.worktree}/.DS_Store`;
          const outside = `${fixture.repo}/retained.txt`;
          yield* fixture.fs.writeFileString(outside, "outside bytes");
          if (kind === "directory") {
            yield* fixture.fs.makeDirectory(target);
            yield* fixture.fs.writeFileString(`${target}/notes.txt`, "retained bytes");
          } else if (kind === "symlink") {
            yield* fixture.fs.symlink(outside, target);
          } else {
            yield* fixture.fs.writeFileString(target, "tracked metadata");
            yield* fixture.command(fixture.worktree, ["add", "-f", ".DS_Store"]);
            yield* fixture.command(fixture.worktree, ["commit", "-m", "track named file"]);
            yield* fixture.fs.writeFileString(target, "retained edit");
          }
          expect(checkoutEntries(yield* fixture.service.runNow)[0]).toMatchObject({
            outcome: "kept",
          });
          expect(yield* fixture.fs.exists(target)).toBe(true);
          expect(yield* fixture.fs.readFileString(outside)).toBe("outside bytes");
          if (kind === "directory")
            expect(yield* fixture.fs.readFileString(`${target}/notes.txt`)).toBe("retained bytes");
          if (kind === "symlink") expect(yield* fixture.fs.readLink(target)).toBe(outside);
          if (kind === "tracked-edit")
            expect(yield* fixture.fs.readFileString(target)).toBe("retained edit");
        }),
      ),
  );
  it.live.each([3, 90])(
    "keeps a recent unarchived checkout for its configured %s day delay",
    (days) =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* cleanupFixture();
          fixture.setRetention(days);
          fixture.setThreads([
            shell({
              branch: "feature",
              worktreePath: fixture.worktree,
              latestUserMessageAt: fixture.at(-DAY_MS),
            }),
          ]);
          expect(checkoutEntries(yield* fixture.service.runNow)[0]).toMatchObject({
            outcome: "kept",
          });
          expect(yield* fixture.fs.exists(fixture.worktree)).toBe(true);
        }),
      ),
  );
  it.live("reclaims shared archived families but preserves an Off or unarchived owner", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture();
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
        expect(checkoutEntries(yield* fixture.service.runNow)[0]?.reason).toBe(
          "Shared by 2 threads",
        );
        const otherProject = ProjectId.make("off-owner-project");
        fixture.setProjectWholeCleanupOff(otherProject);
        fixture.setThreads([first, { ...sibling, projectId: otherProject }]);
        expect(checkoutEntries(yield* fixture.service.runNow)[0]?.reason).toBe(
          "Whole-worktree cleanup is off for an owner",
        );
        fixture.setThreads([first, sibling]);
        expect(checkoutEntries(yield* fixture.service.runNow)[0]).toMatchObject({
          outcome: "removed",
        });
      }),
    ),
  );
  it.live("protects an archived checkout used through an open output path with cwd elsewhere", () =>
    runCleanupTest(
      Effect.gen(function* () {
        let processPaths: readonly string[] = [];
        const fixture = yield* cleanupFixture().pipe(
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
        expect(checkoutEntries(report)[0]?.reason).toContain("process is using a file");
        expect(yield* fixture.fs.exists(fixture.worktree)).toBe(true);
        processPaths = [];
        expect(checkoutEntries(yield* fixture.service.runNow)[0]).toMatchObject({
          outcome: "removed",
        });
      }),
    ),
  );
  it.live("protects unknown ignored additions made while measuring a clean archived checkout", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        let measuredRoot: string | undefined;
        let additionWritten = false;
        const fixture = yield* cleanupFixture().pipe(
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
        expect(checkoutEntries(yield* fixture.service.runNow)[0]).toMatchObject({
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
          const fixture = yield* cleanupFixture();
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
          expect(checkoutEntries(report)[0]).toMatchObject({ outcome: "kept", bytes: null });
          expect(yield* fixture.fs.readFileString(`${fixture.worktree}/${relative}`)).toBe(
            "unique retained bytes\n",
          );
        }),
      ),
  );
  it.live("preserves unrecognized ignored installs without following their links", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, fs, worktree, setPolicy } = yield* cleanupFixture();
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
        expect(checkoutEntries(report)[0]).toMatchObject({
          outcome: "kept",
          bytes: null,
          files: null,
        });
        expect(checkoutEntries(report)[0]?.reason).toContain("ignored files (node_modules/)");
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
        const { service, worktree } = yield* cleanupFixture().pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            readDirectory: (directory) => fs.readDirectory(`${directory}/missing-directory`),
          }),
        );
        const report = yield* service.runNow;
        expect(checkoutEntries(report)[0]).toMatchObject({
          outcome: "removed",
          bytes: null,
          files: null,
        });
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
        const fixture = yield* cleanupFixture().pipe(
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
        expect(checkoutEntries(report)[0]).toMatchObject({
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
        const fixture = yield* cleanupFixture().pipe(
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
        expect(checkoutEntries(kept)[0]).toMatchObject({
          outcome: "kept",
          reason: "Provider session is still open",
          bytes: null,
        });
        expect(walked.filter((directory) => directory.startsWith(root))).toEqual([]);
        fixture.setOpenSessionCwd(null);
        const removed = yield* fixture.service.runNow;
        expect(checkoutEntries(removed)[0]).toMatchObject({ outcome: "removed" });
        expect(checkoutEntries(removed)[0]?.bytes).toBeGreaterThan(0);
        expect(walked).toContain(root);
      }),
    ),
  );
  it.live("compares the checked-out branch without a full status", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, fs, repo, worktree, command, setThreads, fullStatusCalls } =
          yield* cleanupFixture();
        const changed = { outcome: "kept", reason: "Repository or branch changed" };
        yield* command(worktree, ["checkout", "--detach"]);
        expect(checkoutEntries(yield* service.runNow)[0]).toMatchObject(changed);
        // A branch that has no commit yet is still a different branch.
        yield* command(worktree, ["switch", "--orphan", "other"]);
        expect(checkoutEntries(yield* service.runNow)[0]).toMatchObject(changed);
        // Status output reserves a leading "(" for a detached HEAD.
        yield* command(worktree, ["switch", "-c", "(feature)", "feature"]);
        setThreads([shell({ branch: "(feature)", worktreePath: worktree })]);
        expect(checkoutEntries(yield* service.runNow)[0]).toMatchObject(changed);
        setThreads([shell({ branch: "feature", worktreePath: worktree })]);
        yield* command(worktree, ["tag", "feature", "feature"]);
        // Newer Git refuses to create a tag named HEAD, but still reads one.
        yield* command(worktree, ["update-ref", "refs/tags/HEAD", "refs/heads/feature"]);
        yield* command(worktree, ["switch", "feature"]);
        const index = (yield* command(worktree, ["rev-parse", "--git-path", "index"])).stdout;
        yield* fs.writeFileString(`${index.trim()}.lock`, "");
        const locked = checkoutEntries(yield* service.runNow)[0];
        expect(locked).toMatchObject({
          outcome: "failed",
          projectPath: repo,
          path: worktree,
          threadId: "thread-1",
          threadTitle: "Thread",
        });
        expect(locked?.reason).toContain("Git index is locked");
        expect(yield* fs.readFileString(`${worktree}/tracked.txt`)).toBe("original\n");
        yield* fs.remove(`${index.trim()}.lock`);
        const gitFile = yield* fs.readFileString(`${worktree}/.git`);
        yield* fs.writeFileString(`${worktree}/.git`, "gitdir: /missing-git-directory\n");
        expect(checkoutEntries(yield* service.runNow)[0]).toMatchObject({
          outcome: "kept",
          reason: "Repository and project mapping changed",
        });
        yield* fs.writeFileString(`${worktree}/.git`, gitFile);
        expect(checkoutEntries(yield* service.runNow)[0]).toMatchObject({ outcome: "removed" });
        expect(fullStatusCalls()).toBe(0);
      }),
    ),
  );
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
  it.live("retains clean archived source when an unresolved historical owner claims its path", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture();
        fixture.setThreads([
          shell({ branch: "feature", worktreePath: fixture.worktree, archivedAt: fixture.at(-1) }),
        ]);
        fixture.setHistoricalOwners([
          {
            threadId: "unresolved-legacy-owner",
            projectId: "missing-project",
            branch: null,
            worktreePath: fixture.worktree,
          },
        ]);
        const report = yield* fixture.service.runNow;
        expect(report.entries).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              outcome: "kept",
              reason: expect.stringContaining("Historical thread ownership"),
            }),
          ]),
        );
        expect(yield* fixture.fs.exists(fixture.worktree)).toBe(true);
        expect(
          (yield* fixture.command(fixture.repo, ["show-ref", "--verify", "refs/heads/feature"]))
            .exitCode,
        ).toBe(0);
      }),
    ),
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
        const { service, fs, worktree, setPolicy } = yield* cleanupFixture();
        setPolicy(policy);
        expect(yield* service.latestReport).toBeNull();
        yield* fs.writeFileString(`${worktree}/${file}`, "local data\n");
        const report = yield* service.runNow;
        yield* service.drain;
        expect(report.trigger).toBe("manual");
        expect(
          report.entries.filter(
            (entry) => entry.kind === "worktree" && entry.worktreeResource === undefined,
          ),
        ).toMatchObject([
          {
            outcome,
            path: worktree,
            threadId: "thread-1",
            threadTitle: "Thread",
            bytes: null,
            files: null,
          },
        ]);
        expect(report.bytesFreed).toBe(0);
        expect(yield* fs.exists(worktree)).toBe(outcome === "kept");
        expect(yield* service.latestReport).toEqual(report);
        if (outcome === "kept")
          expect(checkoutEntries(report)[0]?.reason).toContain(
            file === ".env" ? "ignored files (.env)" : "uncommitted changes (1 file)",
          );
      }),
    ),
  );
  it.live(
    "discovers trunk without a remote HEAD or tracking ref and removes an integrated worktree",
    () =>
      runCleanupTest(
        Effect.gen(function* () {
          const { service, fs, repo, worktree, command } = yield* cleanupFixture({
            ...DEFAULT_SERVER_SETTINGS.storageCleanup,
            worktreeUnchanged: true,
          });
          const remote = yield* fs.makeTempDirectoryScoped({ prefix: "cleanup-remote-" });
          yield* command(remote, ["init", "--bare", "-b", "trunk"]);
          yield* command(repo, ["remote", "add", "origin", remote]);
          yield* command(repo, ["push", "origin", "main:trunk"]);
          yield* command(repo, ["update-ref", "-d", "refs/remotes/origin/trunk"]);
          expect((yield* command(repo, ["for-each-ref", "refs/remotes/origin"])).stdout).toBe("");

          const report = yield* service.runNow;
          expect(report.entries[0]).toMatchObject({
            outcome: "removed",
            reason: "No commits beyond the default branch",
          });
          expect(yield* fs.exists(worktree)).toBe(false);
        }),
      ),
  );
  it.live(
    "keeps worktree commits present on nondefault main but absent from advertised trunk",
    () =>
      runCleanupTest(
        Effect.gen(function* () {
          const { service, fs, repo, worktree, command } = yield* cleanupFixture({
            ...DEFAULT_SERVER_SETTINGS.storageCleanup,
            worktreeUnchanged: true,
          });
          const remote = yield* fs.makeTempDirectoryScoped({ prefix: "cleanup-remote-" });
          yield* command(remote, ["init", "--bare", "-b", "trunk"]);
          yield* command(repo, ["remote", "add", "origin", remote]);
          yield* command(repo, ["push", "origin", "main:trunk"]);
          yield* fs.writeFileString(`${worktree}/tracked.txt`, "unmerged work\n");
          yield* command(worktree, ["commit", "-am", "unmerged work"]);
          yield* command(repo, ["push", "origin", "feature:main"]);
          expect(
            (yield* command(repo, ["symbolic-ref", "refs/remotes/origin/HEAD"]).pipe(Effect.exit))
              ._tag,
          ).toBe("Failure");

          const report = yield* service.runNow;
          expect(checkoutEntries(report)[0]).toMatchObject({
            outcome: "kept",
            reason: "Has commits beyond the default branch",
          });
          expect(yield* fs.readFileString(`${worktree}/tracked.txt`)).toBe("unmerged work\n");
        }),
      ),
  );
  it.live("keeps the worktree when the remote default is unavailable even if main exists", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, fs, repo, worktree, command } = yield* cleanupFixture({
          ...DEFAULT_SERVER_SETTINGS.storageCleanup,
          worktreeUnchanged: true,
        });
        const remote = yield* fs.makeTempDirectoryScoped({ prefix: "cleanup-remote-" });
        yield* command(remote, ["init", "--bare", "-b", "trunk"]);
        yield* command(repo, ["remote", "add", "origin", remote]);
        // The remote HEAD names an unborn trunk; main exists but is not its default.
        yield* command(repo, ["push", "origin", "main"]);

        const report = yield* service.runNow;
        expect(checkoutEntries(report)[0]).toMatchObject({
          outcome: "kept",
          reason: "Default branch is unavailable",
        });
        expect(yield* fs.exists(worktree)).toBe(true);
      }),
    ),
  );
  it.live("preserves tracked edits written after the final status check", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture();
        fixture.setPolicy("tracked-changes");
        fixture.editBeforeRemoval();
        const report = yield* fixture.service.runNow;
        expect(checkoutEntries(report)[0]).toMatchObject({
          outcome: "failed",
          bytes: null,
          files: null,
        });
        expect(report.bytesFreed).toBe(0);
        expect(checkoutEntries(report)[0]?.reason).toContain(
          "contains modified or untracked files",
        );
        expect(yield* fixture.fs.readFileString(`${fixture.worktree}/tracked.txt`)).toBe(
          "late edit\n",
        );
      }),
    ),
  );
  it.live("caps entries while preserving totals and prioritizing removals", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, fs, worktree, setThreads } = yield* cleanupFixture();
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
        expect(checkoutEntries(report)[0]?.outcome).toBe("removed");
        expect(checkoutEntries(report)[0]?.bytes).toBeGreaterThan(0);
        expect(report.bytesFreed).toBe(checkoutEntries(report)[0]?.bytes);
      }),
    ),
  );
  it.live("keeps staged edits in tracked-only mode", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, fs, worktree, setPolicy, command } = yield* cleanupFixture();
        setPolicy("tracked-changes");
        yield* fs.writeFileString(`${worktree}/tracked.txt`, "staged\n");
        yield* command(worktree, ["add", "tracked.txt"]);
        expect(checkoutEntries(yield* service.runNow)[0]).toMatchObject({
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
          const fixture = yield* cleanupFixture();
          const { service, fs, worktree, setThreads } = fixture;
          setThreads([shell({ branch: "feature", worktreePath: worktree, status: "running" })]);
          expect(checkoutEntries(yield* service.runNow)[0]?.reason).toContain("Thread is running");
          setThreads([
            shell({ branch: "feature", worktreePath: worktree }),
            shell({ id: ThreadId.make("thread-2"), branch: "feature", worktreePath: worktree }),
          ]);
          expect(checkoutEntries(yield* service.runNow)[0]?.reason).toBe("Shared by 2 threads");
          setThreads([
            shell({ branch: "feature", worktreePath: worktree }),
            shell({
              id: ThreadId.make("thread-2"),
              branch: "feature",
              worktreePath: worktree,
              archivedAt: at(-DAY_MS),
            }),
          ]);
          expect(checkoutEntries(yield* service.runNow)[0]?.reason).toBe("Shared by 2 threads");
          expect(yield* fs.exists(worktree)).toBe(true);
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
              (entry) => entry.kind === "worktree" && entry.worktreeResource === undefined,
            ),
          ).toEqual([]);
        }),
      ),
  );
  it.live("persists sweep and dependency decision records in the local audit file", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture();
        fixture.disable();
        fixture.setDependencyPolicy(8);
        yield* fixture.fs.makeDirectory(`${fixture.worktree}/node_modules`, { recursive: true });
        const report = yield* fixture.service.runNow;
        expect(report.entries).toContainEqual(
          expect.objectContaining({
            kind: "worktree",
            worktreeResource: "dependencies",
            outcome: "kept",
            reason: "Dependencies: No dependency install could be safely recognized",
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
        const fixture = yield* cleanupFixture();
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
        yield* fixture.seedAgedDependencyUse;
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
        const fixture = yield* cleanupFixture();
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
        yield* fixture.seedAgedDependencyUse;
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
        const fixture = yield* cleanupFixture();
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
        const fixture = yield* cleanupFixture();
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
        const fixture = yield* cleanupFixture();
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
        const fixture = yield* cleanupFixture();
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
        const fixture = yield* cleanupFixture();
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
        const fixture = yield* cleanupFixture();
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
        const fixture = yield* cleanupFixture();
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
        const fixture = yield* cleanupFixture();
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

        yield* fixture.seedAgedDependencyUse;
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
        const fixture = yield* cleanupFixture();
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
          const fixture = yield* cleanupFixture();
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
        const fixture = yield* cleanupFixture();
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
        const fixture = yield* cleanupFixture().pipe(
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
        const fixture = yield* cleanupFixture();
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
        const fixture = yield* cleanupFixture();
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
          const fixture = yield* cleanupFixture();
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
        const fixture = yield* cleanupFixture();
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
        expect(yield* fixture.fs.exists(fixture.worktree)).toBe(true);
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
          const fixture = yield* cleanupFixture();
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
        const { service } = yield* cleanupFixture();
        const reports = yield* Effect.all([service.runNow, service.runNow], {
          concurrency: "unbounded",
        });
        yield* service.drain;
        expect(
          reports
            .flatMap((report) => report.entries)
            .filter((entry) => entry.kind === "worktree" && entry.worktreeResource === undefined),
        ).toMatchObject([{ outcome: "removed" }]);
        expect(yield* service.latestReport).toEqual(reports[1]);
      }),
    ),
  );
  it.live("aggregates expired artifacts and rotated logs while retaining current logs", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, fs, config, enableFiles, disable } = yield* cleanupFixture();
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
        const fixture = yield* cleanupFixture();
        const { service, worktree, command, enableFiles } = fixture;
        enableFiles();
        yield* command(worktree, ["worktree", "lock", worktree]);
        const report = yield* service.runNow;
        expect(checkoutEntries(report)[0]).toMatchObject({ outcome: "failed" });
        expect(checkoutEntries(report)[0]?.reason).toContain("git worktree remove: fatal:");
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
        const fixture = yield* cleanupFixture();
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
        expect(yield* fixture.fs.exists(fixture.worktree)).toBe(true);
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
        const fixture = yield* cleanupFixture();
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

describe("settled worktree rechecks", () => {
  it.live.each([{ settledAt: null }, { settledAt: at(DAY_MS) }])(
    "keeps a checkout changed during measurement (%j)",
    (change) =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* pausedMeasurementFixture();
          const thread = shell({
            branch: "feature",
            worktreePath: fixture.worktree,
            settledAt: at(0),
          });
          fixture.setSettings({
            storageCleanup: {
              ...DEFAULT_SERVER_SETTINGS.storageCleanup,
              worktreeSettledAfterDays: 0,
            },
          });
          fixture.setThreads([thread]);
          const run = yield* fixture.service.runNow.pipe(Effect.forkChild);
          yield* Deferred.await(fixture.measuring);
          fixture.setThreads([{ ...thread, ...change }]);
          yield* Deferred.succeed(fixture.resume, undefined);
          const report = yield* Fiber.join(run);
          expect(checkoutEntries(report)[0]?.reason).toBe(
            "Thread activity or shared worktree changed since check",
          );
          expect(yield* fixture.fs.exists(fixture.worktree)).toBe(true);
        }),
      ),
  );
});

it.live("keeps saved usage data when removing a settled checkout", () =>
  runCleanupTest(
    Effect.gen(function* () {
      const fixture = yield* cleanupFixture();
      fixture.setSettings({
        storageCleanup: { ...DEFAULT_SERVER_SETTINGS.storageCleanup, worktreeSettledAfterDays: 0 },
      });
      fixture.setThreads([
        shell({ branch: "feature", worktreePath: fixture.worktree, settledAt: at(0) }),
      ]);
      yield* fixture.fs.makeDirectory(fixture.config.stateDir, { recursive: true });
      const cachePath = `${fixture.config.stateDir}/${SCAN_CACHE_FILE_NAME}`;
      const savedUsage = JSON.stringify({ tokens: 12345, cost: 1.25 });
      yield* fixture.fs.writeFileString(cachePath, savedUsage);
      expect((yield* fixture.service.runNow).counts.removed).toBe(1);
      expect(yield* fixture.fs.readFileString(cachePath)).toBe(savedUsage);
    }),
  ),
);

const seedLegacyReviewOutput = Effect.fn("test.seedLegacyReviewOutput")(function* (
  fixture: Effect.Success<ReturnType<typeof cleanupFixture>>,
  app = "web",
) {
  const source = `${fixture.worktree}/apps/${app}`;
  yield* fixture.fs.makeDirectory(source, { recursive: true });
  yield* fixture.fs.writeFileString(`${source}/package.json`, '{"name":"generic-app"}');
  yield* fixture.fs.writeFileString(`${source}/vite.config.ts`, "export default {};\n");
  yield* fixture.command(fixture.worktree, ["add", `apps/${app}`]);
  yield* fixture.command(fixture.worktree, ["commit", "-m", "generic build sources"]);
  yield* fixture.fs.makeDirectory(`${source}/dist`);
  yield* fixture.fs.writeFileString(`${source}/dist/old.js`, "old generated bytes");
  yield* fixture.fs.writeFileString(`${source}/dist/notes.txt`, "retain this note");
});

describe("legacy build review service", () => {
  it.live(
    "lists ownerless builds and starts the configured delay without backdating old files",
    () =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* cleanupFixture();
          fixture.setDependencyRetention(3);
          fixture.setThreads([]);
          yield* seedLegacyReviewOutput(fixture);
          const targets = yield* fixture.service.buildReviewTargets({});
          expect(targets).toHaveLength(1);
          expect(targets[0]).toMatchObject({
            root: "apps/web/dist",
            archived: false,
            delayDays: 3,
            protectedReason: null,
          });
          expect(targets[0]!.eligibleAt).toBeGreaterThanOrEqual(fixture.now + 3 * DAY_MS);
          const preview = yield* fixture.service.previewBuildReview({ targetId: targets[0]!.id });
          expect(preview.selectedPaths).toEqual([]);
          const saved = yield* fixture.service.selectBuildReview({
            targetId: targets[0]!.id,
            previewToken: preview.token,
            paths: ["old.js"],
          });
          expect(saved.selectedCount).toBe(1);
          const report = yield* fixture.service.runNow;
          expect(
            report.entries.filter((entry) => entry.worktreeResource === "generated-builds"),
          ).toMatchObject([{ outcome: "kept" }]);
          expect(yield* fixture.fs.exists(`${fixture.worktree}/apps/web/dist/old.js`)).toBe(true);
        }),
      ),
  );

  it.live(
    "reclaims only approved aged ownerless files and retains protection after consumption",
    () =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* cleanupFixture();
          fixture.setDependencyRetention(3);
          fixture.setThreads([]);
          yield* seedLegacyReviewOutput(fixture);
          yield* Effect.sync(() =>
            observeLegacyBuild(fixture.worktree, "apps/web/dist", fixture.now - 4 * DAY_MS),
          );
          const [target] = yield* fixture.service.buildReviewTargets({});
          const preview = yield* fixture.service.previewBuildReview({ targetId: target!.id });
          yield* fixture.service.selectBuildReview({
            targetId: target!.id,
            previewToken: preview.token,
            paths: ["old.js"],
          });
          const report = yield* fixture.service.runNow;
          expect(
            report.entries.filter((entry) => entry.worktreeResource === "generated-builds"),
          ).toMatchObject([{ outcome: "removed", files: 1 }]);
          expect(
            yield* fixture.fs.readFileString(`${fixture.worktree}/apps/web/dist/notes.txt`),
          ).toBe("retain this note");
          yield* fixture.fs.writeFileString(
            `${fixture.worktree}/apps/web/dist/old.js`,
            "recreated bytes",
          );
          expect(
            (yield* fixture.service.runNow).entries.filter(
              (entry) => entry.worktreeResource === "generated-builds",
            ),
          ).toMatchObject([{ outcome: "kept" }]);
          expect(yield* fixture.fs.exists(`${fixture.worktree}/apps/web/dist/old.js`)).toBe(true);
        }),
      ),
  );

  it.live.each(["off", "ambiguous", "provider", "consumer"] as const)(
    "retains %s ownerless protection during review",
    (mode) =>
      runCleanupTest(
        Effect.gen(function* () {
          let paths: readonly string[] = [];
          const fixture = yield* cleanupFixture().pipe(
            Effect.provideService(
              WorktreeConsumers.ProcessPaths,
              Effect.sync(() => paths),
            ),
          );
          fixture.setDependencyRetention(3);
          fixture.setThreads([]);
          yield* seedLegacyReviewOutput(fixture);
          if (mode === "off") fixture.setDependencyRetention(null);
          if (mode === "ambiguous")
            fixture.setProjectRoots(projectShells([fixture.repo, fixture.repo]));
          if (mode === "provider") fixture.setOpenSessionCwd(fixture.worktree);
          if (mode === "consumer") paths = [`${fixture.worktree}/apps/web/dist/old.js`];
          const [target] = yield* fixture.service.buildReviewTargets({});
          expect(target?.protectedReason).toBeTruthy();
          const preview = yield* fixture.service
            .previewBuildReview({ targetId: target!.id })
            .pipe(Effect.result);
          expect(preview._tag).toBe("Failure");
          expect(yield* fixture.fs.exists(`${fixture.worktree}/apps/web/dist/old.js`)).toBe(true);
        }),
      ),
  );

  it.live("archived owners remove reviewed files immediately and protect the whole checkout", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture();
        fixture.setDependencyRetention(90);
        const owner = shell({
          branch: "feature",
          worktreePath: fixture.worktree,
          archivedAt: fixture.at(-1),
        });
        fixture.setThreads([owner]);
        yield* seedLegacyReviewOutput(fixture);
        const [target] = yield* fixture.service.buildReviewTargets({});
        expect(target?.archived).toBe(true);
        const preview = yield* fixture.service.previewBuildReview({ targetId: target!.id });
        yield* fixture.service.selectBuildReview({
          targetId: target!.id,
          previewToken: preview.token,
          paths: ["old.js"],
        });
        fixture.setThreads([
          {
            ...owner,
            updatedAt: fixture.at(1),
            lastVisitedAt: fixture.at(1),
            latestUserMessageAt: fixture.at(1),
            latestRunCompletedAt: fixture.at(2),
            latestRunId: RunId.make("finished-status-request"),
          },
        ]);
        expect(
          (yield* fixture.service.runNow).entries.filter(
            (entry) => entry.worktreeResource === "generated-builds",
          ),
        ).toMatchObject([{ outcome: "removed", files: 1 }]);
        expect(
          yield* fixture.fs.readFileString(`${fixture.worktree}/apps/web/dist/notes.txt`),
        ).toBe("retain this note");
        yield* fixture.fs.remove(`${fixture.worktree}/apps/web/dist`, { recursive: true });
        fixture.setRetention(1);
        fixture.setPolicy("tracked-changes");
        yield* fixture.service.runNow;
        expect(yield* fixture.fs.exists(fixture.worktree)).toBe(true);
      }),
    ),
  );

  it.live("changed ownership or policy invalidates the preview without granting authority", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture();
        fixture.setDependencyRetention(3);
        fixture.setThreads([]);
        yield* seedLegacyReviewOutput(fixture);
        const [target] = yield* fixture.service.buildReviewTargets({});
        const preview = yield* fixture.service.previewBuildReview({ targetId: target!.id });
        fixture.setThreads([shell({ branch: "feature", worktreePath: fixture.worktree })]);
        const result = yield* fixture.service
          .selectBuildReview({
            targetId: target!.id,
            previewToken: preview.token,
            paths: ["old.js"],
          })
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        expect(yield* fixture.fs.exists(`${fixture.worktree}/apps/web/dist/old.js`)).toBe(true);
      }),
    ),
  );
});

it.live.each(["longer delay", "Off review", "competing mapping"] as const)(
  "observed %s permanently revokes legacy selection before policy early exits",
  (change) =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture();
        fixture.setDependencyRetention(3);
        fixture.setThreads([]);
        yield* seedLegacyReviewOutput(fixture);
        yield* Effect.sync(() =>
          observeLegacyBuild(fixture.worktree, "apps/web/dist", fixture.now - 4 * DAY_MS),
        );
        const [target] = yield* fixture.service.buildReviewTargets({});
        const preview = yield* fixture.service.previewBuildReview({ targetId: target!.id });
        yield* fixture.service.selectBuildReview({
          targetId: target!.id,
          previewToken: preview.token,
          paths: ["old.js"],
        });
        if (change === "longer delay") {
          fixture.setDependencyRetention(30);
          yield* fixture.service.runNow;
        } else if (change === "competing mapping") {
          fixture.setProjectRoots(projectShells([fixture.repo, fixture.repo]));
          yield* fixture.service.runNow;
          fixture.setProjectRoots(projectShells([fixture.repo]));
        } else {
          fixture.setDependencyRetention(null);
          const [protectedTarget] = yield* fixture.service.buildReviewTargets({});
          expect(protectedTarget?.protectedReason).toContain("off");
        }
        fixture.setDependencyRetention(3);
        const report = yield* fixture.service.runNow;
        expect(
          report.entries.filter((entry) => entry.worktreeResource === "generated-builds"),
        ).toMatchObject([{ outcome: "kept" }]);
        expect(yield* fixture.fs.readFileString(`${fixture.worktree}/apps/web/dist/old.js`)).toBe(
          "old generated bytes",
        );
        expect(
          yield* fixture.fs.readFileString(`${fixture.worktree}/apps/web/dist/notes.txt`),
        ).toBe("retain this note");
        const refreshed = yield* fixture.service.previewBuildReview({ targetId: target!.id });
        expect(refreshed.selectedPaths).toEqual([]);
      }),
    ),
);

it.live(
  "targeted build preview skips sibling preflight and retains the selected final consumer guard",
  () =>
    runCleanupTest(
      Effect.gen(function* () {
        let captures = 0;
        let finalConsumerCapture = -1;
        let selectedOutput = "";
        const fixture = yield* cleanupFixture().pipe(
          Effect.provideService(
            WorktreeConsumers.ProcessPaths,
            Effect.sync(() => {
              captures++;
              return captures === finalConsumerCapture ? [selectedOutput] : [];
            }),
          ),
        );
        fixture.setDependencyRetention(3);
        fixture.setThreads([]);
        yield* seedLegacyReviewOutput(fixture);
        selectedOutput = `${fixture.worktree}/apps/web/dist/old.js`;
        const [target] = yield* fixture.service.buildReviewTargets({});
        captures = 0;
        yield* fixture.service.previewBuildReview({ targetId: target!.id });
        const capturesWithoutSibling = captures;
        expect(capturesWithoutSibling).toBeGreaterThan(1);
        yield* seedLegacyReviewOutput(fixture, "server");
        captures = 0;
        yield* fixture.service.previewBuildReview({ targetId: target!.id });
        expect(captures).toBe(capturesWithoutSibling);
        captures = 0;
        finalConsumerCapture = capturesWithoutSibling;
        const refused = yield* fixture.service
          .previewBuildReview({ targetId: target!.id })
          .pipe(Effect.result);
        expect(refused._tag).toBe("Failure");
        expect(yield* fixture.fs.readFileString(selectedOutput)).toBe("old generated bytes");
        expect(
          yield* fixture.fs.readFileString(`${fixture.worktree}/apps/server/dist/old.js`),
        ).toBe("old generated bytes");
      }),
    ),
);

it.live(
  "all-Off cleanup revokes the only project's prior build consent without process capture",
  () =>
    runCleanupTest(
      Effect.gen(function* () {
        let fileCaptures = 0;
        let cwdCaptures = 0;
        let providerCaptures = 0;
        const fixture = yield* cleanupFixture().pipe(
          Effect.provideService(
            WorktreeConsumers.ProcessPaths,
            Effect.sync(() => {
              fileCaptures++;
              return [];
            }),
          ),
          Effect.provideService(
            GeneratedDependencies.ProcessWorkingDirectories,
            Effect.sync(() => {
              cwdCaptures++;
              return [];
            }),
          ),
        );
        const projectId = ProjectId.make("project-1");
        fixture.setDependencyRetention(null);
        fixture.setProjectDependencyRetention(projectId, 3);
        fixture.setThreads([]);
        yield* seedLegacyReviewOutput(fixture);
        yield* Effect.sync(() =>
          observeLegacyBuild(fixture.worktree, "apps/web/dist", fixture.now - 4 * DAY_MS),
        );
        const [target] = yield* fixture.service.buildReviewTargets({});
        const preview = yield* fixture.service.previewBuildReview({ targetId: target!.id });
        yield* fixture.service.selectBuildReview({
          targetId: target!.id,
          previewToken: preview.token,
          paths: ["old.js"],
        });
        fixture.setProjectWholeCleanupOff(projectId);
        fixture.setOpenSessionCwd(fixture.repo);
        fixture.onSessionLiveRead(() => {
          providerCaptures++;
        });
        fileCaptures = 0;
        cwdCaptures = 0;
        yield* fixture.service.runNow;
        expect(fileCaptures).toBe(0);
        expect(cwdCaptures).toBe(0);
        expect(providerCaptures).toBe(0);
        fixture.setProjectDependencyRetention(projectId, 3);
        const report = yield* fixture.service.runNow;
        expect(
          report.entries.filter((entry) => entry.worktreeResource === "generated-builds"),
        ).toMatchObject([{ outcome: "kept" }]);
        expect(yield* fixture.fs.readFileString(`${fixture.worktree}/apps/web/dist/old.js`)).toBe(
          "old generated bytes",
        );
        expect(
          yield* fixture.fs.readFileString(`${fixture.worktree}/apps/web/dist/notes.txt`),
        ).toBe("retain this note");
        expect(
          (yield* fixture.service.previewBuildReview({ targetId: target!.id })).selectedPaths,
        ).toEqual([]);
      }),
    ),
);
