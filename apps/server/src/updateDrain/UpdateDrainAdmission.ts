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
  type UpdateDrainIntent,
  type UpdateDrainStartCommand,
  type UpdateDrainStatus,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import { UpdateDrain } from "./UpdateDrain.ts";

const UpdateDrainAdmissionKind = [
  "thread-turn",
  "thread-queue-start",
  "pull-request-watch-wake",
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
type UpdateDrainAdmissionKind = (typeof UpdateDrainAdmissionKind)[number];

type UpdateDrainLifecycleCommand = UpdateDrainStartCommand | UpdateDrainCancelCommand;
export const TOOL_MAINTENANCE_TARGET = "tool-maintenance";
const WATCH_PROCESS_PERMITS = 8;

const toolMaintenanceHoldsAdmission = (intent: UpdateDrainIntent | null) =>
  intent?.targetVersion === TOOL_MAINTENANCE_TARGET && intent.status !== "cancelled";

type AwaitingAdmission = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
) => Effect.Effect<A, E | UpdateDrainError, R>;

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
  readonly admitPullRequestWatchWake: AwaitingAdmission;
  readonly admitPullRequestWatchProcess: AwaitingAdmission;
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

export const currentExecutionBlockers = Effect.fn("currentExecutionBlockers")(function* (
  toolMaintenance = false,
) {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const terminals = yield* TerminalManager;
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;

  // Readers can commit cleanup after native turns become idle; cleanup can
  // then transfer to a runtime finalizer. Keep both runtime snapshots around
  // the outbox read so neither handoff disappears between these reads.
  const { shell, work } = toolMaintenance
    ? yield* projections.getToolMaintenanceSnapshot.pipe(Effect.mapError(internalError))
    : {
        shell: yield* projections.getShellSnapshot().pipe(Effect.mapError(internalError)),
        work: [],
      };
  const activeRunThreads = new Set<ThreadId>();
  const backgroundThreads = new Set<ThreadId>();
  const cleanupThreads = new Set<ThreadId>();
  for (const item of work) {
    switch (item.kind) {
      case "active-run":
        activeRunThreads.add(item.threadId);
        break;
      case "background":
        backgroundThreads.add(item.threadId);
        break;
      case "cleanup":
        cleanupThreads.add(item.threadId);
        break;
    }
  }
  const firstRuntimeWork = yield* providerSessions.pendingExecution.pipe(
    Effect.mapError(internalError),
  );
  const cleanup = yield* outbox.pendingCleanup.pipe(Effect.mapError(internalError));
  const secondRuntimeWork = yield* providerSessions.pendingExecution.pipe(
    Effect.mapError(internalError),
  );
  const terminalState = yield* terminals.refreshMetadata.pipe(Effect.mapError(internalError));
  for (const pending of cleanup) cleanupThreads.add(pending.threadId);
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
    const activeRun = activeRunThreads.delete(thread.id);
    if (activeRun || ["preparing", "queued", "starting", "running", "waiting"].includes(status)) {
      blockers.push({
        type: "thread-turn",
        threadId: thread.id,
        turnId: thread.activeRunId === null ? null : TurnId.make(thread.activeRunId),
        status: status === "running" || status === "waiting" ? "running" : "starting",
      });
    }
    const backgroundOutstanding = backgroundThreads.delete(thread.id);
    const background = thread.pendingBackgroundTasks ?? [];
    if (backgroundOutstanding || background.length > 0) {
      blockers.push({
        type: "thread-background",
        threadId: thread.id,
        status:
          backgroundOutstanding || background.some((task) => task.kind !== "monitor")
            ? "working"
            : "monitoring",
      });
    }
  }

  for (const threadId of activeRunThreads)
    blockers.push({ type: "thread-turn", threadId, turnId: null, status: "starting" });
  for (const threadId of backgroundThreads)
    blockers.push({ type: "thread-background", threadId, status: "working" });
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
    const rightOwner = right.type === "provider-runtime" ? right.providerSessionId : right.threadId;
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

export const makeUpdateDrainAdmission = Effect.fn("makeUpdateDrainAdmission")(function* () {
  const context = yield* Effect.context<
    | ProjectionStore.ProjectionStoreV2
    | TerminalManager
    | EffectOutbox.EffectOutboxV2
    | ProviderSessionManager.ProviderSessionManagerV2
  >();
  return yield* makeAdmission((toolMaintenance) =>
    currentExecutionBlockers(toolMaintenance).pipe(Effect.provide(context)),
  );
});

const makeAdmission = Effect.fn("UpdateDrainAdmission.makeAdmission")(function* (
  currentBlockers: (
    toolMaintenance: boolean,
  ) => Effect.Effect<ReadonlyArray<UpdateDrainBlocker>, UpdateDrainError>,
) {
  const drain = yield* UpdateDrain;
  const mutex = yield* Semaphore.make(1);
  // Maintenance waits for admitted watch subprocesses before closing. Idle
  // subscriptions and network reads do not need a permit.
  const watchProcesses = yield* Semaphore.make(WATCH_PROCESS_PERMITS);
  let released = yield* Deferred.make<void>();

  const waitForAdmission =
    (
      gate: Semaphore.Semaphore,
      isClosed: (intent: UpdateDrainIntent | null) => boolean,
    ): AwaitingAdmission =>
    (effect) =>
      Effect.gen(function* () {
        while (true) {
          const result = yield* gate.withPermits(1)(
            Effect.gen(function* () {
              const release = released;
              const { intent } = yield* drain.status;
              if (isClosed(intent)) return { admitted: false as const, release };
              return { admitted: true as const, value: yield* effect };
            }),
          );
          if (result.admitted) return result.value;
          // Watch stream acquisition and finalizers can mask interruption. Waiting
          // for release must still let the stream stop without spawning a process.
          yield* Deferred.await(result.release).pipe(Effect.interruptible);
        }
      });

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
      blockers: yield* currentBlockers(durable.intent.targetVersion === TOOL_MAINTENANCE_TARGET),
    } satisfies UpdateDrainStatus;
  });

  const dispatch: UpdateDrainAdmissionShape["dispatch"] = (command) => {
    if (command.type === "update-drain.cancel") {
      return mutex.withPermits(1)(
        drain.dispatch(command).pipe(
          Effect.tap(() =>
            Effect.gen(function* () {
              const previous = released;
              released = yield* Deferred.make<void>();
              yield* Deferred.succeed(previous, undefined);
            }),
          ),
          Effect.uninterruptible,
        ),
      );
    }
    const start = drain.dispatch(command);
    return mutex.withPermits(1)(
      command.targetVersion === TOOL_MAINTENANCE_TARGET
        ? watchProcesses.withPermits(WATCH_PROCESS_PERMITS)(start)
        : start,
    );
  };

  const claimActivation: UpdateDrainAdmissionShape["claimActivation"] = (input) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const durable = yield* drain.status;
        if (durable.intent?.status === "draining" && durable.intent.requestId === input.requestId) {
          const blockers = yield* currentBlockers(
            durable.intent.targetVersion === TOOL_MAINTENANCE_TARGET,
          );
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
          !(kind === "thread-queue-start" && !toolMaintenanceHoldsAdmission(durable.intent)) &&
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
    admitPullRequestWatchWake: waitForAdmission(mutex, toolMaintenanceHoldsAdmission),
    admitPullRequestWatchProcess: waitForAdmission(watchProcesses, toolMaintenanceHoldsAdmission),
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
  const admission = yield* makeAdmission(() => unavailable);
  return UpdateDrainAdmission.of({
    ...admission,
    status: unavailable,
    claimActivation: Effect.fn("UpdateDrainAdmission.claimActivation")(() => unavailable),
  });
});

export const layerOffline = Layer.effect(UpdateDrainAdmission, makeOfflineAdmission);
