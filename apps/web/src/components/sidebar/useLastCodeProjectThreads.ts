import type { OlderSettledScope } from "@t3tools/client-runtime/state/threads";
import { useOlderSettledShelf } from "../../state/olderSettledShelf";
import { useShallow } from "zustand/react/shallow";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useClientSetting } from "../../hooks/useSettings";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useThreadShellsForProjectRefs } from "../../state/entities";
import { useUiStateStore } from "../../uiStateStore";
import type { indexLastCodeSidebarThreads } from "./lastcodeSidebarProjects";
import {
  lastcodeSidebarOwnerRef,
  lastcodeSidebarOwnerGroupKey,
  lastcodeSidebarSubagentGroupKey,
} from "../lastcodeSidebarFamilies.logic";
import { useCollapsedLastCodeSidebarFamilies } from "../lastcodeSidebarFamilies.store";
import {
  lastCodeProjectThreadStatus,
  projectLastCodeProjectThreads,
} from "./lastcodeProjectThreads";

export function useLastCodeProjectThreads(
  project: Pick<SidebarProjectSnapshot, "memberProjectRefs"> &
    Partial<Pick<SidebarProjectSnapshot, "projectKey">>,
  activeThreadKey: string | null,
  projectExpanded: boolean,
  listExpanded: boolean,
  threadIndex?: ReturnType<typeof indexLastCodeSidebarThreads>,
) {
  const threads = useThreadShellsForProjectRefs(project.memberProjectRefs);
  const scopes: OlderSettledScope[] = [
    ...new Set(project.memberProjectRefs.map((ref) => ref.environmentId)),
  ].map((environmentId) => ({
    environmentId,
    projectIds: project.memberProjectRefs.flatMap((ref) =>
      ref.environmentId === environmentId ? [ref.projectId] : [],
    ),
  }));
  const shelf = useOlderSettledShelf({
    scopes,
    expanded: projectExpanded && listExpanded,
    initialPages: 1,
    visibleCount: 0,
  });
  const olderSettled = {
    hasMore: shelf.hasMore || shelf.unloadedCount(threads) > 0,
    loading: shelf.loading,
    failed: shelf.failed,
    loadMore: shelf.loadMore,
    retry: shelf.retry,
  };
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
  const projectKey = project.projectKey;
  const ownership =
    projectKey !== undefined && threadIndex
      ? {
          projectKey,
          byThreadKey: threadIndex.byThreadKey,
          hiddenThreadKeys: threadIndex.hiddenThreadKeys,
        }
      : undefined;
  const collapseKeys = new Set<string>();
  for (const [key, thread] of threadsByKey) {
    collapseKeys.add(key);
    collapseKeys.add(lastcodeSidebarSubagentGroupKey(key));
    const owner = ownership ? lastcodeSidebarOwnerRef(thread) : null;
    if (owner && projectKey !== undefined)
      collapseKeys.add(lastcodeSidebarOwnerGroupKey(projectKey, owner));
  }
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
    ownership,
    collapsedByKey,
    activeThreadKey,
    projectExpanded,
    previewCount,
    listExpanded,
    groupingStyle,
    showFamilyStatusSubheaders,
    statusForThread,
  });
  return { ...result, threadsByKey, groupingStyle, olderSettled };
}
