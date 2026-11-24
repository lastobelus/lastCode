import { useGT } from "gt-react";
import { useClientSettings, updateClientSettings } from "../../hooks/useSettings";
import { useSearchableSetting } from "./settingsSearch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { Switch } from "../ui/switch";

export function LastCodePageScrollSettings() {
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  const enabled = useClientSettings((settings) => settings.pageScrollOverlapEnabled);
  return (
    <SettingsSection
      title={gt("{pageUp}/{pageDown} Behaviour", {
        pageUp: "Page-up",
        pageDown: "Page-down",
      })}
    >
      <SettingsRow
        {...searchableSetting("page-scroll-overlap")}
        control={
          <Switch
            checked={enabled}
            onCheckedChange={(checked) =>
              updateClientSettings({ pageScrollOverlapEnabled: Boolean(checked) })
            }
            aria-label={gt("Keep 1 line when scrolling page-at-a-time")}
          />
        }
      />
    </SettingsSection>
  );
}
