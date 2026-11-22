import { msg } from "gt-react";
import { m } from "~/i18n/messages";
import type { DesktopBridge, DesktopUpdateState } from "@t3tools/contracts";
import { ensureLocalApi } from "../../localApi";
import {
  getDesktopUpdateActionError,
  getDesktopUpdateInstallConfirmationMessage,
  getDesktopUpdateInstallRefusal,
  shouldToastDesktopUpdateActionResult,
} from "../desktopUpdate.logic";
import { showDesktopUpdateDownloadedToast } from "../desktopUpdate.toast";
import { stackedThreadToast, toastManager } from "../ui/toast";
type UpdateBridge = Pick<DesktopBridge, "downloadUpdate" | "installUpdate" | "openExternal">;
export function downloadLastCodeSidebarUpdate(
  bridge: UpdateBridge,
  setDesktopUpdateActionPending: (pending: boolean) => void,
) {
  void bridge
    .downloadUpdate()
    .then((result) => {
      if (result.completed) {
        showDesktopUpdateDownloadedToast(bridge, result.state);
      }
      if (!shouldToastDesktopUpdateActionResult(result)) return;
      const actionError = getDesktopUpdateActionError(result);
      if (!actionError) return;
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: m(msg("Could not download update")),
          description: actionError,
        }),
      );
    })
    .catch((error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: m(msg("Could not start update download")),
          description:
            error instanceof Error ? error.message : m(msg("An unexpected error occurred.")),
        }),
      );
    })
    .finally(() => setDesktopUpdateActionPending(false));
}
export async function installLastCodeSidebarUpdate(
  bridge: UpdateBridge,
  desktopUpdateState: DesktopUpdateState,
  setDesktopUpdateActionPending: (pending: boolean) => void,
) {
  let confirmed = false;
  try {
    confirmed = await ensureLocalApi().dialogs.confirm(
      getDesktopUpdateInstallConfirmationMessage(desktopUpdateState),
    );
  } catch (error) {
    setDesktopUpdateActionPending(false);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: m(msg("Could not confirm update")),
        description: error instanceof Error ? error.message : m(msg("Update confirmation failed.")),
      }),
    );
    return;
  }
  if (!confirmed) {
    setDesktopUpdateActionPending(false);
    return;
  }
  void bridge
    .installUpdate(desktopUpdateState.downloadedVersion ?? undefined)
    .then((result) => {
      const refusal = getDesktopUpdateInstallRefusal(
        result,
        desktopUpdateState.downloadedVersion ?? undefined,
      );
      const actionError =
        refusal ??
        (shouldToastDesktopUpdateActionResult(result) ? getDesktopUpdateActionError(result) : null);
      if (!actionError) return;
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: refusal ? m(msg("Update not installed")) : m(msg("Could not install update")),
          description: actionError,
        }),
      );
    })
    .catch((error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: m(msg("Could not install update")),
          description:
            error instanceof Error ? error.message : m(msg("An unexpected error occurred.")),
        }),
      );
    })
    .finally(() => setDesktopUpdateActionPending(false));
}
