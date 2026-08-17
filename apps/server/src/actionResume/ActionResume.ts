/**
 * One-shot Project Action continuation service.
 *
 * Actions run in ordinary dedicated terminal sessions. Lifecycle state is
 * persisted as ordinary thread activities, while an in-memory registry makes
 * the latest state cheap to project into thread shells. A completed Action
 * dispatches one server-originated system turn using a deterministic command
 * id, so retries cannot create duplicate follow-ups.
 */
import {
  ActionResumeState,
  ActionResumeError,
  CommandId,
  EventId,
  MessageId,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProjectScript,
  type ThreadId,
} from "@t3tools/contracts";
import { projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { ProjectionThreadActivityRepository } from "../persistence/Services/ProjectionThreadActivities.ts";
import { forkParked } from "../serverActivation.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ThreadActionResumeService } from "../orchestration/ThreadActionResume.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";

export const ACTION_RESUME_ACTIVITY_KIND = "action.resume.lifecycle";

export interface ListedProjectAction {
  readonly id: string;
  readonly name: string;
  readonly resumeEligible: boolean;
  readonly disabledReason: string | null;
}

export interface ActionResumeInvocation {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
}

interface FinishActionInput {
  readonly threadId: ThreadId;
  readonly outcome: Exclude<ActionResumeState["outcome"], "running">;
  readonly exitCode?: number | null;
  readonly exitSignal?: number | null;
}

export class ActionResume extends Context.Service<
  ActionResume,
  {
    readonly listProjectActions: (
      invocation: ActionResumeInvocation,
    ) => Effect.Effect<ReadonlyArray<ListedProjectAction>, ActionResumeError>;
    readonly runProjectActionAndResume: (
      invocation: ActionResumeInvocation,
      actionId: string,
    ) => Effect.Effect<ActionResumeState, ActionResumeError>;
    readonly cancelByUser: (threadId: ThreadId) => Effect.Effect<void>;
    readonly cancelByArchive: (threadId: ThreadId) => Effect.Effect<void>;
    readonly resumeInterrupted: (threadId: ThreadId) => Effect.Effect<void, ActionResumeError>;
    readonly countRunning: Effect.Effect<number>;
  }
>()("t3/actionResume/ActionResume") {}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const outcomeSummary = (state: ActionResumeState): string => {
  switch (state.outcome) {
    case "running":
      return `Waiting for Action: ${state.actionName}`;
    case "succeeded":
      return `Action completed: ${state.actionName}`;
    case "failed":
      return `Action failed: ${state.actionName}`;
    case "cancelled_by_user":
      return `Action cancelled: ${state.actionName}`;
    case "cancelled_by_archive":
      return `Action cancelled when thread was archived: ${state.actionName}`;
    case "cancelled_by_shutdown":
      return `Action cancelled when LastCode quit: ${state.actionName}`;
    case "process_lost":
      return `Action interrupted when LastCode stopped: ${state.actionName}`;
  }
};

const outcomeTone = (state: ActionResumeState): "info" | "error" =>
  state.outcome === "failed" || state.outcome === "process_lost" ? "error" : "info";

const followUpText = (state: ActionResumeState): string => {
  const status =
    state.outcome === "succeeded"
      ? "succeeded"
      : state.outcome === "failed"
        ? `failed${state.exitCode === null ? "" : ` with exit code ${state.exitCode}`}`
        : state.outcome === "cancelled_by_user"
          ? "was cancelled by the user"
          : state.outcome === "process_lost"
            ? "was interrupted because LastCode stopped"
            : state.outcome;
  return [
    "Automated Project Action follow-up.",
    `Action: ${state.actionName} (${state.actionId})`,
    `Validated status: ${status}.`,
    `Output artifact: combined terminal transcript in ${state.terminalId}.`,
    "Continue the originating task using this result. Inspect the terminal artifact only if its output is needed; no raw output is included in this message.",
  ].join("\n");
};

const mapActionResumeError =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, ActionResumeError, R> =>
    effect.pipe(
      Effect.mapError((error) => {
        if (
          typeof error === "object" &&
          error !== null &&
          "_tag" in error &&
          error._tag === "ActionResumeError"
        ) {
          return error as unknown as ActionResumeError;
        }
        return new ActionResumeError({
          reason: "internal_error",
          message: `Could not ${operation}.`,
        });
      }),
    );

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const activities = yield* ProjectionThreadActivityRepository;
  const registry = yield* ThreadActionResumeService;
  const terminals = yield* TerminalManager.TerminalManager;
  const providers = yield* ProviderRegistry;
  const mutex = yield* Semaphore.make(1);
  const decodeState = Schema.decodeUnknownEffect(ActionResumeState);

  const providerIsCodex = Effect.fn("ActionResume.providerIsCodex")(function* (
    providerInstanceId: ProviderInstanceId,
  ) {
    const provider = (yield* providers.getProviders).find(
      (entry) => entry.instanceId === providerInstanceId,
    );
    return provider?.driver === ProviderDriverKind.make("codex");
  });

  const persistState = Effect.fn("ActionResume.persistState")(function* (state: ActionResumeState) {
    const previous = registry.getLatest(state.threadId);
    registry.record(state);
    const activityId = EventId.make(
      `action-resume:${state.runId}:${state.outcome}:${state.delivery}`,
    );
    const commandId = CommandId.make(
      `server:action-resume:${state.runId}:${state.outcome}:${state.delivery}`,
    );
    yield* engine
      .dispatch({
        type: "thread.activity.append",
        commandId,
        threadId: state.threadId,
        activity: {
          id: activityId,
          tone: outcomeTone(state),
          kind: ACTION_RESUME_ACTIVITY_KIND,
          summary: outcomeSummary(state),
          payload: state,
          turnId: null,
          createdAt: state.finishedAt ?? state.startedAt,
        },
        createdAt: state.finishedAt ?? state.startedAt,
      })
      .pipe(
        Effect.catchCause((cause) => {
          if (previous === null) registry.clear(state.threadId);
          else registry.record(previous);
          return Effect.failCause(cause);
        }),
      );
  });

  const threadEligibleForFollowUp = Effect.fn("ActionResume.threadEligibleForFollowUp")(function* (
    threadId: ThreadId,
  ) {
    const thread = yield* snapshots.getThreadShellById(threadId);
    if (Option.isNone(thread) || thread.value.archivedAt !== null) return false;
    const latestTurn = thread.value.latestTurn;
    const turnIdle = latestTurn === null || latestTurn.state !== "running";
    const sessionIdle =
      thread.value.session === null ||
      (thread.value.session.status !== "starting" && thread.value.session.status !== "running");
    return (
      turnIdle &&
      sessionIdle &&
      !thread.value.hasPendingApprovals &&
      !thread.value.hasPendingUserInput
    );
  });

  const deliverPendingUnlocked = Effect.fn("ActionResume.deliverPendingUnlocked")(function* (
    threadId: ThreadId,
  ) {
    const state = registry.getLatest(threadId);
    if (state === null || state.delivery !== "pending") return;
    if (!(yield* threadEligibleForFollowUp(threadId))) return;

    const commandId = CommandId.make(`server:action-resume:${state.runId}:delivery`);
    const messageId = MessageId.make(`action-resume:${state.runId}:follow-up`);
    yield* engine.dispatch({
      type: "thread.turn.start",
      commandId,
      threadId,
      message: {
        messageId,
        role: "system",
        text: followUpText(state),
        attachments: [],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: state.finishedAt ?? (yield* nowIso),
    });
    yield* persistState({ ...state, delivery: "delivered" });
  });

  const deliverPending = (threadId: ThreadId) =>
    mutex
      .withPermits(1)(deliverPendingUnlocked(threadId))
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Action follow-up delivery failed; it remains pending", {
            threadId,
            cause: Cause.pretty(cause),
          }),
        ),
      );

  const finishUnlocked = Effect.fn("ActionResume.finishUnlocked")(function* (
    input: FinishActionInput,
  ) {
    const current = registry.getLatest(input.threadId);
    if (current === null || current.outcome !== "running") return;
    const finishedAt = yield* nowIso;
    const shouldDeliver =
      input.outcome === "succeeded" ||
      input.outcome === "failed" ||
      input.outcome === "cancelled_by_user";
    const next: ActionResumeState = {
      ...current,
      outcome: input.outcome,
      delivery: shouldDeliver
        ? "pending"
        : input.outcome === "process_lost"
          ? "available"
          : "disposed",
      finishedAt,
      exitCode: input.exitCode ?? null,
      exitSignal: input.exitSignal ?? null,
    };
    yield* persistState(next);
  });

  const finish = (input: FinishActionInput) =>
    mutex
      .withPermits(1)(finishUnlocked(input))
      .pipe(
        Effect.andThen(deliverPending(input.threadId)),
        Effect.catchCause((cause) =>
          Effect.logError("Failed to finalize Project Action", {
            threadId: input.threadId,
            outcome: input.outcome,
            cause: Cause.pretty(cause),
          }),
        ),
      );

  const cancel = (threadId: ThreadId, outcome: "cancelled_by_user" | "cancelled_by_archive") =>
    Effect.gen(function* () {
      const current = registry.getLatest(threadId);
      if (current === null || current.outcome !== "running") return;
      yield* finish({ threadId, outcome });
      yield* terminals
        .close({ threadId, terminalId: current.terminalId })
        .pipe(Effect.ignoreCause({ log: true }));
    });

  const resolveProjectContext = Effect.fn("ActionResume.resolveProjectContext")(function* (
    threadId: ThreadId,
  ) {
    const thread = yield* snapshots.getThreadShellById(threadId);
    if (Option.isNone(thread)) {
      return yield* new ActionResumeError({
        reason: "thread_not_found",
        message: "The originating thread no longer exists.",
      });
    }
    const project = yield* snapshots.getProjectShellById(thread.value.projectId);
    if (Option.isNone(project)) {
      return yield* new ActionResumeError({
        reason: "project_not_found",
        message: "The originating project no longer exists.",
      });
    }
    return { thread: thread.value, project: project.value };
  });

  const listProjectActionsImpl = Effect.fn("ActionResume.listProjectActions")(function* (
    invocation: ActionResumeInvocation,
  ) {
    const codex = yield* providerIsCodex(invocation.providerInstanceId);
    const { project } = yield* resolveProjectContext(invocation.threadId);
    const alreadyRunning = registry.getLatest(invocation.threadId)?.outcome === "running";
    return project.scripts.map((script) => {
      const disabledReason = !codex
        ? "Resume-capable Actions are available to Codex providers in this first slice."
        : script.allowAgentResume !== true
          ? "This Action has not been opted in for agent-triggered resume."
          : alreadyRunning
            ? "This thread is already waiting for a resume-capable Action."
            : null;
      return {
        id: script.id,
        name: script.name,
        resumeEligible: disabledReason === null,
        disabledReason,
      };
    });
  });

  const launchActionUnlocked = Effect.fn("ActionResume.launchActionUnlocked")(function* (
    invocation: ActionResumeInvocation,
    script: ProjectScript,
  ) {
    const existing = registry.getLatest(invocation.threadId);
    if (existing?.outcome === "running") {
      return yield* new ActionResumeError({
        reason: "action_already_running",
        message: `This thread is already waiting for ${existing.actionName}.`,
      });
    }
    const { thread, project } = yield* resolveProjectContext(invocation.threadId);
    const runId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    const terminalId = `action-${runId}`;
    const startedAt = yield* nowIso;
    const state: ActionResumeState = {
      runId,
      threadId: invocation.threadId,
      projectId: project.id,
      actionId: script.id,
      actionName: script.name,
      terminalId,
      outcome: "running",
      delivery: "armed",
      startedAt,
      finishedAt: null,
      exitCode: null,
      exitSignal: null,
    };
    yield* persistState(state);

    const cwd = thread.worktreePath ?? project.workspaceRoot;
    const env = projectScriptRuntimeEnv({
      project: { cwd: project.workspaceRoot },
      worktreePath: thread.worktreePath,
    });
    const launch = Effect.gen(function* () {
      yield* terminals.open({
        threadId: invocation.threadId,
        terminalId,
        cwd,
        worktreePath: thread.worktreePath,
        env,
        cols: 120,
        rows: 30,
      });
      yield* terminals.write({
        threadId: invocation.threadId,
        terminalId,
        data: `${script.command}\n__t3_action_status=$?\nexit $__t3_action_status\n`,
      });
    });
    const launched = yield* Effect.exit(launch);
    if (launched._tag === "Failure") {
      yield* finishUnlocked({ threadId: invocation.threadId, outcome: "failed" });
      return yield* new ActionResumeError({
        reason: "launch_failed",
        message: `Failed to launch Action "${script.name}".`,
      });
    }
    return state;
  });

  const runProjectActionAndResumeImpl = Effect.fn("ActionResume.runProjectActionAndResume")(
    function* (invocation: ActionResumeInvocation, actionId: string) {
      if (!(yield* providerIsCodex(invocation.providerInstanceId))) {
        return yield* new ActionResumeError({
          reason: "unsupported_provider",
          message: "Resume-capable Actions are available to Codex providers in this first slice.",
        });
      }
      const { project } = yield* resolveProjectContext(invocation.threadId);
      const script = project.scripts.find((entry) => entry.id === actionId);
      if (!script) {
        return yield* new ActionResumeError({
          reason: "action_not_found",
          message: `Project Action "${actionId}" was not found.`,
        });
      }
      if (script.allowAgentResume !== true) {
        return yield* new ActionResumeError({
          reason: "action_not_enabled",
          message: `Project Action "${script.name}" is not opted in for agent-triggered resume.`,
        });
      }
      return yield* mutex.withPermits(1)(launchActionUnlocked(invocation, script));
    },
  );

  const resumeInterruptedImpl = Effect.fn("ActionResume.resumeInterrupted")(function* (
    threadId: ThreadId,
  ) {
    yield* mutex.withPermits(1)(
      Effect.gen(function* () {
        const current = registry.getLatest(threadId);
        if (current === null || current.delivery !== "available") {
          return yield* new ActionResumeError({
            reason: "action_not_recoverable",
            message: "This thread has no interrupted Action follow-up to resume.",
          });
        }
        yield* persistState({ ...current, delivery: "pending" });
      }),
    );
    yield* deliverPending(threadId);
  });

  const unsubscribeTerminal = yield* terminals.subscribe((event) => {
    const state = registry.getLatest(event.threadId);
    if (state === null || state.outcome !== "running" || state.terminalId !== event.terminalId) {
      return Effect.void;
    }
    if (event.type === "exited") {
      return finish({
        threadId: state.threadId,
        outcome: event.exitCode === 0 ? "succeeded" : "failed",
        exitCode: event.exitCode,
        exitSignal: event.exitSignal,
      });
    }
    if (event.type === "closed") {
      return finish({ threadId: state.threadId, outcome: "cancelled_by_user" });
    }
    if (event.type === "error") {
      return finish({ threadId: state.threadId, outcome: "failed" });
    }
    return Effect.void;
  });
  yield* Effect.addFinalizer(() => Effect.sync(unsubscribeTerminal));

  const hydrateAndReconcile = Effect.fn("ActionResume.hydrateAndReconcile")(function* () {
    const rows = yield* activities.listByKind({ kind: ACTION_RESUME_ACTIVITY_KIND });
    for (const row of rows) {
      const decoded = yield* Effect.option(decodeState(row.payload));
      if (Option.isSome(decoded)) registry.record(decoded.value);
    }
    for (const state of registry.listLatest()) {
      if (state.outcome === "running") {
        const finishedAt = yield* nowIso;
        yield* persistState({
          ...state,
          outcome: "process_lost",
          delivery: "available",
          finishedAt,
        });
      } else if (state.delivery === "pending") {
        yield* persistState({ ...state, delivery: "available" });
      }
    }
  });

  yield* forkParked(
    hydrateAndReconcile().pipe(
      Effect.andThen(
        Stream.runForEach(engine.streamDomainEvents, (event) => {
          if (event.aggregateKind !== "thread") return Effect.void;
          const threadId = event.aggregateId as ThreadId;
          if (event.type === "thread.archived") return cancel(threadId, "cancelled_by_archive");
          if (event.type === "thread.deleted") {
            registry.clear(threadId);
            return Effect.void;
          }
          return deliverPending(threadId);
        }),
      ),
    ),
  );

  yield* Effect.addFinalizer(() =>
    Effect.forEach(
      registry.listLatest().filter((state) => state.outcome === "running"),
      (state) =>
        mutex.withPermits(1)(
          Effect.gen(function* () {
            const finishedAt = yield* nowIso;
            yield* persistState({
              ...state,
              outcome: "cancelled_by_shutdown",
              delivery: "disposed",
              finishedAt,
            });
            yield* terminals
              .close({ threadId: state.threadId, terminalId: state.terminalId })
              .pipe(Effect.ignoreCause({ log: true }));
          }),
        ),
      { concurrency: 1, discard: true },
    ).pipe(Effect.ignoreCause({ log: true })),
  );

  return ActionResume.of({
    listProjectActions: (invocation) =>
      listProjectActionsImpl(invocation).pipe(mapActionResumeError("list Project Actions")),
    runProjectActionAndResume: (invocation, actionId) =>
      runProjectActionAndResumeImpl(invocation, actionId).pipe(
        mapActionResumeError("run the Project Action"),
      ),
    cancelByUser: (threadId) => cancel(threadId, "cancelled_by_user"),
    cancelByArchive: (threadId) => cancel(threadId, "cancelled_by_archive"),
    resumeInterrupted: (threadId) =>
      resumeInterruptedImpl(threadId).pipe(mapActionResumeError("resume the interrupted Action")),
    countRunning: Effect.sync(() => registry.countRunning()),
  });
});

export const layer = Layer.effect(ActionResume, make);
