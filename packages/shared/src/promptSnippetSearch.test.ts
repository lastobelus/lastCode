import { describe, expect, it } from "vite-plus/test";
import type { PromptSnippet } from "@t3tools/contracts";
import { promptSnippetWordAtCursor, searchPromptSnippets } from "./promptSnippetSearch.ts";

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

describe("promptSnippetWordAtCursor", () => {
  it("returns the entire word and UTF-16 replacement span around the caret", () => {
    for (const [value, cursor, query, start, end] of [
      ["review", 1, "review", 0, 6],
      ["review", 6, "review", 0, 6],
      ["go review now", 5, "review", 3, 9],
      ["éclair_42", 2, "éclair_42", 0, 9],
      ["📝 𐐀é_42!", 5, "𐐀é_42", 3, 10],
    ] as const) {
      const word = promptSnippetWordAtCursor(value, cursor);
      expect(word).toEqual({ query, start, end });
      expect(value.slice(word!.start, word!.end)).toBe(query);
    }
  });

  it("preserves surrounding Unicode text when replacing the returned span", () => {
    const value = "📝 𐐀é_42! next";
    const word = promptSnippetWordAtCursor(value, 5)!;
    expect(value.slice(0, word.start) + "chosen" + value.slice(word.end)).toBe("📝 chosen! next");
  });

  it("requires a letter immediately left of a valid caret", () => {
    for (const [value, cursor] of [
      ["", 0],
      ["word", 0],
      ["word ", 5],
      ["word.", 5],
      ["word2", 5],
      ["word_", 5],
      ["é", 2],
      ["𐐀", 1],
      ["word", -1],
      ["word", 5],
      ["word", 1.5],
      ["word", NaN],
    ] as const) {
      expect(promptSnippetWordAtCursor(value, cursor)).toBeNull();
    }
  });
});
