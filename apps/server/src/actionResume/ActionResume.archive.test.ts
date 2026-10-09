import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
  type OrchestrationProjectShell,
  type ServerProvider,
  type TerminalEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as UpdateDrainAdmission from "../updateDrain/UpdateDrainAdmission.testkit.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as CommandReceipts from "../orchestration-v2/CommandReceiptStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ActionRunStore from "./ActionRunStore.ts";
import * as ActionResume from "./ActionResume.ts";

const threadId = ThreadId.make("action-archive:thread");
const childId = ThreadId.make("action-archive:child");
const projectId = ProjectId.make("action-archive:project");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "example-model" };
const archiveId = CommandId.make("action-archive:stop");
const provider = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-01T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
} satisfies ServerProvider;
const project = {
  id: projectId,
  title: "Action archive",
  workspaceRoot: "/workspace/action-archive",
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
  ],
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
} satisfies OrchestrationProjectShell;

const makeHarness = Effect.fn("ActionArchiveTest.makeHarness")(function* (
  raceDelivery: boolean,
  raceLaunch = false,
) {
  const database = SqlitePersistence.layerMemory;
  const replay = ProviderReplayHarness.layerWithRegistry(
    { name: "action-archive" },
    ProviderAdapterRegistry.layerFromAdapters([
      {
        instanceId,
        driver: provider.driver,
        getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
        openSession: () => Effect.die("Provider turns are disabled in Action archive tests"),
      },
    ]),
    { databaseLayer: database, runEffectWorker: false },
  );
  const threads = ThreadManagement.layer.pipe(Layer.provide(replay));
  const receipts = CommandReceipts.layer.pipe(Layer.provide(database));
  const runs = ActionRunStore.layer.pipe(Layer.provide(database));
  const attempted = yield* Deferred.make<void>();
  let raced = false;
  let archiveAtOpen: Effect.Effect<void> = Effect.void;
  const actionThreads = Layer.effect(
    ThreadManagement.ThreadManagementService,
    Effect.gen(function* () {
      const delegate = yield* ThreadManagement.ThreadManagementService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      if (raceLaunch)
        archiveAtOpen = orchestrator
          .dispatch({
            type: "thread.archive",
            threadId,
            commandId: archiveId,
            childDisposition: "stop_and_archive",
            expectedChildThreadIds: [childId],
          })
          .pipe(Effect.asVoid, Effect.orDie);
      return ThreadManagement.ThreadManagementService.of({
        ...delegate,
        dispatch: (command) =>
          Effect.gen(function* () {
            if (raceDelivery && !raced && command.type === "message.dispatch") {
              raced = true;
              // The eligibility read passed; archive wins the authoritative dispatch lock.
              yield* orchestrator.dispatch({
                type: "thread.archive",
                threadId,
                commandId: archiveId,
                childDisposition: "stop_and_archive",
                expectedChildThreadIds: [childId],
              });
            }
            return yield* delegate
              .dispatch(command)
              .pipe(
                Effect.ensuring(
                  command.type === "message.dispatch"
                    ? Deferred.succeed(attempted, undefined)
                    : Effect.void,
                ),
              );
          }),
      });
    }),
  ).pipe(Layer.provide(Layer.merge(threads, replay)));
  let listener: ((event: TerminalEvent) => Effect.Effect<void>) | undefined;
  let terminalWrites = 0;
  let terminalCloses = 0;
  const terminal = Layer.mock(TerminalManager.TerminalManager)({
    subscribe: (next) =>
      Effect.sync(() => {
        listener = next;
        return () => {
          listener = undefined;
        };
      }),
    open: () =>
      Effect.suspend(() => archiveAtOpen).pipe(
        Effect.andThen(
          Effect.succeed({
            status: "running",
            shellFamily: "posix",
          } as TerminalManager.OpenTerminalSessionSnapshot),
        ),
      ),
    write: () =>
      Effect.sync(() => {
        terminalWrites += 1;
      }),
    close: () =>
      Effect.sync(() => {
        terminalCloses += 1;
      }),
    history: () => Effect.succeed("retained Action output"),
  });
  const actions = ActionResume.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        actionThreads,
        receipts,
        runs,
        terminal,
        ServerSettings.layerTest(),
        ProviderRegistryMock.layer([provider]),
        UpdateDrainAdmission.layerOpen,
        Layer.mock(ProjectStore.ProjectStoreV2)({
          getShell: () => Effect.succeed(Option.some(project)),
        }),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );
  return {
    layer: Layer.mergeAll(replay, threads, receipts, runs, actions),
    attempted,
    terminalWrites: () => terminalWrites,
    terminalCloses: () => terminalCloses,
    emit: (event: TerminalEvent) =>
      Effect.suspend(() => listener?.(event) ?? Effect.die("Action terminal is not subscribed")),
  };
});

