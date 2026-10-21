// @effect-diagnostics nodeBuiltinImport:off -- Opaque server-resolved build review identifiers.
import * as NodeCrypto from "node:crypto";
import {
  legacyBuildActivity,
  generatedBuildActivity,
  generatedBuildReviewProtection,
} from "@t3tools/shared/generatedBuildOwnership";
import {
  BuildReviewError,
  BUILD_REVIEW_PAGE_SIZE,
  GitCommandError,
  OrchestrationV2AppThreadJson,
  OrchestrationV2ProviderSessionJson,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type {
  BuildReviewTarget,
  BuildReviewTargetsInput,
  BuildReviewPreviewInput,
  BuildReviewPreview,
  BuildReviewSelectInput,
  BuildReviewSelectionResult,
  OrchestrationV2ThreadShell,
  ProviderSessionId,
  ProjectId,
  ServerSettings,
  ServerSettingsError,
  TerminalSummary,
  WorktreeCleanupRules,
  StorageCleanupReport,
  StorageCleanupReportEntry,
  ThreadId,
} from "@t3tools/contracts";
import { resolveWorktreeCleanup } from "@t3tools/shared/projectSettings";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import type { PlatformError } from "effect/PlatformError";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerConfig from "./config.ts";
import * as GitManager from "./git/GitManager.ts";
import * as WorktreeCleanup from "./orchestration-v2/WorktreeCleanupService.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionManager from "./orchestration-v2/ProviderSessionManager.ts";
import { threadHasQueuedTurnStart } from "./orchestration-v2/ThreadSettlementService.ts";
import { forkParked } from "./serverActivation.ts";
import * as Settings from "./serverSettings.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import { isFilesystemRoot, managedWorktreesDirectories } from "./worktreesDirectory.ts";
import * as PreviewHosting from "./preview/Hosting.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import { withWorkspaceLease } from "./workspace/workspaceLease.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as GeneratedDependencies from "./workspace/GeneratedDependencies.ts";
import * as GeneratedBuilds from "./workspace/GeneratedBuilds.ts";
import * as WorktreeConsumers from "./workspace/WorktreeConsumers.ts";

const decodeCleanupThread = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2AppThreadJson),
);
const decodeCleanupSession = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ProviderSessionJson),
);
const encodeAuditRecord = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const encodeReviewContext = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const isBuildReviewError = Schema.is(BuildReviewError);

const DAY_MS = 86_400_000;
// After a settle, the project's settle script needs time to open its
// terminal, which then protects the worktree.
const SETTLE_SCRIPT_GRACE_MS = 60_000;
// Worktree creation can precede its thread row, including review-guide checkouts.
const ORPHAN_WORKTREE_GRACE_MS = 60 * 60 * 1_000;

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const REPORT_ENTRY_LIMIT = 200;
const isGitCommandError = Schema.is(GitCommandError);

type CleanupWorkingEntry = {
  -readonly [Key in keyof StorageCleanupReportEntry]: StorageCleanupReportEntry[Key];
};

type OwnershipScope = {
  readonly cwd: string;
  readonly projectId: ProjectId;
  readonly branch: string | null;
  readonly threads: ReadonlyArray<
    Pick<OrchestrationV2ThreadShell, "id" | "projectId" | "branch" | "worktreePath">
  >;
  readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly workspaceRoot: string }>;
};

function cleanupFailureReason(error: { readonly message: string }) {
  return isGitCommandError(error)
    ? `${error.command}: ${error.detail.split(/\r?\n/)[0]}${error.reason ? ` (${error.reason})` : ""}`
    : (error.message.split(/\r?\n/)[0] ?? error.message);
}

const worktreeCleanupEnabled = (rules: WorktreeCleanupRules) =>
  rules.worktreeAfterDays !== null ||
  rules.worktreeSettledAfterDays !== null ||
  rules.worktreeOnMerge ||
  rules.worktreeOnDelete ||
  rules.worktreeUnchanged;

function anyWorktreePolicy(
  settings: ServerSettings,
  predicate: (rules: WorktreeCleanupRules) => boolean,
): boolean {
  return (
    predicate(resolveWorktreeCleanup(settings, null)) ||
    Object.keys(settings.projectSettingsOverrides).some((projectId) =>
      predicate(resolveWorktreeCleanup(settings, projectId as ProjectId)),
    )
  );
}

function sameProjectWorktreePolicies(left: ServerSettings, right: ServerSettings): boolean {
  return [
    ...new Set([
      ...Object.keys(left.projectSettingsOverrides),
      ...Object.keys(right.projectSettingsOverrides),
    ]),
  ].every((projectId) =>
    Equal.equals(
      left.projectSettingsOverrides[projectId as ProjectId]?.worktreeCleanup,
      right.projectSettingsOverrides[projectId as ProjectId]?.worktreeCleanup,
    ),
  );
}

export function storageCleanupThreadIdle(thread: OrchestrationV2ThreadShell, now: number): boolean {
  return (
    thread.worktreePath !== null &&
    thread.activeRunId === null &&
    (thread.status === "idle" ||
      thread.status === "completed" ||
      thread.status === "interrupted" ||
      thread.status === "failed" ||
      thread.status === "cancelled" ||
      thread.status === "rolled_back") &&
    (thread.pendingBackgroundTasks?.length ?? 0) === 0 &&
    thread.pendingRuntimeRequest === null &&
    !threadHasQueuedTurnStart(thread, now)
  );
}

/** PR metadata refreshes must not reset the inactivity clock. */
export function storageCleanupActivityAt(thread: OrchestrationV2ThreadShell): number {
  return Math.max(
    ...[
      thread.createdAt,
      thread.latestUserMessageAt,
      thread.latestRunRequestedAt,
      thread.latestRunStartedAt,
      thread.latestRunCompletedAt,
    ].flatMap((value) => (value == null ? [] : [DateTime.toEpochMillis(value)])),
  );
}

/** Only a complete subagent chain within this worktree shares ownership. */
function worktreeOwner(threads: ReadonlyArray<OrchestrationV2ThreadShell>) {
  if (threads.length === 1) return threads[0];
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const tops = threads.filter((thread) => !byId.has(thread.lineage.parentThreadId!));
  if (tops.length !== 1) return undefined;
  const owner = tops[0]!;
  for (const thread of threads) {
    let current = thread;
    const seen = new Set<string>();
    while (current.id !== owner.id) {
      if (
        seen.has(current.id) ||
        current.lineage.relationshipToParent !== "subagent" ||
        current.lineage.rootThreadId !== owner.lineage.rootThreadId
      )
        return undefined;
      seen.add(current.id);
      const parent = byId.get(current.lineage.parentThreadId!);
      if (parent === undefined) return undefined;
      current = parent;
    }
  }
  return owner;
}

/**
 * Whether the host's pull request proves this worktree's head was merged. A
 * squash or rebase merge leaves the head outside the default branch, so the
 * merged pull request then has to name this exact commit.
 */
export function storageCleanupPullRequestMerged(
  pullRequest: Pick<
    GitManager.GitBranchPullRequest,
    "state" | "headRef" | "baseRef" | "headSha"
  > | null,
  worktree: {
    readonly branch: string;
    readonly defaultBranch: string;
    readonly headSha: string;
    readonly integrated: boolean;
  },
): boolean {
  return (
    pullRequest?.state === "merged" &&
    (worktree.integrated ||
      (pullRequest.headRef === worktree.branch &&
        pullRequest.baseRef === worktree.defaultBranch &&
        pullRequest.headSha === worktree.headSha))
  );
}

/** Deleted threads have no shell activity summary; deletion and later events reset retention. */
export function storageCleanupDeletedActivityAt(
  thread: { readonly deletedAt: DateTime.Utc | null; readonly updatedAt: DateTime.Utc },
  latestEventAt: string | null,
): number | null {
  if (thread.deletedAt === null) return null;
  const eventAt = latestEventAt === null ? 0 : Date.parse(latestEventAt);
  if (!Number.isFinite(eventAt)) return null;
  return Math.max(
    DateTime.toEpochMillis(thread.deletedAt),
    DateTime.toEpochMillis(thread.updatedAt),
    eventAt,
  );
}

type BuildReviewRequest = {
  readonly input: BuildReviewTargetsInput | BuildReviewPreviewInput | BuildReviewSelectInput;
  readonly candidates: Array<{ target: BuildReviewTarget; entry: CleanupWorkingEntry }>;
  result?: BuildReviewPreview | BuildReviewSelectionResult;
};

