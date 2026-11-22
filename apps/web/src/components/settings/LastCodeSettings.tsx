import { Link } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import { HardDriveIcon, PaletteIcon } from "lucide-react";
import { LastCodeAnnotationSettings } from "./LastCodeAnnotationSettings";
import { LastCodeMessageAppearanceSettings } from "./LastCodeMessageAppearanceSettings";
import { LastCodeWorkStatusSettings } from "./LastCodeWorkStatusSettings";
import { LastCodeHandoffSettings } from "./LastCodeHandoffSettings";
import { LastCodeScrollbarSettings } from "./LastCodeScrollbarSettings";
import { LastCodePageScrollSettings } from "./LastCodePageScrollSettings";
import { LastCodeSidebarSettings } from "./LastCodeSidebarSettings";
import { LastCodeImportSettings } from "./LastCodeImportSettings";
import { LastCodeLocalUpdatesSettings } from "./LastCodeLocalUpdatesSettings";
import { LastCodeEnvironmentPauseSettings } from "./LastCodeEnvironmentPauseSettings";
import { LastCodeEnvironmentIconSettings } from "./LastCodeEnvironmentIconSettings";
import { LocalCiSettingsSection } from "./LocalCiSettings";
import { LastCodePullRequestWatchSettings } from "./LastCodePullRequestWatchSettings";
import { Button } from "../ui/button";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

export function LastCodeSettingsPanel() {
  const gt = useGT();
  return (
    <SettingsPageContainer>
      <SettingsSection title={gt("Storage")} icon={<HardDriveIcon className="size-5" />}>
        <SettingsRow
          title={gt("Storage settings")}
          description={gt(
            "Configure worktree suspension, saved workspaces, cleanup and permanent deletion in one place.",
          )}
          control={
            <Button variant="outline" size="sm" render={<Link to="/settings/worktrees" />}>
              <T>Open Storage</T>
            </Button>
          }
        />
      </SettingsSection>
      <LastCodeLocalUpdatesSettings />
      <LastCodeEnvironmentPauseSettings />
      <LastCodePullRequestWatchSettings />
      <LocalCiSettingsSection />
      <SettingsSection title={gt("Appearance")} icon={<PaletteIcon className="size-5" />}>
        <LastCodeAnnotationSettings />
        <LastCodeMessageAppearanceSettings />
        <LastCodeWorkStatusSettings />
        <LastCodeHandoffSettings />
        <LastCodeScrollbarSettings />
        <LastCodeSidebarSettings />
      </SettingsSection>
      <LastCodePageScrollSettings />
      <LastCodeEnvironmentIconSettings />
      <LastCodeImportSettings />
    </SettingsPageContainer>
  );
}
