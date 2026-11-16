import { scoreSubsequenceMatch } from "./searchRanking.ts";
import {
  isListedThreadLineage,
  type EnvironmentId,
  type OrchestrationV2ThreadShell,
  type ThreadTagVocabularyEntry,
} from "@t3tools/contracts";

type DiscoveryShell = Pick<
  OrchestrationV2ThreadShell,
  "id" | "title" | "tags" | "projectId" | "archivedAt" | "deletedAt" | "lineage" | "delegatedFrom"
>;

/** Existing removals also report changes to archived/omitted rows; text streaming is absent. */
export function threadTagDiscoveryRevision(input: {
  readonly generation: number;
  readonly removals: ReadonlyMap<string, number>;
  readonly snapshot: {
    readonly threads: readonly DiscoveryShell[];
    readonly archivedThreads?: readonly DiscoveryShell[];
  } | null;
}): string {
  return JSON.stringify([
    input.generation,
    [...input.removals],
    [...(input.snapshot?.threads ?? []), ...(input.snapshot?.archivedThreads ?? [])].map(
      (thread) => [
        thread.id,
        thread.title,
        thread.tags,
        thread.projectId,
        thread.archivedAt,
        thread.deletedAt,
        thread.lineage,
        thread.delegatedFrom,
      ],
    ),
  ]);
}

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

type FilterableThread = Pick<
  OrchestrationV2ThreadShell,
  "id" | "lineage" | "tags" | "delegatedFrom"
>;

export interface TagFilteredEnvironment {
  readonly environmentId: EnvironmentId;
  readonly threads: ReadonlyArray<FilterableThread>;
  /** Tags this environment hides, or null while its filter is off. */
  readonly hiddenTags: ReadonlyArray<string> | null;
}

export const NO_HIDDEN_THREADS: ReadonlySet<string> = new Set();

/** The thread a subagent, side chat or delegated task takes its visibility from, if any. */
export function visibilityParentKey(
  environmentId: EnvironmentId,
  thread: Pick<FilterableThread, "lineage" | "delegatedFrom">,
): string | null {
  const parentId = thread.lineage.parentThreadId;
  if (!isListedThreadLineage(thread.lineage) && parentId !== null) {
    return `${environmentId}\u0000${parentId}`;
  }
  return thread.delegatedFrom === undefined
    ? null
    : `${thread.delegatedFrom.environmentId}\u0000${thread.delegatedFrom.threadId}`;
}

function hasHiddenTag(
  tags: ReadonlyArray<string> | undefined,
  hiddenTags: ReadonlyArray<string> | null,
): boolean {
  return hiddenTags?.some((tag) => tags?.includes(tag) === true) === true;
}

/**
 * Keys of threads the tag filter hides. Children (subagents, side chats, delegated tasks) follow
 * their parent; while any environment hides tags, a child whose parent is not loaded stays hidden.
 * For a partial list such as an archive page, `alreadyHidden` and `loadedElsewhere` give the
 * hidden and loaded keys of live threads, and `hidingAnywhere` the global flag.
 */
export function hiddenThreadKeys(
  environments: ReadonlyArray<TagFilteredEnvironment>,
  alreadyHidden: ReadonlySet<string> = NO_HIDDEN_THREADS,
  loadedElsewhere: ReadonlySet<string> = NO_HIDDEN_THREADS,
  hidingAnywhere: boolean = environments.some((environment) => environment.hiddenTags !== null),
): ReadonlySet<string> {
  if (alreadyHidden.size === 0 && !hidingAnywhere) return NO_HIDDEN_THREADS;
  const byKey = new Map<
    string,
    { thread: FilterableThread; environment: TagFilteredEnvironment }
  >();
  for (const environment of environments) {
    for (const thread of environment.threads) {
      byKey.set(`${environment.environmentId}\u0000${thread.id}`, {
        thread,
        environment,
      });
    }
  }
  const hiddenByKey = new Map<string, boolean>();
  const isHidden = (key: string): boolean => {
    if (alreadyHidden.has(key)) return true;
    const known = hiddenByKey.get(key);
    if (known !== undefined) return known;
    const entry = byKey.get(key);
    if (entry === undefined) return false;
    const { thread, environment } = entry;
    const parentKey = visibilityParentKey(environment.environmentId, thread);
    const followsParent =
      parentKey !== null && (byKey.has(parentKey) || alreadyHidden.has(parentKey));
    if (parentKey !== null && !followsParent && loadedElsewhere.has(parentKey)) {
      hiddenByKey.set(key, false);
      return false;
    }
    if (parentKey !== null && !followsParent && hidingAnywhere) {
      hiddenByKey.set(key, true);
      return true;
    }
    if (!followsParent) {
      const hidden = hasHiddenTag(thread.tags, environment.hiddenTags);
      hiddenByKey.set(key, hidden);
      return hidden;
    }
    // Seed before following the parent so a malformed cycle ends visible.
    hiddenByKey.set(key, false);
    const hidden = isHidden(parentKey);
    hiddenByKey.set(key, hidden);
    return hidden;
  };
  const hidden = new Set<string>();
  for (const key of byKey.keys()) {
    if (isHidden(key)) hidden.add(key);
  }
  return hidden.size === 0 ? NO_HIDDEN_THREADS : hidden;
}

export function mergeThreadTagVocabulary(
  pages: readonly (readonly ThreadTagVocabularyEntry[])[],
  query = "",
): ThreadTagVocabularyEntry[] {
  const entries = new Map<string, ThreadTagVocabularyEntry>();
  for (const page of pages)
    for (const entry of page) {
      const previous = entries.get(entry.tag);
      entries.set(entry.tag, {
        tag: entry.tag,
        count: entry.count + (previous?.count ?? 0),
        projectCount: entry.projectCount + (previous?.projectCount ?? 0),
        preferredProject: entry.preferredProject === true || previous?.preferredProject === true,
      });
    }
  return rankThreadTagVocabulary(
    [...entries.values()],
    query,
    new Set(
      [...entries.values()].filter((entry) => entry.preferredProject).map((entry) => entry.tag),
    ),
  );
}

export function threadTagEnterSelection(input: {
  readonly candidate: string;
  readonly entries: readonly { readonly tag: string }[];
  readonly allowCreate: boolean;
  readonly canCreate: boolean;
  readonly highlighted: string | null;
}): string | undefined {
  if (
    input.highlighted !== null &&
    (input.entries.some((entry) => entry.tag === input.highlighted) ||
      (input.allowCreate && input.canCreate && input.highlighted === input.candidate))
  )
    return input.highlighted;
  if (input.allowCreate && input.candidate) {
    const exact = input.entries.find((entry) => entry.tag === input.candidate);
    if (exact) return exact.tag;
    if (input.canCreate) return input.candidate;
  }
  return input.entries[0]?.tag;
}