it.effect.each([false, true])(
  "refuses a new Action and closes its unused terminal during archive stopping (launch race: %s)",
  (raceLaunch) =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(false, raceLaunch);
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const actions = yield* ActionResume.ActionResume;
        const runs = yield* ActionRunStore.ActionRunStore;
        yield* threads.dispatch({
          type: "thread.create",
          commandId: CommandId.make("action-archive:create"),
          threadId,
          projectId,
          title: "Action archive",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        yield* threads.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("action-archive:busy"),
          threadId,
          messageId: MessageId.make("action-archive:busy"),
          text: "Keep this turn prepared",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "defer_start" },
          createdBy: "user",
          creationSource: "web",
        });
        const sink = yield* EventSink.EventSinkV2;
        const now = yield* DateTime.now;
        const root = (yield* threads.getThreadRecords(threadId, [])).thread;
        yield* sink.write({
          events: [
            {
              id: EventId.make("action-archive:child-created"),
              type: "thread.created",
              threadId: childId,
              occurredAt: now,
              payload: {
                ...root,
                id: childId,
                title: "Owned child",
                lineage: {
                  parentThreadId: threadId,
                  rootThreadId: threadId,
                  relationshipToParent: "subagent",
                },
              },
            },
          ],
        });
        if (!raceLaunch)
          yield* orchestrator.dispatch({
            type: "thread.archive",
            threadId,
            commandId: archiveId,
            childDisposition: "stop_and_archive",
            expectedChildThreadIds: [childId],
          });
        const error = yield* Effect.flip(
          actions.runProjectActionAndResume({ threadId, providerInstanceId: instanceId }, "qa"),
        );
        assert.equal(error._tag, "ActionResumeError");
        assert.equal(error.reason, "launch_failed");
        assert.equal(harness.terminalWrites(), 0);
        assert.equal(harness.terminalCloses(), 1);
        const shell = (yield* threads.getThreadRecords(threadId, [])).thread;
        assert.equal(shell.archivePending?.status, "stopping");
        assert.isNull(shell.actionResume ?? null);
        const retained = (yield* runs.listLatest).find((state) => state.threadId === threadId);
        assert.equal(retained?.outcome, "failed");
        assert.equal(retained?.delivery, "disposed");
      }).pipe(Effect.provide(harness.layer));
    }),
);

