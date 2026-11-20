import { sha256 } from "@noble/hashes/sha2";
import {
  AuthMcpClientAccess,
  CommandId,
  isRuntimeModeAbove,
  NonNegativeInt,
  PeerArchiveCohort,
  PeerArchiveGeneration,
  PeerArchiveReceipt,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  type PeerArchiveApplyInput,
  type PeerArchiveApplyResult,
  type PeerArchiveRestoreResult,
  type PeerArchiveUnavailable,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Hex from "effect/encoding/Hex";
import { clientModeCeiling, type McpClientCaller } from "../mcp/McpInvocationContext.ts";
import type { CommandReceiptStoreV2Shape } from "./CommandReceiptStore.ts";
import { DispatchModeLimit } from "./DispatchModeLimit.ts";
import type { EventSinkV2Shape } from "./EventSink.ts";
import type {
  LastCodeArchiveJournal,
  LastCodeArchiveJournalKey,
} from "./LastCodeArchiveJournal.ts";
import {
  PeerArchiveDispatch,
  type PeerArchiveDispatchInput,
} from "./LastCodePeerArchiveDispatch.ts";
import type { OrchestratorV2Shape } from "./Orchestrator.ts";

interface DestinationPorts {
  readonly journal: LastCodeArchiveJournal;
  readonly orchestrator: Pick<OrchestratorV2Shape, "dispatch">;
  readonly eventSink: Pick<EventSinkV2Shape, "readByCommandId">;
  readonly receipts: Pick<CommandReceiptStoreV2Shape, "getByCommandId">;
}

export interface LastCodePeerArchiveDestination {
  readonly apply: (
    client: McpClientCaller,
    input: PeerArchiveApplyInput,
  ) => Effect.Effect<PeerArchiveApplyResult, PeerArchiveUnavailable>;
  readonly restore: (
    client: McpClientCaller,
    input: PeerArchiveGeneration,
  ) => Effect.Effect<PeerArchiveRestoreResult, PeerArchiveUnavailable>;
}

const CommandAttempt = Schema.Struct({ ordinal: NonNegativeInt, id: CommandId });
const ArchiveAttempt = Schema.Struct({
  ...CommandAttempt.fields,
  retryOf: Schema.optional(CommandId),
  failed: Schema.optional(Schema.Literal(true)),
  access: AuthMcpClientAccess,
  limit: Schema.Struct({ runtimeMode: RuntimeMode, interactionMode: ProviderInteractionMode }),
});
type ArchiveAttempt = typeof ArchiveAttempt.Type;

const Cohort = Schema.Struct({
  selection: PeerArchiveCohort,
  archive: Schema.optional(ArchiveAttempt),
  archived: Schema.optional(PeerArchiveReceipt.fields.threads),
  restore: Schema.optional(CommandAttempt),
  restored: Schema.optional(Schema.Array(ThreadId)),
});
type Cohort = typeof Cohort.Type;

const DestinationState = Schema.Struct({
  nonce: Schema.String,
  sessionId: Schema.String,
  fenced: Schema.Boolean,
  ownerThreadIds: Schema.Array(ThreadId),
  cohorts: Schema.Array(Cohort),
});
type DestinationState = typeof DestinationState.Type;
const DestinationStateJson = Schema.fromJsonString(DestinationState);
const decodeState = Schema.decodeUnknownEffect(DestinationStateJson);
const encodeState = Schema.encodeEffect(DestinationStateJson);
const generationLockKey = Schema.encodeSync(Schema.fromJsonString(PeerArchiveGeneration));
const sameThreadIds = Schema.toEquivalence(Schema.Array(ThreadId));
const sameCohorts = Schema.toEquivalence(Schema.Array(PeerArchiveCohort));
const encodeAttemptKey = Schema.encodeSync(
  Schema.fromJsonString(Schema.Tuple([Schema.String, ThreadId, Schema.String, NonNegativeInt])),
);

const pending = { status: "pending", reason: "offline" } satisfies PeerArchiveUnavailable;
const changed = { status: "blocked", reason: "selection_changed" } satisfies PeerArchiveUnavailable;
const denied = { status: "blocked", reason: "denied" } satisfies PeerArchiveUnavailable;

const orderBy = <T>(rows: readonly T[], key: (row: T) => string) =>
  rows.toSorted((a, b) => (key(a) < key(b) ? -1 : key(a) === key(b) ? 0 : 1));

function reviewedSelection(input: PeerArchiveApplyInput) {
  const ownerThreadIds = input.ownerThreadIds.toSorted();
  const selected = new Set<ThreadId>();
  if (
    !ownerThreadIds.includes(input.ownerThreadId) ||
    new Set(ownerThreadIds).size !== ownerThreadIds.length ||
    input.cohorts.length === 0
  )
    return null;
  for (const cohort of input.cohorts) {
    if (
      !cohort.selectedThreadIds.includes(cohort.anchorThreadId) ||
      new Set(cohort.typedIn.map((row) => row.threadId)).size !== cohort.typedIn.length
    )
      return null;
    for (const id of cohort.selectedThreadIds) {
      if (selected.has(id)) return null;
      selected.add(id);
    }
  }
  return {
    ownerThreadIds,
    cohorts: orderBy(input.cohorts, (cohort) => cohort.anchorThreadId).map((cohort) => ({
      anchorThreadId: cohort.anchorThreadId,
      selectedThreadIds: cohort.selectedThreadIds.toSorted(),
      typedIn: orderBy(cohort.typedIn, (row) => row.threadId).map(
        ({ threadId, latestHumanMessageAt }) => ({ threadId, latestHumanMessageAt }),
      ),
      childDisposition: cohort.childDisposition,
    })),
  };
}

function nextAttempt(
  nonce: string,
  anchor: ThreadId,
  operation: "archive" | "restore",
  previous: typeof CommandAttempt.Type | undefined,
) {
  const ordinal = (previous?.ordinal ?? -1) + 1;
  const digest = Hex.encode(
    sha256(new TextEncoder().encode(encodeAttemptKey([nonce, anchor, operation, ordinal]))),
  );
  return { ordinal, id: CommandId.make(`linked-archive:${operation}:${digest}`) };
}

function admittedClient(client: McpClientCaller, attempt: ArchiveAttempt): McpClientCaller {
  const access =
    attempt.access === "read-only" ||
    (client.access !== "read-only" && isRuntimeModeAbove(client.access, attempt.access))
      ? attempt.access
      : client.access;
  const current = clientModeCeiling({ ...client, access });
  return {
    ...client,
    access,
    narrowedTo: {
      runtimeMode: isRuntimeModeAbove(current.runtimeMode, attempt.limit.runtimeMode)
        ? attempt.limit.runtimeMode
        : current.runtimeMode,
      interactionMode: attempt.limit.interactionMode === "plan" ? "plan" : current.interactionMode,
    },
  };
}

type ArchivedThreads = PeerArchiveReceipt["threads"];
type ArchiveEvidence =
  | { readonly state: "archived"; readonly threads: ArchivedThreads }
  | { readonly state: "dispatch" | "pending" | "rejected" | "failed" | "unproven" };
type Remaining = PeerArchiveUnavailable | undefined;

const mergeRemaining = (current: Remaining, next: Remaining): Remaining =>
  current?.status === "pending" ? current : next?.status === "pending" ? next : (current ?? next);

const missingArchiveRows = ({ archived, selection }: Cohort) =>
  archived !== undefined && archived.length < selection.selectedThreadIds.length
    ? changed
    : undefined;

export const makeLastCodePeerArchiveDestination = Effect.fn("LastCodePeerArchiveDestination.make")(
  function* ({ journal, orchestrator, eventSink, receipts }: DestinationPorts) {
    const locks = yield* KeyedLock.make<string>();
    const unavailable = (cause: unknown) =>
      Effect.logWarning("Could not read or write linked archive destination state", cause).pipe(
        Effect.andThen(Effect.fail(pending)),
      );

    const withGeneration = <A>(
      client: McpClientCaller,
      generation: PeerArchiveGeneration,
      run: (key: LastCodeArchiveJournalKey) => Effect.Effect<A, PeerArchiveUnavailable>,
    ) => {
      if (client.linked !== true || client.access === "read-only" || client.sessionId.trim() === "")
        return Effect.fail(denied);
      const key = {
        role: "destination",
        ownerEnvironmentId: generation.ownerEnvironmentId,
        ownerThreadId: generation.ownerThreadId,
        sourceArchiveCommandId: generation.sourceArchiveCommandId,
      } satisfies LastCodeArchiveJournalKey;
      return locks.withLock(generationLockKey(key), run(key));
    };

    const open = Effect.fnUntraced(function* (
      key: LastCodeArchiveJournalKey,
      client: McpClientCaller,
      initial: Pick<DestinationState, "fenced" | "ownerThreadIds" | "cohorts">,
    ) {
      let row = yield* journal.read(key).pipe(Effect.catch(unavailable));
      if (row === null) {
        const stateJson = yield* encodeState({
          ...initial,
          nonce: SecureRandom.uuidV4Unsafe(),
          sessionId: client.sessionId,
        }).pipe(Effect.catch(unavailable));
        yield* journal.insertOnce(key, stateJson).pipe(Effect.catch(unavailable));
        row = yield* journal.read(key).pipe(Effect.catch(unavailable));
        if (row === null) return yield* Effect.fail(pending);
      }
      let state = yield* decodeState(row.stateJson).pipe(Effect.catch(unavailable));
      if (state.sessionId !== client.sessionId) return yield* Effect.fail(denied);
      let revision = row.revision;
      const save = Effect.fnUntraced(function* (updated: DestinationState) {
        const stateJson = yield* encodeState(updated).pipe(Effect.catch(unavailable));
        const result = yield* journal
          .compareAndReplace(key, revision, stateJson)
          .pipe(Effect.catch(unavailable));
        if (result === "stale") return yield* Effect.fail(pending);
        state = updated;
        revision++;
      });
      return {
        get state() {
          return state;
        },
        fence: () => (state.fenced ? Effect.void : save({ ...state, fenced: true })),
        saveCohort: (cohort: Cohort) =>
          save({
            ...state,
            cohorts: state.cohorts.map((entry) =>
              entry.selection.anchorThreadId === cohort.selection.anchorThreadId ? cohort : entry,
            ),
          }),
      };
    });

    const readReceipt = Effect.fnUntraced(function* (
      id: CommandId,
      anchor: ThreadId,
      type: string,
    ) {
      const found = yield* receipts.getByCommandId(id).pipe(Effect.catch(unavailable));
      if (Option.isNone(found)) return undefined;
      const receipt = found.value;
      if (receipt.commandId !== id || receipt.threadId !== anchor || receipt.commandType !== type)
        return yield* Effect.fail(changed);
      return receipt.status;
    });

    const readEvents = (commandId: CommandId) =>
      eventSink.readByCommandId({ commandId }).pipe(
        Stream.filter((row) => row.commandId === commandId),
        Stream.runCollect,
        Effect.catch(unavailable),
      );

    const readArchiveEvidence = Effect.fnUntraced(function* (
      selection: PeerArchiveCohort,
      attempt: ArchiveAttempt,
    ): Effect.fn.Return<ArchiveEvidence, PeerArchiveUnavailable> {
      if (attempt.failed === true) return { state: "failed" };
      const { anchorThreadId, selectedThreadIds } = selection;
      const completedId = CommandId.make(`${attempt.id}:complete`);
      const failedId = CommandId.make(`${attempt.id}:failed`);
      const acceptance = yield* readReceipt(attempt.id, anchorThreadId, "thread.archive");
      if (acceptance === "rejected") return { state: "rejected" };

      // Read receipts first. A worker may commit while this request is inspecting the attempt.
      const completion = yield* readReceipt(completedId, anchorThreadId, "thread.archive.complete");
      const failure = yield* readReceipt(failedId, anchorThreadId, "thread.archive.fail");
      const selected = new Set(selectedThreadIds);
      const rows = new Map<ThreadId, ArchivedThreads[number]>();
      for (const id of [attempt.id, completedId]) {
        for (const { event } of yield* readEvents(id)) {
          if (event.type !== "thread.archived" || !selected.has(event.threadId)) continue;
          const { archivedWith, archivedAt } = event.payload;
          if (
            event.payload.id === event.threadId &&
            archivedAt !== null &&
            archivedWith?.threadId === anchorThreadId &&
            archivedWith.commandId === attempt.id
          ) {
            rows.set(event.threadId, {
              threadId: event.threadId,
              archivedAt: DateTime.formatIso(archivedAt),
              archivedWith,
            });
          }
        }
      }
      if (rows.size > 0) return { state: "archived", threads: [...rows.values()] };
      if (failure === "accepted") {
        const failed = (yield* readEvents(failedId)).some(({ event }) => {
          if (event.type !== "thread.metadata-updated" || !selected.has(event.threadId))
            return false;
          const row = event.payload.archivePending;
          return (
            event.payload.id === event.threadId &&
            row?.status === "failed" &&
            row.threadId === anchorThreadId &&
            row.commandId === attempt.id
          );
        });
        return { state: failed ? "failed" : "unproven" };
      }
      if (completion === "accepted") return { state: "unproven" };
      return { state: acceptance === "accepted" ? "pending" : "dispatch" };
    });

    const dispatch = Effect.fnUntraced(function* (
      command: Parameters<OrchestratorV2Shape["dispatch"]>[0],
      scope: PeerArchiveDispatchInput,
    ) {
      const result = yield* Effect.result(
        orchestrator
          .dispatch(command)
          .pipe(
            Effect.provideService(PeerArchiveDispatch, scope),
            Effect.provideService(DispatchModeLimit, clientModeCeiling(scope.client)),
          ),
      );
      if (result._tag === "Success") return undefined;
      switch (result.failure._tag) {
        case "OrchestratorThreadAboveModeLimitError":
        case "OrchestratorRuntimeModeAboveCeilingError":
          return denied;
        case "OrchestratorCommandIdConflictError":
          return changed;
        default:
          return pending;
      }
    });

    type Generation = Effect.Success<ReturnType<typeof open>>;
    const observeArchive = Effect.fnUntraced(function* (
      generation: Generation,
      client: McpClientCaller,
      key: LastCodeArchiveJournalKey,
      entry: Cohort,
      operation: "apply" | "restore",
    ) {
      if (entry.archived !== undefined) return { entry, remaining: undefined };
      const selection = entry.selection;
      let attempt = entry.archive;
      let evidence =
        attempt === undefined ? undefined : yield* readArchiveEvidence(selection, attempt);
      const observed = evidence?.state;
      if (operation === "restore" && observed === "dispatch")
        return { entry, remaining: undefined };
      const replaceAttempt =
        operation === "apply" &&
        (observed === undefined || observed === "rejected" || observed === "failed");

      if (replaceAttempt) {
        const retryOf = observed === "failed" ? attempt?.id : attempt?.retryOf;
        attempt = {
          ...nextAttempt(generation.state.nonce, selection.anchorThreadId, "archive", attempt),
          ...(retryOf === undefined ? {} : { retryOf }),
          access: client.access,
          limit: clientModeCeiling(client),
        };
        entry = { ...entry, archive: attempt };
        yield* generation.saveCohort(entry);
      }

      let dispatchOutcome: Remaining;
      if (
        attempt !== undefined &&
        operation === "apply" &&
        (replaceAttempt || observed === "dispatch")
      ) {
        dispatchOutcome = yield* dispatch(
          {
            type: "thread.archive",
            commandId: attempt.id,
            threadId: selection.anchorThreadId,
            childDisposition: selection.childDisposition,
            ...(attempt.retryOf === undefined ? {} : { expectedArchiveCommandId: attempt.retryOf }),
          },
          {
            kind: "archive",
            client: admittedClient(client, attempt),
            ownerEnvironmentId: key.ownerEnvironmentId,
            ownerThreadIds: generation.state.ownerThreadIds,
            selectedThreadIds: selection.selectedThreadIds,
            typedIn: selection.typedIn,
          },
        );
        evidence = yield* readArchiveEvidence(selection, attempt);
      }

      switch (evidence?.state) {
        case "archived":
          entry = { ...entry, archived: evidence.threads };
          yield* generation.saveCohort(entry);
          return { entry, remaining: undefined };
        case "failed":
          if (attempt !== undefined && attempt.failed !== true) {
            entry = { ...entry, archive: { ...attempt, failed: true } };
            yield* generation.saveCohort(entry);
          }
          return { entry, remaining: operation === "apply" ? changed : undefined };
        case "rejected":
          return { entry, remaining: operation === "apply" ? changed : undefined };
        case "unproven":
          return { entry, remaining: changed };
        case "pending":
          return { entry, remaining: pending };
        case "dispatch":
          return { entry, remaining: dispatchOutcome ?? pending };
        case undefined:
          return { entry, remaining: undefined };
      }
    });

    const restoreCohort = Effect.fnUntraced(function* (
      generation: Generation,
      client: McpClientCaller,
      key: LastCodeArchiveJournalKey,
      entry: Cohort,
    ): Effect.fn.Return<
      { readonly restored: readonly ThreadId[]; readonly remaining: Remaining },
      PeerArchiveUnavailable
    > {
      const {
        archived,
        restored,
        selection: { anchorThreadId },
      } = entry;
      if (restored !== undefined) return { restored: restored, remaining: undefined };
      if (archived === undefined) return { restored: [], remaining: undefined };

      let attempt = entry.restore;
      const prior =
        attempt === undefined
          ? undefined
          : yield* readReceipt(attempt.id, anchorThreadId, "thread.unarchive");
      if (attempt === undefined || prior === "rejected") {
        attempt = nextAttempt(generation.state.nonce, anchorThreadId, "restore", attempt);
        yield* generation.saveCohort({ ...entry, restore: attempt });
      }

      if (prior !== "accepted") {
        const outcome = yield* dispatch(
          { type: "thread.unarchive", commandId: attempt.id, threadId: anchorThreadId },
          {
            kind: "restore",
            client,
            ownerEnvironmentId: key.ownerEnvironmentId,
            ownerThreadIds: generation.state.ownerThreadIds,
            committed: archived,
          },
        );
        const acceptance = yield* readReceipt(attempt.id, anchorThreadId, "thread.unarchive");
        if (acceptance !== "accepted")
          return {
            restored: [],
            remaining: acceptance === "rejected" ? changed : (outcome ?? pending),
          };
      }

      const committed = new Set(archived.map(({ threadId }) => threadId));
      const ids = new Set<ThreadId>();
      for (const { event } of yield* readEvents(attempt.id)) {
        if (
          event.type === "thread.unarchived" &&
          committed.has(event.threadId) &&
          event.payload.id === event.threadId &&
          event.payload.archivedAt === null &&
          event.payload.archivedWith === null
        )
          ids.add(event.threadId);
      }
      const restoredIds = [...ids];
      yield* generation.saveCohort({ ...entry, restore: attempt, restored: restoredIds });
      return { restored: restoredIds, remaining: undefined };
    });

    const apply: LastCodePeerArchiveDestination["apply"] = (client, input) =>
      withGeneration(client, input, (key) =>
        Effect.gen(function* () {
          const reviewed = reviewedSelection(input);
          if (reviewed === null) return yield* Effect.fail(changed);
          const generation = yield* open(key, client, {
            ownerThreadIds: reviewed.ownerThreadIds,
            cohorts: reviewed.cohorts.map((selection) => ({ selection })),
            fenced: false,
          });
          const { state } = generation;
          if (
            state.fenced ||
            !sameThreadIds(state.ownerThreadIds, reviewed.ownerThreadIds) ||
            !sameCohorts(
              state.cohorts.map(({ selection }) => selection),
              reviewed.cohorts,
            )
          )
            return yield* Effect.fail(changed);

          const receipts: PeerArchiveReceipt[] = [];
          let remaining: Remaining;
          for (const entry of state.cohorts) {
            const observed = yield* Effect.result(
              observeArchive(generation, client, key, entry, "apply"),
            );
            if (observed._tag === "Failure") {
              remaining = mergeRemaining(remaining, observed.failure);
              continue;
            }
            const { entry: cohort, remaining: unavailable } = observed.success;
            remaining = mergeRemaining(remaining, unavailable);
            if (cohort.archived === undefined) continue;
            receipts.push({
              anchorThreadId: cohort.selection.anchorThreadId,
              threads: cohort.archived,
            });
            remaining = mergeRemaining(remaining, missingArchiveRows(cohort));
          }
          return { receipts, ...(remaining === undefined ? {} : { remaining }) };
        }),
      );

    const restore: LastCodePeerArchiveDestination["restore"] = (client, input) =>
      withGeneration(client, input, (key) =>
        Effect.gen(function* () {
          const generation = yield* open(key, client, {
            fenced: true,
            ownerThreadIds: [],
            cohorts: [],
          });
          yield* generation.fence();

          const restoredThreadIds: ThreadId[] = [];
          let remaining: Remaining;
          for (const entry of generation.state.cohorts) {
            const result = yield* Effect.result(
              Effect.gen(function* () {
                const observed = yield* observeArchive(generation, client, key, entry, "restore");
                if (observed.remaining !== undefined)
                  return { restored: [], remaining: observed.remaining };
                const result = yield* restoreCohort(generation, client, key, observed.entry);
                return {
                  restored: result.restored,
                  remaining: mergeRemaining(result.remaining, missingArchiveRows(observed.entry)),
                };
              }),
            );
            if (result._tag === "Failure") {
              remaining = mergeRemaining(remaining, result.failure);
              continue;
            }
            restoredThreadIds.push(...result.success.restored);
            remaining = mergeRemaining(remaining, result.success.remaining);
          }
          return { restoredThreadIds, ...(remaining === undefined ? {} : { remaining }) };
        }),
      );

    return { apply, restore } satisfies LastCodePeerArchiveDestination;
  },
);
