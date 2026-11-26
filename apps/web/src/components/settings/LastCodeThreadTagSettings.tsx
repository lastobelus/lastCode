import { useGT } from "gt-react";
import { useClientSettings, updateClientSettings } from "../../hooks/useSettings";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function LastCodeThreadTagSettings() {
  const gt = useGT();
  const header = useClientSettings((settings) => settings.lastcodeThreadTagsHeaderEnabled);
  const sidebar = useClientSettings((settings) => settings.lastcodeThreadTagsSidebarEnabled);
  return (
    <>
      <SettingsRow
        {...searchableSetting("thread-tags-header")}
        description={gt(
          "Tags appear below the thread title, where you can add or remove them. Turning this off keeps tags.",
        )}
        control={
          <Switch
            aria-label={gt("Show thread tags in chat header")}
            checked={header}
            onCheckedChange={(lastcodeThreadTagsHeaderEnabled) =>
              updateClientSettings({ lastcodeThreadTagsHeaderEnabled })
            }
          />
        }
      />
      <SettingsRow
        {...searchableSetting("thread-tags-sidebar")}
        description={gt(
          "Adds a tag filter to the sidebar. A parent tag also shows its nested tags, so work includes work/client. Turning this off shows the full sidebar and keeps tags.",
        )}
        control={
          <Switch
            aria-label={gt("Show tag filter in sidebar")}
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
