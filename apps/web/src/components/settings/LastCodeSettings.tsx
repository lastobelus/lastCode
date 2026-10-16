import { LastCodeMessageAppearanceSettings } from "./LastCodeMessageAppearanceSettings";
import { LastCodeHandoffSettings } from "./LastCodeHandoffSettings";
import { LastCodeScrollbarSettings } from "./LastCodeScrollbarSettings";
import { LastCodeSidebarSettings } from "./LastCodeSidebarSettings";
import { LastCodeSettingsSlider as SettingsSlider } from "./LastCodeSettingsSlider";
import { LastCodeImportSettings } from "./LastCodeImportSettings";
import { LastCodeLocalUpdatesSettings } from "./LastCodeLocalUpdatesSettings";
import { DEFAULT_SERVER_SETTINGS, ProviderDriverKind } from "@t3tools/contracts";
import {
  MIN_THREAD_PROVIDER_BADGE_SIZE,
  MAX_THREAD_PROVIDER_BADGE_SIZE,
  MIN_THREAD_PROVIDER_BADGE_TRANSPARENCY,
  MAX_THREAD_PROVIDER_BADGE_TRANSPARENCY,
} from "@t3tools/contracts/settings";
import { useAtomValue } from "@effect/atom-react";
import { PaletteIcon, ServerIcon } from "lucide-react";
import { useMemo } from "react";

import { environmentCatalog } from "../../connection/catalog";
import { ConnectedEnvironmentIcon, updateEnvironmentIconColors } from "../../environmentIcons";
import { usePrimarySettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { Switch } from "../ui/switch";
import { SidebarEnvironmentIcon } from "../sidebar/SidebarEnvironmentIcon";
import { searchableSetting } from "./settingsSearch";
import { ProviderAccentColorPicker } from "./ProviderAccentColorPicker";
import { deriveLastCodeEnvironmentSettingEntries } from "./LastCodeSettings.logic";
import { LocalCiSettingsSection } from "./LocalCiSettings";
import { ScopedSwitch } from "./ScopedSwitch";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useScopedSettingsWriteAllowed,
  useUpdateScopedSettings,
} from "./useScopedSettings";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";

const PROVIDER_BADGE_PREVIEWS = [
  {
    kind: "laptop",
    provider: { driverKind: ProviderDriverKind.make("claudeAgent"), displayName: "Claude" },
  },
  {
    kind: "server",
    provider: { driverKind: ProviderDriverKind.make("codex"), displayName: "Codex" },
  },
] as const;

function EnvironmentPauseSettingsSection() {
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
    <SettingsSection title="Environment controls">
      <SettingsRow
        serverScoped
        settingKeys={["environmentPauseEnabled"]}
        {...searchableSetting("environment-pause")}
        description="Enable pause and resume controls for this environment in Connections. The sidebar control pauses only the environment running on this computer."
        status={supported ? undefined : "Update the environment to enable this feature."}
        resetAction={
          mixed || enabled !== DEFAULT_SERVER_SETTINGS.environmentPauseEnabled ? (
            <SettingResetButton
              label="environment pause button"
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
            aria-label="Environment pause button"
          />
        }
      />
    </SettingsSection>
  );
}

