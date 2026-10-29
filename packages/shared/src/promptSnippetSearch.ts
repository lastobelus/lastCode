import type { PromptSnippet } from "@t3tools/contracts";
import { normalizeSearchQuery, scoreQueryMatch } from "./searchRanking.ts";

function normalizeQuery(query: string): string {
  return normalizeSearchQuery(query).replace(/\s+/gu, " ");
}

/** A remembered abbreviation remains useful even when discovery improves the wording. */
export function searchPromptSnippets(
  snippets: ReadonlyArray<PromptSnippet>,
  query: string,
  limit = 50,
): PromptSnippet[] {
  const normalizedQuery = normalizeQuery(query);
  const ranked: Array<{ snippet: PromptSnippet; learned: number; score: number }> = [];
  for (const snippet of snippets) {
    let learned = 0;
    for (const use of snippet.queryUses) {
      const remembered = normalizeQuery(use.query);
      if (remembered && remembered === normalizedQuery) {
        learned += use.count;
      }
    }
    const scores = [snippet.title, snippet.text].map((value) =>
      scoreQueryMatch({
        value: value.toLowerCase(),
        query: normalizedQuery,
        exactBase: 0,
        prefixBase: 10,
        boundaryBase: 30,
        includesBase: 60,
        fuzzyBase: 100,
      }),
    );
    const matches = scores.filter((score): score is number => score !== null);
    if (normalizedQuery && learned === 0 && matches.length === 0) continue;
    ranked.push({ snippet, learned, score: matches.length > 0 ? Math.min(...matches) : 0 });
  }
  return ranked
    .sort(
      (left, right) =>
        right.learned - left.learned ||
        left.score - right.score ||
        right.snippet.useCount - left.snippet.useCount ||
        (right.snippet.lastUsedAt ?? "").localeCompare(left.snippet.lastUsedAt ?? "") ||
        left.snippet.title.localeCompare(right.snippet.title) ||
        left.snippet.id.localeCompare(right.snippet.id),
    )
    .slice(0, Math.max(0, limit))
    .map(({ snippet }) => snippet);
}
