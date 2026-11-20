import {
  getThreadArchivePlan,
  isOrchestrationV2WorkActive,
  linkOriginIsFenced,
  type CommandId,
  type EnvironmentId,
  EventId,
  type IsoDateTime,
  type OrchestrationV2AppThread,
  type OrchestrationV2ServerCommand,
  type ThreadArchiveOperation,
  type OrchestrationV2ThreadShell,
  type ThreadArchivePeerGuard,
  type ThreadId,
} from "@t3tools/contracts";
import { getThreadOwner } from "@t3tools/shared/threadOwnership";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { clientModeCeiling, type McpClientCaller } from "../mcp/McpInvocationContext.ts";
import { DispatchModeLimit, type DispatchModes } from "./DispatchModeLimit.ts";
import type { OrchestratorDispatchError, OrchestratorV2Error } from "./Orchestrator.ts";
import {
  emptyProjection,
  threadShellFromProjection,
  type ProjectionStoreV2Error,
  type ProjectionStoreV2Shape,
} from "./ProjectionStore.ts";

type OwnerScope = Pick<ThreadArchivePeerGuard, "ownerEnvironmentId" | "ownerThreadIds">;

export interface PeerArchiveCommittedThread {
  readonly threadId: ThreadId;
  readonly archivedAt: IsoDateTime;
  readonly archivedWith: NonNullable<OrchestrationV2AppThread["archivedWith"]>;
}

type PeerArchiveCaller = OwnerScope & { readonly client: McpClientCaller };
export type PeerArchiveDispatchInput =
  | (PeerArchiveCaller & {
      readonly kind: "archive";
      readonly selectedThreadIds: readonly ThreadId[];
      readonly typedIn: ThreadArchivePeerGuard["typedIn"];
    })
  | (PeerArchiveCaller & {
      readonly kind: "restore";
      /** Exact transitions from the destination's committed archive events. */
      readonly committed: readonly PeerArchiveCommittedThread[];
    });

/** Only the authenticated server handler may supply this context around a dispatch. */
export const PeerArchiveDispatch = Context.Reference<PeerArchiveDispatchInput | undefined>(
  "t3/orchestration-v2/PeerArchiveDispatch",
  { defaultValue: () => undefined },
);

type LinkAuthority = Pick<ThreadArchivePeerGuard, "linkSessionId" | "linkAccess">;
type Rows = ReadonlyMap<ThreadId, OrchestrationV2ThreadShell | null>;
type Reject<E> = (cause: string) => E;

const peerArchiveGuard = (
  input: Extract<PeerArchiveDispatchInput, { kind: "archive" }>,
): ThreadArchivePeerGuard => ({
  ownerEnvironmentId: input.ownerEnvironmentId,
  ownerThreadIds: input.ownerThreadIds,
  linkSessionId: input.client.sessionId,
  linkAccess: input.client.access,
  typedIn: input.typedIn,
});

const isMatchingPeerArchiveTransition = (
  thread: OrchestrationV2ThreadShell | null | undefined,
  committed: PeerArchiveCommittedThread,
) =>
  thread != null &&
  thread.deletedAt === null &&
  thread.archivePending == null &&
  thread.archivedAt !== null &&
  DateTime.formatIso(thread.archivedAt) === committed.archivedAt &&
  thread.archivedWith?.threadId === committed.archivedWith.threadId &&
  thread.archivedWith.commandId === committed.archivedWith.commandId;

const readPeerArchiveRows = Effect.fnUntraced(function* <E>(
  environmentId: EnvironmentId | undefined,
  ids: readonly ThreadId[],
  read: (id: ThreadId) => Effect.Effect<OrchestrationV2ThreadShell | null, E>,
  follow: (thread: OrchestrationV2ThreadShell) => boolean,
) {
  const rows = new Map<ThreadId, OrchestrationV2ThreadShell | null>();
  const get = Effect.fnUntraced(function* (id: ThreadId) {
    if (rows.has(id)) return rows.get(id) ?? null;
    const row = yield* read(id);
    rows.set(id, row);
    return row;
  });
  const visited = new Set<ThreadId>();
  for (const id of ids) {
    let thread = yield* get(id);
    if (thread === null || !follow(thread) || environmentId === undefined) continue;
    while (thread !== null && !visited.has(thread.id)) {
      visited.add(thread.id);
      const owner = getThreadOwner(thread, environmentId);
      if (owner?.environmentId !== environmentId) break;
      thread = yield* get(owner.threadId);
    }
  }
  return rows;
});

