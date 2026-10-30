import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ContextMenuItem,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "../state/server";
import { readEnvironmentScope } from "../state/session";

export type ThreadReadOutcome = "applied" | "unchanged" | "unsupported" | "failed";

export function readEnvironmentSupportsVisitedTracking(environmentId: EnvironmentId) {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadVisitedTracking === true
  );
}

/** Synced markers require destination authority; older servers retain local markers. */
export function canMarkThreadReadState(target: ScopedThreadRef) {
  return (
    !readEnvironmentSupportsVisitedTracking(target.environmentId) ||
    readEnvironmentScope(target.environmentId, AuthOrchestrationOperateScope)
  );
}

export function withThreadReadPermissions<A extends string>(
  items: readonly ContextMenuItem<A>[],
  targets: readonly ScopedThreadRef[],
): readonly ContextMenuItem<A>[] {
  const permitted = targets.every(canMarkThreadReadState);
  return items.map((item) =>
    item.id === "mark-read" || item.id === "mark-unread"
      ? { ...item, disabled: item.disabled || !permitted }
      : item,
  );
}

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
