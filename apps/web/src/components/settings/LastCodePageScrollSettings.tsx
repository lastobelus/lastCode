import { useClientSettings, updateClientSettings } from "../../hooks/useSettings";
import { searchableSetting } from "./settingsSearch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { Switch } from "../ui/switch";

export function LastCodePageScrollSettings() {
  const enabled = useClientSettings((settings) => settings.pageScrollOverlapEnabled);
  return (
    <SettingsSection title="Page-up/Page-down Behaviour">
      <SettingsRow
        {...searchableSetting("page-scroll-overlap")}
        control={
          <Switch
            checked={enabled}
            onCheckedChange={(checked) =>
              updateClientSettings({ pageScrollOverlapEnabled: Boolean(checked) })
            }
            aria-label="Keep 1 line when scrolling page-at-a-time"
          />
        }
      />
    </SettingsSection>
  );
}
