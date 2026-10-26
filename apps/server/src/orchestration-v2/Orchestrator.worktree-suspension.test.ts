import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  MessageId,
  OrchestrationV2Command,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type WorktreeSuspensionSummary,
  type WorktreeSuspensionTransitionInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerConfig from "../config.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type { ProviderAdapterV2 } from "@t3tools/provider-core/server/ProviderAdapter";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { dispatchCommand, dispatchUserCommand } from "./ThreadMessageIntake.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Suspension metadata must not launch a provider"),
} as ProviderAdapterV2["Service"];
const database = SqlitePersistence.layerMemory;
const testLayer = Layer.mergeAll(
  ServerConfig.layerTest(process.cwd(), { prefix: "workspace-adoption-intake-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
  ),
  database,
  ProjectionStore.layer.pipe(Layer.provide(database)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "worktree-suspension" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  ),
);

const projectId = ProjectId.make("suspension:project");
const firstId = ThreadId.make("suspension:first");
const secondId = ThreadId.make("suspension:second");
const worktreePath = "/worktrees/example/topic";
const create = (threadId: ThreadId, worktree: string | null = worktreePath) => ({
  type: "thread.create" as const,
  commandId: CommandId.make(`create:${threadId}`),
  threadId,
  projectId,
  title: "Workspace owner",
  modelSelection: { instanceId, model: "gpt-6" },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  branch: "topic",
  worktreePath: worktree,
  createdBy: "user" as const,
  creationSource: "web" as const,
});
const capturing: WorktreeSuspensionSummary = {
  checkoutId: "checkout:example",
  generation: 1,
  state: "capturing",
  snapshotId: null,
  lastRestoredAt: null,
  keepWorkspace: false,
};
const suspended: WorktreeSuspensionSummary = {
  ...capturing,
  state: "suspended",
  snapshotId: "snapshot:example",
};
const transition = (
  suffix: string,
  expected: WorktreeSuspensionSummary | null,
  next: WorktreeSuspensionSummary,
  ids = [firstId, secondId],
): WorktreeSuspensionTransitionInput => ({
  commandId: CommandId.make(`suspension:${suffix}`),
  threadId: firstId,
  checkoutId: capturing.checkoutId,
  aliases: [worktreePath],
  expectedOwners: ids.map((threadId) => ({
    threadId,
    projectId,
    worktreePath,
    branch: "topic",
    generation: expected?.generation ?? null,
  })),
  expected,
  next,
});
const setup = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  yield* engine.dispatch(create(firstId));
  yield* engine.dispatch(create(secondId));
  return engine;
});
const decodeClientCommand = Schema.decodeUnknownSync(OrchestrationV2Command);

