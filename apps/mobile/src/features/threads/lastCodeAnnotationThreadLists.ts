import type { EnvironmentId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  isThreadAnnotationHidden,
  isThreadAnnotationVisibleInPalette,
} from "@t3tools/shared/threadAnnotation";

import { scopedThreadKey } from "../../lib/scopedEntities";
import { getThreadListV2OrderedSection } from "./threadListV2";
import { createThreadMovePlanner, type ThreadMoveDestination } from "./threadOrder";

export function filterLastCodeAnnotationThreadRows(
  threads: readonly EnvironmentThreadShell[],
  retainedThreadKey?: string | null,
): readonly EnvironmentThreadShell[] {
  const visible = threads.filter(
    (thread) =>
      !isThreadAnnotationHidden(thread.annotation) ||
      scopedThreadKey(thread.environmentId, thread.id) === retainedThreadKey,
  );
  return visible.length === threads.length ? threads : visible;
}

export function getLastCodeAnnotationOrderedSection(
  input: Parameters<typeof getThreadListV2OrderedSection>[0],
  retainedThreadKey?: string | null,
) {
  return getThreadListV2OrderedSection({
    ...input,
    threads: filterLastCodeAnnotationThreadRows(input.threads, retainedThreadKey),
  });
}

/** The palette supplies tag-filtered shells. A title query can only lift annotation hiding. */
export function filterLastCodeMobilePaletteThreads(
  threads: readonly EnvironmentThreadShell[],
  query: string,
) {
  const visible = threads.filter((thread) => isThreadAnnotationVisibleInPalette(thread, query));
  return visible.length === threads.length ? threads : visible;
}

export function planLastCodeAnnotationThreadMove(
  input: Parameters<typeof getThreadListV2OrderedSection>[0] & {
    readonly retainedThreadKey?: string | null | undefined;
    readonly reorderableEnvironmentIds: ReadonlySet<EnvironmentId>;
    readonly movedId: string;
    readonly direction: ThreadMoveDestination;
  },
) {
  const ordered = getLastCodeAnnotationOrderedSection(input, input.retainedThreadKey);
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
