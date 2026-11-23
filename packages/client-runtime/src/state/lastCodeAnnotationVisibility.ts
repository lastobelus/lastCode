import { getThreadOwner } from "@t3tools/shared/threadOwnership";
import { isThreadAnnotationHidden } from "@t3tools/shared/threadAnnotation";
import { Atom } from "effect/reactivity";

import { scopeThreadRef, scopedThreadKey } from "../environment/scoped.ts";
import type { EnvironmentThreadShell } from "./models.ts";

const NO_ANNOTATION_HIDDEN_THREADS: ReadonlySet<string> = new Set();

type AnnotationVisibilityThread = Pick<
  EnvironmentThreadShell,
  | "id"
  | "environmentId"
  | "annotation"
  | "lineage"
  | "delegatedFrom"
  | "creatorOrigin"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
>;

export function getLastCodeAnnotationHiddenThreadKeys(
  threads: readonly AnnotationVisibilityThread[],
): ReadonlySet<string> {
  const remaining = threads.filter((thread) => isThreadAnnotationHidden(thread.annotation));
  if (remaining.length === 0) return NO_ANNOTATION_HIDDEN_THREADS;

  const childrenByOwner = new Map<string, AnnotationVisibilityThread[]>();
  for (const thread of threads) {
    const owner = getThreadOwner(thread, thread.environmentId);
    if (owner === null) continue;
    const key = scopedThreadKey(owner);
    const children = childrenByOwner.get(key);
    if (children) children.push(thread);
    else childrenByOwner.set(key, [thread]);
  }

  const seen = new Set<string>();
  const hidden = new Set<string>();
  for (const thread of remaining) {
    const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    if (seen.has(key)) continue;
    seen.add(key);
    if (!thread.hasPendingApprovals && !thread.hasPendingUserInput) hidden.add(key);
    const children = childrenByOwner.get(key);
    if (children) remaining.push(...children);
  }
  return hidden;
}

export function createLastCodeAnnotationHiddenThreadKeysAtom(
  threads: Atom.Atom<readonly EnvironmentThreadShell[]>,
) {
  let previous = NO_ANNOTATION_HIDDEN_THREADS;
  return Atom.make((get) => {
    const next = getLastCodeAnnotationHiddenThreadKeys(get(threads));
    if (next.size !== previous.size || ![...next].every((key) => previous.has(key)))
      previous = next;
    return previous;
  }).pipe(Atom.withLabel("lastcode-annotation-hidden-thread-keys"));
}
