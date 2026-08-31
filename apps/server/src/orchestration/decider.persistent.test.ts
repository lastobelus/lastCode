import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-08-30T00:00:00.000Z";

function thread(id: string, persistent = false): OrchestrationReadModel["threads"][number] {
  return {
    id: ThreadId.make(id),
    projectId: ProjectId.make("project-1"),
    title: id,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    persistent,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
  };
}

function readModel(threads: OrchestrationReadModel["threads"]): OrchestrationReadModel {
  return { snapshotSequence: 0, projects: [], threads, updatedAt: NOW };
}

it.layer(NodeServices.layer)("persistent thread decider", (it) => {
  it.effect("atomically replaces the persistent thread", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.persistence.set",
          commandId: CommandId.make("cmd-persist"),
          threadId: ThreadId.make("thread-new"),
          persistent: true,
        },
        readModel: readModel([thread("thread-old", true), thread("thread-new")]),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events[0]?.type).toBe("thread.persistence-changed");
      if (events[0]?.type === "thread.persistence-changed") {
        expect(events[0].payload).toMatchObject({
          persistentThreadId: "thread-new",
          replacedThreadId: "thread-old",
        });
      }
    }),
  );

  for (const type of ["thread.archive", "thread.delete"] as const) {
    it.effect(`blocks ${type} for the persistent thread`, () =>
      Effect.gen(function* () {
        const result = yield* Effect.flip(
          decideOrchestrationCommand({
            command: {
              type,
              commandId: CommandId.make(`cmd-${type}`),
              threadId: ThreadId.make("thread-persistent"),
            },
            readModel: readModel([thread("thread-persistent", true)]),
          }),
        );
        expect(result.message).toContain("cannot be");
        expect(result.message).toContain("persistence is disabled or moved");
      }),
    );
  }
});
