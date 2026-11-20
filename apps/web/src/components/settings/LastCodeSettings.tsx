import { PaletteIcon } from "lucide-react";
import { LastCodeSidebarSettings } from "./LastCodeSidebarSettings";
import { LastCodeLocalUpdatesSettings } from "./LastCodeLocalUpdatesSettings";
import { LastCodeEnvironmentIconSettings } from "./LastCodeEnvironmentIconSettings";
import { LocalCiSettingsSection } from "./LocalCiSettings";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

export function LastCodeSettingsPanel() {
  return (
    <SettingsPageContainer>
      <LastCodeLocalUpdatesSettings />
      <LocalCiSettingsSection />
      <SettingsSection title="Appearance" icon={<PaletteIcon className="size-5" />}>
        <LastCodeSidebarSettings />
      </SettingsSection>
      <LastCodeEnvironmentIconSettings />
    </SettingsPageContainer>
  );
}
