import { usePrimarySettings, updateClientSettings } from "../../hooks/useSettings";
import { Switch } from "../ui/switch";
import { searchableSetting } from "./settingsSearch";
import { SettingsRow } from "./settingsLayout";

export function LastCodeWorkStatusSettings() {
  const { hoverCurrentWorkDetails } = usePrimarySettings();
  return (
    <SettingsRow
      {...searchableSetting("hover-current-work-details")}
      description="Hover over status text to see the full work list. The info button works either way."
      control={
        <Switch
          checked={hoverCurrentWorkDetails}
          onCheckedChange={(checked) =>
            updateClientSettings({ hoverCurrentWorkDetails: Boolean(checked) })
          }
          aria-label="Show work details on hover"
        />
      }
    />
  );
}
