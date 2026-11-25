import type { ContextMenuItem } from "@t3tools/contracts";
import type { SnoozePreset } from "@t3tools/client-runtime/state/thread-settled";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../i18n/messages";
import type { HandoffMenuDescriptor } from "../handoffs/handoffMenu";
import type { WorktreeSuspensionActionId } from "./worktreeSuspensionMenu";

export type ThreadActionMenuId =
  | "find"
  | WorktreeSuspensionActionId
  | "new-thread-on-branch"
  | "filter-by-project"
  | "turn-into-project"
  | "project-settings"
  | "pin"
  | "unpin"
  | "mark-persistent"
  | "disable-persistence"
  | "settle"
  | "unsettle"
  | "auto-settle"
  | "auto-settle:enabled"
  | "auto-settle:disabled"
  | "snooze"
  | `snooze:${string}`
  | "unsnooze"
  | "rename"
  | "regenerate-title"
  | "cancel-action"
  | "stop-thread-processes"
  | "mark-unread"
  | "share-guest"
  | "mark-read"
  | "copy"
  | "copy-path"
  | "copy-branch"
  | "copy-thread"
  | "copy-thread-id"
  | `handoff:${string}`
  | "handoff-show-all"
  | "handoffs-heading"
  | "handoffs-empty"
  | "archive"
  | "archive-discard"
  | "dismiss-archive-failure"
  | "linked-archive-status"
  | "delete";

export type DraftActionMenuId =
  | "copy"
  | "copy-path"
  | "copy-branch"
  | "project-settings"
  | "discard";

export function buildDraftActionMenuItems(
  options: {
    readonly hasPath: boolean;
    readonly hasBranch: boolean;
    readonly hasProject: boolean;
  },
  resolve: MessageResolver = m,
): ReadonlyArray<ContextMenuItem<DraftActionMenuId>> {
  return [
    {
      id: "copy",
      label: resolve(msg("Copy", { $context: "submenu of things to copy" })),
      icon: "copy",
      disabled: !options.hasPath && !options.hasBranch,
      children: [
        ...(options.hasPath
          ? [
              {
                id: "copy-path" as const,
                label: resolve(msg("Path", { $context: "copy the file path" })),
                icon: "folder",
              },
            ]
          : []),
        ...(options.hasBranch
          ? [
              {
                id: "copy-branch" as const,
                label: resolve(msg("Branch", { $context: "copy the git branch name" })),
                icon: "git-branch",
              },
            ]
          : []),
      ],
    },
    ...(options.hasProject
      ? [
          {
            id: "project-settings" as const,
            label: resolve(msg("Project settings")),
            icon: "settings",
          },
        ]
      : []),
    {
      id: "discard",
      label: resolve(msg("Discard draft")),
      icon: "trash",
      destructive: true,
      separatorBefore: true,
    },
  ];
}

export interface ThreadActionMenuState {
  readonly canOperate: boolean;
  /** Settle, snooze and their undo stay available until the host denies the operate scope. */
  readonly canTriage?: boolean;
  readonly canFind?: boolean;
  /** False where no inline title editor is rendered, such as sidebar search results. */
  readonly canRename?: boolean;
  readonly branch: string | null;
  readonly projectFilter: {
    readonly label: string;
    readonly isActive: boolean;
  } | null;
  readonly isPinned: boolean;
  readonly isPersistent: boolean;
  readonly archiveFailed?: boolean;
  readonly isSettled: boolean;
  readonly autoSettleEnabled: boolean;
  readonly isSnoozed: boolean;
  readonly canSnoozeNow: boolean;
  readonly isRegeneratingTitle: boolean;
  readonly isRunning: boolean;
  /** The server marks unread against the latest run's completion, so in-flight runs cannot be. */
  readonly hasCompletedRun: boolean;
  /** Waiting and queued runtimes without an active run can still have a completed reply. */
  readonly blocksMarkUnread?: boolean;
  readonly hasRunningAction: boolean;
  readonly hasStoppableProcesses: boolean;
  readonly supports: {
    readonly settlement: boolean;
    readonly autoSettleOptOut: boolean;
    readonly snooze: boolean;
    readonly pinning: boolean;
    readonly persistence: boolean;
    readonly titleRegeneration: boolean;
  };
  readonly snoozePresets: ReadonlyArray<SnoozePreset>;
  /** Guest links need their own grant, so the caller checks it instead of `canOperate`. */
  readonly canShareWithGuest?: boolean;
  /** A No project thread with its own folder, on a server that can promote it. */
  readonly canTurnIntoProject?: boolean;
  readonly handoffs?: ReadonlyArray<HandoffMenuDescriptor>;
  readonly handoffsOverflow?: boolean;
}

