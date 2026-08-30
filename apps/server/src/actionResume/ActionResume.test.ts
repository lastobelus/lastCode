import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type ActionProgress,
  type ActionResumeState,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type TerminalEvent,
  type TerminalOpenInput,
  type TerminalWriteInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import {
  ACTION_EVENT_TOKEN_ENV,
  ACTION_RUN_ID_ENV,
  actionProtocolFrame,
} from "@t3tools/shared/actionResumeProtocol";

import { ProjectionThreadActivityRepository } from "../persistence/Services/ProjectionThreadActivities.ts";
import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadActionResume from "../orchestration/ThreadActionResume.ts";
import { makeProviderRegistryLayer } from "../provider/testUtils/providerRegistryMock.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import { UpdateDrainAdmission } from "../updateDrain/UpdateDrainAdmission.ts";
import * as ActionResume from "./ActionResume.ts";

const threadId = ThreadId.make("thread-action-resume");
const projectId = ProjectId.make("project-action-resume");
const providerInstanceId = ProviderInstanceId.make("codex");
const claudeProviderInstanceId = ProviderInstanceId.make("claudeAgent");
const openCodeProviderInstanceId = ProviderInstanceId.make("opencode");
const now = "2026-08-17T00:00:00.000Z";

const thread = {
  id: threadId,
  projectId,
  title: "Action resume thread",
  modelSelection: { provider: "codex", instanceId: providerInstanceId, model: "gpt-5" },
  runtimeMode: "approval-required",
  interactionMode: "plan",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
} as OrchestrationThreadShell;

const project = {
  id: projectId,
  title: "Action resume project",
  workspaceRoot: "/tmp/action-resume-project",
  defaultModelSelection: null,
  scripts: [
    {
      id: "qa",
      name: "QA",
      command: "vp test run",
      icon: "test",
      runOnWorktreeCreate: false,
      allowAgentResume: true,
    },
    {
      id: "manual-only",
      name: "Manual only",
      command: "echo manual",
      icon: "play",
      runOnWorktreeCreate: false,
    },
  ],
  createdAt: now,
  updatedAt: now,
} as OrchestrationProjectShell;

it("writes shell-specific status propagation for Action terminals", () => {
  assert.equal(
    ActionResume.actionCommandForShell("vp test run", "powershell", "run-1"),
    "vp test run\nif ($?) { exit 0 }\nif ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }\nexit 1\n",
  );
  assert.equal(
    ActionResume.actionCommandForShell("vp test run", "cmd", "run-1"),
    "vp test run\nexit /b %errorlevel%\n",
  );
  assert.equal(
    ActionResume.actionCommandForShell("printf '\\033[31mred\\033[0m\\n'", "posix", "run-1"),
    "printf '\\033]777;T3ActionOutput;run-1;start\\007'; eval 'printf '\"'\"'\\033[31mred\\033[0m\\n'\"'\"''; __t3_action_status=$?; printf '\\033]777;T3ActionOutput;run-1;end\\007'; exit $__t3_action_status\n",
  );
});

it("blocks a replacement until the current Action continuation is settled", () => {
  for (const delivery of ["armed", "pending", "available"] as const) {
    assert.isTrue(ActionResume.actionBlocksNewLaunch({ delivery } as ActionResumeState), delivery);
  }
  for (const delivery of ["delivered", "disposed"] as const) {
    assert.isFalse(ActionResume.actionBlocksNewLaunch({ delivery } as ActionResumeState), delivery);
  }
  assert.isFalse(ActionResume.actionBlocksNewLaunch(null));
});

