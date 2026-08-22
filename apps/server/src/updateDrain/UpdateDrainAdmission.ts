import {
  CommandId,
  ThreadId,
  UpdateActivationCommitError,
  type UpdateActivationCommitInput,
  UpdateActivationCommitResult,
  UpdateDrainAdmissionError,
  type UpdateDrainBlocker,
  type UpdateDrainCancelCommand,
  type UpdateDrainClaimInput,
  type UpdateDrainCommandReceipt,
  UpdateDrainError,
  type UpdateDrainStartCommand,
  type UpdateDrainState,
  type UpdateDrainStatus,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerConfig from "../config.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
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
  readonly commitUpdateActivation: (
    input: UpdateActivationCommitInput,
  ) => Effect.Effect<UpdateActivationCommitResult, UpdateActivationCommitError>;
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

function pendingTurnStartKey(threadId: string, messageId: string) {
  return `${threadId}\u0000${messageId}`;
}

interface UpdateActivationTrialOptions {
  readonly trial: UpdateActivationCommitInput;
  readonly existingCommit?: UpdateActivationCommitResult | undefined;
  readonly persistCommit: (
    record: UpdateActivationCommitResult,
  ) => Effect.Effect<void, UpdateActivationCommitError>;
}

const encodeUpdateActivationCommit = Schema.encodeSync(
  Schema.fromJsonString(UpdateActivationCommitResult),
);
const decodeUpdateActivationCommit = Schema.decodeUnknownEffect(
  Schema.fromJsonString(UpdateActivationCommitResult),
);

export const updateActivationCommitRecordPath = Effect.fn("updateActivationCommitRecordPath")(
  function* (baseDir: string, requestId: UpdateActivationCommitInput["requestId"]) {
    const path = yield* Path.Path;
    return path.join(baseDir, "runtime", "activation", requestId, "commit.json");
  },
);

export const persistUpdateActivationCommit = Effect.fn("persistUpdateActivationCommit")(function* (
  baseDir: string,
  record: UpdateActivationCommitResult,
) {
  const filePath = yield* updateActivationCommitRecordPath(baseDir, record.requestId);
  yield* writeFileStringAtomically({
    filePath,
    contents: `${encodeUpdateActivationCommit(record)}\n`,
    durable: true,
  });
});

export const readUpdateActivationCommit = Effect.fn("readUpdateActivationCommit")(function* (
  baseDir: string,
  trial: UpdateActivationCommitInput,
) {
  const fs = yield* FileSystem.FileSystem;
  const filePath = yield* updateActivationCommitRecordPath(baseDir, trial.requestId);
  if (!(yield* fs.exists(filePath))) return undefined;
  const commit = yield* fs
    .readFileString(filePath)
    .pipe(Effect.flatMap(decodeUpdateActivationCommit));
  if (commit.requestId !== trial.requestId || commit.targetDigest !== trial.targetDigest) {
    return yield* new UpdateActivationCommitError({
      reason: "request_mismatch",
      message: "Activation commit does not match the running trial.",
    });
  }
  return commit;
});

export const makeUpdateDrainAdmission = Effect.fn("makeUpdateDrainAdmission")(function* (
  activation?: UpdateActivationTrialOptions,
) {
  const drain = yield* UpdateDrain;
  const projections = yield* ProjectionSnapshotQuery;
  const projectionTurns = yield* ProjectionTurnRepository;
  const terminals = yield* TerminalManager;
  const mutex = yield* Semaphore.make(1);
  // The provider event stream is hot, so accepted starts from a previous
  // server lifetime cannot be resumed. Keep their exact identities out of the
  // live blocker set; a new start replaces the row with a new message id.
  const stalePendingTurnStartKeys = new Set(
    (yield* projectionTurns.listPendingTurnStarts().pipe(Effect.mapError(internalError))).map(
      (pending) => pendingTurnStartKey(pending.threadId, pending.messageId),
    ),
  );
  let activationCommit: UpdateActivationCommitResult | undefined;

  const admissionIsClosed = (durable: UpdateDrainState): boolean => {
    if (activation !== undefined) return activationCommit === undefined;
    return durable.intent?.status === "draining" || durable.intent?.status === "claimed";
  };

  const rejectClosedAdmission = (
    durable: UpdateDrainState,
    kind: UpdateDrainAdmissionKind,
  ): Effect.Effect<never, UpdateDrainAdmissionError | UpdateDrainError> => {
    if (durable.intent === null || durable.intent.status === "cancelled") {
      return Effect.fail(
        new UpdateDrainError({
          reason: "no_active_drain",
          message: "Trial update admission is closed without a durable activation claim.",
        }),
      );
    }
    if (activation !== undefined && durable.intent.requestId !== activation.trial.requestId) {
      return Effect.fail(
        new UpdateDrainError({
          reason: "request_mismatch",
          message: `Trial update '${activation.trial.requestId}' does not match active drain '${durable.intent.requestId}'.`,
        }),
      );
    }
    return Effect.fail(
      new UpdateDrainAdmissionError({
        reason: "update_draining",
        requestId: durable.intent.requestId,
        targetVersion: durable.intent.targetVersion,
        message: `Cannot start ${kind.replaceAll("-", " ")} while LastCode is awaiting update activation commit.`,
      }),
    );
  };

  const currentBlockers = Effect.fn("UpdateDrainAdmission.currentBlockers")(function* () {
    // Read pending starts first. If one transitions while the shell snapshot is
    // read, that newer snapshot contains the starting/running provider state.
    const pendingTurnStarts = yield* projectionTurns
      .listPendingTurnStarts()
      .pipe(Effect.mapError(internalError));
    const [shell, terminalState] = yield* Effect.all([
      projections.getShellSnapshot().pipe(Effect.mapError(internalError)),
      terminals.refreshMetadata,
    ]);
    const blockers: UpdateDrainBlocker[] = [];
    const blockedTurnThreadIds = new Set<string>();

    for (const thread of shell.threads) {
      if (thread.latestTurn?.state === "running") {
        blockedTurnThreadIds.add(thread.id);
        blockers.push({
          type: "thread-turn",
          threadId: thread.id,
          turnId: thread.latestTurn.turnId,
          status: "running",
        });
      } else if (thread.session?.status === "starting" || thread.session?.status === "running") {
        blockedTurnThreadIds.add(thread.id);
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

    for (const pending of pendingTurnStarts) {
      const pendingThreadId = pending.threadId;
      if (stalePendingTurnStartKeys.has(pendingTurnStartKey(pendingThreadId, pending.messageId))) {
        continue;
      }
      if (blockedTurnThreadIds.has(pendingThreadId)) continue;
      blockers.push({
        type: "thread-turn",
        threadId: pendingThreadId,
        turnId: null,
        status: "starting",
      });
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
    if (!admissionIsClosed(durable)) {
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

  const completeActivation = Effect.fn("UpdateDrainAdmission.completeActivation")(function* (
    record: UpdateActivationCommitResult,
  ) {
    const durable = yield* drain.status.pipe(
      Effect.mapError(
        () =>
          new UpdateActivationCommitError({
            reason: "drain_not_claimed",
            message: "Failed to verify the durable update drain activation claim.",
          }),
      ),
    );
    if (durable.intent?.status === "completed") {
      if (durable.intent.requestId === record.requestId) return;
      return yield* new UpdateActivationCommitError({
        reason: "request_mismatch",
        message: `Activation request '${record.requestId}' does not match completed request '${durable.intent.requestId}'.`,
      });
    }
    if (durable.intent?.requestId !== record.requestId) {
      return yield* new UpdateActivationCommitError({
        reason: "request_mismatch",
        message: `Activation request '${record.requestId}' does not match the durable update drain.`,
      });
    }
    if (durable.intent.status !== "claimed") {
      return yield* new UpdateActivationCommitError({
        reason: "drain_not_claimed",
        message: `Durable update drain '${record.requestId}' is not claimed for activation.`,
      });
    }
    yield* drain
      .dispatch({
        type: "update-drain.complete",
        commandId: CommandId.make(`update-drain:complete:${record.requestId}`),
        requestId: record.requestId,
        createdAt: DateTime.formatIso(yield* DateTime.now),
      })
      .pipe(
        Effect.mapError(
          () =>
            new UpdateActivationCommitError({
              reason: "drain_not_claimed",
              message: `Failed to durably complete update drain '${record.requestId}'.`,
            }),
        ),
      );
  });

  if (activation?.existingCommit !== undefined) {
    yield* completeActivation(activation.existingCommit);
    activationCommit = activation.existingCommit;
  }

  const commitUpdateActivation: UpdateDrainAdmissionShape["commitUpdateActivation"] = (input) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        if (activation === undefined) {
          return yield* new UpdateActivationCommitError({
            reason: "not_trial",
            message: "This server did not start as an update activation trial.",
          });
        }
        if (input.requestId !== activation.trial.requestId) {
          return yield* new UpdateActivationCommitError({
            reason: "request_mismatch",
            message: `Activation request '${input.requestId}' does not match trial request '${activation.trial.requestId}'.`,
          });
        }
        if (input.targetDigest !== activation.trial.targetDigest) {
          return yield* new UpdateActivationCommitError({
            reason: "digest_mismatch",
            message: "Activation target digest does not match the running trial package.",
          });
        }
        if (activationCommit !== undefined) return activationCommit;

        const durable = yield* drain.status.pipe(
          Effect.mapError(
            () =>
              new UpdateActivationCommitError({
                reason: "drain_not_claimed",
                message: "Failed to verify the durable update drain activation claim.",
              }),
          ),
        );
        if (
          durable.intent?.status !== "claimed" ||
          durable.intent.requestId !== activation.trial.requestId
        ) {
          return yield* new UpdateActivationCommitError({
            reason: "drain_not_claimed",
            message: `Durable update drain '${activation.trial.requestId}' is not claimed for activation.`,
          });
        }

        const record: UpdateActivationCommitResult = {
          ...activation.trial,
          schemaVersion: 1,
          status: "committed",
        };
        yield* activation.persistCommit(record);
        yield* completeActivation(record);
        activationCommit = record;
        return record;
      }),
    );

  const admit: UpdateDrainAdmissionShape["admit"] = (kind, effect) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const durable = yield* drain.status;
        if (admissionIsClosed(durable)) return yield* rejectClosedAdmission(durable, kind);
        return yield* effect;
      }),
    );

  const admitOrElse: UpdateDrainAdmissionShape["admitOrElse"] = (_kind, effect, whenClosed) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const durable = yield* drain.status;
        return yield* admissionIsClosed(durable) ? whenClosed : effect;
      }),
    );

  return UpdateDrainAdmission.of({
    dispatch,
    claimActivation,
    commitUpdateActivation,
    status: mutex.withPermits(1)(statusUnlocked()),
    admit,
    admitOrElse,
  });
});

export const layer = Layer.effect(
  UpdateDrainAdmission,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* makeUpdateDrainAdmission(
      config.updateActivationTrial === undefined
        ? undefined
        : {
            trial: config.updateActivationTrial,
            existingCommit: yield* readUpdateActivationCommit(
              config.baseDir,
              config.updateActivationTrial,
            ).pipe(
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.provideService(Path.Path, path),
              Effect.mapError(
                () =>
                  new UpdateActivationCommitError({
                    reason: "write_failed",
                    message: "Failed to read the update activation commit record.",
                  }),
              ),
            ),
            persistCommit: (record) =>
              persistUpdateActivationCommit(config.baseDir, record).pipe(
                Effect.provideService(FileSystem.FileSystem, fs),
                Effect.provideService(Path.Path, path),
                Effect.mapError(
                  () =>
                    new UpdateActivationCommitError({
                      reason: "write_failed",
                      message: "Failed to persist the update activation commit record.",
                    }),
                ),
              ),
          },
    );
  }),
);
