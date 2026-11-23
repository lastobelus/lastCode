import { getThreadOwner } from "@t3tools/shared/threadOwnership";
import { isThreadAnnotationHidden } from "@t3tools/shared/threadAnnotation";
import { Atom } from "effect/reactivity";

import { scopeThreadRef, scopedThreadKey } from "../environment/scoped.ts";
import type { EnvironmentThreadShell } from "./models.ts";

const NO_ANNOTATION_HIDDEN_THREADS: ReadonlySet<string> = new Set();
const EMPTY_VISIBILITY = {
  hiddenThreadKeys: NO_ANNOTATION_HIDDEN_THREADS,
  pendingChildThreadKeys: NO_ANNOTATION_HIDDEN_THREADS,
};

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
  | "pendingSubagentRequest"
>;

function needsOwnAnswer(thread: AnnotationVisibilityThread) {
  return thread.hasPendingApprovals || thread.hasPendingUserInput;
}

function needsAnswer(thread: AnnotationVisibilityThread) {
  return needsOwnAnswer(thread) || thread.pendingSubagentRequest != null;
}

export function getLastCodeAnnotationVisibility(threads: readonly AnnotationVisibilityThread[]) {
  const remaining = threads.filter((thread) => isThreadAnnotationHidden(thread.annotation));
  if (remaining.length === 0) return EMPTY_VISIBILITY;

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
  const pendingChildren = new Set<string>();
  for (const thread of remaining) {
    const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    if (seen.has(key)) continue;
    seen.add(key);
    if (!needsAnswer(thread)) hidden.add(key);
    const children = childrenByOwner.get(key);
    if (!children) continue;
    for (const child of children) {
      remaining.push(child);
      // The parent's request indicator can be for this same child.
      if (!needsOwnAnswer(thread) && needsAnswer(child)) {
        pendingChildren.add(scopedThreadKey(scopeThreadRef(child.environmentId, child.id)));
      }
    }
  }
  return { hiddenThreadKeys: hidden, pendingChildThreadKeys: pendingChildren };
}

function reuseThreadKeys(previous: ReadonlySet<string>, next: ReadonlySet<string>) {
  return previous.size === next.size && [...next].every((key) => previous.has(key))
    ? previous
    : next;
}

export function createLastCodeAnnotationVisibilityAtom(
  threads: Atom.Atom<readonly EnvironmentThreadShell[]>,
) {
  let previous = EMPTY_VISIBILITY;
  return Atom.make((get) => {
    const next = getLastCodeAnnotationVisibility(get(threads));
    const hiddenThreadKeys = reuseThreadKeys(previous.hiddenThreadKeys, next.hiddenThreadKeys);
    const pendingChildThreadKeys = reuseThreadKeys(
      previous.pendingChildThreadKeys,
      next.pendingChildThreadKeys,
    );
    if (
      hiddenThreadKeys !== previous.hiddenThreadKeys ||
      pendingChildThreadKeys !== previous.pendingChildThreadKeys
    )
      previous = { hiddenThreadKeys, pendingChildThreadKeys };
    return previous;
  }).pipe(Atom.withLabel("lastcode-annotation-visibility"));
}
