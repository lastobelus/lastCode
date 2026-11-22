import { T, useGT } from "gt-react";
import { ProviderDriverKind } from "@t3tools/contracts";
import {
  MIN_THREAD_PROVIDER_BADGE_SIZE,
  MAX_THREAD_PROVIDER_BADGE_SIZE,
  MIN_THREAD_PROVIDER_BADGE_TRANSPARENCY,
  MAX_THREAD_PROVIDER_BADGE_TRANSPARENCY,
} from "@t3tools/contracts/settings";
import { useAtomValue } from "@effect/atom-react";
import { ServerIcon } from "lucide-react";
import { environmentCatalog } from "../../connection/catalog";
import { ConnectedEnvironmentIcon, updateEnvironmentIconColors } from "../../environmentIcons";
import { usePrimarySettings, updateClientSettings } from "../../hooks/useSettings";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { SidebarEnvironmentIcon } from "../sidebar/SidebarEnvironmentIcon";
import { Switch } from "../ui/switch";
import { useSearchableSetting } from "./settingsSearch";
import { ProviderAccentColorPicker } from "./ProviderAccentColorPicker";
import {
  deriveLastCodeEnvironmentSettingEntries,
  type LastCodeEnvironmentSettingEntry,
} from "./LastCodeSettings.logic";
import { LastCodeSettingsSlider as SettingsSlider } from "./LastCodeSettingsSlider";
import { SettingsRow, SettingsSection } from "./settingsLayout";

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

function ProviderBadgePreview() {
  const gt = useGT();
  const clientSettings = usePrimarySettings();
  return (
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
            {kind === "laptop"
              ? gt("Local · {provider}", { provider: provider.displayName })
              : gt("Remote · {provider}", { provider: provider.displayName })}
          </span>
        </span>
      ))}
    </span>
  );
}

function ProviderBadgeSettings() {
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  const clientSettings = usePrimarySettings();
  return (
    <>
      <SettingsRow
        {...searchableSetting("show-thread-provider-badges")}
        description={gt(
          "Show the thread's provider logo at the lower-right of its machine icon in the sidebar. Badges also show machine icons for local threads when Show local icon is off.",
        )}
        status={<ProviderBadgePreview />}
        control={
          <Switch
            checked={clientSettings.showThreadProviderBadge}
            onCheckedChange={(checked) =>
              updateClientSettings({ showThreadProviderBadge: Boolean(checked) })
            }
            aria-label={gt("Show thread provider badges")}
          />
        }
      />
      {clientSettings.showThreadProviderBadge ? (
        <>
          <SettingsRow
            {...searchableSetting("thread-provider-badge-size")}
            description={gt("Provider badge size as a percentage of the machine icon.")}
            control={
              <SettingsSlider
                id="thread-provider-badge-size-slider"
                label={gt("Provider badge size")}
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
            description={gt("0% keeps the provider logo opaque; 100% makes it fully transparent.")}
            control={
              <SettingsSlider
                id="thread-provider-badge-transparency-slider"
                label={gt("Provider badge transparency")}
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
    </>
  );
}

function EnvironmentIconSetting({ environment }: { environment: LastCodeEnvironmentSettingEntry }) {
  const gt = useGT();
  const clientSettings = usePrimarySettings();
  const color = clientSettings.environmentIconColors[environment.environmentId];
  const isLocal = environment.kind === "local";
  return (
    <SettingsRow
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
      description={isLocal ? gt("Primary machine") : gt("Saved remote environment")}
    >
      <div className="space-y-4 px-0 pb-3 sm:px-4">
        <ProviderAccentColorPicker
          displayName={environment.label}
          value={color}
          label={gt("Icon color")}
          defaultOptionLabel={gt("Default")}
          onCommit={(value) =>
            updateClientSettings((settings) => ({
              environmentIconColors: updateEnvironmentIconColors(
                settings.environmentIconColors,
                environment.environmentId,
                value,
              ),
            }))
          }
          description={gt("Used for this environment in sidebars and thread details.")}
        />
        {isLocal ? (
          <div className="flex items-center justify-between gap-6 border-border/70 border-t pt-4">
            <div className="min-w-0 space-y-1">
              <div className="text-xs font-medium text-foreground">{gt("Show local icon")}</div>
              <p className="max-w-xl text-xs leading-snug text-muted-foreground">
                <T>
                  Show this environment's machine icon for local threads even when provider badges
                  are off.
                </T>
              </p>
            </div>
            <Switch
              checked={clientSettings.showLocalEnvironmentIcon}
              onCheckedChange={(checked) =>
                updateClientSettings({ showLocalEnvironmentIcon: Boolean(checked) })
              }
              aria-label={gt("Show local icon")}
            />
          </div>
        ) : null}
      </div>
    </SettingsRow>
  );
}

export function LastCodeEnvironmentIconSettings() {
  const gt = useGT();
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environmentSettings = deriveLastCodeEnvironmentSettingEntries({
    entries: catalog.entries,
    primaryEnvironmentId,
  });

  return (
    <SettingsSection
      id="environment-icons"
      title={gt("Environments")}
      icon={<ServerIcon className="size-5" />}
    >
      <ProviderBadgeSettings />
      {environmentSettings.map((environment) => (
        <EnvironmentIconSetting key={environment.environmentId} environment={environment} />
      ))}
    </SettingsSection>
  );
}
