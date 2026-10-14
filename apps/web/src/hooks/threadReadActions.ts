import type { ScopedThreadRef } from "@t3tools/contracts";
import { stackedThreadToast, toastManager } from "../components/ui/toast";

/** Bulk menus report unsupported targets once, without discarding their selection. */
export function markThreadsUnread(
  targets: readonly ScopedThreadRef[],
  markUnread: (target: ScopedThreadRef, reportUnsupported: boolean) => boolean | void,
) {
  const unsupported = targets.filter((target) => markUnread(target, false) === false).length;
  if (unsupported)
    toastManager.add(
      stackedThreadToast({
        type: "info",
        title: "Some threads could not be marked unread",
        description: `${unsupported} of ${targets.length} threads have no completed reply yet.`,
      }),
    );
}
