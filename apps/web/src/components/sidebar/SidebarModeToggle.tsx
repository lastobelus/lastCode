import { toggleUpstreamSidebar } from "../../sidebarMode";
import { ListTreeIcon } from "lucide-react";

import {
  useClientSettingsHydrated,
  useSidebarMode,
  useUpdateClientSettings,
} from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function SidebarModeToggle({ onBackdrop = false }: { onBackdrop?: boolean }) {
  const sidebarMode = useSidebarMode();
  const hydrated = useClientSettingsHydrated();
  const updateSettings = useUpdateClientSettings();

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={sidebarMode === "lastcode" ? "LastCode sidebar active" : "Legacy sidebar"}
            aria-pressed={sidebarMode === "legacy"}
            disabled={!hydrated || sidebarMode === "lastcode"}
            size="titlebar-icon"
            variant={onBackdrop ? "media-toggle" : "ghost-toggle"}
            className="pointer-events-auto relative top-auto translate-y-0"
            onClick={() => updateSettings(toggleUpstreamSidebar)}
          >
            <ListTreeIcon />
          </Button>
        }
      />
      <TooltipPopup side="bottom">
        {sidebarMode === "lastcode"
          ? "Turn off LastCode sidebar in LastCode settings to switch upstream sidebars"
          : sidebarMode === "legacy"
            ? "Switch to v2 sidebar"
            : "Switch to legacy sidebar"}
      </TooltipPopup>
    </Tooltip>
  );
}
