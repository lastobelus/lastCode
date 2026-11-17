import type { ReactNode } from "react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { SidebarThreadSummary } from "../../types";
import { ThreadAnnotationHoverPopover } from "../thread-annotation/ThreadAnnotation";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { checkTaskPermission } from "./lastcodeSidebarPermission";
import type { useLastCodeThreadDetails } from "./useLastCodeThreadDetails";

type DetailsLifetime = ReturnType<typeof useLastCodeThreadDetails>;
export interface LastCodeThreadAnnotationActions {
  onEditAnnotation: (thread: SidebarThreadSummary) => void;
  onSaveAnnotationBody: (thread: SidebarThreadSummary, body: string) => Promise<boolean>;
  onResolveAnnotation: (thread: SidebarThreadSummary) => void;
}

export function LastCodeThreadCleanupOverlay({
  thread,
  content,
}: {
  thread: SidebarThreadSummary;
  content: ReactNode;
}) {
  const pending =
    thread.worktreeCleanup?.status === "deleting" || thread.worktreeCleanup?.status === "queued";
  if (!pending || thread.annotation?.resolvedAt === null) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label={`${thread.title} cleanup details`}
            className="absolute inset-0 z-20 cursor-not-allowed"
          />
        }
      />
      <TooltipPopup
        align="start"
        side="right"
        sideOffset={4}
        variant="glass"
        viewportPadding="none"
      >
        <div className="text-left">{content}</div>
      </TooltipPopup>
    </Tooltip>
  );
}

export function LastCodeThreadDetails({
  thread,
  lifetime,
  gitCwd,
  content,
  trailingContent,
  annotations,
}: {
  thread: SidebarThreadSummary;
  lifetime: DetailsLifetime;
  gitCwd: string | null;
  content: ReactNode;
  trailingContent: ReactNode;
  annotations: LastCodeThreadAnnotationActions;
}) {
  const annotation = thread.annotation ?? null;
  const annotated = annotation?.resolvedAt === null;
  const {
    annotationPopoverHandle,
    annotationTriggerId,
    threadRowActive,
    handleThreadDetailsTooltipOpenChange,
    threadNavigationRef,
    threadDetailsTooltipId,
  } = lifetime;
  return (
    <>
      {annotated && annotation ? (
        <ThreadAnnotationHoverPopover
          annotation={annotation}
          cwd={gitCwd ?? undefined}
          handle={annotationPopoverHandle}
          navigationTriggerId={annotationTriggerId}
          onBodyChange={(body) => annotations.onSaveAnnotationBody(thread, body)}
          onEdit={() => {
            if (checkTaskPermission(thread.environmentId)) annotations.onEditAnnotation(thread);
          }}
          onResolve={() => annotations.onResolveAnnotation(thread)}
          threadDetails={content}
          trailingContent={trailingContent}
          threadRef={scopeThreadRef(thread.environmentId, thread.id)}
        />
      ) : null}
      <Tooltip
        disabled={annotated}
        open={!annotated && threadRowActive}
        onOpenChange={handleThreadDetailsTooltipOpenChange}
      >
        <TooltipPopup
          align="start"
          animated={false}
          anchor={threadNavigationRef}
          id={threadDetailsTooltipId}
          side="right"
          sideOffset={4}
          variant="glass"
          viewportPadding="none"
        >
          <div className="text-left">{content}</div>
        </TooltipPopup>
      </Tooltip>
    </>
  );
}
