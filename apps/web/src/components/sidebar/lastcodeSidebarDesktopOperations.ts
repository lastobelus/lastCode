import type { DesktopBridge, DesktopUpdateState } from "@t3tools/contracts";
import { ensureLocalApi } from "../../localApi";
import {
  getDesktopUpdateActionError,
  getDesktopUpdateInstallConfirmationMessage,
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
          title: "Could not download update",
          description: actionError,
        }),
      );
    })
    .catch((error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not start update download",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
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
        title: "Could not confirm update",
        description: error instanceof Error ? error.message : "Update confirmation failed.",
      }),
    );
    return;
  }
  if (!confirmed) {
    setDesktopUpdateActionPending(false);
    return;
  }
  void bridge
    .installUpdate()
    .then((result) => {
      if (!shouldToastDesktopUpdateActionResult(result)) return;
      const actionError = getDesktopUpdateActionError(result);
      if (!actionError) return;
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not install update",
          description: actionError,
        }),
      );
    })
    .catch((error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not install update",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        }),
      );
    })
    .finally(() => setDesktopUpdateActionPending(false));
}
