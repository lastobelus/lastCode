import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ProjectScript, ScopedThreadRef } from "@t3tools/contracts";
import { msg } from "gt-react";
import { LayoutDashboard } from "lucide-react";

import { resolveDiscoveredServerUrl } from "~/browser/browserTargetResolver";
import { type OpenPreviewMutation, openUrlInPreview } from "~/browser/openFileInPreview";
import { m } from "~/i18n/messages";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";

import { stackedThreadToast, toastManager } from "./ui/toast";

/** The project Action whose `previewUrl` is the dashboards hub's index. */
const DASHBOARDS_SCRIPT_NAME = "dashboards";

function dashboardsPreviewUrl(scripts: readonly ProjectScript[]): string | null {
  return (
    scripts.find((script) => script.name.trim().toLowerCase() === DASHBOARDS_SCRIPT_NAME)
      ?.previewUrl ?? null
  );
}

/** Reveals the hub tab the reader used last, wherever it has navigated, or opens the index. */
async function openDashboards<E>(
  threadRef: ScopedThreadRef,
  previewUrl: string,
  openPreview: OpenPreviewMutation<E>,
): Promise<void> {
  const result = await openUrlInPreview({
    threadRef,
    url: resolveDiscoveredServerUrl(threadRef.environmentId, previewUrl),
    openPreview,
    reuse: "origin",
  });
  if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: m(msg("Could not open dashboards")),
      description: thrownErrorMessage(error, m) ?? m(msg("An unexpected error occurred.")),
    }),
  );
}

/** The [+] menu's Dashboards handler, absent in projects without a Dashboards Action. */
export function useDashboardsEntry(
  threadRef: ScopedThreadRef | null,
  scripts: readonly ProjectScript[],
): (() => void) | undefined {
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const previewUrl = dashboardsPreviewUrl(scripts);
  if (threadRef === null || previewUrl === null) return undefined;
  return () => {
    void openDashboards(threadRef, previewUrl, openPreview);
  };
}

/** Spread into the [+] menu's actions; empty when the project has no Dashboards Action. */
export function dashboardsMenuActions(
  onAddDashboards: (() => void) | undefined,
  available: boolean,
  disabledReason: string,
) {
  return onAddDashboards
    ? [
        {
          label: msg("Dashboards"),
          icon: LayoutDashboard,
          shortcut: "H",
          available,
          disabledReason,
          onClick: onAddDashboards,
        },
      ]
    : [];
}
