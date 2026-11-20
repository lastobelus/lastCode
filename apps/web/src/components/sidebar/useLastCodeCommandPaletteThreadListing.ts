import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { isShownUnderParent } from "@t3tools/client-runtime/state/threads";
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
import { useLastCodeHiddenThreadKeys } from "./useLastCodeHiddenThreadKeys";

export function lastCodePaletteThreadPredicate(
  threads: readonly SidebarThreadSummary[],
  delegatedUnderParent: ReadonlySet<string>,
  hidden: ReadonlySet<string>,
  searchMissingOwners: boolean,
) {
  const availableOwners = searchMissingOwners
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
      hidden.has(scopedThreadKey(ref))
    )
      return false;
    if (!isShownUnderParent(ref, thread.lineage, delegatedUnderParent)) return true;
    if (hidden.size === 0 && availableOwners === null) return false;

    const owner = lastcodeSidebarOwnerRef(thread);
    if (owner === null) return false;
    const ownerKey = scopedThreadKey(owner);
    // A filtered owner is absent from the sidebar. For other missing owners, accept
    // explicit searches for tasks without adding them to the initial jump list.
    return hidden.has(ownerKey) || availableOwners?.has(ownerKey) === false;
  };
}

export function useLastCodeCommandPaletteThreadListing(query: string) {
  const lastCodeSidebar = useSidebarMode() === "lastcode";
  const allThreads = useThreadShells(lastCodeSidebar);
  const visibleThreads = useVisibleThreadShells(!lastCodeSidebar);
  const delegatedUnderParent = useDelegatedUnderParent();
  const hidden = useLastCodeHiddenThreadKeys(allThreads);
  if (!lastCodeSidebar) return { threads: visibleThreads, delegatedUnderParent };
  return {
    threads: allThreads,
    isThreadListed: lastCodePaletteThreadPredicate(
      allThreads,
      delegatedUnderParent,
      hidden,
      query.trim().length > 0,
    ),
  };
}
