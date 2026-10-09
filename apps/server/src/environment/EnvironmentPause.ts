import {
  CommandId,
  EnvironmentPauseError,
  environmentPauseResumeComplete,
  isProviderNativeSubagentThread,
  type EnvironmentPauseStatus,
  type OrchestrationV2ThreadShell,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import { threadPullRequestKeyOf } from "@t3tools/shared/threadPullRequests";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessions from "../orchestration-v2/ProviderSessionManager.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import * as ServerSettings from "../serverSettings.ts";
import { currentExecutionBlockers } from "../updateDrain/UpdateDrainAdmission.ts";
import * as Store from "./EnvironmentPauseStore.ts";

export class EnvironmentPause extends Context.Service<
  EnvironmentPause,
  {
    readonly status: Effect.Effect<EnvironmentPauseStatus, EnvironmentPauseError>;
    readonly start: Effect.Effect<EnvironmentPauseStatus, EnvironmentPauseError>;
    readonly retry: Effect.Effect<EnvironmentPauseStatus, EnvironmentPauseError>;
    readonly resume: Effect.Effect<EnvironmentPauseStatus, EnvironmentPauseError>;
  }
>()("t3/environment/EnvironmentPause") {}

const deferredActivity = (
  thread: OrchestrationV2ThreadShell,
  deferred: ReadonlyArray<{ readonly threadId: ThreadId; readonly runId: RunId }>,
) =>
  ["queued", "starting"].includes(thread.activityRunStatus ?? thread.status) &&
  deferred.some(
    (run) => run.threadId === thread.id && run.runId === (thread.activeRunId ?? thread.latestRunId),
  );

const activeBackgroundWork = (thread: OrchestrationV2ThreadShell, automationPaused: boolean) =>
  (thread.pendingBackgroundTasks ?? []).some(
    (task) =>
      !(
        automationPaused &&
        task.kind === "monitor" &&
        (thread.pullRequests ?? []).some(
          (link) =>
            link.watch != null &&
            task.taskId === `pull-request-watch:${threadPullRequestKeyOf(link)}`,
        )
      ),
  );

const activeThread = (
  thread: OrchestrationV2ThreadShell,
  deferred: ReadonlyArray<{ readonly threadId: ThreadId; readonly runId: RunId }>,
  automationPaused: boolean,
) =>
  thread.deletedAt == null &&
  ((!deferredActivity(thread, deferred) &&
    (["preparing", "queued", "starting", "running", "waiting"].includes(
      thread.activityRunStatus ?? thread.status,
    ) ||
      thread.activeRunId !== null)) ||
    thread.pendingRuntimeRequest !== null ||
    activeBackgroundWork(thread, automationPaused) ||
    thread.actionResume?.outcome === "running");

const resumeComplete = environmentPauseResumeComplete;

const make = Effect.gen(function* () {
  const store = yield* Store.EnvironmentPauseStore;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  const crypto = yield* Crypto.Crypto;
  const executionContext = yield* Effect.context<
    | ProjectionStore.ProjectionStoreV2
    | ProviderSessions.ProviderSessionManagerV2
    | TerminalManager
    | EffectOutbox.EffectOutboxV2
  >();
  const operations = yield* Semaphore.make(1);
  const recovery = yield* Semaphore.make(1);
  const operationActive = yield* Ref.make(false);
  const readShell = projections
    .getShellSnapshot()
    .pipe(
      Effect.mapError(
        (cause) => new EnvironmentPauseError({ operation: "status", reason: "unavailable", cause }),
      ),
    );
  const readBlockers = currentExecutionBlockers().pipe(Effect.provide(executionContext));
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
    const pendingIds = new Set(pending.map(({ threadId }) => threadId));
    // Archived work still blocks quiet in status, but cannot accept messages.
    return {
      deferred,
      threads: shell.threads.filter(
        (thread) =>
          thread.archivedAt == null &&
          thread.deletedAt == null &&
          !isProviderNativeSubagentThread(thread) &&
          (activeThread(thread, deferred, automationPaused) || pendingIds.has(thread.id)),
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

  const reconcileResumeRecipients = Effect.gen(function* () {
    const session = yield* store.get;
    const retryable = new Set<ThreadId>();
    if (session?.phase !== "resuming") return retryable;
    for (const target of session.targets) {
      if (
        target.pause !== "sent" ||
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
    const direction = session.phase === "resuming" ? "resume" : "pause";
    let unknown = false;
    for (const target of session.targets) {
      if (target[direction] !== "pending" || target[`${direction}Accepted`]) continue;
      const identity = Store.deliveryIdentity(session, target, direction);
      const record = yield* projections
        .getThreadRecords(target.threadId, ["messages"], { messageIds: [identity.messageId] })
        .pipe(Effect.result);
      const effects = yield* outbox.listByCommandId(identity.commandId).pipe(Effect.result);
      if (
        effects._tag === "Failure" ||
        (record._tag === "Failure" && record.failure._tag !== "ProjectionStoreThreadNotFoundError")
      ) {
        unknown = true;
        continue;
      }
      const accepted =
        (record._tag === "Success" && record.success.messages.length > 0) ||
        effects.success.some(
          (effect) =>
            effect.request.type === "provider-turn.start" ||
            effect.request.type === "provider-turn.steer",
        );
      yield* store.update((current) =>
        current?.id !== session.id
          ? current
          : {
              ...current,
              targets: current.targets.map((latest) =>
                latest.threadId !== target.threadId ||
                latest[`${direction}Attempt`] !== target[`${direction}Attempt`] ||
                latest[direction] !== "pending" ||
                latest[`${direction}Accepted`]
                  ? latest
                  : {
                      ...latest,
                      [direction]: accepted ? ("pending" as const) : ("failed" as const),
                      [`${direction}Accepted`]: accepted,
                      error: accepted
                        ? null
                        : "The message was not submitted before the server stopped. Retry to send it.",
                    },
              ),
            },
      );
    }
    return (yield* reconcileUnavailablePauseRecipients) || unknown;
  });
  const reconcileUnaccepted = recovery.withPermits(1)(recoverUnaccepted);

  const withOperation = (effect: Effect.Effect<EnvironmentPauseStatus, EnvironmentPauseError>) =>
    operations.withPermits(1)(
      // Finish any observation of unsent rows before fanout owns them. The
      // recovery lock is released before dispatch so status remains live.
      recovery
        .withPermits(1)(recoverUnaccepted.pipe(Effect.andThen(Ref.set(operationActive, true))))
        .pipe(Effect.andThen(effect), Effect.ensuring(Ref.set(operationActive, false))),
    );

  const status = Effect.gen(function* (): Effect.fn.Return<
    EnvironmentPauseStatus,
    EnvironmentPauseError
  > {
    const recoveryUnknown = yield* reconcileUnaccepted;
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
        yield* store.update((current) => (current?.id === session?.id ? null : current));
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
        const direction = session.phase === "resuming" ? "resume" : "pause";
        if (target[direction] !== "pending" || !target[`${direction}Accepted`]) continue;
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
                  new EnvironmentPauseError({ operation: "status", reason: "unavailable", cause }),
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
            yield* store.recordDelivery(identity.messageId, false);
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
          yield* store.recordDelivery(identity.messageId, false);
        } else {
          // A crash between native acceptance and its receipt cannot prove non-delivery.
          // Keep the target; never re-send it or declare it safely paused by inference.
          deliveryUnknown = true;
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
    const blockers =
      execution._tag === "Success"
        ? execution.success.filter((blocker) => {
            if (blocker.type === "thread-background" && automationPaused)
              return !shellThreads.some(
                (thread) =>
                  thread.id === blocker.threadId &&
                  (thread.pendingBackgroundTasks?.length ?? 0) > 0 &&
                  !activeBackgroundWork(thread, true),
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
      shellThreads
        .filter((thread) => activeThread(thread, deferredRuns, automationPaused))
        .map((thread) => thread.id),
    );
    for (const blocker of blockers) if ("threadId" in blocker) activeIds.add(blocker.threadId);
    const quiet =
      known &&
      blockers.length === 0 &&
      activeIds.size === 0 &&
      session !== null &&
      session.targets.every(
        (target) => target.pause === "sent" || target.pause === "unavailable",
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
          if (direction === "resume" && target.pause !== "sent") return;
          if (
            target[direction] === "sent" ||
            target[direction] === "unavailable" ||
            target[`${direction}Accepted`]
          )
            return;
          const identity = Store.deliveryIdentity(snapshot, target, direction);
          // The command could have committed before the pause file was updated.
          const existing =
            direction === "resume"
              ? yield* readResumeRecipient(snapshot, target)
              : yield* threads
                  .getProjectThreadRecords(target, ["messages"], {
                    messageIds: [identity.messageId],
                  })
                  .pipe(Effect.result);
          const accepted =
            existing._tag === "Success" &&
            existing.success.messages.some((message) => message.id === identity.messageId);
          const result = accepted
            ? { _tag: "Success" as const }
            : direction === "resume" && existing._tag === "Failure"
              ? existing
              : yield* threads
                  .sendToThread({
                    projectId: target.projectId,
                    threadId: target.threadId,
                    ...identity,
                    text: direction === "pause" ? "pause to go offline" : "resume",
                    attachments: [],
                    mode: "cooperative",
                    createdBy: "user",
                    creationSource: "server",
                  })
                  .pipe(Effect.result);
          yield* store.update((current) =>
            current?.id !== snapshot.id
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
                          [`${direction}Accepted`]: result._tag === "Success",
                          [direction]:
                            result._tag === "Success" ? latest[direction] : ("failed" as const),
                          error:
                            result._tag === "Success"
                              ? latest.error
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
        if (target.pause !== "sent") continue;
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
          target.pause === "unavailable" ||
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

  return EnvironmentPause.of({
    status,
    start: withOperation(
      Effect.gen(function* () {
        const existing = yield* store.get;
        if (existing !== null && !(existing.phase === "resuming" && resumeComplete(existing))) {
          if (existing.phase === "resuming")
            return yield* new EnvironmentPauseError({
              operation: "start",
              reason: "resume_in_progress",
            });
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
          id: yield* crypto.randomUUIDv4.pipe(
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
        yield* store.update(() => session);
        yield* collectNewTargets;
        yield* deliver("pause");
        return yield* status;
      }),
    ),
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
    resume: withOperation(
      Effect.gen(function* () {
        const session = yield* store.get;
        if (session === null)
          return yield* new EnvironmentPauseError({ operation: "resume", reason: "no_session" });
        if (session.targets.some((target) => target.pause === "pending"))
          return yield* new EnvironmentPauseError({ operation: "resume", reason: "unavailable" });
        yield* store.update((current) =>
          current === null
            ? current
            : {
                ...current,
                phase: "resuming",
                // Settled re-Pause failures must not erase an earlier received Pause.
                targets: current.targets.map((target) =>
                  target.resumeRequired === true ? { ...target, pause: "sent" as const } : target,
                ),
              },
        );
        yield* retryDirection("resume");
        return yield* status;
      }),
    ),
  });
});

export const layer = Layer.effect(EnvironmentPause, make);
