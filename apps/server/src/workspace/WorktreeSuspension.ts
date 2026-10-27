import {
  CommandId,
  ThreadId,
  ProjectId,
  hasOpenActionableDashboardItems,
  type WorkspaceLifecyclePreviewInput,
  type WorkspaceLifecycleRunInput,
  type WorkspaceLifecyclePreview,
  WorktreeSuspensionRequestError,
  type ListSavedWorkspacesInput,
  type PreviewWorktreeSuspensionInput,
  type SuspendWorktreeInput,
  type RestoreWorktreeInput,
  type SetKeepWorkspaceInput,
  type PreviewWorktreeDiscardInput,
  type DiscardWorktreeSnapshotsInput,
  type SavedWorkspace,
  type SavedWorkspacesPage,
  type WorktreeSuspensionPreview,
  type WorktreeDiscardPreview,
  type WorkspaceOperation,
  type WorktreeSuspensionOwner,
  type WorktreeSuspensionSummary,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import {
  createWorktreeSuspensionStore,
  WorktreeSuspensionError,
  type WorktreeSuspensionSnapshot,
} from "@t3tools/shared/worktreeSuspension";
import {
  acquireGeneratedWorktreeMutation,
  generatedBuildReviewProtection,
} from "@t3tools/shared/generatedBuildOwnership";
import { resolveWorktreeSuspension } from "@t3tools/shared/projectSettings";
import { evaluateWorktreeSuspensionEligibility } from "@t3tools/shared/worktreeSuspensionPolicy";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as CommandReceipts from "../orchestration-v2/CommandReceiptStore.ts";
import * as WorkspaceLifecycle from "./WorkspaceLifecycle.ts";
import * as ProviderSessions from "../orchestration-v2/ProviderSessionManager.ts";
import * as Cleanup from "../orchestration-v2/WorktreeCleanupService.ts";
import * as PreviewHosting from "../preview/Hosting.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { makeIsManagedWorktreePath } from "../worktreesDirectory.ts";
import { WorkspaceAcquisition, WorkspaceUnavailableError } from "./WorkspaceAcquisition.ts";
import {
  WorktreeSuspensionRegistry,
  CheckoutAuthority as CheckoutAuthoritySchema,
  type CheckoutAuthority,
} from "./WorktreeSuspensionRegistry.ts";
import * as WorktreeConsumers from "./WorktreeConsumers.ts";
import {
  withWorkspaceLease,
  registerWorkspaceLeaseRoot,
  retireWorkspaceLeaseAliases,
} from "./workspaceLease.ts";

type Input<S extends Schema.Top> = S["Type"];
type Request<A> = Effect.Effect<A, WorktreeSuspensionRequestError>;
export interface SavedWorkspaceAccess {
  readonly allowOrphans: boolean;
}

export class WorktreeSuspension extends Context.Service<
  WorktreeSuspension,
  {
    readonly list: (
      input: Input<typeof ListSavedWorkspacesInput>,
      access?: SavedWorkspaceAccess,
    ) => Request<SavedWorkspacesPage>;
    readonly previewSuspend: (
      input: Input<typeof PreviewWorktreeSuspensionInput>,
    ) => Request<WorktreeSuspensionPreview>;
    readonly suspend: (input: Input<typeof SuspendWorktreeInput>) => Request<WorkspaceOperation>;
    readonly restore: (
      input: Input<typeof RestoreWorktreeInput>,
      access?: SavedWorkspaceAccess,
    ) => Request<WorkspaceOperation>;
    readonly previewDiscard: (
      input: Input<typeof PreviewWorktreeDiscardInput>,
    ) => Request<WorktreeDiscardPreview>;
    readonly discard: (
      input: Input<typeof DiscardWorktreeSnapshotsInput>,
    ) => Request<WorkspaceOperation>;
    readonly setKeepWorkspace: (
      input: Input<typeof SetKeepWorkspaceInput>,
      access?: SavedWorkspaceAccess,
    ) => Request<WorkspaceOperation>;
    readonly createFresh: (
      input: Input<typeof PreviewWorktreeSuspensionInput>,
    ) => Request<WorkspaceOperation>;
    readonly sweep: Effect.Effect<void>;
  }
>()("t3/workspace/WorktreeSuspension") {}

const failure = (reason: WorktreeSuspensionRequestError["reason"], message: string) =>
  new WorktreeSuspensionRequestError({ reason, message });
const isRequestError = Schema.is(WorktreeSuspensionRequestError);
const isWorkspaceUnavailable = Schema.is(WorkspaceUnavailableError);
const safeFailure = (cause: unknown) =>
  isRequestError(cause)
    ? cause
    : cause instanceof WorktreeSuspensionError
      ? failure(
          "protected",
          `${cause.message}. Existing files and recovery data have been retained.`,
        )
      : failure(
          "unavailable",
          "The saved workspace could not be verified. Its files and recovery data have been retained.",
        );
const equivalentSummary = Schema.toEquivalence(
  Schema.NullOr(
    // Keep equality tied to the persisted contract rather than timestamps or thread chatter.
    Schema.Struct({
      checkoutId: Schema.String,
      generation: Schema.Number,
      state: Schema.String,
      snapshotId: Schema.NullOr(Schema.String),
      lastRestoredAt: Schema.NullOr(Schema.String),
      keepWorkspace: Schema.Boolean,
    }),
  ),
);

export const make = Effect.gen(function* () {
  const registry = yield* WorktreeSuspensionRegistry;
  const lifecycle = yield* WorkspaceLifecycle.WorkspaceLifecycle;
  const receipts = yield* CommandReceipts.CommandReceiptStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const sessions = yield* ProviderSessions.ProviderSessionManagerV2;
  const cleanup = yield* Cleanup.WorktreeCleanupService;
  const terminals = yield* TerminalManager.TerminalManager;
  const previews = yield* PreviewHosting.PreviewHosting;
  const settings = yield* ServerSettings.ServerSettingsService;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const acquisition = yield* WorkspaceAcquisition;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const scope = yield* Scope.Scope;
  const saves = yield* Semaphore.make(1);
  const isManaged = yield* makeIsManagedWorktreePath;
  const store = createWorktreeSuspensionStore({ storeRoot: path.join(registry.root, "snapshots") });
  const previewsByToken = new Map<
    string,
    { authority: CheckoutAuthority; snapshotIds?: readonly string[]; expiresAt: number }
  >();
  const lifecyclePreviews = new Map<
    string,
    {
      input: WorkspaceLifecyclePreviewInput;
      records: readonly CheckoutAuthority[];
      ids: ReadonlyMap<string, readonly string[]>;
      threadIds: readonly ThreadId[];
      projectIds: readonly string[];
      expiresAt: number;
      allowOrphans: boolean;
    }
  >();
  const liveOperations = new Map<
    string,
    { readonly completed: Deferred.Deferred<void>; started: boolean; cancelled: boolean }
  >();
  const native = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: safeFailure });
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const milliseconds = DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
  const shortBranch = (branch: string) => branch.replace(/^refs\/heads\//u, "");
  const clearOperation = (record: CheckoutAuthority): CheckoutAuthority => {
    const next = { ...record, blockedReason: null };
    delete next.operation;
    return next;
  };
  const sameAuthority = Schema.toEquivalence(CheckoutAuthoritySchema);
  const snapshotIds = (record: CheckoutAuthority) => [
    ...new Set([
      ...record.history,
      ...(record.summary.snapshotId === null ? [] : [record.summary.snapshotId]),
      ...(record.operation?.snapshotIds ?? []),
    ]),
  ];
  const canonical = (value: string) =>
    fs.realPath(value).pipe(
      Effect.catchIf(
        (cause) => cause.reason._tag === "NotFound",
        () => Effect.succeed(path.resolve(value)),
      ),
    );
  const overlaps = (a: string, b: string) => {
    const relative = path.relative(a, b);
    return (
      relative === "" ||
      (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
    );
  };
  const ownerOf = (thread: OrchestrationV2ThreadShell): WorktreeSuspensionOwner => ({
    threadId: thread.id,
    projectId: thread.projectId,
    worktreePath: thread.worktreePath!,
    branch: thread.branch,
    generation: thread.worktreeSuspension?.generation ?? null,
  });
  const ownersFor = Effect.fn("WorktreeSuspension.ownersFor")(function* (
    aliases: readonly string[],
    authority?: CheckoutAuthority,
  ) {
    if (authority?.detached) return [];
    const records = yield* projections.getThreadWorktreePaths({ includeArchived: true });
    const owners: OrchestrationV2ThreadShell[] = [];
    for (const record of records) {
      const actual = yield* canonical(record.worktreePath);
      if (!aliases.includes(actual) && !aliases.includes(record.worktreePath)) continue;
      const shell = yield* projections.getThreadShell(record.threadId);
      if (shell !== null && shell.deletedAt === null) owners.push(shell);
    }
    if (authority !== undefined) {
      for (const owner of authority.owners) {
        if (owners.some((thread) => thread.id === owner.threadId)) continue;
        const shell = yield* projections.getThreadShell(owner.threadId);
        if (
          shell !== null &&
          shell.deletedAt === null &&
          shell.worktreeSuspension?.checkoutId === authority.checkoutId
        )
          owners.push(shell);
      }
    }
    return owners;
  });
  const commonDirectory = Effect.fn("WorktreeSuspension.commonDirectory")(function* (cwd: string) {
    const result = yield* git.execute({
      operation: "suspension repository identity",
      cwd,
      args: ["rev-parse", "--git-common-dir"],
    });
    return yield* fs.realPath(path.resolve(cwd, result.stdout.trim()));
  });
  const survivingOwners = Effect.fn("WorktreeSuspension.survivingOwners")(function* (
    record: CheckoutAuthority,
  ) {
    return (yield* ownersFor(record.aliases, record)).filter(
      (thread) =>
        thread.worktreeSuspension?.checkoutId === record.checkoutId ||
        record.owners.some(
          (owner) =>
            owner.threadId === thread.id &&
            owner.generation === null &&
            thread.worktreeSuspension === undefined &&
            owner.worktreePath === thread.worktreePath &&
            owner.projectId === thread.projectId,
        ),
    );
  });
  const liveAliases = Effect.fn("WorktreeSuspension.liveAliases")(function* (
    record: CheckoutAuthority,
    destination = record.path,
  ) {
    const occupied = yield* Effect.forEach(
      record.aliases.filter(
        (alias) => alias !== destination && alias.split(path.sep).includes(".suspended-workspaces"),
      ),
      (alias) => fs.exists(alias).pipe(Effect.map((exists) => (exists ? [alias] : []))),
    );
    return [...new Set([destination, ...occupied.flat()])];
  });
  const registerPublishedRoots = Effect.fn("WorktreeSuspension.registerPublishedRoots")(function* (
    record: CheckoutAuthority,
    previousAliases: readonly string[],
  ) {
    yield* registerWorkspaceLeaseRoot(record.path, previousAliases);
    yield* retireWorkspaceLeaseAliases(
      record.path,
      previousAliases.filter((alias) => !record.aliases.includes(alias)),
    );
  });
  const identify = Effect.fn("WorktreeSuspension.identify")(function* (
    threadId: ThreadId,
    catalog?: readonly CheckoutAuthority[],
    purpose: "capture" | "activity" = "capture",
  ) {
    const thread = yield* projections.getThreadShell(threadId);
    if (thread === null || thread.deletedAt !== null || thread.worktreePath === null)
      return yield* failure("unavailable", "This thread does not own a linked worktree.");
    const existing = (catalog ?? (yield* registry.list)).find(
      (entry) =>
        entry.checkoutId === thread.worktreeSuspension?.checkoutId ||
        (!entry.detached && entry.aliases.includes(thread.worktreePath!)),
    );
    if (existing !== undefined) return existing;
    if (thread.worktreeSuspension !== undefined)
      return yield* failure(
        "protected",
        "The private recovery catalog is missing. Workspace commands are blocked to preserve recovery data.",
      );
    const actual = yield* fs.realPath(thread.worktreePath);
    if (catalog !== undefined) {
      const registered = (yield* registry.list).find(
        (entry) =>
          !entry.detached &&
          (entry.aliases.includes(actual) || entry.aliases.includes(thread.worktreePath!)),
      );
      if (registered !== undefined) return registered;
    }
    if (!(yield* isManaged(actual)))
      return yield* failure("protected", "Only managed linked worktrees can be suspended.");
    const allOwners = yield* ownersFor([actual, thread.worktreePath]);
    if (allOwners.length === 0)
      return yield* failure("changed", "The worktree no longer has a verified owner.");
    const project = yield* projects.get(thread.projectId);
    if (Option.isNone(project))
      return yield* failure("protected", "The owning project is unavailable.");
    const repositoryRoot = project.value.workspaceRoot;
    const common = yield* commonDirectory(actual);
    if (common !== (yield* commonDirectory(repositoryRoot)))
      return yield* failure("protected", "The worktree belongs to a different repository.");
    for (const candidate of yield* projects.list()) {
      if (overlaps(actual, yield* canonical(candidate.workspaceRoot)))
        return yield* failure("protected", "A registered project uses this workspace.");
    }
    const checkoutId = yield* crypto.randomUUIDv4();
    const inspected = yield* native(() =>
      purpose === "activity" ? store.inspectActiveSource(actual) : store.inspectSource(actual),
    );
    const record: CheckoutAuthority = {
      checkoutId,
      repositoryRoot,
      path: actual,
      aliases: [...new Set([actual, ...allOwners.map((owner) => owner.worktreePath!)])],
      owners: allOwners.map(ownerOf),
      history: [],
      snapshots: [],
      blockedReason: null,
      lastHead: inspected.head,
      nativeIdentity: {
        sourceIdentity: inspected.sourceIdentity,
        gitDirectory: inspected.gitDirectory,
        gitDirectoryIdentity: inspected.gitDirectoryIdentity,
        commonDirectory: inspected.commonDirectory,
        commonIdentity: inspected.commonIdentity,
      },
      recoveryThread: {
        title: thread.title,
        modelSelection: thread.modelSelection,
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
      },
      summary: {
        checkoutId,
        generation: 0,
        state: "active",
        snapshotId: null,
        lastRestoredAt: null,
        keepWorkspace: false,
      },
    };
    yield* registry.put(record, null);
    yield* registerWorkspaceLeaseRoot(record.path, record.aliases);
    return record;
  });
  const requireRecord = Effect.fn("WorktreeSuspension.requireRecord")(function* (
    checkoutId: string,
  ) {
    const record = (yield* registry.list).find((entry) => entry.checkoutId === checkoutId);
    return record ?? (yield* failure("unavailable", "The saved workspace is unavailable."));
  });
  const checkOwners = Effect.fn("WorktreeSuspension.checkOwners")(function* (
    record: CheckoutAuthority,
  ) {
    const owners = yield* ownersFor(record.aliases, record);
    if (
      owners.length !== record.owners.length ||
      owners.some((thread) => {
        const expected = record.owners.find((owner) => owner.threadId === thread.id);
        return (
          expected === undefined ||
          expected.projectId !== thread.projectId ||
          expected.worktreePath !== thread.worktreePath ||
          expected.branch !== thread.branch ||
          expected.generation !== (thread.worktreeSuspension?.generation ?? null) ||
          !equivalentSummary(
            thread.worktreeSuspension ?? null,
            expected.generation === null ? null : record.summary,
          )
        );
      })
    )
      return yield* failure(
        "changed",
        "The workspace owner set changed. Refresh before continuing.",
      );
    return owners;
  });
  const guard = Effect.fn("WorktreeSuspension.guard")(function* (
    record: CheckoutAuthority,
    physicalPath = record.path,
    automatic = false,
  ) {
    const owners = yield* checkOwners(record);
    yield* originalStillOwned(record, physicalPath);
    if (record.summary.keepWorkspace)
      return yield* failure("protected", "Keep workspace is enabled.");
    for (const owner of owners) {
      if (
        owner.activeRunId !== null ||
        owner.pendingRuntimeRequest !== null ||
        (owner.pendingBackgroundTasks?.length ?? 0) > 0 ||
        hasOpenActionableDashboardItems(owner.dashboardItems) ||
        owner.archivePending != null ||
        (owner.actionResume != null &&
          !["delivered", "disposed"].includes(owner.actionResume.delivery))
      )
        return yield* failure(
          "protected",
          "A workspace owner has unfinished work or needs attention.",
        );
      const project = yield* projects.get(owner.projectId);
      if (
        Option.isNone(project) ||
        (yield* commonDirectory(project.value.workspaceRoot)) !==
          (yield* commonDirectory(physicalPath))
      )
        return yield* failure("protected", "The owning project repository changed.");
    }
    const historical = yield* cleanup.historicalWorktreeOwners;
    for (const owner of historical) {
      if (owner.worktreePath !== null && record.aliases.includes(owner.worktreePath))
        return yield* failure("protected", "Historical workspace ownership needs review.");
    }
    const previewPaths = yield* previews.protectedWorkspacePaths();
    if (previewPaths.some((cwd) => record.aliases.some((alias) => overlaps(alias, cwd))))
      return yield* failure("protected", "A retained preview uses the workspace.");
    const runtimeOwners = yield* sessions.workspaceOwnership;
    if (
      runtimeOwners.some(
        (runtime) =>
          record.aliases.some((alias) => overlaps(alias, runtime.cwd)) ||
          runtime.threadIds.some((id) => record.owners.some((owner) => owner.threadId === id)),
      )
    )
      return yield* failure("protected", "A provider still owns the workspace.");
    const terminalMetadata = yield* terminals.refreshMetadata;
    if (
      terminalMetadata.some(
        (terminal) =>
          ["starting", "running"].includes(terminal.status) &&
          record.aliases.some((alias) => overlaps(alias, terminal.cwd)),
      )
    )
      return yield* failure("protected", "A terminal uses the workspace.");
    if (
      yield* Effect.try({
        try: () => generatedBuildReviewProtection(physicalPath),
        catch: safeFailure,
      })
    )
      return yield* failure("protected", "Reviewed generated files retain this workspace.");
    const consumer = yield* WorktreeConsumers.worktreeConsumerReason(physicalPath);
    if (consumer !== null) return yield* failure("protected", consumer);
    const latestOwners = yield* checkOwners(record);
    if (
      latestOwners.some(
        (owner) =>
          owner.activeRunId !== null ||
          owner.pendingRuntimeRequest !== null ||
          (owner.pendingBackgroundTasks?.length ?? 0) > 0 ||
          hasOpenActionableDashboardItems(owner.dashboardItems) ||
          owner.archivePending != null ||
          (owner.actionResume != null &&
            !["delivered", "disposed"].includes(owner.actionResume.delivery)),
      )
    )
      return yield* failure(
        "protected",
        "A workspace owner acquired unfinished work or attention during verification.",
      );
    if (automatic && !(yield* automaticallyEligible(record)))
      return yield* failure(
        "protected",
        "The automatic suspension policy or workspace participation changed during verification.",
      );
  });
  const reconcileDeletedOwners = Effect.fn("WorktreeSuspension.reconcileDeletedOwners")(function* (
    record: CheckoutAuthority,
  ) {
    if (record.operation === undefined && record.pendingProjection === undefined) return record;
    const candidates = [
      ...new Set(
        [...record.owners, ...(record.pendingProjection?.expectedOwners ?? [])].map(
          (owner) => owner.threadId,
        ),
      ),
    ];
    const deleted = new Set<ThreadId>();
    for (const id of candidates) {
      if ((yield* projections.getThreadShell(id)) !== null) continue;
      const row = yield* projections.getThread(id).pipe(Effect.option);
      if (Option.isSome(row) && row.value.deletedAt !== null) deleted.add(id);
    }
    if (deleted.size === 0) return record;
    // Deletion releases ownership without granting disposal consent. New command
    // IDs preserve any transition receipts recorded before the owner disappeared.
    let next: CheckoutAuthority = {
      ...record,
      owners: record.owners.filter((owner) => !deleted.has(owner.threadId)),
    };
    if (record.pendingProjection !== undefined) {
      const expectedOwners = record.pendingProjection.expectedOwners.filter(
        (owner) => !deleted.has(owner.threadId),
      );
      next = {
        ...next,
        pendingProjection: {
          ...record.pendingProjection,
          expectedOwners,
          threadId: expectedOwners[0]?.threadId ?? record.pendingProjection.threadId,
          commandId: CommandId.make(`suspension:${yield* crypto.randomUUIDv4()}`),
        },
      };
    }
    yield* registry.put(next, record);
    return next;
  });
  const finishPublication = Effect.fn("WorktreeSuspension.finishPublication")(function* (
    initial: CheckoutAuthority,
  ) {
    const pending = yield* reconcileDeletedOwners(initial);
    const transition = pending.pendingProjection;
    if (transition === undefined) return pending;
    const sharing = yield* ownersFor(pending.aliases, pending);
    const nextOwners = transition.expectedOwners.map((entry) => ({
      ...entry,
      generation: transition.next.generation,
      ...(transition.workspace === undefined
        ? {}
        : { worktreePath: transition.workspace.worktreePath, branch: transition.workspace.branch }),
    }));
    const matches = (
      expected: readonly WorktreeSuspensionOwner[],
      summary: WorktreeSuspensionSummary | null,
    ) =>
      sharing.length === expected.length &&
      sharing.every((thread) => {
        const owner = expected.find((entry) => entry.threadId === thread.id);
        return (
          owner !== undefined &&
          owner.projectId === thread.projectId &&
          owner.worktreePath === thread.worktreePath &&
          owner.branch === thread.branch &&
          owner.generation === (thread.worktreeSuspension?.generation ?? null) &&
          equivalentSummary(thread.worktreeSuspension ?? null, summary)
        );
      });
    if (!matches(nextOwners, transition.next)) {
      if (!matches(transition.expectedOwners, transition.expected))
        return yield* failure(
          "changed",
          "Workspace ownership and the saved recovery operation disagree. Files have been retained.",
        );
      yield* orchestrator.transitionWorktreeSuspension(transition);
      const after = yield* ownersFor(pending.aliases, pending);
      if (
        after.length !== nextOwners.length ||
        after.some(
          (thread) =>
            !nextOwners.some(
              (owner) =>
                owner.threadId === thread.id &&
                owner.projectId === thread.projectId &&
                owner.worktreePath === thread.worktreePath &&
                owner.branch === thread.branch &&
                equivalentSummary(thread.worktreeSuspension ?? null, transition.next),
            ),
        )
      )
        return yield* failure(
          "changed",
          "The complete workspace owner publication could not be verified.",
        );
    }
    const destination = transition.workspace?.worktreePath ?? pending.path;
    const committed = {
      ...pending,
      blockedReason: null,
      path: destination,
      aliases:
        transition.next.state === "active"
          ? yield* liveAliases(pending, destination)
          : pending.aliases,
      owners: nextOwners,
      summary: transition.next,
    };
    delete committed.pendingProjection;
    yield* registry.put(committed, pending);
    yield* registerPublishedRoots(committed, pending.aliases);
    return committed;
  });
  const publish = Effect.fn("WorktreeSuspension.publish")(function* (
    previous: CheckoutAuthority | null,
    record: CheckoutAuthority,
    next: WorktreeSuspensionSummary,
    workspace?: { worktreePath: string; branch: string | null },
  ) {
    if (record.owners.length === 0) {
      const destination = workspace?.worktreePath ?? record.path;
      const ownerless = {
        ...record,
        summary: next,
        aliases: next.state === "active" ? yield* liveAliases(record, destination) : record.aliases,
        ...(workspace === undefined ? {} : { path: workspace.worktreePath }),
      };
      yield* registry.put(ownerless, previous);
      yield* registerPublishedRoots(ownerless, record.aliases);
      return ownerless;
    }
    const aliases = [
      ...new Set([...record.aliases, ...(workspace === undefined ? [] : [workspace.worktreePath])]),
    ];
    const transition = {
      commandId: CommandId.make(`suspension:${yield* crypto.randomUUIDv4()}`),
      threadId: record.owners[0]!.threadId,
      checkoutId: record.checkoutId,
      aliases,
      expectedOwners: record.owners,
      expected: record.owners.every((owner) => owner.generation === null)
        ? null
        : (previous?.summary ?? null),
      next,
      ...(workspace === undefined ? {} : { workspace }),
    };
    const pending = { ...record, aliases, summary: next, pendingProjection: transition };
    yield* registry.put(pending, previous);
    yield* registerWorkspaceLeaseRoot(pending.path, pending.aliases);
    return yield* finishPublication(pending);
  });
  const refreshActiveOwners = Effect.fn("WorktreeSuspension.refreshActiveOwners")(function* (
    initial: CheckoutAuthority,
  ) {
    let record = initial;
    if (record.pendingProjection !== undefined) return yield* finishPublication(record);
    if (
      !["active", "suspended", "discarded"].includes(record.summary.state) ||
      record.operation !== undefined ||
      record.detached
    )
      return record;
    if (record.summary.state === "active") {
      const aliases = yield* liveAliases(record);
      if (
        aliases.length !== record.aliases.length ||
        aliases.some((alias, index) => alias !== record.aliases[index])
      ) {
        const normalized = { ...record, aliases };
        yield* registry.put(normalized, record);
        yield* registerPublishedRoots(normalized, record.aliases);
        record = normalized;
      }
    }
    const sharing = yield* ownersFor(record.aliases, record);
    const expected = record.owners.every((owner) => owner.generation === null)
      ? null
      : record.summary;
    const attached = sharing.filter((thread) =>
      equivalentSummary(thread.worktreeSuspension ?? null, expected),
    );
    let departed = false;
    for (const owner of record.owners.filter(
      (owner) => !attached.some((thread) => thread.id === owner.threadId),
    )) {
      const current = yield* projections.getThread(owner.threadId);
      if (current.deletedAt !== null) {
        departed = true;
        continue;
      }
      if (
        record.summary.state === "active" &&
        record.summary.snapshotId === null &&
        current.worktreePath !== owner.worktreePath &&
        current.worktreeSuspension?.checkoutId !== record.checkoutId
      ) {
        departed = true;
        continue;
      }
      return yield* failure(
        "changed",
        "A workspace owner changed outside an accepted active binding.",
      );
    }
    if (
      record.summary.state === "active" &&
      record.summary.snapshotId === null &&
      record.owners.length > 0 &&
      departed &&
      !attached.some((thread) => record.owners.some((owner) => owner.threadId === thread.id))
    ) {
      const detached = { ...record, owners: [], detached: true, blockedReason: null };
      yield* registry.put(detached, record);
      return detached;
    }
    if (
      attached.length !== sharing.length ||
      attached.some(
        (thread) =>
          thread.worktreePath === null ||
          (record.summary.state !== "active" &&
            (!record.owners.some((owner) => owner.threadId === thread.id) ||
              thread.worktreePath !== record.path ||
              thread.branch !==
                record.owners.find((owner) => owner.threadId === thread.id)?.branch)),
      )
    )
      return yield* failure("changed", "The shared workspace bindings need review.");
    const paths = [...new Set(attached.map((thread) => thread.worktreePath!))];
    if (paths.length > 1)
      return yield* failure("changed", "Sharing owners no longer agree on one active checkout.");
    const destination = paths[0] ?? record.path;
    let next: CheckoutAuthority = { ...record, owners: attached.map(ownerOf), blockedReason: null };
    if (record.summary.state === "active" && attached.length > 0) {
      if (destination !== record.path && !(yield* isManaged(destination)))
        return yield* failure("protected", "The rebound checkout is outside managed worktrees.");
      const info = yield* fs.stat(destination).pipe(Effect.option);
      const nativeChanged =
        Option.isSome(info) &&
        (record.nativeIdentity === undefined ||
          Number(info.value.dev) !== record.nativeIdentity.sourceIdentity.dev ||
          Option.isNone(info.value.ino) ||
          Number(info.value.ino.value) !== record.nativeIdentity.sourceIdentity.ino);
      const projectsChanged = attached.some(
        (thread) =>
          record.owners.find((owner) => owner.threadId === thread.id)?.projectId !==
          thread.projectId,
      );
      if (nativeChanged || destination !== record.path || projectsChanged) {
        const projectRows = yield* Effect.forEach(attached, (thread) =>
          projects.get(thread.projectId),
        );
        if (projectRows.some(Option.isNone))
          return yield* failure("protected", "A rebound checkout project is unavailable.");
        for (const project of projectRows)
          if (
            Option.isSome(project) &&
            record.nativeIdentity !== undefined &&
            (yield* commonDirectory(project.value.workspaceRoot)) !==
              record.nativeIdentity.commonDirectory
          )
            return yield* failure("changed", "The rebound project belongs to another repository.");
        if (Option.isSome(info)) {
          const inspected = yield* native(() => store.inspectActiveSource(destination));
          if (
            record.nativeIdentity !== undefined &&
            (inspected.commonDirectory !== record.nativeIdentity.commonDirectory ||
              inspected.commonIdentity.dev !== record.nativeIdentity.commonIdentity.dev ||
              inspected.commonIdentity.ino !== record.nativeIdentity.commonIdentity.ino)
          )
            return yield* failure(
              "changed",
              "The recreated checkout belongs to another repository.",
            );
          next = {
            ...next,
            nativeIdentity: {
              sourceIdentity: inspected.sourceIdentity,
              gitDirectory: inspected.gitDirectory,
              gitDirectoryIdentity: inspected.gitDirectoryIdentity,
              commonDirectory: inspected.commonDirectory,
              commonIdentity: inspected.commonIdentity,
            },
            lastHead: inspected.head,
          };
        }
        next = {
          ...next,
          path: destination,
          aliases: yield* liveAliases(record, destination),
          repositoryRoot:
            projectRows.find(Option.isSome)?.value.workspaceRoot ?? record.repositoryRoot,
        };
      }
    }
    if (!sameAuthority(record, next)) {
      yield* registry.put(next, record);
      yield* registerPublishedRoots(next, record.aliases);
    }
    return next;
  });
  const markBlocked = Effect.fn("WorktreeSuspension.markBlocked")(function* (
    checkoutId: string,
    reason?: WorktreeSuspensionRequestError,
  ) {
    const record = yield* requireRecord(checkoutId);
    yield* registry.put(
      {
        ...record,
        blockedReason:
          reason?.message ??
          "The operation stopped. Recovery data is retained; retry recovery before starting workspace commands.",
      },
      record,
    );
  });
  const assertFresh = Effect.fn("WorktreeSuspension.assertFresh")(function* (
    expected: CheckoutAuthority,
  ) {
    const actual = yield* requireRecord(expected.checkoutId);
    if (!sameAuthority(actual, expected))
      return yield* failure("changed", "The workspace changed. Refresh before continuing.");
    yield* checkOwners(actual);
    return actual;
  });
  const receiptFor = (
    snapshot: WorktreeSuspensionSnapshot,
    owners: readonly WorktreeSuspensionOwner[],
  ) => ({
    snapshotId: snapshot.id,
    savedAt: snapshot.createdAt,
    head: snapshot.head,
    branch: snapshot.branch,
    bytes: snapshot.savedBytes,
    fileCount: snapshot.entries.length,
    owners,
  });
  const remember = Effect.fn("WorktreeSuspension.remember")(function* (
    record: CheckoutAuthority,
    snapshot: WorktreeSuspensionSnapshot,
  ) {
    if (snapshot.ownerBinding !== record.checkoutId)
      return yield* failure("changed", "The saved copy belongs to a different checkout.");
    const next = {
      ...record,
      lastHead: snapshot.head,
      history: [...new Set([...record.history, snapshot.id])],
      snapshots: [
        ...(record.snapshots ?? []).filter((entry) => entry.snapshotId !== snapshot.id),
        receiptFor(snapshot, record.owners),
      ],
    };
    yield* registry.put(next, record);
    return next;
  });
  const restoredIdentity = Effect.fn("WorktreeSuspension.restoredIdentity")(function* (
    destination: string,
  ) {
    const inspected = yield* native(() => store.inspectSource(destination));
    return {
      sourceIdentity: inspected.sourceIdentity,
      gitDirectory: inspected.gitDirectory,
      gitDirectoryIdentity: inspected.gitDirectoryIdentity,
      commonDirectory: inspected.commonDirectory,
      commonIdentity: inspected.commonIdentity,
    };
  });
  const originalStillOwned = Effect.fn("WorktreeSuspension.originalStillOwned")(function* (
    record: CheckoutAuthority,
    physicalPath = record.path,
  ) {
    const actual = yield* restoredIdentity(physicalPath);
    const expected = record.nativeIdentity;
    if (
      expected === undefined ||
      actual.sourceIdentity.dev !== expected.sourceIdentity.dev ||
      actual.sourceIdentity.ino !== expected.sourceIdentity.ino ||
      actual.gitDirectory !== expected.gitDirectory ||
      actual.gitDirectoryIdentity.dev !== expected.gitDirectoryIdentity.dev ||
      actual.gitDirectoryIdentity.ino !== expected.gitDirectoryIdentity.ino ||
      actual.commonDirectory !== expected.commonDirectory ||
      actual.commonIdentity.dev !== expected.commonIdentity.dev ||
      actual.commonIdentity.ino !== expected.commonIdentity.ino
    )
      return yield* failure(
        "changed",
        "The original workspace identity changed. Recovery data has been retained.",
      );
  });
  const latestWorkspaceUse = (record?: CheckoutAuthority) =>
    [record?.lastWorkspaceUseAt, record?.summary.lastRestoredAt]
      .filter((value): value is string => value != null)
      .sort()
      .at(-1) ?? null;
  const automaticEligibility = (
    thread: OrchestrationV2ThreadShell,
    policy: ReturnType<typeof resolveWorktreeSuspension>,
    timestamp: number,
    lastUse: string | null,
    held: boolean,
  ) => {
    const adopted =
      thread.workspaceUserAdopted === true ||
      thread.createdBy === "user" ||
      thread.latestUserAuthoredMessageAt != null ||
      thread.subagentPromotion != null ||
      thread.settledOverride !== null ||
      thread.lineage.independent === true ||
      thread.creatorGrouping === "independent";
    return evaluateWorktreeSuspensionEligibility({
      policy,
      now: timestamp,
      candidate: {
        kind: thread.lineage.relationshipToParent === "subagent" ? "subagent" : "thread",
        agentCreatedChild:
          thread.createdBy === "agent" && thread.creatorThreadId !== undefined
            ? true
            : thread.createdBy === "user"
              ? false
              : null,
        humanParticipation: adopted ? true : thread.workspaceUserAdopted === false ? false : null,
        settledAt: thread.settledAt === null ? null : DateTime.formatIso(thread.settledAt),
        lastWorkspaceUseAt: lastUse,
        active: thread.activeRunId !== null,
        pendingWork:
          thread.pendingRuntimeRequest !== null || (thread.pendingBackgroundTasks?.length ?? 0) > 0,
        held,
      },
    });
  };
  const automaticallyEligible = Effect.fn("WorktreeSuspension.automaticallyEligible")(function* (
    record: CheckoutAuthority,
  ) {
    const currentSettings = yield* settings.getSettings;
    const timestamp = yield* milliseconds;
    const owners = yield* checkOwners(record);
    return (
      owners.length > 0 &&
      owners.every(
        (thread) =>
          automaticEligibility(
            thread,
            resolveWorktreeSuspension(currentSettings, thread.projectId),
            timestamp,
            latestWorkspaceUse(record),
            record.summary.keepWorkspace,
          ).eligible,
      )
    );
  });
  const savedEntry = Effect.fn("WorktreeSuspension.savedEntry")(function* (
    record: CheckoutAuthority,
    snapshotId: string,
  ) {
    const cached = record.snapshots?.find((entry) => entry.snapshotId === snapshotId);
    const snapshot =
      cached === undefined
        ? yield* native(() => store.read(snapshotId)).pipe(Effect.option)
        : Option.none();
    const details =
      cached ?? (Option.isSome(snapshot) ? receiptFor(snapshot.value, record.owners) : undefined);
    const owners = yield* survivingOwners(record);
    const originalOwners = details?.owners ?? record.owners;
    return {
      snapshotId,
      checkoutId: record.checkoutId,
      title: owners[0]?.title ?? record.recoveryThread?.title ?? "Saved workspace",
      path: details?.owners[0]?.worktreePath ?? record.path,
      projectIds: [...new Set(originalOwners.map((owner) => owner.projectId))],
      ownerThreadIds: originalOwners.map((owner) => owner.threadId),
      savedAt:
        details?.savedAt ??
        record.operation?.acceptedAt ??
        record.lastWorkspaceUseAt ??
        "1970-01-01T00:00:00.000Z",
      head: details?.head ?? record.lastHead ?? "unverified",
      branch: details?.branch == null ? null : shortBranch(details.branch),
      bytes: details?.bytes ?? 0,
      fileCount: details?.fileCount ?? 0,
      current: record.summary.snapshotId === snapshotId,
      orphaned: owners.length === 0,
      state: record.summary.state,
      keepWorkspace: record.summary.keepWorkspace,
      ...(record.blockedReason !== null
        ? { blockedReason: record.blockedReason }
        : details === undefined
          ? {
              blockedReason:
                "The operation stopped before a complete saved copy was verified. Existing files have been retained.",
            }
          : {}),
    } satisfies SavedWorkspace;
  });
  const selectedLifecycleDone = Effect.fn("WorktreeSuspension.selectedLifecycleDone")(function* (
    intent: NonNullable<NonNullable<CheckoutAuthority["operation"]>["lifecycle"]>,
  ) {
    const rows = yield* Effect.forEach(
      intent.threadIds,
      (id) => projections.getThread(id).pipe(Effect.option),
      { concurrency: 8 },
    );
    return rows.every(
      (row) =>
        Option.isSome(row) &&
        (intent.operation === "delete"
          ? row.value.deletedAt !== null
          : row.value.archivedAt !== null || row.value.deletedAt !== null),
    );
  });
  const lifecycleResolution = Effect.fn("WorktreeSuspension.lifecycleResolution")(function* (
    operation: NonNullable<CheckoutAuthority["operation"]>,
  ) {
    if (operation.consentCommitted === true) return "committed" as const;
    const intent = operation.lifecycle;
    if (intent === undefined) return "unknown" as const;
    let accepted = false;
    if (intent.projectId !== undefined) {
      const receipt = yield* receipts.getProjectByCommandId(intent.commandId);
      if (
        Option.isNone(receipt) ||
        receipt.value.projectId !== intent.projectId ||
        receipt.value.commandType !== "project.delete"
      )
        return "unknown" as const;
      if (receipt.value.status === "rejected") return "rejected" as const;
      accepted = true;
    } else if (intent.deleteReceipts !== undefined) {
      const outcomes = yield* Effect.forEach(
        intent.deleteReceipts,
        (binding) =>
          receipts
            .getByCommandId(binding.commandId)
            .pipe(
              Effect.map((receipt) =>
                Option.isSome(receipt) &&
                receipt.value.threadId === binding.threadId &&
                receipt.value.commandType === "thread.delete"
                  ? receipt.value.status
                  : "unknown",
              ),
            ),
        { concurrency: 8 },
      );
      if (outcomes.includes("rejected")) return "rejected" as const;
      accepted = outcomes.every((outcome) => outcome === "accepted");
    } else if (intent.target.kind === "threads") {
      const original = yield* receipts.getByCommandId(intent.commandId);
      if (
        Option.isSome(original) &&
        intent.target.threadIds.includes(original.value.threadId) &&
        original.value.commandType.startsWith(`thread.${intent.operation}`) &&
        original.value.status === "rejected"
      )
        return "rejected" as const;
      if (intent.operation === "archive") {
        const failed = yield* receipts.getByCommandId(CommandId.make(`${intent.commandId}:failed`));
        if (
          Option.isSome(failed) &&
          intent.target.threadIds.includes(failed.value.threadId) &&
          failed.value.commandType === "thread.archive.fail" &&
          failed.value.status === "accepted"
        )
          return "rejected" as const;
      }
      const receipt =
        intent.operation === "archive"
          ? yield* receipts.getByCommandId(CommandId.make(`${intent.commandId}:complete`))
          : original;
      accepted =
        Option.isSome(receipt) &&
        intent.target.threadIds.includes(receipt.value.threadId) &&
        receipt.value.commandType ===
          (intent.operation === "archive" ? "thread.archive.complete" : "thread.delete") &&
        receipt.value.status === "accepted";
    }
    if (!accepted) return "unknown" as const;
    return (yield* selectedLifecycleDone(intent)) ? ("committed" as const) : ("rejected" as const);
  });
  const cancelDiscardOperation = Effect.fn("WorktreeSuspension.cancelDiscardOperation")(function* (
    record: CheckoutAuthority,
  ) {
    if (
      record.operation?.kind !== "discard" ||
      record.operation.consentCommitted === true ||
      !["active", "suspended", "discarded"].includes(record.summary.state)
    )
      return yield* failure("protected", "Committed saved-data disposal cannot be cancelled.");
    for (const id of record.operation.snapshotIds)
      yield* native(() => store.cancelDiscardIntent(id));
    const kept = clearOperation(record);
    yield* registry.put(kept, record);
    return kept;
  });
  const finishDiscard = Effect.fn("WorktreeSuspension.finishDiscard")(function* (
    initial: CheckoutAuthority,
  ) {
    let record = initial;
    const operation = record.operation;
    if (operation?.kind !== "discard") return record;
    const resolution = yield* lifecycleResolution(operation);
    if (resolution === "rejected") return yield* cancelDiscardOperation(record);
    if (resolution !== "committed") return record;
    if (operation.consentCommitted !== true) {
      const next = { ...record, operation: { ...operation, consentCommitted: true } };
      yield* registry.put(next, record);
      record = next;
    }
    const sharing = yield* ownersFor(record.aliases, record);
    const remainingOwners = sharing.map(ownerOf);
    if (
      sharing.some(
        (thread) => !equivalentSummary(thread.worktreeSuspension ?? null, record.summary),
      )
    )
      return yield* failure("changed", "A sharing owner changed before saved-data disposal.");
    if (
      operation.lifecycle !== undefined &&
      sharing.some((thread) => !operation.lifecycle!.threadIds.includes(thread.id))
    )
      return yield* failure(
        "changed",
        "Another thread still owns this saved workspace. Its recovery data was retained.",
      );
    if (record.summary.keepWorkspace)
      return yield* failure("protected", "Keep workspace protects this saved copy.");
    if (remainingOwners.length !== record.owners.length) {
      const next = { ...record, owners: remainingOwners };
      yield* registry.put(next, record);
      record = next;
    } else yield* checkOwners(record);
    const currentSelected =
      record.summary.snapshotId !== null &&
      operation.snapshotIds.includes(record.summary.snapshotId);
    if (currentSelected && record.summary.state !== "discarding")
      record = yield* publish(record, record, { ...record.summary, state: "discarding" });
    for (const id of operation.snapshotIds) {
      let journal = yield* native(() => store.readJournal(id));
      if (journal.phase === "active" || journal.phase === "suspended")
        journal = yield* native(() => store.beginDiscard(id));
      if (journal.phase === "discard-intent") yield* native(() => store.commitDiscard(id));
      else if (journal.phase !== "discarding" && journal.phase !== "discarded")
        return yield* failure(
          "protected",
          "The saved copy is still needed by an unfinished operation.",
        );
    }
    if (currentSelected)
      record = yield* publish(record, record, {
        ...record.summary,
        state: "discarded",
        snapshotId: null,
        keepWorkspace: false,
      });
    for (const id of operation.snapshotIds)
      if ((yield* native(() => store.readJournal(id))).phase !== "discarded")
        yield* native(() => store.purgeDiscard(id));
    const finished = clearOperation({
      ...record,
      history: record.history.filter((id) => !operation.snapshotIds.includes(id)),
      snapshots: (record.snapshots ?? []).filter(
        (entry) => !operation.snapshotIds.includes(entry.snapshotId),
      ),
    });
    yield* registry.put(finished, record);
    return finished;
  });
  const cancelUnstartedRestore = Effect.fn("WorktreeSuspension.cancelUnstartedRestore")(function* (
    record: CheckoutAuthority,
  ) {
    const operation = record.operation;
    const id = operation?.snapshotIds[0];
    if (
      (operation?.kind !== "restore" && operation?.kind !== "recovery") ||
      id === undefined ||
      (operation.kind === "restore" && record.summary.state !== "restoring")
    )
      return record;
    if (
      operation.kind === "recovery" &&
      (yield* registry.list).some((entry) => entry.checkoutId === operation.id)
    )
      return record;
    const unstarted = yield* native(async () => {
      const journal = await store.readJournal(id);
      const suspended =
        journal.phase === "suspended" &&
        journal.restorePath === undefined &&
        journal.restoreIdentity === undefined &&
        journal.destinationPath === undefined;
      // Native staging records "restoring" before allocating a checkout. Active
      // metadata for another unique branch therefore predates this recovery.
      const priorCompletedRecovery =
        operation.kind === "recovery" &&
        operation.branch === `suspension/recovered-${operation.id}` &&
        journal.phase === "active" &&
        journal.branch !== `refs/heads/${operation.branch}` &&
        journal.requestedBranch !== `refs/heads/${operation.branch}`;
      if (!suspended && !priorCompletedRecovery) return false;
      await store.verify(id);
      return JSON.stringify(journal) === JSON.stringify(await store.readJournal(id));
    });
    if (!unstarted) return record;
    if (operation.kind === "recovery") {
      const kept = clearOperation(record);
      yield* registry.put(kept, record);
      return kept;
    }
    const aliases = record.aliases.filter(
      (alias) => alias === record.path || alias !== operation.destinationPath,
    );
    const suspended = yield* publish(
      record,
      clearOperation({ ...record, aliases, blockedReason: null }),
      { ...record.summary, state: "suspended" },
    );
    yield* registerPublishedRoots(suspended, record.aliases);
    return suspended;
  });
  const finishRestore = Effect.fn("WorktreeSuspension.finishRestore")(function* (
    initial: CheckoutAuthority,
  ) {
    let record = initial;
    const operation = record.operation;
    const id = operation?.snapshotIds[0];
    if (
      operation?.kind !== "restore" ||
      id === undefined ||
      operation.destinationPath === undefined
    )
      return yield* failure("changed", "The restore operation has no exact saved-copy binding.");
    if (!(yield* isManaged(operation.destinationPath)))
      return yield* failure("protected", "Choose a managed worktree destination.");
    yield* checkOwners(record);
    let journal = yield* native(() => store.readJournal(id));
    if (journal.phase === "suspended" || journal.phase === "removing") {
      yield* native(() =>
        store.stageRestore(id, { destinationPath: operation.destinationPath! }),
      ).pipe(Effect.onError(() => cancelUnstartedRestore(record).pipe(Effect.ignoreCause)));
      journal = yield* native(() => store.readJournal(id));
    }
    const restored =
      journal.phase === "restoring"
        ? yield* native(() => store.resumeRestore(id))
        : yield* native(() => store.verifyRestored(id));
    if (restored.path !== operation.destinationPath)
      return yield* failure("changed", "The restore destination changed.");
    if (record.summary.state !== "active")
      record = yield* publish(
        record,
        {
          ...record,
          nativeIdentity: yield* restoredIdentity(restored.path),
          lastHead: restored.head,
        },
        {
          ...record.summary,
          state: "active",
          snapshotId: null,
          lastRestoredAt: yield* now,
          keepWorkspace: operation.manual,
        },
        { worktreePath: restored.path, branch: shortBranch(restored.branch) },
      );
    journal = yield* native(() => store.readJournal(id));
    if (journal.phase === "restored") yield* native(() => store.finalizeRestore(id));
    const finished = clearOperation(record);
    yield* registry.put(finished, record);
    return finished;
  });
  const finishRecovery = Effect.fn("WorktreeSuspension.finishRecovery")(function* (
    initial: CheckoutAuthority,
  ) {
    const operation = initial.operation;
    const id = operation?.snapshotIds[0];
    if (
      operation?.kind !== "recovery" ||
      id === undefined ||
      operation.destinationPath === undefined ||
      operation.recoveryProjectId === undefined ||
      operation.recoveryThreadId === undefined ||
      initial.recoveryThread === undefined
    )
      return yield* failure(
        "unavailable",
        "Separate recovery needs a verified project and thread template.",
      );
    const project = yield* projects.get(operation.recoveryProjectId);
    if (
      Option.isNone(project) ||
      (yield* commonDirectory(project.value.workspaceRoot)) !==
        (yield* native(() => store.read(id))).commonDirectory
    )
      return yield* failure(
        "protected",
        "Map this recovery to a project in the original repository.",
      );
    if (!(yield* isManaged(operation.destinationPath)))
      return yield* failure("protected", "Choose a managed worktree destination.");
    const saved = yield* native(() => store.read(id));
    if (saved.ownerBinding !== initial.checkoutId)
      return yield* failure("changed", "The historical copy belongs to a different checkout.");
    let journal = yield* native(() => store.readJournal(id));
    if (
      journal.phase === "suspended" ||
      (journal.phase === "active" &&
        (journal.destinationPath !== operation.destinationPath ||
          journal.branch !== `refs/heads/${operation.branch}`))
    ) {
      yield* native(() =>
        store.stageRestore(id, {
          destinationPath: operation.destinationPath!,
          branchName: operation.branch!,
        }),
      ).pipe(Effect.onError(() => cancelUnstartedRestore(initial).pipe(Effect.ignoreCause)));
      journal = yield* native(() => store.readJournal(id));
    }
    const result =
      journal.phase === "restoring"
        ? yield* native(() => store.resumeRestore(id))
        : yield* native(() => store.verifyRestored(id));
    if (
      result.path !== operation.destinationPath ||
      shortBranch(result.branch) !== operation.branch
    )
      return yield* failure("changed", "The separate recovery destination changed.");
    let recovered = (yield* registry.list).find((entry) => entry.checkoutId === operation.id);
    if (recovered === undefined) {
      recovered = {
        checkoutId: operation.id,
        repositoryRoot: project.value.workspaceRoot,
        path: result.path,
        aliases: [result.path],
        owners: [],
        history: [],
        snapshots: [],
        blockedReason: null,
        sourceCheckoutId: initial.checkoutId,
        nativeIdentity: yield* restoredIdentity(result.path),
        lastHead: result.head,
        lastWorkspaceUseAt: yield* now,
        recoveryThread: initial.recoveryThread,
        summary: {
          checkoutId: operation.id,
          generation: 0,
          state: "active",
          snapshotId: null,
          lastRestoredAt: yield* now,
          keepWorkspace: true,
        },
        operation: { ...operation, kind: "recovery" },
      };
      yield* registry.put(recovered, null);
      yield* registerWorkspaceLeaseRoot(result.path);
    }
    if (recovered.pendingProjection !== undefined) recovered = yield* finishPublication(recovered);
    let thread = yield* projections.getThreadShell(operation.recoveryThreadId);
    const deleted =
      thread === null
        ? yield* projections.getThread(operation.recoveryThreadId).pipe(Effect.option)
        : Option.none();
    if (Option.isSome(deleted) && deleted.value.deletedAt !== null) {
      if (
        deleted.value.projectId !== operation.recoveryProjectId ||
        deleted.value.worktreePath !== result.path
      )
        return yield* failure("changed", "The recovery thread binding changed.");
      // Accepted deletion releases the published owner, but retains the source
      // snapshot and the recovered checkout rather than recreating a tombstone.
      if (recovered.owners.length > 0) {
        const retained = { ...recovered, owners: [] };
        yield* registry.put(retained, recovered);
        recovered = retained;
      }
    } else {
      if (thread === null) {
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`suspension:recover:${operation.id}`),
          threadId: operation.recoveryThreadId,
          projectId: operation.recoveryProjectId,
          ...initial.recoveryThread,
          title: `Recovered: ${initial.recoveryThread.title}`,
          branch: shortBranch(result.branch),
          worktreePath: result.path,
          createdBy: "user",
          creationSource: "web",
        });
        thread = yield* projections.getThreadShell(operation.recoveryThreadId);
      }
      if (
        thread === null ||
        thread.deletedAt !== null ||
        thread.projectId !== operation.recoveryProjectId ||
        thread.worktreePath !== result.path ||
        thread.branch !== shortBranch(result.branch)
      )
        return yield* failure("changed", "The recovery thread binding changed.");
      if (thread.worktreeSuspension === undefined) {
        const bound = { ...recovered, owners: [ownerOf(thread)] };
        yield* registry.put(bound, recovered);
        recovered = yield* publish(bound, bound, bound.summary);
      } else if (!equivalentSummary(thread.worktreeSuspension, recovered.summary))
        return yield* failure("changed", "The recovery thread authority changed.");
    }
    if ((yield* native(() => store.readJournal(id))).phase === "restored")
      yield* native(() => store.finalizeRestore(id));
    const active = clearOperation(recovered);
    yield* registry.put(active, recovered);
    const source = yield* requireRecord(initial.checkoutId);
    if (source.operation?.id !== operation.id)
      return yield* failure("changed", "The original recovery authority changed.");
    const finished = clearOperation(source);
    yield* registry.put(finished, source);
    return active;
  });
  const finishFresh = Effect.fn("WorktreeSuspension.finishFresh")(function* (
    record: CheckoutAuthority,
  ) {
    const operation = record.operation;
    if (
      operation?.kind !== "fresh" ||
      operation.destinationPath === undefined ||
      operation.branch === undefined ||
      record.lastHead === undefined
    )
      return yield* failure("unavailable", "The fresh-worktree operation has no verified base.");
    yield* checkOwners(record);
    const result = yield* native(() =>
      store.createFresh({
        operationId: operation.id,
        repositoryRoot: record.repositoryRoot,
        destinationPath: operation.destinationPath!,
        head: record.lastHead!,
        branchName: operation.branch!,
      }),
    );
    const active =
      record.summary.state === "active"
        ? record
        : yield* publish(
            record,
            {
              ...record,
              nativeIdentity: yield* restoredIdentity(result.path),
              lastWorkspaceUseAt: yield* now,
              lastHead: result.head,
            },
            {
              ...record.summary,
              generation: record.summary.generation + 1,
              state: "active",
              snapshotId: null,
              lastRestoredAt: null,
              keepWorkspace: true,
            },
            { worktreePath: result.path, branch: shortBranch(result.branch) },
          );
    const finished = clearOperation(active);
    yield* registry.put(finished, active);
    return finished;
  });
  const reconcile = Effect.fn("WorktreeSuspension.reconcile")(function* (
    initial: CheckoutAuthority,
  ) {
    let record =
      initial.pendingProjection === undefined
        ? yield* reconcileDeletedOwners(initial)
        : yield* finishPublication(initial);
    if (record.sourceCheckoutId !== undefined && record.operation?.kind === "recovery") {
      const source = yield* requireRecord(record.sourceCheckoutId);
      if (source.operation?.kind === "recovery") return yield* finishRecovery(source);
      return yield* failure("changed", "The separate recovery owner operation is unavailable.");
    }
    if (record.operation?.kind === "discard") return yield* finishDiscard(record);
    if (record.operation?.kind === "restore") return yield* finishRestore(record);
    if (record.operation?.kind === "fresh") return yield* finishFresh(record);
    if (record.operation?.kind === "recovery") {
      yield* finishRecovery(record);
      return yield* requireRecord(record.checkoutId);
    }
    if (record.operation?.kind !== "capture") return yield* refreshActiveOwners(record);
    const id = record.operation.snapshotIds[0];
    if (id === undefined)
      return yield* failure("changed", "The save operation has no exact snapshot identity.");
    const journalExists = yield* fs.exists(
      path.join(registry.root, "snapshots", id, "journal.json"),
    );
    if (!journalExists) {
      if (yield* fs.exists(path.join(registry.root, "snapshots", id)))
        return yield* failure(
          "protected",
          "The incomplete preservation directory has no verified journal. Its recovery authority has been retained.",
        );
      yield* originalStillOwned(record);
      const active = yield* publish(record, clearOperation(record), {
        ...record.summary,
        state: "active",
        snapshotId: null,
      });
      return active;
    }
    let journal = yield* native(() => store.readJournal(id));
    if (
      (journal.phase === "capturing" &&
        !(yield* fs.exists(path.join(registry.root, "snapshots", id, "manifest.json")))) ||
      journal.phase === "capture-cleanup"
    ) {
      yield* originalStillOwned(record);
      yield* native(() =>
        store.cleanupIncompleteCapture(id, { operationId: record.operation!.id }),
      );
      journal = yield* native(() => store.readJournal(id));
    }
    if (journal.phase === "capture-cancelled") {
      yield* originalStillOwned(record);
      return yield* publish(record, clearOperation(record), {
        ...record.summary,
        state: "active",
        snapshotId: null,
      });
    }
    if (["isolating", "isolated", "removing"].includes(journal.phase)) {
      const recovered = yield* native(() => store.reconcileRemoval(id));
      if (recovered.status === "restore-required") {
        const restoring = yield* publish(
          record,
          {
            ...record,
            operation: { ...record.operation, kind: "restore", destinationPath: record.path },
          },
          { ...record.summary, state: "restoring" },
        );
        return yield* finishRestore(restoring);
      }
      journal = recovered.journal;
    }
    if (journal.phase === "suspended") {
      const snapshot = yield* native(() => store.read(id));
      record = yield* remember(record, snapshot);
      return yield* publish(record, clearOperation(record), {
        ...record.summary,
        state: "suspended",
      });
    }
    if (["capturing", "verifying", "ready", "active"].includes(journal.phase)) {
      yield* originalStillOwned(record);
      if (journal.trialPath !== undefined) {
        yield* native(() => store.trialRestore(id));
        journal = yield* native(() => store.readJournal(id));
        if (journal.trialPath !== undefined)
          return yield* failure(
            "protected",
            "The owned trial restore still needs recovery. Its operation has been retained.",
          );
      }
      const manifest = yield* native(() => store.read(id)).pipe(Effect.option);
      if (Option.isSome(manifest) && !record.history.includes(id))
        record = yield* remember(record, manifest.value);
      if (journal.phase !== "active") yield* native(() => store.keepOriginal(id));
      const active = yield* publish(record, clearOperation(record), {
        ...record.summary,
        state: "active",
        snapshotId: null,
      });
      return active;
    }
    return yield* failure(
      "protected",
      "The saved workspace needs explicit recovery before commands can run.",
    );
  });
  const capture = Effect.fn("WorktreeSuspension.capture")(function* (
    initial: CheckoutAuthority,
    automatic: boolean,
  ) {
    return yield* withWorkspaceLease(
      initial.path,
      Effect.suspend(() =>
        Effect.gen(function* () {
          let record = yield* assertFresh(initial);
          const id = record.operation?.snapshotIds[0];
          if (record.operation?.kind !== "capture" || id === undefined)
            return yield* failure("changed", "The durable save intent is missing.");
          yield* guard(record);
          if (automatic && !(yield* automaticallyEligible(record))) {
            yield* reconcile(record);
            return;
          }
          return yield* Effect.acquireUseRelease(
            Effect.try({
              try: () => acquireGeneratedWorktreeMutation(record.path),
              catch: safeFailure,
            }),
            () =>
              Effect.gen(function* () {
                const snapshot = yield* native(() =>
                  store.capture({
                    sourcePath: record.path,
                    snapshotId: id,
                    operationId: record.operation!.id,
                    ownerBinding: record.checkoutId,
                  }),
                );
                record = yield* remember(record, snapshot);
                yield* native(() => store.trialRestore(id));
                yield* guard(record);
                const journal = yield* native(() =>
                  store.isolate(id, {
                    quarantineParent: path.join(path.dirname(record.path), ".suspended-workspaces"),
                  }),
                );
                if (journal.isolatedPath === undefined)
                  return yield* failure(
                    "unavailable",
                    "The isolated workspace could not be verified.",
                  );
                yield* guard(record, journal.isolatedPath);
                yield* native(() => store.prepareRemoval(id));
                yield* guard(record, journal.isolatedPath, automatic);
                yield* native(() => store.finishRemoval(id));
                yield* publish(record, clearOperation(record), {
                  ...record.summary,
                  state: "suspended",
                });
              }),
            (release) => Effect.sync(release),
          );
        }),
      ),
    );
  });
  const queue = Effect.fn("WorktreeSuspension.queue")(function* <E>(
    record: CheckoutAuthority,
    operation: Effect.Effect<unknown, E>,
  ) {
    if (liveOperations.has(record.checkoutId) || record.operation === undefined)
      return yield* failure(
        "busy",
        "A saved-workspace operation is already running or has no durable intent.",
      );
    const completed = yield* Deferred.make<void>();
    const job = { completed, started: false, cancelled: false };
    liveOperations.set(record.checkoutId, job);
    const run = withWorkspaceLease(
      record.path,
      Effect.suspend(() => {
        if (job.cancelled) return Effect.void;
        job.started = true;
        return operation;
      }),
    );
    const limited = record.operation.kind === "capture" ? saves.withPermits(1)(run) : run;
    yield* limited.pipe(
      Effect.catchCause((cause) =>
        markBlocked(
          record.checkoutId,
          safeFailure(Option.getOrUndefined(Cause.findErrorOption(cause))),
        ).pipe(Effect.ignore),
      ),
      Effect.ensuring(
        Effect.gen(function* () {
          liveOperations.delete(record.checkoutId);
          yield* Deferred.succeed(completed, undefined);
        }),
      ),
      Effect.forkIn(scope),
    );
    return {
      operationId: record.operation.id,
      checkoutId: record.checkoutId,
      state: "queued",
      message: "Workspace operation recorded. Refresh saved workspaces to see its result.",
    } satisfies WorkspaceOperation;
  });
  const acceptCapture = Effect.fn("WorktreeSuspension.acceptCapture")(function* (
    initial: CheckoutAuthority,
    automatic: boolean,
  ) {
    return yield* withWorkspaceLease(
      initial.path,
      Effect.suspend(() =>
        Effect.gen(function* () {
          const fresh = yield* assertFresh(initial);
          yield* guard(fresh);
          if (
            liveOperations.has(fresh.checkoutId) ||
            fresh.operation !== undefined ||
            fresh.summary.state !== "active"
          )
            return yield* failure("busy", "Finish the current workspace operation first.");
          if (automatic && !(yield* automaticallyEligible(fresh))) return null;
          const id = yield* crypto.randomUUIDv4();
          const record = yield* publish(
            fresh,
            {
              ...fresh,
              aliases: [
                ...new Set([
                  ...fresh.aliases,
                  path.join(path.dirname(fresh.path), ".suspended-workspaces", id),
                ]),
              ],
              operation: {
                id,
                kind: "capture",
                snapshotIds: [id],
                manual: !automatic,
                acceptedAt: yield* now,
              },
              blockedReason: null,
            },
            {
              ...fresh.summary,
              generation: fresh.summary.generation + 1,
              state: "capturing",
              snapshotId: id,
            },
          );
          return yield* queue(record, capture(record, automatic));
        }),
      ),
    );
  });
  const list = Effect.fn("WorktreeSuspension.list")(function* (
    input: Input<typeof ListSavedWorkspacesInput>,
    access?: SavedWorkspaceAccess,
  ) {
    const entries: SavedWorkspace[] = [];
    for (const record of yield* registry.list) {
      if (access?.allowOrphans !== true && (yield* survivingOwners(record)).length === 0) continue;
      for (const id of snapshotIds(record)) {
        const entry = yield* savedEntry(record, id);
        if (input.projectId === undefined || entry.projectIds.includes(input.projectId))
          entries.push(entry);
      }
    }
    const start = input.cursor ?? 0;
    return {
      entries: entries.slice(start, start + 100),
      nextCursor: start + 100 < entries.length ? start + 100 : null,
    };
  }, Effect.mapError(safeFailure));
  const previewSuspend = Effect.fn("WorktreeSuspension.previewSuspend")(function* (
    input: Input<typeof PreviewWorktreeSuspensionInput>,
  ) {
    const initial = yield* identify(input.threadId);
    const record = yield* withWorkspaceLease(initial.path, reconcile(initial));
    if (record.summary.state !== "active" || record.operation !== undefined)
      return yield* failure("busy", "This workspace is not ready to suspend.");
    yield* withWorkspaceLease(record.path, guard(record));
    const token = yield* crypto.randomUUIDv4();
    previewsByToken.set(token, { authority: record, expiresAt: (yield* milliseconds) + 300_000 });
    return {
      token,
      checkoutId: record.checkoutId,
      path: record.path,
      ownerThreadIds: record.owners.map((owner) => owner.threadId),
      message:
        "Save the exact workspace before removing its checkout. All sharing threads will use this saved copy. Dependencies and generated files are saved unless already safely cleaned.",
    };
  }, Effect.mapError(safeFailure));
  const suspend = Effect.fn("WorktreeSuspension.suspend")(function* (
    input: Input<typeof SuspendWorktreeInput>,
  ) {
    const preview = previewsByToken.get(input.previewToken);
    previewsByToken.delete(input.previewToken);
    if (
      preview === undefined ||
      preview.expiresAt < (yield* milliseconds) ||
      preview.snapshotIds !== undefined ||
      !preview.authority.owners.some((owner) => owner.threadId === input.threadId)
    )
      return yield* failure("invalid-preview", "Refresh the suspension preview before continuing.");
    const accepted = yield* acceptCapture(preview.authority, false);
    return accepted ?? (yield* failure("changed", "The workspace is no longer eligible."));
  }, Effect.mapError(safeFailure));
  const acceptRestore = Effect.fn("WorktreeSuspension.acceptRestore")(function* (
    initial: CheckoutAuthority,
    manual: boolean,
    destinationPath = initial.path,
  ) {
    const record = yield* assertFresh(initial);
    if (
      record.summary.state !== "suspended" ||
      record.summary.snapshotId === null ||
      record.operation !== undefined
    )
      return yield* failure("protected", "This copy is not the current suspended workspace.");
    if (!(yield* isManaged(destinationPath)))
      return yield* failure("protected", "Choose a managed worktree destination.");
    if (yield* fs.exists(destinationPath))
      return yield* failure(
        "protected",
        "The restore destination is occupied. Choose another managed destination.",
      );
    const id = yield* crypto.randomUUIDv4();
    return yield* publish(
      record,
      {
        ...record,
        aliases: [...new Set([...record.aliases, destinationPath])],
        operation: {
          id,
          kind: "restore",
          snapshotIds: [record.summary.snapshotId],
          manual,
          acceptedAt: yield* now,
          destinationPath,
        },
        blockedReason: null,
      },
      { ...record.summary, state: "restoring" },
    );
  });
  const restore = Effect.fn("WorktreeSuspension.restore")(function* (
    input: Input<typeof RestoreWorktreeInput>,
    access?: SavedWorkspaceAccess,
  ) {
    const initial = yield* requireRecord(input.checkoutId);
    return yield* withWorkspaceLease(
      initial.path,
      Effect.suspend(() =>
        Effect.gen(function* () {
          let fresh = yield* requireRecord(initial.checkoutId);
          if (access?.allowOrphans !== true && (yield* survivingOwners(fresh)).length === 0)
            return yield* failure(
              "protected",
              "Recovering an ownerless saved workspace requires environment maintenance permission.",
            );
          if (liveOperations.has(initial.checkoutId))
            return yield* failure("busy", "The workspace operation is still running.");
          let requestedOperation = fresh.operation;
          if (requestedOperation?.kind === "restore" || requestedOperation?.kind === "recovery") {
            const cancelled = yield* cancelUnstartedRestore(fresh);
            if (cancelled.operation === undefined) requestedOperation = undefined;
            fresh = cancelled;
          }
          const record = yield* reconcile(fresh);
          if (
            (requestedOperation?.kind === "restore" || requestedOperation?.kind === "recovery") &&
            requestedOperation.snapshotIds.includes(input.snapshotId) &&
            record.operation === undefined
          )
            return {
              operationId: requestedOperation.id,
              checkoutId: record.checkoutId,
              state: "complete",
              message: "The saved workspace recovery completed.",
            } satisfies WorkspaceOperation;
          if (!snapshotIds(record).includes(input.snapshotId))
            return yield* failure("changed", "The selected saved copy changed.");
          if (record.summary.snapshotId === input.snapshotId && record.owners.length > 0) {
            const restoring = yield* acceptRestore(
              record,
              true,
              input.destinationPath ?? record.path,
            );
            return yield* queue(
              restoring,
              withWorkspaceLease(restoring.path, finishRestore(restoring)),
            );
          }
          if (record.operation !== undefined)
            return yield* failure("busy", "Finish the current operation before separate recovery.");
          const projectId =
            input.projectId ??
            record.snapshots?.find((entry) => entry.snapshotId === input.snapshotId)?.owners[0]
              ?.projectId;
          if (projectId === undefined || record.recoveryThread === undefined)
            return yield* failure(
              "protected",
              "Choose a project in the original repository for this recovery.",
            );
          const id = yield* crypto.randomUUIDv4();
          const branch = `suspension/recovered-${id}`;
          const destinationPath =
            input.destinationPath ?? path.join(path.dirname(record.path), `recovered-${id}`);
          if (
            destinationPath === record.path ||
            record.aliases.includes(destinationPath) ||
            !(yield* isManaged(destinationPath))
          )
            return yield* failure(
              "protected",
              "Historical recovery needs a separate managed destination.",
            );
          if (yield* fs.exists(destinationPath))
            return yield* failure(
              "protected",
              "The recovery destination is occupied. Choose another managed destination.",
            );
          const pending: CheckoutAuthority = {
            ...record,
            operation: {
              id,
              kind: "recovery",
              snapshotIds: [input.snapshotId],
              manual: true,
              acceptedAt: yield* now,
              destinationPath,
              recoveryProjectId: projectId,
              recoveryThreadId: ThreadId.make(`suspension:${id}`),
              branch,
            },
            blockedReason: null,
          };
          yield* registry.put(pending, record);
          yield* registerWorkspaceLeaseRoot(destinationPath);
          return yield* queue(
            pending,
            withWorkspaceLease(destinationPath, finishRecovery(pending)),
          );
        }),
      ),
    );
  }, Effect.mapError(safeFailure));
  const discardAllowed = Effect.fn("WorktreeSuspension.discardAllowed")(function* (
    record: CheckoutAuthority,
    ids: readonly string[],
  ) {
    if (record.summary.keepWorkspace)
      return yield* failure("protected", "Keep workspace protects these saved copies.");
    if (
      record.operation !== undefined ||
      record.pendingProjection !== undefined ||
      !["active", "suspended", "discarded"].includes(record.summary.state)
    )
      return yield* failure(
        "busy",
        "Finish or recover the current operation before discarding recovery data.",
      );
    yield* checkOwners(record);
    if (ids.some((id) => !record.history.includes(id)))
      return yield* failure("changed", "The selected saved copies changed.");
    for (const id of ids) {
      const saved = yield* native(() => store.read(id));
      if (saved.ownerBinding !== record.checkoutId)
        return yield* failure("changed", "A saved copy belongs to another checkout.");
    }
  });
  const previewDiscard = Effect.fn("WorktreeSuspension.previewDiscard")(function* (
    input: Input<typeof PreviewWorktreeDiscardInput>,
  ) {
    const initial = yield* requireRecord(input.checkoutId);
    const record = yield* withWorkspaceLease(initial.path, reconcile(initial));
    const ids = [...new Set(input.snapshotIds)];
    yield* discardAllowed(record, ids);
    const snapshots = yield* Effect.forEach(ids, (id) => savedEntry(record, id));
    const token = yield* crypto.randomUUIDv4();
    previewsByToken.set(token, {
      authority: record,
      snapshotIds: ids,
      expiresAt: (yield* milliseconds) + 300_000,
    });
    return {
      token,
      checkoutId: record.checkoutId,
      snapshots,
      bytes: snapshots.reduce((sum, snapshot) => sum + snapshot.bytes, 0),
      retainedCount: record.history.length - ids.length,
      message:
        "Permanently discard these saved files, including uncommitted work and notes. You cannot restore them afterward. Git branches and ordinary checkpoints remain.",
    };
  }, Effect.mapError(safeFailure));
  const prepareDiscard = Effect.fn("WorktreeSuspension.prepareDiscard")(function* (
    record: CheckoutAuthority,
    ids: readonly string[],
    lifecycleIntent?: NonNullable<NonNullable<CheckoutAuthority["operation"]>["lifecycle"]>,
    recordIntent?: (pending: CheckoutAuthority) => void,
  ) {
    if (liveOperations.has(record.checkoutId))
      return yield* failure("busy", "The workspace operation is still finishing.");
    yield* discardAllowed(record, ids);
    const pending: CheckoutAuthority = {
      ...record,
      blockedReason: null,
      operation: {
        id: yield* crypto.randomUUIDv4(),
        kind: "discard",
        snapshotIds: ids,
        manual: true,
        acceptedAt: yield* now,
        ...(lifecycleIntent === undefined
          ? { consentCommitted: true }
          : { lifecycle: lifecycleIntent }),
      },
    };
    recordIntent?.(pending);
    yield* registry.put(pending, record);
    for (const id of ids) yield* native(() => store.beginDiscard(id));
    return pending;
  });
  const discard = Effect.fn("WorktreeSuspension.discard")(function* (
    input: Input<typeof DiscardWorktreeSnapshotsInput>,
  ) {
    const preview = previewsByToken.get(input.previewToken);
    previewsByToken.delete(input.previewToken);
    if (preview?.snapshotIds === undefined || preview.expiresAt < (yield* milliseconds))
      return yield* failure("invalid-preview", "Refresh the discard preview before continuing.");
    return yield* withWorkspaceLease(
      preview.authority.path,
      Effect.suspend(() =>
        Effect.gen(function* () {
          const record = yield* assertFresh(preview.authority);
          const pending = yield* prepareDiscard(record, preview.snapshotIds!);
          return yield* queue(pending, withWorkspaceLease(pending.path, finishDiscard(pending)));
        }),
      ),
    );
  }, Effect.mapError(safeFailure));
  const setKeepWorkspace = Effect.fn("WorktreeSuspension.setKeepWorkspace")(function* (
    input: Input<typeof SetKeepWorkspaceInput>,
    access?: SavedWorkspaceAccess,
  ) {
    const orphanRelease = "checkoutId" in input;
    if (orphanRelease && access?.allowOrphans !== true)
      return yield* failure(
        "protected",
        "Releasing an ownerless workspace hold requires environment maintenance permission.",
      );
    const initial = orphanRelease
      ? yield* requireRecord(input.checkoutId)
      : yield* identify(input.threadId);
    return yield* withWorkspaceLease(
      initial.path,
      Effect.suspend(() =>
        Effect.gen(function* () {
          const fresh = yield* requireRecord(initial.checkoutId);
          if (orphanRelease && (yield* survivingOwners(fresh)).length !== 0)
            return yield* failure(
              "protected",
              "This checkout still has an owner. Release its hold through that thread.",
            );
          if (liveOperations.has(initial.checkoutId))
            return yield* failure(
              "busy",
              "Finish the workspace operation before changing its hold.",
            );
          if (
            orphanRelease &&
            (fresh.operation !== undefined || fresh.pendingProjection !== undefined)
          )
            return yield* failure(
              "busy",
              "Finish the workspace operation before releasing its hold.",
            );
          const record = yield* reconcile(fresh);
          if (
            (orphanRelease
              ? !["active", "suspended", "discarded"].includes(record.summary.state)
              : record.summary.state !== "active") ||
            record.operation !== undefined
          )
            return yield* failure(
              "busy",
              "Restore the current workspace before changing its hold.",
            );
          yield* publish(record, record, { ...record.summary, keepWorkspace: input.keep });
          return {
            operationId: yield* crypto.randomUUIDv4(),
            checkoutId: record.checkoutId,
            state: "complete",
            message: input.keep
              ? "Keep workspace is enabled for all sharing threads."
              : "The workspace hold was released. Configured cleanup rules apply.",
          } satisfies WorkspaceOperation;
        }),
      ),
    );
  }, Effect.mapError(safeFailure));
  const createFresh = Effect.fn("WorktreeSuspension.createFresh")(function* (
    input: Input<typeof PreviewWorktreeSuspensionInput>,
  ) {
    const initial = yield* identify(input.threadId);
    return yield* withWorkspaceLease(
      initial.path,
      Effect.suspend(() =>
        Effect.gen(function* () {
          const record = yield* reconcile(initial);
          if (record.summary.state !== "discarded" || record.operation !== undefined)
            return yield* failure(
              "protected",
              "Fresh creation is available after deliberate saved-workspace disposal.",
            );
          yield* checkOwners(record);
          if (!(yield* isManaged(record.path)) || (yield* fs.exists(record.path)))
            return yield* failure(
              "protected",
              "The managed destination is occupied or no longer managed.",
            );
          const branch = record.owners[0]?.branch;
          const tip =
            branch === null || branch === undefined
              ? record.lastHead
              : yield* git
                  .execute({
                    operation: "fresh workspace base",
                    cwd: record.repositoryRoot,
                    args: ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`],
                    allowNonZeroExit: true,
                  })
                  .pipe(
                    Effect.map((result) =>
                      result.exitCode === 0 ? result.stdout.trim() : record.lastHead,
                    ),
                  );
          if (tip === undefined || !/^[a-f0-9]{40,64}$/u.test(tip))
            return yield* failure(
              "unavailable",
              "The original branch and base commit are unavailable. Choose a new branch explicitly.",
            );
          const id = yield* crypto.randomUUIDv4();
          const pending: CheckoutAuthority = {
            ...record,
            lastHead: tip,
            blockedReason: null,
            operation: {
              id,
              kind: "fresh",
              snapshotIds: [],
              manual: true,
              acceptedAt: yield* now,
              destinationPath: record.path,
              branch: `suspension/fresh-${id}`,
            },
          };
          yield* registry.put(pending, record);
          return yield* queue(pending, withWorkspaceLease(pending.path, finishFresh(pending)));
        }),
      ),
    );
  }, Effect.mapError(safeFailure));
  const lifecycleInventory = Effect.fn("WorktreeSuspension.lifecycleInventory")(function* (
    input: WorkspaceLifecyclePreviewInput,
    access?: SavedWorkspaceAccess,
  ) {
    const roots =
      input.target.kind === "threads"
        ? input.target.threadIds
        : (yield* projections.getShellSnapshot({ projectId: input.target.projectId })).threads
            .concat(
              (yield* projections.getShellSnapshot({ projectId: input.target.projectId }))
                .archivedThreads,
            )
            .filter((thread) => thread.deletedAt === null)
            .map((thread) => thread.id);
    const threadIds = [
      ...new Set(
        (yield* Effect.forEach(roots, (id) =>
          input.operation === "archive"
            ? projections.getArchiveFamilyThreadIds(id)
            : projections.getOwnedThreadIds(id),
        )).flat(),
      ),
    ];
    if (threadIds.length > 1000)
      return yield* failure(
        "protected",
        "This operation has too many thread owners for one saved-workspace confirmation.",
      );
    const targetProjects = input.target.kind === "project" ? [input.target.projectId] : [];
    const records: CheckoutAuthority[] = [];
    const selected = new Map<string, readonly string[]>();
    const snapshots: SavedWorkspace[] = [];
    const retainedSnapshots: SavedWorkspace[] = [];
    for (const record of yield* registry.list) {
      if (access?.allowOrphans !== true && (yield* survivingOwners(record)).length === 0) continue;
      const knownOwners = [
        ...record.owners,
        ...(record.snapshots ?? []).flatMap((entry) => entry.owners),
      ];
      if (
        !knownOwners.some(
          (owner) => threadIds.includes(owner.threadId) || targetProjects.includes(owner.projectId),
        )
      )
        continue;
      records.push(record);
      const ids: string[] = [];
      const currentOwners = yield* ownersFor(record.aliases, record);
      for (const id of snapshotIds(record)) {
        const receipt = record.snapshots?.find((entry) => entry.snapshotId === id);
        const involved = receipt?.owners ?? record.owners;
        const outside =
          currentOwners.some((owner) => !threadIds.includes(owner.id)) ||
          (yield* Effect.forEach(
            involved.filter((owner) => !threadIds.includes(owner.threadId)),
            (owner) => projections.getThreadShell(owner.threadId),
          )).some((owner) => owner !== null && owner.deletedAt === null);
        const entry = yield* savedEntry(record, id);
        if (
          !outside &&
          !record.summary.keepWorkspace &&
          record.operation === undefined &&
          record.pendingProjection === undefined &&
          record.history.includes(id) &&
          entry.blockedReason === undefined
        ) {
          snapshots.push(entry);
          ids.push(id);
        } else retainedSnapshots.push(entry);
      }
      selected.set(record.checkoutId, ids);
    }
    if (snapshots.length + retainedSnapshots.length > 100)
      return yield* failure(
        "protected",
        "More than 100 saved copies are affected. Review smaller groups before continuing.",
      );
    const projectIds = [
      ...new Set([
        ...targetProjects,
        ...records.flatMap((record) => record.owners.map((owner) => owner.projectId)),
      ]),
    ];
    if (projectIds.length > 100)
      return yield* failure("protected", "Too many projects share these saved workspaces.");
    return { records, ids: selected, threadIds, projectIds, snapshots, retainedSnapshots };
  });
  const previewLifecycle = Effect.fn("WorktreeSuspension.previewLifecycle")(function* (
    input: WorkspaceLifecyclePreviewInput,
    access?: SavedWorkspaceAccess,
  ) {
    const inventory = yield* lifecycleInventory(input, access);
    const token = yield* crypto.randomUUIDv4();
    lifecyclePreviews.set(token, {
      input,
      records: inventory.records,
      ids: inventory.ids,
      threadIds: inventory.threadIds,
      projectIds: inventory.projectIds,
      expiresAt: (yield* milliseconds) + 300_000,
      allowOrphans: access?.allowOrphans === true,
    });
    return {
      token,
      snapshots: inventory.snapshots,
      retainedSnapshots: inventory.retainedSnapshots,
      bytes: inventory.snapshots.reduce((total, snapshot) => total + snapshot.bytes, 0),
      threadIds: inventory.threadIds,
      projectIds: inventory.projectIds,
      message:
        "Discard only the listed saved copies after this operation succeeds. Copies shared outside this selection or protected by a hold remain available.",
    } satisfies WorkspaceLifecyclePreview;
  }, Effect.mapError(safeFailure));
  const sameLifecycleInput = Schema.toEquivalence(
    Schema.Struct({
      operation: Schema.Literals(["archive", "delete"]),
      target: Schema.Union([
        Schema.Struct({ kind: Schema.Literal("threads"), threadIds: Schema.Array(ThreadId) }),
        Schema.Struct({ kind: Schema.Literal("project"), projectId: ProjectId }),
      ]),
    }),
  );
  const sameDeleteReceipts = Schema.toEquivalence(
    Schema.Array(Schema.Struct({ threadId: ThreadId, commandId: CommandId })),
  );
  const runLifecycleWithDisposition: WorkspaceLifecycle.WorkspaceLifecycleHandler["run"] =
    Effect.fn("WorktreeSuspension.runLifecycle")(function* <A, E, R>(
      input: WorkspaceLifecycleRunInput,
      commit: Effect.Effect<A, E, R>,
    ) {
      const choice = input.savedWorkspace;
      if (choice?.mode !== "discard") return yield* commit;
      if (
        input.deleteReceipts !== undefined &&
        (input.operation !== "delete" ||
          input.target.kind !== "threads" ||
          input.deleteReceipts.some(
            (binding) =>
              input.target.kind !== "threads" || !input.target.threadIds.includes(binding.threadId),
          ) ||
          new Set(input.deleteReceipts.map((binding) => binding.threadId)).size !==
            input.deleteReceipts.length ||
          new Set(input.deleteReceipts.map((binding) => binding.commandId)).size !==
            input.deleteReceipts.length)
      )
        return yield* failure(
          "changed",
          "The deletion receipt bindings do not match the selected roots.",
        );
      const preparedHere: CheckoutAuthority[] = [];
      const cancelUnstartedIntents = Effect.suspend(() =>
        Effect.forEach(preparedHere, (original) =>
          withWorkspaceLease(
            original.path,
            Effect.gen(function* () {
              const fresh = yield* requireRecord(original.checkoutId);
              if (
                fresh.operation?.id === original.operation?.id &&
                fresh.operation?.lifecycle?.commandId === input.commandId &&
                fresh.operation.consentCommitted !== true
              )
                yield* cancelDiscardOperation(fresh);
            }),
          ).pipe(Effect.ignoreCause),
        ),
      );
      const intents = yield* Effect.gen(function* () {
        const pending = (yield* registry.list).filter(
          (record) =>
            record.operation?.kind === "discard" &&
            record.operation.lifecycle?.commandId === input.commandId,
        );
        if (pending.length > 0) {
          if (
            pending.some(
              (record) =>
                !sameLifecycleInput(
                  {
                    operation: record.operation!.lifecycle!.operation,
                    target: record.operation!.lifecycle!.target,
                  },
                  input,
                ) ||
                !sameDeleteReceipts(
                  record.operation!.lifecycle!.deleteReceipts ?? [],
                  input.deleteReceipts ?? [],
                ),
            )
          )
            return yield* failure(
              "changed",
              "The lifecycle replay does not match its saved-data intent.",
            );
          return pending;
        }
        const preview = lifecyclePreviews.get(choice.previewToken);
        lifecyclePreviews.delete(choice.previewToken);
        if (
          preview === undefined ||
          preview.expiresAt < (yield* milliseconds) ||
          !sameLifecycleInput(preview.input, input)
        )
          return yield* failure(
            "invalid-preview",
            "Refresh the saved-workspace confirmation before continuing.",
          );
        const inventory = yield* lifecycleInventory(input, { allowOrphans: preview.allowOrphans });
        if (
          inventory.records.length !== preview.records.length ||
          inventory.records.some(
            (record) => !preview.records.some((expected) => sameAuthority(record, expected)),
          ) ||
          inventory.threadIds.length !== preview.threadIds.length ||
          inventory.threadIds.some((id) => !preview.threadIds.includes(id)) ||
          inventory.records.some(
            (record) =>
              [...(inventory.ids.get(record.checkoutId) ?? [])].join("\0") !==
              [...(preview.ids.get(record.checkoutId) ?? [])].join("\0"),
          )
        )
          return yield* failure(
            "changed",
            "The affected owners or saved copies changed. Review a fresh confirmation.",
          );
        const records: CheckoutAuthority[] = [];
        for (const record of inventory.records) {
          const ids = inventory.ids.get(record.checkoutId) ?? [];
          if (ids.length === 0) continue;
          records.push(
            yield* withWorkspaceLease(
              record.path,
              prepareDiscard(
                record,
                ids,
                {
                  commandId: input.commandId,
                  operation: input.operation,
                  target: input.target,
                  threadIds: inventory.threadIds,
                  ...(input.deleteReceipts === undefined
                    ? {}
                    : { deleteReceipts: input.deleteReceipts }),
                  ...(input.target.kind === "project" ? { projectId: input.target.projectId } : {}),
                },
                (pending) => {
                  preparedHere.push(pending);
                },
              ),
            ),
          );
        }
        return records;
      }).pipe(
        Effect.onError(() => cancelUnstartedIntents),
        Effect.mapError(safeFailure),
      );
      const reconcileFailed = Effect.forEach(intents, (original) =>
        withWorkspaceLease(
          original.path,
          Effect.gen(function* () {
            const fresh = yield* requireRecord(original.checkoutId);
            if (fresh.operation?.id === original.operation?.id) yield* finishDiscard(fresh);
          }),
        ),
      ).pipe(Effect.ignoreCause);
      const result = yield* commit.pipe(Effect.onError(() => reconcileFailed));
      for (const original of intents)
        yield* withWorkspaceLease(
          original.path,
          Effect.gen(function* () {
            const fresh = yield* requireRecord(original.checkoutId);
            if (
              fresh.operation?.id !== original.operation?.id ||
              fresh.operation?.lifecycle === undefined
            )
              return yield* failure("changed", "The saved-data consent operation changed.");
            if (!(yield* selectedLifecycleDone(fresh.operation.lifecycle))) {
              yield* cancelDiscardOperation(fresh);
              return yield* failure(
                "changed",
                "Some selected threads were not archived or deleted. Their saved copies have been retained.",
              );
            }
            if (fresh.operation.lifecycle.deleteReceipts !== undefined) {
              const resolution = yield* lifecycleResolution(fresh.operation);
              if (resolution !== "committed") {
                if (resolution === "rejected") yield* cancelDiscardOperation(fresh);
                return yield* failure(
                  "changed",
                  "The complete deletion receipts could not be verified. Saved copies have been retained.",
                );
              }
            }
            const consent = { ...fresh, operation: { ...fresh.operation, consentCommitted: true } };
            yield* registry.put(consent, fresh);
            yield* finishDiscard(consent);
          }),
        ).pipe(Effect.mapError(safeFailure));
      return result;
    });
  const runLifecycle: WorkspaceLifecycle.WorkspaceLifecycleHandler["run"] = Effect.fn(
    "WorktreeSuspension.coordinateLifecycle",
  )(function* <A, E, R>(input: WorkspaceLifecycleRunInput, commit: Effect.Effect<A, E, R>) {
    if (input.operation !== "delete") return yield* runLifecycleWithDisposition(input, commit);
    const selected = yield* Effect.gen(function* () {
      const roots =
        input.target.kind === "threads"
          ? input.target.threadIds
          : (yield* projections.getShellSnapshot({ projectId: input.target.projectId })).threads
              .concat(
                (yield* projections.getShellSnapshot({ projectId: input.target.projectId }))
                  .archivedThreads,
              )
              .map((thread) => thread.id);
      return new Set(
        (yield* Effect.forEach(roots, (id) => projections.getOwnedThreadIds(id))).flat(),
      );
    }).pipe(Effect.mapError(safeFailure));
    const reconcileRetained = Effect.gen(function* () {
      const affected = (yield* registry.list.pipe(Effect.orElseSucceed(() => []))).filter(
        (record) =>
          [
            ...record.owners,
            ...(record.pendingProjection?.expectedOwners ?? []),
            ...(record.snapshots ?? []).flatMap((snapshot) => snapshot.owners),
          ].some(
            (owner) =>
              selected.has(owner.threadId) ||
              (input.target.kind === "project" && owner.projectId === input.target.projectId),
          ),
      );
      for (const record of affected) {
        const job = liveOperations.get(record.checkoutId);
        if (job !== undefined && !job.started) job.cancelled = true;
      }
      yield* Effect.forEach(
        affected,
        (record) =>
          withWorkspaceLease(
            record.path,
            Effect.gen(function* () {
              const job = liveOperations.get(record.checkoutId);
              // Outcome persistence happens after the native lease is released.
              // Wait before another catalog CAS, as acquisition does.
              if (job?.started) yield* Deferred.await(job.completed);
              else if (job !== undefined) job.cancelled = true;
              yield* reconcile(yield* requireRecord(record.checkoutId));
            }),
          ).pipe(Effect.catchCause(() => markBlocked(record.checkoutId).pipe(Effect.ignore))),
        { concurrency: 4, discard: true },
      ).pipe(Effect.forkIn(scope));
    }).pipe(Effect.ignoreCause);
    return yield* runLifecycleWithDisposition(input, commit).pipe(
      Effect.ensuring(reconcileRetained),
    );
  });
  const sweepBudget = 4;
  let lastRecoveryId = "";
  let lastAutomaticPath = "";
  const rotate = <A>(values: readonly A[], key: (value: A) => string, after: string) => {
    const sorted = [...values].sort((left, right) => key(left).localeCompare(key(right)));
    const next = sorted.findIndex((value) => key(value).localeCompare(after) > 0);
    return next < 0 ? sorted : [...sorted.slice(next), ...sorted.slice(0, next)];
  };
  const sweep = Effect.gen(function* () {
    const catalog = yield* registry.list;
    const reconcilable = catalog.filter(
      (entry) =>
        !liveOperations.has(entry.checkoutId) &&
        (!entry.detached || entry.operation !== undefined || entry.pendingProjection !== undefined),
    );
    for (const entry of rotate(reconcilable, (entry) => entry.checkoutId, lastRecoveryId).slice(
      0,
      sweepBudget,
    )) {
      lastRecoveryId = entry.checkoutId;
      yield* withWorkspaceLease(
        entry.path,
        Effect.suspend(() =>
          liveOperations.has(entry.checkoutId)
            ? Effect.void
            : requireRecord(entry.checkoutId).pipe(Effect.flatMap(reconcile)),
        ),
      ).pipe(Effect.catchCause(() => markBlocked(entry.checkoutId).pipe(Effect.ignore)));
    }
    const configured = yield* settings.getSettings;
    const timestamp = yield* milliseconds;
    const shell = yield* projections.getShellSnapshot();
    const byId = new Map(catalog.map((entry) => [entry.checkoutId, entry]));
    const byPath = new Map(
      catalog
        .filter((entry) => !entry.detached)
        .flatMap((entry) => entry.aliases.map((alias) => [alias, entry] as const)),
    );
    const candidates = new Map<string, ThreadId>();
    for (const thread of [...shell.threads, ...shell.archivedThreads]) {
      if (thread.worktreePath === null || thread.deletedAt !== null) continue;
      const record =
        thread.worktreeSuspension === undefined
          ? byPath.get(thread.worktreePath)
          : byId.get(thread.worktreeSuspension.checkoutId);
      if (
        record !== undefined &&
        (record.detached ||
          record.summary.state !== "active" ||
          record.operation !== undefined ||
          record.pendingProjection !== undefined ||
          liveOperations.has(record.checkoutId))
      )
        continue;
      if (
        !automaticEligibility(
          thread,
          resolveWorktreeSuspension(configured, thread.projectId),
          timestamp,
          latestWorkspaceUse(record),
          record?.summary.keepWorkspace ?? false,
        ).eligible
      )
        continue;
      candidates.set(record?.path ?? thread.worktreePath, thread.id);
    }
    for (const [workspacePath, threadId] of rotate(
      [...candidates],
      ([workspacePath]) => workspacePath,
      lastAutomaticPath,
    ).slice(0, sweepBudget)) {
      lastAutomaticPath = workspacePath;
      yield* Effect.gen(function* () {
        const identified = yield* identify(threadId, catalog);
        if (
          identified.summary.state !== "active" ||
          identified.operation !== undefined ||
          liveOperations.has(identified.checkoutId)
        )
          return;
        const record = yield* refreshActiveOwners(identified);
        if (yield* automaticallyEligible(record)) yield* acceptCapture(record, true);
      }).pipe(Effect.ignoreCause);
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Saved workspace sweep retained incomplete candidates", { cause }),
    ),
  );

  for (const record of yield* registry.list.pipe(Effect.orElseSucceed(() => [])))
    if (!record.detached) yield* registerWorkspaceLeaseRoot(record.path, record.aliases);
  yield* lifecycle.install({ preview: previewLifecycle, run: runLifecycle });
  const positiveUse = (purpose: string) =>
    [
      "terminal",
      "action",
      "setup",
      "preview",
      "checkpoint",
      "file-write",
      "git-mutation",
      "editor",
    ].includes(purpose);
  yield* acquisition.install(
    Effect.fn("WorktreeSuspension.acquire")(
      function* (input) {
        const normalized = path.resolve(input.path);
        const catalog = yield* registry.list;
        let record = catalog.find(
          (entry) =>
            !entry.detached &&
            (entry.aliases.some((alias) => overlaps(alias, normalized)) ||
              overlaps(entry.path, normalized)),
        );
        if (record === undefined) {
          const bindings = yield* projections.getThreadWorktreePaths({ includeArchived: true });
          for (const binding of bindings) {
            const matchesPath = overlaps(path.resolve(binding.worktreePath), normalized);
            if (!matchesPath && binding.threadId !== input.threadId) continue;
            const thread = yield* projections.getThreadShell(binding.threadId);
            if (thread?.worktreeSuspension !== undefined) {
              const rebound = catalog.find(
                (entry) =>
                  entry.checkoutId === thread.worktreeSuspension!.checkoutId && !entry.detached,
              );
              if (rebound?.summary.state === "active" && rebound.operation === undefined) {
                record = rebound;
                break;
              }
              return yield* new WorkspaceUnavailableError({ reason: "snapshot-unavailable" });
            }
            if (thread !== null && matchesPath && positiveUse(input.purpose)) {
              const policy = resolveWorktreeSuspension(
                yield* settings.getSettings,
                thread.projectId,
              );
              if (
                policy.mode !== "off" &&
                Object.values(policy.scopes).some(Boolean) &&
                (yield* fs.exists(binding.worktreePath)) &&
                (yield* isManaged(binding.worktreePath))
              ) {
                record = yield* identify(thread.id, undefined, "activity");
                break;
              }
            }
          }
          if (record === undefined) return { path: input.path, branch: null, restored: false };
        }
        const initial = record;
        return yield* withWorkspaceLease(
          initial.path,
          Effect.gen(function* () {
            const running = liveOperations.get(initial.checkoutId);
            if (running !== undefined) {
              if (running.started) yield* Deferred.await(running.completed);
              else running.cancelled = true;
            }
            const current = yield* reconcile(yield* requireRecord(initial.checkoutId));
            if (current.detached || !current.aliases.some((alias) => overlaps(alias, normalized)))
              return { path: input.path, branch: null, restored: false };
            if (current.operation !== undefined && current.operation.kind !== "discard")
              return yield* new WorkspaceUnavailableError({ reason: "blocked" });
            if (current.summary.state === "discarded")
              return yield* new WorkspaceUnavailableError({ reason: "discarded" });
            const alias =
              current.aliases
                .filter((candidate) => overlaps(candidate, normalized))
                .sort((left, right) => right.length - left.length)[0] ?? current.path;
            if (alias.split(path.sep).includes(".suspended-workspaces"))
              return yield* new WorkspaceUnavailableError({ reason: "blocked" });
            const suffix = path.relative(alias, normalized);
            if (current.summary.state === "active") {
              yield* checkOwners(current);
              if (positiveUse(input.purpose)) {
                const used = { ...current, lastWorkspaceUseAt: yield* now };
                yield* registry.put(used, current);
              }
              return {
                path: path.join(current.path, suffix),
                branch: !(yield* fs.exists(current.path))
                  ? (current.owners[0]?.branch ?? null)
                  : yield* git
                      .execute({
                        operation: "suspension active branch",
                        cwd: current.path,
                        args: ["rev-parse", "--symbolic-full-name", "HEAD"],
                      })
                      .pipe(
                        Effect.map((result) =>
                          result.stdout.trim().startsWith("refs/heads/")
                            ? shortBranch(result.stdout.trim())
                            : null,
                        ),
                      ),
                restored: false,
              };
            }
            if (current.summary.state !== "suspended")
              return yield* new WorkspaceUnavailableError({ reason: "busy" });
            if (current.owners.length === 0)
              return yield* new WorkspaceUnavailableError({ reason: "owner-changed" });
            const restoring = yield* acceptRestore(current, false);
            const active = yield* finishRestore(restoring);
            return {
              path: path.join(active.path, suffix),
              branch: active.owners[0]?.branch ?? null,
              restored: true,
            };
          }),
        );
      },
      Effect.mapError((cause) =>
        isWorkspaceUnavailable(cause)
          ? cause
          : new WorkspaceUnavailableError({ reason: "snapshot-unavailable" }),
      ),
    ),
  );
  return WorktreeSuspension.of({
    list,
    previewSuspend,
    suspend,
    restore,
    previewDiscard,
    discard,
    setKeepWorkspace,
    createFresh,
    sweep,
  });
});

export const layer = Layer.effect(WorktreeSuspension, make);
