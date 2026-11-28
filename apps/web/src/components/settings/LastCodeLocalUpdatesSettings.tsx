import { type DesktopLastCodeSettingsState, type DesktopUpdateState } from "@t3tools/contracts";
import { msg, useGT, useMessages } from "gt-react";
import { MoonStarIcon } from "lucide-react";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { useEffect, useState } from "react";
import { isElectron } from "../../env";
import { m, type MessageResolver } from "../../i18n/messages";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { useSearchableSetting } from "./settingsSearch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

function useLocalNightlyPreference() {
  const [settings, setSettings] = useState<DesktopLastCodeSettingsState | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the native desktop update preference when this settings control mounts
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
            title: m(msg("Could not load {lastCode} settings", { lastCode: "LastCode" })),
            description:
              error instanceof Error ? error.message : m(msg("Desktop settings read failed.")),
          }),
        );
      });
  }, []);

  const setLocalNightlies = async (enabled: boolean) => {
    const bridge = window.desktopBridge;
    if (!bridge || typeof bridge.setShowAndInstallLocalNightlies !== "function") return;
    setIsSaving(true);
    await (async () => {
      setSettings(await bridge.setShowAndInstallLocalNightlies(enabled));
    })()
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: m(msg("Could not change local nightly updates")),
            description:
              error instanceof Error ? error.message : m(msg("Desktop settings write failed.")),
          }),
        );
      })
      .finally(() => {
        setIsSaving(false);
      });
  };

  return { settings, isSaving, setLocalNightlies };
}

function useCheckpointRequest() {
  const [isRequesting, setIsRequesting] = useState(false);

  const requestCheckpoint = () => {
    const bridge = window.desktopBridge;
    if (!bridge || typeof bridge.checkForUpdate !== "function") return;
    setIsRequesting(true);
    void bridge
      .checkForUpdate({ requestCheckpoint: true })
      .then((result) => {
        if (result.error || !result.checked) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: m(msg("Could not request a checkpoint")),
              description: result.error ?? result.state.message ?? m(msg("The check did not run.")),
            }),
          );
          return;
        }
        toastManager.add(
          stackedThreadToast({
            type: "success",
            title: result.checkpointRequested
              ? m(msg("Checkpoint requested"))
              : m(msg("Checked for updates")),
            description: result.checkpointRequested
              ? m(
                  msg(
                    "The checkpoint service is running. Check again later to pick up its result.",
                  ),
                )
              : m(
                  msg(
                    "The checkpoint service is not installed on this Mac, so only existing releases were checked.",
                  ),
                ),
          }),
        );
      })
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: m(msg("Could not request a checkpoint")),
            description:
              error instanceof Error ? error.message : m(msg("Checkpoint request failed.")),
          }),
        );
      })
      .finally(() => setIsRequesting(false));
  };

  return { isRequesting, requestCheckpoint };
}

function localNightlyStatus(
  settings: DesktopLastCodeSettingsState | null,
  updateState: DesktopUpdateState | null,
  resolve: MessageResolver,
) {
  if (!isElectron) {
    return resolve(
      msg("Open this page in the {lastCode} desktop app to configure local builds.", {
        lastCode: "LastCode",
      }),
    );
  }
  if (settings?.message != null) return settings.message;
  if (updateState?.source === "lastcode-local" && updateState.status === "downloading") {
    return resolve(
      msg("A local update build is running. Progress and failures are recorded in {buildLog}.", {
        buildLog: "~/.lastcode/local-updates/build.log",
      }),
    );
  }
  if (settings?.showAndInstallLocalNightlies) {
    return resolve(
      msg(
        "Enabled. {lastCode} checks your local repository and shows new checkpoints and {lastCode} revisions in the sidebar.",
        { lastCode: "LastCode" },
      ),
    );
  }
  return resolve(
    msg("Off by default. No local repositories, builds, or installers are touched while disabled."),
  );
}

export function LastCodeLocalUpdatesSettings() {
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  const resolve = useMessages();
  const updateState = useDesktopUpdateState();
  const { settings, isSaving, setLocalNightlies } = useLocalNightlyPreference();
  const { isRequesting, requestCheckpoint } = useCheckpointRequest();
  const localUpdateActive =
    updateState?.source === "lastcode-local" &&
    (updateState.status === "downloading" || updateState.status === "downloaded");
  const status = localNightlyStatus(settings, updateState, resolve);

  return (
    <SettingsSection title="LastCode" icon={<MoonStarIcon className="size-5" />}>
      <SettingsRow
        {...searchableSetting("local-nightlies")}
        description={gt(
          "Show local {lastCode} checkpoints and revisions as app updates. The first sidebar click runs full local CI and builds and validates a DMG; the second restarts and installs it.",
          { lastCode: "LastCode" },
        )}
        status={status}
        control={
          <Switch
            checked={settings?.showAndInstallLocalNightlies ?? false}
            disabled={
              !isElectron || !settings || !settings.supported || isSaving || localUpdateActive
            }
            onCheckedChange={(checked) => void setLocalNightlies(Boolean(checked))}
            aria-label={gt("Show and install local nightlies")}
          />
        }
      />
      <SettingsRow
        {...searchableSetting("local-checkpoint-request")}
        description={gt(
          "Ask the checkpoint service for a new checkpoint now. Checking for updates only finds releases that are already built.",
        )}
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={
              !isElectron ||
              !settings?.showAndInstallLocalNightlies ||
              isRequesting ||
              updateState?.status === "checking"
            }
            onClick={requestCheckpoint}
          >
            {gt("Request checkpoint")}
          </Button>
        }
      />
    </SettingsSection>
  );
}
