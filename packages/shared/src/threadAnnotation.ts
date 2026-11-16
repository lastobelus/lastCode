import type { OrchestrationV2AppThread } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

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
