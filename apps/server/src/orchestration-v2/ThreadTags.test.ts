import {
  CommandId,
  ProjectId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ThreadTags from "./ThreadTags.ts";

// Shell fixture fields below are the metadata read by this service. No transcript reads are supplied.
const shell = (id: string, projectId: string, tags: string[], archived = false) =>
  ({
    id: ThreadId.make(id),
    projectId: ProjectId.make(projectId),
    tags,
    deletedAt: null,
    archivedAt: archived ? "archived" : null,
    settledAt: "settled",
  }) as unknown as OrchestrationV2ThreadShell;
const active = [
  shell("a", "one", ["Work/client", "Work/client"]),
  shell("b", "two", ["Work", "worker"]),
  shell("c", "one", ["Work/client/deep"]),
];
const archived = [shell("d", "one", ["archived"], true)];
const testLayer = (commands: unknown[] = []) =>
  ThreadTags.layer.pipe(
    Layer.provide(
      Layer.succeed(ThreadManagement.ThreadManagementService, {
        getShellSnapshot: (
          input: Parameters<
            ThreadManagement.ThreadManagementService["Service"]["getShellSnapshot"]
          >[0],
        ) =>
          Effect.succeed({
            threads: active.filter(
              (t) => input?.projectId === undefined || t.projectId === input.projectId,
            ),
            archivedThreads: archived,
            snapshotSequence: 0,
          }),
        dispatch: (
          command: Parameters<ThreadManagement.ThreadManagementService["Service"]["dispatch"]>[0],
        ) =>
          Effect.sync(() => {
            commands.push(command);
            return { sequence: 42 };
          }),
      } as unknown as ThreadManagement.ThreadManagementService["Service"]),
    ),
  );

it.effect(
  "discovers settled-thread vocabulary, deduplicates counts, ranks preferred projects and pages",
  () =>
    Effect.gen(function* () {
      const tags = yield* ThreadTags.ThreadTags;
      expect(
        yield* tags.vocabulary({ preferredProjectId: ProjectId.make("one"), limit: 1 }),
      ).toEqual({ entries: [{ tag: "Work", count: 3, projectCount: 2 }], nextCursor: 1 });
      expect((yield* tags.vocabulary({ query: "Work/client" })).entries).toContainEqual({
        tag: "Work/client",
        count: 2,
        projectCount: 1,
      });
      expect((yield* tags.vocabulary({ query: "wcd" })).entries.map((e) => e.tag)).toEqual([
        "Work/client/deep",
      ]);
      expect((yield* tags.vocabulary({ archived: true })).entries).toEqual([
        { tag: "archived", count: 1, projectCount: 1 },
      ]);
    }).pipe(Effect.provide(testLayer())),
);

it.effect(
  "queries complete shells across projects and pages while exact matching stays narrow",
  () => {
    const commands: unknown[] = [];
    return Effect.gen(function* () {
      const tags = yield* ThreadTags.ThreadTags;
      const first = yield* tags.query({ tag: "Work", limit: 2 });
      expect(first.threads.map((t) => t.id)).toEqual(["a", "b"]);
      expect(first.nextCursor).toBe(2);
      expect((yield* tags.query({ tag: "Work", cursor: 2 })).threads.map((t) => t.id)).toEqual([
        "c",
      ]);
      expect((yield* tags.query({ tag: "Work", mode: "exact" })).threads.map((t) => t.id)).toEqual([
        "b",
      ]);
      expect(
        (yield* tags.query({ tag: "Work", projectId: ProjectId.make("one") })).threads.map(
          (t) => t.id,
        ),
      ).toEqual(["a", "c"]);
      expect(
        (yield* tags.query({ tag: "archived", archived: true })).threads.map((t) => t.id),
      ).toEqual(["d"]);
      yield* tags.set({
        threadId: ThreadId.make("a"),
        commandId: CommandId.make("remove"),
        tag: "Work",
        tagged: false,
      });
      expect(commands.at(-1)).toEqual({
        type: "thread.tag.set",
        threadId: "a",
        commandId: "remove",
        tag: "Work",
        tagged: false,
      });
    }).pipe(Effect.provide(testLayer(commands)));
  },
);
