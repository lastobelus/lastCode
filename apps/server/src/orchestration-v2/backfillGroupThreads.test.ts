import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectionReplay from "./testkit/ProjectionReplay.ts";
import { backfillGroupThreads } from "./backfillGroupThreads.ts";

const testLayer = Layer.mergeAll(EventSink.layer, ProjectionReplay.layer).pipe(
  Layer.provideMerge(
    Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
      Layer.provideMerge(SqlitePersistence.layerMemory),
    ),
  ),
);
const now = DateTime.makeUnsafe("2026-09-01T00:00:00Z");
const projectId = ProjectId.make("project");
const providerInstanceId = ProviderInstanceId.make("codex");

const createThread = Effect.fnUntraced(function* (
  name: string,
  fields: Partial<OrchestrationV2AppThread> = {},
) {
  const id = ThreadId.make(name);
  const thread: OrchestrationV2AppThread = {
    id,
    projectId,
    title: name,
    createdBy: "agent",
    creationSource: "mcp",
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
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
    ...fields,
  };
  const sink = yield* EventSink.EventSinkV2;
  yield* sink.write({
    events: [
      {
        id: EventId.make("create:" + id),
        type: "thread.created",
        threadId: id,
        occurredAt: now,
        payload: thread,
      },
    ],
  });
  return thread;
});

it.layer(testLayer)("historical group threads", (it) => {
  it.effect("marks only empty agent-created MCP parents with current placement evidence", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const sink = yield* EventSink.EventSinkV2;
      const parent = yield* createThread("parent");
      yield* createThread("explicit child", { groupedUnderThreadId: parent.id });
      const legacyParent = yield* createThread("legacy parent");
      yield* createThread("legacy child", {
        creatorThreadId: legacyParent.id,
        creatorGrouping: "grouped",
      });
      const detached = yield* createThread("former parent");
      yield* createThread("detached child", {
        creatorThreadId: detached.id,
        creatorGrouping: "grouped",
        groupedUnderThreadId: null,
      });
      const user = yield* createThread("user parent", { createdBy: "user", creationSource: "web" });
      yield* createThread("user child", { groupedUnderThreadId: user.id });
      const foreignParent = yield* createThread("foreign parent");
      yield* createThread("foreign child", {
        projectId: ProjectId.make("another-project"),
        groupedUnderThreadId: foreignParent.id,
      });
      const withMessage = yield* createThread("parent with a message");
      yield* createThread("child of parent with a message", {
        groupedUnderThreadId: withMessage.id,
      });
      yield* sink.write({
        events: [
          {
            id: EventId.make("message event"),
            type: "message.updated",
            threadId: withMessage.id,
            occurredAt: now,
            payload: {
              id: MessageId.make("message"),
              threadId: withMessage.id,
              runId: null,
              nodeId: null,
              role: "user",
              text: "Past activity",
              attachments: [],
              streaming: false,
              createdAt: now,
              updatedAt: now,
              createdBy: "agent",
              creationSource: "mcp",
            },
          },
        ],
      });

      assert.equal(yield* backfillGroupThreads(), 2);
      assert.equal(yield* backfillGroupThreads(), 0);
      for (const thread of [parent, legacyParent]) {
        assert.isTrue((yield* store.getThread(thread.id)).groupThread);
        assert.isTrue((yield* store.getThreadShell(thread.id))?.groupThread);
        assert.equal(
          DateTime.formatIso((yield* store.getThread(thread.id)).updatedAt),
          DateTime.formatIso(now),
        );
      }
      for (const thread of [detached, user, foreignParent, withMessage]) {
        assert.isUndefined((yield* store.getThread(thread.id)).groupThread);
      }

      const replay = yield* ProjectionReplay.ProjectionReplay;
      assert.isTrue((yield* replay.rebuild).valid);
      assert.isTrue((yield* store.getThread(parent.id)).groupThread);
      assert.isTrue((yield* store.getThread(legacyParent.id)).groupThread);
    }),
  );
});
