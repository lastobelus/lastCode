import type { OrchestrationV2AppThread, ThreadAnnotation } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export function threadAnnotationAuthoredBody(annotation: ThreadAnnotation | null | undefined) {
  return annotation?.bodyGenerated === true ? "" : (annotation?.body ?? "");
}

export function isThreadAnnotationHidden(annotation: ThreadAnnotation | null | undefined) {
  return annotation?.resolvedAt === null && annotation.hideUntil !== undefined;
}

export function isThreadAnnotationVisibleInPalette(
  thread: { readonly annotation?: ThreadAnnotation | null | undefined; readonly title: string },
  query: string,
): boolean {
  if (!isThreadAnnotationHidden(thread.annotation)) return true;
  const titleQuery = query.trim().toLowerCase();
  return titleQuery.length > 0 && thread.title.toLowerCase().includes(titleQuery);
}

export function threadAnnotationRevealAt(annotation: ThreadAnnotation | null | undefined) {
  return annotation?.resolvedAt === null ? annotation.reveal?.at : undefined;
}

export function isThreadAnnotationRevealUnseen(
  annotation: ThreadAnnotation | null | undefined,
  lastVisitedAt?: string | null,
) {
  const revealAt = threadAnnotationRevealAt(annotation);
  return (
    revealAt !== undefined &&
    (lastVisitedAt == null || Date.parse(revealAt) > Date.parse(lastVisitedAt))
  );
}

/** Unchanged notes predating a child were copied from its parent; later child writes remain independent. */
export function threadAnnotationOf(
  thread: Pick<
    OrchestrationV2AppThread,
    "annotation" | "createdAt" | "lineage" | "creatorThreadId"
  >,
) {
  const annotation = thread.annotation ?? null;
  if (
    annotation === null ||
    (thread.lineage.relationshipToParent !== "subagent" && thread.creatorThreadId === undefined)
  )
    return annotation;
  const createdAt = DateTime.toEpochMillis(thread.createdAt);
  const noteCreatedAt = Date.parse(annotation.createdAt);
  const noteUpdatedAt = Date.parse(annotation.updatedAt);
  return noteCreatedAt < createdAt && noteUpdatedAt <= createdAt ? null : annotation;
}

export function threadAnnotationId(annotation: Pick<ThreadAnnotation, "id" | "createdAt">): string {
  return annotation.id ?? `legacy:${annotation.createdAt}`;
}

export function threadAnnotationEntries(
  annotation: ThreadAnnotation | null,
): readonly ThreadAnnotation[] {
  if (annotation === null) return [];
  const entries: readonly ThreadAnnotation[] = [annotation, ...(annotation.otherAnnotations ?? [])];
  return entries.map((entry) => {
    const { otherAnnotations: _others, ...note } = entry;
    return { ...note, id: threadAnnotationId(note) };
  });
}

export function threadAnnotationsOf(thread: Parameters<typeof threadAnnotationOf>[0]) {
  return threadAnnotationEntries(thread.annotation ?? null)
    .filter((entry) => threadAnnotationOf({ ...thread, annotation: entry }) !== null)
    .map((entry) => ({ ...entry, id: threadAnnotationId(entry) }));
}

export function threadAnnotationById(
  thread: Parameters<typeof threadAnnotationOf>[0],
  annotationId?: string,
) {
  const entries = threadAnnotationsOf(thread);
  if (annotationId !== undefined) return entries.find((entry) => entry.id === annotationId) ?? null;
  const current = threadAnnotationOf(thread);
  if (current === null) return null;
  return entries.find((entry) => entry.id === threadAnnotationId(current)) ?? null;
}
