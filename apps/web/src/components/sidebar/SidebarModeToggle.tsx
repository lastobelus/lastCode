import { ListTreeIcon } from "lucide-react";

import {
  useClientSettingsHydrated,
  useClientSetting,
  useSidebarMode,
  toggleSidebarMode,
} from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function SidebarModeToggle({ onBackdrop = false }: { onBackdrop?: boolean }) {
  const sidebarMode = useSidebarMode();
  const hydrated = useClientSettingsHydrated();
  const lastcodeEnabled = useClientSetting("lastcodeSidebarEnabled");

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={lastcodeEnabled ? "LastCode sidebar" : "Legacy sidebar"}
            aria-pressed={sidebarMode === (lastcodeEnabled ? "lastcode" : "legacy")}
            disabled={!hydrated}
            size="titlebar-icon"
            variant={onBackdrop ? "media-toggle" : "ghost-toggle"}
            className="pointer-events-auto relative top-auto translate-y-0"
            onMouseDown={(event) => {
              // Let hiding pause a row editor without committing its draft on the button press.
              if (document.activeElement?.matches('[data-testid^="thread-row-"] input')) {
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
        {sidebarMode === "lastcode"
          ? "Switch to v2 sidebar"
          : lastcodeEnabled
            ? "Switch to LastCode sidebar"
            : sidebarMode === "legacy"
              ? "Switch to v2 sidebar"
              : "Switch to legacy sidebar"}
      </TooltipPopup>
    </Tooltip>
  );
}
