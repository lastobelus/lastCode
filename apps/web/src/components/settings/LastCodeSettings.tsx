import { PaletteIcon } from "lucide-react";
import { LastCodeMessageAppearanceSettings } from "./LastCodeMessageAppearanceSettings";
import { LastCodeHandoffSettings } from "./LastCodeHandoffSettings";
import { LastCodeScrollbarSettings } from "./LastCodeScrollbarSettings";
import { LastCodeSidebarSettings } from "./LastCodeSidebarSettings";
import { LastCodeImportSettings } from "./LastCodeImportSettings";
import { LastCodeLocalUpdatesSettings } from "./LastCodeLocalUpdatesSettings";
import { LastCodeEnvironmentPauseSettings } from "./LastCodeEnvironmentPauseSettings";
import { LastCodeEnvironmentIconSettings } from "./LastCodeEnvironmentIconSettings";
import { LocalCiSettingsSection } from "./LocalCiSettings";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

export function LastCodeSettingsPanel() {
  return (
    <SettingsPageContainer>
      <LastCodeLocalUpdatesSettings />
      <LastCodeEnvironmentPauseSettings />
      <LocalCiSettingsSection />
      <SettingsSection title="Appearance" icon={<PaletteIcon className="size-5" />}>
        <LastCodeMessageAppearanceSettings />
        <LastCodeHandoffSettings />
        <LastCodeScrollbarSettings />
        <LastCodeSidebarSettings />
      </SettingsSection>
      <LastCodeEnvironmentIconSettings />
      <LastCodeImportSettings />
    </SettingsPageContainer>
  );
}
