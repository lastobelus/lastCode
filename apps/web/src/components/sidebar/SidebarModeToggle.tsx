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
  const label = lastcodeEnabled ? "LastCode" : "Legacy";
  const active = sidebarMode === (lastcodeEnabled ? "lastcode" : "legacy");

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={`${label} sidebar`}
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
      <TooltipPopup side="bottom">{`Switch to ${active ? "v2" : label} sidebar`}</TooltipPopup>
    </Tooltip>
  );
}
