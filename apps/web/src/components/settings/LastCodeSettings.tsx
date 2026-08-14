import type {
  DesktopLastCodeSettingsState,
  LastCodeSettingsImportPreview,
} from "@t3tools/contracts";
import { DownloadIcon, MoonStarIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { isElectron } from "../../env";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { searchableSetting } from "./settingsSearch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

export function LastCodeSettingsPanel() {
  const updateState = useDesktopUpdateState();
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
        ? "A checkpoint build is running. Progress and failures are recorded in ~/.lastcode/local-updates/build.log."
        : settings?.showAndInstallLocalNightlies
          ? "Enabled. LastCode checks your local checkpoint repository and shows new nightlies in the sidebar."
          : "Off by default. No local repositories, builds, or installers are touched while disabled."));

  return (
    <SettingsPageContainer>
      <SettingsSection title="LastCode" icon={<MoonStarIcon className="size-5" />}>
        <SettingsRow
          {...searchableSetting("local-nightlies")}
          description="Show local LastCode checkpoints as app updates. The first sidebar click runs full local CI, builds a DMG and updater ZIP, and stages the update; the second restarts and installs it."
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
