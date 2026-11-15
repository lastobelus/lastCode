import {
  CommandId,
  EnvironmentPauseError,
  environmentPauseResumeComplete,
  isProviderNativeSubagentThread,
  type EnvironmentPauseStatus,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessions from "../orchestration-v2/ProviderSessionManager.ts";
import * as PreviewHosting from "../preview/Hosting.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import * as ServerSettings from "../serverSettings.ts";
import { currentExecutionBlockers } from "../updateDrain/UpdateDrainAdmission.ts";
import * as Store from "./EnvironmentPauseStore.ts";
import {
  pauseActivity,
  deferredActivity,
  EnvironmentPauseCaller,
  pauseExecutionBlockers,
} from "./EnvironmentPauseActivity.ts";

export class EnvironmentPause extends Context.Service<
  EnvironmentPause,
  {
    readonly status: Effect.Effect<EnvironmentPauseStatus, EnvironmentPauseError>;
    readonly start: Effect.Effect<EnvironmentPauseStatus, EnvironmentPauseError>;
    readonly retry: Effect.Effect<EnvironmentPauseStatus, EnvironmentPauseError>;
    readonly resume: Effect.Effect<EnvironmentPauseStatus, EnvironmentPauseError>;
    readonly continueResume: Effect.Effect<void, EnvironmentPauseError>;
  }
>()("t3/environment/EnvironmentPause") {}

type Target = Store.StoredSession["targets"][number];
const needsResume = (target: Target) =>
  target.pause !== "pending" && (target.pause === "sent" || target.resumeRequired === true);
const resumeComplete = (session: Store.StoredSession) =>
  environmentPauseResumeComplete(session) &&
  session.targets.every(
    (target) =>
      !target.resumeRequired || target.resume === "sent" || target.resume === "unavailable",
  );

const make = Effect.gen(function* () {
  const store = yield* Store.EnvironmentPauseStore;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  const random = yield* SecureRandom.SecureRandom;
  const executionContext = yield* Effect.context<
    | ProjectionStore.ProjectionStoreV2
    | ProviderSessions.ProviderSessionManagerV2
    | TerminalManager
    | EffectOutbox.EffectOutboxV2
  >();
  const operations = yield* Semaphore.make(1);
  const recovery = yield* Semaphore.make(1);
  const operationActive = yield* Ref.make(0);
  let resumeRevision = 0;
  const readShell = projections
    .getShellSnapshot()
    .pipe(
      Effect.mapError(
        (cause) => new EnvironmentPauseError({ operation: "status", reason: "unavailable", cause }),
      ),
    );
  const previewHosting = yield* Effect.serviceOption(PreviewHosting.PreviewHosting);
  const readBlockers = Effect.gen(function* () {
    const blockers = yield* currentExecutionBlockers().pipe(Effect.provide(executionContext));
    const previews = Option.isSome(previewHosting)
      ? yield* previewHosting.value.list().pipe(Effect.orElseSucceed(() => []))
      : [];
    return { blockers, previews };
  });
  const readTargets = Effect.gen(function* () {
    const session = yield* store.get;
    const automationPaused = session !== null && session.phase !== "resuming";
    const shell = yield* readShell;
    const deferred = yield* outbox.deferredAutomaticExecution.pipe(
      Effect.mapError(
        (cause) => new EnvironmentPauseError({ operation: "status", reason: "unavailable", cause }),
      ),
    );
    const pending = yield* outbox.pendingExecution.pipe(
      Effect.mapError(
        (cause) => new EnvironmentPauseError({ operation: "status", reason: "unavailable", cause }),
      ),
    );
    const pendingIds = new Set(
      pending.filter(({ providerMessage }) => providerMessage).map(({ threadId }) => threadId),
    );
    const activity = pauseActivity(
      [...shell.threads, ...shell.archivedThreads],
      deferred,
      automationPaused,
    );
    // Archived work still blocks quiet in status, but cannot accept messages.
    return {
      deferred,
      threads: shell.threads.filter(
        (thread) =>
          thread.archivedAt == null &&
          thread.deletedAt == null &&
          !isProviderNativeSubagentThread(thread) &&
          (activity.activeThread(thread) || pendingIds.has(thread.id)),
      ),
    };
  });

  const readResumeRecipient = (
    session: Store.StoredSession,
    target: Store.StoredSession["targets"][number],
  ) =>
    projections
      .getThreadRecords(target.threadId, ["messages"], {
        messageIds: [Store.deliveryIdentity(session, target, "resume").messageId],
      })
      .pipe(Effect.result);

  const readSubmission = Effect.fnUntraced(function* (
    session: Store.StoredSession,
    target: Store.StoredSession["targets"][number],
    direction: "pause" | "resume",
  ) {
    const identity = Store.deliveryIdentity(session, target, direction);
    const record = yield* projections
      .getThreadRecords(target.threadId, ["messages"], { messageIds: [identity.messageId] })
      .pipe(Effect.result);
    const effects = yield* outbox.listByCommandId(identity.commandId).pipe(Effect.result);
    // Dispatch commits messages and effects atomically. A failed response/reload
    // after that commit is not evidence that submitting another message is safe.
    if (
      (record._tag === "Success" &&
        record.success.messages.some((message) => message.id === identity.messageId)) ||
      (effects._tag === "Success" && effects.success.length > 0)
    )
      return "accepted" as const;
    if (
      effects._tag === "Failure" ||
      (record._tag === "Failure" && record.failure._tag !== "ProjectionStoreThreadNotFoundError")
    )
      return "unknown" as const;
    return "unsubmitted" as const;
  });

  const reconcileResumeRecipients = Effect.gen(function* () {
    const session = yield* store.get;
    const retryable = new Set<ThreadId>();
    if (session === null) return retryable;
    for (const target of session.targets) {
      if (
        (session.phase !== "resuming" && !target.rePause) ||
        !needsResume(target) ||
        target.resume === "sent" ||
        target.resume === "unavailable" ||
        (target.resume === "pending" && target.resumeAccepted)
      )
        continue;
      // Tombstones keep their messages. Read them directly so deletion cannot hide
      // a committed resume whose delivery receipt has not reached the pause file.
      const record = yield* readResumeRecipient(session, target);
      let accepted =
        record._tag === "Success" && record.success.messages.length > 0 && !target.resumeAccepted;
      let unavailable =
        !accepted &&
        (record._tag === "Failure"
          ? record.failure._tag === "ProjectionStoreThreadNotFoundError"
          : record.success.thread.archivedAt !== null || record.success.thread.deletedAt !== null);
      if (unavailable && !target.resumeAccepted) {
        const effects = yield* outbox
          .listByCommandId(Store.deliveryIdentity(session, target, "resume").commandId)
          .pipe(Effect.result);
        if (effects._tag === "Failure") continue;
        // A committed command may outlive its projection. Claimed native delivery
        // cannot be dismissed just because the recipient later disappeared.
        if (
          effects.success.some(
            (effect) =>
              (effect.request.type === "provider-turn.start" ||
                effect.request.type === "provider-turn.steer") &&
              (effect.attemptCount > 0 ||
                effect.status === "pending" ||
                effect.status === "running"),
          )
        ) {
          accepted = true;
          unavailable = false;
        }
      }
      if (!accepted && !unavailable) {
        if (record._tag === "Success") retryable.add(target.threadId);
        continue;
      }
      yield* store.update((current) =>
        current?.id !== session.id
          ? current
          : {
              ...current,
              targets: current.targets.map((latest) =>
                latest.threadId !== target.threadId ||
                latest.resumeAttempt !== target.resumeAttempt ||
                latest.resume === "sent" ||
                latest.resume === "unavailable" ||
                (latest.resume === "pending" && latest.resumeAccepted)
                  ? latest
                  : {
                      ...latest,
                      resume: accepted ? ("pending" as const) : ("unavailable" as const),
                      resumeAccepted: accepted,
                      error: accepted
                        ? null
                        : "This thread was archived or deleted and cannot receive Resume.",
                    },
              ),
            },
      );
    }
    return retryable;
  });

  const retireUnavailablePauseRecipients = Effect.gen(function* () {
    const session = yield* store.get;
    if (session === null || session.phase === "resuming") return false;
    let unknown = false;
    for (const target of session.targets) {
      if (
        target.pause === "sent" ||
        target.pause === "unavailable" ||
        (target.pause === "pending" && target.pauseAccepted)
      )
        continue;
      const identity = Store.deliveryIdentity(session, target, "pause");
      const record = yield* projections
        .getThreadRecords(target.threadId, ["messages"], { messageIds: [identity.messageId] })
        .pipe(Effect.result);
      if (
        record._tag === "Failure" &&
        record.failure._tag !== "ProjectionStoreThreadNotFoundError"
      ) {
        unknown = true;
        continue;
      }
      const unavailable =
        record._tag === "Failure" ||
        record.success.thread.archivedAt !== null ||
        record.success.thread.deletedAt !== null;
      if (!unavailable) continue;
      let accepted = false;
      if (!target.pauseAccepted) {
        const effects = yield* outbox.listByCommandId(identity.commandId).pipe(Effect.result);
        if (effects._tag === "Failure") {
          unknown = true;
          continue;
        }
        // A committed command can precede pause bookkeeping. Let the normal
        // delivery reconciliation inspect its queued run and native evidence.
        accepted =
          (record._tag === "Success" && record.success.messages.length > 0) ||
          effects.success.some(
            (effect) =>
              effect.request.type === "provider-turn.start" ||
              effect.request.type === "provider-turn.steer",
          );
      }
      // failed + accepted is a definitive negative receipt, not an uncertain
      // acceptance. Successful recipients keep their original Resume obligation.
      yield* store.update((current) =>
        current?.id !== session.id
          ? current
          : {
              ...current,
              targets: current.targets.map((latest) =>
                latest.threadId !== target.threadId ||
                latest.pauseAttempt !== target.pauseAttempt ||
                latest.pause !== target.pause ||
                latest.pauseAccepted !== target.pauseAccepted
                  ? latest
                  : {
                      ...latest,
                      pause: accepted ? ("pending" as const) : ("unavailable" as const),
                      pauseAccepted: accepted || latest.pauseAccepted,
                      error: accepted
                        ? null
                        : "This thread is no longer available and did not receive Pause.",
                    },
              ),
            },
      );
    }
    return unknown;
  });
  const reconcileUnavailablePauseRecipients = Effect.gen(function* () {
    // Admission and its bookkeeping own these rows until fanout completes.
    if (yield* Ref.get(operationActive)) return false;
    return yield* retireUnavailablePauseRecipients;
  });

  const recoverUnaccepted = Effect.gen(function* () {
    // Live fanout owns these pending rows until its command result/receipt is saved.
    // A newly constructed service has no such operation, so it can recover them.
    if (yield* Ref.get(operationActive)) return false;
    const session = yield* store.get;
    if (session === null) return false;
    let unknown = false;
    for (const target of session.targets) {
      for (const direction of ["pause", "resume"] as const) {
        if (direction === "resume" && session.phase !== "resuming" && !target.rePause) continue;
        if (
          (direction === "resume" && !needsResume(target)) ||
          (target[direction] !== "pending" && target[direction] !== "failed") ||
          target[`${direction}Accepted`]
        )
          continue;
        const submission = yield* readSubmission(session, target, direction);
        const accepted = submission === "accepted";
        if (submission === "unknown") {
          unknown = true;
          if (target[direction] === "pending") continue;
        }
        if (submission === "unsubmitted" && target[direction] === "failed") continue;
        yield* store.update((current) =>
          current?.id !== session.id
            ? current
            : {
                ...current,
                targets: current.targets.map((latest) =>
                  latest.threadId !== target.threadId ||
                  latest[`${direction}Attempt`] !== target[`${direction}Attempt`] ||
                  latest[direction] !== target[direction] ||
                  latest[`${direction}Accepted`]
                    ? latest
                    : {
                        ...latest,
                        [direction]:
                          submission === "unsubmitted" ? ("failed" as const) : ("pending" as const),
                        [`${direction}Accepted`]: accepted,
                        error: accepted
                          ? null
                          : submission === "unknown"
                            ? "The message submission could not be confirmed. Waiting for recovery."
                            : "The message was not submitted before the server stopped. Retry to send it.",
                      },
                ),
              },
        );
      }
    }
    return (yield* reconcileUnavailablePauseRecipients) || unknown;
  });
  const reconcileUnaccepted = recovery.withPermits(1)(recoverUnaccepted);

  const retireCancelledPauses = Effect.gen(function* () {
    const session = yield* store.get;
    if (session === null) return;
    for (const target of session.targets) {
      if (target.pause !== "failed" || !target.pauseAccepted) continue;
      const identity = Store.deliveryIdentity(session, target, "pause");
      const record = yield* projections
        .getThreadRecords(target.threadId, ["messages", "runs", "providerTurns"], {
          messageIds: [identity.messageId],
        })
        .pipe(Effect.result);
      if (record._tag === "Failure") continue;
      const message = record.success.messages.find((message) => message.id === identity.messageId);
      const run = record.success.runs.find(
        (run) => run.id === message?.runId && run.userMessageId === identity.messageId,
      );
      if (
        run?.status !== "cancelled" ||
        record.success.providerTurns.some(
          (turn) =>
            turn.nativeTurnRef !== null &&
            ((run.rootNodeId !== null && turn.nodeId === run.rootNodeId) ||
              (run.activeAttemptId !== null && turn.runAttemptId === run.activeAttemptId)),
        )
      )
        continue;
      const effects = yield* outbox
        .listByCommandId(CommandId.make(`command:system:start-queued:${run.id}`))
        .pipe(Effect.result);
      if (effects._tag === "Failure" || effects.success.some((effect) => effect.attemptCount > 0))
        continue;
      yield* store.recordDelivery(identity.messageId, "cancelled");
    }
  });

  const withOperation = (effect: Effect.Effect<EnvironmentPauseStatus, EnvironmentPauseError>) =>
    operations.withPermits(1)(
      Effect.acquireUseRelease(
        // Finish any observation of unsent rows before fanout owns them. The
        // recovery lock is released before dispatch so status remains live.
        recovery.withPermits(1)(
          recoverUnaccepted.pipe(Effect.andThen(Ref.update(operationActive, (count) => count + 1))),
        ),
        () => effect,
        () => Ref.update(operationActive, (count) => count - 1),
      ),
    );
  const withResumeOperation = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.acquireUseRelease(
      Ref.update(operationActive, (count) => count + 1),
      () => effect,
      () => Ref.update(operationActive, (count) => count - 1),
    );

  const status = Effect.gen(function* (): Effect.fn.Return<
    EnvironmentPauseStatus,
    EnvironmentPauseError
  > {
    const recoveryUnknown = yield* reconcileUnaccepted;
    yield* retireCancelledPauses;
    yield* reconcileResumeRecipients;
    let session = yield* store.get;
    if (session?.phase === "resuming" && resumeComplete(session)) {
      const deferred = yield* outbox.pendingAutomaticRelease.pipe(
        Effect.mapError(
          (cause) =>
            new EnvironmentPauseError({ operation: "status", reason: "unavailable", cause }),
        ),
      );
      // Resume opens admission immediately. Keep its durable intent until held
      // work starts, so a restart before the scheduler's next pass cannot lose it.
      if (deferred.length === 0) {
        yield* store.update((current) =>
          current?.id === session?.id && current?.phase === "resuming" && resumeComplete(current)
            ? null
            : current,
        );
        session = yield* store.get;
      }
    }
    // Recovery discovery for disabled environments is one cheap read; no execution scan.
    if (
      session === null &&
      !(yield* settings.getSettings.pipe(
        Effect.mapError(
          (cause) =>
            new EnvironmentPauseError({ operation: "status", reason: "unavailable", cause }),
        ),
      )).environmentPauseEnabled
    ) {
      return {
        session: null,
        activeThreadCount: 0,
        blockers: [],
        quiet: false,
        observation: "known",
      };
    }
    let deliveryUnknown = recoveryUnknown;
    if (session !== null) {
      for (const target of session.targets) {
        for (const direction of session.phase === "resuming" || target.rePause
          ? (["pause", "resume"] as const)
          : (["pause"] as const)) {
          if (direction === "resume" && !needsResume(target)) continue;
          if (target[direction] !== "pending") continue;
          if (!target[`${direction}Accepted`]) {
            if ((yield* readSubmission(session, target, direction)) === "unknown")
              deliveryUnknown = true;
            continue;
          }
          const identity = Store.deliveryIdentity(session, target, direction);
          let effects = yield* outbox
            .listByCommandId(identity.commandId)
            .pipe(
              Effect.mapError(
                (cause) =>
                  new EnvironmentPauseError({ operation: "status", reason: "unavailable", cause }),
              ),
            );
          let deliveries = effects.filter(
            (effect) =>
              effect.request.type === "provider-turn.start" ||
              effect.request.type === "provider-turn.steer",
          );
          if (deliveries.length === 0) {
            const records = yield* projections
              .getThreadRecords(target.threadId, ["messages", "runs", "providerTurns"], {
                messageIds: [identity.messageId],
              })
              .pipe(Effect.result);
            if (records._tag === "Failure") {
              deliveryUnknown = true;
              continue;
            }
            const message = records.success.messages.find(
              (message) => message.id === identity.messageId,
            );
            const run = records.success.runs.find(
              (run) => run.id === message?.runId && run.userMessageId === identity.messageId,
            );
            if (run === undefined) {
              deliveryUnknown = true;
              continue;
            }
            // Queued messages acquire their start effect under a later system command.
            // The original message command has no provider effect while waiting.
            if (run.status === "queued") continue;
            effects = yield* outbox
              .listByCommandId(CommandId.make(`command:system:start-queued:${run.id}`))
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new EnvironmentPauseError({
                      operation: "status",
                      reason: "unavailable",
                      cause,
                    }),
                ),
              );
            deliveries = effects.filter((effect) => effect.request.type === "provider-turn.start");
            const nativeAcceptance = records.success.providerTurns.some(
              (turn) =>
                turn.nativeTurnRef !== null &&
                ((run.rootNodeId !== null && turn.nodeId === run.rootNodeId) ||
                  (run.activeAttemptId !== null && turn.runAttemptId === run.activeAttemptId)),
            );
            if (
              deliveries.length === 0 &&
              !nativeAcceptance &&
              (run.status === "cancelled" || run.status === "failed")
            ) {
              yield* store.recordDelivery(
                identity.messageId,
                run.status === "cancelled" && direction === "pause" ? "cancelled" : false,
              );
              continue;
            }
            if (deliveries.length === 0) {
              deliveryUnknown = true;
              continue;
            }
          }
          const unsettled = deliveries.some(
            (effect) => effect.status === "pending" || effect.status === "running",
          );
          if (unsettled) continue;
          if (
            deliveries.some(
              (effect) =>
                (effect.status === "cancelled" || effect.status === "failed") &&
                effect.attemptCount === 0,
            )
          ) {
            yield* store.recordDelivery(
              identity.messageId,
              direction === "pause" && deliveries.every((effect) => effect.status === "cancelled")
                ? "cancelled"
                : false,
            );
          } else {
            // A crash between native acceptance and its receipt cannot prove non-delivery.
            // Keep the target; never re-send it or declare it safely paused by inference.
            deliveryUnknown = true;
          }
        }
      }
      deliveryUnknown =
        (yield* recovery.withPermits(1)(reconcileUnavailablePauseRecipients)) || deliveryUnknown;
      session = yield* store.get;
    }
    const execution = yield* readBlockers.pipe(Effect.result);
    const pending = yield* outbox.pendingExecution.pipe(Effect.result);
    const shell = yield* readShell.pipe(Effect.result);
    const automationPaused = session !== null && session.phase !== "resuming";
    const deferred = yield* (
      automationPaused ? outbox.deferredAutomaticExecution : Effect.succeed([])
    ).pipe(Effect.result);
    const known =
      execution._tag === "Success" &&
      shell._tag === "Success" &&
      pending._tag === "Success" &&
      deferred._tag === "Success" &&
      !deliveryUnknown;
    const shellThreads =
      shell._tag === "Success" ? [...shell.success.threads, ...shell.success.archivedThreads] : [];
    const deferredRuns = deferred._tag === "Success" ? deferred.success : [];
    const caller = yield* EnvironmentPauseCaller;
    const activity = pauseActivity(shellThreads, deferredRuns, automationPaused, caller);
    const blockers =
      execution._tag === "Success"
        ? pauseExecutionBlockers(
            execution.success.blockers,
            shellThreads,
            caller,
            execution.success.previews,
          ).filter((blocker) => {
            if (blocker.type === "thread-background" && automationPaused)
              return !shellThreads.some(
                (thread) =>
                  thread.id === blocker.threadId &&
                  (thread.pendingBackgroundTasks?.length ?? 0) > 0 &&
                  !activity.activeBackgroundWork(thread),
              );
            return (
              blocker.type !== "thread-turn" ||
              blocker.status !== "starting" ||
              !shellThreads.some(
                (thread) =>
                  thread.id === blocker.threadId && deferredActivity(thread, deferredRuns),
              )
            );
          })
        : [];
    if (pending._tag === "Success")
      for (const { threadId } of pending.success) {
        if (
          !blockers.some(
            (blocker) => blocker.type === "thread-turn" && blocker.threadId === threadId,
          )
        )
          blockers.push({ type: "thread-turn", threadId, turnId: null, status: "starting" });
      }
    const activeIds = new Set<ThreadId>(
      shellThreads.filter((thread) => activity.activeThread(thread)).map((thread) => thread.id),
    );
    for (const blocker of blockers) if ("threadId" in blocker) activeIds.add(blocker.threadId);
    const quiet =
      known &&
      blockers.length === 0 &&
      activeIds.size === 0 &&
      session !== null &&
      session.targets.every(
        (target) => !target.rePause && (target.pause === "sent" || target.pause === "unavailable"),
      ) &&
      session.phase !== "resuming";
    return {
      session:
        session === null
          ? null
          : {
              ...session,
              phase: quiet ? "paused" : session.phase,
              targets: session.targets.map(
                ({
                  pauseAttempt: _pauseAttempt,
                  resumeAttempt: _resumeAttempt,
                  pauseAccepted: _pauseAccepted,
                  resumeAccepted: _resumeAccepted,
                  resumeRequired: _resumeRequired,
                  pauseCancelled: _pauseCancelled,
                  rePause: _rePause,
                  ...target
                }) => target,
              ),
            },
      activeThreadCount: activeIds.size,
      blockers,
      quiet,
      observation: known ? "known" : "unknown",
    };
  });

  const deliver = Effect.fn("EnvironmentPause.deliver")(function* (direction: "pause" | "resume") {
    const snapshot = yield* store.get;
    if (snapshot === null) return;
    yield* Effect.forEach(
      snapshot.targets,
      (target) =>
        Effect.gen(function* () {
          if (direction === "resume" && !needsResume(target)) return;
          const current = yield* store.get;
          if (
            current?.id !== snapshot.id ||
            (direction === "pause" ? current.phase === "resuming" : current.phase !== "resuming")
          )
            return;
          if (
            target[direction] === "sent" ||
            target[direction] === "unavailable" ||
            target[`${direction}Accepted`]
          )
            return;
          const identity = Store.deliveryIdentity(snapshot, target, direction);
          let submission = yield* readSubmission(snapshot, target, direction);
          let inactive = false;
          if (submission === "unsubmitted") {
            const result = yield* threads
              .sendToThread({
                projectId: target.projectId,
                threadId: target.threadId,
                ...identity,
                text: direction === "pause" ? "pause to go offline" : "resume",
                attachments: [],
                mode: "auto",
                ...(direction === "pause" && target.rePause !== "required"
                  ? { pauseOnlyIfActive: true as const }
                  : {}),
                createdBy: "user",
                creationSource: "server",
              })
              .pipe(Effect.result);
            submission =
              result._tag === "Success"
                ? "accepted"
                : yield* readSubmission(snapshot, target, direction);
            inactive =
              direction === "pause" &&
              result._tag === "Failure" &&
              result.failure._tag === "OrchestratorPauseRecipientInactiveError" &&
              submission === "unsubmitted";
          }
          yield* store.update((current) =>
            current?.id !== snapshot.id || (direction === "pause" && current.phase === "resuming")
              ? current
              : {
                  ...current,
                  targets: current.targets.map((latest) =>
                    latest.threadId !== target.threadId ||
                    latest[direction] === "sent" ||
                    latest[direction] === "unavailable" ||
                    (latest[direction] === "failed" && latest[`${direction}Accepted`]) ||
                    latest[`${direction}Attempt`] !== target[`${direction}Attempt`]
                      ? latest
                      : {
                          ...latest,
                          [`${direction}Accepted`]: submission === "accepted",
                          [direction]: inactive
                            ? ("unavailable" as const)
                            : submission === "unsubmitted"
                              ? ("failed" as const)
                              : ("pending" as const),
                          error: inactive
                            ? "This thread finished before Pause was submitted."
                            : submission === "accepted"
                              ? latest.error
                              : submission === "unknown"
                                ? "The message submission could not be confirmed. Waiting for recovery."
                                : "This thread could not accept the message. Retry after resolving its current state.",
                        },
                  ),
                },
          );
        }),
      { concurrency: 4, discard: true },
    );
  });
  const collectNewTargets = Effect.gen(function* () {
    const { threads: activeTargets, deferred } = yield* readTargets;
    const snapshot = yield* store.get;
    const activeById = new Map(activeTargets.map((thread) => [thread.id, thread]));
    const laterRuns = new Map<ThreadId, number>();
    if (snapshot !== null && snapshot.phase !== "resuming") {
      for (const target of snapshot.targets) {
        if (target.pause !== "sent" || target.rePause) continue;
        const thread = activeById.get(target.threadId);
        if (thread === undefined) continue;
        const activeRunId =
          thread.activeRunId ??
          (["preparing", "queued", "starting", "running", "waiting"].includes(
            thread.activityRunStatus ?? thread.status,
          )
            ? thread.latestRunId
            : null);
        if (
          activeRunId === null ||
          deferred.some((run) => run.threadId === thread.id && run.runId === activeRunId)
        )
          continue;
        const identity = Store.deliveryIdentity(snapshot, target, "pause");
        const receipt = yield* projections
          .getThreadRecords(thread.id, ["messages"], {
            messageIds: [identity.messageId],
          })
          .pipe(Effect.result);
        if (receipt._tag === "Failure") continue;
        const pauseRunId = receipt.success.messages.find(
          (message) => message.id === identity.messageId,
        )?.runId;
        if (pauseRunId == null || pauseRunId === activeRunId) continue;
        const records = yield* projections
          .getThreadRecords(thread.id, ["runs"], {
            runIds: [pauseRunId, activeRunId],
          })
          .pipe(Effect.result);
        if (records._tag === "Failure") continue;
        const pauseRun = records.success.runs.find((run) => run.id === pauseRunId);
        const activeRun = records.success.runs.find((run) => run.id === activeRunId);
        if (pauseRun === undefined || activeRun === undefined) continue;
        // A held run can be admitted before the Pause control but promoted only
        // after it finishes. Active ownership and execution time prove that order.
        const promotedAfterPause =
          thread.activeRunId === activeRun.id &&
          ["starting", "running"].includes(activeRun.status) &&
          ["completed", "failed", "interrupted", "cancelled"].includes(pauseRun.status) &&
          pauseRun.completedAt !== null &&
          (activeRun.startedAt === null
            ? activeRun.status === "starting"
            : DateTime.toEpochMillis(activeRun.startedAt) >=
              DateTime.toEpochMillis(pauseRun.completedAt));
        // Checkpoint/background activity for the same run does not need another
        // message. A later active run must be proved by durable conversation rows.
        if (
          (activeRun.ordinal > pauseRun.ordinal || promotedAfterPause) &&
          ["queued", "starting", "running"].includes(activeRun.status)
        )
          laterRuns.set(target.threadId, target.pauseAttempt);
      }
    }
    yield* store.update((session) => {
      if (session === null || session.phase === "resuming") return session;
      const existing = new Set(session.targets.map((target) => target.threadId));
      const restored = session.targets.map((target) => {
        const thread = activeById.get(target.threadId);
        const reenroll =
          (target.pause === "unavailable" && !target.pauseCancelled) ||
          (target.pause === "sent" && laterRuns.get(target.threadId) === target.pauseAttempt);
        return !reenroll || thread === undefined
          ? target
          : {
              ...target,
              projectId: thread.projectId,
              title: thread.title,
              pause: "pending" as const,
              pauseAttempt: target.pauseAttempt + 1,
              pauseAccepted: false,
              ...(target.pause === "sent" ? { resumeRequired: true as const } : {}),
              error: null,
            };
      });
      const targets = activeTargets
        .filter((thread) => !existing.has(thread.id))
        .map((thread) => ({
          threadId: thread.id,
          projectId: thread.projectId,
          title: thread.title,
          pause: "pending" as const,
          resume: "pending" as const,
          pauseAttempt: 0,
          resumeAttempt: 0,
          pauseAccepted: false,
          resumeAccepted: false,
          error: null,
        }));
      return targets.length === 0 &&
        restored.every((target, index) => target === session.targets[index])
        ? session
        : { ...session, targets: [...restored, ...targets] };
    });
  });
  const retryDirection = Effect.fn("EnvironmentPause.retryDirection")(function* (
    direction: "pause" | "resume",
  ) {
    // This serialized operation has not started fanout yet. Retire definitive
    // cancellations discovered by status before Retry gives them a new attempt.
    if (direction === "pause") yield* recovery.withPermits(1)(retireUnavailablePauseRecipients);
    const retryable = direction === "resume" ? yield* reconcileResumeRecipients : null;
    yield* store.update((session) =>
      session === null
        ? session
        : {
            ...session,
            targets: session.targets.map((target) =>
              target[direction] !== "failed" ||
              (retryable !== null && !retryable.has(target.threadId))
                ? target
                : {
                    ...target,
                    [direction]: "pending" as const,
                    [`${direction}Attempt`]: target[`${direction}Attempt`] + 1,
                    [`${direction}Accepted`]: false,
                    error: null,
                  },
            ),
          },
    );
    yield* deliver(direction);
  });

  const cancelPending = Effect.fn("EnvironmentPause.cancelPending")(function* (
    direction: "pause" | "resume",
  ) {
    const session = yield* store.get;
    if (
      session === null ||
      (direction === "pause" ? session.phase !== "resuming" : session.phase === "resuming")
    )
      return;
    for (const target of session.targets) {
      if (
        target[direction] !== "pending" ||
        (direction === "resume" && target.rePause !== "waiting")
      )
        continue;
      const identity = Store.deliveryIdentity(session, target, direction);
      if (
        !target[`${direction}Accepted`] &&
        (yield* readSubmission(session, target, direction)) === "unsubmitted"
      ) {
        yield* store.recordDelivery(identity.messageId, "cancelled");
        continue;
      }
      const record = yield* projections
        .getThreadRecords(target.threadId, ["messages", "runs", "providerTurns"], {
          messageIds: [identity.messageId],
        })
        .pipe(Effect.result);
      if (record._tag === "Failure") continue;
      const message = record.success.messages.find((message) => message.id === identity.messageId);
      const run = record.success.runs.find(
        (run) => run.id === message?.runId && run.userMessageId === identity.messageId,
      );
      if (run?.status !== "queued" && run?.status !== "cancelled") continue;
      if (
        run.status === "cancelled" &&
        (run.startedAt !== null ||
          record.success.providerTurns.some(
            (turn) =>
              turn.nativeTurnRef !== null &&
              ((run.rootNodeId !== null && turn.nodeId === run.rootNodeId) ||
                (run.activeAttemptId !== null && turn.runAttemptId === run.activeAttemptId)),
          ))
      )
        continue;
      if (run.status === "queued") {
        const cancelled = yield* threads
          .dispatch({
            type: "queued-run.cancel",
            commandId: CommandId.make(`${identity.commandId}:cancel`),
            threadId: target.threadId,
            runId: run.id,
          })
          .pipe(Effect.result);
        if (cancelled._tag === "Failure") continue;
      }
      yield* store.recordDelivery(identity.messageId, "cancelled");
    }
  });
  const cancelPendingPauses = cancelPending("pause");
  const prepareRePause = Effect.gen(function* () {
    yield* cancelPending("resume");
    yield* store.update((session) =>
      session === null || session.phase === "resuming"
        ? session
        : {
            ...session,
            targets: session.targets.map((target) =>
              target.rePause !== "waiting" ||
              target.pause === "pending" ||
              target.resume === "pending"
                ? target
                : {
                    ...target,
                    pause: "pending" as const,
                    pauseAttempt: target.pauseAttempt + 1,
                    pauseAccepted: false,
                    pauseCancelled: undefined,
                    rePause: target.resume === "sent" ? ("required" as const) : undefined,
                    resumeRequired:
                      target.resume !== "sent" && (target.pause === "sent" || target.resumeRequired)
                        ? (true as const)
                        : undefined,
                    resume: "pending" as const,
                    resumeAttempt: target.resumeAttempt + 1,
                    resumeAccepted: false,
                    error: null,
                  },
            ),
          },
    );
  });
  const continueResume = reconcileUnaccepted.pipe(
    Effect.andThen(
      withResumeOperation(
        Effect.gen(function* () {
          if ((yield* store.get) === null) return;
          yield* status;
          const session = yield* store.get;
          if (session === null) return;
          if (session.phase === "resuming") {
            yield* cancelPendingPauses;
            yield* deliver("resume");
          } else {
            yield* prepareRePause;
            yield* deliver("pause");
          }
          yield* status;
        }),
      ),
    ),
  );

  return EnvironmentPause.of({
    status,
    start: Effect.suspend(() => {
      const requestedAtRevision = resumeRevision;
      return withOperation(
        Effect.gen(function* () {
          if (requestedAtRevision !== resumeRevision) return yield* status;
          const existing = yield* store.get;
          if (existing !== null && !(existing.phase === "resuming" && resumeComplete(existing))) {
            yield* store.update((current) =>
              current === null || requestedAtRevision !== resumeRevision
                ? current
                : {
                    ...current,
                    phase: "pausing",
                    targets:
                      current.phase !== "resuming"
                        ? current.targets
                        : current.targets.map((target) => ({
                            ...target,
                            ...(target.pause !== "pending" ? { rePause: "waiting" as const } : {}),
                          })),
                  },
            );
            yield* prepareRePause;
            yield* collectNewTargets;
            yield* deliver("pause");
            return yield* status;
          }
          const enabled = yield* settings.getSettings.pipe(
            Effect.mapError(
              (cause) =>
                new EnvironmentPauseError({ operation: "start", reason: "unavailable", cause }),
            ),
          );
          if (!enabled.environmentPauseEnabled)
            return yield* new EnvironmentPauseError({ operation: "start", reason: "disabled" });
          const now = yield* DateTime.now;
          const session: Store.StoredSession = {
            id: yield* random
              .uuidV4()
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new EnvironmentPauseError({ operation: "start", reason: "unavailable", cause }),
                ),
              ),
            createdAt: DateTime.formatIso(now),
            phase: "pausing",
            targets: [],
          };
          // Close automatic admission before observing which threads need a message.
          const admitted = yield* store.update((current) =>
            requestedAtRevision === resumeRevision ? session : current,
          );
          if (admitted?.id !== session.id) return yield* status;
          yield* collectNewTargets;
          yield* deliver("pause");
          return yield* status;
        }),
      );
    }),
    retry: withOperation(
      Effect.gen(function* () {
        yield* status;
        const session = yield* store.get;
        if (session === null)
          return yield* new EnvironmentPauseError({ operation: "retry", reason: "no_session" });
        if (session.phase !== "resuming") yield* collectNewTargets;
        yield* retryDirection(session.phase === "resuming" ? "resume" : "pause");
        return yield* status;
      }),
    ),
    continueResume,
    resume: withResumeOperation(
      Effect.gen(function* () {
        resumeRevision++;
        const session = yield* store.get;
        if (session === null) return yield* status;
        yield* store.update((current) =>
          current === null
            ? current
            : {
                ...current,
                phase: "resuming",
                targets: current.targets.map((target) => ({
                  ...target,
                  rePause: undefined,
                  // A cancelled older Resume cannot satisfy a newly received Pause.
                  ...(target.resume === "unavailable" && target.resumeRequired
                    ? { resume: "pending" as const, resumeAccepted: false }
                    : {}),
                })),
              },
        );
        yield* cancelPendingPauses;
        yield* retryDirection("resume");
        return yield* status;
      }),
    ),
  });
});

export const layer = Layer.effect(EnvironmentPause, make);
