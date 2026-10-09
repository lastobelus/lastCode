import {
  EnvironmentPauseError,
  type EnvironmentPauseStatus,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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

const activeThread = (thread: OrchestrationV2ThreadShell) =>
  thread.deletedAt == null &&
  (["preparing", "queued", "starting", "running", "waiting"].includes(
    thread.activityRunStatus ?? thread.status,
  ) ||
    thread.activeRunId !== null ||
    thread.pendingRuntimeRequest !== null ||
    (thread.pendingBackgroundTasks?.length ?? 0) > 0 ||
    thread.actionResume?.outcome === "running");

const make = Effect.gen(function* () {
  const store = yield* Store.EnvironmentPauseStore;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  const executionContext = yield* Effect.context<
    | ProjectionStore.ProjectionStoreV2
    | ProviderSessions.ProviderSessionManagerV2
    | TerminalManager
    | EffectOutbox.EffectOutboxV2
  >();
  const operations = yield* Semaphore.make(1);
  const readShell = projections
    .getShellSnapshot()
    .pipe(
      Effect.mapError(
        (cause) => new EnvironmentPauseError({ operation: "status", reason: "unavailable", cause }),
      ),
    );
  const readBlockers = currentExecutionBlockers().pipe(Effect.provide(executionContext));
  const readTargets = Effect.gen(function* () {
    const shell = yield* readShell;
    const pending = yield* outbox.pendingExecution.pipe(
      Effect.mapError(
        (cause) => new EnvironmentPauseError({ operation: "status", reason: "unavailable", cause }),
      ),
    );
    const pendingIds = new Set(pending.map(({ threadId }) => threadId));
    return [...shell.threads, ...shell.archivedThreads].filter(
      (thread) => thread.deletedAt == null && (activeThread(thread) || pendingIds.has(thread.id)),
    );
  });

  const status = Effect.gen(function* (): Effect.fn.Return<
    EnvironmentPauseStatus,
    EnvironmentPauseError
  > {
    let session = yield* store.get;
    if (
      session?.phase === "resuming" &&
      session.targets.every((target) => target.pause !== "sent" || target.resume === "sent")
    ) {
      yield* store.update((current) => (current?.id === session?.id ? null : current));
      session = yield* store.get;
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
    let deliveryUnknown = false;
    if (session !== null) {
      for (const target of session.targets) {
        const direction = session.phase === "resuming" ? "resume" : "pause";
        if (target[direction] !== "pending" || !target[`${direction}Accepted`]) continue;
        const identity = Store.deliveryIdentity(session, target, direction);
        const effects = yield* outbox
          .listByCommandId(identity.commandId)
          .pipe(
            Effect.mapError(
              (cause) =>
                new EnvironmentPauseError({ operation: "status", reason: "unavailable", cause }),
            ),
          );
        const deliveries = effects.filter(
          (effect) =>
            effect.request.type === "provider-turn.start" ||
            effect.request.type === "provider-turn.steer",
        );
        if (
          deliveries.some((effect) => effect.status === "cancelled" || effect.status === "failed")
        ) {
          yield* store.recordDelivery(identity.messageId, false);
        } else if (deliveries.every((effect) => effect.status === "succeeded")) {
          // A crash between native acceptance and its receipt cannot prove non-delivery.
          // Keep the target; never re-send it or declare it safely paused by inference.
          deliveryUnknown = true;
        }
      }
      session = yield* store.get;
    }
    const execution = yield* readBlockers.pipe(Effect.result);
    const pending = yield* outbox.pendingExecution.pipe(Effect.result);
    const shell = yield* readShell.pipe(Effect.result);
    const known =
      execution._tag === "Success" &&
      shell._tag === "Success" &&
      pending._tag === "Success" &&
      !deliveryUnknown;
    const blockers = execution._tag === "Success" ? [...execution.success] : [];
    if (pending._tag === "Success")
      for (const { threadId } of pending.success) {
        if (
          !blockers.some(
            (blocker) => blocker.type === "thread-turn" && blocker.threadId === threadId,
          )
        )
          blockers.push({ type: "thread-turn", threadId, turnId: null, status: "starting" });
      }
    const shellThreads =
      shell._tag === "Success" ? [...shell.success.threads, ...shell.success.archivedThreads] : [];
    const activeIds = new Set<ThreadId>(
      shellThreads.filter(activeThread).map((thread) => thread.id),
    );
    for (const blocker of blockers) if ("threadId" in blocker) activeIds.add(blocker.threadId);
    const quiet =
      known &&
      blockers.length === 0 &&
      activeIds.size === 0 &&
      session !== null &&
      session.targets.every((target) => target.pause === "sent") &&
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
          if (target[direction] === "sent" || target[`${direction}Accepted`]) return;
          const identity = Store.deliveryIdentity(snapshot, target, direction);
          // The command could have committed before the pause file was updated.
          const existing = yield* threads
            .getProjectThreadRecords(target, ["messages"], { messageIds: [identity.messageId] })
            .pipe(Effect.result);
          const accepted =
            existing._tag === "Success" &&
            existing.success.messages.some((message) => message.id === identity.messageId);
          const result = accepted
            ? { _tag: "Success" as const }
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
    const activeTargets = yield* readTargets;
    yield* store.update((session) => {
      if (session === null || session.phase === "resuming") return session;
      const existing = new Set(session.targets.map((target) => target.threadId));
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
      return targets.length === 0
        ? session
        : { ...session, targets: [...session.targets, ...targets] };
    });
  });
  const retryDirection = Effect.fn("EnvironmentPause.retryDirection")(function* (
    direction: "pause" | "resume",
  ) {
    yield* store.update((session) =>
      session === null
        ? session
        : {
            ...session,
            targets: session.targets.map((target) =>
              target[direction] !== "failed"
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
    start: operations.withPermits(1)(
      Effect.gen(function* () {
        const existing = yield* store.get;
        if (existing !== null) {
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
        const activeTargets = yield* readTargets;
        const now = yield* DateTime.now;
        const session: Store.StoredSession = {
          id: crypto.randomUUID(),
          createdAt: DateTime.formatIso(now),
          phase: "pausing",
          targets: activeTargets.map((thread) => ({
            threadId: thread.id,
            projectId: thread.projectId,
            title: thread.title,
            pause: "pending",
            resume: "pending",
            pauseAttempt: 0,
            resumeAttempt: 0,
            pauseAccepted: false,
            resumeAccepted: false,
            error: null,
          })),
        };
        yield* store.update(() => session);
        yield* deliver("pause");
        return yield* status;
      }),
    ),
    retry: operations.withPermits(1)(
      Effect.gen(function* () {
        const session = yield* store.get;
        if (session === null)
          return yield* new EnvironmentPauseError({ operation: "retry", reason: "no_session" });
        if (session.phase !== "resuming") yield* collectNewTargets;
        yield* retryDirection(session.phase === "resuming" ? "resume" : "pause");
        return yield* status;
      }),
    ),
    resume: operations.withPermits(1)(
      Effect.gen(function* () {
        const session = yield* store.get;
        if (session === null)
          return yield* new EnvironmentPauseError({ operation: "resume", reason: "no_session" });
        if (session.targets.some((target) => target.pause === "pending"))
          return yield* new EnvironmentPauseError({ operation: "resume", reason: "unavailable" });
        yield* store.update((current) =>
          current === null ? current : { ...current, phase: "resuming" },
        );
        yield* retryDirection("resume");
        const resumed = yield* store.get;
        if (
          resumed !== null &&
          resumed.targets.every((target) => target.pause !== "sent" || target.resume === "sent")
        )
          yield* store.update(() => null);
        return yield* status;
      }),
    ),
  });
});

export const layer = Layer.effect(EnvironmentPause, make);
