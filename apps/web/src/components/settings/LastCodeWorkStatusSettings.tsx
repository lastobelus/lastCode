import { useGT } from "gt-react";
import { usePrimarySettings, updateClientSettings } from "../../hooks/useSettings";
import { Switch } from "../ui/switch";
import { useSearchableSetting } from "./settingsSearch";
import { SettingsRow } from "./settingsLayout";

export function LastCodeWorkStatusSettings() {
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  const { hoverCurrentWorkDetails } = usePrimarySettings();
  return (
    <SettingsRow
      {...searchableSetting("hover-current-work-details")}
      description={gt(
        "Hover over status text to see the full work list. The info button works either way.",
      )}
      control={
        <Switch
          checked={hoverCurrentWorkDetails}
          onCheckedChange={(checked) =>
            updateClientSettings({ hoverCurrentWorkDetails: Boolean(checked) })
          }
          aria-label={gt("Show work details on hover")}
        />
      }
    />
  );
}
