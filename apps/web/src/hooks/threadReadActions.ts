import type { ScopedThreadRef } from "@t3tools/contracts";
import { stackedThreadToast, toastManager } from "../components/ui/toast";

export type ThreadReadOutcome = "applied" | "unchanged" | "unsupported" | "failed";

/** Bulk menus report each failure class once, without discarding their selection. */
export async function markThreadsReadState(
  targets: readonly ScopedThreadRef[],
  mark: (target: ScopedThreadRef, report: boolean) => Promise<ThreadReadOutcome>,
) {
  const results = await Promise.all(targets.map((target) => mark(target, false)));
  const unsupported = results.filter((result) => result === "unsupported").length;
  const failed = results.filter((result) => result === "failed").length;
  if (unsupported)
    toastManager.add(
      stackedThreadToast({
        type: "info",
        title: "Some threads could not be marked unread",
        description: `${unsupported} of ${targets.length} threads have no completed reply yet.`,
      }),
    );
  if (failed)
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Read markers could not be saved",
        description: `${failed} of ${targets.length} read markers could not be saved. Reconnect and try again.`,
      }),
    );
}
