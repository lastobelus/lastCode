import type { DesktopLastCodeSettingsState } from "@t3tools/contracts";
import { MoonStarIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { isElectron } from "../../env";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { searchableSetting } from "./settingsSearch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

export function LastCodeSettingsPanel() {
  const updateState = useDesktopUpdateState();
  const [settings, setSettings] = useState<DesktopLastCodeSettingsState | null>(null);
  const [isSaving, setIsSaving] = useState(false);

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
    </SettingsPageContainer>
  );
}
