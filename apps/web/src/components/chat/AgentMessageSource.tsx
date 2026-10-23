import type { ScopedThreadRef } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { BotIcon, ChevronRightIcon } from "lucide-react";
import { useId } from "react";
import { useProject, useQuietThreadShells } from "../../state/entities";
import { ProjectFavicon } from "../ProjectFavicon";
import { isSidebarSubagentThread } from "../Sidebar.logic";
import { ThreadHoverCardPopup } from "../ThreadHoverCard";
import { lastcodeSidebarThreadPath } from "../lastcodeSidebarFamilies.logic";
import { InlineButton } from "../ui/button";
import { Tooltip, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";

export function AgentMessageSource({
  senderRef,
  currentThreadRef,
  onOpenThread,
}: {
  senderRef: ScopedThreadRef;
  currentThreadRef: ScopedThreadRef | null;
  onOpenThread: () => void;
}) {
  const descriptionId = useId();
  return (
    <Tooltip>
      <TooltipTrigger
        aria-describedby={descriptionId}
        render={
          <InlineButton onClick={onOpenThread} tone="muted" aria-label="Open sending thread" />
        }
      >
        Sent by another agent
      </TooltipTrigger>
      <ThreadHoverCardPopup
        id={descriptionId}
        role="tooltip"
        align="end"
        viewportPadding="none"
        className="max-w-[min(50ch,var(--available-width))]"
      >
        <SenderBreadcrumb senderRef={senderRef} currentThreadRef={currentThreadRef} />
      </ThreadHoverCardPopup>
    </Tooltip>
  );
}

function SenderBreadcrumb({
  senderRef,
  currentThreadRef,
}: {
  senderRef: ScopedThreadRef;
  currentThreadRef: ScopedThreadRef | null;
}) {
  // The popup mounts these subscriptions only while open; timeline rows stay quiet.
  const threads = useQuietThreadShells();
  const path = lastcodeSidebarThreadPath(threads, senderRef);
  const sender = path.at(-1);
  const project = useProject(
    sender ? scopeProjectRef(sender.environmentId, sender.projectId) : null,
  );
  const currentIndex = path.findIndex(
    (thread) =>
      thread.id === currentThreadRef?.threadId &&
      thread.environmentId === currentThreadRef.environmentId,
  );
  const relative = currentIndex !== -1;
  const visiblePath = relative ? path.slice(currentIndex + 1) : path;

  return (
    <ol
      aria-label="Sending thread path"
      className="flex w-max max-w-full flex-col gap-1 p-(--floating-content-inset) text-xs"
    >
      {!sender ? (
        <li className="text-muted-foreground">Sending thread unavailable</li>
      ) : (
        <>
          <li className="flex min-w-0 items-center gap-1.5 font-medium">
            {relative ? (
              <span className="truncate">Current Thread</span>
            ) : (
              <>
                {project ? (
                  <ProjectFavicon project={project} className="size-3.5 shrink-0" />
                ) : null}
                <span className="min-w-0 truncate">{project?.title ?? "Project unavailable"}</span>
              </>
            )}
          </li>
          {visiblePath.map((thread, index) => (
            <li
              key={thread.id}
              className={cn(
                "flex min-w-0 items-center gap-1.5",
                thread === sender ? "font-medium text-foreground" : "text-muted-foreground",
              )}
              style={{ paddingInlineStart: `min(${(index + 1) * 0.875}rem, 12ch)` }}
            >
              <ChevronRightIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
              {isSidebarSubagentThread(thread) ? (
                <>
                  <BotIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
                  <span className="sr-only">Subagent: </span>
                </>
              ) : null}
              <span className="min-w-0 truncate">{thread.title}</span>
            </li>
          ))}
        </>
      )}
    </ol>
  );
}