it.effect("runs one opted-in Action and delivers exactly one automated follow-up", () => {
  const dispatched: OrchestrationCommand[] = [];
  const opened: TerminalOpenInput[] = [];
  const written: TerminalWriteInput[] = [];
  const timeline: string[] = [];
  let terminalStatus: "running" | "exited" = "running";
  let failWrite = false;
  let admissionClosed = false;
  let progressFlushed: Deferred.Deferred<void> | undefined;
  const admittedKinds: string[] = [];
  let terminalListener: ((event: TerminalEvent) => Effect.Effect<void>) | undefined;

  const dependencies = Layer.mergeAll(
    Layer.mock(OrchestrationEngineService)({
      dispatch: (command) =>
        Effect.gen(function* () {
          timeline.push(`dispatch:${command.type}`);
          dispatched.push(command);
          if (
            progressFlushed !== undefined &&
            command.type === "thread.activity.append" &&
            command.activity.kind === ActionResume.ACTION_RESUME_ACTIVITY_KIND &&
            (command.activity.payload as ActionResumeState).progress?.phase === "review"
          ) {
            yield* Deferred.succeed(progressFlushed, undefined);
          }
          return { sequence: dispatched.length };
        }),
      streamDomainEvents: Stream.never,
    }),
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: () => Effect.succeed(Option.some(thread)),
      getProjectShellById: () => Effect.succeed(Option.some(project)),
    }),
    Layer.mock(ProjectionThreadActivityRepository)({
      listByKind: () => Effect.succeed([]),
      listByThreadId: ({ threadId: requestedThreadId }) =>
        Effect.succeed(
          dispatched.flatMap((command) => {
            if (
              command.type !== "thread.activity.append" ||
              command.threadId !== requestedThreadId
            ) {
              return [];
            }
            return [
              {
                activityId: command.activity.id,
                threadId: command.threadId,
                turnId: command.activity.turnId,
                tone: command.activity.tone,
                kind: command.activity.kind,
                summary: command.activity.summary,
                payload: command.activity.payload,
                createdAt: command.activity.createdAt,
              },
            ];
          }),
        ),
    }),
    Layer.mock(TerminalManager.TerminalManager)({
      open: (input) =>
        Effect.sync(() => {
          timeline.push("terminal:open");
          opened.push(input);
          return {
            status: terminalStatus,
            shellFamily: "posix",
          } as TerminalManager.OpenTerminalSessionSnapshot;
        }),
      write: (input) =>
        failWrite
          ? Effect.die("write failed")
          : Effect.sync(() => {
              written.push(input);
            }),
      close: (input) =>
        terminalListener?.({
          type: "closed",
          threadId: input.threadId,
          terminalId: input.terminalId ?? "default",
          deleteHistory: input.deleteHistory ?? false,
        }) ?? Effect.void,
      history: ({ terminalId }) => {
        const runId = terminalId.slice("action-".length);
        return Effect.succeed(
          `prompt\n${ActionResume.actionOutputMarker(runId, "start")}full retained output\n${ActionResume.actionOutputMarker(runId, "end")}prompt`,
        );
      },
      subscribe: (listener) =>
        Effect.sync(() => {
          terminalListener = listener;
          return () => undefined;
        }),
    }),
    makeProviderRegistryLayer([
      {
        instanceId: providerInstanceId,
        driver: ProviderDriverKind.make("codex"),
      } as never,
      {
        instanceId: claudeProviderInstanceId,
        driver: ProviderDriverKind.make("claudeAgent"),
      } as never,
      {
        instanceId: openCodeProviderInstanceId,
        driver: ProviderDriverKind.make("opencode"),
      } as never,
    ]),
    ThreadActionResume.layer,
    Layer.mock(UpdateDrainAdmission)({
      admit: (kind, effect) =>
        Effect.sync(() => admittedKinds.push(kind)).pipe(
          Effect.andThen(
            admissionClosed ? Effect.die("update drain is closed in this test") : effect,
          ),
        ),
    }),
    NodeServices.layer,
  );

  return Effect.gen(function* () {
    progressFlushed = yield* Deferred.make<void>();
    const service = yield* ActionResume.ActionResume;
    // Let startup reconciliation settle while the registry is still empty.
    yield* Effect.yieldNow;
    const listed = yield* service.listProjectActions({ threadId, providerInstanceId });
    assert.deepEqual(
      listed.map(({ id, resumeEligible }) => ({ id, resumeEligible })),
      [
        { id: "qa", resumeEligible: true },
        { id: "manual-only", resumeEligible: false },
      ],
    );

    const claudeListed = yield* service.listProjectActions({
      threadId,
      providerInstanceId: claudeProviderInstanceId,
    });
    assert.isTrue(claudeListed.find(({ id }) => id === "qa")?.resumeEligible);

    const unsupportedListed = yield* service.listProjectActions({
      threadId,
      providerInstanceId: openCodeProviderInstanceId,
    });
    assert.isFalse(unsupportedListed.find(({ id }) => id === "qa")?.resumeEligible);
    const unsupportedRun = yield* service
      .runProjectActionAndResume({ threadId, providerInstanceId: openCodeProviderInstanceId }, "qa")
      .pipe(Effect.flip);
    assert.equal(unsupportedRun.reason, "unsupported_provider");

    const claudeRunning = yield* service.runProjectActionAndResume(
      { threadId, providerInstanceId: claudeProviderInstanceId },
      "qa",
    );
    assert.equal(claudeRunning.outcome, "running");
    yield* terminalListener!({
      type: "closed",
      threadId,
      terminalId: claudeRunning.terminalId,
      deleteHistory: true,
    });

    const running = yield* service.runProjectActionAndResume(
      { threadId, providerInstanceId },
      "qa",
    );
    assert.equal(running.outcome, "running");
    assert.equal(running.command, "vp test run");
    const launchedActivity = dispatched.findLast(
      (command) => command.type === "thread.activity.append",
    );
    assert.equal(launchedActivity?.type, "thread.activity.append");
    if (launchedActivity?.type === "thread.activity.append") {
      assert.deepInclude(launchedActivity.activity.payload, { command: "vp test run" });
    }
    assert.equal(opened.length, 2);
    assert.equal(written.length, 2);
    assert.isBelow(
      timeline.indexOf("terminal:open"),
      timeline.indexOf("dispatch:thread.activity.append"),
    );
    assert.match(written.at(-1)?.data ?? "", /vp test run/);
    assert.match(written.at(-1)?.data ?? "", /exit \$__t3_action_status/);
    assert.equal(opened.at(-1)?.env?.[ACTION_RUN_ID_ENV], running.runId);
    const eventToken = opened.at(-1)?.env?.[ACTION_EVENT_TOKEN_ENV];
    assert.isString(eventToken);

    assert.isDefined(terminalListener);
    const startMarker = ActionResume.actionOutputMarker(running.runId, "start");
    const endMarker = ActionResume.actionOutputMarker(running.runId, "end");
    const progressFrame = (
      state: "working" | "waiting",
      summary: string,
      fields: Partial<Omit<ActionProgress, "version" | "state" | "summary">> = {},
    ) =>
      actionProtocolFrame({
        runId: running.runId,
        token: eventToken!,
        event: { kind: "progress", progress: { version: 1, state, summary, ...fields } },
      });
    const resultFrame = actionProtocolFrame({
      runId: running.runId,
      token: eventToken!,
      event: {
        kind: "result",
        report: {
          version: 1,
          outcome: "attention",
          reason: "test-failure",
          summary: "One test needs attention",
        },
      },
    });
    yield* terminalListener!({
      type: "output",
      threadId,
      terminalId: running.terminalId,
      data: `prompt and echoed command\n${startMarker.slice(0, -2)}`,
    });
    yield* terminalListener!({
      type: "output",
      threadId,
      terminalId: running.terminalId,
      data: `${startMarker.slice(-2)}QA failed: \u001b[31mexpected 2, received 3\u001b[0m\n${progressFrame("working", "Running checks")}${progressFrame("working", "Running checks")}${progressFrame("working", "Running tests")}${progressFrame("waiting", "Waiting for review", { phase: "ci", current: 1, total: 3, unit: "check" })}${resultFrame}${endMarker}prompt`,
    });
    const registry = yield* ThreadActionResume.ThreadActionResumeService;
    assert.deepInclude(registry.getLatest(threadId), {
      outcome: "running",
      revision: 2,
    });
    assert.equal(registry.getLatest(threadId)?.progress?.state, "waiting");
    assert.equal(registry.getLatest(threadId)?.progress?.summary, "Waiting for review");
    assert.deepEqual(
      dispatched.flatMap((command) => {
        if (
          command.type !== "thread.activity.append" ||
          command.activity.kind !== ActionResume.ACTION_RESUME_ACTIVITY_KIND
        ) {
          return [];
        }
        const payload = command.activity.payload as ActionResumeState;
        return payload.runId === running.runId && payload.outcome === "running"
          ? [payload.revision]
          : [];
      }),
      [0, 1, 2],
    );
    yield* terminalListener!({
      type: "output",
      threadId,
      terminalId: running.terminalId,
      data: progressFrame("waiting", "Waiting for review", {
        phase: "review",
        detail: "Review is still pending",
        current: 2,
        total: 3,
        unit: "check",
      }),
    });
    yield* TestClock.adjust(999);
    assert.equal(registry.getLatest(threadId)?.progress?.summary, "Waiting for review");
    yield* TestClock.adjust(1);
    yield* Deferred.await(progressFlushed);
    assert.deepInclude(registry.getLatest(threadId)?.progress, {
      state: "waiting",
      summary: "Waiting for review",
      phase: "review",
      detail: "Review is still pending",
      current: 2,
      total: 3,
      unit: "check",
    });
    assert.deepEqual(
      dispatched.flatMap((command) => {
        if (
          command.type !== "thread.activity.append" ||
          command.activity.kind !== ActionResume.ACTION_RESUME_ACTIVITY_KIND
        ) {
          return [];
        }
        const payload = command.activity.payload as ActionResumeState;
        return payload.runId === running.runId && payload.outcome === "running"
          ? [payload.revision]
          : [];
      }),
      [0, 1, 2, 3],
    );
    yield* terminalListener!({
      type: "output",
      threadId,
      terminalId: running.terminalId,
      data: `${progressFrame("waiting", "Waiting for review", {
        phase: "approval",
        current: 3,
        total: 3,
        unit: "check",
      })}${progressFrame("waiting", "Waiting for review", {
        phase: "review",
        detail: "Review is still pending",
        current: 2,
        total: 3,
        unit: "check",
      })}`,
    });
    yield* TestClock.adjust(1_000);
    yield* Effect.yieldNow;
    assert.equal(registry.getLatest(threadId)?.revision, 3);
    assert.equal(registry.getLatest(threadId)?.progress?.phase, "review");
    assert.deepEqual(
      [
        ...new Set(
          dispatched.flatMap((command) =>
            command.type === "thread.activity.append" &&
            command.activity.kind === ActionResume.ACTION_RESUME_ACTIVITY_KIND &&
            (command.activity.payload as ActionResumeState).runId === running.runId
              ? [command.activity.id]
              : [],
          ),
        ),
      ],
      [`action-resume:${running.runId}`],
    );
    yield* terminalListener!({
      type: "exited",
      threadId,
      terminalId: running.terminalId,
      exitCode: 0,
      exitSignal: null,
    });
    yield* terminalListener!({
      type: "exited",
      threadId,
      terminalId: running.terminalId,
      exitCode: 0,
      exitSignal: null,
    });

    const turnStarts = dispatched.filter(
      (command): command is Extract<OrchestrationCommand, { type: "thread.turn.start" }> =>
        command.type === "thread.turn.start",
    );
    assert.equal(turnStarts.length, 1);
    assert.equal(turnStarts[0]?.message.role, "system");
    assert.match(turnStarts[0]?.message.text ?? "", /Automated Project Action follow-up/);
    assert.include(turnStarts[0]?.message.text ?? "", "Exit code: 0");
    assert.include(turnStarts[0]?.message.text ?? "", "One test needs attention");
    assert.include(turnStarts[0]?.message.text ?? "", `"runId":"${running.runId}"`);
    assert.notInclude(turnStarts[0]?.message.text ?? "", "expected 2, received 3");
    assert.notInclude(turnStarts[0]?.message.text ?? "", "prompt and echoed command");
    assert.equal(turnStarts[0]?.runtimeMode, thread.runtimeMode);
    assert.equal(turnStarts[0]?.interactionMode, thread.interactionMode);

    assert.deepInclude(registry.getLatest(threadId), {
      outcome: "succeeded",
      delivery: "delivered",
      report: {
        version: 1,
        outcome: "attention",
        reason: "test-failure",
        summary: "One test needs attention",
      },
    });
    const inspection = yield* service.inspectActionRun(
      { threadId, providerInstanceId },
      running.runId,
    );
    assert.deepInclude(inspection, {
      runId: running.runId,
      actionName: "QA",
      lifecycleOutcome: "succeeded",
      exitCode: 0,
      outputTail: "full retained output\n",
    });
    const missingInspection = yield* service
      .inspectActionRun({ threadId, providerInstanceId }, "another-thread-run")
      .pipe(Effect.flip);
    assert.equal(missingInspection.reason, "action_run_not_found");

    const deleting = yield* service.runProjectActionAndResume(
      { threadId, providerInstanceId },
      "qa",
    );
    yield* terminalListener!({
      type: "closed",
      threadId,
      terminalId: deleting.terminalId,
      deleteHistory: true,
    });

    assert.equal(dispatched.filter((command) => command.type === "thread.turn.start").length, 1);
    assert.deepInclude(registry.getLatest(threadId), {
      outcome: "cancelled_by_user",
      delivery: "disposed",
    });

    failWrite = true;
    const failedWrite = yield* service
      .runProjectActionAndResume({ threadId, providerInstanceId }, "qa")
      .pipe(Effect.flip);
    assert.equal(failedWrite.reason, "launch_failed");
    const failedState = registry.getLatest(threadId);
    assert.deepInclude(failedState, { outcome: "failed", delivery: "disposed" });

    failWrite = false;
    terminalStatus = "exited";
    const earlyExit = yield* service
      .runProjectActionAndResume({ threadId, providerInstanceId }, "qa")
      .pipe(Effect.flip);
    assert.equal(earlyExit.reason, "launch_failed");
    assert.equal(registry.getLatest(threadId)?.runId, failedState?.runId);

    terminalStatus = "running";
    const blocked = yield* service.runProjectActionAndResume(
      { threadId, providerInstanceId },
      "qa",
    );
    admissionClosed = true;
    yield* terminalListener!({
      type: "exited",
      threadId,
      terminalId: blocked.terminalId,
      exitCode: 0,
      exitSignal: null,
    });
    assert.equal(dispatched.filter((command) => command.type === "thread.turn.start").length, 1);
    assert.equal(admittedKinds.at(-1), "thread-turn");
    assert.deepInclude(registry.getLatest(threadId), {
      outcome: "succeeded",
      delivery: "pending",
    });

    admissionClosed = false;
    yield* service.retryPendingFollowUps;
    yield* service.retryPendingFollowUps;
    assert.equal(dispatched.filter((command) => command.type === "thread.turn.start").length, 2);
    assert.deepInclude(registry.getLatest(threadId), {
      outcome: "succeeded",
      delivery: "delivered",
    });
  }).pipe(
    Effect.provide(
      ActionResume.layer.pipe(Layer.provideMerge(Layer.merge(dependencies, TestClock.layer()))),
    ),
    Effect.scoped,
  );
});

