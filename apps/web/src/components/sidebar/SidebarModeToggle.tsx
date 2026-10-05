import { ListTreeIcon } from "lucide-react";

import {
  useClientSettingsHydrated,
  useLegacySidebarEnabled,
  useUpdateClientSettings,
} from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function SidebarModeToggle({ onBackdrop = false }: { onBackdrop?: boolean }) {
  const legacySidebarEnabled = useLegacySidebarEnabled();
  const hydrated = useClientSettingsHydrated();
  const updateSettings = useUpdateClientSettings();

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label="Legacy sidebar"
            aria-pressed={legacySidebarEnabled}
            disabled={!hydrated}
            size="titlebar-icon"
            variant={onBackdrop ? "media-toggle" : "ghost-toggle"}
            className="pointer-events-auto relative top-auto translate-y-0"
            onClick={() =>
              updateSettings((settings) => ({
                legacySidebarEnabled: !settings.legacySidebarEnabled,
              }))
            }
          >
            <ListTreeIcon />
          </Button>
        }
      />
      <TooltipPopup side="bottom">
        {legacySidebarEnabled ? "Switch to v2 sidebar" : "Switch to legacy sidebar"}
      </TooltipPopup>
    </Tooltip>
  );
}
