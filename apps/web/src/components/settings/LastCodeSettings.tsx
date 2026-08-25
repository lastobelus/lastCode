import type {
  DesktopLastCodeSettingsState,
  LastCodeSettingsImportPreview,
} from "@t3tools/contracts";
import {
  DEFAULT_LEGACY_SIDEBAR_SCALE,
  LEGACY_SIDEBAR_SCALE_REFERENCE,
  MAX_LEGACY_SIDEBAR_SCALE,
  MIN_LEGACY_SIDEBAR_SCALE,
} from "@t3tools/contracts/settings";
import { useAtomValue } from "@effect/atom-react";
import { DownloadIcon, MoonStarIcon, PaletteIcon, ServerIcon } from "lucide-react";
import { type CSSProperties, useCallback, useEffect, useMemo, useState } from "react";

import { environmentCatalog } from "../../connection/catalog";
import { isElectron } from "../../env";
import { EnvironmentIcon, updateEnvironmentIconColors } from "../../environmentIcons";
import { usePrimarySettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { searchableSetting } from "./settingsSearch";
import { ProviderAccentColorPicker } from "./ProviderAccentColorPicker";
import { deriveLastCodeEnvironmentSettingEntries } from "./LastCodeSettings.logic";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";

export function LastCodeSettingsPanel() {
  const updateState = useDesktopUpdateState();
  const clientSettings = usePrimarySettings();
  const updateClientSettings = useUpdateClientSettings();
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const [settings, setSettings] = useState<DesktopLastCodeSettingsState | null>(null);
  const [importPreview, setImportPreview] = useState<LastCodeSettingsImportPreview | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isImporting, setIsImporting] = useState(false);

  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge || typeof bridge.getLastCodeSettings !== "function") return;
    void bridge
      .getLastCodeSettings()
      .then(setSettings)
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not load LastCode settings",
            description: error instanceof Error ? error.message : "Desktop settings read failed.",
          }),
        );
      });
  }, []);

  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge || typeof bridge.previewT3SettingsImport !== "function") return;
    void bridge
      .previewT3SettingsImport()
      .then(setImportPreview)
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not inspect T3 Code settings",
            description: error instanceof Error ? error.message : "Settings preview failed.",
          }),
        );
      });
  }, []);

  const setLocalNightlies = useCallback(async (enabled: boolean) => {
    const bridge = window.desktopBridge;
    if (!bridge || typeof bridge.setShowAndInstallLocalNightlies !== "function") return;
    setIsSaving(true);
    try {
      setSettings(await bridge.setShowAndInstallLocalNightlies(enabled));
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not change local nightly updates",
          description: error instanceof Error ? error.message : "Desktop settings write failed.",
        }),
      );
    } finally {
      setIsSaving(false);
    }
  }, []);

  const importSettings = useCallback(async () => {
    const bridge = window.desktopBridge;
    if (!bridge || typeof bridge.importT3Settings !== "function") return;
    setIsImporting(true);
    try {
      const result = await bridge.importT3Settings();
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: "T3 Code settings imported",
          description: `Backed up the previous LastCode settings to ${result.backupDirectory}. Restarting LastCode…`,
        }),
      );
    } catch (error) {
      setIsImporting(false);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not import T3 Code settings",
          description: error instanceof Error ? error.message : "Settings import failed.",
        }),
      );
    }
  }, []);

  const localUpdateActive =
    updateState?.source === "lastcode-local" &&
    (updateState.status === "downloading" || updateState.status === "downloaded");
  const status = !isElectron
    ? "Open this page in the LastCode desktop app to configure local builds."
    : (settings?.message ??
      (updateState?.source === "lastcode-local" && updateState.status === "downloading"
        ? "A local update build is running. Progress and failures are recorded in ~/.lastcode/local-updates/build.log."
        : settings?.showAndInstallLocalNightlies
          ? "Enabled. LastCode checks your local repository and shows new checkpoints and LastCode revisions in the sidebar."
          : "Off by default. No local repositories, builds, or installers are touched while disabled."));
  const legacySidebarScaleRatio =
    (clientSettings.legacySidebarScale - MIN_LEGACY_SIDEBAR_SCALE) /
    (MAX_LEGACY_SIDEBAR_SCALE - MIN_LEGACY_SIDEBAR_SCALE);
  const legacySidebarScaleSliderStyle = {
    "--settings-slider-progress": `${legacySidebarScaleRatio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - legacySidebarScaleRatio}rem`,
  } as CSSProperties;
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
      <SettingsSection title="LastCode" icon={<MoonStarIcon className="size-5" />}>
        <SettingsRow
          {...searchableSetting("local-nightlies")}
          description="Show local LastCode checkpoints and revisions as app updates. The first sidebar click runs full local CI and builds and validates a DMG; the second restarts and installs it."
          status={status}
          control={
            <Switch
              checked={settings?.showAndInstallLocalNightlies ?? false}
              disabled={
                !isElectron || !settings || !settings.supported || isSaving || localUpdateActive
              }
              onCheckedChange={(checked) => void setLocalNightlies(Boolean(checked))}
              aria-label="Show and install local nightlies"
            />
          }
        />
      </SettingsSection>
      <SettingsSection title="Appearance" icon={<PaletteIcon className="size-5" />}>
        <SettingsRow
          {...searchableSetting("scale-legacy-sidebar")}
          description="Scale legacy project and thread rows while leaving the sidebar header, Search field, and Projects heading unchanged. The 75% marker matches the normalized version of the original compact-sidebar patch."
          resetAction={
            clientSettings.legacySidebarScale !== DEFAULT_LEGACY_SIDEBAR_SCALE ? (
              <SettingResetButton
                label="legacy sidebar scale"
                onClick={() =>
                  updateClientSettings({ legacySidebarScale: DEFAULT_LEGACY_SIDEBAR_SCALE })
                }
              />
            ) : null
          }
          control={
            <div className="flex w-full items-center gap-3 sm:w-64">
              <output
                className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
                htmlFor="legacy-sidebar-scale"
              >
                {clientSettings.legacySidebarScale}%
              </output>
              <div className="relative min-w-0 flex-1 pb-3">
                <input
                  aria-label="Scale legacy sidebar"
                  className="settings-slider block w-full"
                  id="legacy-sidebar-scale"
                  max={MAX_LEGACY_SIDEBAR_SCALE}
                  min={MIN_LEGACY_SIDEBAR_SCALE}
                  onChange={(event) => {
                    const legacySidebarScale = Number(event.currentTarget.value);
                    if (
                      Number.isInteger(legacySidebarScale) &&
                      legacySidebarScale >= MIN_LEGACY_SIDEBAR_SCALE &&
                      legacySidebarScale <= MAX_LEGACY_SIDEBAR_SCALE
                    ) {
                      updateClientSettings({ legacySidebarScale });
                    }
                  }}
                  step={1}
                  style={legacySidebarScaleSliderStyle}
                  type="range"
                  value={clientSettings.legacySidebarScale}
                />
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute top-5 left-1/2 flex -translate-x-1/2 flex-col items-center text-[9px] leading-none text-muted-foreground"
                >
                  <span className="h-1.5 border-muted-foreground/60 border-l" />
                  <span className="mt-0.5">{LEGACY_SIDEBAR_SCALE_REFERENCE}%</span>
                </span>
              </div>
            </div>
          }
        />
        <SettingsRow
          {...searchableSetting("rounded-project-icons")}
          description="Round the corners of project favicon images. Leave this off to show each icon's original shape."
          control={
            <Switch
              checked={clientSettings.roundedProjectIcons}
              onCheckedChange={(checked) =>
                updateClientSettings({ roundedProjectIcons: Boolean(checked) })
              }
              aria-label="Rounded project icons"
            />
          }
        />
      </SettingsSection>
      <SettingsSection
        id="environment-icons"
        title="Environments"
        icon={<ServerIcon className="size-5" />}
      >
        {environmentSettings.map((environment) => {
          const color = clientSettings.environmentIconColors[environment.environmentId];
          const isLocal = environment.kind === "local";
          return (
            <SettingsRow
              key={environment.environmentId}
              title={
                <span className="inline-flex min-w-0 items-center gap-2">
                  <EnvironmentIcon
                    kind={isLocal ? "monitor" : "server"}
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
                      <p className="max-w-xl text-xs leading-[1.45] text-muted-foreground">
                        Show a Monitor icon for local threads. Legacy rows always reserve its space.
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
      <SettingsSection title="Import from T3 Code" icon={<DownloadIcon className="size-5" />}>
        <SettingsRow
          {...searchableSetting("import-t3-settings")}
          description="Copy selected preferences into LastCode once, back up the current LastCode files, then restart. The two apps remain independent after the import."
          status={
            !isElectron ? (
              "Open this page in the LastCode desktop app to import settings."
            ) : importPreview ? (
              <div className="space-y-1.5">
                <p>Source: {importPreview.sourceDirectory}</p>
                {importPreview.message ? <p>{importPreview.message}</p> : null}
                <ul className="space-y-0.5">
                  {importPreview.categories.map((category) => (
                    <li key={category.id}>
                      <span className="text-foreground/80">{category.label}</span>{" "}
                      <span>
                        ({category.sourceFile}) — {category.status}
                      </span>
                      {category.status === "ready" ? <span>: {category.detail}</span> : null}
                    </li>
                  ))}
                </ul>
                <p>Not imported: {importPreview.excluded.join("; ")}.</p>
              </div>
            ) : (
              "Inspecting ~/.t3/userdata…"
            )
          }
          control={
            <Button
              size="sm"
              variant="outline"
              disabled={!importPreview?.canImport || isImporting}
              onClick={() => void importSettings()}
            >
              {isImporting ? "Importing…" : "Import and restart"}
            </Button>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
