import type { SidebarThreadSummary } from "../../types";
import type { ComponentProps } from "react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { readThreadShell } from "../../state/entities";
import {
  SidebarThreadHoverContent,
  SidebarThreadCleanupHoverContent,
} from "./SidebarThreadHoverContent";
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

/** Build once so cleanup overlay and ordinary/annotation details share the same query snapshots. */
export function createLastCodeThreadHoverContents(
  input: Pick<
    ComponentProps<typeof LastCodeThreadHoverDetails>,
    | "thread"
    | "sourceControl"
    | "processes"
    | "identity"
    | "familyPresentation"
    | "projectCwdFallback"
  >,
) {
  const { thread } = input;
  const cleanup = thread.worktreeCleanup;
  const blockerTitle =
    cleanup?.status === "queued"
      ? (readThreadShell(scopeThreadRef(thread.environmentId, cleanup.blockedByThreadId))?.title ??
        null)
      : null;
  return {
    content: (
      <LastCodeThreadHoverDetails
        {...input}
        cleanupBlockerTitle={blockerTitle}
        hasActiveAnnotation={thread.annotation?.resolvedAt === null}
      />
    ),
    trailingContent: (
      <SidebarThreadCleanupHoverContent thread={thread} blockerTitle={blockerTitle} standalone />
    ),
  };
}
