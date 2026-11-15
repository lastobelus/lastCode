import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  OrchestrationV2AppThreadJson,
  OrchestrationV2ThreadShellJson,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as EventStore from "./EventStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import { runDatabaseMigrations } from "../persistence/DatabaseMigrations.ts";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const encodeThread = Schema.encodeSync(OrchestrationV2AppThreadJson);
const decodeThread = Schema.decodeSync(OrchestrationV2AppThreadJson);
const encodeShell = Schema.encodeSync(OrchestrationV2ThreadShellJson);
const decodeShell = Schema.decodeSync(OrchestrationV2ThreadShellJson);

const TestLayer = Layer.mergeAll(ProjectionStore.layer, EventStore.layer, EffectOutbox.layer).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

it.effect(
  "loads historical thread metadata and replays events after retiring native promotion",
  () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const events = yield* EventStore.EventStoreV2;
      const now = DateTime.makeUnsafe("2026-01-01T00:00:00Z");
      const threadId = ThreadId.make("native-subagent");
      const providerInstanceId = ProviderInstanceId.make("provider-instance");
      const thread = {
        createdBy: "agent" as const,
        creationSource: "provider" as const,
        id: threadId,
        projectId: ProjectId.make("project"),
        title: "Native subagent",
        providerInstanceId,
        modelSelection: { instanceId: providerInstanceId, model: "model" },
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: {
          parentThreadId: ThreadId.make("parent"),
          relationshipToParent: "subagent" as const,
          rootThreadId: ThreadId.make("parent"),
        },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      };
      yield* events.append({
        events: [
          {
            id: EventId.make("created"),
            type: "thread.created",
            threadId,
            occurredAt: now,
            payload: thread,
          },
        ],
      });
      const destination = {
        ...thread,
        id: ThreadId.make("interactive"),
        title: "Interactive",
        creationSource: "web" as const,
        createdBy: "user" as const,
        lineage: {
          ...thread.lineage,
          parentThreadId: threadId,
          relationshipToParent: "fork" as const,
        },
      };
      yield* events.append({
        events: [
          {
            id: EventId.make("destination"),
            type: "thread.created",
            threadId: destination.id,
            occurredAt: now,
            payload: destination,
          },
        ],
      });
      const promotion = {
        createdBy: "user" as const,
        creationSource: "web" as const,
        requestId: CommandId.make("promotion"),
        targetThreadId: ThreadId.make("interactive"),
        status: "waiting" as const,
        error: null,
        requestedAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      };
      for (const subagentPromotion of [
        promotion,
        ...(["forking", "failed", "promoted"] as const).map((status) => ({ ...promotion, status })),
        null,
      ]) {
        const id = EventId.make(`promotion-${subagentPromotion?.status ?? "cleared"}`);
        yield* events.append({
          events: [
            { id, type: "thread.metadata-updated", threadId, occurredAt: now, payload: thread },
          ],
        });
        // Inject the exact obsolete JSON field, as written by an older build.
        yield* sql`UPDATE orchestration_events SET payload_json = json_set(payload_json, '$.subagentPromotion', json(${JSON.stringify(subagentPromotion)})) WHERE event_id = ${id}`;
        const replay = yield* Stream.runCollect(events.read());
        for (const stored of replay) yield* store.apply(stored.event);
        yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = json_set(payload_json, '$.subagentPromotion', json(${JSON.stringify(subagentPromotion)})) WHERE thread_id = ${threadId}`;
        const projection = yield* store.getThreadProjection(threadId);
        const json = encodeThread(projection.thread);
        const decoded = decodeThread(json);
        assert.isFalse("subagentPromotion" in decoded);
        assert.equal((yield* store.getThreadProjection(destination.id)).thread.id, destination.id);
        const sqlShell = (yield* store.getShellSnapshot()).threads.find(
          (item) => item.id === threadId,
        )!;
        const memoryShell = ProjectionStore.threadShellFromProjection(projection);
        for (const shell of [sqlShell, memoryShell]) {
          assert.isFalse("subagentPromotion" in shell);
          const encoded = encodeShell(shell);
          assert.isFalse("subagentPromotion" in decodeShell(encoded));
        }
      }
      // Upgrading must retire all old jobs, including leased and terminal rows.
      for (const status of ["pending", "running", "succeeded", "failed", "cancelled"]) {
        yield* sql`INSERT INTO orchestration_v2_effect_outbox (effect_id, command_id, thread_id, effect_type, payload_json, status, available_at, created_at, updated_at) VALUES (${status}, 'old-command', ${threadId}, 'subagent.promote', '{"type":"subagent.promote","requestId":"old-command"}', ${status}, '2026-01-01', '2026-01-01', '2026-01-01')`;
      }
      yield* sql`DELETE FROM lastcode_sql_migrations WHERE migration_id > 19`;
      yield* runDatabaseMigrations();
      assert.isEmpty(
        yield* sql`SELECT effect_id FROM orchestration_v2_effect_outbox WHERE effect_type = 'subagent.promote'`,
      );
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      assert.isTrue(Option.isNone(yield* outbox.claimNext({ workerId: "new-worker" })));
      assert.isEmpty(yield* outbox.listByCommandId(CommandId.make("old-command")));
    }).pipe(Effect.provide(TestLayer)),
);
