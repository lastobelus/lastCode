import { useState } from "react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import { useClientSetting } from "../../hooks/useSettings";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { lastcodeSidebarScaleStyle } from "../../lastcodeSidebarScale";
import { useEnvironmentThread } from "../../state/threads";
import { SidebarContent, SidebarGroup } from "../ui/sidebar";
import { LastCodeSidebarDesktopNotice } from "./LastCodeSidebarDesktopNotice";
import { LastCodeSidebarConnectionNotice } from "./LastCodeSidebarConnectionNotice";
import { LastCodeSidebarPresentationProvider } from "./LastCodeSidebarPresentation";
import { LastCodeSidebarProjectList } from "./LastCodeSidebarProjectList";
import { LastCodeSidebarSearch } from "./LastCodeSidebarSearch";
import { LastCodeSidebarProjectToolbar } from "./LastCodeSidebarProjectToolbar";
import { ProjectSidebarDraftList } from "./ProjectSidebarDraftList";
import { useLastCodeSidebarEnvironments } from "./useLastCodeSidebarEnvironments";
import { useLastCodeSidebarProjects } from "./useLastCodeSidebarProjects";
import { useLastCodeSidebarNavigation } from "./useLastCodeSidebarNavigation";

function ThreadDetailPrewarmer({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  useEnvironmentThread(threadRef.environmentId, threadRef.threadId);
  return null;
}
function EmptyProjects() {
  const scale = useClientSetting("legacySidebarScale");
  const style = lastcodeSidebarScaleStyle(scale);
  return (
    <div
      className="px-2 pt-4 text-center text-secondary-label text-xs"
      data-lastcode-sidebar-scale={scale}
      style={style}
    >
      No projects yet
    </div>
  );
}

/** Collection composition owns expansion once, shared by rendered rows and root navigation. */
export function LastCodeSidebarContent() {
  const { grouping, presentation } = useLastCodeSidebarEnvironments();
  const { sortedProjects, orderedProjectKeys, resolveProjectKey, index } =
    useLastCodeSidebarProjects(grouping);
  const [expandedLists, setExpandedLists] = useState<ReadonlySet<string>>(() => new Set());
  const navigation = useLastCodeSidebarNavigation(sortedProjects, index, expandedLists);
  const thread = navigation.routeThreadKey
    ? index.byThreadKey.get(navigation.routeThreadKey)
    : null;
  const activeRoute = {
    threadKey: navigation.routeThreadKey,
    projectKey: thread
      ? resolveProjectKey(scopeProjectRef(thread.environmentId, thread.projectId))
      : null,
  };
  const onExpandedChange = (key: string, expanded: boolean) => {
    setExpandedLists((current) => {
      if (current.has(key) === expanded) return current;
      const next = new Set(current);
      if (expanded) next.add(key);
      else next.delete(key);
      return next;
    });
  };
  const handleNewThread = useNewThreadHandler();
  const newThread = { handle: handleNewThread, shortcutLabel: navigation.newThreadShortcutLabel };
  return (
    <>
      {navigation.prewarmedSidebarThreadRefs.map((threadRef) => (
        <ThreadDetailPrewarmer key={scopedThreadKey(threadRef)} threadRef={threadRef} />
      ))}
      <LastCodeSidebarPresentationProvider
        {...presentation}
        openPullRequestsInRightPanel={navigation.routeThreadRef !== null}
      >
        <SidebarContent
          fixedHeader={
            <LastCodeSidebarSearch
              projects={sortedProjects}
              shortcutLabel={navigation.commandPaletteShortcutLabel}
            />
          }
        >
          <LastCodeSidebarDesktopNotice />
          <LastCodeSidebarConnectionNotice />
          <SidebarGroup>
            <ProjectSidebarDraftList />
            <LastCodeSidebarProjectToolbar />
            <LastCodeSidebarProjectList
              projects={sortedProjects}
              orderedProjectKeys={orderedProjectKeys}
              activeRoute={activeRoute}
              expandedLists={expandedLists}
              onExpandedChange={onExpandedChange}
              jumpLabels={navigation.visibleThreadJumpLabelByKey}
              newThread={newThread}
            />
            {sortedProjects.length === 0 && <EmptyProjects />}
          </SidebarGroup>
        </SidebarContent>
      </LastCodeSidebarPresentationProvider>
    </>
  );
}
