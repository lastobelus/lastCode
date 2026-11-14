import fuzzysort from "fuzzysort";

export interface ThreadMentionSearchSubject {
  readonly id?: string;
  readonly title: string;
  readonly branch?: string | null;
  readonly projectTitle?: string | null;
  readonly environmentLabel?: string | null;
  readonly pullRequests?: ReadonlyArray<{
    readonly number: number;
    readonly title?: string | null;
    readonly references?: ReadonlyArray<string>;
  }>;
}

const BRANCH_PREFIX = /^(?:(?:t3|t3code)\/(?=\S)|t3-(?=[0-9a-f]{8}$))/i;
const FLAT_QUERY_PREFIX = /(^| )t3-(?=[0-9a-f]{1,8}(?: |$))/gi;

/** Rank each item by its best complete-query match in any one field. */
export function rankThreadMentions<T>(
  query: string,
  items: ReadonlyArray<T>,
  subjectOf: (item: T) => ThreadMentionSearchSubject,
): T[] {
  const search = query
    .trim()
    .replace(/^(?:pr|pull request|pull)\s*(?=#?\d)/i, "")
    .replace(/^#\s*/, "")
    .replace(BRANCH_PREFIX, "")
    .replace(FLAT_QUERY_PREFIX, "$1");
  if (!search) return [];

  const ranked: Array<{ item: T; score: number; index: number }> = [];
  items.forEach((item, index) => {
    const subject = subjectOf(item);
    const fields: Array<string | null | undefined> = [
      subject.title,
      subject.id,
      subject.branch?.replace(BRANCH_PREFIX, ""),
      subject.projectTitle,
      subject.environmentLabel,
    ];
    for (const pullRequest of subject.pullRequests ?? []) {
      fields.push(String(pullRequest.number), pullRequest.title, ...(pullRequest.references ?? []));
    }
    let best: number | null = null;
    for (const field of fields) {
      if (!field) continue;
      // Raw strings enter fuzzysort's unbounded global target cache.
      const match = fuzzysort.single(search, fuzzysort.prepare(field));
      if (match !== null && (best === null || match.score > best)) best = match.score;
    }
    if (best !== null) ranked.push({ item, score: best, index });
  });
  ranked.sort((left, right) => right.score - left.score || left.index - right.index);
  return ranked.map(({ item }) => item);
}