export function buildStopThreadProcessesMenuItem(
  hasStoppableProcesses: boolean,
  resolve: MessageResolver = m,
) {
  return hasStoppableProcesses
    ? {
        id: "stop-thread-processes" as const,
        label: resolve(msg("Stop all previews & processes")),
        destructive: true,
      }
    : null;
}

/** The native bridge expresses each group divider on the following command. */
export function withThreadActionMenuDividers<A extends string>(
  items: ReadonlyArray<ContextMenuItem<A>>,
): ReadonlyArray<ContextMenuItem<A>> {
  return items.map((item, index) => {
    const previousId = items[index - 1]?.id;
    const startsGroup =
      previousId === "new-thread-on-branch" ||
      (previousId === "annotate" && item.id !== "resolve-annotation") ||
      previousId === "resolve-annotation" ||
      previousId === "stop-thread-processes" ||
      ((previousId === "mark-persistent" || previousId === "disable-persistence") &&
        item.id !== "stop-thread-processes");
    return startsGroup ? { ...item, separatorBefore: true } : item;
  });
}

/** Local actions need no operate grant; synced read markers are gated by their destination. */
export function threadActionRequiresOperate(action: ThreadActionMenuId): boolean {
  if (action.startsWith("handoff:")) return false;
  return ![
    "find",
    "new-thread-on-branch",
    "project-settings",
    "filter-by-project",
    "handoff-show-all",
    "handoffs-heading",
    "handoffs-empty",
    "linked-archive-status",
    "mark-unread",
    "share-guest",
    "mark-read",
    "copy",
    "copy-path",
    "copy-branch",
    "copy-thread",
    "copy-thread-id",
  ].includes(action);
}

export function isThreadTriageAction(action: string): boolean {
  return (
    action === "settle" ||
    action === "unsettle" ||
    action === "snooze" ||
    action === "unsnooze" ||
    action.startsWith("snooze:")
  );
}

