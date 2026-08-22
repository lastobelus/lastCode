import {
  CommandId,
  ThreadId,
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

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import { UpdateDrain } from "./UpdateDrain.ts";

export const UpdateDrainAdmissionKind = [
  "thread-turn",
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
  const drain = yield* UpdateDrain;
  const projections = yield* ProjectionSnapshotQuery;
  const terminals = yield* TerminalManager;
  const mutex = yield* Semaphore.make(1);

  const currentBlockers = Effect.fn("UpdateDrainAdmission.currentBlockers")(function* () {
    const [shell, terminalState] = yield* Effect.all([
      projections.getShellSnapshot().pipe(Effect.mapError(internalError)),
      terminals.refreshMetadata,
    ]);
    const blockers: UpdateDrainBlocker[] = [];

    for (const thread of shell.threads) {
      if (thread.latestTurn?.state === "running") {
        blockers.push({
          type: "thread-turn",
          threadId: thread.id,
          turnId: thread.latestTurn.turnId,
          status: "running",
        });
      } else if (thread.session?.status === "starting" || thread.session?.status === "running") {
        blockers.push({
          type: "thread-turn",
          threadId: thread.id,
          turnId: thread.session.activeTurnId,
          status: thread.session.status,
        });
      }

      if (thread.backgroundLiveness) {
        blockers.push({
          type: "thread-background",
          threadId: thread.id,
          status: thread.backgroundLiveness,
        });
      }
    }

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

    return blockers.sort((left, right) => {
      const threadOrder = left.threadId.localeCompare(right.threadId);
      if (threadOrder !== 0) return threadOrder;
      const typeOrder = left.type.localeCompare(right.type);
      if (typeOrder !== 0) return typeOrder;
      if (left.type === "terminal-process" && right.type === "terminal-process") {
        return left.terminalId.localeCompare(right.terminalId);
      }
      return 0;
    });
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
      blockers: yield* currentBlockers(),
    } satisfies UpdateDrainStatus;
  });

  const dispatch: UpdateDrainAdmissionShape["dispatch"] = (command) =>
    mutex.withPermits(1)(drain.dispatch(command));

  const claimActivation: UpdateDrainAdmissionShape["claimActivation"] = (input) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const durable = yield* drain.status;
        if (durable.intent?.status === "draining" && durable.intent.requestId === input.requestId) {
          const blockers = yield* currentBlockers();
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
        if (durable.intent !== null && durable.intent.status !== "cancelled") {
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
