import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import type { Preferences } from "../../../persistence/mobile-preferences";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../../state/preferences";
import { SettingsSection } from "../../settings/components/SettingsSection";
import { SettingsSwitchRow } from "../../settings/components/SettingsSwitchRow";

export function TagSettings() {
  const stored = useAtomValue(mobilePreferencesAtom);
  const preferences: Preferences = AsyncResult.getOrElse(stored, () => ({}));
  const update = useAtomSet(updateMobilePreferencesAtom);
  return (
    <SettingsSection title="Thread tags on this device">
      <SettingsSwitchRow
        icon="tag"
        label="Tags button in thread header"
        subtitle="Add and remove this thread's tags from the header. Turning this off keeps tags and agent access."
        value={preferences.lastcodeThreadTagsHeaderEnabled !== false}
        onValueChange={(lastcodeThreadTagsHeaderEnabled) =>
          update({ lastcodeThreadTagsHeaderEnabled })
        }
      />
      <SettingsSwitchRow
        icon="line.3.horizontal.decrease"
        label="Sidebar tag filter"
        subtitle="Filter threads by tag. A parent tag also shows its nested tags. Turning this off shows the full list and keeps tags and agent access."
        value={preferences.lastcodeThreadTagsSidebarEnabled !== false}
        onValueChange={(lastcodeThreadTagsSidebarEnabled) =>
          update({ lastcodeThreadTagsSidebarEnabled })
        }
      />
    </SettingsSection>
  );
}