const peerArchiveChanged = "The linked archive selection changed. Review it again.";
const peerArchiveDenied = "The linked archive is outside this peer session's access.";

function reachableOwnerPath(
  destination: EnvironmentId,
  scope: OwnerScope,
  sourceIds: ReadonlySet<ThreadId>,
  anchor: ThreadId,
  target: ThreadId,
  rows: Rows,
) {
  const path = new Map<ThreadId, OrchestrationV2ThreadShell>();
  let id = target;
  while (!path.has(id)) {
    const thread = rows.get(id);
    if (thread == null || thread.lineage.sideChat === true) return null;
    path.set(id, thread);
    const owner = getThreadOwner(thread, destination);
    if (owner === null) return null;
    if (owner.environmentId === destination) {
      id = owner.threadId;
      continue;
    }
    return owner.environmentId === scope.ownerEnvironmentId &&
      sourceIds.has(owner.threadId) &&
      path.has(anchor)
      ? path
      : null;
  }
  return null;
}

const checkScope = <E>(
  destination: EnvironmentId | undefined,
  scope: OwnerScope,
  link: LinkAuthority,
  reject: Reject<E>,
): Effect.Effect<EnvironmentId, E> => {
  if (link.linkAccess === "read-only" || link.linkSessionId.trim().length === 0)
    return Effect.fail(reject(peerArchiveDenied));
  if (
    destination === undefined ||
    scope.ownerEnvironmentId === destination ||
    scope.ownerThreadIds.length === 0 ||
    new Set(scope.ownerThreadIds).size !== scope.ownerThreadIds.length
  )
    return Effect.fail(reject(peerArchiveChanged));
  return Effect.succeed(destination);
};

const authorizeTarget = <E>(
  thread: OrchestrationV2ThreadShell,
  link: LinkAuthority,
  limit: DispatchModes,
  checkMode: (thread: OrchestrationV2ThreadShell) => Effect.Effect<void, E>,
  reject: Reject<E>,
): Effect.Effect<void, E> =>
  linkOriginIsFenced({ sessionId: link.linkSessionId, access: link.linkAccess, label: "" }) &&
  thread.linkOrigin?.sessionId !== link.linkSessionId
    ? Effect.fail(reject(peerArchiveDenied))
    : checkMode(thread).pipe(Effect.provideService(DispatchModeLimit, limit));

const validatePeerArchive = Effect.fnUntraced(function* <E>(input: {
  readonly destination: EnvironmentId | undefined;
  readonly guard: ThreadArchivePeerGuard;
  readonly modeLimit: DispatchModes;
  readonly anchor: ThreadId;
  readonly selected: readonly ThreadId[];
  readonly rows: Rows;
  readonly completedShutdown?: CommandId;
  readonly retryOf?: CommandId;
  readonly checkMode: (thread: OrchestrationV2ThreadShell) => Effect.Effect<void, E>;
  readonly reject: Reject<E>;
}) {
  const { guard, rows, selected, anchor, reject, completedShutdown, retryOf } = input;
  const destination = yield* checkScope(input.destination, guard, guard, reject);
  const ids = new Set(selected);
  const evidence = new Map(guard.typedIn.map((row) => [row.threadId, row.latestHumanMessageAt]));
  if (!ids.has(anchor) || ids.size !== selected.length || evidence.size !== guard.typedIn.length)
    return yield* Effect.fail(reject(peerArchiveChanged));

  const expectedRequest = completedShutdown ?? retryOf;
  if (retryOf !== undefined) {
    const prior = getThreadArchivePlan(rows.get(anchor)?.archivePending);
    if (
      prior?.peer?.ownerEnvironmentId !== guard.ownerEnvironmentId ||
      prior.peer.linkSessionId !== guard.linkSessionId ||
      prior.archiveThreadIds.length !== ids.size ||
      new Set(prior.archiveThreadIds).size !== ids.size ||
      prior.archiveThreadIds.some((id) => !ids.has(id))
    )
      return yield* Effect.fail(reject(peerArchiveChanged));
  }

  const sources = new Set(guard.ownerThreadIds);
  const checkedEvidence = new Set<ThreadId>();
  const threads: Array<{ thread: OrchestrationV2ThreadShell; depth: number }> = [];
  for (const id of ids) {
    const path = reachableOwnerPath(destination, guard, sources, anchor, id, rows);
    const thread = path?.get(id);
    if (
      path === null ||
      thread === undefined ||
      thread.deletedAt !== null ||
      thread.archivedAt !== null ||
      thread.persistent === true ||
      (expectedRequest === undefined
        ? thread.archivePending != null
        : thread.archivePending?.threadId !== anchor ||
          thread.archivePending.commandId !== expectedRequest ||
          thread.archivePending.status !==
            (completedShutdown === undefined ? "failed" : "stopping"))
    )
      return yield* Effect.fail(reject(peerArchiveChanged));

    for (const owner of path.values()) {
      if (checkedEvidence.has(owner.id)) continue;
      const latest = owner.latestUserAuthoredMessageAt;
      const expected = evidence.get(owner.id);
      if (latest == null ? expected !== undefined : DateTime.formatIso(latest) !== expected)
        return yield* Effect.fail(reject(peerArchiveChanged));
      checkedEvidence.add(owner.id);
    }
    yield* authorizeTarget(thread, guard, input.modeLimit, input.checkMode, reject);
    threads.push({ thread, depth: path.size });
  }
  if ([...evidence.keys()].some((id) => !checkedEvidence.has(id)))
    return yield* Effect.fail(reject(peerArchiveChanged));
  return threads.sort((left, right) => left.depth - right.depth).map(({ thread }) => thread);
});

