import {
  CommandId,
  type ProviderSessionId,
  ThreadId,
  TurnId,
  UpdateDrainAdmissionError,
  type UpdateDrainBlocker,
  type UpdateDrainCancelCommand,
  type UpdateDrainClaimInput,
  type UpdateDrainCommandReceipt,
  UpdateDrainError,
  type UpdateDrainStartCommand,
  type UpdateDrainStatus,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import { UpdateDrain } from "./UpdateDrain.ts";

export const UpdateDrainAdmissionKind = [
  "thread-turn",
  "thread-archive",
  "thread-delete",
  "thread-teardown",
  "thread-settle",
  "terminal-open",
  "terminal-restart",
  "terminal-write",
  "action-resume",
  "setup-script",
] as const;
export type UpdateDrainAdmissionKind = (typeof UpdateDrainAdmissionKind)[number];

type UpdateDrainLifecycleCommand = UpdateDrainStartCommand | UpdateDrainCancelCommand;

export interface UpdateDrainAdmissionShape {
  readonly dispatch: (
    command: UpdateDrainLifecycleCommand,
  ) => Effect.Effect<UpdateDrainCommandReceipt, UpdateDrainError>;
  readonly claimActivation: (
    input: UpdateDrainClaimInput,
  ) => Effect.Effect<UpdateDrainCommandReceipt, UpdateDrainError>;
  readonly status: Effect.Effect<UpdateDrainStatus, UpdateDrainError>;
  readonly admit: <A, E, R>(
    kind: UpdateDrainAdmissionKind,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | UpdateDrainAdmissionError | UpdateDrainError, R>;
  readonly admitOrElse: <A, E, R, ClosedError, ClosedRequirements>(
    kind: UpdateDrainAdmissionKind,
    effect: Effect.Effect<A, E, R>,
    whenClosed: Effect.Effect<A, ClosedError, ClosedRequirements>,
  ) => Effect.Effect<A, E | ClosedError | UpdateDrainError, R | ClosedRequirements>;
}

export class UpdateDrainAdmission extends Context.Service<
  UpdateDrainAdmission,
  UpdateDrainAdmissionShape
>()("t3/updateDrain/UpdateDrainAdmission") {}

function internalError(_cause: unknown) {
  return new UpdateDrainError({
    reason: "internal_error",
    message: "Failed to derive current update drain blockers.",
  });
}

export const makeUpdateDrainAdmission = Effect.fn("makeUpdateDrainAdmission")(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const terminals = yield* TerminalManager;
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const currentBlockers = Effect.fn("UpdateDrainAdmission.currentBlockers")(function* () {
    // Readers can commit cleanup after native turns become idle; cleanup can
    // then transfer to a runtime finalizer. Keep both runtime snapshots around
    // the outbox read so neither handoff disappears between these reads.
    const shell = yield* projections.getShellSnapshot().pipe(Effect.mapError(internalError));
    const firstRuntimeWork = yield* providerSessions.pendingExecution.pipe(
      Effect.mapError(internalError),
    );
    const cleanup = yield* outbox.pendingCleanup.pipe(Effect.mapError(internalError));
    const secondRuntimeWork = yield* providerSessions.pendingExecution.pipe(
      Effect.mapError(internalError),
    );
    const terminalState = yield* terminals.refreshMetadata.pipe(Effect.mapError(internalError));
    const cleanupThreads = new Set(cleanup.map((pending) => pending.threadId));
    const blockers: UpdateDrainBlocker[] = [];

    // V2 commits the accepted run before provider start, so preparing and queued
    // work are already durable blockers. Restart recovery owns interruption of
    // old runs; admission must not discard a still-live run on its own.
    for (const thread of [...shell.threads, ...shell.archivedThreads]) {
      // Archive cancels projected runs before provider shutdown. Keep the hold
      // until completion, and retain failed/unfinished runtime close evidence
      // even after the failed archive banner is dismissed.
      if (thread.archivePending?.status === "stopping")
        blockers.push({ type: "provider-teardown", threadId: thread.id });
      if (
        thread.worktreeCleanup?.status === "queued" ||
        thread.worktreeCleanup?.status === "deleting"
      )
        cleanupThreads.add(thread.id);
      if (thread.deletedAt != null) continue;
      const status = thread.activityRunStatus ?? thread.status;
      if (["preparing", "queued", "starting", "running", "waiting"].includes(status)) {
        blockers.push({
          type: "thread-turn",
          threadId: thread.id,
          turnId: thread.activeRunId === null ? null : TurnId.make(thread.activeRunId),
          status: status === "running" || status === "waiting" ? "running" : "starting",
        });
      }
      if ((thread.pendingBackgroundTasks?.length ?? 0) > 0) {
        blockers.push({
          type: "thread-background",
          threadId: thread.id,
          status: thread.pendingBackgroundTasks!.some((task) => task.kind !== "monitor")
            ? "working"
            : "monitoring",
        });
      }
    }

    for (const threadId of cleanupThreads) blockers.push({ type: "thread-cleanup", threadId });

    for (const terminal of terminalState) {
      if (terminal.status !== "starting" && !terminal.hasRunningSubprocess) continue;
      blockers.push({
        type: "terminal-process",
        threadId: ThreadId.make(terminal.threadId),
        terminalId: terminal.terminalId,
        label: terminal.label,
        status: terminal.status === "starting" ? "starting" : "running",
      });
    }

    const runtimeWork = new Map<ProviderSessionId, (typeof firstRuntimeWork)[number]>();
    for (const pending of [...firstRuntimeWork, ...secondRuntimeWork]) {
      if (runtimeWork.get(pending.providerSessionId)?.status !== "stopping")
        runtimeWork.set(pending.providerSessionId, pending);
    }
    for (const pending of runtimeWork.values())
      blockers.push({ type: "provider-runtime", ...pending });

    return blockers.sort((left, right) => {
      const leftOwner = left.type === "provider-runtime" ? left.providerSessionId : left.threadId;
      const rightOwner =
        right.type === "provider-runtime" ? right.providerSessionId : right.threadId;
      const threadOrder = leftOwner.localeCompare(rightOwner);
      if (threadOrder !== 0) return threadOrder;
      const typeOrder = left.type.localeCompare(right.type);
      if (typeOrder !== 0) return typeOrder;
      if (left.type === "terminal-process" && right.type === "terminal-process") {
        return left.terminalId.localeCompare(right.terminalId);
      }
      return 0;
    });
  });

  return yield* makeAdmission(currentBlockers());
});

const makeAdmission = Effect.fn("UpdateDrainAdmission.makeAdmission")(function* (
  currentBlockers: Effect.Effect<ReadonlyArray<UpdateDrainBlocker>, UpdateDrainError>,
) {
  const drain = yield* UpdateDrain;
  const mutex = yield* Semaphore.make(1);

  const statusUnlocked = Effect.fn("UpdateDrainAdmission.statusUnlocked")(function* () {
    const durable = yield* drain.status;
    if (durable.intent === null || durable.intent.status === "cancelled") {
      return {
        ...durable,
        admission: "open" as const,
        blockers: [],
      } satisfies UpdateDrainStatus;
    }
    return {
      ...durable,
      admission: "closed" as const,
      blockers: yield* currentBlockers,
    } satisfies UpdateDrainStatus;
  });

  const dispatch: UpdateDrainAdmissionShape["dispatch"] = (command) =>
    mutex.withPermits(1)(drain.dispatch(command));

  const claimActivation: UpdateDrainAdmissionShape["claimActivation"] = (input) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const durable = yield* drain.status;
        if (durable.intent?.status === "draining" && durable.intent.requestId === input.requestId) {
          const blockers = yield* currentBlockers;
          if (blockers.length > 0) {
            return yield* new UpdateDrainError({
              reason: "not_quiescent",
              message: `Update drain '${input.requestId}' still has ${blockers.length} execution blocker${blockers.length === 1 ? "" : "s"}.`,
            });
          }
        }

        return yield* drain.dispatch({
          type: "update-drain.claim",
          commandId: CommandId.make(`update-drain:claim:${input.requestId}`),
          requestId: input.requestId,
          createdAt: DateTime.formatIso(yield* DateTime.now),
        });
      }),
    );

  const admit: UpdateDrainAdmissionShape["admit"] = (kind, effect) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const durable = yield* drain.status;
        // Settlement finishes admitted work (including automatic queued wakes).
        // It may drain under this lock, but cannot start cleanup after activation.
        if (
          durable.intent !== null &&
          durable.intent.status !== "cancelled" &&
          !(kind === "thread-settle" && durable.intent.status === "draining")
        ) {
          return yield* new UpdateDrainAdmissionError({
            reason: "update_draining",
            requestId: durable.intent.requestId,
            targetVersion: durable.intent.targetVersion,
            message: `Cannot start ${kind.replaceAll("-", " ")} while LastCode is draining for update ${durable.intent.targetVersion}.`,
          });
        }
        return yield* effect;
      }),
    );

  const admitOrElse: UpdateDrainAdmissionShape["admitOrElse"] = (_kind, effect, whenClosed) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const durable = yield* drain.status;
        return yield* durable.intent !== null && durable.intent.status !== "cancelled"
          ? whenClosed
          : effect;
      }),
    );

  return UpdateDrainAdmission.of({
    dispatch,
    claimActivation,
    status: mutex.withPermits(1)(statusUnlocked()),
    admit,
    admitOrElse,
  });
});

export const layer = Layer.effect(UpdateDrainAdmission, makeUpdateDrainAdmission());

/** Only for a caller holding exclusive offline server ownership for the whole operation. */
export const makeOfflineAdmission = Effect.gen(function* () {
  const unavailable = Effect.fail(
    new UpdateDrainError({
      reason: "internal_error",
      message: "Live execution status and activation claims are unavailable in offline mode.",
    }),
  );
  const admission = yield* makeAdmission(unavailable);
  return UpdateDrainAdmission.of({
    ...admission,
    status: unavailable,
    claimActivation: () => unavailable,
  });
});

export const layerOffline = Layer.effect(UpdateDrainAdmission, makeOfflineAdmission);
