import type { ContextMenuItem } from "@t3tools/contracts";
import type { SidebarThreadSummary } from "../../types";
import {
  lastcodeThreadPersistenceAction,
  protectLegacyThreadActions,
} from "../lastcodeThreadPersistence.logic";
import {
  buildStopThreadProcessesMenuItem,
  withThreadActionMenuDividers,
} from "../threadActionMenu.logic";

// Every static item is explicitly classified, including disabled guidance rows.
export const LASTCODE_THREAD_ACTION_POLICY = {
  "new-thread-on-branch": false,
  rename: true,
  annotate: true,
  "mark-unread": false,
  "creator-independent": true,
  "creator-grouped": true,
  "open-creator": false,
  "mark-persistent": true,
  "disable-persistence": true,
  "stop-thread-processes": true,
  "copy-path": false,
  "copy-thread-id": false,
  "open-dashboard": false,
  "project-settings": false,
  "handoffs-heading": false,
  "handoffs-empty": false,
  "handoff-show-all": false,
  "dismiss-archive-failure": true,
  delete: true,
} as const;
export type LastCodeThreadActionId = keyof typeof LASTCODE_THREAD_ACTION_POLICY;
export function isLastCodeThreadActionId(action: string | null): action is LastCodeThreadActionId {
  return (
    action !== null && Object.prototype.hasOwnProperty.call(LASTCODE_THREAD_ACTION_POLICY, action)
  );
}
export function lastcodeThreadActionRequiresOperate(action: string | null): boolean {
  return isLastCodeThreadActionId(action) && LASTCODE_THREAD_ACTION_POLICY[action];
}
export function parseLastCodeHandoffAction(action: string | null) {
  if (action === "handoff-show-all") return { kind: "all" } as const;
  if (action?.startsWith("handoff:"))
    return { kind: "entry", id: action.slice("handoff:".length) } as const;
  return null;
}

interface ThreadMenuInput {
  thread: Pick<
    SidebarThreadSummary,
    "branch" | "creatorGrouping" | "persistent" | "archivePending"
  >;
  creator: { groupingEligible: boolean; canOpen: boolean };
  canAnnotate: boolean;
  supportsPersistence: boolean;
  hasStoppableProcesses: boolean;
  projectSettingsKey: string | null;
  handoffs: { entries: readonly { id: string; label: string }[]; hasMore: boolean };
  canOperate: boolean;
}

function metadataItems(input: ThreadMenuInput): ContextMenuItem<string>[] {
  const items: ContextMenuItem<string>[] = [];
  if (input.thread.branch) {
    items.push({ id: "new-thread-on-branch", label: `New thread on ${input.thread.branch}` });
  }
  items.push({ id: "rename", label: "Rename thread" });
  if (input.canAnnotate) items.push({ id: "annotate", label: "Annotate thread…" });
  items.push({ id: "mark-unread", label: "Mark unread" });
  if (input.creator.groupingEligible) {
    const grouped = input.thread.creatorGrouping === "grouped";
    items.push({
      id: grouped ? "creator-independent" : "creator-grouped",
      label: grouped ? "Move to top level" : "Group with creator thread",
    });
  }
  if (input.creator.canOpen) items.push({ id: "open-creator", label: "Open creator thread" });
  return items;
}

function processItems(input: ThreadMenuInput): ContextMenuItem<string>[] {
  const items: ContextMenuItem<string>[] = [];
  const persistence = lastcodeThreadPersistenceAction({
    persistent: input.thread.persistent === true,
    supported: input.supportsPersistence,
  });
  if (persistence) items.push(persistence);
  const stopProcesses = buildStopThreadProcessesMenuItem(input.hasStoppableProcesses);
  if (stopProcesses) items.push(stopProcesses);
  return items;
}

function handoffItems(handoffs: ThreadMenuInput["handoffs"]): ContextMenuItem<string>[] {
  const items: ContextMenuItem<string>[] = [
    { id: "handoffs-heading", label: "Handoffs", disabled: true, separatorBefore: true },
  ];
  if (handoffs.entries.length === 0) {
    items.push({ id: "handoffs-empty", label: "No handoffs yet", disabled: true });
  } else {
    items.push(...handoffs.entries.map(({ id, label }) => ({ id: `handoff:${id}`, label })));
  }
  if (handoffs.hasMore) items.push({ id: "handoff-show-all", label: "Show all…" });
  return items;
}

export function buildLastCodeThreadMenu(input: ThreadMenuInput): ContextMenuItem<string>[] {
  const items = [
    ...metadataItems(input),
    ...processItems(input),
    { id: "copy-path", label: "Copy Path" },
    { id: "copy-thread-id", label: "Copy Thread ID" },
    { id: "open-dashboard", label: "Open dashboard", icon: "layout-dashboard" as const },
    {
      id: "project-settings",
      label: "Project settings",
      disabled: input.projectSettingsKey === null,
    },
    ...handoffItems(input.handoffs),
  ];
  if (input.thread.archivePending?.status === "failed") {
    items.push({ id: "dismiss-archive-failure", label: "Dismiss archive failure" });
  }
  const menu: ContextMenuItem<string>[] = [
    ...items,
    { id: "delete", separatorBefore: true, label: "Delete", destructive: true, icon: "trash" },
  ];
  return protectLegacyThreadActions(
    withThreadActionMenuDividers(menu),
    input.thread.persistent === true,
  ).map((item) =>
    lastcodeThreadActionRequiresOperate(item.id)
      ? { ...item, disabled: item.disabled || !input.canOperate }
      : item,
  );
}