it.effect("requires an explicit resume after a running Action is found on startup", () =>
  Effect.gen(function* () {
    const reconciled = yield* Deferred.make<ActionResumeState>();
    const subscribed = yield* Deferred.make<void>();
    const dispatched: OrchestrationCommand[] = [];
    let failTurnStart = false;
    const running: ActionResumeState = {
      runId: "interrupted-run",
      threadId,
      projectId,
      actionId: "qa",
      actionName: "QA",
      terminalId: "action-interrupted-run",
      outcome: "running",
      delivery: "armed",
      startedAt: now,
      finishedAt: null,
      exitCode: null,
      exitSignal: null,
    };
    const recoveredThreadId = ThreadId.make("thread-action-resume-recovered");
    const available: ActionResumeState = {
      ...running,
      runId: "available-run",
      threadId: recoveredThreadId,
      terminalId: "action-available-run",
      outcome: "process_lost",
      delivery: "available",
      finishedAt: now,
    };
    const settledThreadId = ThreadId.make("thread-action-resume-settled");
    const settled: ActionResumeState = {
      ...running,
      runId: "settled-run",
      threadId: settledThreadId,
      terminalId: "action-settled-run",
      outcome: "succeeded",
      delivery: "disposed",
      finishedAt: now,
      exitCode: 0,
    };

    const dependencies = Layer.mergeAll(
      Layer.mock(OrchestrationEngineService)({
        dispatch: (command) =>
          Effect.gen(function* () {
            if (command.type === "thread.turn.start" && failTurnStart) {
              return yield* new OrchestrationCommandInvariantError({
                commandType: command.type,
                detail: "turn start failed",
              });
            }
            dispatched.push(command);
            if (
              command.type === "thread.activity.append" &&
              command.activity.payload !== null &&
              typeof command.activity.payload === "object" &&
              "outcome" in command.activity.payload &&
              command.activity.payload.outcome === "process_lost" &&
              "runId" in command.activity.payload &&
              command.activity.payload.runId === "interrupted-run"
            ) {
              yield* Deferred.await(subscribed);
              yield* Deferred.succeed(reconciled, command.activity.payload as ActionResumeState);
            }
            return { sequence: dispatched.length };
          }),
        streamDomainEvents: Stream.unwrap(
          Deferred.succeed(subscribed, undefined).pipe(Effect.as(Stream.never)),
        ),
      }),
      Layer.mock(ProjectionSnapshotQuery)({
        getThreadShellById: () => Effect.succeed(Option.some(thread)),
        getProjectShellById: () => Effect.succeed(Option.some(project)),
      }),
      Layer.mock(ProjectionThreadActivityRepository)({
        listByKind: () =>
          Effect.succeed([
            {
              activityId: EventId.make("action-resume:interrupted-run:running:armed"),
              threadId,
              turnId: null,
              tone: "info",
              kind: ActionResume.ACTION_RESUME_ACTIVITY_KIND,
              summary: "Waiting for Action: QA",
              payload: running,
              sequence: 1,
              createdAt: now,
            },
            {
              activityId: EventId.make("action-resume:available-run:process_lost:available"),
              threadId: recoveredThreadId,
              turnId: null,
              tone: "error",
              kind: ActionResume.ACTION_RESUME_ACTIVITY_KIND,
              summary: "Action interrupted when LastCode stopped: QA",
              payload: available,
              sequence: 2,
              createdAt: now,
            },
            {
              activityId: EventId.make("action-resume:settled-run:succeeded:disposed"),
              threadId: settledThreadId,
              turnId: null,
              tone: "info",
              kind: ActionResume.ACTION_RESUME_ACTIVITY_KIND,
              summary: "Action completed: QA",
              payload: settled,
              createdAt: now,
            },
            {
              activityId: EventId.make("action-resume:settled-run:succeeded:pending"),
              threadId: settledThreadId,
              turnId: null,
              tone: "info",
              kind: ActionResume.ACTION_RESUME_ACTIVITY_KIND,
              summary: "Action completed: QA",
              payload: { ...settled, delivery: "pending" },
              createdAt: now,
            },
          ]),
      }),
      Layer.mock(TerminalManager.TerminalManager)({
        open: () => Effect.die("unexpected terminal open"),
        write: () => Effect.die("unexpected terminal write"),
        history: () =>
          Effect.succeed("Persisted failure detail after both markers were unavailable."),
        close: () => Effect.void,
        subscribe: () => Effect.succeed(() => undefined),
      }),
      makeProviderRegistryLayer([
        {
          instanceId: providerInstanceId,
          driver: ProviderDriverKind.make("codex"),
        } as never,
      ]),
      ThreadActionResume.layer,
      Layer.mock(UpdateDrainAdmission)({
        admit: (_kind, effect) => effect,
      }),
      NodeServices.layer,
    );

    yield* Effect.scoped(
      Effect.gen(function* () {
        const service = yield* ActionResume.ActionResume;
        const registry = yield* ThreadActionResume.ThreadActionResumeService;
        assert.deepInclude(registry.getLatest(recoveredThreadId), {
          outcome: "process_lost",
          delivery: "available",
        });
        assert.deepInclude(registry.getLatest(settledThreadId), {
          outcome: "succeeded",
          delivery: "disposed",
        });
        assert.isNull(registry.getForShell(settledThreadId));
        yield* service.discardInterrupted(recoveredThreadId);
        assert.deepInclude(registry.getLatest(recoveredThreadId), { delivery: "disposed" });
        registry.record(available);
        failTurnStart = true;
        const resumeError = yield* service.resumeInterrupted(recoveredThreadId).pipe(Effect.flip);
        assert.equal(resumeError.reason, "internal_error");
        assert.deepInclude(registry.getLatest(recoveredThreadId), { delivery: "available" });
        failTurnStart = false;
        yield* service.cancelByArchive(recoveredThreadId);
        assert.deepInclude(registry.getLatest(recoveredThreadId), { delivery: "disposed" });

        const interrupted = yield* Deferred.await(reconciled);
        assert.equal(interrupted.outcome, "process_lost");
        assert.equal(interrupted.delivery, "available");
        assert.equal(
          dispatched.filter((command) => command.type === "thread.turn.start").length,
          0,
        );

        yield* service.resumeInterrupted(threadId);

        const turnStarts = dispatched.filter(
          (command): command is Extract<OrchestrationCommand, { type: "thread.turn.start" }> =>
            command.type === "thread.turn.start",
        );
        assert.equal(turnStarts.length, 1);
        assert.equal(turnStarts[0]?.message.role, "system");
        assert.match(turnStarts[0]?.message.text ?? "", /was interrupted because LastCode stopped/);
        assert.match(
          turnStarts[0]?.message.text ?? "",
          /Persisted failure detail after both markers were unavailable/,
        );
      }),
    ).pipe(Effect.provide(ActionResume.layer.pipe(Layer.provideMerge(dependencies))));
  }),
);