export function LastCodeSettingsPanel() {
  const clientSettings = usePrimarySettings();
  const updateClientSettings = useUpdateClientSettings();
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environmentSettings = useMemo(
    () =>
      deriveLastCodeEnvironmentSettingEntries({
        entries: catalog.entries,
        primaryEnvironmentId,
      }),
    [catalog.entries, primaryEnvironmentId],
  );

  return (
    <SettingsPageContainer>
      <LastCodeLocalUpdatesSettings />
      <EnvironmentPauseSettingsSection />
      <LocalCiSettingsSection />
      <SettingsSection title="Appearance" icon={<PaletteIcon className="size-5" />}>
        <LastCodeMessageAppearanceSettings />
        <LastCodeHandoffSettings />
        <LastCodeScrollbarSettings />
        <LastCodeSidebarSettings />
      </SettingsSection>
      <SettingsSection
        id="environment-icons"
        title="Environments"
        icon={<ServerIcon className="size-5" />}
      >
        <SettingsRow
          {...searchableSetting("show-thread-provider-badges")}
          description="Show the thread's provider logo at the lower-right of its machine icon in the sidebar. Badges also show machine icons for local threads when Show local icon is off."
          status={
            <span className="inline-flex flex-wrap items-center gap-5 rounded-md bg-sidebar px-3 py-2 text-xs text-secondary-label">
              {PROVIDER_BADGE_PREVIEWS.map(({ kind, provider }) => (
                <span key={kind} className="inline-flex items-center gap-3">
                  <SidebarEnvironmentIcon
                    kind={kind}
                    context="settings"
                    className="size-5"
                    provider={clientSettings.showThreadProviderBadge ? provider : null}
                    badgeSize={clientSettings.threadProviderBadgeSize}
                    badgeTransparency={clientSettings.threadProviderBadgeTransparency}
                  />
                  <span>
                    {kind === "laptop" ? "Local" : "Remote"} · {provider.displayName}
                  </span>
                </span>
              ))}
            </span>
          }
          control={
            <Switch
              checked={clientSettings.showThreadProviderBadge}
              onCheckedChange={(checked) =>
                updateClientSettings({ showThreadProviderBadge: Boolean(checked) })
              }
              aria-label="Show thread provider badges"
            />
          }
        />
        {clientSettings.showThreadProviderBadge ? (
          <>
            <SettingsRow
              {...searchableSetting("thread-provider-badge-size")}
              description="Provider badge size as a percentage of the machine icon."
              control={
                <SettingsSlider
                  id="thread-provider-badge-size-slider"
                  label="Provider badge size"
                  min={MIN_THREAD_PROVIDER_BADGE_SIZE}
                  max={MAX_THREAD_PROVIDER_BADGE_SIZE}
                  value={clientSettings.threadProviderBadgeSize}
                  unit="%"
                  onChange={(threadProviderBadgeSize) =>
                    updateClientSettings({ threadProviderBadgeSize })
                  }
                />
              }
            />
            <SettingsRow
              {...searchableSetting("thread-provider-badge-transparency")}
              description="0% keeps the provider logo opaque; 100% makes it fully transparent."
              control={
                <SettingsSlider
                  id="thread-provider-badge-transparency-slider"
                  label="Provider badge transparency"
                  min={MIN_THREAD_PROVIDER_BADGE_TRANSPARENCY}
                  max={MAX_THREAD_PROVIDER_BADGE_TRANSPARENCY}
                  value={clientSettings.threadProviderBadgeTransparency}
                  unit="%"
                  onChange={(threadProviderBadgeTransparency) =>
                    updateClientSettings({ threadProviderBadgeTransparency })
                  }
                />
              }
            />
          </>
        ) : null}
        {environmentSettings.map((environment) => {
          const color = clientSettings.environmentIconColors[environment.environmentId];
          const isLocal = environment.kind === "local";
          return (
            <SettingsRow
              key={environment.environmentId}
              title={
                <span className="inline-flex min-w-0 items-center gap-2">
                  <ConnectedEnvironmentIcon
                    environmentId={environment.environmentId}
                    context="settings"
                    color={color}
                    className="size-4 shrink-0"
                  />
                  <span className="truncate">{environment.label}</span>
                </span>
              }
              description={isLocal ? "Primary machine" : "Saved remote environment"}
            >
              <div className="space-y-4 px-0 pb-3 sm:px-4">
                <ProviderAccentColorPicker
                  displayName={environment.label}
                  value={color}
                  label="Icon color"
                  defaultOptionLabel="Default"
                  commitDelayMs={120}
                  onCommit={(value) =>
                    updateClientSettings((settings) => ({
                      environmentIconColors: updateEnvironmentIconColors(
                        settings.environmentIconColors,
                        environment.environmentId,
                        value,
                      ),
                    }))
                  }
                  description="Used for this environment in sidebars and thread details."
                />
                {isLocal ? (
                  <div className="flex items-center justify-between gap-6 border-border/70 border-t pt-4">
                    <div className="min-w-0 space-y-1">
                      <div className="text-xs font-medium text-foreground">Show local icon</div>
                      <p className="max-w-xl text-xs leading-snug text-muted-foreground">
                        Show this environment's machine icon for local threads even when provider
                        badges are off.
                      </p>
                    </div>
                    <Switch
                      checked={clientSettings.showLocalEnvironmentIcon}
                      onCheckedChange={(checked) =>
                        updateClientSettings({ showLocalEnvironmentIcon: Boolean(checked) })
                      }
                      aria-label="Show local icon"
                    />
                  </div>
                ) : null}
              </div>
            </SettingsRow>
          );
        })}
      </SettingsSection>
      <LastCodeImportSettings />
    </SettingsPageContainer>
  );
}