it.effect("keeps read-state and administrative actions from adopting an agent workspace", () =>
  Effect.gen(function* () {
    const engine = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* engine.dispatch(create(secondId));
    yield* engine.dispatch({
      ...create(firstId),
      creatorThreadId: secondId,
      createdBy: "agent",
      creationSource: "mcp",
    });
    yield* engine.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("adoption:agent-message"),
      threadId: firstId,
      messageId: MessageId.make("adoption:agent-message"),
      text: "Automatic child work",
      attachments: [],
      createdBy: "agent",
      creationSource: "mcp",
      dispatchMode: { type: "queue_after_active" },
    });
    const run = (yield* projections.getThreadRecords(firstId, ["runs"])).runs[0]!;
    const completedAt = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
    yield* projections.apply({
      id: EventId.make("adoption:agent-completed"),
      type: "run.updated",
      threadId: firstId,
      occurredAt: completedAt,
      payload: { ...run, status: "completed", completedAt },
    });
    yield* dispatchUserCommand({
      type: "thread.visit",
      commandId: CommandId.make("adoption:view"),
      threadId: firstId,
      visitedAt: "2026-01-01T00:00:00.000Z",
    }).pipe(Effect.provide(ThreadManagement.layer));
    yield* dispatchUserCommand({
      type: "thread.mark-unread",
      commandId: CommandId.make("adoption:unread"),
      threadId: firstId,
    }).pipe(Effect.provide(ThreadManagement.layer));
    yield* dispatchUserCommand({
      type: "thread.pin",
      commandId: CommandId.make("adoption:pin"),
      threadId: firstId,
    }).pipe(Effect.provide(ThreadManagement.layer));
    yield* dispatchUserCommand({
      type: "thread.metadata.update",
      commandId: CommandId.make("adoption:administrative"),
      threadId: firstId,
      actionResume: null,
    }).pipe(Effect.provide(ThreadManagement.layer));
    assert.isFalse((yield* projections.getThread(firstId)).workspaceUserAdopted);
    assert.isFalse((yield* projections.getThreadShell(firstId))?.workspaceUserAdopted);
    assert.isTrue((yield* projections.getThread(secondId)).workspaceUserAdopted);
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "records deliberate human edits while server and MCP metadata preserve untouched state",
  () =>
    Effect.gen(function* () {
      const engine = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* engine.dispatch({ ...create(firstId), createdBy: "agent", creationSource: "mcp" });
      yield* dispatchCommand({
        type: "thread.metadata.update",
        commandId: CommandId.make("adoption:automatic"),
        threadId: firstId,
        title: "Automatic title",
      }).pipe(Effect.provide(ThreadManagement.layer));
      assert.isFalse((yield* projections.getThread(firstId)).workspaceUserAdopted);
      const result = yield* dispatchUserCommand({
        type: "thread.metadata.update",
        commandId: CommandId.make("adoption:human"),
        threadId: firstId,
        title: "Human title",
        branch: "human-branch",
      }).pipe(Effect.provide(ThreadManagement.layer));
      assert.isTrue((yield* projections.getThread(firstId)).workspaceUserAdopted);
      assert.isTrue((yield* projections.getThreadShell(firstId))?.workspaceUserAdopted);
      assert.isTrue(
        result.storedEvents.every(
          (stored) => stored.commandId === CommandId.make("adoption:human"),
        ),
      );
      const updated = result.storedEvents.findLast(
        (stored) => stored.event.type === "thread.metadata-updated",
      )!.event;
      assert.equal((yield* projections.getThread(firstId)).title, "Human title");
      assert.equal((yield* projections.getThread(firstId)).branch, "human-branch");
      const current = yield* projections.getThread(firstId);
      const replay = ProjectionStore.applyToProjection(
        ProjectionStore.emptyProjection({ ...updated, type: "thread.created", payload: current }),
        updated,
      );
      assert.isTrue(ProjectionStore.threadShellFromProjection(replay).workspaceUserAdopted);
    }).pipe(Effect.provide(testLayer)),
);

