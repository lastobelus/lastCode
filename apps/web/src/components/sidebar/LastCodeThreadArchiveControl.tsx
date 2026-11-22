import { useEffect, useRef } from "react";
import { ArchiveIcon } from "lucide-react";
import type { SidebarThreadSummary } from "../../types";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useClientSettings } from "~/hooks/useSettings";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { checkTaskPermission } from "./lastcodeSidebarPermission";
import { useLastCodeThreadActions } from "./LastCodeThreadActions";
import type { LastCodeThreadActions } from "./LastCodeThreadActions";
import { readThreadShell } from "../../state/entities";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { reportThreadOperationFailure } from "./lastcodeThreadOperationResult";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type { LastCodeThreadEditingCapabilities } from "./useLastCodeThreadEditing";

const ARCHIVE_BUTTON_CLASS =
  "inline-flex h-6 min-w-6 cursor-pointer items-center justify-center rounded-md px-0.75 text-icon-muted hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring";
export function LastCodeThreadArchiveControl({
  thread,
  confirming,
  editing,
}: {
  thread: SidebarThreadSummary;
  confirming: boolean;
  editing: LastCodeThreadEditingCapabilities;
}) {
  const confirmRequired = useClientSettings((settings) => settings.confirmThreadArchive);
  const confirmButton = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!confirming) return;
    const frame = requestAnimationFrame(() => confirmButton.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [confirming]);
  const stopPointer = (event: React.PointerEvent<HTMLButtonElement>) => event.stopPropagation();
  const archive = useArchiveClick(thread, confirming, editing, confirmRequired);
  if (confirming)
    return (
      <button
        ref={confirmButton}
        type="button"
        data-thread-selection-safe
        data-testid={`thread-archive-confirm-${thread.id}`}
        aria-label={`Confirm archive ${thread.title}`}
        className="absolute top-1/2 right-1 inline-flex h-5 -translate-y-1/2 cursor-pointer items-center rounded-md bg-destructive/12 px-2 text-3xs font-medium text-destructive transition-colors hover:bg-destructive/18 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-destructive/40"
        onPointerDown={stopPointer}
        onClick={archive}
      >
        Confirm
      </button>
    );
  const control = (
    <div className="pointer-events-none absolute top-1/2 right-0.5 -translate-y-1/2 opacity-0 transition-opacity duration-150 max-sm:pointer-events-auto max-sm:opacity-100 group-hover/menu-sub-item:pointer-events-auto group-hover/menu-sub-item:opacity-100 group-focus-within/menu-sub-item:pointer-events-auto group-focus-within/menu-sub-item:opacity-100">
      <button
        type="button"
        data-thread-selection-safe
        data-testid={`thread-archive-${thread.id}`}
        aria-label={`Archive ${thread.title}`}
        className={ARCHIVE_BUTTON_CLASS}
        onPointerDown={stopPointer}
        onClick={archive}
      >
        <ArchiveIcon className="size-3.5" />
      </button>
    </div>
  );
  return confirmRequired ? (
    control
  ) : (
    <Tooltip>
      <TooltipTrigger render={control} />
      <TooltipPopup side="top">Archive</TooltipPopup>
    </Tooltip>
  );
}

export async function archiveLastCodeThread(
  ref: ScopedThreadRef,
  inlineConfirmed: boolean,
  archive: LastCodeThreadActions["archiveThread"],
) {
  if (!checkTaskPermission(ref.environmentId)) return;
  if (readThreadShell(ref)?.persistent === true) {
    toastManager.add(
      stackedThreadToast({
        type: "warning",
        title: "Persistent thread not archived",
        description: "Disable persistence or move it to another thread first.",
      }),
    );
    return;
  }
  const result = inlineConfirmed ? await archive(ref, { confirmed: true }) : await archive(ref);
  reportThreadOperationFailure(result, "Failed to archive thread");
}

/** Inline confirmation is independent from the shared family archive confirmation. */
function useArchiveClick(
  thread: SidebarThreadSummary,
  confirming: boolean,
  editing: LastCodeThreadEditingCapabilities,
  confirmRequired: boolean,
) {
  const { archiveThread } = useLastCodeThreadActions();
  const ref = scopeThreadRef(thread.environmentId, thread.id);
  return (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (confirming) editing.cancelArchiveConfirmation(ref);
    if (thread.persistent) return;
    if (!confirming && confirmRequired) {
      if (checkTaskPermission(thread.environmentId)) editing.requestArchiveConfirmation(ref);
      return;
    }
    void archiveLastCodeThread(ref, confirming, archiveThread);
  };
}
