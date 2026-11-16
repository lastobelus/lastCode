import type { ThreadDashboardItem } from "@t3tools/contracts";
import { LayoutDashboardIcon } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";

/** Reported items connect a thread to its project's dashboard, even after settlement. */
export function ThreadDashboardIndicator({
  items,
}: {
  readonly items: ReadonlyArray<ThreadDashboardItem> | undefined;
}) {
  if (!items || items.length === 0) return null;
  const openCount = items.filter((item) => item.status === "open").length;
  const label =
    openCount > 0
      ? `Project dashboard · ${openCount} open ${openCount === 1 ? "item" : "items"}. Open dashboard from the thread menu.`
      : "Reports to the project dashboard. Open dashboard from the thread menu.";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={label}
            className="inline-flex shrink-0 items-center text-muted-foreground"
          />
        }
      >
        <LayoutDashboardIcon aria-hidden className="size-3" />
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}
