import { useShallow } from "zustand/react/shallow";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useClientSetting } from "../../hooks/useSettings";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useThreadShellsForProjectRefs } from "../../state/entities";
import { useUiStateStore } from "../../uiStateStore";
import { lastcodeSidebarSubagentGroupKey } from "../lastcodeSidebarFamilies.logic";
import { useCollapsedLastCodeSidebarFamilies } from "../lastcodeSidebarFamilies.store";
import {
  lastCodeProjectThreadStatus,
  projectLastCodeProjectThreads,
} from "./lastcodeProjectThreads";

export function useLastCodeProjectThreads(
  project: Pick<SidebarProjectSnapshot, "memberProjectRefs">,
  activeThreadKey: string | null,
  projectExpanded: boolean,
  listExpanded: boolean,
) {
  const threads = useThreadShellsForProjectRefs(project.memberProjectRefs);
  const sortOrder = useClientSetting("sidebarThreadSortOrder");
  const previewCount = useClientSetting("sidebarThreadPreviewCount");
  const groupingStyle = useClientSetting("legacySidebarThreadGroupingStyle");
  const showFamilyStatusSubheaders = useClientSetting("lastcodeSidebarFamilyStatusSubheaders");
  const threadsByKey = new Map(
    threads.map((thread) => [
      scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      thread,
    ]),
  );
  const collapseKeys = [...threadsByKey.keys()].flatMap((key) => [
    key,
    lastcodeSidebarSubagentGroupKey(key),
  ]);
  const collapsedByKey = useCollapsedLastCodeSidebarFamilies(collapseKeys);
  const localVisits = useUiStateStore(
    useShallow((state) =>
      threads.map(
        (thread) =>
          state.threadLastVisitedAtById[
            scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))
          ] ?? null,
      ),
    ),
  );
  const statusForThread = lastCodeProjectThreadStatus(threads, localVisits);
  const result = projectLastCodeProjectThreads(threads, sortOrder, {
    collapsedByKey,
    activeThreadKey,
    projectExpanded,
    previewCount,
    listExpanded,
    groupingStyle,
    showFamilyStatusSubheaders,
    statusForThread,
  });
  return { ...result, threadsByKey, groupingStyle };
}