const validatePeerRestore = Effect.fnUntraced(function* <E>(input: {
  readonly destination: EnvironmentId | undefined;
  readonly archive: Extract<PeerArchiveDispatchInput, { kind: "restore" }>;
  readonly anchor: ThreadId;
  readonly rows: Rows;
  readonly checkMode: (thread: OrchestrationV2ThreadShell) => Effect.Effect<void, E>;
  readonly reject: Reject<E>;
}) {
  const { archive, anchor, rows, reject } = input;
  const link = { linkSessionId: archive.client.sessionId, linkAccess: archive.client.access };
  const destination = yield* checkScope(input.destination, archive, link, reject);
  const sources = new Set(archive.ownerThreadIds);
  const committed = archive.committed;
  const archiveCommandId = committed[0]?.archivedWith.commandId;
  if (
    archive.client.linked !== true ||
    committed.length === 0 ||
    new Set(committed.map(({ threadId }) => threadId)).size !== committed.length ||
    committed.some(
      ({ archivedWith }) =>
        archivedWith.threadId !== anchor || archivedWith.commandId !== archiveCommandId,
    )
  )
    return yield* Effect.fail(reject(peerArchiveChanged));

  const ids: ThreadId[] = [];
  for (const entry of committed) {
    const thread = rows.get(entry.threadId);
    if (thread == null || !isMatchingPeerArchiveTransition(thread, entry)) continue;
    if (reachableOwnerPath(destination, archive, sources, anchor, entry.threadId, rows) === null)
      return yield* Effect.fail(reject(peerArchiveChanged));
    yield* authorizeTarget(
      thread,
      link,
      clientModeCeiling(archive.client),
      input.checkMode,
      reject,
    );
    ids.push(thread.id);
  }
  return ids;
});
type LastCodeArchiveCommand = Extract<
  OrchestrationV2ServerCommand,
  {
    readonly type:
      | "thread.archive"
      | "thread.unarchive"
      | "thread.archive.complete"
      | "thread.archive.fail";
  }
>;

