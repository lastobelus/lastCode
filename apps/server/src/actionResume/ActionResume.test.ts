import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
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

import { ProjectionThreadActivityRepository } from "../persistence/Services/ProjectionThreadActivities.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadActionResume from "../orchestration/ThreadActionResume.ts";
import { makeProviderRegistryLayer } from "../provider/testUtils/providerRegistryMock.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ActionResume from "./ActionResume.ts";

const threadId = ThreadId.make("thread-action-resume");
const projectId = ProjectId.make("project-action-resume");
const providerInstanceId = ProviderInstanceId.make("codex");
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
    ActionResume.actionCommandForShell("vp test run", "powershell"),
    "vp test run\nif ($?) { exit 0 }\nif ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }\nexit 1\n",
  );
  assert.equal(
    ActionResume.actionCommandForShell("vp test run", "cmd"),
    "vp test run\nexit /b %errorlevel%\n",
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
  let terminalListener: ((event: TerminalEvent) => Effect.Effect<void>) | undefined;

  const dependencies = Layer.mergeAll(
    Layer.mock(OrchestrationEngineService)({
      dispatch: (command) =>
        Effect.sync(() => {
          dispatched.push(command);
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
    }),
    Layer.mock(TerminalManager.TerminalManager)({
      open: (input) =>
        Effect.sync(() => {
          opened.push(input);
          return { shellFamily: "posix" } as TerminalManager.OpenTerminalSessionSnapshot;
        }),
      write: (input) =>
        Effect.sync(() => {
          written.push(input);
        }),
      close: () => Effect.void,
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
    ]),
    ThreadActionResume.layer,
    NodeServices.layer,
  );

  return Effect.gen(function* () {
    const service = yield* ActionResume.ActionResume;
    const listed = yield* service.listProjectActions({ threadId, providerInstanceId });
    assert.deepEqual(
      listed.map(({ id, resumeEligible }) => ({ id, resumeEligible })),
      [
        { id: "qa", resumeEligible: true },
        { id: "manual-only", resumeEligible: false },
      ],
    );

    const running = yield* service.runProjectActionAndResume(
      { threadId, providerInstanceId },
      "qa",
    );
    assert.equal(running.outcome, "running");
    assert.equal(opened.length, 1);
    assert.equal(written.length, 1);
    assert.match(written[0]?.data ?? "", /vp test run/);
    assert.match(written[0]?.data ?? "", /exit \$__t3_action_status/);

    assert.isDefined(terminalListener);
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
    assert.equal(turnStarts[0]?.runtimeMode, thread.runtimeMode);
    assert.equal(turnStarts[0]?.interactionMode, thread.interactionMode);

    const registry = yield* ThreadActionResume.ThreadActionResumeService;
    assert.deepInclude(registry.getLatest(threadId), {
      outcome: "succeeded",
      delivery: "delivered",
    });
  }).pipe(Effect.provide(ActionResume.layer.pipe(Layer.provideMerge(dependencies))), Effect.scoped);
});

it.effect("requires an explicit resume after a running Action is found on startup", () =>
  Effect.gen(function* () {
    const reconciled = yield* Deferred.make<ActionResumeState>();
    const dispatched: OrchestrationCommand[] = [];
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

    const dependencies = Layer.mergeAll(
      Layer.mock(OrchestrationEngineService)({
        dispatch: (command) =>
          Effect.gen(function* () {
            dispatched.push(command);
            if (
              command.type === "thread.activity.append" &&
              command.activity.payload !== null &&
              typeof command.activity.payload === "object" &&
              "outcome" in command.activity.payload &&
              command.activity.payload.outcome === "process_lost"
            ) {
              yield* Deferred.succeed(reconciled, command.activity.payload as ActionResumeState);
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
          ]),
      }),
      Layer.mock(TerminalManager.TerminalManager)({
        open: () => Effect.die("unexpected terminal open"),
        write: () => Effect.die("unexpected terminal write"),
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
      NodeServices.layer,
    );

    yield* Effect.scoped(
      Effect.gen(function* () {
        const service = yield* ActionResume.ActionResume;
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
      }),
    ).pipe(Effect.provide(ActionResume.layer.pipe(Layer.provideMerge(dependencies))));
  }),
);
