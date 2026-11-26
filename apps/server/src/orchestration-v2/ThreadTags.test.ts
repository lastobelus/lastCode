import {
  EnvironmentId,
  type ThreadTagVocabularyInput,
  ProjectId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as DateTime from "effect/DateTime";
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
    updatedAt: DateTime.makeUnsafe(id === "a" ? "2026-06-01T00:00:00Z" : "2026-06-02T00:00:00Z"),
    lineage: { rootThreadId: id, parentThreadId: null, relationshipToParent: null },
  }) as unknown as OrchestrationV2ThreadShell;
const active = [
  shell("a", "one", ["Work/client", "Work/client"]),
  shell("b", "two", ["Work", "worker"]),
  shell("c", "one", ["Work/client/deep"]),
];
const archived = [shell("d", "one", ["archived"], true)];
const testLayer = (shells = active) =>
  ThreadTags.layer.pipe(
    Layer.provide(
      Layer.succeed(ThreadManagement.ThreadManagementService, {
        getShellSnapshot: (
          input: Parameters<
            ThreadManagement.ThreadManagementService["Service"]["getShellSnapshot"]
          >[0],
        ) =>
          Effect.succeed({
            threads: shells.filter(
              (t) => input?.projectId === undefined || t.projectId === input.projectId,
            ),
            archivedThreads: archived,
            snapshotSequence: 73,
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
  () =>
    Effect.gen(function* () {
      const tags = yield* ThreadTags.ThreadTags;
      const first = yield* tags.query({ tag: "Work", limit: 2 });
      expect(first).toHaveProperty("snapshotSequence", 73);
      expect(first.threads.map((t) => t.id)).toEqual(["b", "c"]);
      expect(first.nextCursor).toBe(2);
      expect((yield* tags.query({ tag: "Work", cursor: 2 })).threads.map((t) => t.id)).toEqual([
        "a",
      ]);
      expect((yield* tags.query({ tag: "Work", mode: "exact" })).threads.map((t) => t.id)).toEqual([
        "b",
      ]);
      expect(
        (yield* tags.query({ tag: "Work", projectId: ProjectId.make("one") })).threads.map(
          (t) => t.id,
        ),
      ).toEqual(["c", "a"]);
      expect(
        (yield* tags.query({ tag: "archived", archived: true })).threads.map((t) => t.id),
      ).toEqual(["d"]);
    }).pipe(Effect.provide(testLayer())),
);

it.effect("filters canonical vocabulary before counting using parent-aware UI privacy", () => {
  const local = EnvironmentId.make("local");
  const child = (id: string, parent: string, tags: string[], remote = false) => ({
    ...shell(id, "one", tags),
    lineage: {
      rootThreadId: ThreadId.make(id),
      parentThreadId: remote ? null : ThreadId.make(parent),
      relationshipToParent: remote ? null : ("subagent" as const),
    },
    ...(remote
      ? {
          delegatedFrom: {
            environmentId: EnvironmentId.make("remote"),
            threadId: ThreadId.make(parent),
            title: "Parent",
          },
        }
      : {}),
  });
  const shells = [
    shell("private", "two", ["private", "leaked/path", "shared"]),
    shell("visible", "one", ["shared", "public"]),
    child("nested", "private", ["nested-secret"]),
    child("remote-hidden", "hidden", ["remote-secret"], true),
    child("remote-visible", "visible", ["private", "remote-public"], true),
    child("remote-missing", "missing", ["missing-secret"], true),
    {
      ...child("independent", "hidden", ["independent"], true),
      lineage: { ...shell("independent", "one", []).lineage, independent: true as const },
    },
  ];
  return Effect.gen(function* () {
    const tags = yield* ThreadTags.ThreadTags;
    const input = {
      preferredProjectId: ProjectId.make("one"),
      uiVisibility: {
        environmentId: local,
        hiddenTags: ["private"],
        hiddenThreadKeys: ["remote\u0000hidden"],
        loadedThreadKeys: ["remote\u0000hidden", "remote\u0000visible"],
        hidingAnywhere: true,
      },
    } satisfies ThreadTagVocabularyInput;
    const first = yield* tags.vocabulary({ ...input, limit: 1 });
    expect(first.entries).toHaveLength(1);
    expect(first.nextCursor).toBe(1);
    const result = yield* tags.vocabulary(input);
    expect(result.nextCursor).toBeNull();
    expect(result.entries.map((entry) => entry.tag)).toEqual([
      "independent",
      "private",
      "public",
      "remote-public",
      "shared",
    ]);
    expect(result.entries.find((entry) => entry.tag === "shared")?.count).toBe(1);
    expect(
      (yield* tags.vocabulary({ ...input, projectId: ProjectId.make("one") })).entries,
    ).toEqual(result.entries);
    expect((yield* tags.vocabulary({})).entries.some((entry) => entry.tag === "leaked/path")).toBe(
      true,
    );
  }).pipe(Effect.provide(testLayer(shells)));
});