export function makePeerArchiveDispatch(ports: {
  readonly destination: EnvironmentId | undefined;
  readonly store: Pick<
    ProjectionStoreV2Shape,
    "getThread" | "getThreadShell" | "getThreadProviderContext" | "getThreadRecords"
  >;
  readonly checkMode: (
    command: LastCodeArchiveCommand,
    threadId: ThreadId,
    thread: DispatchModes,
  ) => Effect.Effect<void, OrchestratorV2Error>;
  readonly policy: (
    thread: OrchestrationV2ThreadShell,
  ) => Effect.Effect<
    { readonly unfinished: boolean; readonly unread: boolean },
    ProjectionStoreV2Error
  >;
  readonly mapDispatchError: (
    command: LastCodeArchiveCommand,
  ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, OrchestratorDispatchError, R>;
  readonly reject: (command: LastCodeArchiveCommand, cause: string) => OrchestratorDispatchError;
}) {
  const peerScope = (command: LastCodeArchiveCommand) => ({
    destination: ports.destination,
    anchor: command.threadId,
    checkMode: (thread: OrchestrationV2ThreadShell) => ports.checkMode(command, thread.id, thread),
    reject: (cause: string) => ports.reject(command, cause),
  });

  const peerRows = (
    command: LastCodeArchiveCommand,
    ids: readonly ThreadId[],
    follow: (thread: OrchestrationV2ThreadShell) => boolean = () => true,
  ) =>
    readPeerArchiveRows(
      ports.destination,
      [command.threadId, ...ids],
      (id) =>
        Effect.gen(function* () {
          const shell = yield* ports.store.getThreadShell(id);
          if (shell !== null) return shell;
          const record = yield* ports.store
            .getThread(id)
            .pipe(
              Effect.catchTag("ProjectionStoreThreadNotFoundError", () => Effect.succeed(null)),
            );
          return record?.deletedAt == null
            ? null
            : threadShellFromProjection(
                emptyProjection({
                  id: EventId.make(`peer-archive-owner:${id}`),
                  type: "thread.created",
                  threadId: id,
                  occurredAt: record.updatedAt,
                  payload: record,
                }),
              );
        }).pipe(ports.mapDispatchError(command)),
      follow,
    );

  const restoreRows = (
    command: Extract<LastCodeArchiveCommand, { type: "thread.unarchive" }>,
    restore: Extract<PeerArchiveDispatchInput, { kind: "restore" }>,
  ) => {
    const expected = new Map(restore.committed.map((entry) => [entry.threadId, entry]));
    return peerRows(command, [...expected.keys()], (thread) => {
      const entry = expected.get(thread.id);
      return entry !== undefined && isMatchingPeerArchiveTransition(thread, entry);
    });
  };

  const prepareArchive = Effect.fnUntraced(function* (
    command: Extract<LastCodeArchiveCommand, { type: "thread.archive" }>,
    archive: Extract<PeerArchiveDispatchInput, { kind: "archive" }>,
  ) {
    const scope = peerScope(command);
    if (archive.client.linked !== true)
      return yield* scope.reject("A linked archive requires an authenticated peer session.");
    if (
      command.childDisposition === undefined ||
      command.expectedChildThreadIds !== undefined ||
      command.expectedArchiveThreadIds !== undefined ||
      command.includeTypedInThreadIds !== undefined ||
      command.savedWorkspace !== undefined
    )
      return yield* scope.reject("Use the reviewed linked archive selection and disposition.");

    const peer = peerArchiveGuard(archive);
    const modeLimit = clientModeCeiling(archive.client);
    const rows = yield* peerRows(command, archive.selectedThreadIds);
    const participants = yield* validatePeerArchive({
      ...scope,
      guard: peer,
      modeLimit,
      rows,
      selected: archive.selectedThreadIds,
      ...(command.expectedArchiveCommandId === undefined
        ? {}
        : { retryOf: command.expectedArchiveCommandId }),
    });
    const selected = new Set(archive.selectedThreadIds);
    for (const thread of participants) {
      // A native mirror may share a running runtime with an unselected owner.
      const parentId = thread.lineage.parentThreadId;
      if (
        thread.creationSource === "provider" &&
        thread.lineage.relationshipToParent === "subagent" &&
        parentId !== null &&
        !selected.has(parentId)
      ) {
        const parent = rows.get(parentId);
        if (parent == null || parent.deletedAt !== null)
          return yield* scope.reject("The native subagent no longer has its reviewed owner.");
        const ownerContext = yield* ports.store
          .getThreadProviderContext(parentId)
          .pipe(ports.mapDispatchError(command));
        const active = ["preparing", "starting", "running", "waiting"];
        if (
          active.includes(thread.status) ||
          active.includes(parent.activityRunStatus ?? parent.status) ||
          ownerContext.providerSessions.some((session) => active.includes(session.status))
        )
          return yield* scope.reject(
            "Include the parent thread to stop and archive this running native subagent.",
          );
      }
      const { subagents } = yield* ports.store
        .getThreadRecords(thread.id, ["subagents"], { omitSettledSubagents: true })
        .pipe(ports.mapDispatchError(command));
      if (
        subagents.some(
          (task) =>
            task.origin === "provider_native" &&
            isOrchestrationV2WorkActive(task.status) &&
            (task.childThreadId === null || !selected.has(task.childThreadId)),
        )
      )
        return yield* scope.reject(
          "A linked conversation shares its provider runtime with unselected native work.",
        );
      if (command.childDisposition === "stop_and_archive") continue;
      const policy = yield* ports.policy(thread).pipe(ports.mapDispatchError(command));
      if (policy.unfinished || (command.childDisposition === "archive_if_idle" && policy.unread))
        return yield* scope.reject(
          "A linked conversation has work that needs attention. Review the archive choices again.",
        );
    }
    return {
      threadId: command.threadId,
      commandId: command.commandId,
      familyVersion: 2,
      childDisposition: command.childDisposition,
      childThreadIds: archive.selectedThreadIds.filter((id) => id !== command.threadId),
      archiveThreadIds: participants.map(({ id }) => id),
      promoteThreadIds: [],
      peer,
      modeLimit,
      status: "stopping",
    } satisfies typeof ThreadArchiveOperation.Type;
  });

  const validateCompletion = Effect.fnUntraced(function* (
    command: Extract<LastCodeArchiveCommand, { type: "thread.archive.complete" }>,
    pending: typeof ThreadArchiveOperation.Type,
    guard: ThreadArchivePeerGuard,
  ) {
    const scope = peerScope(command);
    if (pending.threadId !== command.threadId || pending.modeLimit === undefined)
      return yield* scope.reject("The linked archive shutdown plan is incomplete.");
    yield* validatePeerArchive({
      ...scope,
      guard,
      modeLimit: pending.modeLimit,
      selected: pending.archiveThreadIds,
      rows: yield* peerRows(command, pending.archiveThreadIds),
      completedShutdown: command.requestId,
    });
  });

  const restoreThreadIds = Effect.fnUntraced(function* (
    command: Extract<LastCodeArchiveCommand, { type: "thread.unarchive" }>,
    restore: Extract<PeerArchiveDispatchInput, { kind: "restore" }>,
  ) {
    const scope = peerScope(command);
    if (command.expectedArchiveCommandId !== undefined)
      return yield* scope.reject("A linked restore requires exact committed archive transitions.");
    return yield* validatePeerRestore({
      ...scope,
      archive: restore,
      rows: yield* restoreRows(command, restore),
    });
  });

  const collectLockRows = Effect.fnUntraced(function* (
    command: OrchestrationV2ServerCommand,
    peer: PeerArchiveDispatchInput | undefined,
  ) {
    if (command.type === "thread.archive" && peer?.kind === "archive")
      return yield* peerRows(command, peer.selectedThreadIds);
    if (command.type === "thread.unarchive" && peer?.kind === "restore")
      return yield* restoreRows(command, peer);
    if (command.type === "thread.archive.complete" || command.type === "thread.archive.fail") {
      const shell = yield* ports.store
        .getThreadShell(command.threadId)
        .pipe(ports.mapDispatchError(command));
      const plan = getThreadArchivePlan(shell?.archivePending);
      if (plan?.peer !== undefined)
        return yield* peerRows(
          command,
          plan.archiveThreadIds,
          () => command.type === "thread.archive.complete" && plan.commandId === command.requestId,
        );
    }
    return null;
  });

  const guardTargets = Effect.fnUntraced(function* (
    command: LastCodeArchiveCommand,
    planned: {
      readonly cancelUnsettledEffects?: { readonly threadIds?: ReadonlyArray<ThreadId> };
    },
    participants: ReadonlySet<ThreadId>,
  ) {
    const peer = yield* PeerArchiveDispatch;
    const pending =
      command.type === "thread.archive.complete"
        ? getThreadArchivePlan(
            (yield* ports.store.getThread(command.threadId).pipe(ports.mapDispatchError(command)))
              .archivePending,
          )
        : null;
    const exact =
      command.type === "thread.archive" && peer?.kind === "archive"
        ? peer.selectedThreadIds
        : command.type === "thread.unarchive" && peer?.kind === "restore"
          ? peer.committed.map(({ threadId }) => threadId)
          : pending?.peer === undefined
            ? undefined
            : pending.archiveThreadIds;
    if (exact !== undefined) {
      const allowed = new Set(exact);
      if (
        (planned.cancelUnsettledEffects !== undefined &&
          planned.cancelUnsettledEffects.threadIds === undefined) ||
        [...participants, ...(planned.cancelUnsettledEffects?.threadIds ?? [])].some(
          (id) => !allowed.has(id),
        )
      )
        return yield* ports.reject(
          command,
          "The linked archive planned work outside its reviewed selection.",
        );
      // Peer planning already checked each participant's fenced session and mode under these locks.
      return true;
    }
    return false;
  });

  return {
    collectLockRows,
    prepareArchive,
    validateCompletion,
    restoreThreadIds,
    guardTargets,
    reject: ports.reject,
  };
}
