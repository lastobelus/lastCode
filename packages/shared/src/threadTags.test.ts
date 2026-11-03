import { expect, it } from "@effect/vitest";
import { matchesThreadTag, rankThreadTagVocabulary, threadTagPaths } from "./threadTags.ts";

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
