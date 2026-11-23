import type { EnvironmentId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { isThreadAnnotationVisibleInPalette } from "@t3tools/shared/threadAnnotation";

import { scopedThreadKey } from "../../lib/scopedEntities";
import { getThreadListV2OrderedSection } from "./threadListV2";
import { createThreadMovePlanner, type ThreadMoveDestination } from "./threadOrder";

export function filterLastCodeAnnotationThreadRows(
  threads: readonly EnvironmentThreadShell[],
  hidden: ReadonlySet<string>,
  retainedThreadKey?: string | null,
): readonly EnvironmentThreadShell[] {
  if (hidden.size === 0) return threads;
  const visible = threads.filter((thread) => {
    const key = scopedThreadKey(thread.environmentId, thread.id);
    return key === retainedThreadKey || !hidden.has(key);
  });
  return visible.length === threads.length ? threads : visible;
}

export function getLastCodeAnnotationOrderedSection(
  input: Parameters<typeof getThreadListV2OrderedSection>[0],
  hidden: ReadonlySet<string>,
  retainedThreadKey?: string | null,
) {
  return getThreadListV2OrderedSection({
    ...input,
    threads: filterLastCodeAnnotationThreadRows(input.threads, hidden, retainedThreadKey),
  });
}

/** The palette supplies tag-filtered shells. A title query can only lift annotation hiding. */
export function filterLastCodeMobilePaletteThreads(
  threads: readonly EnvironmentThreadShell[],
  query: string,
  annotationHiddenThreadKeys: ReadonlySet<string>,
) {
  const visible = threads.filter((thread) =>
    isThreadAnnotationVisibleInPalette(
      thread,
      query,
      annotationHiddenThreadKeys.has(scopedThreadKey(thread.environmentId, thread.id)),
    ),
  );
  return visible.length === threads.length ? threads : visible;
}

export function planLastCodeAnnotationThreadMove(
  input: Parameters<typeof getThreadListV2OrderedSection>[0] & {
    readonly retainedThreadKey?: string | null | undefined;
    readonly annotationHiddenThreadKeys: ReadonlySet<string>;
    readonly reorderableEnvironmentIds: ReadonlySet<EnvironmentId>;
    readonly movedId: string;
    readonly direction: ThreadMoveDestination;
  },
) {
  const ordered = getLastCodeAnnotationOrderedSection(
    input,
    input.annotationHiddenThreadKeys,
    input.retainedThreadKey,
  );
  const assignments = createThreadMovePlanner({
    allThreads: input.threads,
    ordered,
    section: input.section,
    reorderableEnvironmentIds: input.reorderableEnvironmentIds,
  })(input.movedId, input.direction);
  if (assignments === null) return null;
  const crossSection = !ordered.some(
    (row) => scopedThreadKey(row.environmentId, row.id) === input.movedId,
  );
  return { ordered, assignments, crossSection };
}
