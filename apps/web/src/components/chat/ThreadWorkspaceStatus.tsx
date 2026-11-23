import type { ScopedThreadRef } from "@t3tools/contracts";
import { useMessages } from "gt-react";
import { useQuietThreadShell } from "../../state/entities";
import { workspaceStatusLabel } from "../worktreeSuspensionMenu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function ThreadWorkspaceStatus({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const messages = useMessages();
  const summary = useQuietThreadShell(threadRef)?.source.worktreeSuspension;
  if (summary == null || (summary.state === "active" && !summary.keepWorkspace)) return null;
  const label = workspaceStatusLabel(summary, messages);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span role="status" className="min-w-0 max-w-36 truncate text-xs text-muted-foreground" />
        }
      >
        {label}
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}
