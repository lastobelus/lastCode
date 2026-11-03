import { scoreSubsequenceMatch } from "./searchRanking.ts";

/** Parent paths are derived for discovery; assignments remain exact strings. */
export function threadTagPaths(tag: string): string[] {
  const segments = tag.split("/");
  if (segments.some((segment) => segment.length === 0 || segment.trim() !== segment)) return [tag];
  return segments.map((_, index) => segments.slice(0, index + 1).join("/"));
}

/** Discovery is hierarchical; writes always use the original exact spelling. */
export function matchesThreadTag(
  tags: readonly string[] | undefined,
  tag: string,
  mode: "exact" | "subtree" = "subtree",
): boolean {
  return (
    tags?.some(
      (candidate) => candidate === tag || (mode === "subtree" && candidate.startsWith(`${tag}/`)),
    ) ?? false
  );
}

export function rankThreadTagVocabulary<T extends { readonly tag: string }>(
  entries: readonly T[],
  query = "",
  preferredTags: ReadonlySet<string> = new Set(),
): T[] {
  const needle = query.trim().replace(/^#/, "").toLowerCase();
  return entries
    .flatMap((item) => {
      const score = needle ? scoreSubsequenceMatch(item.tag.toLowerCase(), needle) : 0;
      return score === null ? [] : [{ item, score }];
    })
    .sort(
      (a, b) =>
        Number(preferredTags.has(b.item.tag)) - Number(preferredTags.has(a.item.tag)) ||
        a.score - b.score ||
        (a.item.tag < b.item.tag ? -1 : a.item.tag > b.item.tag ? 1 : 0),
    )
    .map(({ item }) => item);
}