export function buildThreadActionMenuItems(
  state: ThreadActionMenuState,
  resolve: MessageResolver = m,
): ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> {
  const stopProcesses = buildStopThreadProcessesMenuItem(state.hasStoppableProcesses, resolve);
  const items: ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> = [
    ...(state.canFind
      ? [{ id: "find" as const, label: resolve(msg("Find in thread")), icon: "text-search" }]
      : []),
    ...(state.branch
      ? [
          {
            id: "new-thread-on-branch" as const,
            label: resolve(msg("New thread on {branch}", { branch: state.branch })),
            icon: "message-square-plus",
          },
        ]
      : []),
    ...(state.supports.pinning
      ? [
          state.isPinned
            ? { id: "unpin" as const, label: resolve(msg("Unpin thread")), icon: "pin-off" }
            : { id: "pin" as const, label: resolve(msg("Pin thread")), icon: "pin" },
        ]
      : []),
    ...(state.supports.persistence
      ? [
          state.isPersistent
            ? {
                id: "disable-persistence" as const,
                label: resolve(msg("Disable persistent thread")),
                icon: "message-square-lock",
              }
            : {
                id: "mark-persistent" as const,
                label: resolve(msg("Mark as persistent thread")),
                icon: "message-square-lock",
              },
        ]
      : []),
    ...(stopProcesses ? [stopProcesses] : []),
    // Both lifecycle actions stay available on pinned threads: settling
    // clears the pin ("done" beats "keep on top"), and snoozing hides the
    // card until wake with the pin intact.
    ...(state.supports.settlement
      ? [
          state.isSettled
            ? {
                id: "unsettle" as const,
                label: resolve(msg("Un-settle thread")),
                icon: "circle-check",
              }
            : { id: "settle" as const, label: resolve(msg("Settle thread")), icon: "circle-check" },
        ]
      : []),
    ...(state.supports.snooze
      ? [
          state.isSnoozed
            ? { id: "unsnooze" as const, label: resolve(msg("Wake thread")), icon: "clock" }
            : {
                id: "snooze" as const,
                label: resolve(msg("Snooze", { $context: "verb, snooze the thread" })),
                icon: "clock",
                disabled: !state.canSnoozeNow,
                children: [
                  ...state.snoozePresets.map((preset) => ({
                    id: `snooze:${preset.id}` as const,
                    label: preset.label,
                    detail: preset.whenLabel,
                  })),
                  {
                    id: "snooze:custom" as const,
                    label: resolve(msg("Custom…")),
                    separatorBefore: state.snoozePresets.length > 0,
                  },
                ],
              },
        ]
      : []),
    {
      id: "rename",
      label: resolve(msg("Rename thread")),
      icon: "pencil",
      disabled: state.canRename === false,
      separatorBefore: true,
    },
    ...(state.supports.titleRegeneration
      ? [
          {
            id: "regenerate-title" as const,
            label: state.isRegeneratingTitle
              ? resolve(msg("Regenerating…"))
              : resolve(msg("Regenerate title")),
            icon: "refresh-cw",
            disabled: state.isRegeneratingTitle,
          },
        ]
      : []),
    ...(state.hasRunningAction
      ? [
          {
            id: "cancel-action" as const,
            label: resolve(msg("Cancel running Action")),
            destructive: true,
          },
        ]
      : []),
    ...(state.hasCompletedRun && !(state.blocksMarkUnread ?? state.isRunning)
      ? [{ id: "mark-unread" as const, label: resolve(msg("Mark unread")), icon: "mail-open" }]
      : []),
    ...(state.canShareWithGuest
      ? [{ id: "share-guest" as const, label: resolve(msg("Share with guest")), icon: "user-plus" }]
      : []),
    { id: "mark-read", label: resolve(msg("Mark read")), icon: "check" },
    ...(state.projectFilter
      ? [
          {
            id: "filter-by-project" as const,
            label: state.projectFilter.isActive
              ? resolve(msg("Show all projects"))
              : resolve(msg("Filter by {project}", { project: state.projectFilter.label })),
            icon: "folder-tree",
          },
        ]
      : []),
    ...(state.canTurnIntoProject
      ? [
          {
            id: "turn-into-project" as const,
            label: resolve(msg("Turn into project")),
            icon: "folder-plus",
            disabled: state.isRunning,
          },
        ]
      : []),
    ...(state.supports.autoSettleOptOut
      ? [
          {
            id: "auto-settle" as const,
            label: resolve(msg("Auto-settle behavior")),
            icon: "timer",
            children: [
              {
                id: "auto-settle:enabled" as const,
                label: resolve(msg("Follow settings")),
                checked: state.autoSettleEnabled,
              },
              {
                id: "auto-settle:disabled" as const,
                label: resolve(msg("Never", { $context: "auto-settle never" })),
                checked: !state.autoSettleEnabled,
              },
            ],
          },
        ]
      : []),
    {
      id: "copy",
      label: resolve(msg("Copy", { $context: "submenu of things to copy" })),
      icon: "copy",
      separatorBefore: true,
      children: [
        {
          id: "copy-path",
          label: resolve(msg("Path", { $context: "copy the file path" })),
          icon: "folder",
        },
        ...(state.branch
          ? [
              {
                id: "copy-branch" as const,
                label: resolve(msg("Branch", { $context: "copy the git branch name" })),
                icon: "git-branch",
              },
            ]
          : []),
        {
          id: "copy-thread",
          label: resolve(msg("Thread", { $context: "copy the thread contents" })),
          icon: "message-square",
        },
        { id: "copy-thread-id", label: resolve(msg("Thread ID")), icon: "hash" },
      ],
    },
    { id: "project-settings", label: resolve(msg("Project settings")), icon: "settings" },
    {
      id: "handoffs-heading",
      label: resolve(msg("Handoffs")),
      disabled: true,
      separatorBefore: true,
    },
    ...(state.handoffs?.length
      ? state.handoffs.map(({ entry, label }) => ({
          id: `handoff:${entry.id}` as const,
          label,
          icon: "external-link",
        }))
      : [
          { id: "handoffs-empty" as const, label: resolve(msg("No handoffs yet")), disabled: true },
        ]),
    ...(state.handoffsOverflow
      ? [{ id: "handoff-show-all" as const, label: resolve(msg("Show all…")), icon: "list" }]
      : []),
    // Archive hides the thread but keeps its history in Settings; it is less destructive than Delete.
    // Eligibility is checked after the handler reads the owned family.
    {
      id: "archive",
      label: state.isPersistent
        ? resolve(msg("Archive thread (disable persistence first)"))
        : resolve(msg("Archive thread")),
      icon: "archive",
      disabled: state.isPersistent,
      separatorBefore: true,
    },
    ...(state.archiveFailed
      ? [{ id: "dismiss-archive-failure" as const, label: resolve(msg("Dismiss archive failure")) }]
      : []),
    {
      id: "delete",
      label: state.isPersistent
        ? resolve(msg("Delete (disable persistence first)"))
        : resolve(msg("Delete", { $context: "verb, delete the thread" })),
      destructive: true,
      icon: "trash",
      disabled: state.isPersistent,
    },
  ];
  return withThreadActionMenuDividers(
    state.canOperate
      ? items
      : items.map((item) =>
          threadActionRequiresOperate(item.id) &&
          !(state.canTriage === true && isThreadTriageAction(item.id))
            ? {
                ...item,
                disabled: true,
                ...(item.children
                  ? { children: item.children.map((child) => ({ ...child, disabled: true })) }
                  : {}),
              }
            : item,
        ),
  );
}
