import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import type { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { SidebarThreadSummary } from "../../types";
import { readEnvironmentSupportsThreadAnnotations } from "../../state/entities";
import { ThreadAnnotationHoverPopover } from "../thread-annotation/ThreadAnnotation";
import { ThreadHoverCardPopup } from "../ThreadHoverCard";
import { Tooltip, TooltipTrigger } from "../ui/tooltip";
import { Popover, PopoverPopup } from "../ui/popover";
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
      <ThreadHoverCardPopup
        align="start"
        side="right"
        sideOffset={4}
        variant="glass"
        viewportPadding="none"
      >
        <div className="text-left">{content}</div>
      </ThreadHoverCardPopup>
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
  const { annotationPopoverHandle, annotationTriggerId } = lifetime;
  return (
    <>
      {annotated && annotation ? (
        <ThreadAnnotationHoverPopover
          annotation={annotation}
          cwd={gitCwd ?? undefined}
          handle={annotationPopoverHandle}
          navigationTriggerId={annotationTriggerId}
          readOnly={!readEnvironmentSupportsThreadAnnotations(thread.environmentId)}
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
      {!annotated ? <OrdinaryThreadDetails lifetime={lifetime} content={content} /> : null}
    </>
  );
}

function OrdinaryThreadDetails({
  lifetime,
  content,
}: {
  lifetime: DetailsLifetime;
  content: ReactNode;
}) {
  const {
    threadRowActive,
    threadDetailsPopoverHandle,
    annotationTriggerId,
    handleThreadDetailsTooltipOpenChange,
    threadNavigationRef,
    threadDetailsTooltipId,
    threadDetailsRef,
  } = lifetime;
  const actionsRef = useRef<PopoverPrimitive.Root.Actions | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- immediate popup removal bypasses Base UI's exit completion, so clear its mounted focus guards before the next input
  useLayoutEffect(() => {
    if (!threadRowActive) actionsRef.current?.unmount();
  }, [threadRowActive]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a detached handle outlives its root, so release mounted content when the row unmounts or annotation mode changes
  useEffect(() => {
    const actions = actionsRef.current;
    return () => {
      threadDetailsPopoverHandle.close();
      actions?.unmount();
    };
  }, [threadDetailsPopoverHandle]);
  return (
    <Popover
      actionsRef={actionsRef}
      handle={threadDetailsPopoverHandle}
      open={threadRowActive}
      triggerId={annotationTriggerId}
      onOpenChange={handleThreadDetailsTooltipOpenChange}
    >
      {threadRowActive ? (
        <PopoverPopup
          ref={threadDetailsRef}
          align="start"
          animated={false}
          anchor={threadNavigationRef}
          className="max-w-80 select-text text-left whitespace-normal before:hidden"
          elevated
          initialFocus={false}
          finalFocus={false}
          id={threadDetailsTooltipId}
          side="right"
          // Touch the row so pointer entry needs no delayed dismissal.
          sideOffset={0}
          tooltipStyle
          padding="none"
        >
          <div className="flex min-h-0 max-h-(--available-height) flex-col text-left">
            {content}
          </div>
        </PopoverPopup>
      ) : null}
    </Popover>
  );
}
