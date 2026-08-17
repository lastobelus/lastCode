import { assert, it } from "@effect/vitest";
import { EventId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProjectionThreadActivityRepository } from "../Services/ProjectionThreadActivities.ts";
import { ProjectionThreadActivityRepositoryLive } from "./ProjectionThreadActivities.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionThreadActivityRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionThreadActivityRepository", (it) => {
  it.effect("lists activity kinds in authoritative event sequence order", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadActivityRepository;
      const threadId = ThreadId.make("thread-action-resume-order");
      const createdAt = "2026-08-17T00:00:00.000Z";

      yield* repository.upsert({
        activityId: EventId.make("action-resume:run:succeeded:delivered"),
        threadId,
        turnId: null,
        tone: "info",
        kind: "action.resume.lifecycle",
        summary: "delivered",
        payload: { delivery: "delivered" },
        sequence: 3,
        createdAt,
      });
      yield* repository.upsert({
        activityId: EventId.make("action-resume:run:succeeded:pending"),
        threadId,
        turnId: null,
        tone: "info",
        kind: "action.resume.lifecycle",
        summary: "pending",
        payload: { delivery: "pending" },
        sequence: 2,
        createdAt,
      });

      const rows = yield* repository.listByKind({ kind: "action.resume.lifecycle" });

      assert.deepEqual(
        rows.map((row) => row.summary),
        ["pending", "delivered"],
      );
    }),
  );
});
