import type { SidebarThreadSummary } from "../../types";
import { SidebarThreadHoverContent } from "./SidebarThreadHoverContent";
import type { LastCodeThreadIdentity } from "./useLastCodeThreadIdentity";
import type { LastCodeThreadSourceControlSnapshot } from "./useLastCodeThreadSourceControl";
import type { LastCodeThreadProcessSnapshot } from "./useLastCodeThreadProcesses";
import type { LastCodeThreadFamilyPresentation } from "./useLastCodeThreadFamily";
export function LastCodeThreadHoverDetails({
  thread,
  sourceControl,
  processes,
  identity,
  familyPresentation,
  projectCwdFallback,
  cleanupBlockerTitle,
  hasActiveAnnotation,
}: {
  thread: SidebarThreadSummary;
  sourceControl: LastCodeThreadSourceControlSnapshot;
  processes: LastCodeThreadProcessSnapshot;
  identity: LastCodeThreadIdentity;
  familyPresentation: LastCodeThreadFamilyPresentation;
  projectCwdFallback: string | null;
  cleanupBlockerTitle: string | null;
  hasActiveAnnotation: boolean;
}) {
  return (
    <>
      {familyPresentation.relationshipDescription ? (
        <div className="mb-2 text-xs text-sidebar-muted-foreground">
          {familyPresentation.relationshipDescription}
        </div>
      ) : null}

      <SidebarThreadHoverContent
        branchMismatch={sourceControl.branchMismatch}
        environmentLabel={identity.threadEnvironmentLabel}
        environmentIconColor={identity.environmentIconColor}
        modelInstanceId={identity.modelInstanceId}
        modelLabel={identity.modelLabel}
        projectCwd={sourceControl.threadProjectCwd ?? projectCwdFallback}
        projectFaviconPath={sourceControl.threadProject?.faviconPath ?? null}
        projectTitle={sourceControl.threadProject?.title ?? null}
        providerEntry={identity.providerEntry}
        showInstanceBadge={identity.showInstanceBadge}
        terminalProcessCount={processes.runningTerminalIds.length}
        terminalStatus={processes.terminalStatus}
        thread={thread}
        cleanupBlockerTitle={cleanupBlockerTitle}
        showCleanup={!hasActiveAnnotation}
      />
    </>
  );
}
