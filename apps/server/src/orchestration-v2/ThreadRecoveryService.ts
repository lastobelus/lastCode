import * as KeyedLock from "@t3tools/shared/KeyedLock";
import {
  RunId,
  RunAttemptId,
  ThreadId,
  type OrchestrationV2ThreadRecovery,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import type { ProviderAdapterV2Event, ProviderAdapterV2TurnInspection } from "./ProviderAdapter.ts";

type Terminal = Extract<ProviderAdapterV2Event, { type: "turn.terminal" }>;
export interface ThreadRecoveryIdentity {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly attemptId: RunAttemptId;
}
interface RecoveryRegistration extends ThreadRecoveryIdentity {
  readonly inspect: Effect.Effect<ProviderAdapterV2TurnInspection, ThreadRecoveryError>;
  readonly finalize: (
    terminal: Terminal,
    receipt: ReadonlyArray<OrchestrationV2DomainEvent>,
  ) => Effect.Effect<void, ThreadRecoveryError>;
}
export class ThreadRecoveryError extends Schema.TaggedError<ThreadRecoveryError>()(
  "ThreadRecoveryError",
  {
    threadId: ThreadId,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return "Could not recover this thread.";
  }
}
export class ThreadRecoveryService extends Context.Service<
  ThreadRecoveryService,
  {
    readonly register: (input: RecoveryRegistration) => Effect.Effect<void>;
    readonly suspect: (input: ThreadRecoveryIdentity) => Effect.Effect<void, ThreadRecoveryError>;
    readonly completed: (input: ThreadRecoveryIdentity) => Effect.Effect<void>;
    readonly recover: (input: ThreadRecoveryIdentity) => Effect.Effect<void, ThreadRecoveryError>;
    readonly reconcile: Effect.Effect<void>;
    readonly assertRepairable: (
      input: ThreadRecoveryIdentity,
    ) => Effect.Effect<void, ThreadRecoveryError>;
    readonly recordRepairThread: (
      input: ThreadRecoveryIdentity & { readonly repairThreadId: ThreadId },
    ) => Effect.Effect<void, ThreadRecoveryError>;
  }
>()("t3/orchestration-v2/ThreadRecoveryService") {}

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sink = yield* EventSink.EventSinkV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const lock = yield* KeyedLock.make<ThreadId>();
  const commands = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const registrations = new Map<ThreadId, RecoveryRegistration>();
  const pendingFailures = new Map<string, string>();
  const incidentKey = (input: ThreadRecoveryIdentity) =>
    `${input.threadId}:${input.runId}:${input.attemptId}`;
  const matches = (a: ThreadRecoveryIdentity, b: ThreadRecoveryIdentity) =>
    a.runId === b.runId && a.attemptId === b.attemptId;
  const repairLink = (
    input: ThreadRecoveryIdentity,
    recovery: OrchestrationV2ThreadRecovery | undefined,
  ) =>
    recovery?.runId === input.runId &&
    recovery.attemptId === input.attemptId &&
    recovery.repairThreadId !== undefined
      ? { repairThreadId: recovery.repairThreadId }
      : {};
  const current = Effect.fnUntraced(function* (input: ThreadRecoveryIdentity) {
    const projection = yield* projections.getRuntimeRecoveryProjection(input.threadId);
    const run = projection.runs.find(
      (run) => run.id === input.runId && run.activeAttemptId === input.attemptId,
    );
    // A receipt for an older run must never replace a newer run's recovery state.
    if (
      run === undefined ||
      projection.runs.some(
        (other) =>
          other.ordinal > run.ordinal &&
          (other.startedAt !== null ||
            ["preparing", "starting", "running", "waiting"].includes(other.status)),
      )
    )
      return null;
    return { thread: projection.thread, run, providerTurns: projection.providerTurns };
  });
  const write = (
    input: ThreadRecoveryIdentity,
    status: OrchestrationV2ThreadRecovery["status"],
    detail: string,
    repairThreadId?: ThreadId,
    expectedStatus?: "running",
  ) =>
    commands.withLock(
      input.threadId,
      Effect.gen(function* () {
        const state = yield* current(input);
        if (state === null || (expectedStatus !== undefined && state.run.status !== expectedStatus))
          return false;
        const now = yield* DateTime.now;
        const result = yield* sink.writeIfRunCurrent({
          threadId: input.threadId,
          runId: input.runId,
          activeAttemptId: input.attemptId,
          expectedStatus: state.run.status,
          events: [
            {
              id: yield* ids.allocate.event({ threadId: input.threadId }),
              type: "thread.metadata-updated",
              threadId: input.threadId,
              occurredAt: now,
              payload: {
                ...state.thread,
                recovery: {
                  runId: input.runId,
                  attemptId: input.attemptId,
                  status,
                  detail,
                  updatedAt: now,
                  ...repairLink(input, state.thread.recovery),
                  ...(repairThreadId === undefined ? {} : { repairThreadId }),
                },
              },
            },
          ],
        });
        return result.committed;
      }),
    );
  const markFailed = Effect.fnUntraced(function* (input: ThreadRecoveryIdentity, detail: string) {
    pendingFailures.set(incidentKey(input), detail);
    yield* write(input, "failed", detail);
    pendingFailures.delete(incidentKey(input));
  });
  const recover = (input: ThreadRecoveryIdentity, manual: boolean) =>
    lock.withLock(
      input.threadId,
      Effect.gen(function* () {
        const pendingFailure = pendingFailures.get(incidentKey(input));
        if (pendingFailure !== undefined) {
          yield* markFailed(input, pendingFailure);
          return;
        }
        const registered = registrations.get(input.threadId);
        if (registered === undefined || !matches(registered, input)) return;
        const inspection = yield* registered.inspect.pipe(Effect.timeout("10 seconds"));
        if (inspection.status === "active") return;
        const state = yield* current(input);
        if (state === null || state.run.status !== "running") {
          const registered = registrations.get(input.threadId);
          if (registered !== undefined && matches(registered, input))
            registrations.delete(input.threadId);
          return;
        }
        const prior = state.thread.recovery;
        if (
          !manual &&
          prior?.runId === input.runId &&
          prior.attemptId === input.attemptId &&
          prior.status === "failed"
        )
          return;
        if (inspection.status === "unknown") {
          yield* markFailed(
            input,
            "The provider's turn state could not be confirmed. No work was interrupted or restarted.",
          );
          return;
        }
        if (
          !state.providerTurns.some(
            (turn) =>
              turn.id === inspection.event.providerTurnId &&
              turn.providerThreadId === inspection.event.providerThreadId &&
              turn.runAttemptId === input.attemptId,
          )
        ) {
          yield* markFailed(
            input,
            "The saved provider-turn record is missing or does not match this attempt. Automatic recovery cannot safely restore its history. Open a repair thread to investigate.",
          );
          return;
        }
        if (
          !(yield* write(
            input,
            "recovering",
            "The provider finished. Reconciling the saved turn state…",
          ))
        )
          return;
        yield* commands.withLock(
          input.threadId,
          Effect.gen(function* () {
            const latest = yield* current(input);
            if (latest === null || latest.run.status !== "running") return;
            const now = yield* DateTime.now;
            const turn = latest.providerTurns.find(
              (turn) =>
                turn.id === inspection.event.providerTurnId &&
                turn.providerThreadId === inspection.event.providerThreadId &&
                turn.runAttemptId === input.attemptId,
            );
            if (turn === undefined)
              return yield* new ThreadRecoveryError({
                threadId: input.threadId,
                cause: "Provider turn disappeared during recovery.",
              });
            const events: OrchestrationV2DomainEvent[] = [];
            events.push({
              id: yield* ids.allocate.event({ threadId: input.threadId }),
              type: "provider-turn.updated",
              threadId: input.threadId,
              runId: input.runId,
              occurredAt: now,
              payload: { ...turn, status: inspection.event.status, completedAt: now },
            });
            events.push({
              id: yield* ids.allocate.event({ threadId: input.threadId }),
              type: "thread.metadata-updated",
              threadId: input.threadId,
              occurredAt: now,
              payload: {
                ...latest.thread,
                recovery: {
                  runId: input.runId,
                  attemptId: input.attemptId,
                  status: "recovered",
                  detail:
                    "Recovered the provider's finished turn. Some output may be missing from the conversation; no provider work was repeated.",
                  updatedAt: now,
                  ...repairLink(input, latest.thread.recovery),
                },
              },
            });
            yield* registered.finalize(inspection.event, events);
          }),
        );
        const registeredAfterFinalization = registrations.get(input.threadId);
        if (
          registeredAfterFinalization !== undefined &&
          matches(registeredAfterFinalization, input)
        )
          registrations.delete(input.threadId);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            yield* markFailed(
              input,
              "Automatic recovery could not finish. Open a repair thread to investigate without repeating the original work.",
            ).pipe(Effect.ignore);
            return yield* new ThreadRecoveryError({ threadId: input.threadId, cause });
          }),
        ),
      ),
    );
  return ThreadRecoveryService.of({
    register: (input) =>
      Effect.sync(() => {
        const previous = registrations.get(input.threadId);
        if (previous !== undefined && !matches(previous, input))
          pendingFailures.delete(incidentKey(previous));
        registrations.set(input.threadId, input);
      }),
    completed: (input) =>
      Effect.sync(() => {
        pendingFailures.delete(incidentKey(input));
        const entry = registrations.get(input.threadId);
        if (entry !== undefined && matches(entry, input)) registrations.delete(input.threadId);
      }),
    suspect: (input) =>
      lock
        .withLock(
          input.threadId,
          Effect.gen(function* () {
            const registered = registrations.get(input.threadId);
            if (registered === undefined || !matches(registered, input)) return;
            yield* write(
              input,
              "suspect",
              "Turn updates stopped being recorded. Checking the provider before attempting recovery.",
              undefined,
              "running",
            );
          }),
        )
        .pipe(
          Effect.asVoid,
          Effect.mapError((cause) => new ThreadRecoveryError({ threadId: input.threadId, cause })),
        ),
    recover: (input) => recover(input, true),
    reconcile: Effect.suspend(() =>
      Effect.forEach(
        [...registrations.values()],
        (entry) =>
          recover(entry, false).pipe(
            Effect.catchCause((cause) => Effect.logWarning("Thread recovery failed", cause)),
          ),
        { concurrency: 4, discard: true },
      ),
    ),
    assertRepairable: (input) =>
      current(input).pipe(
        Effect.flatMap((state) => {
          const recovery = state?.thread.recovery;
          return recovery?.status === "failed" &&
            recovery.runId === input.runId &&
            recovery.attemptId === input.attemptId
            ? Effect.void
            : Effect.fail(
                new ThreadRecoveryError({
                  threadId: input.threadId,
                  cause: "Recovery incident is no longer current.",
                }),
              );
        }),
        Effect.mapError((cause) => new ThreadRecoveryError({ threadId: input.threadId, cause })),
      ),
    recordRepairThread: (input) =>
      lock
        .withLock(
          input.threadId,
          Effect.gen(function* () {
            const state = yield* current(input);
            const recovery = state?.thread.recovery;
            if (
              recovery?.status !== "failed" ||
              recovery.runId !== input.runId ||
              recovery.attemptId !== input.attemptId
            )
              return yield* new ThreadRecoveryError({
                threadId: input.threadId,
                cause: "Recovery incident is no longer current.",
              });
            if (!(yield* write(input, "failed", recovery.detail, input.repairThreadId)))
              return yield* new ThreadRecoveryError({
                threadId: input.threadId,
                cause: "Recovery incident changed during repair launch.",
              });
          }),
        )
        .pipe(
          Effect.mapError((cause) => new ThreadRecoveryError({ threadId: input.threadId, cause })),
        ),
  });
});
export const layer = Layer.effect(ThreadRecoveryService, make);
