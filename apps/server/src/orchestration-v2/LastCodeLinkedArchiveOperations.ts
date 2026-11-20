import {
  CommandId,
  type LinkedArchiveOperation,
  LinkedArchiveSelection,
  NonNegativeInt,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2StoredEvent,
  PeerArchiveReceipt,
  PeerArchiveUnavailable,
  ThreadId,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { PeerArchiveWriteTransport } from "../peer/LastCodePeerArchiveServices.ts";
import { DispatchModeLimit } from "./DispatchModeLimit.ts";
import { EventSinkV2 } from "./EventSink.ts";
import {
  makeLastCodeArchiveJournal,
  type LastCodeArchiveJournalRow,
} from "./LastCodeArchiveJournal.ts";
import { readPeerArchiveOwnerScope } from "./LastCodePeerArchiveInventory.ts";
import { OrchestratorDispatchError, type OrchestratorV2DispatchResult } from "./Orchestrator.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";

const StoredMachine = Schema.Struct({
  selection: LinkedArchiveSelection,
  status: Schema.Literals(["pending", "blocked", "review", "committed", "restored"]),
  reason: Schema.optional(PeerArchiveUnavailable.fields.reason),
  selectionRevision: Schema.optional(NonNegativeInt),
  receipts: Schema.Array(PeerArchiveReceipt),
});
const State = Schema.Struct({
  ownerThreadIds: Schema.Array(ThreadId),
  localArchive: Schema.optional(Schema.Struct({ sequence: Schema.Int, archivedAt: Schema.String })),
  restoreCommandId: Schema.optional(CommandId),
  localRestoreCommandId: Schema.optional(CommandId),
  machines: Schema.Array(StoredMachine),
});
type State = typeof State.Type;
type StoredMachine = typeof StoredMachine.Type;
type ArchiveCommand = Extract<
  OrchestrationV2ServerCommand,
  { type: "thread.archive" | "thread.unarchive" }
>;
const readState = Schema.decodeUnknownSync(Schema.fromJsonString(State));
const writeState = Schema.encodeSync(Schema.fromJsonString(State));

const localArchiveTransition = (
  ownerThreadId: ThreadId,
  { sequence, event }: OrchestrationV2StoredEvent,
) =>
  event.threadId === ownerThreadId &&
  event.type === "thread.archived" &&
  event.payload.archivedAt !== null
    ? { sequence, archivedAt: DateTime.formatIso(event.payload.archivedAt) }
    : undefined;

const initialMachine = (selection: LinkedArchiveSelection): StoredMachine =>
  selection.status === "ready"
    ? { selection, status: selection.cohorts.length === 0 ? "committed" : "pending", receipts: [] }
    : { selection, status: selection.status, reason: selection.reason, receipts: [] };

const unavailableMachine = (
  machine: StoredMachine,
  reason: PeerArchiveUnavailable,
  answered = false,
): StoredMachine => ({
  ...machine,
  status: reason.status,
  reason: answered && reason.status === "pending" ? undefined : reason.reason,
});

const make = Effect.gen(function* () {
  const { getEnvironmentId } = yield* ServerEnvironment;
  const environmentId = yield* getEnvironmentId;
  const journal = makeLastCodeArchiveJournal(yield* SqlClient.SqlClient);
  const events = yield* EventSinkV2;
  const store = yield* ProjectionStoreV2;
  const peers = yield* PeerArchiveWriteTransport;
  const scope = yield* Scope.Scope;
  const locks = yield* KeyedLock.make<ThreadId>();
  const rowsFor = (ownerThreadId: ThreadId) =>
    journal.listByOwner({ role: "source", ownerEnvironmentId: environmentId, ownerThreadId });

  const archived = (row: LastCodeArchiveJournalRow) =>
    Stream.concat(
      events.readByCommandId({ commandId: row.sourceArchiveCommandId }),
      events.readByCommandId({
        commandId: CommandId.make(`${row.sourceArchiveCommandId}:complete`),
      }),
    ).pipe(
      Stream.filterMap((event) => {
        const transition = localArchiveTransition(row.ownerThreadId, event);
        return transition === undefined ? Result.fail(undefined) : Result.succeed(transition);
      }),
      Stream.runHead,
      Effect.map(Option.getOrUndefined),
    );

  const restored = (threadId: ThreadId, commandId: CommandId) =>
    events.readByCommandId({ commandId }).pipe(
      Stream.filter(
        ({ event }) => event.threadId === threadId && event.type === "thread.unarchived",
      ),
      Stream.runHead,
      Effect.map(Option.isSome),
    );

  const generations = Effect.fn("LastCodeLinkedArchive.generations")(function* (
    threadId: ThreadId,
  ) {
    const rows = yield* rowsFor(threadId);
    if (rows.length === 0) return [];
    const shell = yield* store.getThreadShell(threadId);
    if (shell === null) return [];
    const currentArchive =
      shell.archivedAt === null ? undefined : DateTime.formatIso(shell.archivedAt);
    const candidates = yield* Effect.forEach(rows, (row) =>
      Effect.gen(function* () {
        const state = readState(row.stateJson);
        const committed = state.localArchive ?? (yield* archived(row));
        if (committed === undefined) return undefined;
        const localArchived = currentArchive === committed.archivedAt;
        const localRestored =
          state.restoreCommandId !== undefined &&
          (state.localRestoreCommandId === state.restoreCommandId ||
            (yield* restored(threadId, state.restoreCommandId)));
        if (localArchived || localRestored) {
          return {
            row,
            state,
            sequence: committed.sequence,
            archivedAt: committed.archivedAt,
            localArchived: !localRestored && localArchived,
          };
        }
        return undefined;
      }),
    );
    return candidates
      .filter((candidate) => candidate !== undefined)
      .sort((left, right) => right.sequence - left.sequence);
  });

  const pendingRestore = (entry: Effect.Success<ReturnType<typeof generations>>[number]) =>
    !entry.localArchived && entry.state.machines.some(({ status }) => status !== "restored");

  const needsReview = (machine: StoredMachine) =>
    machine.selection.status !== "ready" || machine.reason === "selection_changed";

  const status = (threadId: ThreadId) =>
    generations(threadId).pipe(
      Effect.map((entries) =>
        entries
          .filter((entry, index) => index === 0 || pendingRestore(entry))
          .map((entry): LinkedArchiveOperation => ({
            sourceArchiveCommandId: entry.row.sourceArchiveCommandId,
            archivedAt: entry.archivedAt,
            operation: entry.localArchived ? "archive" : "restore",
            machines: entry.state.machines.map((machine) => ({
              environmentId: machine.selection.environmentId,
              label: machine.selection.label,
              status:
                !entry.localArchived && machine.status === "committed" ? "pending" : machine.status,
              ...(entry.localArchived && needsReview(machine) ? { requiresReview: true } : {}),
              reason: machine.reason,
            })),
          })),
      ),
    );

  const selectedOwnerThreadIds = (threadId: ThreadId) =>
    generations(threadId).pipe(
      Effect.map(
        (entries) => entries.find(({ localArchived }) => localArchived)?.state.ownerThreadIds,
      ),
    );

  const run = Effect.fnUntraced(function* (key: LastCodeArchiveJournalRow) {
    const row = yield* journal.read(key);
    if (row === null) return;
    const state = readState(row.stateJson);
    const local = (yield* generations(row.ownerThreadId)).find(
      (entry) => entry.row.sourceArchiveCommandId === row.sourceArchiveCommandId,
    );
    if (local === undefined) return;
    const restoring = state.restoreCommandId !== undefined;
    if (restoring === local.localArchived) return;
    const limits = yield* DispatchModeLimit;
    const generation = {
      ownerEnvironmentId: row.ownerEnvironmentId,
      ownerThreadId: row.ownerThreadId,
      sourceArchiveCommandId: row.sourceArchiveCommandId,
    };
    const machines = yield* Effect.forEach(
      state.machines,
      (machine) => {
        const { selection } = machine;
        if (
          selection.status !== "ready" ||
          (selection.cohorts.length === 0 && machine.selectionRevision === undefined)
        )
          return Effect.succeed(restoring ? { ...machine, status: "restored" as const } : machine);
        if (restoring) {
          if (machine.status === "restored") return Effect.succeed(machine);
          return peers.restore(selection.environmentId, generation, limits).pipe(
            Effect.match({
              onFailure: (reason) => unavailableMachine(machine, reason),
              onSuccess: ({ remaining }): StoredMachine =>
                remaining === undefined
                  ? { ...machine, status: "restored", reason: undefined }
                  : unavailableMachine(machine, remaining, true),
            }),
          );
        }
        if (machine.status === "committed" || needsReview(machine)) return Effect.succeed(machine);
        return peers
          .apply(
            selection.environmentId,
            {
              ...generation,
              ownerThreadIds: state.ownerThreadIds,
              cohorts: selection.cohorts,
              ...(machine.selectionRevision === undefined
                ? {}
                : { selectionRevision: machine.selectionRevision }),
            },
            limits,
          )
          .pipe(
            Effect.match({
              onFailure: (reason) => unavailableMachine(machine, reason),
              onSuccess: ({ receipts, remaining }): StoredMachine =>
                remaining === undefined
                  ? { ...machine, receipts, status: "committed", reason: undefined }
                  : unavailableMachine({ ...machine, receipts }, remaining, true),
            }),
          );
      },
      { concurrency: "unbounded" },
    );
    yield* journal.compareAndReplace(row, row.revision, writeState({ ...state, machines }));
  });

  const start = (row: LastCodeArchiveJournalRow) =>
    run(row).pipe(
      Effect.catchCause((cause) => Effect.logWarning("Linked archive work remains pending", cause)),
      Effect.forkIn(scope),
      Effect.asVoid,
    );

  const revise = Effect.fnUntraced(function* (
    key: LastCodeArchiveJournalRow,
    update: (state: State) => State,
  ) {
    for (;;) {
      const row = yield* journal.read(key);
      if (row === null) return;
      const state = readState(row.stateJson);
      const next = update(state);
      if (
        next === state ||
        (yield* journal.compareAndReplace(row, row.revision, writeState(next))) === "applied"
      )
        return;
    }
  });

  const recordLocalTransition = (
    row: LastCodeArchiveJournalRow,
    command: ArchiveCommand,
    result: OrchestratorV2DispatchResult,
  ) => {
    const transition = result.storedEvents.find(
      ({ event }) =>
        event.threadId === command.threadId &&
        event.type ===
          (command.type === "thread.archive" ? "thread.archived" : "thread.unarchived"),
    );
    if (transition === undefined) return Effect.void;
    return revise(row, (state) =>
      command.type === "thread.archive"
        ? { ...state, localArchive: localArchiveTransition(command.threadId, transition) }
        : state.restoreCommandId === command.commandId
          ? {
              ...state,
              localRestoreCommandId: command.commandId,
              machines: state.machines.map((machine) => ({
                ...machine,
                status: "pending",
                reason: undefined,
              })),
            }
          : state,
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not save local archive transition", cause),
      ),
    );
  };

  const dispatchLocked = Effect.fn("LastCodeLinkedArchive.dispatch")(function* <E, R>(
    command: ArchiveCommand,
    local: Effect.Effect<OrchestratorV2DispatchResult, E, R>,
  ) {
    const entries = yield* generations(command.threadId);
    const archivedLocally = entries.find(({ localArchived }) => localArchived);
    const expected = command.expectedLinkedArchiveCommandId;
    if (expected !== undefined && command.type === "thread.unarchive") {
      const restore = entries.find(
        (entry) => !entry.localArchived && entry.row.sourceArchiveCommandId === expected,
      );
      if (restore === undefined)
        return yield* Effect.fail("The linked archive generation changed. Review it again.");
      yield* start(restore.row);
      return {
        sequence: restore.sequence,
        storedEvents: [],
        replayed: true,
      } satisfies OrchestratorV2DispatchResult;
    }
    const previous = archivedLocally;
    if (expected !== undefined && archivedLocally?.row.sourceArchiveCommandId !== expected)
      return yield* Effect.fail("The linked archive generation changed. Review it again.");
    const selection =
      command.type === "thread.archive" ? command.linkedArchiveSelection : undefined;
    if (
      new Set(selection?.map(({ environmentId }) => environmentId)).size !==
      (selection?.length ?? 0)
    ) {
      return yield* Effect.fail("Choose each linked machine once.");
    }
    if (command.type === "thread.archive" && !previous?.localArchived) {
      if (!selection?.length) return yield* local;
      const owner = yield* readPeerArchiveOwnerScope(environmentId, command.threadId, store);
      const key = {
        role: "source" as const,
        ownerEnvironmentId: environmentId,
        ownerThreadId: command.threadId,
        sourceArchiveCommandId: command.commandId,
      };
      yield* journal.insertOnce(
        key,
        writeState({
          ownerThreadIds:
            command.includeTypedInThreadIds === undefined
              ? owner.ownerThreadIds.filter((id) => !owner.keptOwnerThreadIds.includes(id))
              : owner.ownerThreadIds,
          machines: selection.map(initialMachine),
        }),
      );
      const row = yield* journal.read(key);
      const result = yield* local;
      if (row !== null) {
        yield* recordLocalTransition(row, command, result);
        yield* start(row);
      }
      return result;
    }
    if (previous === undefined) return yield* local;
    const { row, state, localArchived, sequence } = previous;
    if (command.type === "thread.archive" && state.restoreCommandId !== undefined)
      return yield* local;
    if (command.type === "thread.unarchive" && localArchived) {
      yield* revise(row, (state) => ({
        ...state,
        restoreCommandId: command.commandId,
      }));
      const result = yield* local.pipe(
        Effect.onError(() =>
          restored(command.threadId, command.commandId).pipe(
            Effect.flatMap((committed) =>
              committed
                ? start(row)
                : revise(row, (state) => ({ ...state, restoreCommandId: undefined })),
            ),
            Effect.ignore,
          ),
        ),
      );
      yield* recordLocalTransition(row, command, result);
      yield* start(row);
      return result;
    }
    if (selection?.length) {
      yield* revise(row, (state) =>
        state.restoreCommandId !== undefined
          ? state
          : {
              ...state,
              machines: state.machines.map((machine) => {
                if (!needsReview(machine)) return machine;
                const approved = selection.find(
                  ({ environmentId }) => environmentId === machine.selection.environmentId,
                );
                if (approved?.status !== "ready") return machine;
                if (machine.selection.status !== "ready") return initialMachine(approved);
                return {
                  ...initialMachine(approved),
                  status: "pending",
                  receipts: machine.receipts,
                  selectionRevision: (machine.selectionRevision ?? 0) + 1,
                };
              }),
            },
      );
    }
    yield* start(row);
    return { sequence, storedEvents: [], replayed: true } satisfies OrchestratorV2DispatchResult;
  });

  const dispatch = <E, R>(
    command: ArchiveCommand,
    local: Effect.Effect<OrchestratorV2DispatchResult, E, R>,
  ): Effect.Effect<OrchestratorV2DispatchResult, E | OrchestratorDispatchError, R> =>
    (command.type === "thread.archive" &&
      command.expectedLinkedArchiveCommandId === undefined &&
      !command.linkedArchiveSelection?.some(
        (machine) => machine.status !== "ready" || machine.cohorts.length > 0,
      )) ||
    (command.type === "thread.unarchive" && command.expectedArchiveCommandId !== undefined)
      ? local
      : locks.withLock(command.threadId, dispatchLocked(command, local)).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestratorDispatchError({
                commandId: command.commandId,
                commandType: command.type,
                cause,
              }),
          ),
        );

  return { dispatch, status, selectedOwnerThreadIds };
});

