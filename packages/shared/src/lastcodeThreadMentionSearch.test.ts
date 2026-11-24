import fuzzysort from "fuzzysort";
import { describe, expect, it } from "vite-plus/test";

import {
  rankThreadMentions,
  type ThreadMentionSearchSubject,
} from "./lastcodeThreadMentionSearch.ts";

function rank(query: string, subjects: ReadonlyArray<ThreadMentionSearchSubject>) {
  return rankThreadMentions(query, subjects, (subject) => subject);
}

describe("thread mention ranking", () => {
  it("ranks a literal match alongside gap-tolerant ordered fragments", () => {
    const exact = { title: "Why42" };
    const fuzzy = { title: "Why Thread 42 Is Stuck" };
    const outOfOrder = { title: "42 Why" };
    expect(rank("wHy42", [fuzzy, outOfOrder, exact])).toEqual([exact, fuzzy]);
  });

  it("requires the full query in one field and ignores empty queries", () => {
    const split = { title: "alpha", projectTitle: "beta" };
    const together = { title: "alpha beta" };
    expect(rank("alpha beta", [split, together])).toEqual([together]);
    expect(rank("", [together])).toEqual([]);
    expect(rank(" \t ", [together])).toEqual([]);
  });

  it("uses fuzzysort's case, accent, and apostrophe handling", () => {
    const subject = { title: "Café’s Review" };
    expect(rank("CAFE'S", [subject])).toEqual([subject]);
    expect(rank("cafes", [subject])).toEqual([subject]);
  });

  it("searches actual IDs, project and environment labels, and pull request metadata", () => {
    const subject = {
      id: "ab12cd34ef56",
      title: "Unrelated",
      projectTitle: "Orchard",
      environmentLabel: "Workstation",
      pullRequests: [
        {
          number: 12345,
          title: "Improve harvest",
          references: ["example/garden#12345", "https://example.com/garden/pull/12345"],
        },
      ],
    };
    for (const query of [
      "ab12",
      "orchard",
      "workstation",
      "harvest",
      "1234",
      "garden#1234",
      "example.com/garden/pull/12345",
      "pr 12345",
      "pr12345",
      "pull request 12345",
      "pull 12345",
      "#12345",
    ]) {
      expect(rank(query, [subject]), query).toEqual([subject]);
    }
  });

  it("removes worktree prefixes from branches and queries", () => {
    const nested = { title: "Unrelated", branch: "t3/orchard" };
    const legacy = { title: "Unrelated", branch: "t3code/garden" };
    const flat = { title: "Unrelated", branch: "t3-abcd1234" };
    expect(rank("orchard", [nested])).toEqual([nested]);
    expect(rank("t3/orchard", [nested])).toEqual([nested]);
    expect(rank("t3code/garden", [legacy])).toEqual([legacy]);
    expect(rank("t3-abcd", [flat])).toEqual([flat]);
  });

  it("keeps low-scoring matches and more than ten tied candidates in input order", () => {
    const weak = { title: `a${"x".repeat(1000)}z` };
    const strong = { title: "az" };
    const ties = Array.from({ length: 12 }, (_, index) => ({ title: "az", index }));
    expect(fuzzysort.single("az", weak.title)!.score).toBeLessThan(0.5);
    expect(rank("az", [weak, strong, ...ties])).toEqual([strong, ...ties, weak]);
  });
});
