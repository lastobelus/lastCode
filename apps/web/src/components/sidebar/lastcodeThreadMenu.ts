import { msg } from "gt-react";
import { m } from "~/i18n/messages";
import type { ContextMenuItem, ThreadId, ThreadOwnershipAvailability } from "@t3tools/contracts";
import {
  delegatedTaskInFlight,
  promoteThreadLabel,
  remoteOwnerStateUnchecked,
  returnThreadToOwnerLabel,
  threadOwnerUnavailable,
  threadOwnershipUnavailable,
} from "./lastcodeThreadPromotionCopy";
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
  "resolve-annotation": true,
  "mark-unread": false,
  "mark-read": false,
  "creator-independent": true,
  "creator-grouped": true,
  promote: true,
  "return-to-owner": true,
  "open-creator": false,
  "mark-persistent": true,
  "disable-persistence": true,
  "stop-thread-processes": true,
  "copy-path": false,
  "copy-thread-id": false,
  "project-settings": false,
  "handoffs-heading": false,
  "handoffs-empty": false,
  "handoff-show-all": false,
  "dismiss-archive-failure": true,
  delete: true,
  "archive-discard": true,
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
  thread: Pick<SidebarThreadSummary, "branch" | "persistent" | "archivePending">;
  parentThreadId: ThreadId | null;
  creator: { groupingEligible: boolean; canOpen: boolean; description?: string | null };
  ownership?: ThreadOwnershipAvailability;
  canAnnotate: boolean;
  hasActiveAnnotation: boolean;
  supportsPersistence: boolean;
  hasStoppableProcesses: boolean;
  projectSettingsKey: string | null;
  handoffs: { entries: readonly { id: string; label: string }[]; hasMore: boolean };
  canOperate: boolean;
}

function metadataItems(input: ThreadMenuInput): ContextMenuItem<string>[] {
  const items: ContextMenuItem<string>[] = [];
  if (input.thread.branch) {
    items.push({
      id: "new-thread-on-branch",
      label: m(msg("New thread on {branch}", { branch: input.thread.branch })),
    });
  }
  items.push({ id: "rename", label: m(msg("Rename thread")) });
  if (input.canAnnotate) {
    items.push({
      id: "annotate",
      label: input.hasActiveAnnotation ? m(msg("Edit Annotation…")) : m(msg("Annotate thread…")),
    });
    if (input.hasActiveAnnotation)
      items.push({ id: "resolve-annotation", label: m(msg("Resolve Annotation…")) });
  }
  items.push({ id: "mark-unread", label: m(msg("Mark unread")) });
  items.push({ id: "mark-read", label: m(msg("Mark read")) });
  const ownership = input.ownership;
  if (ownership) {
    const returning = ownership.action === "return_to_owner";
    const refusal = {
      in_flight: delegatedTaskInFlight,
      owner_unavailable: threadOwnerUnavailable,
      unavailable: threadOwnershipUnavailable,
    };
    const detail =
      ownership.refusal !== null
        ? refusal[ownership.refusal]
        : returning && !ownership.ownerHere
          ? remoteOwnerStateUnchecked
          : undefined;
    items.push({
      id: returning ? "return-to-owner" : "promote",
      label: m(returning ? returnThreadToOwnerLabel : promoteThreadLabel),
      disabled: ownership.refusal !== null,
      ...(detail === undefined ? {} : { detail: m(detail) }),
    });
  }
  if (
    ownership?.action !== "promote" &&
    (input.parentThreadId !== null || input.creator.groupingEligible)
  ) {
    const grouped = input.parentThreadId !== null;
    items.push({
      id: grouped ? "creator-independent" : "creator-grouped",
      label: grouped ? m(msg("Move to top level")) : m(msg("Group with creator thread")),
    });
  }
  if (input.creator.canOpen || input.creator.description)
    items.push({
      id: "open-creator",
      label: input.creator.description ?? m(msg("Open creator thread")),
      disabled: !input.creator.canOpen,
    });
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
    { id: "handoffs-heading", label: m(msg("Handoffs")), disabled: true, separatorBefore: true },
  ];
  if (handoffs.entries.length === 0) {
    items.push({ id: "handoffs-empty", label: m(msg("No handoffs yet")), disabled: true });
  } else {
    items.push(...handoffs.entries.map(({ id, label }) => ({ id: `handoff:${id}`, label })));
  }
  if (handoffs.hasMore) items.push({ id: "handoff-show-all", label: m(msg("Show all…")) });
  return items;
}

export function buildLastCodeThreadMenu(input: ThreadMenuInput): ContextMenuItem<string>[] {
  const items = [
    ...metadataItems(input),
    ...processItems(input),
    { id: "copy-path", label: m(msg("Copy Path")) },
    { id: "copy-thread-id", label: m(msg("Copy Thread ID")) },
    {
      id: "project-settings",
      label: m(msg("Project settings")),
      disabled: input.projectSettingsKey === null,
    },
    ...handoffItems(input.handoffs),
  ];
  if (input.thread.archivePending?.status === "failed") {
    items.push({ id: "dismiss-archive-failure", label: m(msg("Dismiss archive failure")) });
  }
  const menu: ContextMenuItem<string>[] = [
    ...items,
    {
      id: "delete",
      separatorBefore: true,
      label: m(msg("Delete", { $context: "verb, deletes a thread" })),
      destructive: true,
      icon: "trash",
    },
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