export class LastCodeLinkedArchiveOperations extends Context.Service<
  LastCodeLinkedArchiveOperations,
  Effect.Success<typeof make>
>()("t3/orchestration-v2/LastCodeLinkedArchiveOperations") {}

export const layer = Layer.effect(LastCodeLinkedArchiveOperations, make);

const archiveOperations = (service?: LastCodeLinkedArchiveOperations["Service"]) => ({
  dispatch: <E, R>(
    command: OrchestrationV2ServerCommand,
    local: Effect.Effect<OrchestratorV2DispatchResult, E, R>,
  ): Effect.Effect<OrchestratorV2DispatchResult, E | OrchestratorDispatchError, R> =>
    service !== undefined &&
    (command.type === "thread.archive" || command.type === "thread.unarchive")
      ? service.dispatch(command, local)
      : local,
  status: (threadId: ThreadId) => service?.status(threadId) ?? Effect.succeed([]),
  selectedOwnerThreadIds: (threadId: ThreadId) =>
    service?.selectedOwnerThreadIds(threadId) ?? Effect.undefined,
});

export const localArchiveOperations = archiveOperations();
export const captureLinkedArchiveOperations = Effect.serviceOption(
  LastCodeLinkedArchiveOperations,
).pipe(Effect.map((service) => archiveOperations(Option.getOrUndefined(service))));