it.effect.each([false, true])(
  "retains one Action result across archive stopping (delivery race: %s)",
  (raceDelivery) =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(raceDelivery);
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const receipts = yield* CommandReceipts.CommandReceiptStoreV2;
        const actions = yield* ActionResume.ActionResume;
        const runs = yield* ActionRunStore.ActionRunStore;
        yield* threads.dispatch({
          type: "thread.create",
          commandId: CommandId.make("action-archive:create"),
          threadId,
          projectId,
          title: "Action archive",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        // Accepted provider work makes archive asynchronous; no real process is started.
        yield* threads.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("action-archive:busy"),
          threadId,
          messageId: MessageId.make("action-archive:busy"),
          text: "Keep this turn prepared",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "defer_start" },
          createdBy: "user",
          creationSource: "web",
        });
        const sink = yield* EventSink.EventSinkV2;
        const now = yield* DateTime.now;
        const root = (yield* threads.getThreadRecords(threadId, [])).thread;
        yield* sink.write({
          events: [
            {
              id: EventId.make("action-archive:child-created"),
              type: "thread.created",
              threadId: childId,
              occurredAt: now,
              payload: {
                ...root,
                id: childId,
                title: "Owned child",
                lineage: {
                  parentThreadId: threadId,
                  rootThreadId: threadId,
                  relationshipToParent: "subagent",
                },
              },
            },
            {
              id: EventId.make("action-archive:provider-binding"),
              type: "provider-thread.updated",
              threadId,
              occurredAt: now,
              payload: {
                id: ProviderThreadId.make("action-archive:provider-thread"),
                driver: provider.driver,
                providerInstanceId: instanceId,
                providerSessionId: ProviderSessionId.make("action-archive:provider-session"),
                appThreadId: threadId,
                ownerNodeId: null,
                nativeThreadRef: null,
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt: now,
                updatedAt: now,
              },
            },
          ],
        });
        const state = yield* actions.runProjectActionAndResume(
          { threadId, providerInstanceId: instanceId },
          "qa",
        );
        if (!raceDelivery)
          yield* orchestrator.dispatch({
            type: "thread.archive",
            threadId,
            commandId: archiveId,
            childDisposition: "stop_and_archive",
            expectedChildThreadIds: [childId],
          });
        else
          yield* threads.dispatch({
            type: "thread.stop",
            threadId,
            commandId: CommandId.make("action-archive:idle"),
          });
        yield* harness.emit({
          type: "exited",
          threadId,
          terminalId: state.terminalId,
          exitCode: 0,
          exitSignal: null,
        });
        if (raceDelivery) yield* Deferred.await(harness.attempted);
        const held = (yield* threads.getThreadRecords(threadId, [])).thread;
        assert.equal(held.archivePending?.status, "stopping");
        // The ledger-to-shell publication settles safely inside the same hold.
        assert.equal(held.actionResume?.outcome, "succeeded");
        assert.equal(held.actionResume?.delivery, "pending");
        const retained = yield* runs.get(threadId, state.runId);
        assert.equal(
          Option.isSome(retained) ? retained.value.state.delivery : undefined,
          "pending",
        );
        const deliveryId = CommandId.make(`server:action-resume:${state.runId}:delivery`);
        assert.isTrue(Option.isNone(yield* receipts.getByCommandId(deliveryId)));
        yield* actions.retryPendingFollowUps;
        assert.isTrue(Option.isNone(yield* receipts.getByCommandId(deliveryId)));
        const afterSequence = (yield* orchestrator.getShellSnapshot()).snapshotSequence;
        const stopEntered = yield* Deferred.make<void>();
        const releaseStop = yield* Deferred.make<void>();
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const stopping = yield* threads.executeArchive({ threadId, requestId: archiveId }).pipe(
          Effect.provideService(ProviderSessionManager.ProviderSessionManagerV2, {
            ...manager,
            teardownThread: () =>
              Deferred.succeed(stopEntered, undefined).pipe(
                Effect.andThen(Deferred.await(releaseStop)),
                Effect.andThen(Effect.die("Controlled provider teardown failure")),
              ),
          }),
          Effect.forkChild,
        );
        yield* Deferred.await(stopEntered);
        yield* Deferred.succeed(releaseStop, undefined);
        yield* Fiber.join(stopping);
        // Await the persisted delivery milestone, rather than the event consumer's scheduling.
        yield* orchestrator.streamStoredEventsFrom({ threadId, afterSequence }).pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "thread.metadata-updated" &&
              stored.event.payload.actionResume?.runId === state.runId &&
              stored.event.payload.actionResume.delivery === "delivered",
          ),
          Stream.runHead,
        );
        yield* threads.dispatch({
          type: "thread.unarchive",
          commandId: CommandId.make("action-archive:dismiss"),
          threadId,
          expectedArchiveCommandId: archiveId,
        });
        yield* actions.retryPendingFollowUps;
        const after = yield* threads.getThreadProjection(threadId);
        assert.lengthOf(
          after.messages.filter(
            (message) => message.id === MessageId.make(`action-resume:${state.runId}:follow-up`),
          ),
          1,
        );
        const accepted = yield* receipts.getByCommandId(deliveryId);
        assert.equal(Option.isSome(accepted) ? accepted.value.status : undefined, "accepted");
        assert.isTrue(
          (yield* actions.listProjectActions({ threadId, providerInstanceId: instanceId }))[0]
            ?.resumeEligible,
        );
      }).pipe(Effect.provide(harness.layer));
    }),
);
