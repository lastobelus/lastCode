import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type ActionResumeState,
  CommandId,
  MessageId,
  NodeId,
  type OrchestrationProjectShell,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  EventId,
  EnvironmentId,
  UpdateDrainRequestId,
  UpdateDrainTargetVersion,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
  type TerminalEvent,
  type TerminalOpenInput,
  type TerminalWriteInput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as PubSub from "effect/PubSub";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  ACTION_EVENT_TOKEN_ENV,
  ACTION_RUN_ID_ENV,
  actionProtocolFrame,
} from "@t3tools/shared/actionResumeProtocol";
import { parseActionResumeFollowUp } from "@t3tools/shared/actionResume";

import * as CommandReceipts from "../orchestration-v2/CommandReceiptStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as UpdateDrain from "../updateDrain/UpdateDrain.ts";
import * as UpdateDrainAdmission from "../updateDrain/UpdateDrainAdmission.ts";
import * as ServerActivation from "../serverActivation.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { ActionResumeToolkitHandlersLive } from "../mcp/toolkits/actionResume/handlers.ts";
import { ActionResumeToolkit } from "../mcp/toolkits/actionResume/tools.ts";
import { makeProviderRegistryLayer } from "../provider/testUtils/providerRegistryMock.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ActionResume from "./ActionResume.ts";
import actionRunMigration from "./ActionRunMigration.ts";
import * as ActionRunStore from "./ActionRunStore.ts";

