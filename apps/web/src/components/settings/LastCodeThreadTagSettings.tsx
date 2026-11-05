import { useClientSettings, updateClientSettings } from "../../hooks/useSettings";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function LastCodeThreadTagSettings() {
  const header = useClientSettings((settings) => settings.lastcodeThreadTagsHeaderEnabled);
  const sidebar = useClientSettings((settings) => settings.lastcodeThreadTagsSidebarEnabled);
  return (
    <>
      <SettingsRow
        {...searchableSetting("thread-tags-header")}
        description="Tags appear below the thread title, where you can add or remove them. Turning this off keeps tags and agent access."
        control={
          <Switch
            aria-label="Show thread tags in chat header"
            checked={header}
            onCheckedChange={(lastcodeThreadTagsHeaderEnabled) =>
              updateClientSettings({ lastcodeThreadTagsHeaderEnabled })
            }
          />
        }
      />
      <SettingsRow
        {...searchableSetting("thread-tags-sidebar")}
        description="Adds a tag filter to the sidebar. A parent tag also shows its nested tags, so work includes work/client. Turning this off shows the full sidebar and keeps tags and agent access."
        control={
          <Switch
            aria-label="Show tag filter in sidebar"
            checked={sidebar}
            onCheckedChange={(lastcodeThreadTagsSidebarEnabled) =>
              updateClientSettings({ lastcodeThreadTagsSidebarEnabled })
            }
          />
        }
      />
    </>
  );
}
