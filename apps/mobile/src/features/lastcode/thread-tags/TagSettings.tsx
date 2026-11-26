import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useGT } from "gt-react-native";
import type { Preferences } from "../../../persistence/mobile-preferences";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../../state/preferences";
import { SettingsSection } from "../../settings/components/SettingsSection";
import { SettingsSwitchRow } from "../../settings/components/SettingsSwitchRow";

export function TagSettings() {
  const gt = useGT();
  const stored = useAtomValue(mobilePreferencesAtom);
  const preferences: Preferences = AsyncResult.getOrElse(stored, () => ({}));
  const update = useAtomSet(updateMobilePreferencesAtom);
  return (
    <SettingsSection title={gt("Thread tags on this device")}>
      <SettingsSwitchRow
        icon="tag"
        label={gt("Tags button in thread header")}
        subtitle={gt(
          "Add and remove this thread's tags from the header. Turning this off keeps tags.",
        )}
        value={preferences.lastcodeThreadTagsHeaderEnabled !== false}
        onValueChange={(lastcodeThreadTagsHeaderEnabled) =>
          update({ lastcodeThreadTagsHeaderEnabled })
        }
      />
      <SettingsSwitchRow
        icon="line.3.horizontal.decrease"
        label={gt("Sidebar tag filter")}
        subtitle={gt(
          "Filter threads by tag. A parent tag also shows its nested tags. Turning this off shows the full list and keeps tags.",
        )}
        value={preferences.lastcodeThreadTagsSidebarEnabled !== false}
        onValueChange={(lastcodeThreadTagsSidebarEnabled) =>
          update({ lastcodeThreadTagsSidebarEnabled })
        }
      />
    </SettingsSection>
  );
}
