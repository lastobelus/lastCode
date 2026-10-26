import { useLastCodeSidebarPresentation } from "./LastCodeSidebarPresentation";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type { SidebarThreadSummary } from "../../types";
import { ChangeRequestStatusIcon, PrStatusTooltipContent } from "../ThreadStatusIndicators";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { LastCodeThreadSourceControlSnapshot } from "./useLastCodeThreadSourceControl";

export function LastCodeThreadSourceControl({
  thread,
  sourceControl,
  isActive,
  navigateToThread,
}: {
  thread: SidebarThreadSummary;
  sourceControl: LastCodeThreadSourceControlSnapshot;
  isActive: boolean;
  navigateToThread: (ref: ScopedThreadRef) => Promise<void>;
}) {
  const { pr, prStatus, currentLinkedPr } = sourceControl;
  const cleanup = thread.worktreeCleanup ?? null;
  const handlePrClick = useThreadPullRequestClick(
    thread,
    sourceControl,
    isActive,
    navigateToThread,
  );
  return (
    <>
      {cleanup === null && prStatus && pr && (
        <Tooltip>
          <TooltipTrigger
            render={
              <a
                href={prStatus.url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={prStatus.tooltip}
                className={`inline-flex items-center justify-center ${prStatus.colorClass} cursor-pointer rounded-sm outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring`}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={handlePrClick}
              >
                <ChangeRequestStatusIcon state={pr.state} isDraft={pr.isDraft} className="size-3" />
              </a>
            }
          />
          <TooltipPopup side="top">
            <PrStatusTooltipContent status={prStatus} />
          </TooltipPopup>
        </Tooltip>
      )}
      {!pr && currentLinkedPr ? (
        <a
          href={currentLinkedPr.url}
          target="_blank"
          rel="noopener noreferrer"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={handlePrClick}
          className="text-muted-foreground"
          aria-label={`PR #${currentLinkedPr.number}, status pending`}
        >
          <PullRequestGlyph.pullRequest className="size-3" />
        </a>
      ) : null}
    </>
  );
}

/** Opening a PR retains the exact thread destination when the right panel is used. */
function useThreadPullRequestClick(
  thread: SidebarThreadSummary,
  sourceControl: LastCodeThreadSourceControlSnapshot,
  isActive: boolean,
  navigateToThread: (ref: ScopedThreadRef) => Promise<void>,
) {
  const { openPullRequestsInRightPanel, openPrLink } = useLastCodeSidebarPresentation();
  const { prStatus, currentLinkedPr } = sourceControl;
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  return (event: React.MouseEvent<HTMLAnchorElement>) => {
    const url = prStatus?.url ?? currentLinkedPr?.url;
    if (!url) return;
    const openedInRightPanel = openPrLink(
      event,
      url,
      openPullRequestsInRightPanel ? threadRef : undefined,
    );
    if (!openedInRightPanel) return;
    if (!openPullRequestsInRightPanel) return;
    if (!isActive) navigateToThread(threadRef);
  };
}
