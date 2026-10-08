/** Project Actions run as terminal processes and deliver one durable V2 follow-up. */
import {
  ActionResumeState,
  ActionResumeError,
  ActionRunInspection,
  CommandId,
  MessageId,
  type OrchestrationProjectShell,
  ProviderDriverKind,
  type ActionProgress,
  type ProviderInstanceId,
  type ProjectScript,
  type ThreadId,
} from "@t3tools/contracts";
import { projectScriptRuntimeEnv, resolveProjectScripts } from "@t3tools/shared/projectScripts";
import { formatActionResumeFollowUp } from "@t3tools/shared/actionResume";
import {
  ACTION_EVENT_TOKEN_ENV,
  ACTION_RUN_ID_ENV,
  createActionProtocolDecoder,
  type ActionProtocolDecoder,
} from "@t3tools/shared/actionResumeProtocol";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as CommandReceipts from "../orchestration-v2/CommandReceiptStore.ts";
import * as ActionRunStore from "./ActionRunStore.ts";
import * as UpdateDrainAdmission from "../updateDrain/UpdateDrainAdmission.ts";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";

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
  readonly runId: string;
  readonly outcome: Exclude<ActionResumeState["outcome"], "running">;
  readonly exitCode?: number | null;
  readonly exitSignal?: number | null;
  readonly deliver?: boolean;
  readonly publishShell?: boolean;
}

interface ActionProtocolCapture {
  readonly decoder: ActionProtocolDecoder;
  report?: ActionResumeState["report"];
  lastObservedProgress?: ActionProgress;
  lastAcceptedProgressAtMs?: number;
  acceptedProgressCount: number;
  pendingProgress?: ActionProgress;
  progressFlushGeneration: number;
  progressFlushScheduled?: boolean;
  progressLimitWarned?: boolean;
}

const progressEquals = (left: ActionProgress | undefined, right: ActionProgress) =>
  left?.version === right.version &&
  left.state === right.state &&
  left.summary === right.summary &&
  left.phase === right.phase &&
  left.detail === right.detail &&
  left.current === right.current &&
  left.total === right.total &&
  left.unit === right.unit;

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
    readonly inspectActionRun: (
      invocation: ActionResumeInvocation,
      runId: string,
    ) => Effect.Effect<ActionRunInspection, ActionResumeError>;
    readonly cancelByUser: (threadId: ThreadId) => Effect.Effect<void>;
    readonly cancelByArchive: (threadId: ThreadId) => Effect.Effect<void>;
    readonly resumeInterrupted: (threadId: ThreadId) => Effect.Effect<void, ActionResumeError>;
    readonly discardInterrupted: (threadId: ThreadId) => Effect.Effect<void, ActionResumeError>;
    readonly retryPendingFollowUps: Effect.Effect<void>;
    readonly countRunning: Effect.Effect<number>;
  }
>()("t3/actionResume/ActionResume") {}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const MAX_ACTION_OUTPUT_CHARS = 12_000;
const ACTION_PROGRESS_MIN_INTERVAL_MS = 1_000;
const ACTION_PROGRESS_MAX_UPDATES = 128;
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
    runId: state.runId,
    validatedStatus: status,
    lifecycleOutcome: state.outcome,
    exitCode: state.exitCode,
    report: state.report,
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

