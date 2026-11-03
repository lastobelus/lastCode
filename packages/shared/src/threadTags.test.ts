import { expect, it } from "@effect/vitest";
import {
  matchesThreadTag,
  rankThreadTagVocabulary,
  threadTagPaths,
  threadTagDiscoveryRevision,
} from "./threadTags.ts";
import { ThreadId, ProjectId } from "@t3tools/contracts";

it("matches slash-bounded descendants with exact case and an exact-only mode", () => {
  expect(matchesThreadTag(["work/client"], "work")).toBe(true);
  expect(matchesThreadTag(["worker", "Work/client"], "work")).toBe(false);
  expect(matchesThreadTag(["work/client"], "work", "exact")).toBe(false);
  expect(matchesThreadTag(["work"], "work", "exact")).toBe(true);
  expect(matchesThreadTag(undefined, "work")).toBe(false);
  expect(threadTagPaths("work/client/deep")).toEqual(["work", "work/client", "work/client/deep"]);
  expect(threadTagPaths("legacy//literal")).toEqual(["legacy//literal"]);
});
it("fuzzily discovers exact spellings and ranks project vocabulary first", () => {
  const entries = [{ tag: "Work/Client" }, { tag: "WC" }, { tag: "other" }];
  expect(rankThreadTagVocabulary(entries, "#wc", new Set(["Work/Client"]))).toEqual(
    entries.slice(0, 2),
  );
  expect(entries[0]?.tag).toBe("Work/Client");
});

it("refreshes renamed and omitted metadata without reacting to streamed activity", () => {
  const shell = {
    id: ThreadId.make("thread"),
    title: "Before",
    tags: ["work/client"],
    projectId: ProjectId.make("project"),
    archivedAt: null,
    deletedAt: null,
    lineage: {
      rootThreadId: ThreadId.make("thread"),
      parentThreadId: null,
      relationshipToParent: null,
    },
  };
  const initial = {
    generation: 1,
    removals: new Map<string, number>(),
    snapshot: { threads: [shell] },
  };
  const before = threadTagDiscoveryRevision(initial);
  expect(
    threadTagDiscoveryRevision({
      ...initial,
      snapshot: { threads: [{ ...shell, title: "After" }] },
    }),
  ).not.toBe(before);
  expect(
    threadTagDiscoveryRevision({
      ...initial,
      snapshot: { threads: [{ ...shell, tags: ["other"] }] },
    }),
  ).not.toBe(before);
  expect(
    threadTagDiscoveryRevision({ ...initial, removals: new Map([["omitted-archive-thread", 42]]) }),
  ).not.toBe(before);
  const streaming = { ...shell, itemCount: 99 };
  expect(threadTagDiscoveryRevision({ ...initial, snapshot: { threads: [streaming] } })).toBe(
    before,
  );
});