it.effect("commits a human message and its adoption evidence under the same command receipt", () =>
  Effect.gen(function* () {
    const engine = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* engine.dispatch({ ...create(firstId), createdBy: "agent", creationSource: "mcp" });
    const commandId = CommandId.make("adoption:human-message");
    const messageId = MessageId.make("adoption:human-message");
    const result = yield* dispatchUserCommand({
      type: "message.dispatch",
      commandId,
      threadId: firstId,
      messageId,
      text: "Use this workspace for my change",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
      dispatchMode: { type: "queue_after_active" },
    }).pipe(Effect.provide(ThreadManagement.layer));
    const current = yield* projections.getThreadRecords(firstId, ["messages", "runs"]);
    assert.isTrue(current.thread.workspaceUserAdopted);
    assert.equal(
      current.messages.find((message) => message.id === messageId)?.text,
      "Use this workspace for my change",
    );
    assert.equal(current.runs.length, 1);
    assert.isTrue(result.storedEvents.every((stored) => stored.commandId === commandId));
    assert.isTrue(result.storedEvents.some((stored) => stored.event.type === "message.updated"));
    assert.isTrue(
      result.storedEvents.some(
        (stored) =>
          stored.event.type === "thread.metadata-updated" &&
          stored.event.payload.workspaceUserAdopted === true,
      ),
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect("does not adopt a workspace when the deliberate human command is rejected", () =>
  Effect.gen(function* () {
    const engine = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* engine.dispatch({ ...create(firstId), createdBy: "agent", creationSource: "mcp" });
    const result = yield* Effect.exit(
      dispatchUserCommand({
        type: "thread.metadata.update",
        commandId: CommandId.make("adoption:rejected"),
        threadId: firstId,
        branch: "human-branch",
        expectedBranch: "stale-branch",
      }).pipe(Effect.provide(ThreadManagement.layer)),
    );
    assert.equal(result._tag, "Failure");
    assert.isFalse((yield* projections.getThread(firstId)).workspaceUserAdopted);
    assert.isFalse((yield* projections.getThreadShell(firstId))?.workspaceUserAdopted);
    assert.equal((yield* projections.getThread(firstId)).branch, "topic");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("does not reinterpret an automatic command as adoption when its receipt replays", () =>
  Effect.gen(function* () {
    const engine = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* engine.dispatch({ ...create(firstId), createdBy: "agent", creationSource: "mcp" });
    const command = {
      type: "thread.metadata.update" as const,
      commandId: CommandId.make("adoption:replay"),
      threadId: firstId,
      title: "Automatic title",
    };
    const accepted = yield* dispatchCommand(command).pipe(Effect.provide(ThreadManagement.layer));
    const replayed = yield* dispatchUserCommand(command).pipe(
      Effect.provide(ThreadManagement.layer),
    );
    assert.deepEqual(replayed, accepted);
    assert.isFalse((yield* projections.getThread(firstId)).workspaceUserAdopted);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("keeps missing adoption evidence unknown and rejects commands that clear it", () =>
  Effect.gen(function* () {
    const engine = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    yield* engine.dispatch({ ...create(firstId), createdBy: "agent", creationSource: "mcp" });
    yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = json_remove(payload_json, '$.workspaceUserAdopted') WHERE thread_id = ${firstId}`;
    yield* engine.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("adoption:legacy"),
      threadId: firstId,
      title: "Automatic legacy title",
    });
    assert.isUndefined((yield* projections.getThread(firstId)).workspaceUserAdopted);
    assert.isUndefined((yield* projections.getThreadShell(firstId))?.workspaceUserAdopted);
    assert.throws(() =>
      decodeClientCommand({
        type: "thread.metadata.update",
        commandId: "adoption:clear",
        threadId: firstId,
        workspaceUserAdopted: false,
      }),
    );
  }).pipe(Effect.provide(testLayer)),
);

it("keeps availability transitions out of client dispatch commands", () => {
  assert.throws(() =>
    decodeClientCommand({
      type: "thread.worktree-suspension.transition",
      ...transition("client", null, capturing),
    }),
  );
});

it.effect("commits every owner and its receipt together and preserves shell/replay summaries", () =>
  Effect.gen(function* () {
    const engine = yield* setup;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const request = transition("capture", null, capturing);
    const before = yield* projections.getThread(firstId);
    const result = yield* engine.transitionWorktreeSuspension(request);
    assert.equal(result.storedEvents.length, 2);
    assert.deepEqual(result.storedEvents.map((stored) => stored.event.threadId).toSorted(), [
      firstId,
      secondId,
    ]);
    for (const id of [firstId, secondId]) {
      assert.deepEqual((yield* projections.getThread(id)).worktreeSuspension, capturing);
      assert.deepEqual((yield* projections.getThreadShell(id))?.worktreeSuspension, capturing);
    }
    const after = yield* projections.getThread(firstId);
    assert.deepEqual(after.updatedAt, before.updatedAt);
    const snapshot = yield* projections.getShellSnapshot();
    assert.deepEqual(
      snapshot.threads.find((thread) => thread.id === firstId)?.worktreeSuspension,
      capturing,
    );
    const stored = result.storedEvents.find((event) => event.event.threadId === firstId)!.event;
    const replay = ProjectionStore.applyToProjection(
      ProjectionStore.emptyProjection({ ...stored, type: "thread.created", payload: before }),
      stored,
    );
    assert.deepEqual(
      ProjectionStore.threadShellFromProjection(replay).worktreeSuspension,
      capturing,
    );
    const receipts = yield* sql<{ status: string }>`
      SELECT status FROM orchestration_command_receipts WHERE command_id = ${request.commandId}
    `;
    assert.deepEqual(
      receipts.map((receipt) => receipt.status),
      ["accepted"],
    );
    assert.deepEqual(
      (yield* engine.transitionWorktreeSuspension(request)).storedEvents,
      result.storedEvents,
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect("rejects incomplete and stale owner sets without updating any owner", () =>
  Effect.gen(function* () {
    const engine = yield* setup;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    for (const request of [
      transition("partial", null, capturing, [firstId]),
      {
        ...transition("branch", null, capturing),
        expectedOwners: transition("unused", null, capturing).expectedOwners.map((owner) =>
          owner.threadId === secondId ? { ...owner, branch: "different" } : owner,
        ),
      },
    ]) {
      assert.equal(
        (yield* Effect.exit(engine.transitionWorktreeSuspension(request)))._tag,
        "Failure",
      );
      for (const id of [firstId, secondId])
        assert.isUndefined((yield* projections.getThread(id)).worktreeSuspension);
    }
    yield* engine.dispatch(create(ThreadId.make("suspension:late-owner")));
    assert.equal(
      (yield* Effect.exit(engine.transitionWorktreeSuspension(transition("late", null, capturing))))
        ._tag,
      "Failure",
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect("compares state, current snapshot, generation and holds even within one generation", () =>
  Effect.gen(function* () {
    const engine = yield* setup;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* engine.transitionWorktreeSuspension(transition("capture", null, capturing));
    yield* engine.transitionWorktreeSuspension(transition("suspend", capturing, suspended));
    for (const expected of [
      capturing,
      { ...suspended, snapshotId: "snapshot:older" },
      { ...suspended, generation: 0 },
      { ...suspended, keepWorkspace: true },
    ])
      assert.equal(
        (yield* Effect.exit(
          engine.transitionWorktreeSuspension(
            transition(
              `stale:${expected.state}:${expected.snapshotId}:${expected.generation}:${expected.keepWorkspace}`,
              expected,
              { ...suspended, state: "restoring" },
            ),
          ),
        ))._tag,
        "Failure",
      );
    for (const id of [firstId, secondId])
      assert.deepEqual((yield* projections.getThread(id)).worktreeSuspension, suspended);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("refuses capture when a shared owner resumed after eligibility was read", () =>
  Effect.gen(function* () {
    const engine = yield* setup;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const request = transition("stale-eligibility", null, capturing);
    yield* engine.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("suspension:resume-second"),
      threadId: secondId,
      messageId: MessageId.make("suspension:resume-message"),
      text: "Continue this work",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
      dispatchMode: { type: "queue_after_active" },
    });
    assert.equal(
      (yield* Effect.exit(engine.transitionWorktreeSuspension(request)))._tag,
      "Failure",
    );
    for (const id of [firstId, secondId])
      assert.isUndefined((yield* projections.getThread(id)).worktreeSuspension);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("refuses capture while an owner has an unresolved Action continuation", () =>
  Effect.gen(function* () {
    const engine = yield* setup;
    yield* engine.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("suspension:pending-action"),
      threadId: secondId,
      actionResume: {
        runId: "action:example",
        threadId: secondId,
        projectId,
        actionId: "action:check",
        actionName: "Check",
        command: "true",
        terminalId: "action:terminal",
        outcome: "succeeded",
        delivery: "pending",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:01.000Z",
        exitCode: 0,
        exitSignal: null,
        revision: 1,
      },
    });
    assert.equal(
      (yield* Effect.exit(
        engine.transitionWorktreeSuspension(transition("action-eligibility", null, capturing)),
      ))._tag,
      "Failure",
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect("requires an existing workspace hold to be released before capture", () =>
  Effect.gen(function* () {
    const engine = yield* setup;
    const held: WorktreeSuspensionSummary = {
      ...capturing,
      state: "active",
      keepWorkspace: true,
    };
    yield* engine.transitionWorktreeSuspension(transition("hold", null, held));
    assert.equal(
      (yield* Effect.exit(
        engine.transitionWorktreeSuspension(
          transition("held-capture", held, { ...capturing, generation: 2 }),
        ),
      ))._tag,
      "Failure",
    );
    const released: WorktreeSuspensionSummary = { ...held, keepWorkspace: false };
    yield* engine.transitionWorktreeSuspension(transition("release", held, released));
    yield* engine.transitionWorktreeSuspension(
      transition("released-capture", released, { ...capturing, generation: 2 }),
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "blocks new owners and branch/path rebinding while workspace availability is retained",
  () =>
    Effect.gen(function* () {
      const engine = yield* setup;
      yield* engine.transitionWorktreeSuspension(transition("capture", null, capturing));
      yield* engine.transitionWorktreeSuspension(transition("suspend", capturing, suspended));
      const detachedId = ThreadId.make("suspension:detached");
      yield* engine.dispatch(create(detachedId, null));
      const attempts = [
        create(ThreadId.make("suspension:join")),
        {
          type: "thread.metadata.update" as const,
          commandId: CommandId.make("suspension:rebind"),
          threadId: detachedId,
          worktreePath,
        },
        {
          type: "thread.metadata.update" as const,
          commandId: CommandId.make("suspension:rename"),
          threadId: secondId,
          branch: "changed",
        },
      ];
      for (const attempt of attempts)
        assert.equal((yield* Effect.exit(engine.dispatch(attempt)))._tag, "Failure");
      yield* engine.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("suspension:readable-title"),
        threadId: firstId,
        title: "Conversation stays editable",
      });
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "restores every owner to one new path/branch and shares active checkout identity on later joins",
  () =>
    Effect.gen(function* () {
      const engine = yield* setup;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* engine.transitionWorktreeSuspension(transition("capture", null, capturing));
      yield* engine.transitionWorktreeSuspension(transition("suspend", capturing, suspended));
      const restoring: WorktreeSuspensionSummary = { ...suspended, state: "restoring" };
      yield* engine.transitionWorktreeSuspension(transition("restore", suspended, restoring));
      const active: WorktreeSuspensionSummary = {
        ...restoring,
        state: "active",
        snapshotId: null,
        lastRestoredAt: "2026-01-01T00:00:00.000Z",
        keepWorkspace: true,
      };
      const workspace = { worktreePath: "/worktrees/example/recovered", branch: "recovered" };
      const restored = yield* engine.transitionWorktreeSuspension({
        ...transition("active", restoring, active),
        workspace,
      });
      assert.equal(restored.storedEvents.length, 2);
      for (const id of [firstId, secondId]) {
        const thread = yield* projections.getThread(id);
        assert.equal(thread.worktreePath, workspace.worktreePath);
        assert.equal(thread.branch, workspace.branch);
        assert.deepEqual(thread.worktreeSuspension, active);
      }
      const joinedId = ThreadId.make("suspension:active-join");
      yield* engine.dispatch({
        ...create(joinedId, workspace.worktreePath),
        branch: workspace.branch,
      });
      assert.deepEqual((yield* projections.getThread(joinedId)).worktreeSuspension, active);
      yield* engine.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("suspension:leave"),
        threadId: joinedId,
        worktreePath: null,
      });
      assert.isUndefined((yield* projections.getThread(joinedId)).worktreeSuspension);
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "refuses an occupied destination and never uses discarded authority as a restore source",
  () =>
    Effect.gen(function* () {
      const engine = yield* setup;
      yield* engine.transitionWorktreeSuspension(transition("capture", null, capturing));
      yield* engine.transitionWorktreeSuspension(transition("suspend", capturing, suspended));
      const restoring: WorktreeSuspensionSummary = { ...suspended, state: "restoring" };
      yield* engine.transitionWorktreeSuspension(transition("restore", suspended, restoring));
      const occupied = "/worktrees/example/occupied";
      yield* engine.dispatch(create(ThreadId.make("suspension:occupant"), occupied));
      assert.equal(
        (yield* Effect.exit(
          engine.transitionWorktreeSuspension({
            ...transition("collision", restoring, {
              ...restoring,
              state: "active",
              snapshotId: null,
            }),
            workspace: { worktreePath: occupied, branch: "recovered" },
          }),
        ))._tag,
        "Failure",
      );
      const discarded: WorktreeSuspensionSummary = {
        ...restoring,
        state: "discarded",
        snapshotId: null,
      };
      yield* engine.transitionWorktreeSuspension(transition("discarded", restoring, discarded));
      assert.equal(
        (yield* Effect.exit(
          engine.transitionWorktreeSuspension(transition("old-history", discarded, suspended)),
        ))._tag,
        "Failure",
      );
    }).pipe(Effect.provide(testLayer)),
);

it.effect("allows per-thread branch synchronization on a shared restored checkout", () =>
  Effect.gen(function* () {
    const engine = yield* setup;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const active: WorktreeSuspensionSummary = {
      ...capturing,
      state: "active",
      snapshotId: null,
      lastRestoredAt: "2026-01-01T00:00:00.000Z",
      keepWorkspace: true,
    };
    yield* engine.transitionWorktreeSuspension(transition("active-sync", null, active));
    yield* engine.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("sync:first"),
      threadId: firstId,
      branch: "switched",
    });
    assert.equal((yield* projections.getThread(firstId)).branch, "switched");
    assert.equal((yield* projections.getThread(secondId)).branch, "topic");
    assert.deepEqual((yield* projections.getThread(firstId)).worktreeSuspension, active);
    const childId = ThreadId.make("suspension:drifted-child");
    yield* engine.dispatch({
      ...create(childId),
      branch: "switched",
      createdBy: "agent",
      creatorThreadId: firstId,
    });
    assert.deepEqual((yield* projections.getThread(childId)).worktreeSuspension, active);
    yield* engine.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("sync:second"),
      threadId: secondId,
      branch: "switched",
    });
    assert.equal((yield* projections.getThread(secondId)).branch, "switched");
  }).pipe(Effect.provide(testLayer)),
);
