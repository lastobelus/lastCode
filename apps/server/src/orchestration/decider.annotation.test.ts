import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
  type ThreadAnnotation,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function makeReadModel(
  annotation: ThreadAnnotation | null = null,
  latestMessageId: string | null = "message-new",
): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
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
        annotation,
        deletedAt: null,
        messages:
          latestMessageId === null
            ? []
            : [
                {
                  id: MessageId.make(latestMessageId),
                  role: "user",
                  text: "Prompt",
                  turnId: null,
                  streaming: false,
                  createdAt: "2026-01-01T00:00:01.000Z",
                  updatedAt: "2026-01-01T00:00:01.000Z",
                },
              ],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ],
    updatedAt: NOW,
  };
}

const existingAnnotation: ThreadAnnotation = {
  body: "- [ ] Follow up",
  anchorMessageId: MessageId.make("message-old"),
  createdAt: "2025-12-30T00:00:00.000Z",
  updatedAt: "2025-12-31T00:00:00.000Z",
  resolvedAt: null,
};

it.layer(NodeServices.layer)("thread annotation decider", (it) => {
  it.effect("creates an annotation with server timestamps", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.annotation.upsert",
          commandId: CommandId.make("cmd-create"),
          threadId: ThreadId.make("thread-1"),
          body: "# Note",
        },
        readModel: makeReadModel(),
      });
      const first = Array.isArray(event) ? event[0] : event;
      expect(first?.type).toBe("thread.annotation-upserted");
      if (first?.type === "thread.annotation-upserted") {
        expect(first.payload.annotation.body).toBe("# Note");
        expect(first.payload.annotation.createdAt).toBe(first.payload.annotation.updatedAt);
        expect(first.payload.annotation.resolvedAt).toBeNull();
      }
    }),
  );

  it.effect("anchors from the projected marker without hydrated messages", () =>
    Effect.gen(function* () {
      const readModel = makeReadModel(null, null);
      const thread = readModel.threads[0];
      if (!thread) return;
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.annotation.upsert",
          commandId: CommandId.make("cmd-projected-anchor"),
          threadId: ThreadId.make("thread-1"),
          body: "# Note",
        },
        readModel: {
          ...readModel,
          threads: [
            {
              ...thread,
              latestUserMessageId: MessageId.make("message-projected"),
            },
          ],
        },
      });
      const first = Array.isArray(event) ? event[0] : event;
      if (first?.type === "thread.annotation-upserted") {
        expect(first.payload.annotation.anchorMessageId).toBe("message-projected");
      }
    }),
  );

  it.effect("edits without changing created or resolved state", () =>
    Effect.gen(function* () {
      const resolved = { ...existingAnnotation, resolvedAt: existingAnnotation.updatedAt };
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.annotation.upsert",
          commandId: CommandId.make("cmd-edit"),
          threadId: ThreadId.make("thread-1"),
          body: "Edited",
        },
        readModel: makeReadModel(resolved),
      });
      const first = Array.isArray(event) ? event[0] : event;
      if (first?.type === "thread.annotation-upserted") {
        expect(first.payload.annotation.createdAt).toBe(resolved.createdAt);
        expect(first.payload.annotation.resolvedAt).toBe(resolved.resolvedAt);
        expect(first.payload.annotation.anchorMessageId).toBe("message-new");
      }
    }),
  );

  it.effect("keeps an existing anchor when a revert removes every user message", () =>
    Effect.gen(function* () {
      const editedEvent = yield* decideOrchestrationCommand({
        command: {
          type: "thread.annotation.upsert",
          commandId: CommandId.make("cmd-edit-after-empty-revert"),
          threadId: ThreadId.make("thread-1"),
          body: "Edited after revert",
        },
        readModel: makeReadModel(existingAnnotation, null),
      });
      const edited = Array.isArray(editedEvent) ? editedEvent[0] : editedEvent;
      expect(edited?.type).toBe("thread.annotation-upserted");
      if (edited?.type !== "thread.annotation-upserted") return;
      expect(edited.payload.annotation.anchorMessageId).toBe(existingAnnotation.anchorMessageId);

      const resolvedEvent = yield* decideOrchestrationCommand({
        command: {
          type: "thread.annotation.resolve",
          commandId: CommandId.make("cmd-resolve-after-empty-revert"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel(edited.payload.annotation, null),
      });
      const resolved = Array.isArray(resolvedEvent) ? resolvedEvent[0] : resolvedEvent;
      expect(resolved?.type).toBe("thread.annotation-resolved");
      if (resolved?.type !== "thread.annotation-resolved") return;
      expect(resolved.payload.annotation.anchorMessageId).toBe(existingAnnotation.anchorMessageId);

      const reopenedEvent = yield* decideOrchestrationCommand({
        command: {
          type: "thread.annotation.reopen",
          commandId: CommandId.make("cmd-reopen-after-empty-revert"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel(resolved.payload.annotation, null),
      });
      const reopened = Array.isArray(reopenedEvent) ? reopenedEvent[0] : reopenedEvent;
      expect(reopened?.type).toBe("thread.annotation-reopened");
      if (reopened?.type === "thread.annotation-reopened") {
        expect(reopened.payload.annotation.anchorMessageId).toBe(
          existingAnnotation.anchorMessageId,
        );
      }
    }),
  );

  it.effect("resolve and reopen move the anchor and timestamp without changing the body", () =>
    Effect.gen(function* () {
      const resolvedEvent = yield* decideOrchestrationCommand({
        command: {
          type: "thread.annotation.resolve",
          commandId: CommandId.make("cmd-resolve"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel(existingAnnotation, "message-resolved"),
      });
      const resolved = Array.isArray(resolvedEvent) ? resolvedEvent[0] : resolvedEvent;
      if (resolved?.type !== "thread.annotation-resolved") return;
      expect(resolved.payload.annotation.body).toBe(existingAnnotation.body);
      expect(resolved.payload.annotation.anchorMessageId).toBe("message-resolved");
      expect(resolved.payload.annotation.resolvedAt).toBe(resolved.payload.annotation.updatedAt);

      const reopenedEvent = yield* decideOrchestrationCommand({
        command: {
          type: "thread.annotation.reopen",
          commandId: CommandId.make("cmd-reopen"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel(resolved.payload.annotation, "message-reopened"),
      });
      const reopened = Array.isArray(reopenedEvent) ? reopenedEvent[0] : reopenedEvent;
      if (reopened?.type === "thread.annotation-reopened") {
        expect(reopened.payload.annotation.body).toBe(existingAnnotation.body);
        expect(reopened.payload.annotation.anchorMessageId).toBe("message-reopened");
        expect(reopened.payload.annotation.resolvedAt).toBeNull();
      }
    }),
  );

  it.effect("rejects resolving a missing annotation", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(
        decideOrchestrationCommand({
          command: {
            type: "thread.annotation.resolve",
            commandId: CommandId.make("cmd-missing"),
            threadId: ThreadId.make("thread-1"),
          },
          readModel: makeReadModel(),
        }),
      );
      expect(result._tag).toBe("Failure");
    }),
  );

  it.effect("rejects annotations on a thread without a user message", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(
        decideOrchestrationCommand({
          command: {
            type: "thread.annotation.upsert",
            commandId: CommandId.make("cmd-no-anchor"),
            threadId: ThreadId.make("thread-1"),
            body: "Note",
          },
          readModel: makeReadModel(null, null),
        }),
      );
      expect(result._tag).toBe("Failure");
    }),
  );
});
