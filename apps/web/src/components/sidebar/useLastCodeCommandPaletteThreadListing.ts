import { useSidebarMode } from "../../hooks/useSettings";
import {
  useDelegatedUnderParent,
  useThreadShells,
  useVisibleThreadShells,
} from "../../state/entities";
import type { SidebarThreadSummary } from "../../types";
import { lastcodeSidebarThreadKey } from "../lastcodeSidebarFamilies.logic";
import { useLastCodeHiddenThreadKeys } from "./useLastCodeHiddenThreadKeys";

export function useLastCodeCommandPaletteThreadListing() {
  const lastCodeSidebar = useSidebarMode() === "lastcode";
  const allThreads = useThreadShells(lastCodeSidebar);
  const visibleThreads = useVisibleThreadShells(!lastCodeSidebar);
  const delegatedUnderParent = useDelegatedUnderParent();
  const hidden = useLastCodeHiddenThreadKeys(allThreads);
  if (!lastCodeSidebar) return { threads: visibleThreads, delegatedUnderParent };
  return {
    threads: allThreads,
    isThreadListed: (thread: SidebarThreadSummary) =>
      thread.lineage.sideChat !== true &&
      thread.deletedAt === null &&
      !hidden.has(lastcodeSidebarThreadKey(thread)),
  };
}
