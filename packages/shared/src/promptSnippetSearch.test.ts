import { describe, expect, it } from "vite-plus/test";
import type { PromptSnippet } from "@t3tools/contracts";
import { searchPromptSnippets } from "./promptSnippetSearch.ts";

function snippet(id: string, text: string, overrides: Partial<PromptSnippet> = {}): PromptSnippet {
  return { id, title: text, text, useCount: 0, lastUsedAt: null, queryUses: [], ...overrides };
}

describe("common prompt ranking", () => {
  it("matches abbreviations and excludes unrelated prompts", () => {
    const entries = [snippet("review", "Review this pull request"), snippet("test", "Run tests")];
    expect(searchPromptSnippets(entries, "rvpr").map((entry) => entry.id)).toEqual(["review"]);
    expect(searchPromptSnippets(entries, "zzzz")).toEqual([]);
  });

  it("learns a chosen abbreviation without letting global popularity hide other matches", () => {
    const entries = [
      snippet("review", "Review the changes", { useCount: 100 }),
      snippet("ready", "Ready for QA", { queryUses: [{ query: "rv", count: 3 }] }),
    ];
    expect(searchPromptSnippets(entries, " RV ").map((entry) => entry.id)).toEqual([
      "ready",
      "review",
    ]);
    expect(searchPromptSnippets(entries, "review").map((entry) => entry.id)).toEqual(["review"]);
  });

  it("recalls a learned query after rewording and sorts an empty query by usage", () => {
    const entries = [
      snippet("test", "Run focused tests", { useCount: 1 }),
      snippet("merge", "Land the reviewed changes", {
        useCount: 5,
        queryUses: [{ query: "ship", count: 2 }],
      }),
    ];
    expect(searchPromptSnippets(entries, "ship").map((entry) => entry.id)).toEqual(["merge"]);
    expect(searchPromptSnippets(entries, "", 1).map((entry) => entry.id)).toEqual(["merge"]);
    expect(searchPromptSnippets(entries, "", 0)).toEqual([]);
  });
});
