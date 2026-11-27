import { useGT } from "gt-react-native";
import { Platform } from "react-native";
import { AndroidNavigationAppearanceSection } from "./appearance/sections/AndroidNavigationAppearanceSection";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";

import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { mobilePreferencesAtom, saveMobilePreferences } from "../../state/preferences";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SettingsScreen } from "./components/SettingsScreen";
import { CodeAppearanceSection } from "./appearance/sections/CodeAppearanceSection";
import { TerminalAppearanceSection } from "./appearance/sections/TerminalAppearanceSection";
import { TextAppearanceSection } from "./appearance/sections/TextAppearanceSection";
import { ThemeAppearanceSection } from "./appearance/sections/ThemeAppearanceSection";
import { ToolCallsAppearanceSection } from "./appearance/sections/ToolCallsAppearanceSection";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

export function SettingsAppearanceRouteScreen() {
  const gt = useGT();
  const insets = useSafeAreaInsets();
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomCommand(saveMobilePreferences);
  const preferencesReady = AsyncResult.isSuccess(preferencesResult) && !preferencesResult.waiting;
  const roundedProjectIcons =
    AsyncResult.isSuccess(preferencesResult) &&
    preferencesResult.value.roundedProjectIcons === true;

  return (
    <SettingsScreen title={gt("Appearance")}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 18) + 18,
        }}
      >
        <ThemeAppearanceSection />
        {Platform.OS === "android" ? <AndroidNavigationAppearanceSection /> : null}
        <SettingsSection title={gt("Project icons")}>
          <SettingsSwitchRow
            disabled={!preferencesReady}
            icon="folder"
            label={gt("Rounded project icons")}
            subtitle={gt("Round favicon corners instead of preserving each icon's original shape.")}
            value={roundedProjectIcons}
            onValueChange={(value) => {
              void savePreferences({ roundedProjectIcons: value });
            }}
          />
        </SettingsSection>
        <TextAppearanceSection />
        <TerminalAppearanceSection />
        <CodeAppearanceSection />
        <ToolCallsAppearanceSection />
      </ScrollView>
    </SettingsScreen>
  );
}
