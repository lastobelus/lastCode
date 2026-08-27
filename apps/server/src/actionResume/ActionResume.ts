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
import { formatActionResumeFollowUp } from "@t3tools/shared/actionResume";
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
import { UpdateDrainAdmission } from "../updateDrain/UpdateDrainAdmission.ts";

export const ACTION_RESUME_ACTIVITY_KIND = "action.resume.lifecycle";

const ACTION_RESUME_PROVIDER_DRIVERS = new Set([
  ProviderDriverKind.make("codex"),
  ProviderDriverKind.make("claudeAgent"),
]);

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
  readonly deliver?: boolean;
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
    readonly discardInterrupted: (threadId: ThreadId) => Effect.Effect<void, ActionResumeError>;
    readonly retryPendingFollowUps: Effect.Effect<void>;
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

const MAX_ACTION_OUTPUT_CHARS = 12_000;
const ACTION_OUTPUT_OSC = "777;T3ActionOutput";

type ActionOutputBoundary = "start" | "end";

interface ActionOutputCapture {
  readonly runId: string;
  phase: "before" | "capturing" | "after";
  pending: string;
  output: string;
}

export function actionOutputMarker(runId: string, boundary: ActionOutputBoundary): string {
  return `\u001b]${ACTION_OUTPUT_OSC};${runId};${boundary}\u0007`;
}

function createActionOutputCapture(runId: string): ActionOutputCapture {
  return { runId, phase: "before", pending: "", output: "" };
}

function appendBoundedActionOutput(capture: ActionOutputCapture, output: string): void {
  capture.output = `${capture.output}${output}`.slice(-MAX_ACTION_OUTPUT_CHARS);
}

function consumeActionTerminalOutput(capture: ActionOutputCapture, data: string): void {
  if (capture.phase === "after") return;
  capture.pending += data;

  if (capture.phase === "before") {
    const startMarker = actionOutputMarker(capture.runId, "start");
    const startIndex = capture.pending.indexOf(startMarker);
    if (startIndex === -1) {
      capture.pending = capture.pending.slice(-(startMarker.length - 1));
      return;
    }
    capture.pending = capture.pending.slice(startIndex + startMarker.length);
    capture.phase = "capturing";
  }

  const endMarker = actionOutputMarker(capture.runId, "end");
  const endIndex = capture.pending.indexOf(endMarker);
  if (endIndex !== -1) {
    appendBoundedActionOutput(capture, capture.pending.slice(0, endIndex));
    capture.pending = "";
    capture.phase = "after";
    return;
  }

  const safeLength = Math.max(0, capture.pending.length - (endMarker.length - 1));
  appendBoundedActionOutput(capture, capture.pending.slice(0, safeLength));
  capture.pending = capture.pending.slice(safeLength);
}

function finishActionOutputCapture(capture: ActionOutputCapture): string | undefined {
  if (capture.phase === "before") return undefined;
  if (capture.phase === "capturing") {
    appendBoundedActionOutput(capture, capture.pending);
    capture.pending = "";
    capture.phase = "after";
  }
  return capture.output;
}

function actionOutputFromTranscript(
  transcript: string,
  runId: string,
  recoverUnmarkedTail: boolean,
): string | undefined {
  const capture = createActionOutputCapture(runId);
  consumeActionTerminalOutput(capture, transcript);
  const captured = finishActionOutputCapture(capture);
  if (captured !== undefined) return captured;

  const endIndex = transcript.indexOf(actionOutputMarker(runId, "end"));
  if (endIndex === -1) {
    return recoverUnmarkedTail ? transcript.slice(-MAX_ACTION_OUTPUT_CHARS) : undefined;
  }

  // Action terminals are dedicated to one run. If persisted history was capped
  // after a very chatty command, the retained prefix is still Action output even
  // though the start marker has fallen out of history.
  return transcript.slice(0, endIndex).slice(-MAX_ACTION_OUTPUT_CHARS);
}

const followUpText = (state: ActionResumeState, outputTail: string | undefined): string => {
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
  return formatActionResumeFollowUp({
    actionName: state.actionName,
    actionId: state.actionId,
    validatedStatus: status,
    exitCode: state.exitCode,
    output: outputTail,
  });
};

