import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { isShownUnderParent } from "@t3tools/client-runtime/state/threads";
import {
  isThreadAnnotationHidden,
  isThreadAnnotationVisibleInPalette,
} from "@t3tools/shared/threadAnnotation";
import { useSidebarMode } from "../../hooks/useSettings";
import {
  useDelegatedUnderParent,
  useThreadShells,
  useVisibleThreadShells,
} from "../../state/entities";
import type { SidebarThreadSummary } from "../../types";
import {
  lastcodeSidebarOwnerRef,
  lastcodeSidebarThreadKey,
} from "../lastcodeSidebarFamilies.logic";
import { useLastCodeTagHiddenThreadKeys } from "./useLastCodeHiddenThreadKeys";

export function lastCodePaletteThreadPredicate(
  threads: readonly SidebarThreadSummary[],
  delegatedUnderParent: ReadonlySet<string>,
  tagHidden: ReadonlySet<string>,
  query: string,
) {
  const annotationHidden = new Set(
    threads
      .filter((thread) => isThreadAnnotationHidden(thread.annotation))
      .map(lastcodeSidebarThreadKey),
  );
  const availableOwners =
    query.trim().length > 0
      ? new Set(
          threads
            .filter(
              (thread) =>
                thread.archivedAt === null &&
                thread.deletedAt === null &&
                thread.lineage.sideChat !== true,
            )
            .map(lastcodeSidebarThreadKey),
        )
      : null;
  return (thread: SidebarThreadSummary) => {
    const ref = scopeThreadRef(thread.environmentId, thread.id);
    if (
      thread.lineage.sideChat === true ||
      thread.deletedAt !== null ||
      tagHidden.has(scopedThreadKey(ref)) ||
      !isThreadAnnotationVisibleInPalette(thread, query)
    )
      return false;
    if (!isShownUnderParent(ref, thread.lineage, delegatedUnderParent)) return true;
    if (tagHidden.size === 0 && annotationHidden.size === 0 && availableOwners === null)
      return false;

    const owner = lastcodeSidebarOwnerRef(thread);
    if (owner === null) return false;
    const ownerKey = scopedThreadKey(owner);
    // A filtered owner is absent from the sidebar. For other missing owners, accept
    // explicit searches for tasks without adding them to the initial jump list.
    return (
      tagHidden.has(ownerKey) ||
      annotationHidden.has(ownerKey) ||
      availableOwners?.has(ownerKey) === false
    );
  };
}

export function useLastCodeCommandPaletteThreadListing(query: string) {
  const lastCodeSidebar = useSidebarMode() === "lastcode";
  const allThreads = useThreadShells(lastCodeSidebar);
  const visibleThreads = useVisibleThreadShells(!lastCodeSidebar);
  const delegatedUnderParent = useDelegatedUnderParent();
  const tagHidden = useLastCodeTagHiddenThreadKeys(allThreads);
  if (!lastCodeSidebar)
    return {
      threads: visibleThreads.filter((thread) => isThreadAnnotationVisibleInPalette(thread, query)),
      delegatedUnderParent,
    };
  return {
    threads: allThreads,
    isThreadListed: lastCodePaletteThreadPredicate(
      allThreads,
      delegatedUnderParent,
      tagHidden,
      query,
    ),
  };
}