const threadId = ThreadId.make("thread-action-resume");
const projectId = ProjectId.make("project-action-resume");
const providerInstanceId = ProviderInstanceId.make("codex");
const invocation = { threadId, providerInstanceId };
const now = DateTime.makeUnsafe("2026-08-17T00:00:00.000Z");
const nowIso = DateTime.formatIso(now);
const thread: OrchestrationV2AppThread = {
  createdBy: "user",
  creationSource: "web",
  id: threadId,
  projectId,
  title: "Action resume thread",
  providerInstanceId,
  modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
  runtimeMode: "approval-required",
  interactionMode: "plan",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
};
const shell: OrchestrationV2ThreadShell = {
  ...thread,
  latestRunId: null,
  activeRunId: null,
  status: "idle",
  pendingRuntimeRequest: null,
  latestVisibleMessage: null,
  latestUserMessageAt: null,
  hasActionableProposedPlan: false,
  pendingBackgroundTasks: [],
  providerInstanceHistory: [],
  itemCount: 0,
  visibleItemCount: 0,
};
const project: OrchestrationProjectShell = {
  id: projectId,
  title: "Action resume project",
  workspaceRoot: "/workspace/action-project",
  repositoryIdentity: null,
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  faviconPath: null,
  projectIcon: null,
  scripts: [
    {
      id: "qa",
      name: "QA",
      command: "printf ready",
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
  createdAt: nowIso,
  updatedAt: nowIso,
};
const retained = (
  runId: string,
  overrides: Partial<ActionResumeState> = {},
): ActionResumeState => ({
  runId,
  threadId,
  projectId,
  actionId: "qa",
  actionName: "QA",
  command: "printf ready",
  terminalId: `action-${runId}`,
  outcome: "running",
  delivery: "armed",
  startedAt: nowIso,
  finishedAt: null,
  exitCode: null,
  exitSignal: null,
  revision: 0,
  ...overrides,
});

const databaseLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE orchestration_command_receipts (
    command_id TEXT PRIMARY KEY, aggregate_kind TEXT NOT NULL, aggregate_id TEXT NOT NULL,
    command_type TEXT NOT NULL, accepted_at TEXT NOT NULL, result_sequence INTEGER NOT NULL,
    status TEXT NOT NULL, error TEXT
  )`;
    yield* actionRunMigration;
  }),
).pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })));
const StoreTestLayer = Layer.mergeAll(ActionRunStore.layer, CommandReceipts.layer).pipe(
  Layer.provideMerge(databaseLayer),
  Layer.provide(NodeServices.layer),
);

const makeHarness = Effect.gen(function* () {
  const store = yield* ActionRunStore.ActionRunStore;
  const receipts = yield* CommandReceipts.CommandReceiptStoreV2;
  const commands: OrchestrationV2ServerCommand[] = [];
  const events = yield* PubSub.unbounded<OrchestrationV2DomainEvent>();
  const delivered = yield* Deferred.make<void>();
  const subscribed = yield* Deferred.make<void>();
  const terminalClosed = yield* Deferred.make<void>();
  const opened: TerminalOpenInput[] = [];
  const written: TerminalWriteInput[] = [];
  const closed: string[] = [];
  let listener: ((event: TerminalEvent) => Effect.Effect<void>) | undefined;
  const state = {
    busy: false,
    missingShell: false,
    deleted: false,
    drainClosed: false,
    metadataReceipt: null as Deferred.Deferred<void> | null,
    launchResolved: null as Deferred.Deferred<void> | null,
    pauseDelivery: null as {
      entered: Deferred.Deferred<void>;
      release: Deferred.Deferred<void>;
    } | null,
    request: null as OrchestrationV2RuntimeRequest["kind"] | null,
    archived: false,
    failWrite: false,
    failDelivery: false,
    missingHistory: false,
    alreadyDelivered: false,
    latest: null as ActionResumeState | null,
  };
  const appThread = () => ({
    ...thread,
    archivedAt: state.archived ? now : null,
    actionResume: state.latest,
    deletedAt: state.deleted ? now : null,
  });
  const projection = (): OrchestrationV2ThreadProjection => ({
    thread: appThread(),
    runs: state.busy ? [{ status: "running" } as OrchestrationV2Run] : [],
    runtimeRequests:
      state.request === null
        ? []
        : [
            {
              id: RuntimeRequestId.make("request:action"),
              nodeId: NodeId.make("node:action"),
              providerTurnId: null,
              nativeRequestRef: null,
              kind: state.request,
              status: "pending",
              responseCapability: { type: "message" },
              createdAt: now,
              resolvedAt: null,
            },
          ],
    messages: state.alreadyDelivered
      ? [
          {
            id: MessageId.make(`action-resume:${state.latest?.runId}:follow-up`),
          } as OrchestrationV2ConversationMessage,
        ]
      : [],
    attempts: [],
    nodes: [],
    providerThreads: [],
    providerTurns: [],
    turnItems: [],
    subagents: [],
    checkpoints: [],
    plans: [],
    providerSessions: [],
    checkpointScopes: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: now,
  });
  const admission = yield* UpdateDrainAdmission.makeUpdateDrainAdmission().pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(UpdateDrain.UpdateDrain)({
          status: Effect.suspend(() =>
            Effect.succeed({
              sequence: 0,
              intent: state.drainClosed
                ? {
                    requestId: UpdateDrainRequestId.make("update-action"),
                    targetVersion: UpdateDrainTargetVersion.make("1.0.0"),
                    status: "draining" as const,
                  }
                : null,
              admission: state.drainClosed ? ("closed" as const) : ("open" as const),
              blockers: [],
            }),
          ),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
        Layer.mock(TerminalManager.TerminalManager)({}),
      ),
    ),
  );
  const dependencies = Layer.mergeAll(
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: () =>
        Effect.succeed(state.missingShell ? null : { ...shell, ...appThread() }),
      ensureLegacyTranscript: () => Effect.void,
      getThreadRecords: () => Effect.succeed(projection()),
      dispatch: (command) => {
        const apply = Effect.gen(function* () {
          if (command.type === "message.dispatch" && state.failDelivery)
            return yield* new Orchestrator.OrchestratorDispatchError({
              commandId: command.commandId,
              commandType: command.type,
              cause: "delivery failed",
            });
          commands.push(command);
          if (command.type === "thread.metadata.update" && command.actionResume !== undefined) {
            if (state.deleted) return yield* Effect.die("deleted shell must not receive metadata");
            state.latest = command.actionResume;
            if (state.metadataReceipt !== null)
              yield* Deferred.succeed(state.metadataReceipt, undefined);
          }
          if (command.type === "message.dispatch")
            yield* receipts
              .upsert({
                commandId: command.commandId,
                threadId: command.threadId,
                commandType: command.type,
                acceptedAt: now,
                resultSequence: commands.length,
                status: "accepted",
                error: null,
              })
              .pipe(Effect.orDie);
          if (command.type === "message.dispatch") yield* Deferred.succeed(delivered, undefined);
          return { sequence: commands.length, storedEvents: [] };
        });
        if (command.type !== "message.dispatch") return apply;
        return Effect.gen(function* () {
          const pause = state.pauseDelivery;
          if (pause !== null) {
            yield* Deferred.succeed(pause.entered, undefined);
            yield* Deferred.await(pause.release);
          }
          return yield* admission.admit("thread-turn", apply).pipe(
            Effect.mapError(
              (cause) =>
                new Orchestrator.OrchestratorDispatchError({
                  commandId: command.commandId,
                  commandType: command.type,
                  cause,
                }),
            ),
          );
        });
      },
      streamDomainEvents: Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(events);
          yield* Deferred.succeed(subscribed, undefined);
          return Stream.fromSubscription(subscription);
        }),
      ),
    }),
    Layer.mock(ProjectStore.ProjectStoreV2)({
      getShell: () =>
        Effect.gen(function* () {
          if (state.launchResolved !== null)
            yield* Deferred.succeed(state.launchResolved, undefined);
          return Option.some(project);
        }),
    }),
    Layer.mock(TerminalManager.TerminalManager)({
      open: (input) =>
        Effect.sync(() => {
          opened.push(input);
          return {
            status: "running",
            shellFamily: "posix",
          } as TerminalManager.OpenTerminalSessionSnapshot;
        }),
      write: (input) =>
        state.failWrite
          ? Effect.die("write failed")
          : Effect.sync(() => {
              written.push(input);
            }),
      close: (input) =>
        Effect.sync(() => {
          closed.push(input.terminalId ?? "default");
        }).pipe(
          Effect.andThen(
            Effect.suspend(() =>
              (
                listener?.({
                  type: "closed",
                  threadId: input.threadId,
                  terminalId: input.terminalId ?? "default",
                  deleteHistory: input.deleteHistory ?? false,
                }) ?? Effect.void
              ).pipe(Effect.andThen(Deferred.succeed(terminalClosed, undefined))),
            ),
          ),
        ),
      history: () =>
        state.missingHistory
          ? Effect.die("deleted history")
          : Effect.succeed("retained terminal detail"),
      subscribe: (next) =>
        Effect.sync(() => {
          listener = next;
          return () => {
            listener = undefined;
          };
        }),
    }),
    makeProviderRegistryLayer([
      { instanceId: providerInstanceId, driver: ProviderDriverKind.make("codex") } as never,
      {
        instanceId: ProviderInstanceId.make("claude"),
        driver: ProviderDriverKind.make("claudeAgent"),
      } as never,
      {
        instanceId: ProviderInstanceId.make("opencode"),
        driver: ProviderDriverKind.make("opencode"),
      } as never,
    ]),
    ServerSettings.layerTest(),
    Layer.succeed(UpdateDrainAdmission.UpdateDrainAdmission, admission),
  );
  return {
    store,
    receipts,
    events,
    delivered,
    subscribed,
    terminalClosed,
    admission,
    commands,
    opened,
    written,
    closed,
    state,
    layer: ActionResume.layer.pipe(Layer.provide(dependencies), Layer.provide(NodeServices.layer)),
    emit: (event: TerminalEvent) =>
      Effect.suspend(() => listener?.(event) ?? Effect.die("not subscribed")),
    followUps: () => commands.filter((command) => command.type === "message.dispatch"),
  };
});

it("propagates shell command exit status", () => {
  assert.include(
    ActionResume.actionCommandForShell("false", "posix", "run-1"),
    "exit $__t3_action_status",
  );
  assert.include(
    ActionResume.actionCommandForShell("false", "cmd", "run-1"),
    "exit /b %errorlevel%",
  );
  assert.include(
    ActionResume.actionCommandForShell("false", "powershell", "run-1"),
    "exit $LASTEXITCODE",
  );
});

it.effect("runs an opted-in process, retains progress/output, and dispatches one V2 result", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness;
    yield* Effect.gen(function* () {
      const actions = yield* ActionResume.ActionResume;
      assert.equal(
        (yield* actions.listProjectActions(invocation)).find(
          (action) => action.id === "manual-only",
        )?.resumeEligible,
        false,
      );
      assert.equal(
        (yield* Effect.result(actions.runProjectActionAndResume(invocation, "manual-only")))._tag,
        "Failure",
      );
      const run = yield* actions.runProjectActionAndResume(invocation, "qa");
      assert.equal(h.opened[0]?.cwd, project.workspaceRoot);
      assert.equal(h.opened[0]?.env?.[ACTION_RUN_ID_ENV], run.runId);
      assert.equal(run.command, "printf ready");
      assert.equal(
        (yield* Effect.result(actions.runProjectActionAndResume(invocation, "qa")))._tag,
        "Failure",
      );
      const token = h.opened[0]?.env?.[ACTION_EVENT_TOKEN_ENV];
      assert.isString(token);
      yield* h.emit({
        type: "output",
        threadId,
        terminalId: run.terminalId,
        data:
          ActionResume.actionOutputMarker(run.runId, "start") +
          "useful result\n" +
          actionProtocolFrame({
            runId: run.runId,
            token: token!,
            event: {
              kind: "progress",
              progress: { version: 1, state: "working", summary: "Checking" },
            },
          }) +
          actionProtocolFrame({
            runId: run.runId,
            token: token!,
            event: { kind: "result", report: { version: 1, outcome: "success", summary: "Ready" } },
          }) +
          ActionResume.actionOutputMarker(run.runId, "end"),
      });
      assert.equal(h.state.latest?.progress?.summary, "Checking");
      yield* h.emit({
        type: "exited",
        threadId,
        terminalId: run.terminalId,
        exitCode: 0,
        exitSignal: null,
      });
      yield* h.emit({
        type: "exited",
        threadId,
        terminalId: run.terminalId,
        exitCode: 0,
        exitSignal: null,
      });
      yield* actions.retryPendingFollowUps;
      assert.equal(h.followUps().length, 1);
      const followUp = h.followUps()[0]!;
      assert.equal(followUp.createdBy, "system");
      assert.equal(followUp.messageId, `action-resume:${run.runId}:follow-up`);
      assert.equal(parseActionResumeFollowUp(followUp.text)?.report?.summary, "Ready");
      h.state.missingHistory = true;
      const inspected = yield* actions.inspectActionRun(invocation, run.runId);
      assert.equal(inspected.outputTail, "useful result\n");
      assert.equal(h.state.latest?.delivery, "delivered");
      assert.equal(
        (yield* Effect.result(
          actions.inspectActionRun(
            { ...invocation, threadId: ThreadId.make("other-thread") },
            run.runId,
          ),
        ))._tag,
        "Failure",
      );
      assert.equal(yield* actions.countRunning, 0);
    }).pipe(Effect.provide(h.layer));
  }).pipe(Effect.provide(StoreTestLayer)),
);

it.effect.each(["command", "user_input"] as const)(
  "holds completion while a %s request needs a response",
  (request) =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* Effect.gen(function* () {
        const actions = yield* ActionResume.ActionResume;
        const run = yield* actions.runProjectActionAndResume(invocation, "qa");
        h.state.request = request;
        yield* h.emit({
          type: "exited",
          threadId,
          terminalId: run.terminalId,
          exitCode: 1,
          exitSignal: null,
        });
        yield* actions.retryPendingFollowUps;
        assert.equal(h.followUps().length, 0);
        assert.equal(h.state.latest?.delivery, "pending");
        h.state.request = null;
        yield* actions.retryPendingFollowUps;
        assert.equal(h.followUps().length, 1);
        assert.equal(parseActionResumeFollowUp(h.followUps()[0]!.text)?.lifecycleOutcome, "failed");
      }).pipe(Effect.provide(h.layer));
    }).pipe(Effect.provide(StoreTestLayer)),
);

it.effect(
  "cancels the exact process while busy, ignores late exit, and disposes archive results",
  () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* Effect.gen(function* () {
        const actions = yield* ActionResume.ActionResume;
        const run = yield* actions.runProjectActionAndResume(invocation, "qa");
        h.state.busy = true;
        yield* actions.cancelByUser(threadId);
        yield* h.emit({
          type: "exited",
          threadId,
          terminalId: run.terminalId,
          exitCode: 0,
          exitSignal: null,
        });
        assert.include(h.closed, run.terminalId);
        assert.equal(h.state.latest?.outcome, "cancelled_by_user");
        assert.equal(h.followUps().length, 0);
        h.state.busy = false;
        yield* actions.retryPendingFollowUps;
        assert.equal(h.followUps().length, 1);
        const replacement = yield* actions.runProjectActionAndResume(invocation, "qa");
        yield* h.emit({
          type: "output",
          threadId,
          terminalId: replacement.terminalId,
          data: ActionResume.actionOutputMarker(replacement.runId, "start") + "archived output",
        });
        h.state.archived = true;
        yield* actions.cancelByArchive(threadId);
        assert.include(h.closed, replacement.terminalId);
        assert.equal(h.state.latest?.delivery, "disposed");
        assert.equal(
          (yield* actions.inspectActionRun(invocation, replacement.runId)).outputTail,
          "archived output",
        );
        yield* actions.retryPendingFollowUps;
        assert.equal(h.followUps().length, 1);
      }).pipe(Effect.provide(h.layer));
    }).pipe(Effect.provide(StoreTestLayer)),
);

it.effect("recovers running and pending states only after explicit resume", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness;
    yield* h.store.save(retained("lost"), "saved output");
    h.state.metadataReceipt = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const actions = yield* ActionResume.ActionResume;
      yield* Deferred.await(h.state.metadataReceipt!);
      assert.equal(h.state.latest?.outcome, "process_lost");
      assert.equal(h.state.latest?.delivery, "available");
      assert.equal(h.followUps().length, 0);
      assert.equal(h.opened.length, 0);
      h.state.busy = true;
      assert.equal((yield* Effect.result(actions.resumeInterrupted(threadId)))._tag, "Failure");
      assert.equal(h.state.latest?.delivery, "available");
      h.state.busy = false;
      yield* actions.resumeInterrupted(threadId);
      assert.equal(h.followUps().length, 1);
      assert.equal(
        (yield* actions.inspectActionRun(invocation, "lost")).outputTail,
        "saved output",
      );
    }).pipe(Effect.provide(h.layer));
    h.state.metadataReceipt = yield* Deferred.make<void>();
    yield* h.store.save(
      retained("pending", {
        outcome: "succeeded",
        delivery: "pending",
        startedAt: "2026-08-18T00:00:00.000Z",
      }),
    );
    yield* Effect.gen(function* () {
      const actions = yield* ActionResume.ActionResume;
      yield* Deferred.await(h.state.metadataReceipt!);
      assert.equal(h.state.latest?.runId, "pending");
      assert.equal(h.state.latest?.delivery, "available");
      yield* actions.discardInterrupted(threadId);
      assert.equal(h.state.latest?.delivery, "disposed");
      assert.equal(h.followUps().length, 1);
    }).pipe(Effect.provide(Layer.fresh(h.layer)));
  }).pipe(Effect.provide(StoreTestLayer)),
);

it.effect.each(["running", "pending"] as const)(
  "projects %s recovery after first-upgrade shell import and activation",
  (status) =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      const activation = yield* Deferred.make<void>();
      const metadataReceipt = yield* Deferred.make<void>();
      h.state.missingShell = true;
      h.state.metadataReceipt = metadataReceipt;
      const run = retained(
        `upgrade-${status}`,
        status === "pending" ? { outcome: "succeeded", delivery: "pending" } : {},
      );
      yield* h.store.save(run, "first-upgrade output");
      const layer = h.layer.pipe(
        Layer.provide(Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation))),
      );
      yield* Effect.gen(function* () {
        const actions = yield* ActionResume.ActionResume;
        yield* Deferred.await(h.subscribed);
        assert.equal(h.commands.length, 0);
        assert.equal(
          Option.getOrThrow(yield* h.store.get(threadId, run.runId)).state.delivery,
          run.delivery,
        );
        // Startup imports this shell before releasing any parked service.
        h.state.missingShell = false;
        yield* PubSub.publish(h.events, {
          id: EventId.make(`event:upgrade-${status}`),
          threadId,
          type: "thread.created",
          occurredAt: now,
          payload: thread,
        });
        yield* Deferred.succeed(activation, undefined);
        yield* Deferred.await(metadataReceipt);
        assert.equal(h.state.latest?.runId, run.runId);
        assert.equal(h.state.latest?.delivery, "available");
        assert.equal(h.state.latest?.outcome, status === "running" ? "process_lost" : "succeeded");
        assert.equal(
          (yield* actions.inspectActionRun(invocation, run.runId)).outputTail,
          "first-upgrade output",
        );
        assert.equal(h.followUps().length, 0);
        assert.equal(h.opened.length, 0);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(StoreTestLayer)),
);

it.effect("does not dispose hydrated history when startup is cancelled before activation", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness;
    const activation = yield* Deferred.make<void>();
    const run = retained("parked-history");
    yield* h.store.save(run, "previous process output");
    yield* ActionResume.ActionResume.pipe(
      Effect.asVoid,
      Effect.provide(
        h.layer.pipe(
          Layer.provide(
            Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
          ),
        ),
      ),
    );
    const saved = Option.getOrThrow(yield* h.store.get(threadId, run.runId));
    assert.equal(saved.state.outcome, "running");
    assert.equal(saved.state.delivery, "armed");
    assert.equal(saved.outputTail, "previous process output");
    assert.equal(h.commands.length, 0);
    assert.equal(h.closed.length, 0);
  }).pipe(Effect.provide(StoreTestLayer)),
);

it.effect("orders MCP launch after completion ownership before acquiring shared admission", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness;
    yield* Effect.gen(function* () {
      const actions = yield* ActionResume.ActionResume;
      const toolkit = yield* ActionResumeToolkit.pipe(
        Effect.provide(ActionResumeToolkitHandlersLive),
      );
      const run = yield* actions.runProjectActionAndResume(invocation, "qa");
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      h.state.pauseDelivery = { entered, release };
      const completion = yield* h
        .emit({
          type: "exited",
          threadId,
          terminalId: run.terminalId,
          exitCode: 0,
          exitSignal: null,
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const launchResolved = yield* Deferred.make<void>();
      h.state.launchResolved = launchResolved;
      const launch = yield* toolkit
        .handle("run_project_action_and_resume", { actionId: "qa" })
        .pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.provideService(McpInvocationContext.McpInvocationContext, {
            environmentId: EnvironmentId.make("environment-action"),
            thread: {
              threadId,
              providerSessionId: "session-action",
              providerInstanceId,
            },
            client: undefined,
            requestNamespace: "thread:action",
            capabilities: new Set(["action-resume"] as const),
            issuedAt: 0,
          }),
          Effect.forkChild,
        );
      yield* Deferred.await(launchResolved);
      // The MCP launch is waiting for the Action mutex; it must not own admission.
      yield* h.admission.admit("thread-turn", Effect.void);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(completion);
      const result = yield* Fiber.join(launch);
      assert.equal(h.followUps().length, 1);
      assert.equal(h.opened.length, 2);
      assert.equal(result.at(-1)?.isFailure, false);
      assert.equal(h.state.latest?.outcome, "running");
      assert.notEqual(h.state.latest?.runId, run.runId);
    }).pipe(Effect.provide(h.layer));
  }).pipe(Effect.provide(StoreTestLayer)),
);

it.effect("rejects native process launch during update drain without opening a terminal", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness;
    h.state.drainClosed = true;
    yield* Effect.gen(function* () {
      const actions = yield* ActionResume.ActionResume;
      const result = yield* Effect.result(actions.runProjectActionAndResume(invocation, "qa"));
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure.reason, "internal_error");
        assert.include(result.failure.message, "draining for update 1.0.0");
      }
      assert.equal(h.opened.length, 0);
      assert.equal(h.commands.length, 0);
    }).pipe(Effect.provide(h.layer));
  }).pipe(Effect.provide(StoreTestLayer)),
);

it.effect("rejects MCP Action launch during update drain without opening a terminal", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness;
    h.state.drainClosed = true;
    yield* Effect.gen(function* () {
      const toolkit = yield* ActionResumeToolkit.pipe(
        Effect.provide(ActionResumeToolkitHandlersLive),
      );
      const result = yield* toolkit
        .handle("run_project_action_and_resume", { actionId: "qa" })
        .pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.provideService(McpInvocationContext.McpInvocationContext, {
            environmentId: EnvironmentId.make("environment-action"),
            thread: {
              threadId,
              providerSessionId: "session-action",
              providerInstanceId,
            },
            client: undefined,
            requestNamespace: "thread:action",
            capabilities: new Set(["action-resume"] as const),
            issuedAt: 0,
          }),
          Effect.result,
        );
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.include(String(result.failure), "draining for update 1.0.0");
      }
      assert.equal(h.opened.length, 0);
      assert.equal(h.commands.length, 0);
    }).pipe(Effect.provide(h.layer));
  }).pipe(Effect.provide(StoreTestLayer)),
);

it.effect.each(["running", "completed"] as const)(
  "preserves %s process history and captured output when its thread is deleted",
  (status) =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* Effect.gen(function* () {
        const actions = yield* ActionResume.ActionResume;
        const run = yield* actions.runProjectActionAndResume(invocation, "qa");
        yield* h.emit({
          type: "output",
          threadId,
          terminalId: run.terminalId,
          data:
            ActionResume.actionOutputMarker(run.runId, "start") + "retained deleted-thread output",
        });
        if (status === "completed")
          yield* h.emit({
            type: "exited",
            threadId,
            terminalId: run.terminalId,
            exitCode: 0,
            exitSignal: null,
          });
        h.state.deleted = true;
        yield* Deferred.await(h.subscribed);
        yield* PubSub.publish(h.events, {
          id: EventId.make(`event:delete-${status}`),
          threadId,
          type: "thread.deleted",
          occurredAt: now,
          payload: { ...thread, deletedAt: now },
        });
        yield* Deferred.await(h.terminalClosed);
        const inspected = yield* actions.inspectActionRun(invocation, run.runId);
        const saved = Option.getOrThrow(yield* h.store.get(threadId, run.runId));
        assert.equal(inspected.outputTail, "retained deleted-thread output");
        assert.equal(
          inspected.lifecycleOutcome,
          status === "running" ? "cancelled_by_archive" : "succeeded",
        );
        assert.equal(saved.state.delivery, status === "running" ? "disposed" : "delivered");
        assert.equal(yield* actions.countRunning, 0);
        assert.equal(h.followUps().length, status === "running" ? 0 : 1);
        assert.include(h.closed, run.terminalId);
        yield* h.emit({
          type: "exited",
          threadId,
          terminalId: run.terminalId,
          exitCode: 0,
          exitSignal: null,
        });
        assert.equal(
          (yield* actions.inspectActionRun(invocation, run.runId)).lifecycleOutcome,
          inspected.lifecycleOutcome,
        );
      }).pipe(Effect.provide(h.layer));
    }).pipe(Effect.provide(StoreTestLayer)),
);

it.effect(
  "reconciles an accepted delivery receipt after a crash without creating a second run",
  () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      h.state.metadataReceipt = yield* Deferred.make<void>();
      const run = retained("accepted", { outcome: "succeeded", delivery: "pending" });
      yield* h.store.save(run, "result already sent");
      yield* h.receipts.upsert({
        commandId: CommandId.make(`server:action-resume:${run.runId}:delivery`),
        threadId,
        commandType: "message.dispatch",
        acceptedAt: now,
        resultSequence: 9,
        status: "accepted",
        error: null,
      });
      yield* Effect.gen(function* () {
        const actions = yield* ActionResume.ActionResume;
        yield* Deferred.await(h.state.metadataReceipt!);
        assert.equal(h.state.latest?.delivery, "delivered");
        yield* actions.retryPendingFollowUps;
        assert.equal(h.followUps().length, 0);
        assert.equal((yield* Effect.result(actions.resumeInterrupted(threadId)))._tag, "Failure");
      }).pipe(Effect.provide(h.layer));
    }).pipe(Effect.provide(StoreTestLayer)),
);

it.effect(
  "reconciles a cutover transcript result without native receipt and retains output after failure",
  () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      h.state.metadataReceipt = yield* Deferred.make<void>();
      yield* h.store.save(retained("cutover", { outcome: "succeeded", delivery: "pending" }));
      h.state.latest = retained("cutover");
      h.state.alreadyDelivered = true;
      yield* Effect.gen(function* () {
        const actions = yield* ActionResume.ActionResume;
        yield* Deferred.await(h.state.metadataReceipt!);
        assert.equal(h.state.latest?.delivery, "delivered");
        yield* actions.retryPendingFollowUps;
        assert.equal(h.followUps().length, 0);
        h.state.alreadyDelivered = false;
        h.state.failWrite = true;
        assert.equal(
          (yield* Effect.result(actions.runProjectActionAndResume(invocation, "qa")))._tag,
          "Failure",
        );
        assert.equal(h.state.latest?.outcome, "failed");
        assert.equal(h.state.latest?.delivery, "disposed");
        assert.equal(h.opened.length, 1);
        assert.equal(h.closed.length, 1);
      }).pipe(Effect.provide(h.layer));
    }).pipe(Effect.provide(StoreTestLayer)),
);

it.effect(
  "automatically wakes on a V2 admission transition and retains shutdown cancellation",
  () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      let running: ActionResumeState | undefined;
      yield* Effect.gen(function* () {
        const actions = yield* ActionResume.ActionResume;
        const run = yield* actions.runProjectActionAndResume(invocation, "qa");
        h.state.busy = true;
        yield* h.emit({
          type: "exited",
          threadId,
          terminalId: run.terminalId,
          exitCode: 0,
          exitSignal: null,
        });
        assert.equal(h.followUps().length, 0);
        h.state.busy = false;
        yield* Deferred.await(h.subscribed);
        yield* PubSub.publish(h.events, {
          id: EventId.make("event:action-thread-idle"),
          threadId,
          type: "thread.unsettled",
          occurredAt: now,
          payload: thread,
        });
        yield* Deferred.await(h.delivered);
        assert.equal(h.followUps().length, 1);
        yield* actions.retryPendingFollowUps;
        running = yield* actions.runProjectActionAndResume(invocation, "qa");
        yield* h.emit({
          type: "output",
          threadId,
          terminalId: running.terminalId,
          data: ActionResume.actionOutputMarker(running.runId, "start") + "interrupted output",
        });
      }).pipe(Effect.provide(h.layer));
      assert.isDefined(running);
      const shutdown = Option.getOrThrow(yield* h.store.get(threadId, running!.runId));
      assert.equal(shutdown.state.outcome, "cancelled_by_shutdown");
      assert.equal(shutdown.state.delivery, "disposed");
      assert.equal(shutdown.outputTail, "interrupted output");
      assert.include(h.closed, running!.terminalId);
    }).pipe(Effect.provide(StoreTestLayer)),
);

it.effect(
  "keeps a failed delivery pending with its retained result and retries one exact message",
  () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* Effect.gen(function* () {
        const actions = yield* ActionResume.ActionResume;
        const run = yield* actions.runProjectActionAndResume(invocation, "qa");
        h.state.failDelivery = true;
        yield* h.emit({
          type: "output",
          threadId,
          terminalId: run.terminalId,
          data:
            ActionResume.actionOutputMarker(run.runId, "start") +
            "saved after failure" +
            ActionResume.actionOutputMarker(run.runId, "end"),
        });
        yield* h.emit({
          type: "exited",
          threadId,
          terminalId: run.terminalId,
          exitCode: 0,
          exitSignal: null,
        });
        assert.equal(h.state.latest?.delivery, "pending");
        assert.equal(h.followUps().length, 0);
        h.state.missingHistory = true;
        assert.equal(
          (yield* actions.inspectActionRun(invocation, run.runId)).outputTail,
          "saved after failure",
        );
        h.state.failDelivery = false;
        yield* actions.retryPendingFollowUps;
        yield* actions.retryPendingFollowUps;
        assert.equal(h.followUps().length, 1);
        assert.equal(h.followUps()[0]?.messageId, `action-resume:${run.runId}:follow-up`);
      }).pipe(Effect.provide(h.layer));
    }).pipe(Effect.provide(StoreTestLayer)),
);