export function actionCommandForShell(
  command: string,
  shellFamily: TerminalManager.TerminalShellFamily | undefined,
  runId: string,
): string {
  switch (shellFamily) {
    case "powershell":
      return `${command}\nif ($?) { exit 0 }\nif ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }\nexit 1\n`;
    case "cmd":
      return `${command}\nexit /b %errorlevel%\n`;
    default: {
      const quotedCommand = `'${command.replaceAll("'", `'"'"'`)}'`;
      const start = `printf '\\033]${ACTION_OUTPUT_OSC};${runId};start\\007'`;
      const end = `printf '\\033]${ACTION_OUTPUT_OSC};${runId};end\\007'`;
      return `${start}; eval ${quotedCommand}; __t3_action_status=$?; ${end}; exit $__t3_action_status\n`;
    }
  }
}

export function actionBlocksNewLaunch(state: ActionResumeState | null): boolean {
  return (
    state !== null &&
    (state.delivery === "armed" || state.delivery === "pending" || state.delivery === "available")
  );
}

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
  const admission = yield* UpdateDrainAdmission;
  const mutex = yield* Semaphore.make(1);
  const decodeState = Schema.decodeUnknownEffect(ActionResumeState);
  const outputCaptureByRunId = new Map<string, ActionOutputCapture>();

  const providerSupportsActionResume = Effect.fn("ActionResume.providerSupportsActionResume")(
    function* (providerInstanceId: ProviderInstanceId) {
      const provider = (yield* providers.getProviders).find(
        (entry) => entry.instanceId === providerInstanceId,
      );
      return provider !== undefined && ACTION_RESUME_PROVIDER_DRIVERS.has(provider.driver);
    },
  );

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

  const eligibleThreadForFollowUp = Effect.fn("ActionResume.eligibleThreadForFollowUp")(function* (
    threadId: ThreadId,
  ) {
    const thread = yield* snapshots.getThreadShellById(threadId);
    if (Option.isNone(thread) || thread.value.archivedAt !== null) return null;
    const latestTurn = thread.value.latestTurn;
    const turnIdle = latestTurn === null || latestTurn.state !== "running";
    const sessionIdle =
      thread.value.session === null ||
      (thread.value.session.status !== "starting" && thread.value.session.status !== "running");
    const eligible =
      turnIdle &&
      sessionIdle &&
      !thread.value.hasPendingApprovals &&
      !thread.value.hasPendingUserInput;
    return eligible ? thread.value : null;
  });

  const deliverPendingUnlocked = Effect.fn("ActionResume.deliverPendingUnlocked")(function* (
    threadId: ThreadId,
  ) {
    const state = registry.getLatest(threadId);
    if (state === null || state.delivery !== "pending") return;
    const thread = yield* eligibleThreadForFollowUp(threadId);
    if (thread === null) return;
    const outputTail =
      finishActionOutputCapture(
        outputCaptureByRunId.get(state.runId) ?? createActionOutputCapture(state.runId),
      ) ??
      (yield* terminals.history({ threadId: state.threadId, terminalId: state.terminalId }).pipe(
        Effect.map((history) =>
          actionOutputFromTranscript(history, state.runId, state.outcome === "process_lost"),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not recover the Action terminal transcript", {
            threadId: state.threadId,
            terminalId: state.terminalId,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(undefined)),
        ),
      ));

    const commandId = CommandId.make(`server:action-resume:${state.runId}:delivery`);
    const messageId = MessageId.make(`action-resume:${state.runId}:follow-up`);
    const deliveredAt = yield* nowIso;
    yield* engine.dispatch({
      type: "thread.turn.start",
      commandId,
      threadId,
      message: {
        messageId,
        role: "system",
        text: followUpText(state, outputTail),
        attachments: [],
      },
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      createdAt: deliveredAt,
    });
    yield* persistState({ ...state, delivery: "delivered" });
    outputCaptureByRunId.delete(state.runId);
  });

  const attemptDeliverPending = (threadId: ThreadId) =>
    mutex.withPermits(1)(deliverPendingUnlocked(threadId));

  const deliverPending = (threadId: ThreadId) =>
    admission.admit("thread-turn", attemptDeliverPending(threadId)).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Action follow-up delivery failed; it remains pending", {
          threadId,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  const retryPendingFollowUps = Effect.suspend(() =>
    Effect.forEach(
      registry.listLatest().filter((state) => state.delivery === "pending"),
      (state) => deliverPending(state.threadId),
      { concurrency: 1, discard: true },
    ),
  );

  const finishUnlocked = Effect.fn("ActionResume.finishUnlocked")(function* (
    input: FinishActionInput,
  ) {
    const current = registry.getLatest(input.threadId);
    if (current === null || current.outcome !== "running") return;
    const finishedAt = yield* nowIso;
    const shouldDeliver =
      input.deliver !== false &&
      (input.outcome === "succeeded" ||
        input.outcome === "failed" ||
        input.outcome === "cancelled_by_user");
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
    if (next.delivery === "disposed") outputCaptureByRunId.delete(next.runId);
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
      if (current === null) return;
      if (current.outcome === "running") {
        yield* finish({ threadId, outcome });
        yield* terminals
          .close({ threadId, terminalId: current.terminalId })
          .pipe(Effect.ignoreCause({ log: true }));
        return;
      }
      if (
        outcome === "cancelled_by_archive" &&
        (current.delivery === "pending" || current.delivery === "available")
      ) {
        yield* mutex.withPermits(1)(
          Effect.gen(function* () {
            const latest = registry.getLatest(threadId);
            if (
              latest !== null &&
              (latest.delivery === "pending" || latest.delivery === "available")
            ) {
              yield* persistState({ ...latest, delivery: "disposed" });
              outputCaptureByRunId.delete(latest.runId);
            }
          }),
        );
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("Failed to cancel or dispose Project Action state", {
          threadId,
          outcome,
          cause: Cause.pretty(cause),
        }),
      ),
    );

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
    const providerSupported = yield* providerSupportsActionResume(invocation.providerInstanceId);
    const { project } = yield* resolveProjectContext(invocation.threadId);
    const launchBlocked = actionBlocksNewLaunch(registry.getLatest(invocation.threadId));
    return project.scripts.map((script) => {
      const disabledReason = !providerSupported
        ? "Resume-capable Actions are currently available to Codex and Claude providers."
        : script.allowAgentResume !== true
          ? "This Action has not been opted in for agent-triggered resume."
          : launchBlocked
            ? "This thread must finish its current Action continuation first."
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
    if (actionBlocksNewLaunch(existing)) {
      return yield* new ActionResumeError({
        reason: "action_already_running",
        message: `This thread must finish the continuation for ${existing?.actionName ?? "the current Action"} first.`,
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
      command: script.command,
      terminalId,
      outcome: "running",
      delivery: "armed",
      startedAt,
      finishedAt: null,
      exitCode: null,
      exitSignal: null,
    };
    const cwd = thread.worktreePath ?? project.workspaceRoot;
    const env = projectScriptRuntimeEnv({
      project: { cwd: project.workspaceRoot },
      worktreePath: thread.worktreePath,
    });
    const launch = Effect.gen(function* () {
      const terminal = yield* terminals.open({
        threadId: invocation.threadId,
        terminalId,
        cwd,
        worktreePath: thread.worktreePath,
        env,
        cols: 120,
        rows: 30,
      });
      if (terminal.status !== "running") {
        return yield* Effect.die("Action terminal exited during launch.");
      }
      yield* persistState(state);
      outputCaptureByRunId.set(runId, createActionOutputCapture(runId));
      yield* terminals.write({
        threadId: invocation.threadId,
        terminalId,
        data: actionCommandForShell(script.command, terminal.shellFamily, runId),
      });
    });
    const launched = yield* Effect.exit(launch);
    if (launched._tag === "Failure") {
      yield* finishUnlocked({
        threadId: invocation.threadId,
        outcome: "failed",
        deliver: false,
      });
      yield* terminals
        .close({ threadId: invocation.threadId, terminalId, deleteHistory: true })
        .pipe(Effect.ignoreCause({ log: true }));
      return yield* new ActionResumeError({
        reason: "launch_failed",
        message: `Failed to launch Action "${script.name}".`,
      });
    }
    return state;
  });

  const runProjectActionAndResumeImpl = Effect.fn("ActionResume.runProjectActionAndResume")(
    function* (invocation: ActionResumeInvocation, actionId: string) {
      if (!(yield* providerSupportsActionResume(invocation.providerInstanceId))) {
        return yield* new ActionResumeError({
          reason: "unsupported_provider",
          message: "Resume-capable Actions are currently available to Codex and Claude providers.",
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
    const delivered = yield* Effect.exit(attemptDeliverPending(threadId));
    const current = registry.getLatest(threadId);
    if (delivered._tag === "Failure" || current?.delivery === "pending") {
      yield* mutex.withPermits(1)(
        Effect.gen(function* () {
          const latest = registry.getLatest(threadId);
          if (latest?.delivery === "pending") {
            yield* persistState({ ...latest, delivery: "available" });
          }
        }),
      );
      if (delivered._tag === "Failure") return yield* Effect.failCause(delivered.cause);
      return yield* new ActionResumeError({
        reason: "internal_error",
        message: "The interrupted Action follow-up cannot resume while this thread is busy.",
      });
    }
  });

  const discardInterruptedImpl = Effect.fn("ActionResume.discardInterrupted")(function* (
    threadId: ThreadId,
  ) {
    yield* mutex.withPermits(1)(
      Effect.gen(function* () {
        const current = registry.getLatest(threadId);
        if (current === null || current.delivery !== "available") {
          return yield* new ActionResumeError({
            reason: "action_not_recoverable",
            message: "This thread has no interrupted Action follow-up to discard.",
          });
        }
        yield* persistState({ ...current, delivery: "disposed" });
        outputCaptureByRunId.delete(current.runId);
      }),
    );
  });

  const unsubscribeTerminal = yield* terminals.subscribe((event) => {
    const state = registry.getLatest(event.threadId);
    if (state === null || state.outcome !== "running" || state.terminalId !== event.terminalId) {
      return Effect.void;
    }
    if (event.type === "output") {
      return Effect.sync(() => {
        const capture =
          outputCaptureByRunId.get(state.runId) ?? createActionOutputCapture(state.runId);
        outputCaptureByRunId.set(state.runId, capture);
        consumeActionTerminalOutput(capture, event.data);
      });
    }
    if (event.type === "exited") {
      const capture = outputCaptureByRunId.get(state.runId);
      if (capture) finishActionOutputCapture(capture);
      return finish({
        threadId: state.threadId,
        outcome: event.exitCode === 0 ? "succeeded" : "failed",
        exitCode: event.exitCode,
        exitSignal: event.exitSignal,
      });
    }
    if (event.type === "closed") {
      const capture = outputCaptureByRunId.get(state.runId);
      if (capture) finishActionOutputCapture(capture);
      return finish({
        threadId: state.threadId,
        outcome: "cancelled_by_user",
        deliver: !event.deleteHistory,
      });
    }
    if (event.type === "error") {
      return finish({ threadId: state.threadId, outcome: "failed" });
    }
    return Effect.void;
  });
  yield* Effect.addFinalizer(() => Effect.sync(unsubscribeTerminal));

  const hydrate = Effect.fn("ActionResume.hydrate")(function* () {
    const rows = yield* activities.listByKind({ kind: ACTION_RESUME_ACTIVITY_KIND });
    const states: ActionResumeState[] = [];
    for (const row of rows) {
      const decoded = yield* Effect.option(decodeState(row.payload));
      if (Option.isSome(decoded)) states.push(decoded.value);
    }
    registry.hydrate(states);
  });

  const reconcile = Effect.fn("ActionResume.reconcile")(function* () {
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

  yield* hydrate();
  yield* forkParked(
    Effect.gen(function* () {
      const domainEvents = yield* Stream.toQueue(engine.streamDomainEvents, {
        capacity: "unbounded",
      });
      yield* reconcile();
      yield* Stream.runForEach(Stream.fromQueue(domainEvents), (event) => {
        if (event.aggregateKind !== "thread") return Effect.void;
        const threadId = event.aggregateId as ThreadId;
        if (event.type === "thread.archived") return cancel(threadId, "cancelled_by_archive");
        if (event.type === "thread.deleted") {
          registry.clear(threadId);
          return Effect.void;
        }
        return deliverPending(threadId);
      });
    }),
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
    discardInterrupted: (threadId) =>
      discardInterruptedImpl(threadId).pipe(mapActionResumeError("discard the interrupted Action")),
    retryPendingFollowUps,
    countRunning: Effect.sync(() => registry.countRunning()),
  });
});

export const layer = Layer.effect(ActionResume, make);
