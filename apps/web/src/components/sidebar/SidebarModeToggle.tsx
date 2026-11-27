import { useGT } from "gt-react";
import { ListTreeIcon } from "lucide-react";

import {
  useClientSettingsHydrated,
  useSidebarMode,
  toggleSidebarMode,
} from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function SidebarModeToggle({ onBackdrop = false }: { onBackdrop?: boolean }) {
  const sidebarMode = useSidebarMode();
  const hydrated = useClientSettingsHydrated();
  const gt = useGT();
  const active = sidebarMode === "lastcode";

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={gt("{product} sidebar", { product: "LastCode" })}
            aria-pressed={active}
            disabled={!hydrated}
            size="titlebar-icon"
            variant={onBackdrop ? "media-toggle" : "ghost-toggle"}
            className="pointer-events-auto relative top-auto translate-y-0"
            onMouseDown={(event) => {
              // Let hiding pause a row editor without committing its draft on the button press.
              if (
                sidebarMode === "lastcode" &&
                document.activeElement?.hasAttribute("data-lastcode-title-editor")
              ) {
                event.preventDefault();
              }
            }}
            onClick={toggleSidebarMode}
          >
            <ListTreeIcon />
          </Button>
        }
      />
      <TooltipPopup side="bottom">
        {gt("Switch to {mode} sidebar", { mode: active ? "v2" : "LastCode" })}
      </TooltipPopup>
    </Tooltip>
  );
}