export class StorageCleanup extends Context.Service<
  StorageCleanup,
  {
    readonly buildReviewTargets: (
      input: BuildReviewTargetsInput,
    ) => Effect.Effect<readonly BuildReviewTarget[], BuildReviewError>;
    readonly previewBuildReview: (
      input: BuildReviewPreviewInput,
    ) => Effect.Effect<BuildReviewPreview, BuildReviewError>;
    readonly selectBuildReview: (
      input: BuildReviewSelectInput,
    ) => Effect.Effect<BuildReviewSelectionResult, BuildReviewError>;
    readonly runNow: Effect.Effect<StorageCleanupReport, ServerSettingsError>;
    readonly latestReport: Effect.Effect<StorageCleanupReport | null>;
    readonly reports: Stream.Stream<StorageCleanupReport | null>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/storageCleanup") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const settingsService = yield* Settings.ServerSettingsService;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const worktreeCleanup = yield* WorktreeCleanup.WorktreeCleanupService;
  const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const sql = yield* SqlClient.SqlClient;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const gitManager = yield* GitManager.GitManager;
  const terminals = yield* TerminalManager.TerminalManager;
  const previewHosting = yield* PreviewHosting.PreviewHosting;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const auditPath = path.join(config.logsDir, "storage-cleanup.audit.ndjson");
  const auditFileLimit = 512 * 1024;
  const auditSemaphore = yield* Semaphore.make(1);
  const audit = (record: Record<string, unknown>) =>
    auditSemaphore.withPermits(1)(
      Effect.gen(function* () {
        yield* fs.makeDirectory(config.logsDir, { recursive: true });
        const current = yield* fs.stat(auditPath).pipe(Effect.option);
        if (Option.isSome(current) && Number(current.value.size) >= auditFileLimit) {
          const previous = `${auditPath}.1`;
          yield* fs.remove(previous, { force: true });
          yield* fs.rename(auditPath, previous);
        }
        const line = yield* encodeAuditRecord(record);
        yield* fs.writeFileString(auditPath, `${line}\n`, { flag: "a" });
        return true;
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("storage cleanup audit write failed", {
            error: cleanupFailureReason(error),
          }).pipe(Effect.as(false)),
        ),
      ),
    );
  const dependencies = yield* GeneratedDependencies.GeneratedDependencies.pipe(
    Effect.provide(GeneratedDependencies.layer),
  );
  const builds = yield* GeneratedBuilds.GeneratedBuilds.pipe(Effect.provide(GeneratedBuilds.layer));
  const processPaths = yield* WorktreeConsumers.ProcessPaths;
  const buildInput = (input: GeneratedBuilds.BuildInput): GeneratedBuilds.BuildInput => ({
    ...input,
    processPaths,
  });
  const liveTerminals = new Map<string, Map<string, TerminalSummary>>();
  const orphanSizes = new Map<string, number | null>();
  const noteTerminal = (terminal: TerminalSummary) => {
    const threadTerminals =
      liveTerminals.get(terminal.threadId) ?? new Map<string, TerminalSummary>();
    threadTerminals.set(terminal.terminalId, terminal);
    liveTerminals.set(terminal.threadId, threadTerminals);
  };

  const isWindows = yield* HostProcess.isWindows;
  const pathKey = (target: string) => {
    const resolved = path.resolve(target);
    return isWindows ? resolved.toLowerCase() : resolved;
  };
  const inside = (root: string, target: string) => {
    const relative = path.relative(pathKey(root), pathKey(target));
    return (
      relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
  };
  const hasTerminal = (worktreePath: string) =>
    [...liveTerminals.values()]
      .flatMap((entries) => [...entries.values()])
      .some((terminal) => {
        if (terminal.status !== "starting" && terminal.status !== "running") return false;
        const cwd = path.resolve(terminal.cwd);
        return (
          (terminal.worktreePath !== null &&
            path.resolve(terminal.worktreePath) === worktreePath) ||
          cwd === worktreePath ||
          inside(worktreePath, cwd)
        );
      });

  const measureWorktree = Effect.fn("storageCleanup.measureWorktree")(
    function* (worktreePath: string) {
      const root = yield* fs.realPath(worktreePath);
      const pending = [root];
      let entries = 1;
      let bytes = 0;
      while (pending.length > 0) {
        const target = pending.pop()!;
        // Effect's stat follows links. Probe with readLink first to get lstat
        // semantics, including skipping dangling links and directory links.
        const isLink = yield* fs.readLink(target).pipe(
          Effect.as(true),
          Effect.catchIf(
            (error) =>
              error.cause instanceof Error &&
              "code" in error.cause &&
              error.cause.code === "EINVAL",
            () => Effect.succeed(false),
          ),
        );
        if (isLink) continue;
        if ((yield* fs.realPath(target)) !== target) return null;
        const stat = yield* fs.stat(target);
        if (stat.type === "File") {
          // Removing a shared hardlink leaves its blocks allocated.
          if (Option.getOrElse(stat.nlink, () => 1n) !== 1n) continue;
          bytes += Option.match(stat.blocks, {
            onNone: () => Number(stat.size),
            onSome: (blocks) => Number(blocks * 512n),
          });
        } else if (stat.type === "Directory") {
          const names = yield* fs.readDirectory(target);
          entries += names.length;
          if (entries > 2_000_000) return null;
          for (const name of names) {
            const child = path.join(target, name);
            if (!inside(root, child)) return null;
            pending.push(child);
          }
        }
      }
      return bytes;
    },
    Effect.timeout("30 seconds"),
    Effect.orElseSucceed(() => null),
  );

  const previewsProtectingWorktrees = Effect.fn("StorageCleanup.previewsProtectingWorktrees")(
    function* () {
      // If lease state cannot be trusted, preserve worktrees rather than risk
      // deleting the source of a preview that may still be running.
      return yield* previewHosting.protectedWorkspacePaths().pipe(Effect.orElseSucceed(() => null));
    },
  );
  const previewUsesWorktree = (
    worktreePath: string,
    protectedPaths: ReadonlyArray<string> | null,
  ) =>
    protectedPaths === null ||
    protectedPaths.some((candidate) => {
      const resolved = path.resolve(candidate);
      return resolved === worktreePath || inside(worktreePath, resolved);
    });

  // Include archived owners for disposal policy; keep the full snapshot on the
  // reader worker and use narrow projection reads for per-worktree rechecks.
  const readThreads = Effect.fn("StorageCleanup.readThreads")(function* () {
    const snapshot = yield* projections.getShellSnapshot().pipe(NodeSqliteClient.readOnly);
    const projects = yield* projectStore.listShells();
    return { projects, threads: [...snapshot.threads, ...snapshot.archivedThreads] };
  });

  const canonicalWorkspacePath = Effect.fnUntraced(function* (cwd: string) {
    const resolved = path.resolve(cwd);
    return yield* fs.realPath(resolved).pipe(Effect.orElseSucceed(() => resolved));
  });

  const makeProviderSessionGuard = Effect.fn("StorageCleanup.makeProviderSessionGuard")(
    function* () {
      const providerEventsSince = Effect.fnUntraced(function* (sequence: number) {
        const changed = yield* sql`
          SELECT 1 FROM orchestration_events
          WHERE sequence > ${sequence} AND event_type LIKE 'provider-session.%'
          LIMIT 1
        `;
        return changed.length > 0;
      });
      const capture = Effect.fn("StorageCleanup.captureProviderProtection")(function* () {
        const runtimeRevision = yield* providerSessions.ownershipRevision;
        const runtimeWorkspaces = yield* providerSessions.workspaceOwnership;
        const sequence = yield* readApplicationSequence();
        const rows = yield* sql<{ payload_json: string }>`
          SELECT payload_json FROM orchestration_v2_projection_provider_sessions
        `;
        const sessions = yield* Effect.forEach(rows, (row) =>
          decodeCleanupSession(row.payload_json),
        );
        // Persisted ready/running rows can outlive the process. Conversely, a
        // stopped/error row can still own a runtime while its scope is closing.
        const protectedSessions = (yield* Effect.forEach(sessions, (session) =>
          providerSessions.isLive(session.id).pipe(Effect.map((live) => (live ? session : null))),
        )).filter((session) => session !== null);
        const sessionIds = new Set(protectedSessions.map((session) => session.id));
        const bindings =
          sessionIds.size === 0
            ? []
            : yield* sql<{ provider_session_id: ProviderSessionId; thread_id: ThreadId }>`
              SELECT provider_session_id, thread_id FROM orchestration_v2_projection_provider_session_bindings
              WHERE provider_session_id IN ${sql.in([...sessionIds])}
            `;
        // Shared sessions retain their first cwd, so index every live attachment too.
        const protectedThreads = new Set([
          ...runtimeWorkspaces.flatMap((workspace) => workspace.threadIds),
          ...bindings
            .filter((binding) => sessionIds.has(binding.provider_session_id))
            .map((binding) => binding.thread_id),
        ]);
        const protectedAncestors = new Set<string>();
        // Runtime ownership also covers failed attachment persistence and
        // replacement closes whose durable row still names an older cwd.
        for (const workspace of [...runtimeWorkspaces, ...protectedSessions]) {
          for (const cwd of new Set([
            path.resolve(workspace.cwd),
            yield* canonicalWorkspacePath(workspace.cwd),
          ])) {
            let ancestor = cwd;
            while (true) {
              protectedAncestors.add(ancestor);
              const parent = path.dirname(ancestor);
              if (parent === ancestor) break;
              ancestor = parent;
            }
          }
        }
        // Never use mixed runtime, cwd and binding observations. One unstable
        // read keeps this candidate; the next check can capture fresh state.
        if (
          (yield* providerEventsSince(sequence)) ||
          (yield* providerSessions.ownershipRevision) !== runtimeRevision
        )
          return null;
        return { runtimeRevision, sequence, protectedThreads, protectedAncestors };
      });
      let snapshot = yield* capture();
      return Effect.fn("StorageCleanup.hasLiveProviderSession")(function* (
        worktreePath: string,
        threadId?: ThreadId,
      ) {
        // Dependency cohorts call this guard concurrently; each check keeps
        // its own snapshot while a sibling may refresh the shared cache.
        let current = snapshot;
        if (current === null) {
          snapshot = yield* capture();
          return true;
        }
        if (
          (yield* providerEventsSince(current.sequence)) ||
          (yield* providerSessions.ownershipRevision) !== current.runtimeRevision
        ) {
          current = yield* capture();
          snapshot = current;
        }
        // Startup holds the candidate's workspace lease through durable
        // attachment. Unrelated session activity refreshes this index rather
        // than protecting every worktree for the remainder of the sweep.
        return (
          current === null ||
          (threadId !== undefined && current.protectedThreads.has(threadId)) ||
          current.protectedAncestors.has(path.resolve(worktreePath))
        );
      });
    },
  );

  // Local threads under another project need not have a worktreePath of their own.
  const containsProjectRoot = Effect.fn("StorageCleanup.containsProjectRoot")(function* (
    worktreePath: string,
    projects: ReadonlyArray<{ readonly workspaceRoot: string }>,
  ) {
    for (const project of projects) {
      const projectPath = path.resolve(project.workspaceRoot);
      if (pathKey(projectPath) === pathKey(worktreePath) || inside(worktreePath, projectPath))
        return true;
      const realPath = yield* fs
        .realPath(projectPath)
        .pipe(Effect.orElseSucceed(() => projectPath));
      if (pathKey(realPath) === pathKey(worktreePath) || inside(worktreePath, realPath))
        return true;
    }
    return false;
  });

  const reportOrphanWorktrees = Effect.fn("StorageCleanup.reportOrphanWorktrees")(function* (
    roots: ReadonlyArray<string>,
    projects: ReadonlyArray<{ readonly workspaceRoot: string }>,
    entries: StorageCleanupReportEntry[],
  ) {
    // Include deleted and archived threads, even those without a branch or project.
    const rows = yield* sql<{ worktreePath: string }>`
      SELECT DISTINCT json_extract(payload_json, '$.worktreePath') AS "worktreePath"
      FROM orchestration_v2_projection_threads
      WHERE json_extract(payload_json, '$.worktreePath') IS NOT NULL
    `.pipe(NodeSqliteClient.readOnly);
    const referenced = new Set<string>();
    for (const row of rows) {
      const resolved = path.resolve(row.worktreePath);
      referenced.add(pathKey(resolved));
      referenced.add(
        pathKey(yield* fs.realPath(resolved).pipe(Effect.orElseSucceed(() => resolved))),
      );
    }
    const referencedAncestors = new Set<string>();
    for (let ancestor of referenced) {
      while (roots.some((root) => inside(root, ancestor))) {
        ancestor = pathKey(path.dirname(ancestor));
        referencedAncestors.add(ancestor);
      }
    }
    const projectRoots = (yield* Effect.forEach(
      yield* Effect.filter(projects, (project) =>
        fs.exists(path.resolve(project.workspaceRoot)).pipe(Effect.orElseSucceed(() => true)),
      ),
      (project) => {
        const resolved = path.resolve(project.workspaceRoot);
        return fs.realPath(resolved).pipe(
          Effect.orElseSucceed(() => resolved),
          Effect.map((realPath) => [resolved, realPath]),
        );
      },
    )).flat();
    const inProject = (target: string, managedRoot: string) =>
      projectRoots.some(
        (root) =>
          !inside(root, managedRoot) && (pathKey(root) === pathKey(target) || inside(root, target)),
      );
    const directories = Effect.fnUntraced(function* (parent: string, managedRoot: string) {
      if (inProject(parent, managedRoot)) return [];
      const result: string[] = [];
      for (const name of yield* fs.readDirectory(parent).pipe(Effect.orElseSucceed(() => []))) {
        const target = path.join(parent, name);
        if (!inside(parent, target) || inProject(target, managedRoot)) continue;
        const directory = yield* Effect.gen(function* () {
          if (pathKey(yield* fs.realPath(target)) !== pathKey(target)) return false;
          return (yield* fs.stat(target)).type === "Directory";
        }).pipe(Effect.orElseSucceed(() => false));
        if (directory) result.push(target);
      }
      return result;
    });
    // Let the first walk reach its own limit so unmeasurable folders get cached.
    // Later walks share the remaining sweep budget.
    // Unmeasured folders still appear with an unknown size.
    const now = yield* Clock.currentTimeMillis;
    const measurementDeadline = now + 30_000;
    let firstMeasurement = true;
    const reported = new Set<string>();
    const report = Effect.fnUntraced(
      function* (worktreePath: string) {
        const key = pathKey(worktreePath);
        if (
          reported.has(key) ||
          referenced.has(key) ||
          referencedAncestors.has(key) ||
          projectRoots.some((root) => pathKey(root) === key || inside(worktreePath, root))
        )
          return;
        const modified = Option.getOrNull((yield* fs.stat(worktreePath)).mtime);
        if (modified !== null && modified.getTime() > now - ORPHAN_WORKTREE_GRACE_MS) return;
        const gitPath = path.join(worktreePath, ".git");
        const linked = (yield* fs.exists(gitPath)) && (yield* fs.stat(gitPath)).type === "File";
        reported.add(key);
        const remaining = measurementDeadline - (yield* Clock.currentTimeMillis);
        if (!orphanSizes.has(key) && (firstMeasurement || remaining > 0)) {
          const measured = yield* measureWorktree(worktreePath).pipe(
            firstMeasurement ? Effect.map(Option.some) : Effect.timeoutOption(remaining),
          );
          firstMeasurement = false;
          if (Option.isSome(measured)) orphanSizes.set(key, measured.value);
        }
        const bytes = orphanSizes.get(key) ?? null;
        entries.push({
          kind: "worktree",
          outcome: "kept",
          reason: linked
            ? "No thread uses this worktree"
            : "No thread uses this folder, and it isn't a git worktree",
          path: worktreePath,
          projectPath: null,
          threadId: null,
          threadTitle: null,
          bytes,
          files: null,
        });
      },
      Effect.orElseSucceed(() => undefined),
    );
    for (const root of roots) {
      // Worktrees can be <root>/<repository>/<branch> or explicitly <root>/<name>.
      for (const projectDirectory of yield* directories(root, root)) {
        yield* Effect.gen(function* () {
          if (referenced.has(pathKey(projectDirectory))) return;
          const gitPath = path.join(projectDirectory, ".git");
          if (yield* fs.exists(gitPath)) {
            if ((yield* fs.stat(gitPath)).type === "File") yield* report(projectDirectory);
            return;
          }
          for (const worktreePath of yield* directories(projectDirectory, root)) {
            yield* report(worktreePath);
          }
        }).pipe(Effect.orElseSucceed(() => undefined));
      }
    }
    for (const key of orphanSizes.keys()) {
      if (!reported.has(key)) orphanSizes.delete(key);
    }
  });

  // Whether cwd stopped being a checkout of this branch. Two small Git reads,
  // since every worktree in a sweep is asked; statusDetailsLocal also diffs and
  // counts.
  const branchChanged = Effect.fn("StorageCleanup.branchChanged")(function* (
    cwd: string,
    branch: string | null,
  ) {
    const failure = (detail: string) =>
      new GitCommandError({
        operation: "StorageCleanup.branchChanged",
        command: "git",
        cwd,
        detail,
      });
    // Null when cwd is not a repository, or is gone. Git's own messages are
    // matched, so they must not be translated.
    const read = Effect.fnUntraced(function* (args: string[], allowedExitCode?: number) {
      const result = yield* git
        .execute({
          operation: "StorageCleanup.branchChanged",
          cwd,
          args,
          env: { LC_ALL: "C" },
          allowNonZeroExit: true,
        })
        .pipe(
          Effect.catch((error) =>
            Effect.flatMap(fs.exists(cwd), (exists) =>
              exists ? Effect.fail(error) : Effect.succeed(null),
            ),
          ),
        );
      if (result === null) return null;
      if (result.exitCode === 0 || result.exitCode === allowedExitCode) return result;
      if (result.stderr.toLowerCase().includes("not a git repository")) return null;
      return yield* failure(
        result.stderr.trim().split(/\r?\n/)[0]?.slice(0, 1000) || "command failed",
      );
    });
    const index = yield* read(["rev-parse", "--git-path", "index"]);
    if (index === null) return true;
    if (yield* fs.exists(`${path.resolve(cwd, index.stdout.trim())}.lock`))
      return yield* failure(
        "Git index is locked. Status will resume when the index lock is removed.",
      );
    // Exits 1 for a detached HEAD. Reads the full ref name, which is never
    // shortened to "heads/<branch>" when a tag shares the branch name.
    const head = yield* read(["symbolic-ref", "--quiet", "HEAD"], 1);
    if (head === null) return true;
    const ref = head.exitCode === 0 ? head.stdout.trim() : "";
    const name = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length).trim() : null;
    return (name?.startsWith("(") ? null : name) !== branch;
  });

  const localChangesReason = Effect.fn("StorageCleanup.localChangesReason")(function* (
    cwd: string,
  ) {
    if (generatedBuildReviewProtection(cwd)) return "reviewed build content protects this worktree";
    const status = yield* git.execute({
      operation: "StorageCleanup.localChanges",
      cwd,
      args: ["status", "--porcelain=v1", "-z", "--ignore-submodules=none", "--untracked-files=all"],
      maxOutputBytes: 64 * 1024,
    });
    if (status.stdoutTruncated) return "local changes exceed the inspection limit";
    const records = status.stdout.split("\0").filter(Boolean);
    let count = 0;
    for (let i = 0; i < records.length; i++) {
      count++;
      if (/^[RC]|^.[RC]/.test(records[i]!)) i++;
    }
    if (count > 0) return `has uncommitted changes (${count} ${count === 1 ? "file" : "files"})`;
    // A checkout is disposable only after its known generated files have been
    // reclaimed separately. Ignore rules and a permissive local-change setting
    // cannot authorize erasing notes, runtime state or retained review receipts.
    const ignored = yield* git.execute({
      operation: "StorageCleanup.ignoredFiles",
      cwd,
      args: [
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--directory",
        "--no-empty-directory",
        "-z",
      ],
      maxOutputBytes: 64 * 1024,
    });
    if (ignored.stdoutTruncated) return "ignored files exceed the inspection limit";
    for (const file of ignored.stdout.split("\0")) {
      if (file === "") continue;
      // Finder metadata is disposable, but a directory or link with this name
      // is not evidence that its contents belong to Finder. Tracked edits have
      // already been rejected by status above.
      if (path.basename(file) === ".DS_Store") {
        const target = path.join(cwd, file);
        const regularFile = yield* fs.readLink(target).pipe(
          Effect.as(false),
          Effect.catchIf(
            (error) =>
              error.cause instanceof Error &&
              "code" in error.cause &&
              error.cause.code === "EINVAL",
            () => fs.stat(target).pipe(Effect.map((stat) => stat.type === "File")),
          ),
          Effect.orElseSucceed(() => false),
        );
        if (regularFile) continue;
      }
      return `has ignored files (${file})`;
    }
    return null;
  });

  const submoduleRemoval = Effect.fn("StorageCleanup.submoduleRemoval")(
    function* (cwd: string) {
      const inspect = (args: string[], maxOutputBytes = 64 * 1024) =>
        git.execute({
          operation: "StorageCleanup.submodules",
          cwd,
          args,
          maxOutputBytes,
        });
      const admin = yield* inspect(["rev-parse", "--absolute-git-dir"]);
      if (admin.stdoutTruncated || admin.stderrTruncated)
        return { force: false, reason: "submodule inspection exceeded the limit" };
      const modules = path.join(admin.stdout.replace(/\n$/, ""), "modules");
      const stored = yield* fs.exists(modules);
      if (!stored && !(yield* fs.exists(path.join(cwd, ".gitmodules"))))
        return { force: false, reason: null };
      const populated = yield* inspect([
        "submodule",
        "foreach",
        "--recursive",
        "--quiet",
        'printf "%s\\0" "$toplevel/$sm_path"',
      ]);
      if (populated.stdoutTruncated || populated.stderrTruncated)
        return { force: false, reason: "submodule inspection exceeded the limit" };
      const paths = populated.stdout.split("\0").filter(Boolean);
      const pending = [modules];
      for (const submodule of paths) {
        const directory = yield* inspect(["-C", submodule, "rev-parse", "--absolute-git-dir"]);
        if (directory.stdoutTruncated || directory.stderrTruncated)
          return { force: false, reason: "submodule inspection exceeded the limit" };
        pending.push(directory.stdout.replace(/\n$/, ""));
      }
      const visited = new Set<string>();
      while (pending.length > 0) {
        const directory = pending.pop()!;
        if (!(yield* fs.exists(directory))) continue;
        const canonical = yield* fs.realPath(directory);
        if (visited.has(canonical)) continue;
        visited.add(canonical);
        if (visited.size > 10_000)
          return { force: false, reason: "submodule inspection exceeded the limit" };
        if ((yield* fs.stat(directory)).type !== "Directory")
          return { force: false, reason: "submodule repository could not be inspected" };
        if (yield* fs.exists(path.join(directory, "HEAD"))) {
          const unpushed = yield* inspect([
            "--git-dir",
            directory,
            "--work-tree",
            cwd,
            "rev-list",
            "--max-count=1",
            "HEAD",
            "--all",
            "--reflog",
            "--not",
            "--remotes",
          ]);
          if (unpushed.stdoutTruncated || unpushed.stderrTruncated)
            return { force: false, reason: "submodule inspection exceeded the limit" };
          if (unpushed.stdout.trim() !== "")
            return { force: false, reason: "submodule has commits not on a remote-tracking ref" };
          pending.push(path.join(directory, "modules"));
        } else {
          for (const name of yield* fs.readDirectory(directory))
            pending.push(path.join(directory, name));
        }
      }
      // Check files after walking stored history to shorten the gap before forced removal.
      for (const submodule of paths) {
        const changes = yield* localChangesReason(submodule);
        if (changes !== null) return { force: false, reason: `submodule ${changes}` };
      }
      const force = stored || paths.length > 0;
      if (force) {
        const root = yield* fs.realPath(cwd);
        // Git status and foreach omit files inside deinitialized gitlink directories.
        const populatedPaths = new Set(paths.map(pathKey));
        const unchecked: string[] = [];
        for (const repository of [root, ...paths]) {
          const index = yield* inspect(
            ["-C", repository, "ls-files", "--stage", "-z"],
            16 * 1024 * 1024,
          );
          if (index.stdoutTruncated || index.stderrTruncated)
            return { force: false, reason: "submodule inspection exceeded the limit" };
          for (const entry of index.stdout.split("\0")) {
            if (!entry.startsWith("160000 ")) continue;
            const submodule = path.resolve(repository, entry.slice(entry.indexOf("\t") + 1));
            if (!inside(root, submodule))
              return { force: false, reason: "submodules could not be inspected" };
            if (!populatedPaths.has(pathKey(submodule)) && (yield* fs.exists(submodule)))
              unchecked.push(submodule);
          }
        }
        let inspected = unchecked.length;
        while (unchecked.length > 0) {
          if (inspected > 10_000)
            return { force: false, reason: "submodule inspection exceeded the limit" };
          const target = unchecked.pop()!;
          if (
            (yield* fs.realPath(target)) !== path.resolve(target) ||
            (yield* fs.stat(target)).type !== "Directory"
          )
            return { force: false, reason: "submodule has local files" };
          const names = yield* fs.readDirectory(target);
          inspected += names.length;
          for (const name of names) unchecked.push(path.join(target, name));
        }
      }
      return { force, reason: null };
    },
    Effect.orElseSucceed(() => ({ force: false, reason: "submodules could not be inspected" })),
  );

  const cleanupGit = Effect.fn("StorageCleanup.cleanupGit")(function* (
    cwd: string,
    args: string[],
    command: string,
  ) {
    const result = yield* git.execute({
      operation: "StorageCleanup.cleanupGit",
      cwd,
      args,
      allowNonZeroExit: true,
      timeoutMs: 300_000,
    });
    if (result.exitCode !== 0)
      return yield* Effect.fail(
        new GitCommandError({
          operation: "StorageCleanup.cleanupGit",
          command,
          cwd,
          detail: result.stderr.trim().split(/\r?\n/)[0]?.slice(0, 1000) || "command failed",
        }),
      );
  });

  const dependencyCleanupEnabled = (rules: WorktreeCleanupRules) =>
    rules.worktreeDependenciesAfterDays !== null;

  const managedRoots = Effect.fn("StorageCleanup.managedRoots")(function* (
    settings: ServerSettings,
  ) {
    const roots: Array<string> = [];
    for (const directory of managedWorktreesDirectories(
      settings,
      config.worktreesDir,
      path,
      yield* HostProcess.HomeDirectory,
    )) {
      const root = yield* fs.exists(directory).pipe(
        Effect.flatMap((exists) => (exists ? fs.realPath(directory) : Effect.succeed(null))),
        Effect.orElseSucceed(() => null),
      );
      if (root !== null && !isFilesystemRoot(root, path)) roots.push(root);
    }
    return roots;
  });

  const readApplicationSequence = Effect.fn("StorageCleanup.readApplicationSequence")(function* () {
    const rows = yield* sql<{ sequence: number }>`
        SELECT COALESCE(MAX(sequence), 0) AS sequence FROM orchestration_events
      `;
    return rows[0]!.sequence;
  });

  const ownershipChangedSince = Effect.fn("StorageCleanup.ownershipChangedSince")(function* (
    sequence: number,
    scope?: OwnershipScope,
  ) {
    if (scope !== undefined) {
      // Core events also carry visits, attention and PR updates. Compare their
      // ownership fields rather than treating ordinary conversation activity as
      // a workspace change. Keep all observed transitions, including a new owner
      // that moves away again before the final check.
      const rows = yield* sql<{
        kind: string;
        id: string;
        worktreePath: string | null;
        projectId: string | null;
        branch: string | null;
        pathType: string | null;
        branchType: string | null;
      }>`
        SELECT DISTINCT aggregate_kind AS kind, stream_id AS id,
          CASE WHEN aggregate_kind = 'thread' THEN json_extract(payload_json, '$.worktreePath') END AS "worktreePath",
          CASE WHEN aggregate_kind = 'thread' THEN json_extract(payload_json, '$.projectId') END AS "projectId",
          CASE WHEN aggregate_kind = 'thread' THEN json_extract(payload_json, '$.branch') END AS branch,
          CASE WHEN aggregate_kind = 'thread' THEN json_type(payload_json, '$.worktreePath') END AS "pathType",
          CASE WHEN aggregate_kind = 'thread' THEN json_type(payload_json, '$.branch') END AS "branchType"
        FROM orchestration_events
        WHERE sequence > ${sequence}
          AND (aggregate_kind = 'project' OR event_type LIKE 'thread.%')
          AND event_type != 'thread.pull-request-link-updated'
        LIMIT 1001
      `;
      if (rows.length > 1000) return true;
      if (rows.some((row) => row.kind === "project")) {
        const current = yield* projectStore.listShells();
        // Structural project changes can introduce a competing repository
        // mapping even when the new root is elsewhere. Cosmetic edits cannot.
        if (
          current.length !== scope.projects.length ||
          current.some((project) => {
            const initial = scope.projects.find((entry) => entry.id === project.id);
            return (
              initial === undefined ||
              path.resolve(initial.workspaceRoot) !== path.resolve(project.workspaceRoot)
            );
          })
        )
          return true;
      }
      const initial = new Map(scope.threads.map((thread) => [String(thread.id), thread]));
      for (const row of rows) {
        if (row.kind !== "thread") continue;
        if (
          (row.pathType !== "text" && row.pathType !== "null") ||
          (row.branchType !== "text" && row.branchType !== "null") ||
          typeof row.projectId !== "string"
        )
          return true;
        const before = initial.get(row.id);
        if (
          before !== undefined &&
          before.worktreePath === row.worktreePath &&
          before.projectId === row.projectId &&
          before.branch === row.branch
        )
          continue;
        // Ownerless cleanup also requires that no thread history claims this
        // project/branch, even if that thread records a different checkout.
        if (
          scope.branch !== null &&
          row.projectId === scope.projectId &&
          row.branch === scope.branch
        )
          return true;
        for (const recordedPath of [before?.worktreePath, row.worktreePath]) {
          if (recordedPath == null) continue;
          const resolved = path.resolve(recordedPath);
          const canonical = yield* fs.realPath(resolved).pipe(
            Effect.catchIf(
              (error) =>
                error.cause instanceof Error &&
                "code" in error.cause &&
                error.cause.code === "ENOENT",
              () => Effect.succeed(resolved),
            ),
            Effect.orElseSucceed(() => null),
          );
          if (
            canonical === null ||
            canonical === scope.cwd ||
            inside(scope.cwd, canonical) ||
            inside(canonical, scope.cwd)
          )
            return true;
        }
      }
      return false;
    }
    // The informational orphan audit has no candidate-specific snapshot.
    const rows = yield* sql`
      SELECT 1 FROM orchestration_events
      WHERE sequence > ${sequence}
        AND (aggregate_kind = 'project' OR event_type LIKE 'thread.%')
      LIMIT 1
    `;
    return rows.length > 0;
  });

  const readDeletedDependencyCandidates = Effect.fn(
    "StorageCleanup.readDeletedDependencyCandidates",
  )(function* (threadId?: ThreadId) {
    const rows = yield* sql<{
      payload_json: string;
      workspaceRoot: string;
      latestEventAt: string | null;
    }>`
        SELECT t.payload_json, p.workspace_root AS "workspaceRoot",
          (SELECT MAX(e.occurred_at) FROM orchestration_events e
            WHERE e.aggregate_kind = 'thread' AND e.stream_id = t.thread_id
              AND e.application_event_version = 2) AS "latestEventAt"
        FROM orchestration_v2_projection_threads t
        JOIN projection_projects p ON p.project_id = t.project_id
        WHERE t.deleted_at IS NOT NULL
          ${threadId === undefined ? sql`` : sql`AND t.thread_id = ${threadId}`}
      `;
    return yield* Effect.forEach(rows, (row) =>
      decodeCleanupThread(row.payload_json).pipe(
        Effect.map((thread) => ({
          ...thread,
          workspaceRoot: row.workspaceRoot,
          dependencyActivityAt: storageCleanupDeletedActivityAt(thread, row.latestEventAt),
        })),
      ),
    );
  });

  const hasPendingWorkspaceWork = Effect.fn("StorageCleanup.hasPendingWorkspaceWork")(function* (
    threadId: ThreadId,
  ) {
    // Shells omit some delegated/background state, and deleted threads omit
    // the shell entirely. Check the durable records as well as live sessions.
    const rows = yield* sql`
        SELECT 1 FROM orchestration_v2_projection_runs
          WHERE thread_id = ${threadId} AND status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
        UNION ALL
        SELECT 1 FROM orchestration_v2_projection_subagents
          WHERE (thread_id = ${threadId} OR child_thread_id = ${threadId})
            AND status IN ('pending', 'running', 'waiting')
        UNION ALL
        SELECT 1 FROM orchestration_v2_projection_runtime_requests
          WHERE thread_id = ${threadId} AND status = 'pending'
        UNION ALL
        SELECT 1 FROM orchestration_v2_projection_provider_threads
          WHERE thread_id = ${threadId} AND (
            status = 'active' OR NOT json_valid(payload_json) OR
            CASE WHEN json_valid(payload_json)
              THEN json_array_length(payload_json, '$.pendingBackgroundTasks') > 0 ELSE 1 END
          )
        LIMIT 1
      `;
    return rows.length > 0;
  });

  const dependencyEstimates = new WeakMap<StorageCleanupReportEntry, number>();
  const cleanDisposableOutputs = Effect.fn("StorageCleanup.cleanDisposableOutputs")(function* (
    serverSettings: ServerSettings,
    now: number,
    entries: CleanupWorkingEntry[],
    resource: "dependencies" | "generated-builds",
    observationProcessPaths: Effect.Effect<ReadonlyArray<string> | null>,
    observationTargets: WorktreeConsumers.TargetObservation,
    review?: BuildReviewRequest,
  ) {
    const generatedBuilds = resource === "generated-builds";
    const outputPath = (cwd: string) => (generatedBuilds ? cwd : path.join(cwd, "node_modules"));
    const outputExists = (cwd: string) =>
      generatedBuilds ? builds.hasOutputs(cwd) : fs.exists(outputPath(cwd));
    let observationUnavailable = false;
    const processObservation = observationProcessPaths.pipe(
      Effect.tap((paths) =>
        Effect.sync(() => {
          observationUnavailable = paths === null;
        }),
      ),
    );
    const observe = Effect.fnUntraced(function* (
      input: { managedWorktreesRoot: string; repositoryRoot: string; worktreePath: string },
      time: number,
      used = false,
      persist = true,
    ) {
      if (generatedBuilds)
        return yield* builds.observe(
          buildInput(input),
          time,
          used,
          persist,
          processObservation,
          persist ? observationTargets : undefined,
        );
      return yield* dependencies.observe(
        input,
        time,
        used,
        persist,
        processObservation,
        persist ? observationTargets : undefined,
      );
    });
    const unrecognizedReason = () =>
      observationUnavailable
        ? "Process file-consumer observation is unavailable"
        : generatedBuilds
          ? "No verified compiler emissions; legacy build outputs need exact-file review"
          : "No dependency install could be safely recognized";
    const metadataOnly = !review && !anyWorktreePolicy(serverSettings, dependencyCleanupEnabled);
    if (metadataOnly && !generatedBuilds) {
      entries.push({
        kind: "worktree",
        worktreeResource: resource,
        outcome: "kept",
        reason: "Dependency cleanup policy is disabled",
        path: null,
        projectPath: null,
        threadId: null,
        threadTitle: null,
        bytes: null,
        files: null,
      });
      return;
    }
    const roots = yield* managedRoots(serverSettings);
    if (roots.length === 0) return;
    const locationsUnchanged = (settings: ServerSettings) =>
      settings.worktreesDirectory === serverSettings.worktreesDirectory &&
      Equal.equals(
        settings.previousWorktreesDirectories,
        serverSettings.previousWorktreesDirectories,
      );
    const processCwds = metadataOnly
      ? null
      : yield* dependencies.processWorkingDirectories.pipe(
          Effect.flatMap((cwds) =>
            cwds === null ? Effect.succeed(null) : Effect.forEach(cwds, canonicalWorkspacePath),
          ),
        );
    const hasLiveProviderSession = metadataOnly
      ? () => Effect.succeed(true)
      : yield* makeProviderSessionGuard();
    const sequence = yield* readApplicationSequence();
    const snapshot = yield* readThreads();
    const canonicalPaths = new Map<string, string>();
    const resolveOwnerPath = Effect.fnUntraced(function* (recordedPath: string) {
      const resolved = path.resolve(recordedPath);
      const cached = canonicalPaths.get(resolved);
      if (cached !== undefined) return cached;
      const canonical = yield* canonicalWorkspacePath(resolved);
      canonicalPaths.set(resolved, canonical);
      return canonical;
    });
    const pathIdentityUnchanged = Effect.fnUntraced(function* (
      recordedPath: string,
      canonicalPath: string,
    ) {
      // Parent aliases are supported; the worktree itself must remain a real
      // directory at the same canonical location throughout deletion.
      const leafIsLink = yield* fs.readLink(recordedPath).pipe(
        Effect.as(true),
        Effect.catchIf(
          (error) =>
            error.cause instanceof Error && "code" in error.cause && error.cause.code === "EINVAL",
          () => Effect.succeed(false),
        ),
        Effect.orElseSucceed(() => true),
      );
      return (
        !leafIsLink &&
        (yield* fs.realPath(recordedPath).pipe(Effect.orElseSucceed(() => null))) === canonicalPath
      );
    });
    const terminalUsesDependencies = Effect.fnUntraced(function* (
      canonicalPath: string,
      recordedPath: string,
    ) {
      if (hasTerminal(canonicalPath) || hasTerminal(recordedPath)) return true;
      for (const terminals of liveTerminals.values()) {
        for (const terminal of terminals.values()) {
          if (terminal.status !== "starting" && terminal.status !== "running") continue;
          const cwd = yield* canonicalWorkspacePath(terminal.cwd);
          if (cwd === canonicalPath || inside(canonicalPath, cwd)) return true;
          if (
            terminal.worktreePath !== null &&
            (yield* canonicalWorkspacePath(terminal.worktreePath)) === canonicalPath
          )
            return true;
        }
      }
      return false;
    });
    const previewUsesDependencies = Effect.fnUntraced(function* (
      canonicalPath: string,
      recordedPath: string,
    ) {
      const protectedPaths = yield* previewsProtectingWorktrees();
      if (
        previewUsesWorktree(canonicalPath, protectedPaths) ||
        previewUsesWorktree(recordedPath, protectedPaths)
      )
        return true;
      for (const candidate of protectedPaths ?? []) {
        const cwd = yield* canonicalWorkspacePath(candidate);
        if (cwd === canonicalPath || inside(canonicalPath, cwd)) return true;
      }
      return false;
    });
    const liveOwners = yield* Effect.forEach(
      snapshot.threads.filter(
        (thread) => thread.worktreePath !== null && thread.deletedAt === null,
      ),
      (thread) =>
        Effect.gen(function* () {
          const recordedWorktreePath = path.resolve(thread.worktreePath!);
          return {
            ...thread,
            recordedWorktreePath,
            cleanupPath: yield* resolveOwnerPath(recordedWorktreePath),
          };
        }),
    );
    const deletedOwners = yield* Effect.forEach(
      (yield* readDeletedDependencyCandidates()).filter((thread) => thread.worktreePath !== null),
      (thread) =>
        Effect.gen(function* () {
          const recordedWorktreePath = path.resolve(thread.worktreePath!);
          return {
            ...thread,
            recordedWorktreePath,
            cleanupPath: yield* resolveOwnerPath(recordedWorktreePath),
          };
        }),
    );
    const groups = Map.groupBy(
      // Deleted shells can remain visible during cleanup; use their durable
      // deletion activity and outbox guards through the deleted-candidate path.
      liveOwners,
      (thread) => thread.cleanupPath,
    );
    const deletedGroups = Map.groupBy(deletedOwners, (thread) => thread.cleanupPath);
    const dependencyActivityByPath = new Map<
      string,
      { lastUsedAt: number; renewed: boolean; protectedReason: string | null } | null
    >();
    for (const [cwd, owners] of Map.groupBy(
      [...liveOwners, ...deletedOwners],
      (owner) => owner.cleanupPath,
    )) {
      const owner = owners[0]!;
      if (
        owners.length !== 1 ||
        owner.archivedAt !== null ||
        owner.worktreePath === null ||
        resolveWorktreeCleanup(serverSettings, owner.projectId).worktreeDependenciesAfterDays ===
          null ||
        !(yield* outputExists(cwd))
      )
        continue;
      const root = roots.find((root) => inside(root, cwd));
      const project =
        "workspaceRoot" in owner
          ? { workspaceRoot: owner.workspaceRoot }
          : snapshot.projects.find((project) => project.id === owner.projectId);
      if (root === undefined || project === undefined) continue;
      const protectedReason =
        processCwds === null
          ? "Could not check running processes safely"
          : processCwds.some((processCwd) => processCwd === cwd || inside(cwd, processCwd))
            ? "A running process is using this worktree"
            : (yield* terminalUsesDependencies(cwd, owner.recordedWorktreePath))
              ? "A terminal is still using this worktree"
              : (yield* previewUsesDependencies(cwd, owner.recordedWorktreePath))
                ? "A preview is using this worktree, or preview ownership could not be checked"
                : (yield* hasLiveProviderSession(cwd, owner.id))
                  ? "A provider session is still open"
                  : null;
      const activity = yield* observe(
        { managedWorktreesRoot: root, worktreePath: cwd, repositoryRoot: project.workspaceRoot },
        now,
        processCwds?.some(
          (processCwd) =>
            processCwd === path.join(cwd, "node_modules") ||
            inside(path.join(cwd, "node_modules"), processCwd),
        ) ?? false,
      ).pipe(Effect.orElseSucceed(() => null));
      dependencyActivityByPath.set(
        cwd,
        activity === null ? null : { ...activity, protectedReason },
      );
    }
    const reports = new Map<string, CleanupWorkingEntry>();
    const noteCandidate = (
      thread: Pick<OrchestrationV2ThreadShell, "id" | "title">,
      worktreePath: string,
      projectPath: string | null,
    ) => {
      const entry: CleanupWorkingEntry = {
        kind: "worktree",
        worktreeResource: resource,
        outcome: "kept",
        reason: "A final safety check prevented dependency removal",
        path: outputPath(worktreePath),
        projectPath,
        threadId: thread.id,
        threadTitle: thread.title,
        bytes: null,
        files: null,
      };
      entries.push(entry);
      reports.set(worktreePath, entry);
      return entry;
    };
    const readRegistered = Effect.fn("StorageCleanup.registeredDependencies")(function* (
      repositoryRoot: string,
    ) {
      const result = yield* git.execute({
        operation: "StorageCleanup.registeredDependencies",
        cwd: repositoryRoot,
        args: ["worktree", "list", "--porcelain", "-z"],
        maxOutputBytes: 1024 * 1024,
      });
      if (result.stdoutTruncated || result.stderrTruncated) return null;
      return result.stdout.split("\0\0").flatMap((block) => {
        const fields = block.split("\0");
        const location = fields.find((field) => field.startsWith("worktree "))?.slice(9);
        const branch = fields.find((field) => field.startsWith("branch refs/heads/"))?.slice(18);
        return location ? [{ recordedPath: path.resolve(location), branch: branch ?? null }] : [];
      });
    });
    const readProjectRepositories = Effect.fn("StorageCleanup.projectRepositories")(function* () {
      return yield* Effect.forEach(snapshot.projects, (project) =>
        Effect.gen(function* () {
          const result = yield* git.execute({
            operation: "StorageCleanup.projectRepository",
            cwd: project.workspaceRoot,
            args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
            allowNonZeroExit: true,
            env: { LC_ALL: "C" },
            maxOutputBytes: 64 * 1024,
          });
          if (
            result.exitCode !== 0 &&
            !result.stdoutTruncated &&
            !result.stderrTruncated &&
            result.stderr.toLowerCase().includes("not a git repository")
          )
            return { project, commonDirectory: null, uncertain: false };
          const value = result.stdout.trim();
          if (
            result.exitCode !== 0 ||
            result.stdoutTruncated ||
            result.stderrTruncated ||
            !path.isAbsolute(value) ||
            value.includes("\n")
          )
            return { project, commonDirectory: null, uncertain: true };
          return { project, commonDirectory: yield* fs.realPath(value), uncertain: false };
        }).pipe(Effect.orElseSucceed(() => ({ project, commonDirectory: null, uncertain: true }))),
      );
    });
    const projectRepositories = yield* readProjectRepositories();
    const registered = (yield* Effect.forEach(
      projectRepositories,
      ({ project, commonDirectory }) =>
        commonDirectory === null
          ? Effect.succeed([])
          : readRegistered(project.workspaceRoot).pipe(
              Effect.flatMap((worktrees) =>
                Effect.forEach(worktrees ?? [], (worktree) =>
                  Effect.gen(function* () {
                    return {
                      ...worktree,
                      project,
                      commonDirectory,
                      cwd: yield* resolveOwnerPath(worktree.recordedPath),
                    };
                  }),
                ),
              ),
              Effect.orElseSucceed(() => []),
            ),
    )).flat();
    const registeredGroups = Map.groupBy(registered, (entry) => entry.cwd);
    // Include durable deleted records even when their project no longer exists.
    const durableOwners = yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM orchestration_v2_projection_threads`;
    const historicalOwners = yield* Effect.forEach(durableOwners, (row) =>
      decodeCleanupThread(row.payload_json),
    );
    const legacyOwners = yield* worktreeCleanup.historicalWorktreeOwners;
    const ownershipThreads = [...historicalOwners, ...snapshot.threads, ...deletedOwners];
    const workspaceOwnershipChanged = (cwd: string, projectId: ProjectId, branch: string | null) =>
      ownershipChangedSince(sequence, {
        cwd,
        projectId,
        branch,
        threads: ownershipThreads,
        projects: snapshot.projects,
      });
    const reviewContext = (
      projectId: ProjectId,
      cwd: string,
      recordedPath: string,
      branch: string | null,
      owners: readonly unknown[],
    ) => {
      const commonDirectory = projectRepositories.find(
        (entry) => entry.project.id === projectId,
      )?.commonDirectory;
      return encodeReviewContext({
        projectId,
        cwd,
        recordedPath,
        branch,
        owners,
        repository: commonDirectory,
        repositoryProjectIds: projectRepositories
          .filter((entry) => entry.commonDirectory === commonDirectory)
          .map((entry) => entry.project.id)
          .sort(),
        repositoryMappingUncertain: projectRepositories.some((entry) => entry.uncertain),
        projectRoot: snapshot.projects.find((entry) => entry.id === projectId)?.workspaceRoot,
        roots,
        policy: resolveWorktreeCleanup(serverSettings, projectId).worktreeDependenciesAfterDays,
      });
    };
    const observeReviewContext = (
      input: GeneratedBuilds.BuildInput,
      recordedPath: string,
      contextKey: string,
    ) => {
      if (!generatedBuilds) return Effect.succeed(true);
      return [...new Set([input.worktreePath, recordedPath])].sort().reduceRight(
        (effect, cwd) => withWorkspaceLease(cwd, effect),
        builds.validateReviewContext(input, contextKey).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        ),
      );
    };
    const registerReview = Effect.fn("StorageCleanup.registerBuildReview")(function* (
      input: GeneratedBuilds.BuildInput,
      projectId: ProjectId,
      branch: string | null,
      archived: boolean,
      entry: CleanupWorkingEntry,
    ) {
      if (
        !review ||
        ("projectId" in review.input &&
          review.input.projectId !== undefined &&
          review.input.projectId !== projectId)
      )
        return;
      const project = snapshot.projects.find((candidate) => candidate.id === projectId);
      if (!project) return;
      const found = yield* builds.roots(input).pipe(Effect.orElseSucceed(() => []));
      const days = resolveWorktreeCleanup(serverSettings, projectId).worktreeDependenciesAfterDays;
      for (const root of found) {
        const compiler = yield* Effect.try({
          try: () => generatedBuildActivity(input.worktreePath, root),
          catch: () => true,
        }).pipe(Effect.orElseSucceed(() => true));
        if (compiler !== null) continue;
        const clock = yield* Effect.try({
          try: () => legacyBuildActivity(input.worktreePath, root),
          catch: () => null,
        }).pipe(Effect.orElseSucceed(() => null));
        const id = NodeCrypto.createHash("sha256")
          .update([projectId, input.worktreePath, root].join("\0"))
          .digest("hex");
        review.candidates.push({
          entry,
          target: {
            id,
            label: `${branch ?? path.basename(input.worktreePath)} · ${root}`,
            projectId,
            projectName: project.title || path.basename(project.workspaceRoot),
            worktreePath: input.worktreePath,
            root,
            branch,
            archived,
            delayDays: days,
            eligibleAt:
              days === null
                ? null
                : archived
                  ? 0
                  : clock === null
                    ? null
                    : clock.lastUsedAt + days * DAY_MS,
            protectedReason: entry.reason,
          },
        });
      }
    });
    const performReview = Effect.fn("StorageCleanup.performBuildReview")(function* (
      input: GeneratedBuilds.BuildInput,
      contextKey: string,
      canReview: Effect.Effect<boolean>,
    ) {
      if (!review) return;
      for (const candidate of review.candidates.filter(
        (item) => item.target.worktreePath === input.worktreePath,
      )) {
        const targeted = "targetId" in review.input;
        if (targeted && review.input.targetId !== candidate.target.id) continue;
        if (!targeted && !(yield* canReview)) return;
        if (
          !targeted &&
          !(yield* builds.canReview(buildInput(input), candidate.target.root, now, canReview))
        ) {
          candidate.entry.reason =
            "Build review is protected by current files, consumers, or workspace activity.";
          continue;
        }
        const activity = yield* Effect.try({
          try: () => legacyBuildActivity(input.worktreePath, candidate.target.root),
          catch: () => null,
        }).pipe(Effect.orElseSucceed(() => null));
        candidate.target = {
          ...candidate.target,
          protectedReason: null,
          eligibleAt:
            candidate.target.delayDays === null || activity === null
              ? null
              : candidate.target.archived
                ? 0
                : activity.lastUsedAt + candidate.target.delayDays * DAY_MS,
        };
        if (!("targetId" in review.input) || review.input.targetId !== candidate.target.id)
          continue;
        const root = candidate.target.root;
        if ("previewToken" in review.input) {
          const saved = yield* builds.select(
            buildInput(input),
            root,
            now,
            contextKey,
            review.input.previewToken,
            review.input.paths,
            canReview,
          );
          review.result = {
            selectedCount: new Set(review.input.paths).size,
            eligibleAt: candidate.target.archived
              ? 0
              : saved.lastUsedAt + candidate.target.delayDays! * DAY_MS,
            message:
              review.input.paths.length === 0
                ? "Selection cleared; this build remains protected."
                : "Selected unchanged files will be removed after the configured inactivity period.",
          };
        } else {
          const preview = yield* builds.preview(
            buildInput(input),
            root,
            now,
            contextKey,
            canReview,
          );
          const offset = review.input.offset ?? 0;
          review.result = {
            target: {
              ...candidate.target,
              eligibleAt: candidate.target.archived
                ? 0
                : preview.lastUsedAt + candidate.target.delayDays! * DAY_MS,
            },
            token: preview.token,
            files: preview.files
              .slice(offset, offset + BUILD_REVIEW_PAGE_SIZE)
              .map(({ path, size, bytes, selectable, reason }) => ({
                path,
                size,
                bytes,
                selectable,
                reason,
              })),
            offset,
            totalFiles: preview.files.length,
            totalBytes: preview.bytes,
            totalSize: preview.size,
            selectedPaths: preview.selectedPaths,
          };
        }
      }
    });
    const knownPaths = new Set([...groups.keys(), ...deletedGroups.keys()]);
    for (const owner of [
      ...historicalOwners.map((thread) => thread.worktreePath),
      ...legacyOwners.map((thread) => thread.worktreePath),
    ]) {
      if (owner !== null) knownPaths.add(yield* resolveOwnerPath(owner));
    }
    // The managed layout is root/repository/worktree. Unknown repositories never
    // receive an inactivity record or automatic deletion authority.
    for (const root of metadataOnly ? [] : roots) {
      const pending = [{ directory: root, depth: 0 }];
      let visited = 0;
      while (pending.length > 0 && visited < 1000) {
        const { directory, depth } = pending.pop()!;
        visited++;
        if (directory !== root && (yield* fs.exists(path.join(directory, ".git")))) {
          if (
            !knownPaths.has(directory) &&
            !registeredGroups.has(directory) &&
            (yield* outputExists(directory))
          )
            entries.push({
              kind: "worktree",
              worktreeResource: resource,
              outcome: "kept",
              reason: "Could not verify a current repository and project mapping",
              path: outputPath(directory),
              projectPath: null,
              threadId: null,
              threadTitle: null,
              bytes: null,
              files: null,
            });
          continue;
        }
        if (depth === 2) continue;
        const names = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => []));
        for (const name of names) {
          if (name.startsWith(".") || name === "node_modules") continue;
          const child = path.join(directory, name);
          const canonical = yield* fs.realPath(child).pipe(Effect.orElseSucceed(() => null));
          // Never follow candidate or intermediate links, including aliases into another root.
          if (canonical !== child) continue;
          const stat = yield* fs.stat(child).pipe(Effect.orElseSucceed(() => null));
          if (stat?.type === "Directory") pending.push({ directory: child, depth: depth + 1 });
        }
      }
      if (pending.length > 0)
        entries.push({
          kind: "worktree",
          worktreeResource: resource,
          outcome: "kept",
          reason: "Some dependency locations exceeded the discovery limit and were kept",
          path: root,
          projectPath: null,
          threadId: null,
          threadTitle: null,
          bytes: null,
          files: null,
        });
    }
    for (const [cwd, mappings] of registeredGroups) {
      if (knownPaths.has(cwd) || !(yield* outputExists(cwd))) continue;
      const entry: CleanupWorkingEntry = {
        kind: "worktree",
        worktreeResource: resource,
        outcome: "kept",
        reason: "Ownerless install is not yet eligible",
        path: outputPath(cwd),
        projectPath: mappings[0]!.project.workspaceRoot,
        threadId: null,
        threadTitle: null,
        bytes: null,
        files: null,
      };
      entries.push(entry);
      const candidate = mappings[0]!;
      const { project, branch, recordedPath } = candidate;
      const reviewRoot = roots.find((root) => inside(root, cwd));
      if (reviewRoot !== undefined)
        yield* registerReview(
          {
            managedWorktreesRoot: reviewRoot,
            worktreePath: cwd,
            repositoryRoot: project.workspaceRoot,
          },
          project.id,
          branch,
          false,
          entry,
        );
      const contextKey = reviewContext(project.id, cwd, recordedPath, branch, []);
      if (
        reviewRoot !== undefined &&
        !(yield* observeReviewContext(
          {
            managedWorktreesRoot: reviewRoot,
            worktreePath: cwd,
            repositoryRoot: project.workspaceRoot,
          },
          recordedPath,
          contextKey,
        ))
      ) {
        entry.reason = "Build review context could not be verified; files were retained.";
        continue;
      }
      const days = resolveWorktreeCleanup(serverSettings, project.id).worktreeDependenciesAfterDays;
      if (days === null) {
        entry.reason = "Project dependency cleanup is off";
        continue;
      }
      if (projectRepositories.some((repository) => repository.uncertain)) {
        entry.reason = "Could not verify repository ownership for every current project";
        continue;
      }
      if (
        mappings.length !== 1 ||
        projectRepositories.filter(
          (repository) => repository.commonDirectory === candidate.commonDirectory,
        ).length !== 1
      ) {
        entry.reason = "Repository belongs to more than one project";
        continue;
      }
      if (
        branch !== null &&
        ([...snapshot.threads, ...historicalOwners].some(
          (owner) => owner.projectId === project.id && owner.branch === branch,
        ) ||
          legacyOwners.some((owner) => owner.projectId === project.id && owner.branch === branch))
      ) {
        entry.reason = "Thread history still names this branch";
        continue;
      }
      const managedWorktreesRoot = roots.find((root) => inside(root, cwd));
      if (managedWorktreesRoot === undefined) {
        entry.reason = "Worktree is outside the configured cleanup locations";
        continue;
      }
      const input = {
        managedWorktreesRoot,
        worktreePath: cwd,
        repositoryRoot: project.workspaceRoot,
      };
      const keep = (reason: string) => {
        entry.reason = reason;
        return false;
      };
      const cleanOwnerless = Effect.gen(function* () {
        const consumerReason = Effect.fnUntraced(function* () {
          if (processCwds === null) return "Could not check running processes safely";
          if (processCwds.some((processCwd) => processCwd === cwd || inside(cwd, processCwd)))
            return "A running process is using this worktree";
          if (yield* terminalUsesDependencies(cwd, recordedPath))
            return "A terminal is still using this worktree";
          if (yield* previewUsesDependencies(cwd, recordedPath))
            return "A preview is using this worktree, or preview ownership could not be checked";
          if (yield* hasLiveProviderSession(cwd)) return "A provider session is still open";
          if (yield* containsProjectRoot(cwd, snapshot.projects))
            return "A project uses this worktree as its main workspace";
          return null;
        });
        const protectedReason = yield* consumerReason();
        const observation = yield* observe(
          input,
          now,
          processCwds?.some(
            (processCwd) =>
              processCwd === path.join(cwd, "node_modules") ||
              inside(path.join(cwd, "node_modules"), processCwd),
          ) ?? false,
        );
        if (observation === null) return keep(unrecognizedReason());
        if (protectedReason !== null) return keep(protectedReason);
        if (!review && observation.lastUsedAt >= now - days * DAY_MS) {
          return keep(
            observation.renewed
              ? "Started a full inactivity period for this recognized install"
              : "Dependencies were prepared or used within the inactivity period",
          );
        }
        const revalidate = Effect.fnUntraced(function* () {
          const current = yield* settingsService.getSettings;
          if (
            !locationsUnchanged(current) ||
            resolveWorktreeCleanup(current, project.id).worktreeDependenciesAfterDays !== days
          )
            return keep("Dependency cleanup policy or locations changed");
          if (yield* workspaceOwnershipChanged(cwd, project.id, branch))
            return keep("Workspace ownership changed during cleanup");
          if (!(yield* pathIdentityUnchanged(recordedPath, cwd)))
            return keep("Worktree path is a symlink or its location changed");
          if (yield* branchChanged(cwd, branch)) return keep("Repository or branch changed");
          const currentRepositories = yield* readProjectRepositories();
          if (
            currentRepositories.some((repository) => repository.uncertain) ||
            currentRepositories.filter(
              (repository) => repository.commonDirectory === candidate.commonDirectory,
            ).length !== 1
          )
            return keep("Repository and project mapping could not be verified uniquely");
          const registration = yield* readRegistered(project.workspaceRoot);
          if (
            registration === null ||
            !registration.some(
              (worktree) => worktree.recordedPath === recordedPath && worktree.branch === branch,
            )
          )
            return keep("Worktree registration changed or could not be verified");
          const reason = yield* consumerReason();
          if (reason !== null) return keep(reason);
          const latest = yield* observe(input, now, false, false);
          return (
            latest !== null &&
            !latest.renewed &&
            (generatedBuilds || latest.lastUsedAt === observation.lastUsedAt) &&
            !(yield* workspaceOwnershipChanged(cwd, project.id, branch)) &&
            resolveWorktreeCleanup(yield* settingsService.getSettings, project.id)
              .worktreeDependenciesAfterDays === days
          );
        });
        if (!(yield* revalidate())) return false;
        const canRemove = revalidate();
        if (review) {
          yield* performReview(
            input,
            contextKey,
            canRemove.pipe(Effect.orElseSucceed(() => false)),
          );
          return false;
        }
        if (generatedBuilds) {
          const removed = yield* builds.remove(
            buildInput(input),
            now,
            days,
            false,
            canRemove,
            canRemove,
            contextKey,
          );
          entry.reason = removed.reason;
          if (removed.failed) entry.outcome = "failed";
          if (removed.files > 0)
            Object.assign(entry, {
              outcome: removed.failed ? "failed" : "removed",
              bytes: removed.bytes,
              files: removed.files,
            });
          return removed.files > 0;
        }
        if (generatedBuildReviewProtection(cwd, "node_modules"))
          return keep("Reviewed build content protects these dependencies.");
        const inspection = yield* dependencies.inspect(input);
        if (inspection === null)
          return keep("No dependency install could be safely recognized and measured");
        dependencyEstimates.set(entry, inspection.estimatedReclaimedBytes);
        const removed = yield* dependencies.removeBatch(
          [{ inspection, canRemove, isStillEligible: canRemove }],
          (_inspection, decision) =>
            Effect.sync(() => {
              const genericRefusal =
                decision.outcome === "kept" &&
                decision.reason === "Worktree ownership or cleanup eligibility changed";
              Object.assign(entry, {
                outcome: decision.outcome,
                reason: genericRefusal ? entry.reason : decision.reason,
                bytes: decision.outcome === "removed" ? inspection.estimatedReclaimedBytes : null,
              });
            }),
        );
        if (removed.length > 0) {
          entry.outcome = "removed";
          entry.bytes = removed[0]!.estimatedReclaimedBytes;
          entry.reason = "Removed inactive ownerless dependencies; reclaimed size is estimated";
          return true;
        }
        return false;
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            entry.outcome = "failed";
            return keep(cleanupFailureReason(error));
          }),
        ),
      );
      const leasedPaths = [...new Set([cwd, recordedPath])].sort();
      yield* leasedPaths.reduceRight(
        (effect, target) => withWorkspaceLease(target, effect),
        cleanOwnerless,
      );
    }
    const candidates = [
      ...Map.groupBy([...liveOwners, ...deletedOwners], (owner) => owner.cleanupPath).values(),
    ].map((owners) => ({
      owners,
      thread:
        owners.find(
          (owner) =>
            resolveWorktreeCleanup(serverSettings, owner.projectId)
              .worktreeDependenciesAfterDays !== null,
        ) ?? owners[0]!,
    }));
    const eligible = (yield* Effect.forEach(candidates, ({ thread, owners }) =>
      Effect.gen(function* () {
        const days = resolveWorktreeCleanup(
          serverSettings,
          thread.projectId,
        ).worktreeDependenciesAfterDays;
        const contextKey = reviewContext(
          thread.projectId,
          thread.cleanupPath,
          thread.recordedWorktreePath,
          thread.branch,
          owners
            .map((owner) => [
              owner.id,
              owner.projectId,
              owner.branch,
              owner.worktreePath,
              owner.archivedAt,
              resolveWorktreeCleanup(serverSettings, owner.projectId).worktreeDependenciesAfterDays,
            ])
            .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
        );
        if (
          (review || generatedBuilds) &&
          thread.worktreePath !== null &&
          (yield* outputExists(thread.cleanupPath))
        ) {
          const managedWorktreesRoot = roots.find((root) => inside(root, thread.cleanupPath));
          const repositoryRoot =
            "workspaceRoot" in thread
              ? thread.workspaceRoot
              : snapshot.projects.find((project) => project.id === thread.projectId)?.workspaceRoot;
          if (managedWorktreesRoot && repositoryRoot) {
            const entry = noteCandidate(thread, thread.cleanupPath, repositoryRoot);
            yield* registerReview(
              { managedWorktreesRoot, repositoryRoot, worktreePath: thread.cleanupPath },
              thread.projectId,
              thread.branch,
              owners.every((owner) => owner.archivedAt !== null),
              entry,
            );
            if (
              !(yield* observeReviewContext(
                { managedWorktreesRoot, repositoryRoot, worktreePath: thread.cleanupPath },
                thread.recordedWorktreePath,
                contextKey,
              ))
            ) {
              entry.reason = "Build review context could not be verified; files were retained.";
              return [];
            }
            if (days === null) entry.reason = "Project dependency cleanup is off";
          }
        }
        if (days === null || thread.worktreePath === null || thread.branch === null) return [];
        const deleted = "dependencyActivityAt" in thread;
        const activityAt = deleted ? thread.dependencyActivityAt : storageCleanupActivityAt(thread);
        const worktreePath = thread.cleanupPath;
        const recordedWorktreePath = thread.recordedWorktreePath;
        if (!(yield* outputExists(worktreePath))) return [];
        const entry =
          reports.get(worktreePath) ??
          noteCandidate(
            thread,
            worktreePath,
            "workspaceRoot" in thread
              ? thread.workspaceRoot
              : (snapshot.projects.find((project) => project.id === thread.projectId)
                  ?.workspaceRoot ?? null),
          );
        const keep = (reason: string) => {
          Object.assign(entry, { reason });
          return [];
        };
        const archived = owners.every((owner) => owner.archivedAt !== null);
        if (
          owners.some(
            (owner) =>
              resolveWorktreeCleanup(serverSettings, owner.projectId)
                .worktreeDependenciesAfterDays === null,
          )
        )
          return keep("An owning project's dependency cleanup policy is off");
        if (owners.length > 1 && !archived)
          return keep("An unarchived thread still shares this worktree");
        const ownerIds = new Set(owners.map((owner) => owner.id));
        for (const historical of [
          ...historicalOwners.map((owner) => ({ id: owner.id, path: owner.worktreePath })),
          ...legacyOwners.map((owner) => ({ id: owner.threadId, path: owner.worktreePath })),
        ]) {
          if (
            historical.path !== null &&
            !ownerIds.has(historical.id as ThreadId) &&
            (yield* resolveOwnerPath(historical.path)) === worktreePath
          )
            return keep("A historical owner's policy or archival state could not be verified");
        }
        if (activityAt === null) return keep("Could not verify the last thread activity");
        if (!(yield* pathIdentityUnchanged(recordedWorktreePath, worktreePath)))
          return keep("Worktree path is a symlink or its location changed");
        const managedWorktreesRoot = roots.find((root) => inside(root, worktreePath));
        if (managedWorktreesRoot === undefined)
          return keep("Worktree is outside the configured cleanup locations");
        if (yield* workspaceOwnershipChanged(worktreePath, thread.projectId, thread.branch))
          return keep("Workspace ownership changed during cleanup");
        if (processCwds === null) return keep("Could not check running processes safely");
        if (!deleted && !storageCleanupThreadIdle(thread, now))
          return keep("Thread still has active or pending work");
        if (
          processCwds.some(
            (cwd) => path.resolve(cwd) === worktreePath || inside(worktreePath, path.resolve(cwd)),
          )
        )
          return keep("A running process is using this worktree");
        const project = deleted
          ? { workspaceRoot: thread.workspaceRoot }
          : snapshot.projects.find((entry) => entry.id === thread.projectId);
        if (project === undefined) return keep("Project is no longer available");
        if (projectRepositories.some((repository) => repository.uncertain))
          return keep("Could not verify repository ownership for every current project");
        const repository = projectRepositories.find(
          (repository) => repository.project.id === thread.projectId,
        );
        if (
          repository?.commonDirectory === null ||
          repository === undefined ||
          projectRepositories.filter(
            (entry) => entry.commonDirectory === repository.commonDirectory,
          ).length !== 1
        )
          return keep("Repository and project mapping could not be verified uniquely");
        if (!archived) {
          const dependencyActivity = dependencyActivityByPath.get(worktreePath) ?? null;
          if (dependencyActivity === null) return keep(unrecognizedReason());
          if (dependencyActivity.protectedReason !== null)
            return keep(dependencyActivity.protectedReason);
          if (!review && dependencyActivity.lastUsedAt >= now - days * DAY_MS)
            return keep(
              dependencyActivity.renewed
                ? "Started a full inactivity period for this recognized install"
                : "Dependencies were prepared or used within the inactivity period",
            );
        }
        if (yield* terminalUsesDependencies(worktreePath, recordedWorktreePath))
          return keep("A terminal is still using this worktree");
        return [
          {
            thread,
            owners,
            archived,
            days,
            deleted,
            activityAt,
            worktreePath,
            recordedWorktreePath,
            managedWorktreesRoot,
            project,
            contextKey,
          },
        ];
      }),
    )).flat();
    const batchSize = GeneratedDependencies.MAX_DEPENDENCY_REMOVAL_BATCH_SIZE;
    for (let offset = 0; offset < eligible.length; offset += batchSize) {
      const group = eligible.slice(offset, offset + batchSize);
      const removeGroup = Effect.gen(function* () {
        const prepared = (yield* Effect.forEach(
          group,
          ({
            thread,
            owners,
            archived,
            days,
            deleted,
            activityAt,
            worktreePath,
            recordedWorktreePath,
            managedWorktreesRoot,
            project,
            contextKey,
          }) =>
            Effect.gen(function* () {
              const entry = reports.get(worktreePath)!;
              const keep = (reason: string) => {
                Object.assign(entry, { reason });
                return false;
              };
              const allOwnerPoliciesUnchanged = (currentSettings: ServerSettings) =>
                owners.every((owner) => {
                  const initial = resolveWorktreeCleanup(
                    serverSettings,
                    owner.projectId,
                  ).worktreeDependenciesAfterDays;
                  return (
                    initial !== null &&
                    resolveWorktreeCleanup(currentSettings, owner.projectId)
                      .worktreeDependenciesAfterDays === initial
                  );
                });
              const familyStillIdle = Effect.fnUntraced(function* () {
                for (const owner of owners) {
                  const initialDays = resolveWorktreeCleanup(
                    serverSettings,
                    owner.projectId,
                  ).worktreeDependenciesAfterDays;
                  if (
                    initialDays === null ||
                    resolveWorktreeCleanup(yield* settingsService.getSettings, owner.projectId)
                      .worktreeDependenciesAfterDays !== initialDays
                  )
                    return keep("An owning project's dependency cleanup policy changed or is off");
                  if (yield* hasLiveProviderSession(worktreePath, owner.id))
                    return keep("A provider session is still open");
                  if (owner.id === thread.id) continue;
                  if (
                    owner.branch !== thread.branch ||
                    !(yield* pathIdentityUnchanged(owner.recordedWorktreePath, worktreePath))
                  )
                    return keep("Shared worktree identity or branch changed");
                  const latest = yield* projections.getThreadShell(owner.id);
                  if ("dependencyActivityAt" in owner) {
                    const rows = yield* readDeletedDependencyCandidates(owner.id);
                    if (latest !== null && latest.deletedAt === null)
                      return keep("A shared owner was restored");
                    if (
                      rows.length !== 1 ||
                      rows[0]!.worktreePath === null ||
                      (yield* canonicalWorkspacePath(rows[0]!.worktreePath)) !== worktreePath ||
                      rows[0]!.branch !== owner.branch ||
                      rows[0]!.projectId !== owner.projectId ||
                      rows[0]!.archivedAt === null ||
                      rows[0]!.dependencyActivityAt !== owner.dependencyActivityAt
                    )
                      return keep("Shared owner activity or archival state changed");
                    const pending =
                      yield* sql`SELECT 1 FROM orchestration_v2_effect_outbox WHERE thread_id = ${owner.id} AND status NOT IN ('succeeded', 'cancelled') LIMIT 1`;
                    if (pending.length > 0) return keep("A shared owner still has pending work");
                  } else if (
                    latest === null ||
                    latest.deletedAt !== null ||
                    latest.archivedAt === null ||
                    latest.worktreePath === null ||
                    (yield* canonicalWorkspacePath(latest.worktreePath)) !== worktreePath ||
                    latest.branch !== owner.branch ||
                    latest.projectId !== owner.projectId ||
                    !storageCleanupThreadIdle(latest, now) ||
                    storageCleanupActivityAt(latest) !== storageCleanupActivityAt(owner)
                  )
                    return keep("A shared owner is unarchived, active, or changed");
                  if (yield* hasPendingWorkspaceWork(owner.id))
                    return keep("A shared owner still has active or pending work");
                  const ownerProject =
                    "workspaceRoot" in owner
                      ? { workspaceRoot: owner.workspaceRoot }
                      : snapshot.projects.find((candidate) => candidate.id === owner.projectId);
                  if (
                    ownerProject === undefined ||
                    (yield* containsProjectRoot(worktreePath, [ownerProject]))
                  )
                    return keep("A shared owner's project could not be verified safely");
                  if (
                    (yield* observe(
                      {
                        managedWorktreesRoot,
                        worktreePath,
                        repositoryRoot: ownerProject.workspaceRoot,
                      },
                      now,
                      false,
                      false,
                    )) === null
                  )
                    return keep(
                      generatedBuilds
                        ? unrecognizedReason()
                        : "Shared owners do not map to the same recognized repository",
                    );
                }
                return (
                  allOwnerPoliciesUnchanged(yield* settingsService.getSettings) ||
                  keep("An owning project's dependency cleanup policy changed or is off")
                );
              });
              const candidateStillIdle = Effect.fn("StorageCleanup.dependencyCandidateStillIdle")(
                function* () {
                  if (!archived) {
                    const dependencyActivity = yield* observe(
                      { managedWorktreesRoot, worktreePath, repositoryRoot: project.workspaceRoot },
                      now,
                      false,
                      false,
                    );
                    if (
                      dependencyActivity === null ||
                      dependencyActivity.renewed ||
                      (!review && dependencyActivity.lastUsedAt >= now - days * DAY_MS)
                    )
                      return keep("Dependency installation or use changed during cleanup");
                  }
                  if (!(yield* familyStillIdle())) return false;
                  const currentSettings = yield* settingsService.getSettings;
                  if (!locationsUnchanged(currentSettings))
                    return keep("Worktree cleanup locations changed");
                  const currentDays = resolveWorktreeCleanup(
                    currentSettings,
                    thread.projectId,
                  ).worktreeDependenciesAfterDays;
                  if (currentDays !== days) return keep("Dependency cleanup policy changed");
                  if (!(yield* pathIdentityUnchanged(recordedWorktreePath, worktreePath)))
                    return keep("Worktree path is a symlink or its location changed");
                  if (yield* terminalUsesDependencies(worktreePath, recordedWorktreePath))
                    return keep("A terminal is still using this worktree");
                  if (
                    yield* workspaceOwnershipChanged(worktreePath, thread.projectId, thread.branch)
                  )
                    return keep("Workspace ownership changed during cleanup");
                  if (yield* containsProjectRoot(worktreePath, [project, ...snapshot.projects]))
                    return keep("A project uses this worktree as its main workspace");
                  if (yield* previewUsesDependencies(worktreePath, recordedWorktreePath))
                    return keep(
                      "A preview is using this worktree, or preview ownership could not be checked",
                    );
                  const latest = yield* projections.getThreadShell(thread.id);
                  if (deleted) {
                    if (latest !== null && latest.deletedAt === null)
                      return keep("Thread was restored during cleanup");
                    const rows = yield* readDeletedDependencyCandidates(thread.id);
                    if (
                      rows.length !== 1 ||
                      rows[0]!.id !== thread.id ||
                      rows[0]!.worktreePath === null ||
                      path.resolve(rows[0]!.worktreePath) !== recordedWorktreePath ||
                      rows[0]!.branch !== thread.branch ||
                      rows[0]!.projectId !== thread.projectId ||
                      path.resolve(rows[0]!.workspaceRoot) !==
                        path.resolve(project.workspaceRoot) ||
                      rows[0]!.dependencyActivityAt !== activityAt ||
                      !Equal.equals(rows[0]!.archivedAt, thread.archivedAt)
                    )
                      return false;
                    const pending = yield* sql`
              SELECT 1 FROM orchestration_v2_effect_outbox
              WHERE thread_id = ${thread.id} AND status NOT IN ('succeeded', 'cancelled') LIMIT 1
            `;
                    if (pending.length > 0) return keep("Thread still has pending work");
                  } else if (
                    latest === null ||
                    latest.deletedAt !== null ||
                    latest.id !== thread.id ||
                    latest.worktreePath === null ||
                    path.resolve(latest.worktreePath) !== recordedWorktreePath ||
                    latest.branch !== thread.branch ||
                    latest.projectId !== thread.projectId ||
                    !Equal.equals(latest.archivedAt, thread.archivedAt) ||
                    !storageCleanupThreadIdle(latest, now) ||
                    storageCleanupActivityAt(latest) !== activityAt
                  )
                    return false;
                  if (yield* hasPendingWorkspaceWork(thread.id))
                    return keep("Thread still has active or pending work");
                  return (
                    !(yield* terminalUsesDependencies(worktreePath, recordedWorktreePath)) &&
                    !(yield* workspaceOwnershipChanged(
                      worktreePath,
                      thread.projectId,
                      thread.branch,
                    )) &&
                    allOwnerPoliciesUnchanged(yield* settingsService.getSettings)
                  );
                },
              );
              const revalidate = Effect.fn("StorageCleanup.revalidateDependencies")(function* () {
                if (!(yield* candidateStillIdle())) return false;
                if (yield* hasLiveProviderSession(worktreePath, thread.id))
                  return keep("A provider session is still open");
                const status = yield* git.statusDetailsLocal(worktreePath);
                if (!status.isRepo || status.branch !== thread.branch)
                  return keep("Repository or branch changed");
                // Re-read policy, activity, roots, leases and durable pending state
                // after Git/session calls as well as after dependency inspection.
                return (
                  (yield* candidateStillIdle()) &&
                  !(yield* hasLiveProviderSession(worktreePath, thread.id))
                );
              });
              if (!(yield* revalidate())) return null;
              let eligibilitySequence: number | null = null;
              const canRemove = Effect.gen(function* () {
                eligibilitySequence = yield* readApplicationSequence();
                return yield* revalidate();
              });
              const isStillEligible = Effect.gen(function* () {
                if (!(yield* candidateStillIdle())) return false;
                if (
                  eligibilitySequence === null ||
                  (yield* terminalUsesDependencies(worktreePath, recordedWorktreePath)) ||
                  !(yield* pathIdentityUnchanged(recordedWorktreePath, worktreePath))
                )
                  return false;
                const currentSettings = yield* settingsService.getSettings;
                if (!locationsUnchanged(currentSettings))
                  return keep("Worktree cleanup locations changed");
                if (
                  resolveWorktreeCleanup(currentSettings, thread.projectId)
                    .worktreeDependenciesAfterDays !== days
                )
                  return false;
                if (yield* workspaceOwnershipChanged(worktreePath, thread.projectId, thread.branch))
                  return keep("Workspace ownership changed during cleanup");
                // Siblings and mount inventory may take time. Late runtime or
                // core mutations for any known owner invalidate prepared state;
                // visits, PR refreshes and other bookkeeping cannot change it.
                const changed = yield* sql`
                  SELECT 1 FROM orchestration_events
                  WHERE sequence > ${eligibilitySequence}
                    AND aggregate_kind = 'thread'
                    AND stream_id IN ${sql.in(owners.map((owner) => owner.id))}
                    AND event_type NOT IN (
                      'thread.visited', 'thread.marked-unread',
                      'thread.pull-request-link-updated', 'thread.pull-request-synced',
                      'thread.attention-set', 'thread.attention-cleared',
                      'thread.pinned', 'thread.unpinned',
                      'thread.pin-reordered', 'thread.active-reordered'
                    )
                  LIMIT 1
                `;
                if (changed.length > 0 || (yield* hasPendingWorkspaceWork(thread.id))) return false;
                if (deleted) {
                  const pending = yield* sql`
                    SELECT 1 FROM orchestration_v2_effect_outbox
                    WHERE thread_id = ${thread.id} AND status NOT IN ('succeeded', 'cancelled')
                    LIMIT 1
                  `;
                  if (pending.length > 0) return false;
                }
                if (yield* previewUsesDependencies(worktreePath, recordedWorktreePath))
                  return false;
                if (yield* hasLiveProviderSession(worktreePath, thread.id)) return false;
                return (
                  !(yield* terminalUsesDependencies(worktreePath, recordedWorktreePath)) &&
                  allOwnerPoliciesUnchanged(yield* settingsService.getSettings)
                );
              });
              if (review) {
                yield* performReview(
                  { managedWorktreesRoot, worktreePath, repositoryRoot: project.workspaceRoot },
                  contextKey,
                  canRemove.pipe(Effect.catch(() => Effect.succeed(false))),
                );
                return null;
              }
              if (generatedBuilds) {
                const removed = yield* builds.remove(
                  buildInput({
                    managedWorktreesRoot,
                    worktreePath,
                    repositoryRoot: project.workspaceRoot,
                  }),
                  now,
                  days,
                  archived,
                  canRemove,
                  isStillEligible,
                  contextKey,
                );
                entry.reason = removed.reason;
                if (removed.failed) entry.outcome = "failed";
                if (removed.files > 0)
                  Object.assign(entry, {
                    outcome: removed.failed ? "failed" : "removed",
                    bytes: removed.bytes,
                    files: removed.files,
                  });
                return null;
              }
              if (generatedBuildReviewProtection(worktreePath, "node_modules")) {
                keep("Reviewed build content protects these dependencies.");
                return null;
              }
              const inspection = yield* dependencies.inspect({
                managedWorktreesRoot,
                worktreePath,
                repositoryRoot: project.workspaceRoot,
              });
              if (inspection === null) {
                keep("No dependency install could be safely recognized and measured");
                return null;
              }
              return {
                inspection,
                canRemove,
                isStillEligible,
                threadId: thread.id,
              };
            }).pipe(
              Effect.catch((error) => {
                Object.assign(reports.get(worktreePath)!, {
                  outcome: "failed",
                  reason: cleanupFailureReason(error),
                });
                return Effect.logDebug("storage cleanup skipped dependencies", {
                  threadId: thread.id,
                  error,
                }).pipe(Effect.as(null));
              }),
            ),
          { concurrency: group.length },
        )).filter((entry) => entry !== null);
        const removedEntries = yield* dependencies.removeBatch(prepared, (inspection, decision) =>
          Effect.sync(() => {
            const entry = reports.get(inspection.worktreePath)!;
            dependencyEstimates.set(entry, inspection.estimatedReclaimedBytes);
            const genericRefusal =
              decision.outcome === "kept" &&
              decision.reason === "Worktree ownership or cleanup eligibility changed";
            Object.assign(entry, {
              outcome: decision.outcome,
              reason:
                genericRefusal &&
                entry.reason !== "A final safety check prevented dependency removal"
                  ? entry.reason
                  : decision.reason,
              bytes: decision.outcome === "removed" ? inspection.estimatedReclaimedBytes : null,
            });
          }),
        );
        for (const removed of removedEntries) {
          Object.assign(reports.get(removed.worktreePath)!, {
            outcome: "removed",
            reason: `Removed ${removed.packageManager} dependencies; reclaimed size is estimated`,
            bytes: removed.estimatedReclaimedBytes,
          });
          yield* Effect.logInfo("storage cleanup removed dependency install", {
            threadId: prepared.find(
              (entry) => entry.inspection.dependencyPath === removed.dependencyPath,
            )!.threadId,
            packageManager: removed.packageManager,
            estimatedReclaimedBytes: removed.estimatedReclaimedBytes,
          });
        }
      });
      // Ordered group leases exclude startup throughout inspection and removal.
      const paths = [
        ...new Set(
          group.flatMap((entry) => [
            entry.worktreePath,
            ...entry.owners.map((owner) => owner.recordedWorktreePath),
          ]),
        ),
      ].sort();
      yield* paths.reduceRight((effect, cwd) => withWorkspaceLease(cwd, effect), removeGroup);
    }
  });

  const cleanWorktrees = Effect.fn("StorageCleanup.cleanWorktrees")(function* (
    serverSettings: ServerSettings,
    now: number,
    entries: CleanupWorkingEntry[],
    runId: string,
  ) {
    if (!anyWorktreePolicy(serverSettings, worktreeCleanupEnabled)) return;
    const roots = yield* managedRoots(serverSettings);
    const deletedRows = yield* sql<{ payload_json: string; workspaceRoot: string }>`
          SELECT t.payload_json, p.workspace_root AS "workspaceRoot"
          FROM orchestration_v2_projection_threads t
          JOIN projection_projects p ON p.project_id = t.project_id
          WHERE t.deleted_at IS NOT NULL
        `;
    const deletedThreads = (yield* Effect.forEach(deletedRows, (row) =>
      decodeCleanupThread(row.payload_json).pipe(
        Effect.map((thread) => ({ ...thread, workspaceRoot: row.workspaceRoot })),
      ),
    )).filter((thread) => thread.worktreePath !== null && thread.branch !== null);
    const snapshot = yield* readThreads();
    const previewLeases = yield* previewsProtectingWorktrees();
    if (previewLeases === null) return;
    const refreshedDefaultRefs = new Map<string, Set<string>>();
    const defaultBranches = new Map<string, string | null>();
    const sequence = yield* readApplicationSequence();
    const ownedPaths = yield* Effect.forEach(
      [...snapshot.threads.filter((thread) => thread.worktreePath !== null), ...deletedThreads],
      (thread) =>
        Effect.gen(function* () {
          return {
            thread,
            recordedPath: path.resolve(thread.worktreePath!),
            canonicalPath: yield* canonicalWorkspacePath(thread.worktreePath!),
          };
        }),
    );
    const groups = Map.groupBy(ownedPaths, (owner) => owner.canonicalPath);
    const candidates = [...groups.values()];
    const historicalRows = yield* sql<{ threadId: ThreadId; worktreePath: string | null }>`
      SELECT thread_id AS "threadId", json_extract(payload_json, '$.worktreePath') AS "worktreePath"
      FROM orchestration_v2_projection_threads
    `;
    const legacyRows = yield* worktreeCleanup.historicalWorktreeOwners;
    const historicalPaths = yield* Effect.forEach([...historicalRows, ...legacyRows], (owner) =>
      Effect.gen(function* () {
        return {
          id: owner.threadId,
          cwd:
            owner.worktreePath === null ? null : yield* canonicalWorkspacePath(owner.worktreePath),
        };
      }),
    );
    const hasLiveProviderSession = yield* makeProviderSessionGuard();
    for (const owners of candidates) {
      const group = owners.flatMap((owner) =>
        "workspaceRoot" in owner.thread ? [] : [owner.thread],
      );
      const familyOwner = group.length === owners.length ? worktreeOwner(group) : undefined;
      const thread =
        familyOwner ??
        (
          owners.find((owner) =>
            worktreeCleanupEnabled(resolveWorktreeCleanup(serverSettings, owner.thread.projectId)),
          ) ?? owners[0]!
        ).thread;
      const settings = resolveWorktreeCleanup(serverSettings, thread.projectId);
      if (!worktreeCleanupEnabled(settings)) continue;
      const worktreePath = owners[0]!.canonicalPath;
      const activityAt = Math.max(...group.map(storageCleanupActivityAt));
      const deleted = "workspaceRoot" in thread;
      const project = deleted
        ? { workspaceRoot: thread.workspaceRoot }
        : snapshot.projects.find((entry) => entry.id === thread.projectId);
      const entry: CleanupWorkingEntry = {
        kind: "worktree",
        outcome: "kept",
        reason: "",
        path: worktreePath,
        projectPath: project?.workspaceRoot ?? null,
        threadId: thread.id,
        threadTitle: thread.title,
        bytes: null,
        files: null,
      };
      const keep = (reason: string) => entries.push({ ...entry, reason: sentence(reason) });
      const decisionStart = entries.length;
      const allArchived = owners.every((owner) => owner.thread.archivedAt !== null);
      const policiesUnchanged = (current: ServerSettings) =>
        current.worktreesDirectory === serverSettings.worktreesDirectory &&
        Equal.equals(
          current.previousWorktreesDirectories,
          serverSettings.previousWorktreesDirectories,
        ) &&
        owners.every((owner) =>
          Equal.equals(
            resolveWorktreeCleanup(current, owner.thread.projectId),
            resolveWorktreeCleanup(serverSettings, owner.thread.projectId),
          ),
        );
      const sameRepository = Effect.fnUntraced(function* () {
        if (project === undefined) return false;
        const common = yield* git.execute({
          operation: "StorageCleanup.worktreeRepository",
          cwd: worktreePath,
          args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
          maxOutputBytes: 64 * 1024,
          allowNonZeroExit: true,
        });
        const expected = yield* git.execute({
          operation: "StorageCleanup.worktreeRepository",
          cwd: project.workspaceRoot,
          args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
          maxOutputBytes: 64 * 1024,
          allowNonZeroExit: true,
        });
        if (
          common.exitCode !== 0 ||
          expected.exitCode !== 0 ||
          common.stdoutTruncated ||
          expected.stdoutTruncated ||
          common.stderrTruncated ||
          expected.stderrTruncated
        )
          return false;
        const actualPath = common.stdout.trim();
        const expectedPath = expected.stdout.trim();
        if (
          !path.isAbsolute(actualPath) ||
          !path.isAbsolute(expectedPath) ||
          actualPath.includes("\n") ||
          expectedPath.includes("\n")
        )
          return false;
        const actualCommon = yield* fs.realPath(actualPath);
        if (actualCommon !== (yield* fs.realPath(expectedPath))) return false;
        let mappings = 0;
        for (const currentProject of yield* projectStore.listShells()) {
          const repository = yield* git.execute({
            operation: "StorageCleanup.worktreeRepository",
            cwd: currentProject.workspaceRoot,
            args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
            allowNonZeroExit: true,
            env: { LC_ALL: "C" },
            maxOutputBytes: 64 * 1024,
          });
          if (
            repository.exitCode !== 0 &&
            !repository.stdoutTruncated &&
            !repository.stderrTruncated &&
            repository.stderr.toLowerCase().includes("not a git repository")
          )
            continue;
          const commonPath = repository.stdout.trim();
          if (
            repository.exitCode !== 0 ||
            repository.stdoutTruncated ||
            repository.stderrTruncated ||
            !path.isAbsolute(commonPath) ||
            commonPath.includes("\n")
          )
            return false;
          if ((yield* fs.realPath(commonPath)) === actualCommon) {
            if (
              currentProject.id !== thread.projectId ||
              path.resolve(currentProject.workspaceRoot) !== path.resolve(project.workspaceRoot)
            )
              return false;
            mappings++;
          }
        }
        return mappings === 1;
      });
      yield* Effect.gen(function* () {
        if (!(yield* fs.exists(worktreePath))) return;
        if (
          deleted &&
          !settings.worktreeOnDelete &&
          !(allArchived && settings.worktreeAfterDays !== null)
        )
          return keep("no rules apply");
        if (
          owners.some(
            (owner) =>
              !worktreeCleanupEnabled(
                resolveWorktreeCleanup(serverSettings, owner.thread.projectId),
              ),
          )
        )
          return keep("whole-worktree cleanup is off for an owner");
        if (
          historicalPaths.some(
            (owner) =>
              owner.cwd === worktreePath && !owners.some((known) => known.thread.id === owner.id),
          )
        )
          return keep("historical thread ownership could not be resolved");
        if (owners.length > 1 && !allArchived && familyOwner === undefined)
          return keep(`shared by ${owners.length} threads`);
        if (familyOwner !== undefined && group.some((member) => member.branch !== thread.branch))
          return keep("a subagent thread's branch differs from this worktree's branch");
        if (
          owners.some(
            (owner) =>
              owner.thread.branch !== thread.branch || owner.thread.projectId !== thread.projectId,
          )
        )
          return keep("shared repository or project ownership is ambiguous");
        if (project === undefined) return keep("project is unavailable");
        if (thread.branch === null) return keep("thread is running or has pending work");
        for (const owner of owners) {
          if (!("workspaceRoot" in owner.thread) && !storageCleanupThreadIdle(owner.thread, now))
            return keep("thread is running or has pending work");
          if (yield* hasPendingWorkspaceWork(owner.thread.id))
            return keep("thread has pending workspace work");
        }
        if (hasTerminal(worktreePath)) return keep("open terminal");
        if (previewUsesWorktree(worktreePath, previewLeases))
          return keep("preview is still using the worktree");
        // Roots are canonical, so compare canonical paths. A symlinked parent
        // (a linked drive) is fine; a symlinked worktree directory is not.
        const realPath = yield* fs.realPath(worktreePath);
        const realParent = yield* fs.realPath(path.dirname(worktreePath));
        if (realPath !== path.join(realParent, path.basename(worktreePath)))
          return keep("worktree is a symbolic link");
        if (!roots.some((root) => inside(root, realPath)))
          return keep("outside the managed worktree folder");
        if (yield* containsProjectRoot(worktreePath, [project, ...snapshot.projects]))
          return keep("contains a project checkout");
        // A linked worktree has a .git file. Never remove a main checkout.
        if (
          yield* fs.readLink(path.join(worktreePath, ".git")).pipe(
            Effect.as(true),
            Effect.catchIf(
              (error) =>
                error.cause instanceof Error &&
                "code" in error.cause &&
                error.cause.code === "EINVAL",
              () => Effect.succeed(false),
            ),
          )
        )
          return keep("worktree metadata is a symbolic link");
        if ((yield* fs.stat(path.join(worktreePath, ".git"))).type !== "File")
          return keep("not a linked worktree");
        for (const owner of owners) {
          if (
            (yield* fs.realPath(owner.recordedPath)) !== worktreePath ||
            (yield* fs.realPath(path.dirname(owner.recordedPath))).concat(
              path.sep,
              path.basename(owner.recordedPath),
            ) !== worktreePath
          )
            return keep("worktree path is a symlink or its location changed");
        }
        if (!(yield* sameRepository())) return keep("repository and project mapping changed");
        if (yield* branchChanged(worktreePath, thread.branch))
          return keep("repository or branch changed");
        const changes = yield* localChangesReason(worktreePath);
        if (changes !== null) return keep(changes);
        if (
          !deleted &&
          group.some(
            (member) =>
              member.settledAt !== null &&
              now - Math.max(DateTime.toEpochMillis(member.updatedAt), activityAt) <
                SETTLE_SCRIPT_GRACE_MS,
          )
        )
          return keep("settled moments ago");
        const head = yield* git.resolveCommit({ cwd: worktreePath, revision: "HEAD" });
        const old =
          !deleted &&
          settings.worktreeAfterDays !== null &&
          activityAt < now - settings.worktreeAfterDays * DAY_MS;
        const settledFor =
          deleted || thread.settledAt === null
            ? null
            : now - Math.max(DateTime.toEpochMillis(thread.settledAt), activityAt);
        const settledDays = settledFor === null ? null : Math.floor(settledFor / DAY_MS);
        const settled =
          settledFor !== null &&
          settings.worktreeSettledAfterDays !== null &&
          settledFor >= settings.worktreeSettledAfterDays * DAY_MS;
        const archived = allArchived && settings.worktreeAfterDays !== null;
        let eligible = archived || deleted || old || settled;
        let removalReason = archived
          ? "all thread owners are archived"
          : deleted
            ? "thread was deleted"
            : old
              ? `inactive for ${Math.floor((now - activityAt) / DAY_MS)} days`
              : `settled for ${settledDays} days`;
        if (!eligible && (settings.worktreeUnchanged || settings.worktreeOnMerge)) {
          const repositoryCwd = path.resolve(project.workspaceRoot);
          const remote = yield* git.resolvePrimaryRemoteName(repositoryCwd);
          const defaultBranchKey = `${repositoryCwd}\0${remote}`;
          let branch = defaultBranches.get(defaultBranchKey);
          if (branch === undefined) {
            branch = yield* git.resolveDefaultBranchName(repositoryCwd, remote);
            // Without a local HEAD ref, only the remote can identify its default;
            // a conventional name may be a feature branch.
            if (branch === null) {
              branch = yield* git
                .execute({
                  operation: "StorageCleanup.resolveDefaultBranch",
                  cwd: repositoryCwd,
                  args: ["ls-remote", "--symref", "--", remote, "HEAD"],
                  timeoutMs: 20_000,
                })
                .pipe(
                  Effect.map(
                    (result) =>
                      /^ref: refs\/heads\/(.+)\tHEAD\r?$/m.exec(result.stdout)?.[1] ?? null,
                  ),
                  Effect.orElseSucceed(() => null),
                );
            }
            defaultBranches.set(defaultBranchKey, branch);
          }
          if (branch === null) return keep("default branch is unavailable");
          const defaultRef = `refs/remotes/${remote}/${branch}`;
          const refreshed = refreshedDefaultRefs.get(repositoryCwd) ?? new Set<string>();
          if (!refreshed.has(defaultRef)) {
            yield* git.fetchRemoteTrackingBranch({
              cwd: repositoryCwd,
              remoteName: remote,
              remoteBranch: branch,
            });
            refreshed.add(defaultRef);
            refreshedDefaultRefs.set(repositoryCwd, refreshed);
          }
          const base = yield* git.resolveCommit({
            cwd: worktreePath,
            revision: defaultRef,
          });
          const ancestor = yield* git.execute({
            operation: "StorageCleanup.integratedBranch",
            cwd: worktreePath,
            args: ["merge-base", "--is-ancestor", head.commitSha, base.commitSha],
            allowNonZeroExit: true,
          });
          const integrated = ancestor.exitCode === 0;
          eligible = integrated && settings.worktreeUnchanged;
          if (eligible) removalReason = "no commits beyond the default branch";
          if (!eligible && settings.worktreeOnMerge && thread.branch !== null) {
            const pullRequest = yield* gitManager.branchPullRequest(
              { cwd: worktreePath, branch: thread.branch },
              { refresh: true },
            );
            eligible = storageCleanupPullRequestMerged(pullRequest, {
              branch: thread.branch,
              defaultBranch: branch,
              headSha: head.commitSha,
              integrated,
            });
            if (eligible) removalReason = "pull request was merged";
          }
        }
        if (!eligible)
          return keep(
            !deleted && settings.worktreeAfterDays !== null
              ? `inactive for ${Math.floor((now - activityAt) / DAY_MS)} of ${settings.worktreeAfterDays} days`
              : settings.worktreeSettledAfterDays !== null
                ? settledFor === null
                  ? "not settled"
                  : `settled for ${settledDays} of ${settings.worktreeSettledAfterDays} days`
                : settings.worktreeOnMerge
                  ? "not merged"
                  : "has commits beyond the default branch",
          );
        // Threads, queued deletion work and provider sessions as they are now, so a
        // queued turn, resumed session or new thread sharing this path cancels
        // the removal. Read only this path's threads: a full snapshot per
        // worktree takes seconds on large databases.
        const blockedSinceCheck = Effect.fnUntraced(function* () {
          if (generatedBuildReviewProtection(worktreePath))
            return "reviewed build content protects this worktree";
          const latestProjects = yield* projectStore.listShells();
          if (!policiesUnchanged(yield* settingsService.getSettings))
            return "settings changed since check";
          if (
            yield* ownershipChangedSince(sequence, {
              cwd: worktreePath,
              projectId: thread.projectId,
              branch: thread.branch,
              threads: [...snapshot.threads, ...deletedThreads],
              projects: snapshot.projects,
            })
          )
            return "thread or project ownership changed since check";
          if (yield* containsProjectRoot(worktreePath, [project, ...latestProjects]))
            return "contains a project checkout";
          const latestPreviewLeases = yield* previewsProtectingWorktrees();
          if (previewUsesWorktree(worktreePath, latestPreviewLeases))
            return "preview is still using the worktree";
          const latestPaths = (yield* Effect.forEach(
            yield* projections.getThreadWorktreePaths({ includeArchived: true }),
            (entry) =>
              canonicalWorkspacePath(entry.worktreePath).pipe(
                Effect.map((cwd) => (cwd === worktreePath ? entry.threadId : null)),
              ),
          )).filter((id) => id !== null);
          const latest = (yield* Effect.forEach(
            [
              ...new Set([
                ...latestPaths,
                ...owners
                  .filter((owner) => !("workspaceRoot" in owner.thread))
                  .map((owner) => owner.thread.id),
              ]),
            ],
            (id) => projections.getThreadShell(id),
          )).filter((entry) => entry !== null);
          if (hasTerminal(worktreePath)) return "open terminal";
          if (deleted) {
            if (
              latest.length > 0 ||
              (!resolveWorktreeCleanup(yield* settingsService.getSettings, thread.projectId)
                .worktreeOnDelete &&
                !archived)
            )
              return "thread or cleanup settings changed since check";
            // V2 deletion queues durable cleanup. Do not remove its checkout until
            // every effect has finished successfully or was explicitly cancelled.
            const pendingCleanup = yield* sql`
              SELECT 1 FROM orchestration_v2_effect_outbox
              WHERE thread_id = ${thread.id} AND status NOT IN ('succeeded', 'cancelled') LIMIT 1
            `;
            if (pendingCleanup.length > 0) return "thread deletion is still pending";
          } else {
            const liveOwners = owners.filter((owner) => !("workspaceRoot" in owner.thread));
            const latestOwner = worktreeOwner(latest);
            if (
              (familyOwner !== undefined &&
                (latestOwner?.id !== familyOwner.id || latestOwner?.branch !== thread.branch)) ||
              latest.length !== liveOwners.length ||
              liveOwners.some((owner) => {
                const current = latest.find((entry) => entry.id === owner.thread.id);
                return (
                  current === undefined ||
                  !storageCleanupThreadIdle(current, now) ||
                  current.branch !== owner.thread.branch ||
                  current.projectId !== owner.thread.projectId ||
                  !Equal.equals(current.archivedAt, owner.thread.archivedAt) ||
                  (current.settledAt !== null &&
                    !Equal.equals(current.updatedAt, owner.thread.updatedAt)) ||
                  !Equal.equals(current.settledAt, owner.thread.settledAt) ||
                  current.worktreePath !== owner.thread.worktreePath ||
                  storageCleanupActivityAt(current) !==
                    storageCleanupActivityAt(owner.thread as OrchestrationV2ThreadShell)
                );
              })
            )
              return "thread activity or shared worktree changed since check";
          }
          for (const owner of owners) {
            if (yield* hasPendingWorkspaceWork(owner.thread.id))
              return "thread has pending workspace work";
            if ("workspaceRoot" in owner.thread) {
              const pending = yield* sql`
                SELECT 1 FROM orchestration_v2_effect_outbox
                WHERE thread_id = ${owner.thread.id} AND status NOT IN ('succeeded', 'cancelled') LIMIT 1
              `;
              if (pending.length > 0) return "thread deletion is still pending";
            }
            if (yield* hasLiveProviderSession(worktreePath, owner.thread.id))
              return "provider session is still open";
            if (hasTerminal(owner.recordedPath)) return "open terminal";
            if ((yield* canonicalWorkspacePath(owner.recordedPath)) !== worktreePath)
              return "worktree location changed";
          }
          const consumer = yield* WorktreeConsumers.worktreeConsumerReason(worktreePath);
          if (consumer !== null) return consumer;
          return null;
        });
        const blocked = yield* blockedSinceCheck();
        if (blocked !== null) return keep(blocked);
        const bytes = yield* measureWorktree(worktreePath);
        const blockedWhileMeasuring = yield* blockedSinceCheck();
        if (blockedWhileMeasuring !== null) return keep(blockedWhileMeasuring);
        if (yield* branchChanged(worktreePath, thread.branch))
          return keep("repository or branch changed since check");
        if (
          (yield* git.resolveCommit({ cwd: worktreePath, revision: "HEAD" })).commitSha !==
          head.commitSha
        )
          return keep("commit changed since check");
        const finalChanges = yield* localChangesReason(worktreePath);
        if (finalChanges !== null) return keep(finalChanges);
        const current = resolveWorktreeCleanup(
          yield* settingsService.getSettings,
          thread.projectId,
        );
        if (
          Object.keys(settings).some(
            (key) =>
              current[key as keyof typeof settings] !== settings[key as keyof typeof settings],
          )
        )
          return keep("settings changed since check");
        const submodules = yield* submoduleRemoval(worktreePath);
        if (submodules.reason !== null) return keep(submodules.reason);
        if (!(yield* sameRepository())) return keep("repository and project mapping changed");
        const finalBlocked = yield* blockedSinceCheck();
        if (finalBlocked !== null) return keep(finalBlocked);
        const finalFiles = yield* localChangesReason(worktreePath);
        if (finalFiles !== null) return keep(finalFiles);
        // Read settings after all awaited guards, including every shared owner.
        if (!policiesUnchanged(yield* settingsService.getSettings))
          return keep("settings changed since check");
        // Ordinary removals let Git reject late changes. Submodules require force
        // after the recursive history and file checks; unknown files are never cleaned.
        yield* cleanupGit(
          project.workspaceRoot,
          [
            "-c",
            "status.showUntrackedFiles=normal",
            "worktree",
            "remove",
            // Git requires force for submodules; recursive checks above cannot make removal atomic.
            ...(submodules.force ? ["--force"] : []),
            "--",
            worktreePath,
          ],
          "git worktree remove",
        );
        entries.push({ ...entry, outcome: "removed", reason: sentence(removalReason), bytes });
        yield* gitManager.invalidateStatus(project.workspaceRoot);
        // Preserve branch and path: ProviderTurnStartService recreates the checkout
        // from that branch when the thread is resumed.
        yield* Effect.logInfo("storage cleanup removed worktree", { threadId: thread.id });
      }).pipe(
        (effect) =>
          [...new Set([worktreePath, ...owners.map((owner) => owner.recordedPath)])]
            .sort()
            .reduceRight((leased, cwd) => withWorkspaceLease(cwd, leased), effect),
        Effect.catch((error) =>
          Effect.gen(function* () {
            entries.push({
              ...entry,
              outcome: "failed",
              reason: cleanupFailureReason(error),
            });
            yield* Effect.logWarning("storage cleanup failed for worktree", {
              threadId: thread.id,
              error,
            });
          }),
        ),
      );
      for (const decision of entries.slice(decisionStart))
        yield* audit({ event: "worktree-decision", runId, ...decision });
    }
  });

  const reportUnownedWorktrees = Effect.fn("StorageCleanup.reportUnownedWorktrees")(function* (
    entries: CleanupWorkingEntry[],
    runId: string,
  ) {
    const seenWorktrees = new Set<string>();
    const worktrees: string[] = [];
    const managedRoots: string[] = [];
    const recordInventoryFailure = Effect.fn("StorageCleanup.recordInventoryFailure")(function* (
      failedPath: string,
      error: { readonly message: string },
    ) {
      const entry: CleanupWorkingEntry = {
        kind: "worktree",
        outcome: "failed",
        reason: cleanupFailureReason(error),
        path: failedPath,
        projectPath: null,
        threadId: null,
        threadTitle: null,
        bytes: null,
        files: null,
      };
      entries.push(entry);
      yield* audit({ event: "worktree-inventory-failed", runId, ...entry });
      yield* Effect.logWarning("could not inspect registered worktrees for cleanup audit", {
        error: entry.reason,
      });
    });
    const captureInventory = <A, E>(effect: Effect.Effect<A, E>) =>
      effect.pipe(
        Effect.map((value) => ({ value })),
        Effect.catch((error) => Effect.succeed({ error })),
      );
    for (const directory of managedWorktreesDirectories(
      yield* settingsService.getSettings,
      config.worktreesDir,
      path,
      yield* HostProcess.HomeDirectory,
    )) {
      const exists = yield* captureInventory(fs.exists(directory));
      if ("error" in exists) {
        yield* recordInventoryFailure(directory, exists.error);
        continue;
      }
      if (!exists.value) continue;
      const resolvedRoot = yield* captureInventory(fs.realPath(directory));
      if ("error" in resolvedRoot) {
        yield* recordInventoryFailure(directory, resolvedRoot.error);
        continue;
      }
      const root = resolvedRoot.value;
      if (root !== null && !isFilesystemRoot(root, path)) managedRoots.push(root);
    }
    if (managedRoots.length === 0) return;
    const seenProjectRoots = new Set<string>();
    const seenRepositories = new Set<string>();
    for (const project of yield* projectStore.listShells()) {
      const root = path.resolve(project.workspaceRoot);
      if (seenProjectRoots.has(root)) continue;
      seenProjectRoots.add(root);
      const identity = yield* captureInventory(
        git.execute({
          operation: "StorageCleanup.inventoryRepository",
          cwd: root,
          args: ["rev-parse", "--git-common-dir"],
          env: { LC_ALL: "C" },
          allowNonZeroExit: true,
          timeoutMs: 5_000,
          maxOutputBytes: 4_096,
        }),
      );
      if ("error" in identity) {
        yield* recordInventoryFailure(root, identity.error);
        continue;
      }
      const result = identity.value;
      if (result.exitCode !== 0) {
        if (result.stderr.toLowerCase().includes("not a git repository")) continue;
        yield* recordInventoryFailure(
          root,
          new GitCommandError({
            operation: "StorageCleanup.inventoryRepository",
            command: "git rev-parse --git-common-dir",
            cwd: root,
            detail: result.stderr.trim().split(/\r?\n/)[0] || `exited ${result.exitCode}`,
          }),
        );
        continue;
      }
      const commonDir = result.stdout.trim();
      if (result.stdoutTruncated || commonDir === "" || commonDir.includes("\n")) {
        yield* recordInventoryFailure(
          root,
          new GitCommandError({
            operation: "StorageCleanup.inventoryRepository",
            command: "git rev-parse --git-common-dir",
            cwd: root,
            detail: result.stdoutTruncated
              ? "successful Git identity output was truncated"
              : "successful Git identity output was empty or malformed",
          }),
        );
        continue;
      }
      const repositoryResult = yield* captureInventory(fs.realPath(path.resolve(root, commonDir)));
      if ("error" in repositoryResult) {
        yield* recordInventoryFailure(root, repositoryResult.error);
        continue;
      }
      const repository = repositoryResult.value;
      if (repository === null || seenRepositories.has(repository)) continue;
      seenRepositories.add(repository);
      const paths = yield* git.listWorktreePaths(root).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            yield* recordInventoryFailure(root, error);
            return [] as string[];
          }),
        ),
      );
      for (const candidate of paths) {
        const worktreePath = path.resolve(candidate);
        if (!managedRoots.some((managedRoot) => inside(managedRoot, worktreePath))) continue;
        if (seenWorktrees.has(worktreePath)) continue;
        seenWorktrees.add(worktreePath);
        worktrees.push(worktreePath);
      }
    }

    // Inventory may take long enough for thread ownership to change. Capture it
    // afterward, and defer labels if ownership moves while alias paths resolve.
    const ownershipSequence = yield* readApplicationSequence();
    const snapshot = yield* readThreads();
    const deleted = yield* readDeletedDependencyCandidates();
    const recordedPaths = yield* sql<{ worktreePath: string }>`
      SELECT DISTINCT json_extract(payload_json, '$.worktreePath') AS "worktreePath"
      FROM orchestration_v2_projection_threads
      WHERE json_extract(payload_json, '$.worktreePath') IS NOT NULL
    `.pipe(NodeSqliteClient.readOnly);
    const owned = new Set<string>();
    for (const thread of [...snapshot.threads, ...deleted, ...recordedPaths]) {
      if (thread.worktreePath === null) continue;
      const worktreePath = path.resolve(thread.worktreePath);
      const canonicalPath = yield* fs
        .realPath(worktreePath)
        .pipe(Effect.orElseSucceed(() => worktreePath));
      owned.add(canonicalPath);
    }
    if (yield* ownershipChangedSince(ownershipSequence)) {
      yield* audit({
        event: "unowned-worktree-inventory-deferred",
        runId,
        reason: "thread ownership changed while resolving known worktree paths",
        candidateCount: worktrees.length,
      });
      return;
    }
    const orphanStart = entries.length;
    yield* reportOrphanWorktrees(
      managedRoots,
      yield* projectStore.list({ includeDeleted: true }),
      entries,
    );
    for (const worktreePath of worktrees) {
      if (owned.has(worktreePath)) continue;
      const measured = entries.slice(orphanStart).find((entry) => entry.path === worktreePath);
      const entry: CleanupWorkingEntry = measured ?? {
        kind: "worktree",
        outcome: "kept",
        reason: "No owning thread; retained for review",
        path: worktreePath,
        projectPath: null,
        threadId: null,
        threadTitle: null,
        bytes: null,
        files: null,
      };
      if (measured === undefined) entries.push(entry);
      yield* audit({ event: "unowned-worktree", runId, ...entry });
    }
  });

  const cleanFiles = Effect.fn("StorageCleanup.cleanFiles")(function* (
    root: string,
    days: number | null,
    now: number,
    rotatedLogs: boolean,
    removed: { files: number; bytes: number },
  ) {
    if (days === null || !(yield* fs.exists(root))) return removed;
    const realRoot = yield* fs.realPath(root);
    if (realRoot !== path.resolve(root)) return removed;
    const visit = Effect.fn("StorageCleanup.visitFiles")(function* (
      directory: string,
    ): Effect.fn.Return<void, PlatformError | ServerSettingsError> {
      for (const name of yield* fs.readDirectory(directory)) {
        const target = path.join(directory, name);
        if ((yield* fs.realPath(target)) !== target || !inside(realRoot, target)) continue;
        const stat = yield* fs.stat(target);
        if (stat.type === "Directory" && rotatedLogs) {
          yield* visit(target);
        } else if (stat.type === "File" && (!rotatedLogs || /\.(?:log|ndjson)\.\d+$/.test(name))) {
          const modified = Option.getOrNull(stat.mtime);
          if (modified !== null && modified.getTime() < now - days * DAY_MS) {
            const current = (yield* settingsService.getSettings).storageCleanup;
            if ((rotatedLogs ? current.logsAfterDays : current.browserArtifactsAfterDays) !== days)
              return;
            yield* fs.remove(target);
            removed.files++;
            removed.bytes += Number(stat.size);
          }
        }
      }
    });
    yield* visit(realRoot);
    return removed;
  });

  const reportRef = yield* SubscriptionRef.make<StorageCleanupReport | null>(null);
  let sweepSequence = 0;
  const sweep = Effect.fn("StorageCleanup.sweep")(function* (
    trigger: StorageCleanupReport["trigger"],
  ) {
    const now = yield* Clock.currentTimeMillis;
    const serverSettings = yield* settingsService.getSettings;
    const settings = serverSettings.storageCleanup;
    const runId = `${now}-${++sweepSequence}`;
    const entries: CleanupWorkingEntry[] = [];
    // One lazy observation for both resource passes; retain the original array's
    // native identity metadata. Final removal scans remain independent and fresh.
    const observationProcessPaths = yield* Effect.cached(processPaths);
    const observationTargets = WorktreeConsumers.createTargetObservation();
    yield* audit({
      event: "sweep-start",
      runId,
      trigger,
      startedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
      settings,
    });
    yield* cleanDisposableOutputs(
      serverSettings,
      now,
      entries,
      "dependencies",
      observationProcessPaths,
      observationTargets,
    ).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          const entry: CleanupWorkingEntry = {
            kind: "worktree",
            worktreeResource: "dependencies",
            outcome: "failed",
            reason: cleanupFailureReason(error),
            path: null,
            projectPath: null,
            threadId: null,
            threadTitle: null,
            bytes: null,
            files: null,
          };
          entries.push(entry);
          yield* audit({ event: "dependency-cleanup-failed", runId, ...entry });
          yield* Effect.logWarning("dependency cleanup failed", { error });
        }),
      ),
    );
    yield* cleanDisposableOutputs(
      serverSettings,
      now,
      entries,
      "generated-builds",
      observationProcessPaths,
      observationTargets,
    ).pipe(
      Effect.catch((error) =>
        Effect.sync(() =>
          entries.push({
            kind: "worktree",
            worktreeResource: "generated-builds",
            outcome: "failed",
            reason: cleanupFailureReason(error),
            path: null,
            projectPath: null,
            threadId: null,
            threadTitle: null,
            bytes: null,
            files: null,
          }),
        ),
      ),
    );
    yield* cleanWorktrees(serverSettings, now, entries, runId).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          const entry: CleanupWorkingEntry = {
            kind: "worktree",
            outcome: "failed",
            reason: cleanupFailureReason(error),
            path: null,
            projectPath: null,
            threadId: null,
            threadTitle: null,
            bytes: null,
            files: null,
          };
          entries.push(entry);
          yield* audit({ event: "worktree-cleanup-failed", runId, ...entry });
          yield* Effect.logWarning("worktree cleanup failed", { error });
        }),
      ),
    );
    if (
      trigger === "manual" ||
      anyWorktreePolicy(
        serverSettings,
        (rules) => worktreeCleanupEnabled(rules) || dependencyCleanupEnabled(rules),
      )
    ) {
      yield* reportUnownedWorktrees(entries, runId).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            const entry: CleanupWorkingEntry = {
              kind: "worktree",
              outcome: "failed",
              reason: cleanupFailureReason(error),
              path: null,
              projectPath: null,
              threadId: null,
              threadTitle: null,
              bytes: null,
              files: null,
            };
            entries.push(entry);
            yield* audit({ event: "worktree-ownership-audit-failed", runId, ...entry });
            yield* Effect.logWarning("worktree ownership audit failed", { error });
          }),
        ),
      );
    }
    for (const category of [
      {
        kind: "browser-artifacts" as const,
        root: config.browserArtifactsDir,
        days: settings.browserArtifactsAfterDays,
        label: "browser artifacts",
      },
      {
        kind: "logs" as const,
        root: config.logsDir,
        days: settings.logsAfterDays,
        label: "rotated logs",
      },
    ]) {
      if (category.days === null) continue;
      const removed = { files: 0, bytes: 0 };
      yield* cleanFiles(category.root, category.days, now, category.kind === "logs", removed).pipe(
        Effect.map(({ files, bytes }) =>
          entries.push({
            kind: category.kind,
            outcome: files > 0 ? "removed" : "kept",
            reason: files === 0 ? "No expired files" : `Removed ${files} ${category.label}`,
            path: null,
            projectPath: null,
            threadId: null,
            threadTitle: null,
            bytes: files > 0 ? bytes : null,
            files: files > 0 ? files : null,
          }),
        ),
        Effect.catch((error) =>
          Effect.gen(function* () {
            const entry: CleanupWorkingEntry = {
              kind: category.kind,
              outcome: "failed",
              reason: cleanupFailureReason(error),
              path: null,
              projectPath: null,
              threadId: null,
              threadTitle: null,
              bytes: removed.files > 0 ? removed.bytes : null,
              files: removed.files > 0 ? removed.files : null,
            };
            entries.push(entry);
            yield* audit({ event: "file-cleanup-failed", runId, ...entry });
            yield* Effect.logWarning("storage file cleanup failed", { kind: category.kind, error });
          }),
        ),
      );
    }
    const counts = { removed: 0, kept: 0, failed: 0 };
    let bytesFreed = 0;
    for (const entry of entries) {
      // Keep the original report kind vocabulary. Older clients ignore the open
      // detail field and still receive an explicit description of the resource.
      if (entry.worktreeResource === "dependencies") entry.reason = `Dependencies: ${entry.reason}`;
      if (entry.worktreeResource === "generated-builds")
        entry.reason = `Build outputs: ${entry.reason}`;
      if (
        entry.worktreeResource === "dependencies" ||
        entry.worktreeResource === "generated-builds"
      ) {
        yield* audit({
          event: "candidate",
          runId,
          ...entry,
          estimatedReclaimedBytes: dependencyEstimates.get(entry) ?? entry.bytes,
        });
      }
      counts[entry.outcome]++;
      if (entry.outcome !== "kept") bytesFreed += entry.bytes ?? 0;
    }
    const priority = (entry: StorageCleanupReportEntry) =>
      entry.outcome === "failed"
        ? 0
        : entry.outcome === "removed"
          ? 1
          : entry.kind === "worktree" &&
              entry.worktreeResource === undefined &&
              entry.threadId === null
            ? 2
            : 3;
    const latestReport: StorageCleanupReport = {
      trigger,
      startedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
      finishedAt: DateTime.formatIso(yield* DateTime.now),
      entries: entries.sort((a, b) => priority(a) - priority(b)).slice(0, REPORT_ENTRY_LIMIT),
      counts,
      bytesFreed,
      omittedCount: Math.max(0, entries.length - REPORT_ENTRY_LIMIT),
    };
    yield* audit({
      event: "sweep-finish",
      runId,
      trigger,
      startedAt: latestReport.startedAt,
      finishedAt: latestReport.finishedAt,
      counts,
      bytesFreed,
      omittedCount: latestReport.omittedCount,
    });
    yield* SubscriptionRef.set(reportRef, latestReport);
    return latestReport;
  });
  const automaticSweepQueued = yield* Ref.make(false);
  const worker = yield* makeDrainableWorker(
    (completion: Deferred.Deferred<StorageCleanupReport, ServerSettingsError> | undefined) =>
      (completion === undefined ? Ref.set(automaticSweepQueued, false) : Effect.void).pipe(
        Effect.andThen(sweep(completion === undefined ? "automatic" : "manual")),
        Effect.exit,
        Effect.flatMap((exit) =>
          completion === undefined
            ? exit.pipe(
                Effect.asVoid,
                Effect.catchCause((cause) =>
                  Effect.logWarning("storage cleanup failed", { cause }),
                ),
              )
            : Deferred.done(completion, exit).pipe(Effect.asVoid),
        ),
      ),
  );
  const requestSweep = Ref.getAndSet(automaticSweepQueued, true).pipe(
    Effect.flatMap((queued) => (queued ? Effect.void : worker.enqueue(undefined))),
  );
  const runNow = Effect.gen(function* () {
    const completion = yield* Deferred.make<StorageCleanupReport, ServerSettingsError>();
    yield* worker.enqueue(completion);
    return yield* Deferred.await(completion);
  });

  const reviewBuilds = Effect.fn("StorageCleanup.reviewBuilds")(function* (
    input: BuildReviewRequest["input"],
  ) {
    const now = yield* Clock.currentTimeMillis;
    const review: BuildReviewRequest = { input, candidates: [] };
    const entries: CleanupWorkingEntry[] = [];
    yield* cleanDisposableOutputs(
      yield* settingsService.getSettings,
      now,
      entries,
      "generated-builds",
      processPaths,
      WorktreeConsumers.createTargetObservation(),
      review,
    );
    const targets = review.candidates.map(({ target, entry }) => ({
      ...target,
      protectedReason: target.protectedReason === null ? null : entry.reason,
    }));
    if (!("targetId" in input)) return { targets, result: review.result };
    if (!review.result) {
      const target = targets.find((candidate) => candidate.id === input.targetId);
      return yield* new BuildReviewError({
        message:
          target?.protectedReason ??
          "This build target changed or is no longer available. Refresh the target list.",
      });
    }
    return { targets, result: review.result };
  });
  const mapReviewError = (cause: unknown) =>
    isBuildReviewError(cause)
      ? cause
      : new BuildReviewError({
          message:
            "Build review could not verify current files, activity, or workspace ownership. Refresh and try again.",
        });
  const buildReviewTargets = (input: BuildReviewTargetsInput) =>
    reviewBuilds(input).pipe(
      Effect.map(({ targets }) => targets),
      Effect.mapError(mapReviewError),
    );
  const previewBuildReview = (input: BuildReviewPreviewInput) =>
    reviewBuilds(input).pipe(
      Effect.flatMap(({ result }) =>
        result && "files" in result
          ? Effect.succeed(result)
          : Effect.fail(new BuildReviewError({ message: "Build preview is unavailable." })),
      ),
      Effect.mapError(mapReviewError),
    );
  const selectBuildReview = (input: BuildReviewSelectInput) =>
    reviewBuilds(input).pipe(
      Effect.flatMap(({ result }) =>
        result && "selectedCount" in result
          ? Effect.succeed(result)
          : Effect.fail(new BuildReviewError({ message: "Build selection could not be saved." })),
      ),
      Effect.mapError(mapReviewError),
    );

  const start = Effect.fn("StorageCleanup.start")(function* () {
    const unsubscribe = yield* terminals.subscribeMetadata((event) =>
      Effect.sync(() => {
        if (event.type === "snapshot") {
          liveTerminals.clear();
          for (const terminal of event.terminals) noteTerminal(terminal);
        } else if (event.type === "upsert") {
          noteTerminal(event.terminal);
        } else {
          const threadTerminals = liveTerminals.get(event.threadId);
          threadTerminals?.delete(event.terminalId);
          if (threadTerminals?.size === 0) liveTerminals.delete(event.threadId);
        }
      }),
    );
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
    const changes = yield* settingsService.subscribeChanges;
    const events = engine.streamDomainEvents;
    let lastSettings = yield* settingsService.getSettings.pipe(Effect.orDie);
    yield* forkParked(
      requestSweep.pipe(
        Effect.andThen(worker.drain),
        Effect.repeat(Schedule.spaced("1 hour")),
        Effect.asVoid,
      ),
    );
    yield* forkParked(
      Stream.runForEach(changes, (settings) => {
        if (
          Equal.equals(settings.storageCleanup, lastSettings.storageCleanup) &&
          Equal.equals(settings.worktreeCleanup, lastSettings.worktreeCleanup) &&
          sameProjectWorktreePolicies(settings, lastSettings)
        )
          return Effect.void;
        lastSettings = settings;
        return requestSweep;
      }),
    );
    yield* forkParked(
      Stream.runForEach(events, (event) =>
        (event.type === "thread.deleted" ||
          (event.type === "provider-session.updated" &&
            (event.payload.status === "stopped" || event.payload.status === "error"))) &&
        anyWorktreePolicy(
          lastSettings,
          (rules) => rules.worktreeOnDelete || dependencyCleanupEnabled(rules),
        )
          ? requestSweep
          : Effect.void,
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Storage cleanup event stream failed", { cause }),
        ),
      ),
    );
  });
  yield* start();
  return StorageCleanup.of({
    buildReviewTargets,
    previewBuildReview,
    selectBuildReview,
    runNow,
    latestReport: SubscriptionRef.get(reportRef),
    reports: SubscriptionRef.changes(reportRef),
    drain: worker.drain,
  });
});

export const layer = Layer.effect(StorageCleanup, make);
