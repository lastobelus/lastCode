import type { ScopedThreadRef } from "@t3tools/contracts";
import { NetworkIcon } from "lucide-react";
import { linkedArchiveStatusMenuItem } from "../hooks/useLastCodeLinkedArchiveRecovery";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export function LastCodeLinkedArchiveStatusButton(props: {
  thread: ScopedThreadRef;
  disabled: boolean;
  onShow: (thread: ScopedThreadRef) => Promise<void>;
}) {
  const item = linkedArchiveStatusMenuItem(props.thread.environmentId)[0];
  if (item === undefined) return null;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label={item.label}
            disabled={props.disabled}
            onClick={() => void props.onShow(props.thread)}
          />
        }
      >
        <NetworkIcon className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup>{item.label}</TooltipPopup>
    </Tooltip>
  );
}
