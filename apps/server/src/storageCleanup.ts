import {
  GitCommandError,
  OrchestrationV2AppThreadJson,
  OrchestrationV2ProviderSessionJson,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type {
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
import type { PlatformError } from "effect/PlatformError";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerConfig from "./config.ts";
import * as GitManager from "./git/GitManager.ts";
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
import * as GeneratedDependencies from "./workspace/GeneratedDependencies.ts";

const decodeCleanupThread = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2AppThreadJson),
);
const decodeCleanupSession = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ProviderSessionJson),
);
const encodeAuditRecord = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const DAY_MS = 86_400_000;

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const REPORT_ENTRY_LIMIT = 200;
const isGitCommandError = Schema.is(GitCommandError);

function cleanupFailureReason(error: { readonly message: string }) {
  return isGitCommandError(error)
    ? `${error.command}: ${error.detail.split(/\r?\n/)[0]}${error.reason ? ` (${error.reason})` : ""}`
    : (error.message.split(/\r?\n/)[0] ?? error.message);
}

const worktreeCleanupEnabled = (rules: WorktreeCleanupRules) =>
  rules.worktreeAfterDays !== null ||
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

/** Live sessions keep their cwd even when no turn is currently running. */
export function storageCleanupThreadIdle(thread: OrchestrationV2ThreadShell, now: number): boolean {
  return (
    thread.branch !== null &&
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

export class StorageCleanup extends Context.Service<
  StorageCleanup,
  {
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
  const liveTerminals = new Map<string, Map<string, TerminalSummary>>();
  const noteTerminal = (terminal: TerminalSummary) => {
    const threadTerminals =
      liveTerminals.get(terminal.threadId) ?? new Map<string, TerminalSummary>();
    threadTerminals.set(terminal.terminalId, terminal);
    liveTerminals.set(terminal.threadId, threadTerminals);
  };

  const inside = (root: string, target: string) => {
    const relative = path.relative(root, target);
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

  const measureWorktree = (worktreePath: string) =>
    Effect.gen(function* () {
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
        if (stat.type === "File") bytes += Number(stat.size);
        else if (stat.type === "Directory") {
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
    }).pipe(
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

  const readThreads = Effect.fn("StorageCleanup.readThreads")(function* () {
    const snapshot = yield* projections.getShellSnapshot();
    const projects = yield* projectStore.listShells();
    return {
      projects,
      threads: [...snapshot.threads, ...snapshot.archivedThreads],
    };
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
      if (projectPath === worktreePath || inside(worktreePath, projectPath)) return true;
      const realPath = yield* fs
        .realPath(projectPath)
        .pipe(Effect.orElseSucceed(() => projectPath));
      if (realPath === worktreePath || inside(worktreePath, realPath)) return true;
    }
    return false;
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
    // Another Git process is writing to this checkout.
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
    // Status output writes a detached HEAD as "(detached)", so a branch named
    // with a leading "(" has always been read as one.
    return (name?.startsWith("(") ? null : name) !== branch;
  });

  const localChangesReason = Effect.fn("StorageCleanup.localChangesReason")(function* (
    cwd: string,
    rules: WorktreeCleanupRules,
  ) {
    const status = yield* git.execute({
      operation: "StorageCleanup.localChanges",
      cwd,
      args: [
        "status",
        "--porcelain=v1",
        "-z",
        "--ignore-submodules=none",
        rules.worktreeKeepWhen === "tracked-changes"
          ? "--untracked-files=no"
          : "--untracked-files=all",
      ],
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
    if (rules.worktreeKeepWhen !== "any-local-files") return null;
    const ignored = yield* git.execute({
      operation: "StorageCleanup.ignoredFiles",
      cwd,
      args: ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
      maxOutputBytes: 64 * 1024,
    });
    if (ignored.stdoutTruncated) return "ignored files exceed the inspection limit";
    const file = ignored.stdout
      .split("\0")
      .find((entry) => entry !== "" && !/(^|\/)node_modules\/$/.test(entry));
    return file === undefined ? null : `has ignored files (${file})`;
  });

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
    const roots: string[] = [];
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
  ) {
    // Thread-core payloads and project events can change workspace ownership.
    // Read only events after the batch; unrelated streaming output is safe to ignore.
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
  const cleanDependencies = Effect.fn("StorageCleanup.cleanDependencies")(function* (
    serverSettings: ServerSettings,
    now: number,
    entries: StorageCleanupReportEntry[],
  ) {
    if (!anyWorktreePolicy(serverSettings, dependencyCleanupEnabled)) {
      entries.push({
        kind: "worktree",
        worktreeResource: "dependencies",
        outcome: "kept",
        reason: "Dependency cleanup policy is disabled",
        path: null,
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
    const processCwds = yield* dependencies.processWorkingDirectories.pipe(
      Effect.flatMap((cwds) =>
        cwds === null ? Effect.succeed(null) : Effect.forEach(cwds, canonicalWorkspacePath),
      ),
    );
    const hasLiveProviderSession = yield* makeProviderSessionGuard();
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
        owner.worktreePath === null ||
        resolveWorktreeCleanup(serverSettings, owner.projectId).worktreeDependenciesAfterDays ===
          null ||
        !(yield* fs.exists(path.join(cwd, "node_modules")))
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
      const activity = yield* dependencies
        .observe(
          { managedWorktreesRoot: root, worktreePath: cwd, repositoryRoot: project.workspaceRoot },
          now,
          protectedReason !== null,
        )
        .pipe(Effect.orElseSucceed(() => null));
      dependencyActivityByPath.set(
        cwd,
        activity === null ? null : { ...activity, protectedReason },
      );
    }
    const reports = new Map<string, StorageCleanupReportEntry>();
    const noteCandidate = (
      thread: Pick<OrchestrationV2ThreadShell, "id" | "title">,
      worktreePath: string,
    ) => {
      const entry: StorageCleanupReportEntry = {
        kind: "worktree",
        worktreeResource: "dependencies",
        outcome: "kept",
        reason: "A final safety check prevented dependency removal",
        path: path.join(worktreePath, "node_modules"),
        threadId: thread.id,
        threadTitle: thread.title,
        bytes: null,
        files: null,
      };
      entries.push(entry);
      reports.set(worktreePath, entry);
      return entry;
    };
    // Report old installs that share a worktree, without making them eligible.
    for (const cwd of new Set([...groups.keys(), ...deletedGroups.keys()])) {
      const owners = [...(groups.get(cwd) ?? []), ...(deletedGroups.get(cwd) ?? [])];
      if (owners.length <= 1) continue;
      const oldOwner = owners.find((thread) => {
        const days = resolveWorktreeCleanup(
          serverSettings,
          thread.projectId,
        ).worktreeDependenciesAfterDays;
        const activityAt =
          "dependencyActivityAt" in thread
            ? thread.dependencyActivityAt
            : storageCleanupActivityAt(thread);
        return days !== null && activityAt !== null && activityAt < now - days * DAY_MS;
      });
      if (oldOwner && (yield* fs.exists(path.join(cwd, "node_modules"))))
        Object.assign(noteCandidate(oldOwner, cwd), {
          reason: "More than one thread uses this worktree",
        });
    }
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
    const legacyExists =
      yield* sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'projection_threads'`;
    const legacyOwners =
      legacyExists.length === 0
        ? []
        : yield* sql<{ worktree_path: string | null; branch: string | null; project_id: string }>`
      SELECT worktree_path, branch, project_id FROM projection_threads
    `;
    const knownPaths = new Set([...groups.keys(), ...deletedGroups.keys()]);
    for (const owner of [
      ...historicalOwners.map((thread) => thread.worktreePath),
      ...legacyOwners.map((thread) => thread.worktree_path),
    ]) {
      if (owner !== null) knownPaths.add(yield* resolveOwnerPath(owner));
    }
    // The managed layout is root/repository/worktree. Unknown repositories never
    // receive an inactivity record or automatic deletion authority.
    for (const root of roots) {
      const pending = [{ directory: root, depth: 0 }];
      let visited = 0;
      while (pending.length > 0 && visited < 1000) {
        const { directory, depth } = pending.pop()!;
        visited++;
        if (directory !== root && (yield* fs.exists(path.join(directory, ".git")))) {
          if (
            !knownPaths.has(directory) &&
            !registeredGroups.has(directory) &&
            (yield* fs.exists(path.join(directory, "node_modules")))
          )
            entries.push({
              kind: "dependencies",
              outcome: "kept",
              reason: "Could not verify a current repository and project mapping",
              path: path.join(directory, "node_modules"),
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
          kind: "dependencies",
          outcome: "kept",
          reason: "Some dependency locations exceeded the discovery limit and were kept",
          path: root,
          threadId: null,
          threadTitle: null,
          bytes: null,
          files: null,
        });
    }
    for (const [cwd, mappings] of registeredGroups) {
      if (knownPaths.has(cwd) || !(yield* fs.exists(path.join(cwd, "node_modules")))) continue;
      const entry: StorageCleanupReportEntry = {
        kind: "dependencies",
        outcome: "kept",
        reason: "Ownerless install is not yet eligible",
        path: path.join(cwd, "node_modules"),
        threadId: null,
        threadTitle: null,
        bytes: null,
        files: null,
      };
      entries.push(entry);
      const candidate = mappings[0]!;
      const { project, branch, recordedPath } = candidate;
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
          legacyOwners.some((owner) => owner.project_id === project.id && owner.branch === branch))
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
        const observation = yield* dependencies.observe(input, now, protectedReason !== null);
        if (observation === null) return keep("No dependency install could be safely recognized");
        if (protectedReason !== null) return keep(protectedReason);
        if (observation.lastUsedAt >= now - days * DAY_MS) {
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
          if (yield* ownershipChangedSince(sequence))
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
          if (reason !== null) {
            yield* dependencies.observe(input, now, true);
            return keep(reason);
          }
          const latest = yield* dependencies.observe(input, now, false, false);
          return (
            latest !== null &&
            !latest.renewed &&
            latest.lastUsedAt === observation.lastUsedAt &&
            !(yield* ownershipChangedSince(sequence)) &&
            resolveWorktreeCleanup(yield* settingsService.getSettings, project.id)
              .worktreeDependenciesAfterDays === days
          );
        });
        if (!(yield* revalidate())) return false;
        const inspection = yield* dependencies.inspect(input);
        if (inspection === null)
          return keep("No dependency install could be safely recognized and measured");
        const canRemove = revalidate().pipe(Effect.catch(() => Effect.succeed(false)));
        const removed = yield* dependencies.removeBatch([
          { inspection, canRemove, isStillEligible: canRemove },
        ]);
        if (removed.length > 0) {
          entry.outcome = "removed";
          entry.bytes = removed[0]!.estimatedReclaimedBytes;
          entry.reason = "Removed inactive ownerless dependencies; reclaimed size is estimated";
          return true;
        }
        return keep("A final safety check prevented dependency removal");
      }).pipe(
        Effect.catch(() =>
          Effect.sync(() => keep("Could not safely verify dependency activity or ownership")),
        ),
      );
      const leasedPaths = [...new Set([cwd, recordedPath])].sort();
      yield* leasedPaths.reduceRight(
        (effect, target) => withWorkspaceLease(target, effect),
        cleanOwnerless,
      );
    }
    const ownershipChanged = yield* ownershipChangedSince(sequence);
    const candidates = [
      ...[...groups.entries()].flatMap(([cwd, group]) =>
        group.length === 1 && !deletedGroups.has(cwd) ? [group[0]!] : [],
      ),
      ...[...deletedGroups.entries()].flatMap(([cwd, group]) =>
        !groups.has(cwd) && group.length === 1 ? [group[0]!] : [],
      ),
    ];
    const eligible = (yield* Effect.forEach(candidates, (thread) =>
      Effect.gen(function* () {
        const days = resolveWorktreeCleanup(
          serverSettings,
          thread.projectId,
        ).worktreeDependenciesAfterDays;
        if (days === null || thread.worktreePath === null || thread.branch === null) return [];
        const deleted = "dependencyActivityAt" in thread;
        const activityAt = deleted ? thread.dependencyActivityAt : storageCleanupActivityAt(thread);
        if (activityAt !== null && activityAt >= now - days * DAY_MS) return [];
        const worktreePath = thread.cleanupPath;
        const recordedWorktreePath = thread.recordedWorktreePath;
        if (!(yield* fs.exists(path.join(worktreePath, "node_modules")))) return [];
        const entry = noteCandidate(thread, worktreePath);
        const keep = (reason: string) => {
          Object.assign(entry, { reason });
          return [];
        };
        if (activityAt === null) return keep("Could not verify the last thread activity");
        if (!(yield* pathIdentityUnchanged(recordedWorktreePath, worktreePath)))
          return keep("Worktree path is a symlink or its location changed");
        const managedWorktreesRoot = roots.find((root) => inside(root, worktreePath));
        if (managedWorktreesRoot === undefined)
          return keep("Worktree is outside the configured cleanup locations");
        if (ownershipChanged) return keep("Workspace ownership changed during cleanup");
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
        const dependencyActivity = dependencyActivityByPath.get(worktreePath) ?? null;
        if (dependencyActivity === null)
          return keep("No dependency install could be safely recognized");
        if (dependencyActivity.protectedReason !== null)
          return keep(dependencyActivity.protectedReason);
        if (dependencyActivity.lastUsedAt >= now - days * DAY_MS)
          return keep(
            dependencyActivity.renewed
              ? "Started a full inactivity period for this recognized install"
              : "Dependencies were prepared or used within the inactivity period",
          );
        if (yield* terminalUsesDependencies(worktreePath, recordedWorktreePath))
          return keep("A terminal is still using this worktree");
        return [
          {
            thread,
            days,
            deleted,
            activityAt,
            worktreePath,
            recordedWorktreePath,
            managedWorktreesRoot,
            project,
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
            days,
            deleted,
            activityAt,
            worktreePath,
            recordedWorktreePath,
            managedWorktreesRoot,
            project,
          }) =>
            Effect.gen(function* () {
              const entry = reports.get(worktreePath)!;
              const keep = (reason: string) => {
                Object.assign(entry, { reason });
                return false;
              };
              const candidateStillIdle = Effect.fn("StorageCleanup.dependencyCandidateStillIdle")(
                function* () {
                  const dependencyActivity = yield* dependencies.observe(
                    { managedWorktreesRoot, worktreePath, repositoryRoot: project.workspaceRoot },
                    now,
                    false,
                    false,
                  );
                  if (
                    dependencyActivity === null ||
                    dependencyActivity.renewed ||
                    dependencyActivity.lastUsedAt >= now - days * DAY_MS
                  )
                    return keep("Dependency installation or use changed during cleanup");
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
                  // Reuse normalized ownership and project roots only while no
                  // ownership event has changed them; otherwise defer to a new sweep.
                  if (yield* ownershipChangedSince(sequence))
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
                      rows[0]!.dependencyActivityAt !== activityAt
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
                    !storageCleanupThreadIdle(latest, now) ||
                    storageCleanupActivityAt(latest) !== activityAt
                  )
                    return false;
                  if (yield* hasPendingWorkspaceWork(thread.id))
                    return keep("Thread still has active or pending work");
                  return (
                    !(yield* terminalUsesDependencies(worktreePath, recordedWorktreePath)) &&
                    resolveWorktreeCleanup(yield* settingsService.getSettings, thread.projectId)
                      .worktreeDependenciesAfterDays === days &&
                    !(yield* ownershipChangedSince(sequence))
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
              const inspection = yield* dependencies.inspect({
                managedWorktreesRoot,
                worktreePath,
                repositoryRoot: project.workspaceRoot,
              });
              if (inspection === null) {
                keep("No dependency install could be safely recognized and measured");
                return null;
              }
              let eligibilitySequence: number | null = null;
              const canRemove = Effect.gen(function* () {
                eligibilitySequence = yield* readApplicationSequence();
                return yield* revalidate();
              });
              const isStillEligible = Effect.gen(function* () {
                const dependencyActivity = yield* dependencies.observe(
                  { managedWorktreesRoot, worktreePath, repositoryRoot: project.workspaceRoot },
                  now,
                  false,
                  false,
                );
                if (
                  dependencyActivity === null ||
                  dependencyActivity.renewed ||
                  dependencyActivity.lastUsedAt >= now - days * DAY_MS
                )
                  return keep("Dependency installation or use changed during cleanup");
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
                // Siblings and mount inventory may take time. Invalidate prepared
                // eligibility with indexed new events and current state, without
                // repeating Git, project-root resolution or provider-history scans.
                const changed = yield* sql`
                  SELECT 1 FROM orchestration_events
                  WHERE sequence > ${eligibilitySequence}
                    AND (aggregate_kind = 'project' OR event_type LIKE 'thread.%'
                      OR (aggregate_kind = 'thread' AND stream_id = ${thread.id}))
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
                  resolveWorktreeCleanup(yield* settingsService.getSettings, thread.projectId)
                    .worktreeDependenciesAfterDays === days
                );
              });
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
        ...new Set(group.flatMap((entry) => [entry.worktreePath, entry.recordedWorktreePath])),
      ].sort();
      yield* paths.reduceRight((effect, cwd) => withWorkspaceLease(cwd, effect), removeGroup);
    }
  });

  const cleanWorktrees = Effect.fn("StorageCleanup.cleanWorktrees")(function* (
    serverSettings: ServerSettings,
    now: number,
    entries: StorageCleanupReportEntry[],
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
    const groups = Map.groupBy(
      snapshot.threads.filter((thread) => thread.worktreePath !== null),
      (thread) => path.resolve(thread.worktreePath!),
    );
    const candidates = [
      ...[...groups.values()].map((group) => group[0]!),
      ...deletedThreads.filter((thread) => !groups.has(path.resolve(thread.worktreePath!))),
    ];
    if (candidates.length === 0) return;
    const hasLiveProviderSession = yield* makeProviderSessionGuard();
    for (const thread of candidates) {
      const settings = resolveWorktreeCleanup(serverSettings, thread.projectId);
      if (!worktreeCleanupEnabled(settings)) continue;
      const worktreePath = path.resolve(thread.worktreePath!);
      const deleted = "workspaceRoot" in thread;
      const project = deleted
        ? { workspaceRoot: thread.workspaceRoot }
        : snapshot.projects.find((entry) => entry.id === thread.projectId);
      const entry: StorageCleanupReportEntry = {
        kind: "worktree",
        outcome: "kept",
        reason: "",
        path: worktreePath,
        threadId: thread.id,
        threadTitle: thread.title,
        bytes: null,
        files: null,
      };
      const keep = (reason: string) => entries.push({ ...entry, reason: sentence(reason) });
      const decisionStart = entries.length;
      yield* Effect.gen(function* () {
        if (!(yield* fs.exists(worktreePath))) return;
        if (deleted && !settings.worktreeOnDelete) return keep("no rules apply");
        const shared = groups.get(worktreePath)?.length ?? 0;
        if (shared > 1) return keep(`shared by ${shared} threads`);
        if (project === undefined) return keep("project is unavailable");
        if (!deleted && !storageCleanupThreadIdle(thread, now))
          return keep("thread is running or has pending work");
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
        if ((yield* fs.stat(path.join(worktreePath, ".git"))).type !== "File")
          return keep("not a linked worktree");
        if (yield* branchChanged(worktreePath, thread.branch))
          return keep("repository or branch changed");
        const changes = yield* localChangesReason(worktreePath, settings);
        if (changes !== null) return keep(changes);
        const head = yield* git.resolveCommit({ cwd: worktreePath, revision: "HEAD" });
        const old =
          !deleted &&
          settings.worktreeAfterDays !== null &&
          storageCleanupActivityAt(thread) < now - settings.worktreeAfterDays * DAY_MS;
        let eligible = deleted || old;
        let removalReason = deleted
          ? "thread was deleted"
          : `inactive for ${Math.floor((now - storageCleanupActivityAt(thread)) / DAY_MS)} days`;
        if (!eligible && (settings.worktreeUnchanged || settings.worktreeOnMerge)) {
          const repositoryCwd = path.resolve(project.workspaceRoot);
          const remote = yield* git.resolvePrimaryRemoteName(repositoryCwd);
          const branch = yield* git.resolveDefaultBranchName(repositoryCwd, remote);
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
              ? `inactive for ${Math.floor((now - storageCleanupActivityAt(thread)) / DAY_MS)} of ${settings.worktreeAfterDays} days`
              : settings.worktreeOnMerge
                ? "not merged"
                : "has commits beyond the default branch",
          );
        // Threads, queued deletion work and provider sessions as they are now, so a
        // queued turn, resumed session or new thread sharing this path cancels
        // the removal.
        const blockedSinceCheck = Effect.fnUntraced(function* () {
          const latestSnapshot = yield* readThreads();
          if (yield* containsProjectRoot(worktreePath, [project, ...latestSnapshot.projects]))
            return "contains a project checkout";
          const latestPreviewLeases = yield* previewsProtectingWorktrees();
          if (previewUsesWorktree(worktreePath, latestPreviewLeases))
            return "preview is still using the worktree";
          const latest = latestSnapshot.threads.filter(
            (entry) =>
              entry.worktreePath !== null && path.resolve(entry.worktreePath) === worktreePath,
          );
          if (hasTerminal(worktreePath)) return "open terminal";
          if (deleted) {
            if (
              latest.length > 0 ||
              !resolveWorktreeCleanup(yield* settingsService.getSettings, thread.projectId)
                .worktreeOnDelete
            )
              return "thread or cleanup settings changed since check";
            // V2 deletion queues durable cleanup. Do not remove its checkout until
            // every effect has finished successfully or was explicitly cancelled.
            const pendingCleanup = yield* sql`
              SELECT 1 FROM orchestration_v2_effect_outbox
              WHERE thread_id = ${thread.id} AND status NOT IN ('succeeded', 'cancelled') LIMIT 1
            `;
            if (pendingCleanup.length > 0) return "thread deletion is still pending";
          } else if (
            latest.length !== 1 ||
            latest[0]!.id !== thread.id ||
            !storageCleanupThreadIdle(latest[0]!, now) ||
            storageCleanupActivityAt(latest[0]!) !== storageCleanupActivityAt(thread)
          )
            return "thread activity or shared worktree changed since check";
          if (yield* hasLiveProviderSession(worktreePath, thread.id))
            return "provider session is still open";
          return null;
        });
        // Most cancelled removals are caught here, before the worktree is walked.
        const blocked = yield* blockedSinceCheck();
        if (blocked !== null) return keep(blocked);
        const bytes = yield* measureWorktree(worktreePath);
        // The walk can take a while; ask again for anything that started during it.
        const blockedWhileMeasuring = yield* blockedSinceCheck();
        if (blockedWhileMeasuring !== null) return keep(blockedWhileMeasuring);
        if (yield* branchChanged(worktreePath, thread.branch))
          return keep("repository or branch changed since check");
        if (
          (yield* git.resolveCommit({ cwd: worktreePath, revision: "HEAD" })).commitSha !==
          head.commitSha
        )
          return keep("commit changed since check");
        const finalChanges = yield* localChangesReason(worktreePath, settings);
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
        if (yield* hasLiveProviderSession(worktreePath, thread.id))
          return keep("provider session is still open");
        // Clean only untracked files; Git must still refuse removal if a tracked
        // edit arrives after our last status check.
        if (settings.worktreeKeepWhen === "tracked-changes")
          yield* cleanupGit(worktreePath, ["clean", "-ffdx"], "git clean");
        yield* cleanupGit(
          project.workspaceRoot,
          ["-c", "status.showUntrackedFiles=normal", "worktree", "remove", worktreePath],
          "git worktree remove",
        );
        entries.push({ ...entry, outcome: "removed", reason: sentence(removalReason), bytes });
        yield* gitManager.invalidateStatus(project.workspaceRoot);
        // Preserve branch and path: ProviderTurnStartService recreates the checkout
        // from that branch when the thread is resumed.
        yield* Effect.logInfo("storage cleanup removed worktree", { threadId: thread.id });
      }).pipe(
        (effect) => withWorkspaceLease(worktreePath, effect),
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
    entries: StorageCleanupReportEntry[],
    runId: string,
  ) {
    const seenWorktrees = new Set<string>();
    const worktrees: string[] = [];
    const managedRoots: string[] = [];
    const recordInventoryFailure = (failedPath: string, error: { readonly message: string }) =>
      Effect.gen(function* () {
        const entry: StorageCleanupReportEntry = {
          kind: "worktree",
          outcome: "failed",
          reason: cleanupFailureReason(error),
          path: failedPath,
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
    const owned = new Set<string>();
    for (const thread of [...snapshot.threads, ...deleted]) {
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
    for (const worktreePath of worktrees) {
      if (owned.has(worktreePath)) continue;
      const entry: StorageCleanupReportEntry = {
        kind: "worktree",
        outcome: "kept",
        reason: "No owning thread; retained for review",
        path: worktreePath,
        threadId: null,
        threadTitle: null,
        bytes: null,
        files: null,
      };
      entries.push(entry);
      yield* audit({ event: "unowned-worktree", runId, ...entry });
    }
  });

  const cleanFiles = Effect.fn("StorageCleanup.cleanFiles")(function* (
    root: string,
    days: number | null,
    now: number,
    rotatedLogs: boolean,
    // Owned by the caller so files removed before a failure still count.
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
    const entries: StorageCleanupReportEntry[] = [];
    yield* audit({
      event: "sweep-start",
      runId,
      trigger,
      startedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
      settings,
    });
    yield* cleanWorktrees(serverSettings, now, entries, runId).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          const entry: StorageCleanupReportEntry = {
            kind: "worktree",
            outcome: "failed",
            reason: cleanupFailureReason(error),
            path: null,
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
    yield* cleanDependencies(serverSettings, now, entries).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          const entry: StorageCleanupReportEntry = {
            kind: "worktree",
            worktreeResource: "dependencies",
            outcome: "failed",
            reason: cleanupFailureReason(error),
            path: null,
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
    for (const entry of entries.filter((entry) => entry.worktreeResource === "dependencies")) {
      Object.assign(entry, { reason: `Dependencies: ${entry.reason}` });
      yield* audit({
        event: "candidate",
        runId,
        ...entry,
        estimatedReclaimedBytes: dependencyEstimates.get(entry) ?? entry.bytes,
      });
    }
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
            const entry: StorageCleanupReportEntry = {
              kind: "worktree",
              outcome: "failed",
              reason: cleanupFailureReason(error),
              path: null,
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
            threadId: null,
            threadTitle: null,
            bytes: files > 0 ? bytes : null,
            files: files > 0 ? files : null,
          }),
        ),
        Effect.catch((error) =>
          Effect.gen(function* () {
            const entry: StorageCleanupReportEntry = {
              kind: category.kind,
              outcome: "failed",
              reason: cleanupFailureReason(error),
              path: null,
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
      counts[entry.outcome]++;
      bytesFreed += entry.bytes ?? 0;
    }
    const priority = { failed: 0, removed: 1, kept: 2 };
    const latestReport: StorageCleanupReport = {
      trigger,
      startedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
      finishedAt: DateTime.formatIso(yield* DateTime.now),
      entries: entries
        .sort((a, b) => priority[a.outcome] - priority[b.outcome])
        .slice(0, REPORT_ENTRY_LIMIT),
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
  let sweepQueued = false;
  const worker = yield* makeDrainableWorker(
    (completion: Deferred.Deferred<StorageCleanupReport, ServerSettingsError> | undefined) =>
      Effect.suspend(() => {
        // Only automatic requests are coalesced; each manual request gets a report.
        // Clear when its queued sweep starts so changes can request one follow-up.
        if (completion === undefined) sweepQueued = false;
        return sweep(completion === undefined ? "automatic" : "manual");
      }).pipe(
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
  const runNow = Effect.gen(function* () {
    const completion = yield* Deferred.make<StorageCleanupReport, ServerSettingsError>();
    yield* worker.enqueue(completion);
    return yield* Deferred.await(completion);
  });
  const requestSweep = Effect.suspend(() => {
    if (sweepQueued) return Effect.void;
    sweepQueued = true;
    return worker.enqueue(undefined);
  }).pipe(Effect.uninterruptible);

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
    runNow,
    latestReport: SubscriptionRef.get(reportRef),
    reports: SubscriptionRef.changes(reportRef),
    drain: worker.drain,
  });
});

export const layer = Layer.effect(StorageCleanup, make);
