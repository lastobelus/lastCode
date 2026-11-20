import {
  getArchiveFamilyParentThreadId,
  getInteractiveThreadParentThreadId,
  getOwnedThreadFamily,
  getThreadArchivePlan,
  isOrchestrationV2WorkActive,
  isOwnedSubagentThread,
  type EnvironmentId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2InternalCommand,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ThreadArchiveFamily,
  type ThreadId,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { getThreadOwner } from "@t3tools/shared/threadOwnership";
import { pendingBackgroundTurnItems } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { DispatchModeLimit, type DispatchModes } from "./DispatchModeLimit.ts";
import { isGroupedCreatorThread, isThreadPlacementReleaseCommand } from "./CreatorGrouping.ts";
import type { OrchestrationEffectRequestV2, PendingOrchestrationEffectV2 } from "./EffectOutbox.ts";
import type {
  OrchestratorDispatchError,
  OrchestratorProjectionError,
  OrchestratorThreadArchivingError,
  OrchestratorV2DispatchResult,
  OrchestratorV2Error,
} from "./Orchestrator.ts";
import type { ProjectionStoreV2Shape, ProjectionStoreV2Error } from "./ProjectionStore.ts";
import {
  archiveRepairNeedsConfirmation,
  hasUnfinishedArchiveWork,
  hasUnreadArchiveResponse,
} from "./ThreadArchivePolicy.ts";

type EventBuffer = Ref.Ref<Array<OrchestrationV2DomainEvent>>;
type EffectBuffer = Ref.Ref<Array<PendingOrchestrationEffectV2>>;
type LastCodeArchiveCommand = Extract<
  OrchestrationV2ServerCommand,
  {
    readonly type:
      | "thread.archive"
      | "thread.archive.complete"
      | "thread.archive.fail"
      | "thread.unarchive";
  }
>;
type LastCodeArchiveFamilyCommand =
  | LastCodeArchiveCommand
  | Extract<OrchestrationV2ServerCommand, { readonly type: "thread.delete" }>;
type CancelUnsettledEffects = {
  readonly effectTypes: ReadonlyArray<OrchestrationEffectRequestV2["type"]>;
  readonly threadIds?: ReadonlyArray<ThreadId>;
  readonly reason: string;
};
type ArchiveEffect<A = void> = Effect.Effect<A, OrchestratorV2Error>;
type WithLock = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;

interface LastCodeArchivePlannerPorts {
  readonly environmentId?: EnvironmentId;

  readonly reader: {
    readonly store: Pick<
      ProjectionStoreV2Shape,
      | "getThread"
      | "getThreadShell"
      | "getThreadRecords"
      | "getThreadProviderContext"
      | "getThreadLatestAssistantMessageAt"
      | "getOwnedThreadIds"
      | "getGroupedCreatorThreadIds"
    >;
    readonly ownedThreadFamily: (
      command: OrchestrationV2ServerCommand,
    ) => ArchiveEffect<ReadonlyArray<ThreadId>>;
    readonly readArchiveFamilyShells: (
      threadId: ThreadId,
    ) => ArchiveEffect<ReadonlyArray<OrchestrationV2ThreadShell>>;
    readonly archiveFamilyShells: (
      command: OrchestrationV2ServerCommand,
    ) => ArchiveEffect<ReadonlyArray<OrchestrationV2ThreadShell>>;
    readonly readArchiveFamilyParentThreadId: (
      command: OrchestrationV2ServerCommand,
      thread: OrchestrationV2ThreadShell | OrchestrationV2AppThread,
    ) => ArchiveEffect<ThreadId | null>;
    readonly archiveThreadPolicy: (thread: OrchestrationV2ThreadShell) => Effect.Effect<
      {
        readonly unfinished: boolean;
        readonly unread: boolean;
        readonly requiresConfirmation: boolean;
      },
      ProjectionStoreV2Error
    >;
    readonly liveSideChatIds: (threadId: ThreadId) => ArchiveEffect<ReadonlyArray<ThreadId>>;
  };
  readonly locks: {
    readonly withPersistenceLock: WithLock;
    readonly withDeletionLock: WithLock;
    readonly withThreadDispatchLocks: <A, E, R>(
      ids: Iterable<ThreadId>,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | OrchestratorV2Error, R>;
  };
  readonly admission: {
    readonly admitNewExecution: <A>(
      command: OrchestrationV2ServerCommand,
      kind: "thread-archive" | "thread-delete",
      effect: ArchiveEffect<A>,
    ) => ArchiveEffect<A>;
    readonly refuseAboveDispatchModeLimit: (
      command: OrchestrationV2ServerCommand,
      threadId: ThreadId,
      modes: DispatchModes,
    ) => ArchiveEffect;
  };
  readonly mutation: {
    readonly emit: (
      events: EventBuffer,
      command: OrchestrationV2ServerCommand,
    ) => <Event extends OrchestrationV2DomainEvent>(
      event: Omit<Event, "id">,
    ) => ArchiveEffect<Event>;
    readonly dispatchThreadMutation: (
      command: Extract<
        OrchestrationV2Command,
        { readonly type: "thread.archive" | "thread.unarchive" }
      >,
      events: EventBuffer,
      effects: EffectBuffer,
      archiveOwner?: NonNullable<OrchestrationV2AppThread["archivedWith"]>,
    ) => ArchiveEffect<unknown>;
    readonly getProjectionWithPendingEvents: (
      threadId: ThreadId,
      events: EventBuffer,
    ) => ArchiveEffect<OrchestrationV2ThreadProjection>;
    readonly markStoppedRun: (input: {
      readonly command: Extract<OrchestrationV2ServerCommand, { readonly type: "thread.stop" }>;
      readonly events: EventBuffer;
      readonly thread: OrchestrationV2AppThread;
      readonly run: OrchestrationV2Run;
      readonly now: DateTime.Utc;
    }) => ArchiveEffect;
    readonly awaitsRestartContinuation: (
      run: OrchestrationV2Run,
    ) => Effect.Effect<boolean, import("./EffectOutbox.ts").EffectOutboxError>;
    readonly disposeAllDelegatedCompletionCohorts: (input: {
      readonly command: OrchestrationV2Command;
      readonly events: EventBuffer;
      readonly projection: OrchestrationV2ThreadProjection;
      readonly now: DateTime.Utc;
    }) => ArchiveEffect<unknown>;
    readonly releaseGuestAttachments: (
      command: Pick<OrchestrationV2ServerCommand, "commandId"> & { readonly threadId: ThreadId },
      before: OrchestrationV2AppThread["guestShare"],
      after: OrchestrationV2AppThread["guestShare"],
      effects: EffectBuffer,
    ) => Effect.Effect<void>;
    readonly clearPullRequestWatch: (link: ThreadPullRequestLink) => ThreadPullRequestLink;
  };
  // Keep error identity and receipt classification owned by the ordinary dispatcher.
  readonly errors: {
    readonly OrchestratorDispatchError: typeof OrchestratorDispatchError;
    readonly OrchestratorProjectionError: typeof OrchestratorProjectionError;
    readonly OrchestratorThreadArchivingError: typeof OrchestratorThreadArchivingError;
  };
  readonly commandThreadId: (command: OrchestrationV2ServerCommand) => ThreadId;
}

/** Plans into the caller's buffers; the normal dispatcher owns receipts and commit. */
export function makeLastCodeArchivePlanner(ports: LastCodeArchivePlannerPorts) {
  const {
    store: projectionStore,
    ownedThreadFamily,
    archiveFamilyShells,
    readArchiveFamilyShells,
    readArchiveFamilyParentThreadId,
    archiveThreadPolicy,
    liveSideChatIds,
  } = ports.reader;
  const { withThreadDispatchLocks } = ports.locks;
  const threadDispatch = ports.locks;
  const { admitNewExecution, refuseAboveDispatchModeLimit } = ports.admission;
  const {
    emit,
    dispatchThreadMutation,
    getProjectionWithPendingEvents,
    markStoppedRun,
    awaitsRestartContinuation,
    disposeAllDelegatedCompletionCohorts,
    releaseGuestAttachments,
    clearPullRequestWatch,
  } = ports.mutation;
  const {
    OrchestratorDispatchError,
    OrchestratorProjectionError,
    OrchestratorThreadArchivingError,
  } = ports.errors;
  const { commandThreadId } = ports;
  const mapDispatchError =
    (command: Pick<OrchestrationV2ServerCommand, "commandId" | "type">) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, OrchestratorDispatchError, R> =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new OrchestratorDispatchError({
              commandId: command.commandId,
              commandType: command.type,
              cause,
            }),
        ),
      );

  const recordedParentOf = (thread: OrchestrationV2ThreadShell | OrchestrationV2AppThread) => {
    if (ports.environmentId === undefined) return null;
    const owner = getThreadOwner(thread, ports.environmentId);
    return owner?.environmentId === ports.environmentId ? owner.threadId : null;
  };

  const selectArchiveFamily = (
    shells: ReadonlyArray<OrchestrationV2ThreadShell>,
    rootId: ThreadId,
  ) => {
    const family = getOwnedThreadFamily(shells, rootId, recordedParentOf);
    const typedInThreadIds = family.children
      .filter(
        (thread) => recordedParentOf(thread) !== null && thread.latestUserAuthoredMessageAt != null,
      )
      .map((thread) => thread.id);
    const typedInBranchIds = new Set(
      typedInThreadIds.flatMap((id) => [
        id,
        ...getOwnedThreadFamily(shells, id, recordedParentOf).children.map((thread) => thread.id),
      ]),
    );
    typedInBranchIds.delete(rootId);
    const legacyIds = new Set(getOwnedThreadFamily(shells, rootId).children.map(({ id }) => id));
    const widened = family.children.filter(({ id }) => !legacyIds.has(id));
    const expanded = widened.length > 0;
    if (!expanded && typedInThreadIds.length === 0)
      return {
        ...family,
        typedInThreadIds,
        keptThreadIds: typedInBranchIds,
        keptWithTypedInThreadIds: new Set<ThreadId>(),
        expanded,
      };

    const familyIds = new Set(family.children.map(({ id }) => id));
    const groups = shells.filter(
      (group) =>
        group.id !== rootId &&
        group.groupThread === true &&
        group.archivedAt === null &&
        group.deletedAt === null &&
        (familyIds.has(group.id) ||
          widened.some(
            (child) =>
              child.projectId === group.projectId &&
              getInteractiveThreadParentThreadId(child) === group.id,
          )),
    );
    const groupIds = new Set(groups.map(({ id }) => id));
    const emptyGroupCandidates = groups
      .filter(
        (group) =>
          group.lineage.independent !== true &&
          group.persistent !== true &&
          group.workspaceUserAdopted !== true &&
          group.actionResume?.outcome !== "running" &&
          (group.archivePending?.status !== "failed" || group.archivePending.threadId === rootId) &&
          group.latestRunId === null &&
          group.latestUserMessageAt === null &&
          group.latestVisibleMessage === null,
      )
      .map((group) => ({
        id: group.id,
        members: shells
          .filter(
            (thread) =>
              thread.archivedAt === null &&
              thread.deletedAt === null &&
              (getArchiveFamilyParentThreadId(thread, group) === group.id ||
                recordedParentOf(thread) === group.id),
          )
          .map(({ id }) => id),
      }));
    const selectedWith = (kept: ReadonlySet<ThreadId>) => {
      const selected = new Set([
        rootId,
        ...family.children.flatMap(({ id }) => (!groupIds.has(id) && !kept.has(id) ? [id] : [])),
      ]);
      // A container may itself be the last live member of another container.
      let previousSize: number;
      do {
        previousSize = selected.size;
        for (const { id, members } of emptyGroupCandidates)
          if (!kept.has(id) && members.every((member) => selected.has(member))) selected.add(id);
      } while (selected.size !== previousSize);
      return selected;
    };
    const selectedWithTypedIn = selectedWith(new Set());
    const selectedByDefault = selectedWith(typedInBranchIds);
    const children = [
      ...family.children,
      ...groups.filter(({ id }) => !familyIds.has(id) && selectedWithTypedIn.has(id)),
    ];
    return {
      ...family,
      children,
      typedInThreadIds,
      keptThreadIds: new Set(
        children.filter(({ id }) => !selectedByDefault.has(id)).map(({ id }) => id),
      ),
      keptWithTypedInThreadIds: new Set(
        children.filter(({ id }) => !selectedWithTypedIn.has(id)).map(({ id }) => id),
      ),
      expanded,
    };
  };

  const getThreadArchiveFamily = Effect.fn("LastCodeArchivePlanner.getThreadArchiveFamily")(
    function* (
      threadId: ThreadId,
    ): Effect.fn.Return<OrchestrationV2ThreadArchiveFamily, OrchestratorV2Error> {
      const shells = yield* readArchiveFamilyShells(threadId);
      const family = selectArchiveFamily(shells, threadId);
      const owner = shells.find((thread) => thread.id === threadId);
      const threads = owner === undefined ? [...family.children] : [owner, ...family.children];
      const hasArchivePreview = family.expanded || family.typedInThreadIds.length > 0;
      if (hasArchivePreview) {
        const familyIds = new Set(threads.map(({ id }) => id));
        const sideChats = yield* archivableSideChats(threadId).pipe(
          Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause })),
        );
        for (const { id } of sideChats) {
          if (familyIds.has(id)) continue;
          const shell = yield* projectionStore
            .getThreadShell(id)
            .pipe(Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause })));
          if (shell !== null) threads.push(shell);
        }
      }
      const archiveCandidates = threads.filter(({ id }) => !family.keptThreadIds.has(id));
      const activity = yield* Effect.forEach(threads, (thread) =>
        archiveThreadPolicy(thread).pipe(
          Effect.map((policy) => ({ id: thread.id, ...policy })),
          Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause })),
        ),
      );
      const activeThreadIds = activity.filter((entry) => entry.unfinished).map((entry) => entry.id);
      const unreadThreadIds = activity.filter((entry) => entry.unread).map((entry) => entry.id);
      const protectedChildThreadIds = threads
        .filter(({ id, persistent }) => id !== threadId && persistent === true)
        .map(({ id }) => id);
      const protectedArchiveCandidate = protectedChildThreadIds.some(
        (id) => !family.keptThreadIds.has(id),
      );
      return {
        threads,
        ...(hasArchivePreview && ports.environmentId !== undefined
          ? {
              archivePreview: {
                environmentId: ports.environmentId,
                typedInThreadIds: family.typedInThreadIds,
                ...(family.keptWithTypedInThreadIds.size > 0
                  ? { keptWithTypedInThreadIds: [...family.keptWithTypedInThreadIds] }
                  : {}),
                threads: threads.map(({ id, projectId, title }) => ({
                  threadId: id,
                  projectId,
                  title,
                })),
              },
            }
          : {}),
        childThreadIds: family.children.map(({ id }) => id),
        activeThreadIds,
        unreadThreadIds,
        activeChildThreadIds: activeThreadIds.filter((id) =>
          family.children.some((child) => child.id === id),
        ),
        promotableChildThreadIds: [],
        keptThreadIds: [...family.keptThreadIds],
        protectedChildThreadIds,
        nativeStopCount: archiveCandidates.filter(
          ({ id, creationSource }) => id !== threadId && creationSource === "provider",
        ).length,
        requiresConfirmation:
          hasArchivePreview ||
          activity.some((entry) => entry.requiresConfirmation) ||
          protectedArchiveCandidate,
        canPromote: false,
        canStopAndArchive: owner?.persistent !== true && !protectedArchiveCandidate,
      };
    },
  );

  const WORKSPACE_PREPARATION_INPUT = "Preparing workspace";

  // An already archived intermediate owner retains its own restore cohort.
  const archiveOwnerFor = Effect.fnUntraced(function* (
    command: OrchestrationV2ServerCommand,
    thread: OrchestrationV2AppThread,
    family: ReadonlyMap<ThreadId, OrchestrationV2AppThread>,
    owner: NonNullable<OrchestrationV2AppThread["archivedWith"]>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) {
    const visited = new Set<ThreadId>();
    const parentOf = (thread: OrchestrationV2AppThread) =>
      getArchiveFamilyParentThreadId(
        thread,
        family.get(getInteractiveThreadParentThreadId(thread)!),
      );
    let ancestorId = parentOf(thread);
    while (ancestorId !== null && ancestorId !== owner.threadId && !visited.has(ancestorId)) {
      visited.add(ancestorId);
      const ancestor = family.get(ancestorId);
      if (ancestor === undefined) break;
      if (ancestor.archivedAt !== null) {
        const archivedWith = ancestor.archivedWith ?? {
          threadId: ancestor.id,
          commandId: owner.commandId,
        };
        if (ancestor.archivedWith == null) {
          const now = yield* DateTime.now;
          yield* emit(
            events,
            command,
          )({
            type: "thread.metadata-updated",
            threadId: ancestor.id,
            occurredAt: now,
            payload: { ...ancestor, archivedWith, updatedAt: now },
          });
        }
        return archivedWith;
      }
      ancestorId = parentOf(ancestor);
    }
    return owner;
  });

  const planArchivedFamilyRepair = Effect.fnUntraced(function* (
    command: Extract<OrchestrationV2Command, { readonly type: "thread.archive" }>,
    root: OrchestrationV2AppThread,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
  ) {
    const threads = yield* Effect.forEach(yield* ownedThreadFamily(command), (id) =>
      projectionStore.getThread(id).pipe(mapDispatchError(command)),
    );
    const legacyIds = new Set(getOwnedThreadFamily(threads, root.id).children.map(({ id }) => id));
    const participants = threads.filter(({ id }) => legacyIds.has(id));
    if (participants.length === 0) return;
    const owner = root.archivedWith ?? { threadId: root.id, commandId: command.commandId };
    yield* dispatchThreadMutation(command, events, effects, owner);
    const family = new Map(threads.map((thread) => [thread.id, thread]));
    for (const child of participants) {
      const childOwner = yield* archiveOwnerFor(command, child, family, owner, events);
      yield* dispatchThreadMutation(
        { ...command, threadId: child.id },
        events,
        effects,
        childOwner,
      );
    }
  });

  const repairArchivedFamily = Effect.fnUntraced(function* (
    command: Extract<OrchestrationV2Command, { readonly type: "thread.archive" }>,
    root: OrchestrationV2AppThread,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
  ) {
    if (command.childDisposition !== undefined || command.expectedChildThreadIds !== undefined) {
      yield* dispatchArchiveFamilyRequest(command, events, effects, true);
      return;
    }
    const originallyOwned = new Set(
      yield* projectionStore.getOwnedThreadIds(root.id).pipe(mapDispatchError(command)),
    );
    const shells = yield* archiveFamilyShells(command);
    const family = selectArchiveFamily(shells, root.id);
    if (family.expanded || family.typedInThreadIds.length > 0)
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: "Review the archive family before repairing it.",
      });
    for (const thread of family.children) {
      const policy = yield* archiveThreadPolicy(thread).pipe(mapDispatchError(command));
      if (archiveRepairNeedsConfirmation(policy, originallyOwned.has(thread.id)))
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause:
            "This family has unfinished work or unread replies. Review the archive confirmation before repairing it.",
        });
    }
    // Preserve the ordinary repair's protection and unfinished-work guards.
    // Its plan remains uncommitted until provider shutdown is known to be safe.
    const plannedEvents = yield* Ref.make<Array<OrchestrationV2DomainEvent>>([]);
    const plannedEffects = yield* Ref.make<Array<PendingOrchestrationEffectV2>>([]);
    yield* planArchivedFamilyRepair(command, root, plannedEvents, plannedEffects);
    const contexts = yield* Effect.forEach(family.children, (child) =>
      projectionStore
        .getThreadRecords(child.id, ["providerSessions", "providerThreads"])
        .pipe(mapDispatchError(command)),
    );
    const needsShutdown = contexts.some(
      (context) =>
        context.providerSessions.length > 0 ||
        context.providerThreads.some(
          (thread) => thread.appThreadId === context.thread.id && thread.providerSessionId !== null,
        ),
    );
    if (needsShutdown) {
      yield* dispatchArchiveFamilyRequest(
        {
          ...command,
          childDisposition: command.childDisposition ?? "stop_and_archive",
          expectedChildThreadIds:
            command.expectedChildThreadIds ?? family.children.map((child) => child.id),
        },
        events,
        effects,
        true,
      );
    } else {
      const acceptedEvents = yield* Ref.get(plannedEvents);
      const acceptedEffects = yield* Ref.get(plannedEffects);
      yield* Ref.update(events, (current) => [...current, ...acceptedEvents]);
      yield* Ref.update(effects, (current) => [...current, ...acceptedEffects]);
    }
  });

  const sameThreadIds = (left: ReadonlyArray<ThreadId>, right: ReadonlyArray<ThreadId>) => {
    if (left.length !== right.length || new Set(left).size !== left.length) return false;
    const rightIds = new Set(right);
    return rightIds.size === right.length && left.every((id) => rightIds.has(id));
  };

  const archiveParticipants = (
    threads: ReadonlyArray<OrchestrationV2ThreadShell>,
    rootId: ThreadId,
    disposition: NonNullable<ReturnType<typeof getThreadArchivePlan>>["childDisposition"],
    options?: { readonly includeTypedInThreadIds?: ReadonlyArray<ThreadId> | undefined },
  ) => {
    const legacy = getOwnedThreadFamily(threads, rootId);
    const modern = options === undefined ? undefined : selectArchiveFamily(threads, rootId);
    const family = modern ?? legacy;
    const retained =
      disposition === "promote"
        ? legacy.keptThreadIds
        : ((options?.includeTypedInThreadIds === undefined
            ? modern?.keptThreadIds
            : modern?.keptWithTypedInThreadIds) ?? new Set<ThreadId>());
    return {
      family,
      archiveIds: [
        rootId,
        ...family.children.filter((child) => !retained.has(child.id)).map((child) => child.id),
      ],
      promoteIds:
        disposition === "promote" ? legacy.promotableChildren.map((child) => child.id) : [],
    };
  };

  const readSideChats = (threadId: ThreadId) =>
    liveSideChatIds(threadId).pipe(
      Effect.flatMap((ids) =>
        Effect.forEach(ids, (id) => projectionStore.getThreadRecords(id, ["subagents"])),
      ),
    );

  const archivableSideChats = (threadId: ThreadId) =>
    readSideChats(threadId).pipe(
      Effect.map((chats) =>
        chats.flatMap(({ thread, subagents }) =>
          thread.archivedAt === null &&
          thread.deletedAt === null &&
          !subagents.some(
            (task) =>
              task.origin === "app_owned" &&
              task.childThreadId !== null &&
              isOrchestrationV2WorkActive(task.status),
          )
            ? [thread]
            : [],
        ),
      ),
    );

  const cancelArchiveWork = Effect.fnUntraced(function* (
    command: OrchestrationV2ServerCommand,
    threadId: ThreadId,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    now: DateTime.Utc,
  ) {
    const projection = yield* getProjectionWithPendingEvents(threadId, events);
    const emitEvent = emit(events, command);
    const preparingRunIds = new Set(
      projection.runs.filter((run) => run.status === "preparing").map((run) => run.id),
    );
    const activeItems = yield* projectionStore
      .getThreadRecords(threadId, ["turnItems"], {
        turnItemStatuses: ["pending", "running", "waiting"],
      })
      .pipe(mapDispatchError(command));
    const backgroundRunIds = new Set(
      pendingBackgroundTurnItems({
        turnItems: activeItems.turnItems,
        runs: projection.runs,
      }).flatMap((item) => (item.runId === null ? [] : [item.runId])),
    );
    for (const providerThread of projection.providerThreads) {
      if (
        providerThread.appThreadId !== threadId ||
        (providerThread.pendingBackgroundTasks?.length ?? 0) === 0
      )
        continue;
      const ownerRun = projection.runs.findLast(
        (run) => run.status !== "queued" && run.providerThreadId === providerThread.id,
      );
      if (ownerRun !== undefined) backgroundRunIds.add(ownerRun.id);
    }
    for (const run of projection.runs) {
      const unfinished = ["preparing", "starting", "running", "waiting"].includes(run.status);
      if (
        unfinished ||
        backgroundRunIds.has(run.id) ||
        (run.status === "cancelled" &&
          (yield* awaitsRestartContinuation(run).pipe(mapDispatchError(command))))
      )
        yield* markStoppedRun({
          command: {
            type: "thread.stop",
            commandId: command.commandId,
            threadId,
            reason: "Thread archived.",
          },
          events,
          thread: projection.thread,
          run,
          now,
        });
      if (run.status !== "queued" && !unfinished) continue;
      yield* emitEvent({
        type: "run.updated",
        threadId,
        runId: run.id,
        occurredAt: now,
        payload: {
          ...run,
          status: "cancelled",
          queuePosition: null,
          queueHeld: true,
          completedAt: now,
        },
      });
    }
    for (const attempt of projection.attempts) {
      if (!["pending", "running"].includes(attempt.status)) continue;
      yield* emitEvent({
        type: "run-attempt.updated",
        threadId,
        runId: attempt.runId,
        occurredAt: now,
        payload: { ...attempt, status: "cancelled", completedAt: now },
      });
    }
    for (const node of projection.nodes) {
      if (!["pending", "running", "waiting"].includes(node.status)) continue;
      yield* emitEvent({
        type: "node.updated",
        threadId,
        nodeId: node.id,
        occurredAt: now,
        payload: { ...node, status: "cancelled", completedAt: now },
      });
    }
    for (const request of projection.runtimeRequests) {
      if (request.status !== "pending") continue;
      yield* emitEvent({
        type: "runtime-request.updated",
        threadId,
        nodeId: request.nodeId,
        occurredAt: now,
        payload: { ...request, status: "cancelled", resolvedAt: now },
      });
    }
    for (const item of activeItems.turnItems) {
      if (!["pending", "running", "waiting"].includes(item.status)) continue;
      yield* emitEvent({
        type: "turn-item.updated",
        threadId,
        occurredAt: now,
        payload: {
          ...item,
          status: "cancelled",
          title:
            item.runId !== null &&
            preparingRunIds.has(item.runId) &&
            item.type === "command_execution" &&
            item.input === WORKSPACE_PREPARATION_INPUT
              ? "Workspace preparation cancelled"
              : item.title,
          completedAt: now,
          updatedAt: now,
        },
      });
    }
    yield* disposeAllDelegatedCompletionCohorts({
      command: command as OrchestrationV2Command,
      events,
      projection: yield* getProjectionWithPendingEvents(threadId, events),
      now,
    });
  });

  const dispatchArchiveFamilyRequest = Effect.fnUntraced(function* (
    command: Extract<OrchestrationV2Command, { readonly type: "thread.archive" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
    archivedRepair = false,
  ) {
    const shells = yield* archiveFamilyShells(command);
    const root = yield* projectionStore.getThread(command.threadId).pipe(mapDispatchError(command));
    const selection = selectArchiveFamily(shells, root.id);
    const familyIds = new Set([root.id, ...selection.children.map(({ id }) => id)]);
    const sideChats = (yield* archivableSideChats(root.id).pipe(mapDispatchError(command))).filter(
      ({ id }) => !familyIds.has(id),
    );
    const allIds = [...familyIds, ...sideChats.map(({ id }) => id)];
    const defaultIds = allIds.filter((id) => !selection.keptThreadIds.has(id));
    const withTypedInIds = allIds.filter((id) => !selection.keptWithTypedInThreadIds.has(id));
    const expected = command.expectedArchiveThreadIds;
    const includeTypedIn =
      selection.typedInThreadIds.length > 0 &&
      expected !== undefined &&
      command.includeTypedInThreadIds !== undefined &&
      sameThreadIds(command.includeTypedInThreadIds, selection.typedInThreadIds) &&
      sameThreadIds(expected, withTypedInIds) &&
      (command.childDisposition === "archive_after_review" ||
        command.childDisposition === "stop_and_archive");
    const family = selection;
    const archiveIds = includeTypedIn ? withTypedInIds : defaultIds;
    const archiveIdSet = new Set(archiveIds);
    const reject = (cause: string) =>
      new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause,
      });
    if (
      root.creationSource === "provider" &&
      root.lineage.relationshipToParent === "subagent" &&
      root.lineage.independent !== true &&
      root.lineage.parentThreadId !== null
    ) {
      const nativeShell = shells.find((thread) => thread.id === root.id);
      const ownerShell = yield* projectionStore
        .getThreadShell(root.lineage.parentThreadId)
        .pipe(mapDispatchError(command));
      const ownerContext = yield* projectionStore
        .getThreadProviderContext(root.lineage.parentThreadId)
        .pipe(mapDispatchError(command));
      const activeStatuses = ["preparing", "starting", "running", "waiting"];
      if (
        activeStatuses.includes(nativeShell?.status ?? "idle") ||
        activeStatuses.includes(ownerShell?.activityRunStatus ?? ownerShell?.status ?? "idle") ||
        ownerContext.providerSessions.some((session) => activeStatuses.includes(session.status))
      )
        return yield* reject(
          "Archive the parent thread to stop and archive this running native subagent.",
        );
    }
    if (root.deletedAt !== null || (root.archivedAt !== null && !archivedRepair))
      return yield* reject("This conversation is no longer available to archive.");
    if (
      !includeTypedIn &&
      (command.includeTypedInThreadIds !== undefined ||
        ((selection.expanded || selection.typedInThreadIds.length > 0 || expected !== undefined) &&
          (expected === undefined || !sameThreadIds(expected, defaultIds))))
    )
      return yield* reject(
        "Review the archive preview again. Pass expectedArchiveThreadIds excluding keptThreadIds. To include threads the user wrote in, confirm typedInThreadIds and exclude keptWithTypedInThreadIds instead.",
      );
    if (
      family.children.length > 0 &&
      (command.childDisposition === undefined || command.expectedChildThreadIds === undefined)
    )
      return yield* reject(
        "Confirm archiving this conversation and its grouped conversations and subagents.",
      );
    if (
      command.expectedChildThreadIds !== undefined &&
      !sameThreadIds(
        command.expectedChildThreadIds,
        family.children.map((child) => child.id),
      )
    )
      return yield* reject(
        "The conversation family changed. Review the archive confirmation again.",
      );
    if (
      root.persistent === true ||
      [...shells, ...sideChats].some(
        (thread) => archiveIdSet.has(thread.id) && thread.persistent === true,
      )
    )
      return yield* reject(
        "A protected conversation cannot be archived. Remove its protection or make it independent first.",
      );
    if (
      [...shells, ...sideChats].some(
        (thread) => archiveIdSet.has(thread.id) && thread.archivePending?.status === "stopping",
      )
    )
      return yield* reject("A conversation in this family is already being archived.");
    // An idle snapshot is not consent to stop work that appeared before this
    // command. Recheck under the family locks before recording any shutdown.
    if (
      command.childDisposition === "archive_if_idle" ||
      command.childDisposition === "archive_after_review"
    ) {
      const sideChatShells = yield* Effect.forEach(sideChats, ({ id }) =>
        projectionStore.getThreadShell(id).pipe(mapDispatchError(command)),
      );
      const participants = [
        ...shells.filter((thread) => archiveIdSet.has(thread.id) && familyIds.has(thread.id)),
        ...sideChatShells,
      ];
      for (const thread of participants) {
        if (thread === null)
          return yield* reject(
            "This family now has work that needs attention. Review the archive choices again.",
          );
        const policy = yield* archiveThreadPolicy(thread).pipe(mapDispatchError(command));
        if (policy.unfinished || (command.childDisposition === "archive_if_idle" && policy.unread))
          return yield* reject(
            "This family now has work that needs attention. Review the archive choices again.",
          );
      }
    }
    // Shutdown and ownership release complete after this command. Check every
    // target while the requesting caller's limit is in scope, before stopping.
    for (const thread of [...shells.filter((shell) => archiveIdSet.has(shell.id)), ...sideChats]) {
      yield* refuseAboveDispatchModeLimit(command, thread.id, thread);
    }
    const context = yield* projectionStore
      .getThreadProviderContext(command.threadId)
      .pipe(mapDispatchError(command));
    const controls = yield* projectionStore
      .getThreadRecords(
        command.threadId,
        ["runs", "runtimeRequests", "providerThreads", "providerTurns", "turnItems", "subagents"],
        { turnItemStatuses: ["pending", "running", "waiting"] },
      )
      .pipe(mapDispatchError(command));
    const unfinished = hasUnfinishedArchiveWork(controls);
    if (
      family.children.length === 0 &&
      unfinished &&
      command.childDisposition !== "stop_and_archive"
    )
      return yield* reject("This conversation has unfinished work. Stop it before archiving.");
    const rootShell = shells.find((thread) => thread.id === root.id);
    if (
      command.childDisposition === undefined &&
      rootShell !== undefined &&
      hasUnreadArchiveResponse(
        rootShell,
        yield* projectionStore
          .getThreadLatestAssistantMessageAt(root.id)
          .pipe(mapDispatchError(command)),
      )
    )
      return yield* reject(
        "This conversation has unread replies. Review the archive confirmation first.",
      );
    if (
      !archivedRepair &&
      archiveIds.length === 1 &&
      family.children.length === 0 &&
      context.providerSessions.length === 0 &&
      !controls.providerThreads.some(
        (providerThread) =>
          providerThread.appThreadId === command.threadId &&
          providerThread.providerSessionId !== null,
      ) &&
      !unfinished
    ) {
      yield* dispatchThreadMutation(command, events, effects);
      return;
    }
    const now = yield* DateTime.now;
    const modeLimit = yield* DispatchModeLimit;
    const pending = {
      threadId: command.threadId,
      commandId: command.commandId,
      familyVersion:
        selection.expanded || selection.typedInThreadIds.length > 0 ? (2 as const) : (1 as const),
      ...(includeTypedIn ? { includeTypedInThreadIds: selection.typedInThreadIds } : {}),
      childDisposition: command.childDisposition ?? "stop_and_archive",
      childThreadIds: family.children.map((child) => child.id),
      archiveThreadIds: archiveIds,
      promoteThreadIds: [],
      ...(modeLimit === undefined
        ? {}
        : {
            modeLimit: {
              runtimeMode: modeLimit.runtimeMode,
              interactionMode: modeLimit.interactionMode,
            },
          }),
      status: "stopping" as const,
    };
    const previous = getThreadArchivePlan(root.archivePending);
    if (previous?.familyVersion === 2 && previous.status === "failed") {
      for (const id of previous.archiveThreadIds) {
        if (archiveIdSet.has(id)) continue;
        const thread = yield* projectionStore.getThread(id).pipe(mapDispatchError(command));
        if (
          thread.archivePending?.threadId !== root.id ||
          thread.archivePending.commandId !== previous.commandId ||
          thread.archivePending.status !== "failed"
        )
          continue;
        yield* emit(
          events,
          command,
        )({
          type: "thread.metadata-updated",
          threadId: id,
          occurredAt: now,
          payload: { ...thread, archivePending: null, updatedAt: now },
        });
      }
    }
    for (const id of archiveIds) {
      const thread = yield* projectionStore.getThread(id).pipe(mapDispatchError(command));
      yield* emit(
        events,
        command,
      )({
        type: "thread.metadata-updated",
        threadId: id,
        occurredAt: now,
        payload: {
          ...thread,
          archivePending:
            id === command.threadId
              ? pending
              : {
                  threadId: pending.threadId,
                  commandId: pending.commandId,
                  status: pending.status,
                },
          titleRegeneration: null,
          pullRequests: thread.pullRequests?.map((link) => clearPullRequestWatch(link)),
          updatedAt: now,
        },
      });
      yield* cancelArchiveWork(command, id, events, now);
    }
    yield* Ref.update(effects, (current) => [
      ...current,
      {
        id: `effect:${command.commandId}:thread.archive`,
        commandId: command.commandId,
        threadId: command.threadId,
        request: { type: "thread.archive", requestId: command.commandId },
      } satisfies PendingOrchestrationEffectV2,
    ]);
  });

  const dispatchArchiveFamilyResult = Effect.fnUntraced(function* (
    command: Extract<
      OrchestrationV2InternalCommand,
      { readonly type: "thread.archive.complete" | "thread.archive.fail" }
    >,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
  ) {
    const root = yield* projectionStore.getThread(command.threadId).pipe(mapDispatchError(command));
    const pending = getThreadArchivePlan(root.archivePending);
    const now = yield* DateTime.now;
    if (pending?.commandId !== command.requestId || pending.status !== "stopping") {
      yield* emit(
        events,
        command,
      )({ type: "thread.metadata-updated", threadId: root.id, occurredAt: now, payload: root });
      return;
    }
    // Deployed plans used delegated ownership, before ordinary conversation
    // groups joined archive families. Recheck their original edge semantics,
    // so unrelated creator groups do not change old consent.
    const legacyOwnedThreadIds =
      command.type === "thread.archive.complete" &&
      (pending.familyVersion === undefined || pending.childDisposition === "promote")
        ? yield* projectionStore.getOwnedThreadIds(root.id).pipe(mapDispatchError(command))
        : null;
    const legacyParticipants = new Set<ThreadId>();
    if (command.type === "thread.archive.complete") {
      const shells = yield* archiveFamilyShells(command);
      if (pending.familyVersion === 2)
        for (const { id } of getOwnedThreadFamily(shells, root.id).children)
          legacyParticipants.add(id);
      const legacyOwnedIds = legacyOwnedThreadIds === null ? null : new Set(legacyOwnedThreadIds);
      if (
        pending.includeTypedInThreadIds !== undefined &&
        !sameThreadIds(
          pending.includeTypedInThreadIds,
          selectArchiveFamily(shells, root.id).typedInThreadIds,
        )
      )
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: "Human participation changed while stopping. Review the archive choices again.",
        });
      const current = archiveParticipants(
        legacyOwnedIds === null ? shells : shells.filter((thread) => legacyOwnedIds.has(thread.id)),
        root.id,
        pending.childDisposition,
        pending.familyVersion === 2 ? pending : undefined,
      );
      const explicitIds = new Set([root.id, ...pending.childThreadIds]);
      const selectedSideChatIds = new Set(
        pending.archiveThreadIds.filter((id) => !explicitIds.has(id)),
      );
      // A chat initially skipped for active delegated work stays outside this operation.
      const currentSideChatIds =
        pending.familyVersion === undefined || selectedSideChatIds.size === 0
          ? []
          : (yield* archivableSideChats(root.id).pipe(mapDispatchError(command))).flatMap(
              (thread) =>
                selectedSideChatIds.has(thread.id) &&
                thread.archivePending?.commandId === pending.commandId &&
                thread.archivePending.threadId === root.id &&
                thread.archivePending.status === "stopping"
                  ? [thread.id]
                  : [],
            );
      // Retained branches may keep delegating during shutdown. Consent still
      // covers them as long as neither the stopped set nor promoted roots change.
      if (
        !sameThreadIds(
          [...new Set([...current.archiveIds, ...currentSideChatIds])],
          pending.archiveThreadIds,
        ) ||
        !sameThreadIds(current.promoteIds, pending.promoteThreadIds)
      )
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: "The subagents changed while stopping. Review the archive choices again.",
        });
      if (pending.modeLimit !== undefined) {
        for (const id of new Set([
          root.id,
          ...current.archiveIds,
          ...current.promoteIds,
          ...currentSideChatIds,
        ])) {
          const participant = yield* projectionStore.getThread(id).pipe(mapDispatchError(command));
          yield* refuseAboveDispatchModeLimit(command, id, participant).pipe(
            Effect.provideService(DispatchModeLimit, pending.modeLimit),
          );
        }
      }
    }
    const resultIds =
      command.type === "thread.archive.fail"
        ? [
            ...new Set([
              ...pending.archiveThreadIds,
              ...(yield* archiveFamilyShells(command))
                .filter((thread) => thread.archivePending?.commandId === command.requestId)
                .map((thread) => thread.id),
            ]),
          ]
        : pending.archiveThreadIds;
    const familyThreads = new Map(
      (yield* Effect.forEach(legacyOwnedThreadIds ?? (yield* ownedThreadFamily(command)), (id) =>
        projectionStore.getThread(id).pipe(mapDispatchError(command)),
      )).map((thread) => [thread.id, thread]),
    );
    for (const id of resultIds) {
      const thread = yield* projectionStore.getThread(id).pipe(mapDispatchError(command));
      if (thread.archivePending?.commandId !== command.requestId) continue;
      if (command.type === "thread.archive.fail") {
        yield* emit(
          events,
          command,
        )({
          type: "thread.metadata-updated",
          threadId: id,
          occurredAt: now,
          payload: {
            ...thread,
            archivePending: { ...thread.archivePending, status: "failed", error: command.error },
            updatedAt: now,
          },
        });
        continue;
      }
      yield* cancelArchiveWork(command, id, events, now);
      const afterCancel = yield* getProjectionWithPendingEvents(id, events);
      for (const task of afterCancel.subagents) {
        if (task.childThreadId !== null && pending.promoteThreadIds.includes(task.childThreadId))
          continue;
        if (!["pending", "running", "waiting"].includes(task.status)) continue;
        yield* emit(
          events,
          command,
        )({
          type: "subagent.updated",
          threadId: id,
          nodeId: task.id,
          occurredAt: now,
          payload: { ...task, status: "cancelled", completedAt: now, updatedAt: now },
        });
      }
      for (const providerThread of afterCancel.providerThreads)
        if (
          providerThread.appThreadId === id &&
          ((providerThread.pendingBackgroundTasks?.length ?? 0) > 0 ||
            (providerThread.owedBackgroundResults?.length ?? 0) > 0)
        )
          yield* emit(
            events,
            command,
          )({
            type: "provider-thread.updated",
            threadId: id,
            occurredAt: now,
            payload: {
              ...providerThread,
              pendingBackgroundTasks: [],
              owedBackgroundResults: [],
              updatedAt: now,
            },
          });
      for (const turn of afterCancel.providerTurns)
        if (turn.status === "running" || turn.status === "pending")
          yield* emit(
            events,
            command,
          )({
            type: "provider-turn.updated",
            threadId: id,
            occurredAt: now,
            payload: { ...turn, status: "cancelled", completedAt: now },
          });
      const current = (yield* getProjectionWithPendingEvents(id, events)).thread;
      const owner = root.archivedWith ?? { threadId: root.id, commandId: command.requestId };
      const archivedWith =
        pending.familyVersion === 2 && !legacyParticipants.has(id)
          ? owner
          : yield* archiveOwnerFor(command, current, familyThreads, owner, events);
      yield* emit(
        events,
        command,
      )({
        type: "thread.archived",
        threadId: id,
        occurredAt: now,
        payload: {
          ...current,
          archivedAt: current.archivedAt ?? now,
          archivedWith,
          archivePending: null,
          guestShare: null,
          updatedAt: now,
        },
      });
      yield* releaseGuestAttachments(
        { ...command, threadId: id },
        current.guestShare,
        null,
        effects,
      );
      yield* Ref.update(effects, (existing) => [
        ...existing,
        {
          id: `effect:${command.commandId}:${id}:terminal.archive-cleanup`,
          commandId: command.commandId,
          threadId: id,
          request: { type: "terminal.archive-cleanup" },
        } satisfies PendingOrchestrationEffectV2,
      ]);
    }
    if (command.type === "thread.archive.complete") {
      const archivedIds = new Set(pending.archiveThreadIds);
      const promotedIds = new Set(pending.promoteThreadIds);
      for (const id of promotedIds) {
        const thread = yield* projectionStore.getThread(id).pipe(mapDispatchError(command));
        yield* emit(
          events,
          command,
        )({
          type: "thread.metadata-updated",
          threadId: id,
          occurredAt: now,
          payload: {
            ...thread,
            lineage: { ...thread.lineage, independent: true },
            groupedUnderThreadId: null,
            // Independent roots must not reuse their former parent's sidebar slot.
            pinnedAt: null,
            pinOrderKey: null,
            activeOrderKey: null,
            ...(thread.archivePending?.status === "failed" &&
            thread.archivePending.threadId === root.id
              ? { archivePending: null }
              : {}),
            updatedAt: now,
          },
        });
        const parent = yield* getProjectionWithPendingEvents(root.id, events);
        for (const task of parent.subagents.filter(
          (task) => task.origin === "app_owned" && task.childThreadId === id,
        ))
          yield* emit(
            events,
            command,
          )({
            type: "subagent.updated",
            threadId: root.id,
            nodeId: task.id,
            occurredAt: now,
            payload: {
              ...task,
              ownershipReleased: true,
              completionDelivery: { state: "disposed", observedByRunId: null },
              updatedAt: now,
            },
          });
      }
      // A failed stop can mark the whole branch. Releasing that branch also
      // releases its obsolete retry owner, without clearing a separate failure.
      for (const thread of familyThreads.values()) {
        if (
          archivedIds.has(thread.id) ||
          promotedIds.has(thread.id) ||
          thread.archivedAt !== null ||
          thread.deletedAt !== null ||
          thread.archivePending?.status !== "failed" ||
          thread.archivePending.threadId !== root.id
        )
          continue;
        yield* emit(
          events,
          command,
        )({
          type: "thread.metadata-updated",
          threadId: thread.id,
          occurredAt: now,
          payload: { ...thread, archivePending: null, updatedAt: now },
        });
      }
    }
  });

  const dispatchUnarchiveFamily = Effect.fnUntraced(function* (
    command: Extract<OrchestrationV2Command, { readonly type: "thread.unarchive" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
  ) {
    const root = yield* projectionStore.getThread(command.threadId).pipe(mapDispatchError(command));
    const cohort = root.archivedWith;
    const sideChats = (yield* readSideChats(root.id).pipe(mapDispatchError(command))).map(
      ({ thread }) => thread,
    );
    const failedArchive = getThreadArchivePlan(root.archivePending);
    if (command.expectedArchiveCommandId !== undefined) {
      if (
        root.archivedAt !== null ||
        root.deletedAt !== null ||
        failedArchive?.status !== "failed" ||
        failedArchive.threadId !== root.id ||
        failedArchive.commandId !== command.expectedArchiveCommandId
      )
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause:
            root.archivedAt !== null
              ? "This thread family is already archived. Restore it from Settings > Archived threads."
              : "This failed archive changed. Review the conversation before dismissing it.",
        });
      const now = yield* DateTime.now;
      const participants =
        failedArchive.familyVersion === 2
          ? yield* Effect.forEach(new Set([root.id, ...failedArchive.archiveThreadIds]), (id) =>
              projectionStore.getThread(id).pipe(mapDispatchError(command)),
            )
          : [
              root,
              ...new Map(
                [...(yield* archiveFamilyShells(command)), ...sideChats]
                  .filter((thread) => thread.id !== root.id)
                  .map((thread) => [thread.id, thread]),
              ).values(),
            ];
      for (const participant of participants) {
        if (
          participant.archivedAt !== null ||
          participant.deletedAt !== null ||
          participant.archivePending?.status !== "failed" ||
          participant.archivePending.threadId !== root.id ||
          participant.archivePending.commandId !== failedArchive.commandId
        )
          continue;
        const thread = yield* projectionStore
          .getThread(participant.id)
          .pipe(mapDispatchError(command));
        yield* emit(
          events,
          command,
        )({
          type: "thread.metadata-updated",
          threadId: thread.id,
          occurredAt: now,
          payload: { ...thread, archivePending: null, updatedAt: now },
        });
      }
      return;
    }
    const familyParentId =
      (cohort?.threadId === root.id ? null : recordedParentOf(root)) ??
      (yield* readArchiveFamilyParentThreadId(command, root));
    if (familyParentId !== null) {
      const owner = yield* projectionStore
        .getThreadShell(familyParentId)
        .pipe(mapDispatchError(command));
      if (owner?.archivedAt != null && owner.deletedAt === null)
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: "Restore the parent thread to reopen this family",
        });
    }
    let restoreAsRoot = false;
    if (cohort !== undefined && cohort !== null && cohort.threadId !== root.id) {
      const parent = yield* projectionStore
        .getThreadShell(cohort.threadId)
        .pipe(mapDispatchError(command));
      // A detached interactive branch restores by current placement, not its old archive owner.
      restoreAsRoot =
        parent === null ||
        parent.deletedAt !== null ||
        (familyParentId === null && !isOwnedSubagentThread(root));
      if (!restoreAsRoot && parent?.archivedAt != null)
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: "Restore the parent thread to reopen this family",
        });
    }
    yield* dispatchThreadMutation(command, events, effects);
    if (failedArchive?.status === "failed" && failedArchive.threadId === root.id) {
      const now = yield* DateTime.now;
      // A failed repair leaves live participants outside the original restore cohort.
      const participants = new Map(
        [...(yield* archiveFamilyShells(command)), ...sideChats].map((thread) => [
          thread.id,
          thread,
        ]),
      );
      for (const child of participants.values()) {
        if (
          child.id === root.id ||
          child.archivedAt !== null ||
          child.deletedAt !== null ||
          child.archivePending?.status !== "failed" ||
          child.archivePending.threadId !== root.id ||
          child.archivePending.commandId !== failedArchive.commandId
        )
          continue;
        const thread = yield* projectionStore.getThread(child.id).pipe(mapDispatchError(command));
        yield* emit(
          events,
          command,
        )({
          type: "thread.metadata-updated",
          threadId: child.id,
          occurredAt: now,
          payload: { ...thread, archivePending: null, updatedAt: now },
        });
      }
    }
    const restoredSideChats = new Set<ThreadId>();
    if (root.archivedAt !== null) {
      for (const child of sideChats) {
        if (
          child.archivedAt === null ||
          child.deletedAt !== null ||
          DateTime.toEpochMillis(child.archivedAt) < DateTime.toEpochMillis(root.archivedAt)
        )
          continue;
        const owner = child.archivedWith;
        const followsParent =
          cohort == null
            ? owner == null
            : owner?.threadId === cohort.threadId && owner.commandId === cohort.commandId;
        if (!followsParent) continue;
        yield* dispatchThreadMutation({ ...command, threadId: child.id }, events, effects);
        restoredSideChats.add(child.id);
      }
    }
    if (cohort == null || (!restoreAsRoot && cohort.threadId !== root.id)) return;
    const shells = yield* archiveFamilyShells(command);
    const survivingBranch = restoreAsRoot
      ? new Set(
          getOwnedThreadFamily(
            shells
              .filter(
                (thread) =>
                  thread.archivedWith?.threadId === cohort.threadId &&
                  thread.archivedWith.commandId === cohort.commandId,
              )
              .map((thread) => ({ ...thread, archivedAt: null })),
            root.id,
            recordedParentOf,
          ).children.map((thread) => thread.id),
        )
      : null;
    if (restoreAsRoot) {
      const restored = (yield* getProjectionWithPendingEvents(root.id, events)).thread;
      yield* emit(
        events,
        command,
      )({
        type: "thread.metadata-updated",
        threadId: root.id,
        occurredAt: restored.updatedAt,
        payload: {
          ...restored,
          groupedUnderThreadId: null,
          ...(restored.creatorGrouping === "grouped"
            ? { creatorGrouping: "independent" as const }
            : {}),
          ...(isOwnedSubagentThread(restored)
            ? { lineage: { ...restored.lineage, independent: true } }
            : {}),
          pinnedAt: null,
          pinOrderKey: null,
          activeOrderKey: null,
        },
      });
    }
    for (const child of shells) {
      if (
        child.id === root.id ||
        restoredSideChats.has(child.id) ||
        child.archivedAt === null ||
        child.deletedAt !== null ||
        child.archivedWith?.threadId !== cohort.threadId ||
        child.archivedWith.commandId !== cohort.commandId ||
        (survivingBranch !== null && !survivingBranch.has(child.id))
      )
        continue;
      yield* dispatchThreadMutation({ ...command, threadId: child.id }, events, effects);
    }
  });

  const plan = Effect.fnUntraced(function* (
    command: LastCodeArchiveCommand,
    events: EventBuffer,
    effects: EffectBuffer,
  ): Effect.fn.Return<CancelUnsettledEffects | undefined, OrchestratorV2Error> {
    switch (command.type) {
      case "thread.archive": {
        const root = yield* projectionStore
          .getThread(command.threadId)
          .pipe(
            Effect.mapError(
              (cause) => new OrchestratorProjectionError({ threadId: command.threadId, cause }),
            ),
          );
        if (command.expectedArchiveCommandId !== undefined) {
          const failedArchive = getThreadArchivePlan(root.archivePending);
          if (
            root.deletedAt !== null ||
            failedArchive?.status !== "failed" ||
            failedArchive.threadId !== root.id ||
            failedArchive.commandId !== command.expectedArchiveCommandId
          )
            return yield* new OrchestratorDispatchError({
              commandId: command.commandId,
              commandType: command.type,
              cause: "This failed archive changed. Review the conversation before retrying it.",
            });
        }
        if (root.deletedAt !== null)
          return yield* new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: "This conversation is no longer available to archive.",
          });
        if (root.archivedAt !== null) {
          yield* repairArchivedFamily(command, root, events, effects);
        } else yield* dispatchArchiveFamilyRequest(command, events, effects);
        const pending = (yield* Ref.get(events)).find(
          (event) =>
            event.type === "thread.metadata-updated" && event.threadId === command.threadId,
        );
        if (
          pending?.type === "thread.metadata-updated" &&
          getThreadArchivePlan(pending.payload.archivePending)?.status === "stopping"
        ) {
          return {
            threadIds: getThreadArchivePlan(pending.payload.archivePending)!.archiveThreadIds,
            effectTypes: [
              "provider-turn.start",
              "provider-turn.restart",
              "provider-runtime.continue",
              "provider-turn.steer",
              "runtime-request.respond",
              "thread-title.generate",
              "prepared-run.auto-retry",
            ],
            reason: "Thread family is stopping before archive.",
          };
        }
        return undefined;
      }
      case "thread.archive.complete":
      case "thread.archive.fail":
        yield* dispatchArchiveFamilyResult(command, events, effects);
        return undefined;
      case "thread.unarchive":
        yield* dispatchUnarchiveFamily(command, events, effects);
        return undefined;
    }
  });

  const guardCommand = Effect.fnUntraced(function* (command: OrchestrationV2ServerCommand) {
    const allowedWhileArchiving =
      isThreadPlacementReleaseCommand(command) ||
      command.type === "thread.stop" ||
      command.type === "thread.visit" ||
      command.type === "thread.archive.complete" ||
      command.type === "thread.archive.fail" ||
      command.type === "thread.background-work.settle" ||
      // These completions only settle retained metadata; they start no provider work.
      command.type === "message.incoming-summary.complete" ||
      (command.type === "message.dispatch" && command.usageLimitContinuationOfRunId !== undefined);
    if (!allowedWhileArchiving && command.type !== "thread.create") {
      const current = yield* projectionStore
        .getThread(commandThreadId(command))
        .pipe(
          Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeed(null) }),
          mapDispatchError(command),
        );
      if (
        current?.archivePending?.status === "stopping" &&
        (current.deletedAt === null || current.worktreeCleanup != null) &&
        // Only settle an Action already admitted before the hold. Publishing the
        // initial state admits a new terminal command, so it must remain blocked.
        !(
          command.type === "thread.metadata.update" &&
          command.actionResume != null &&
          current.actionResume?.runId === command.actionResume.runId &&
          Object.keys(command).every((key) =>
            ["type", "commandId", "threadId", "actionResume"].includes(key),
          )
        )
      ) {
        return yield* new OrchestratorThreadArchivingError({
          commandId: command.commandId,
          commandType: command.type,
          threadId: current.id,
        });
      }
    }
  });

  const guardParticipants = Effect.fnUntraced(function* (
    command: OrchestrationV2ServerCommand,
    planned: {
      readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
      readonly effects: ReadonlyArray<PendingOrchestrationEffectV2>;
    },
    participantLimit: DispatchModes | undefined,
  ) {
    if (
      command.type !== "thread.archive.complete" &&
      command.type !== "thread.archive" &&
      command.type !== "thread.unarchive" &&
      command.type !== "thread.delete"
    )
      return;
    // The family locks cover every planned mutation and cleanup owner.
    // Check actual participants so an independent archive cannot block
    // an operation that leaves it unchanged.
    const participants = new Set([
      ...planned.events.map((event) => event.threadId),
      ...planned.effects.map((effect) => effect.threadId),
    ]);
    const effectOwners = new Set(planned.effects.map((effect) => effect.threadId));
    const otherMutationOwners = new Set(
      planned.events
        .filter(
          (event) =>
            event.type !== "thread.metadata-updated" || event.payload.groupedUnderThreadId !== null,
        )
        .map((event) => event.threadId),
    );
    for (const threadId of participants) {
      const thread = yield* projectionStore.getThread(threadId).pipe(mapDispatchError(command));
      const releasesPlacementOnly =
        isGroupedCreatorThread(thread) &&
        !effectOwners.has(threadId) &&
        !otherMutationOwners.has(threadId);
      if (
        command.type === "thread.delete" &&
        thread.archivePending?.status === "failed" &&
        !releasesPlacementOnly
      )
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause:
            "This thread is part of a failed archive, so retry or dismiss that archive before deleting the thread.",
        });
      if (
        command.type !== "thread.archive.complete" &&
        thread.archivePending?.status === "stopping" &&
        !releasesPlacementOnly
      )
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause:
            "A conversation in this family is still stopping before archive. Wait for its archive to finish.",
        });
      if (participantLimit !== undefined)
        yield* refuseAboveDispatchModeLimit(command, threadId, thread).pipe(
          Effect.provideService(DispatchModeLimit, participantLimit),
        );
    }
  });

  const dispatchFamily = Effect.fn("LastCodeArchivePlanner.dispatchFamily")(function* (
    command: LastCodeArchiveFamilyCommand,
    dispatchAccepted: (
      sideChatIds: ReadonlyArray<ThreadId>,
    ) => Effect.Effect<OrchestratorV2DispatchResult, OrchestratorV2Error>,
  ): Effect.fn.Return<OrchestratorV2DispatchResult, OrchestratorV2Error> {
    const recollectAndDispatch = (): Effect.Effect<
      OrchestratorV2DispatchResult,
      OrchestratorV2Error
    > =>
      threadDispatch
        .withPersistenceLock(
          Effect.gen(function* () {
            const family = yield* ownedThreadFamily(command);
            const sideChatIds = yield* liveSideChatIds(command.threadId);
            const root = yield* projectionStore
              .getThreadShell(command.threadId)
              .pipe(mapDispatchError(command));
            const creatorIds = [
              ...family,
              ...sideChatIds,
              ...(getThreadArchivePlan(root?.archivePending)?.archiveThreadIds ?? []),
            ];
            const groupedChildren =
              command.type === "thread.delete"
                ? yield* projectionStore
                    .getGroupedCreatorThreadIds(creatorIds)
                    .pipe(mapDispatchError(command))
                : [];
            const familyParentId =
              root == null
                ? null
                : (recordedParentOf(root) ??
                  (yield* readArchiveFamilyParentThreadId(command, root)));
            const ids = [
              ...new Set([
                ...family,
                ...sideChatIds,
                ...groupedChildren,
                ...(root?.archivedWith == null ? [] : [root.archivedWith.threadId]),
                ...(getThreadArchivePlan(root?.archivePending)?.archiveThreadIds ?? []),
                ...(getThreadArchivePlan(root?.archivePending)?.promoteThreadIds ?? []),
                ...(familyParentId === null ? [] : [familyParentId]),
              ]),
            ].toSorted();
            const decide = Effect.gen(function* () {
              const currentFamily = yield* ownedThreadFamily(command);
              // Creation holds its parent lock. If a child arrived while locks were
              // acquired, release and collect the expanded family before deciding.
              if (currentFamily.some((id) => !ids.includes(id))) return null;
              const currentSideChatIds = yield* liveSideChatIds(command.threadId);
              if (currentSideChatIds.some((id) => !ids.includes(id))) return null;
              const currentGroupedChildren =
                command.type === "thread.delete"
                  ? yield* projectionStore
                      .getGroupedCreatorThreadIds([...currentFamily, ...creatorIds])
                      .pipe(mapDispatchError(command))
                  : [];
              if (currentGroupedChildren.some((id) => !ids.includes(id))) return null;
              return yield* dispatchAccepted(currentSideChatIds);
            });
            return yield* withThreadDispatchLocks(ids, decide);
          }),
        )
        .pipe(Effect.filterOrElse((result) => result !== null, recollectAndDispatch));
    const dispatch =
      command.type === "thread.delete"
        ? threadDispatch.withDeletionLock(recollectAndDispatch())
        : recollectAndDispatch();
    if (command.type !== "thread.archive" && command.type !== "thread.delete")
      return yield* dispatch;
    // Admission precedes persistence/family locks and holds through durable effects.
    return yield* admitNewExecution(
      command,
      command.type === "thread.archive" ? "thread-archive" : "thread-delete",
      dispatch,
    );
  });

  return {
    getThreadArchiveFamily,
    plan,
    guardCommand,
    guardParticipants,
    dispatchFamily,
    isFamilyCommand: (
      command: OrchestrationV2ServerCommand,
    ): command is LastCodeArchiveFamilyCommand =>
      command.type === "thread.archive" ||
      command.type === "thread.archive.complete" ||
      command.type === "thread.archive.fail" ||
      command.type === "thread.unarchive" ||
      command.type === "thread.delete",
  };
}
