import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Tracer from "effect/Tracer";
import * as SqlClient from "effect/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import { repairHistoricalThreadCreators } from "./repairHistoricalThreadCreators.ts";

const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);
const TestLayer = Layer.mergeAll(EventSink.layer, ProjectionMaintenance.layer).pipe(
  Layer.provideMerge(stores),
);
const now = DateTime.makeUnsafe("2026-09-01T00:00:00Z");
const provider = ProviderInstanceId.make("codex");

const createThread = Effect.fnUntraced(function* (
  name: string,
  overrides: Partial<OrchestrationV2AppThread> = {},
  commandId = name,
) {
  const id = ThreadId.make(name);
  const thread: OrchestrationV2AppThread = {
    id,
    title: name,
    projectId: ProjectId.make("project"),
    createdBy: "agent",
    creationSource: "mcp",
    providerInstanceId: provider,
    modelSelection: { instanceId: provider, model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
    ...overrides,
  };
  yield* (yield* EventSink.EventSinkV2).write({
    commandId: CommandId.make(commandId),
    events: [
      {
        id: EventId.make(`create:${name}`),
        type: "thread.created",
        threadId: id,
        occurredAt: now,
        payload: thread,
      },
    ],
  });
  return thread;
});

const launchMessage = Effect.fnUntraced(function* (
  thread: OrchestrationV2AppThread,
  creator: ThreadId,
  overrides: Partial<OrchestrationV2ConversationMessage> = {},
  commandId = `${thread.id}:initial-message`,
) {
  yield* (yield* EventSink.EventSinkV2).write({
    commandId: CommandId.make(commandId),
    events: [
      {
        id: EventId.make(`message:${thread.id}:${creator}:${commandId}`),
        type: "message.updated",
        threadId: thread.id,
        occurredAt: now,
        payload: {
          id: MessageId.make(thread.id),
          threadId: thread.id,
          runId: null,
          nodeId: null,
          role: "user",
          text: "Launch",
          attachments: [],
          streaming: false,
          createdAt: now,
          updatedAt: now,
          createdBy: "agent",
          creationSource: "mcp",
          senderThreadId: creator,
          ...overrides,
        },
      },
    ],
  });
});

const creationRecord = Effect.fnUntraced(function* (
  thread: OrchestrationV2AppThread,
  creator: ThreadId,
) {
  const key = `${creator}:${thread.id}`;
  yield* (yield* EventSink.EventSinkV2).write({
    commandId: CommandId.make(`record:${key}`),
    events: [
      {
        id: EventId.make(`record:${key}`),
        type: "turn-item.updated",
        threadId: creator,
        occurredAt: now,
        payload: {
          id: TurnItemId.make(`item:${key}`),
          threadId: creator,
          runId: RunId.make(`run:${creator}`),
          nodeId: NodeId.make(`node:${creator}`),
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "completed",
          title: thread.title,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "thread_created",
          targetThreadId: thread.id,
          targetRunId: null,
          targetProviderInstanceId: provider,
          targetModel: "gpt-5.4",
        },
      },
    ],
  });
});

it.layer(TestLayer)("historical thread creators", (it) => {
  it.effect(
    "repairs exact MCP launches across projects, persists through replay and repeats without events",
    () =>
      Effect.gen(function* () {
        const parent = yield* createThread("launch-parent");
        const child = yield* createThread("launch-child", {
          projectId: ProjectId.make("other-project"),
          pinnedAt: now,
          settledOverride: "settled",
        });
        yield* launchMessage(child, parent.id);
        assert.equal(yield* repairHistoricalThreadCreators, 1);
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const repaired = (yield* store.getThreadProjection(child.id)).thread;
        assert.deepStrictEqual(repaired, {
          ...child,
          creatorThreadId: parent.id,
          creatorGrouping: "grouped",
        });
        const events = yield* EventStore.EventStoreV2;
        const sequence = yield* events.latestSequence();
        assert.equal(yield* repairHistoricalThreadCreators, 0);
        assert.equal(yield* events.latestSequence(), sequence);
        yield* (yield* ProjectionMaintenance.ProjectionMaintenanceV2).rebuild;
        assert.deepStrictEqual((yield* store.getThreadProjection(child.id)).thread, repaired);
        assert.equal(yield* repairHistoricalThreadCreators, 0);
      }),
  );

  it.effect(
    "recovers a no-prompt creation record after compaction and preserves independent placement",
    () =>
      Effect.gen(function* () {
        const parent = yield* createThread("record-parent");
        const child = yield* createThread(
          "record-child",
          { creatorGrouping: "independent" },
          "separate-create-command",
        );
        yield* creationRecord(child, parent.id);
        yield* (yield* ProjectionMaintenance.ProjectionMaintenanceV2).compactEventStore;
        assert.equal(yield* repairHistoricalThreadCreators, 1);
        const repaired = (yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadProjection(
          child.id,
        )).thread;
        assert.deepStrictEqual(repaired, { ...child, creatorThreadId: parent.id });
      }),
  );

  it.effect("keeps existing creator, forks, subagents and unsupported origins unchanged", () =>
    Effect.gen(function* () {
      const parent = yield* createThread("excluded-parent");
      const actual = yield* createThread("actual-parent");
      const variants: Partial<OrchestrationV2AppThread>[] = [
        { creatorThreadId: actual.id, creatorGrouping: "independent" },
        {
          lineage: {
            rootThreadId: parent.id,
            parentThreadId: parent.id,
            relationshipToParent: "subagent",
          },
        },
        {
          lineage: {
            rootThreadId: parent.id,
            parentThreadId: parent.id,
            relationshipToParent: "fork",
          },
        },
        { forkedFrom: { type: "run", threadId: parent.id, runId: RunId.make("fork-source") } },
        { createdBy: "user" },
        { creationSource: "provider" },
      ];
      for (const [index, overrides] of variants.entries()) {
        const child = yield* createThread(`excluded-${index}`, overrides);
        yield* launchMessage(child, parent.id);
      }
      assert.equal(yield* repairHistoricalThreadCreators, 0);
      assert.equal(
        (yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadProjection(
          ThreadId.make("excluded-0"),
        )).thread.creatorThreadId,
        actual.id,
      );
    }),
  );

  it.effect("rejects sender heuristics without the exact launch command and message identity", () =>
    Effect.gen(function* () {
      const parent = yield* createThread("misleading-parent");
      const ordinary = yield* createThread("ordinary-message");
      yield* launchMessage(ordinary, parent.id, {}, "unrelated-send-command");
      const wrongMessage = yield* createThread("wrong-message");
      yield* launchMessage(wrongMessage, parent.id, { id: MessageId.make("different-message") });
      const wrongCreation = yield* createThread("wrong-creation", {}, "different-creation-command");
      yield* launchMessage(wrongCreation, parent.id);
      const noEvidence = yield* createThread("no-evidence");
      assert.equal(yield* repairHistoricalThreadCreators, 0);
      assert.equal(
        (yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadProjection(noEvidence.id))
          .thread.creatorThreadId,
        undefined,
      );
    }),
  );

  it.effect(
    "rejects conflicting evidence, self-links and cycles through proposed or existing provenance",
    () =>
      Effect.gen(function* () {
        const parent = yield* createThread("conflict-parent");
        const other = yield* createThread("conflict-other");
        const conflict = yield* createThread("conflict");
        yield* launchMessage(conflict, parent.id);
        yield* creationRecord(conflict, other.id);
        const self = yield* createThread("self");
        yield* launchMessage(self, self.id);
        const left = yield* createThread("cycle-left");
        const right = yield* createThread("cycle-right");
        yield* launchMessage(left, right.id);
        yield* creationRecord(right, left.id);
        const existingChild = yield* createThread("existing-cycle-child", {
          creatorThreadId: ThreadId.make("existing-cycle-parent"),
        });
        const existingParent = yield* createThread("existing-cycle-parent");
        yield* launchMessage(existingParent, existingChild.id);
        assert.equal(yield* repairHistoricalThreadCreators, 0);
      }),
  );

  it.effect("keeps deleted creator provenance but skips missing creators", () =>
    Effect.gen(function* () {
      const deleted = yield* createThread("deleted-creator", { deletedAt: now });
      const child = yield* createThread("orphan");
      yield* launchMessage(child, deleted.id);
      const missing = yield* createThread("missing-creator-child");
      yield* launchMessage(missing, ThreadId.make("missing-creator"));
      assert.equal(yield* repairHistoricalThreadCreators, 1);
      const store = yield* ProjectionStore.ProjectionStoreV2;
      assert.equal((yield* store.getThreadProjection(child.id)).thread.creatorThreadId, deleted.id);
      assert.equal(
        (yield* store.getThreadProjection(missing.id)).thread.creatorThreadId,
        undefined,
      );
    }),
  );
  it.effect(
    "uses bounded evidence index lookups even when a historical thread cannot be repaired",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const unresolved = yield* createThread("unrecoverable");
        yield* launchMessage(
          unresolved,
          unresolved.id,
          { id: MessageId.make("noise-message") },
          "noise-seed-command",
        );
        const statements: string[] = [];
        const tracer = Tracer.make({
          span(options) {
            const span = new Tracer.NativeSpan(options);
            const end = span.end.bind(span);
            span.end = (endTime, exit) => {
              end(endTime, exit);
              const query = span.attributes.get("db.query.text");
              if (typeof query === "string" && query.includes("WITH candidates AS"))
                statements.push(query);
            };
            return span;
          },
        });
        // Exercise ordinary traffic that shares the application-version index with evidence.
        yield* sql`
        WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < 1000)
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          command_id, actor_kind, payload_json, metadata_json, application_event_version
        )
        SELECT 'unrelated:' || n, 'thread', ${unresolved.id}, n + 1, 'message.updated',
          '2026-09-01T00:00:00Z', 'unrelated-command:' || n, 'client',
          (SELECT payload_json FROM orchestration_events WHERE command_id = 'noise-seed-command'), '{}', 2
        FROM numbers
      `;
        for (const analyzed of [false, true]) {
          if (analyzed) yield* sql`ANALYZE`;
          assert.equal(yield* repairHistoricalThreadCreators.pipe(Effect.withTracer(tracer)), 0);
          const statement = statements.at(-1);
          assert.isDefined(statement);
          const plan = yield* sql.unsafe<{ readonly detail: string }>(
            `EXPLAIN QUERY PLAN ${statement}`,
          );
          const details = plan.map((row) => row.detail).join("\n");
          assert.match(
            details,
            /SEARCH message USING INDEX idx_orch_events_command_id \(command_id=\?(?: AND rowid>\?)?\)/,
          );
          assert.match(
            details,
            /SEARCH record USING INDEX orchestration_events_v2_thread_created_target_idx \(<expr>=\? AND sequence>\?\)/,
          );
          assert.notMatch(details, /SCAN (?:message|record)/);
          assert.notInclude(details, "idx_orchestration_events_application_sequence");
        }
        assert.lengthOf(statements, 2);
        assert.equal(
          (yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadProjection(unresolved.id))
            .thread.creatorThreadId,
          undefined,
        );
        yield* sql`DELETE FROM orchestration_events WHERE event_id LIKE 'unrelated:%'`;
      }),
  );
});