function actionBlocksNewLaunch(state: ActionResumeState | null): boolean {
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
  const serviceScope = yield* Effect.scope;
  const clock = yield* Clock.Clock;
  const crypto = yield* Crypto.Crypto;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const receipts = yield* CommandReceipts.CommandReceiptStoreV2;
  const serverSettings = yield* ServerSettingsService;
  const runs = yield* ActionRunStore.ActionRunStore;
  const admission = yield* UpdateDrainAdmission.UpdateDrainAdmission;
  const latestByThreadId = new Map<string, ActionResumeState>();
  const registry = {
    getLatest: (threadId: string) => latestByThreadId.get(threadId) ?? null,
    record: (state: ActionResumeState) => latestByThreadId.set(state.threadId, state),
    clear: (threadId: string) => latestByThreadId.delete(threadId),
    listLatest: () => [...latestByThreadId.values()],
    countRunning: () =>
      [...latestByThreadId.values()].filter((state) => state.outcome === "running").length,
  };
  const terminals = yield* TerminalManager.TerminalManager;
  const providers = yield* ProviderRegistry;
  const mutex = yield* Semaphore.make(1);
  const outputCaptureByRunId = new Map<string, ActionOutputCapture>();
  const protocolCaptureByRunId = new Map<string, ActionProtocolCapture>();

  const providerSupportsActionResume = Effect.fn("ActionResume.providerSupportsActionResume")(
    function* (providerInstanceId: ProviderInstanceId) {
      const provider = (yield* providers.getProviders).find(
        (entry) => entry.instanceId === providerInstanceId,
      );
      return provider !== undefined && ACTION_RESUME_PROVIDER_DRIVERS.has(provider.driver);
    },
  );

  const persistState = Effect.fn("ActionResume.persistState")(function* (
    input: ActionResumeState,
    outputTail?: string,
    publishShell = true,
  ) {
    const previous = registry.getLatest(input.threadId);
    const state: ActionResumeState = {
      ...input,
      revision:
        previous?.runId === input.runId ? (previous.revision ?? 0) + 1 : (input.revision ?? 0),
    };
    // The run ledger commits first: a failed shell update must not erase process completion.
    yield* runs.save(state, outputTail);
    registry.record(state);
    if (!publishShell) return state;
    yield* threads.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make(
        `server:action-resume:${state.runId}:${state.revision}:${state.outcome}:${state.delivery}`,
      ),
      threadId: state.threadId,
      actionResume: state,
    });
    return state;
  });

  const flushPendingProgressUnlocked = Effect.fn("ActionResume.flushPendingProgressUnlocked")(
    function* (threadId: ThreadId, runId: string, generation: number) {
      const protocol = protocolCaptureByRunId.get(runId);
      if (protocol === undefined || protocol.progressFlushGeneration !== generation) return;

      protocol.progressFlushScheduled = false;
      const pending = protocol.pendingProgress;
      const current = registry.getLatest(threadId);
      if (pending === undefined || current?.runId !== runId || current.outcome !== "running")
        return;

      const updatedAt = yield* nowIso;
      yield* persistState({ ...current, progress: { ...pending, updatedAt } });
      protocol.lastObservedProgress = pending;
      protocol.lastAcceptedProgressAtMs = yield* clock.currentTimeMillis;
      protocol.acceptedProgressCount += 1;
      delete protocol.pendingProgress;
    },
  );

  const acceptProgressUnlocked = Effect.fn("ActionResume.acceptProgressUnlocked")(function* (
    threadId: ThreadId,
    runId: string,
    progress: ActionProgress,
  ) {
    const current = registry.getLatest(threadId);
    const protocol = protocolCaptureByRunId.get(runId);
    if (current?.runId !== runId || current.outcome !== "running" || protocol === undefined) return;

    if (progressEquals(current.progress, progress)) {
      protocol.lastObservedProgress = progress;
      if (protocol.pendingProgress !== undefined) {
        protocol.progressFlushGeneration += 1;
        protocol.progressFlushScheduled = false;
        delete protocol.pendingProgress;
      }
      return;
    }

    if (
      progressEquals(protocol.lastObservedProgress, progress) &&
      protocol.pendingProgress === undefined
    ) {
      return;
    }

    if (protocol.acceptedProgressCount >= ACTION_PROGRESS_MAX_UPDATES) {
      protocol.lastObservedProgress = progress;
      if (protocol.progressLimitWarned !== true) {
        protocol.progressLimitWarned = true;
        yield* Effect.logWarning("Action progress update limit reached", {
          threadId,
          runId,
          limit: ACTION_PROGRESS_MAX_UPDATES,
        });
      }
      return;
    }

    const acceptedAtMs = yield* clock.currentTimeMillis;
    const stateChanged = current.progress?.state !== progress.state;
    if (
      !stateChanged &&
      protocol.lastAcceptedProgressAtMs !== undefined &&
      acceptedAtMs - protocol.lastAcceptedProgressAtMs < ACTION_PROGRESS_MIN_INTERVAL_MS
    ) {
      protocol.lastObservedProgress = progress;
      protocol.pendingProgress = progress;
      if (protocol.progressFlushScheduled !== true) {
        protocol.progressFlushScheduled = true;
        const generation = ++protocol.progressFlushGeneration;
        const remainingMs =
          ACTION_PROGRESS_MIN_INTERVAL_MS - (acceptedAtMs - protocol.lastAcceptedProgressAtMs);
        yield* clock.sleep(Duration.millis(remainingMs)).pipe(
          Effect.andThen(
            mutex.withPermits(1)(flushPendingProgressUnlocked(threadId, runId, generation)),
          ),
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.void
              : Effect.logWarning("Could not flush deferred Action progress", {
                  threadId,
                  runId,
                  cause: Cause.pretty(cause),
                }),
          ),
          Effect.forkIn(serviceScope, { startImmediately: true }),
        );
      }
      return;
    }

    const updatedAt = yield* nowIso;
    yield* persistState({ ...current, progress: { ...progress, updatedAt } });
    protocol.progressFlushGeneration += 1;
    protocol.progressFlushScheduled = false;
    protocol.lastObservedProgress = progress;
    protocol.lastAcceptedProgressAtMs = acceptedAtMs;
    protocol.acceptedProgressCount += 1;
    delete protocol.pendingProgress;
  });

  const eligibleThreadForFollowUp = Effect.fn("ActionResume.eligibleThreadForFollowUp")(function* (
    threadId: ThreadId,
  ) {
    const projection = yield* threads.getThreadRecords(threadId, ["runs", "runtimeRequests"]);
    const thread = projection.thread;
    if (
      thread.archivedAt !== null ||
      thread.deletedAt !== null ||
      thread.archivePending?.status === "stopping"
    )
      return null;
    const busy =
      projection.runs.some(ThreadManagement.isActiveRun) ||
      projection.runtimeRequests.some((request) => request.status === "pending");
    return busy ? null : thread;
  });

  const deliveryAlreadyAccepted = Effect.fn("ActionResume.deliveryAlreadyAccepted")(function* (
    state: ActionResumeState,
  ) {
    const commandId = CommandId.make(`server:action-resume:${state.runId}:delivery`);
    const receipt = yield* receipts.getByCommandId(commandId);
    if (Option.isSome(receipt) && receipt.value.status === "accepted") return true;
    // Hydrates a cutover transcript before checking its stable V1/V2 message identity.
    yield* threads.ensureLegacyTranscript(state.threadId);
    const projection = yield* threads.getThreadRecords(state.threadId, ["messages"], {
      messageIds: [MessageId.make(`action-resume:${state.runId}:follow-up`)],
    });
    return projection.messages.length > 0;
  });

  const deliverPendingUnlocked = Effect.fn("ActionResume.deliverPendingUnlocked")(function* (
    threadId: ThreadId,
  ) {
    const state = registry.getLatest(threadId);
    if (state === null || state.delivery !== "pending") return;
    if (yield* deliveryAlreadyAccepted(state)) {
      yield* persistState({ ...state, delivery: "delivered" });
      outputCaptureByRunId.delete(state.runId);
      protocolCaptureByRunId.delete(state.runId);
      return;
    }
    const thread = yield* eligibleThreadForFollowUp(threadId);
    if (thread === null) return;
    const retained = yield* runs.get(threadId, state.runId);
    const outputTail =
      Option.isSome(retained) && retained.value.outputTail !== null
        ? retained.value.outputTail
        : (finishActionOutputCapture(
            outputCaptureByRunId.get(state.runId) ?? createActionOutputCapture(state.runId),
          ) ??
          (yield* terminals
            .history({ threadId: state.threadId, terminalId: state.terminalId })
            .pipe(
              Effect.map((history) =>
                actionOutputFromTranscript(history, state.runId, state.outcome === "process_lost"),
              ),
              Effect.catchCause(() => Effect.succeed(undefined)),
            )));
    if (outputTail !== undefined) yield* runs.save(state, outputTail);

    const commandId = CommandId.make(`server:action-resume:${state.runId}:delivery`);
    const messageId = MessageId.make(`action-resume:${state.runId}:follow-up`);
    yield* threads.dispatch({
      type: "message.dispatch",
      commandId,
      threadId,
      messageId,
      text: followUpText(state, outputTail),
      attachments: [],
      createdBy: "system",
      creationSource: "server",
      // Serialized V2 admission queues a raced user turn rather than steering it.
      dispatchMode: { type: "queue_after_active" },
    });
    yield* persistState({ ...state, delivery: "delivered" });
    outputCaptureByRunId.delete(state.runId);
    protocolCaptureByRunId.delete(state.runId);
  });

  const attemptDeliverPending = (threadId: ThreadId) =>
    mutex.withPermits(1)(deliverPendingUnlocked(threadId));

  const deliverPending = (threadId: ThreadId) =>
    attemptDeliverPending(threadId).pipe(
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
    if (current === null || current.runId !== input.runId || current.outcome !== "running") return;
    const finishedAt = yield* nowIso;
    const shouldDeliver =
      input.deliver !== false &&
      (input.outcome === "succeeded" ||
        input.outcome === "failed" ||
        input.outcome === "cancelled_by_user");
    const protocol = protocolCaptureByRunId.get(current.runId);
    const report = input.outcome === "succeeded" ? protocol?.report : undefined;
    const progress =
      protocol?.pendingProgress === undefined
        ? current.progress
        : { ...protocol.pendingProgress, updatedAt: finishedAt };
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
      ...(progress === undefined ? {} : { progress }),
      ...(report === undefined ? {} : { report }),
    };
    const capture = outputCaptureByRunId.get(current.runId);
    if (capture !== undefined && protocol !== undefined)
      consumeActionTerminalOutput(capture, protocol.decoder.finish());
    const outputTail = capture === undefined ? undefined : finishActionOutputCapture(capture);
    yield* persistState(next, outputTail, input.publishShell);
    if (next.delivery === "disposed") {
      outputCaptureByRunId.delete(next.runId);
      protocolCaptureByRunId.delete(next.runId);
    }
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
        yield* finish({ threadId, runId: current.runId, outcome });
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
              protocolCaptureByRunId.delete(latest.runId);
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

  const disposeDeleted = Effect.fn("ActionResume.disposeDeleted")(function* (threadId: ThreadId) {
    yield* mutex.withPermits(1)(
      Effect.gen(function* () {
        const current = registry.getLatest(threadId);
        if (current === null) return;
        if (current.outcome === "running") {
          yield* finishUnlocked({
            threadId,
            runId: current.runId,
            outcome: "cancelled_by_archive",
            deliver: false,
            publishShell: false,
          });
        } else if (current.delivery === "pending" || current.delivery === "available") {
          yield* persistState({ ...current, delivery: "disposed" }, undefined, false);
        }
        registry.clear(threadId);
        outputCaptureByRunId.delete(current.runId);
        protocolCaptureByRunId.delete(current.runId);
        yield* terminals
          .close({ threadId, terminalId: current.terminalId })
          .pipe(Effect.ignoreCause({ log: true }));
      }),
    );
  });

  const resolveProjectContext = Effect.fn("ActionResume.resolveProjectContext")(function* (
    threadId: ThreadId,
  ) {
    const thread = yield* threads.getThreadShell(threadId);
    if (thread === null || thread.deletedAt !== null) {
      return yield* new ActionResumeError({
        reason: "thread_not_found",
        message: "The originating thread no longer exists.",
      });
    }
    if (thread.archivedAt !== null) {
      return yield* new ActionResumeError({
        reason: "thread_not_found",
        message: "The originating thread is archived.",
      });
    }
    const project = yield* projects.getShell(thread.projectId);
    if (Option.isNone(project)) {
      return yield* new ActionResumeError({
        reason: "project_not_found",
        message: "The originating project no longer exists.",
      });
    }
    return { thread, project: project.value };
  });

  const resolveActions = Effect.fn("ActionResume.resolveActions")(function* (
    project: Pick<OrchestrationProjectShell, "id" | "scripts">,
  ) {
    // Settings edits change the effective Actions without updating the project shell.
    const settings = yield* serverSettings.getSettings;
    return resolveProjectScripts(settings, project);
  });

  const listProjectActionsImpl = Effect.fn("ActionResume.listProjectActions")(function* (
    invocation: ActionResumeInvocation,
  ) {
    const providerSupported = yield* providerSupportsActionResume(invocation.providerInstanceId);
    const { project } = yield* resolveProjectContext(invocation.threadId);
    const scripts = yield* resolveActions(project);
    const launchBlocked = actionBlocksNewLaunch(registry.getLatest(invocation.threadId));
    return scripts.map((script) => {
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
    const eventToken = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
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
      revision: 0,
    };
    const cwd = thread.worktreePath ?? project.workspaceRoot;
    const env = projectScriptRuntimeEnv({
      project: { cwd: project.workspaceRoot },
      worktreePath: thread.worktreePath,
      extraEnv: {
        [ACTION_RUN_ID_ENV]: runId,
        [ACTION_EVENT_TOKEN_ENV]: eventToken,
      },
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
      protocolCaptureByRunId.set(runId, {
        decoder: createActionProtocolDecoder({ runId, token: eventToken }),
        acceptedProgressCount: 0,
        progressFlushGeneration: 0,
      });
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
        runId,
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
      const scripts = yield* resolveActions(project);
      const script = scripts.find((entry) => entry.id === actionId);
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
      return yield* mutex.withPermits(1)(
        admission.admit("action-resume", launchActionUnlocked(invocation, script)).pipe(
          Effect.catchTags({
            UpdateDrainAdmissionError: (error) =>
              Effect.fail(
                new ActionResumeError({ reason: "internal_error", message: error.message }),
              ),
            UpdateDrainError: (error) =>
              Effect.fail(
                new ActionResumeError({ reason: "internal_error", message: error.message }),
              ),
          }),
        ),
      );
    },
  );

  const inspectActionRunImpl = Effect.fn("ActionResume.inspectActionRun")(function* (
    invocation: ActionResumeInvocation,
    runId: string,
  ) {
    const retained = yield* runs.get(invocation.threadId, runId);
    if (Option.isNone(retained)) {
      return yield* new ActionResumeError({
        reason: "action_run_not_found",
        message: "No retained Project Action run with that id belongs to this thread.",
      });
    }
    const state = retained.value.state;
    const outputTail =
      retained.value.outputTail ??
      (yield* terminals
        .history({
          threadId: invocation.threadId,
          terminalId: state.terminalId,
        })
        .pipe(
          Effect.map((history) => actionOutputFromTranscript(history, state.runId, true) ?? ""),
          Effect.catchCause(() => Effect.succeed("")),
        ));
    return ActionRunInspection.make({
      runId: state.runId,
      actionName: state.actionName,
      lifecycleOutcome: state.outcome,
      exitCode: state.exitCode,
      exitSignal: state.exitSignal,
      outputTail,
    });
  });

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
        protocolCaptureByRunId.delete(current.runId);
      }),
    );
  });

  const unsubscribeTerminal = yield* terminals.subscribe((event) => {
    const state = registry.getLatest(event.threadId);
    if (state === null || state.outcome !== "running" || state.terminalId !== event.terminalId) {
      return Effect.void;
    }
    if (event.type === "output") {
      return Effect.gen(function* () {
        const capture =
          outputCaptureByRunId.get(state.runId) ?? createActionOutputCapture(state.runId);
        outputCaptureByRunId.set(state.runId, capture);
        const protocol = protocolCaptureByRunId.get(state.runId);
        if (!protocol) {
          consumeActionTerminalOutput(capture, event.data);
          return;
        }
        const decoded = protocol.decoder.push(event.data);
        consumeActionTerminalOutput(capture, decoded.output);
        for (const actionEvent of decoded.events) {
          if (actionEvent.kind === "progress") {
            yield* mutex
              .withPermits(1)(
                acceptProgressUnlocked(state.threadId, state.runId, actionEvent.progress),
              )
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("Could not persist Action progress", {
                    threadId: state.threadId,
                    runId: state.runId,
                    cause: Cause.pretty(cause),
                  }),
                ),
              );
          } else if (protocol.report === undefined) protocol.report = actionEvent.report;
          else {
            yield* Effect.logWarning("Action emitted more than one terminal result", {
              threadId: state.threadId,
              runId: state.runId,
            });
          }
        }
        if (decoded.invalidFrames > 0) {
          yield* Effect.logWarning("Action emitted malformed protocol frames", {
            threadId: state.threadId,
            runId: state.runId,
            count: decoded.invalidFrames,
          });
        }
      });
    }
    if (event.type === "exited") {
      const protocol = protocolCaptureByRunId.get(state.runId);
      const capture = outputCaptureByRunId.get(state.runId);
      if (capture) {
        if (protocol) consumeActionTerminalOutput(capture, protocol.decoder.finish());
        finishActionOutputCapture(capture);
      }
      return finish({
        threadId: state.threadId,
        runId: state.runId,
        outcome: event.exitCode === 0 ? "succeeded" : "failed",
        exitCode: event.exitCode,
        exitSignal: event.exitSignal,
      });
    }
    if (event.type === "closed") {
      const protocol = protocolCaptureByRunId.get(state.runId);
      const capture = outputCaptureByRunId.get(state.runId);
      if (capture) {
        if (protocol) consumeActionTerminalOutput(capture, protocol.decoder.finish());
        finishActionOutputCapture(capture);
      }
      return finish({
        threadId: state.threadId,
        runId: state.runId,
        outcome: "cancelled_by_user",
        deliver: !event.deleteHistory,
      });
    }
    if (event.type === "error") {
      const protocol = protocolCaptureByRunId.get(state.runId);
      const capture = outputCaptureByRunId.get(state.runId);
      if (capture) {
        if (protocol) consumeActionTerminalOutput(capture, protocol.decoder.finish());
        finishActionOutputCapture(capture);
      }
      return finish({ threadId: state.threadId, runId: state.runId, outcome: "failed" });
    }
    return Effect.void;
  });
  yield* Effect.addFinalizer(() => Effect.sync(unsubscribeTerminal));

  const hydrate = Effect.fn("ActionResume.hydrate")(function* () {
    for (const state of yield* runs.listLatest) {
      const current = registry.getLatest(state.threadId);
      if (current === null || state.startedAt >= current.startedAt) registry.record(state);
    }
  });

  const reconcile = Effect.fn("ActionResume.reconcile")(function* (
    initialStates: ReadonlyArray<ActionResumeState>,
  ) {
    for (const initial of initialStates) {
      const state = registry.getLatest(initial.threadId);
      if (state === null || state.runId !== initial.runId) continue;
      yield* threads.ensureLegacyTranscript(state.threadId);
      const shell = yield* threads.getThreadShell(state.threadId);
      if (shell === null) {
        // A missing shell during cutover is not proof that its retained result was deleted.
        if (state.outcome === "running" || state.delivery === "pending") {
          const interrupted = {
            ...state,
            outcome: state.outcome === "running" ? ("process_lost" as const) : state.outcome,
            delivery: "available" as const,
            finishedAt: state.finishedAt ?? (yield* nowIso),
            revision: (state.revision ?? 0) + 1,
          };
          yield* runs.save(interrupted);
          registry.record(interrupted);
        }
        continue;
      }
      if (shell.deletedAt !== null) {
        if (state.outcome === "running")
          yield* finishUnlocked({
            threadId: state.threadId,
            runId: state.runId,
            outcome: "cancelled_by_archive",
            deliver: false,
            publishShell: false,
          });
        else if (state.delivery === "pending" || state.delivery === "available")
          yield* persistState({ ...state, delivery: "disposed" }, undefined, false);
        registry.clear(state.threadId);
        continue;
      }
      if (shell.archivedAt !== null) {
        yield* persistState({
          ...state,
          outcome: state.outcome === "running" ? "cancelled_by_archive" : state.outcome,
          delivery: "disposed",
        });
      } else if (
        (state.delivery === "pending" ||
          state.delivery === "available" ||
          state.delivery === "armed") &&
        (yield* deliveryAlreadyAccepted(state))
      ) {
        yield* persistState({ ...state, delivery: "delivered" });
      } else if (state.outcome === "running") {
        const finishedAt = yield* nowIso;
        yield* persistState({
          ...state,
          outcome: "process_lost",
          delivery: "available",
          finishedAt,
        });
      } else if (state.delivery === "pending" && shell.archivePending?.status !== "stopping") {
        // A stopping archive keeps the completed result's delivery intent across restart.
        yield* persistState({ ...state, delivery: "available" });
      } else if (
        shell.actionResume?.runId !== state.runId ||
        shell.actionResume.revision !== state.revision
      ) {
        yield* persistState(state);
      }
    }
  });

  yield* hydrate();
  const initialStates = registry.listLatest();
  // Subscribe before startup imports; reconcile after activation has materialized its shells.
  const domainEvents = yield* Stream.toQueue(threads.streamDomainEvents, { capacity: "unbounded" });
  yield* forkParked(
    Effect.gen(function* () {
      yield* mutex.withPermits(1)(reconcile(initialStates));
      yield* Stream.runForEach(Stream.fromQueue(domainEvents), (event) => {
        const threadId = event.threadId;
        if (event.type === "thread.archived") return cancel(threadId, "cancelled_by_archive");
        if (event.type === "thread.deleted") return disposeDeleted(threadId);
        // Archive failure/dismissal is metadata-only. Retry pending results as
        // soon as that hold ends, even if this subscriber missed its start.
        // Publishing delivered Action metadata is a no-op in deliverPending.
        if (
          event.type === "thread.metadata-updated" &&
          event.payload.archivePending?.status === "stopping"
        )
          return Effect.void;
        return deliverPending(threadId);
      });
    }),
  );

  yield* Effect.addFinalizer(() =>
    Effect.forEach(
      registry
        .listLatest()
        .filter((state) => state.outcome === "running" && outputCaptureByRunId.has(state.runId)),
      (state) =>
        mutex.withPermits(1)(
          Effect.gen(function* () {
            yield* finishUnlocked({
              threadId: state.threadId,
              runId: state.runId,
              outcome: "cancelled_by_shutdown",
              deliver: false,
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
    inspectActionRun: (invocation, runId) =>
      inspectActionRunImpl(invocation, runId).pipe(mapActionResumeError("inspect the Action run")),
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
