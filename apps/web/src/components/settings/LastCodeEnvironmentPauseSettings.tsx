import { useGT } from "gt-react";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { ScopedSwitch } from "./ScopedSwitch";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useScopedSettingsWriteAllowed,
  useUpdateScopedSettings,
} from "./useScopedSettings";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

export function LastCodeEnvironmentPauseSettings() {
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  const enabled = useScopedSettings((settings) => settings.environmentPauseEnabled);
  const mixed = useScopedSettingsMixed(["environmentPauseEnabled"]);
  const updateSettings = useUpdateScopedSettings();
  const { scope, connectedEnvironments } = useSettingsScope();
  const canWrite = useScopedSettingsWriteAllowed();
  const supported =
    connectedEnvironments.length > 0 &&
    connectedEnvironments.every(
      (environment) => environment.serverConfig?.environment.capabilities.environmentPause === true,
    );
  const disabled = !supported || !canWrite || scope.kind === "project" || scope.kind === "checkout";

  return (
    <SettingsSection title={gt("Environment controls")}>
      <SettingsRow
        serverScoped
        settingKeys={["environmentPauseEnabled"]}
        {...searchableSetting("environment-pause")}
        description={gt(
          "Enable pause and resume controls for this environment in Connections. The sidebar control pauses only the environment running on this computer.",
        )}
        status={supported ? undefined : gt("Update the environment to enable this feature.")}
        resetAction={
          mixed || enabled !== DEFAULT_SERVER_SETTINGS.environmentPauseEnabled ? (
            <SettingResetButton
              ariaLabel={gt("Reset environment pause button to default")}
              disabled={disabled}
              onClick={() =>
                updateSettings({
                  environmentPauseEnabled: DEFAULT_SERVER_SETTINGS.environmentPauseEnabled,
                })
              }
            />
          ) : null
        }
        control={
          <ScopedSwitch
            settingKeys={["environmentPauseEnabled"]}
            checked={enabled}
            disabled={disabled}
            onCheckedChange={(checked) =>
              updateSettings({ environmentPauseEnabled: Boolean(checked) })
            }
            aria-label={gt("Environment pause button")}
          />
        }
      />
    </SettingsSection>
  );
}
