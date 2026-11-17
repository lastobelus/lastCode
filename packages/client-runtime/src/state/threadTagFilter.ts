import { type EnvironmentId, type ScopedThreadRef, type ThreadId } from "@t3tools/contracts";
import { threadKey } from "./entities.ts";
export {
  hiddenThreadKeys,
  visibilityParentKey,
  NO_HIDDEN_THREADS,
  type TagFilteredEnvironment,
} from "@t3tools/shared/threadTags";

/**
 * Pull request linked-thread rows the tag filter leaves visible. Loaded threads use the
 * parent-aware hidden set. Rows the shell leaves out carry no lineage, so while any
 * environment hides tags they stay out.
 */
export function visibleLinkedThreads<Row extends { readonly id: ThreadId }>(
  rows: ReadonlyArray<Row>,
  environmentId: EnvironmentId,
  loadedThreadRefs: ReadonlyArray<ScopedThreadRef>,
  hiddenKeys: ReadonlySet<string>,
  hidingAnywhere: boolean,
): ReadonlyArray<Row> {
  if (!hidingAnywhere && hiddenKeys.size === 0) return rows;
  const loaded = new Set(loadedThreadRefs.map((ref) => ref.threadId));
  return rows.filter((row) =>
    loaded.has(row.id)
      ? !hiddenKeys.has(threadKey({ environmentId, threadId: row.id }))
      : !hidingAnywhere,
  );
}
