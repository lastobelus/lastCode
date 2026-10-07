import type { ContextMenuItem } from "@t3tools/contracts";
import type { SnoozePreset } from "@t3tools/client-runtime/state/thread-settled";
import type { HandoffMenuDescriptor } from "../handoffs/handoffMenu";

/**
 * Ids for the per-thread action menu. Snooze presets are dispatched as
 * `snooze:<presetId>` so the union stays closed while the preset list
 * remains data-driven.
 */
export type ThreadActionMenuId =
  | "new-thread-on-branch"
  | "filter-by-project"
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
  | "copy"
  | "copy-path"
  | "copy-branch"
  | "copy-thread-id"
  | `handoff:${string}`
  | "handoff-show-all"
  | "handoffs-heading"
  | "handoffs-empty"
  | "archive"
  | "delete";

export type DraftActionMenuId =
  | "copy"
  | "copy-path"
  | "copy-branch"
  | "project-settings"
  | "discard";

/** Right-click menu for an unsent draft row in the sidebar. */
export function buildDraftActionMenuItems(options: {
  readonly hasPath: boolean;
  readonly hasBranch: boolean;
  readonly hasProject: boolean;
}): ReadonlyArray<ContextMenuItem<DraftActionMenuId>> {
  return [
    {
      id: "copy",
      label: "Copy",
      icon: "copy",
      disabled: !options.hasPath && !options.hasBranch,
      children: [
        ...(options.hasPath ? [{ id: "copy-path" as const, label: "Path", icon: "folder" }] : []),
        ...(options.hasBranch
          ? [{ id: "copy-branch" as const, label: "Branch", icon: "git-branch" }]
          : []),
      ],
    },
    ...(options.hasProject
      ? [{ id: "project-settings" as const, label: "Project settings", icon: "settings" }]
      : []),
    {
      id: "discard",
      label: "Discard draft",
      icon: "trash",
      destructive: true,
      separatorBefore: true,
    },
  ];
}

export interface ThreadActionMenuState {
  readonly canOperate: boolean;
  readonly branch: string | null;
  /**
   * Project scoping for the thread list. Null on surfaces with no scoped
   * list behind the menu (the chat header), where the item must not show.
   */
  readonly projectFilter: {
    readonly label: string;
    /** True when the list is already scoped to this thread's project. */
    readonly isActive: boolean;
  } | null;
  readonly isPinned: boolean;
  readonly isPersistent: boolean;
  readonly isSettled: boolean;
  /** False while the user has turned automatic settlement off for this thread. */
  readonly autoSettleEnabled: boolean;
  readonly isSnoozed: boolean;
  readonly canSnoozeNow: boolean;
  readonly isRegeneratingTitle: boolean;
  readonly hasRunningAction: boolean;
  readonly hasStoppableProcesses: boolean;
  readonly supports: {
    readonly settlement: boolean;
    /** Server understands thread.auto-settle.set. */
    readonly autoSettleOptOut: boolean;
    readonly snooze: boolean;
    readonly pinning: boolean;
    readonly persistence: boolean;
    readonly titleRegeneration: boolean;
  };
  readonly snoozePresets: ReadonlyArray<SnoozePreset>;
  readonly handoffs?: ReadonlyArray<HandoffMenuDescriptor>;
  readonly handoffsOverflow?: boolean;
}

export function buildStopThreadProcessesMenuItem(hasStoppableProcesses: boolean) {
  return hasStoppableProcesses
    ? {
        id: "stop-thread-processes" as const,
        label: "Stop all previews & processes",
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
      previousId === "annotate" ||
      previousId === "stop-thread-processes" ||
      ((previousId === "mark-persistent" || previousId === "disable-persistence") &&
        item.id !== "stop-thread-processes");
    return startsGroup ? { ...item, separatorBefore: true } : item;
  });
}

/** Local navigation, read markers, and copying remain available to read-only clients. */
export function threadActionRequiresOperate(action: ThreadActionMenuId): boolean {
  if (action.startsWith("handoff:")) return false;
  return ![
    "new-thread-on-branch",
    "project-settings",
    "filter-by-project",
    "handoff-show-all",
    "handoffs-heading",
    "handoffs-empty",
    "mark-unread",
    "copy",
    "copy-path",
    "copy-branch",
    "copy-thread-id",
  ].includes(action);
}

/**
 * Single source for the per-thread action menu: the sidebar row's right-click
 * menu and the chat header menu share labels, ordering, and capability gating.
 * Each surface supplies state for the actions it supports.
 */
export function buildThreadActionMenuItems(
  state: ThreadActionMenuState,
): ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> {
  const stopProcesses = buildStopThreadProcessesMenuItem(state.hasStoppableProcesses);
  const items: ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> = [
    ...(state.branch
      ? [
          {
            id: "new-thread-on-branch" as const,
            label: `New thread on ${state.branch}`,
            icon: "message-square-plus",
          },
        ]
      : []),
    ...(state.supports.pinning
      ? [
          state.isPinned
            ? { id: "unpin" as const, label: "Unpin thread", icon: "pin-off" }
            : { id: "pin" as const, label: "Pin thread", icon: "pin" },
        ]
      : []),
    ...(state.supports.persistence
      ? [
          state.isPersistent
            ? {
                id: "disable-persistence" as const,
                label: "Disable persistent thread",
                icon: "message-square-lock",
              }
            : {
                id: "mark-persistent" as const,
                label: "Mark as persistent thread",
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
            ? { id: "unsettle" as const, label: "Un-settle thread", icon: "circle-check" }
            : { id: "settle" as const, label: "Settle thread", icon: "circle-check" },
        ]
      : []),
    ...(state.supports.snooze
      ? [
          state.isSnoozed
            ? { id: "unsnooze" as const, label: "Wake thread", icon: "clock" }
            : {
                id: "snooze" as const,
                label: "Snooze",
                icon: "clock",
                disabled: !state.canSnoozeNow,
                children: [
                  ...state.snoozePresets.map((preset) => ({
                    id: `snooze:${preset.id}` as const,
                    label: `${preset.label} (${preset.whenLabel})`,
                  })),
                  { id: "snooze:custom" as const, label: "Custom…", separatorBefore: true },
                ],
              },
        ]
      : []),
    { id: "rename", label: "Rename thread", icon: "pencil", separatorBefore: true },
    ...(state.supports.titleRegeneration
      ? [
          {
            id: "regenerate-title" as const,
            label: state.isRegeneratingTitle ? "Regenerating…" : "Regenerate title",
            icon: "refresh-cw",
            disabled: state.isRegeneratingTitle,
          },
        ]
      : []),
    ...(state.hasRunningAction
      ? [{ id: "cancel-action" as const, label: "Cancel running Action", destructive: true }]
      : []),
    { id: "mark-unread", label: "Mark unread", icon: "mail-open" },
    ...(state.projectFilter
      ? [
          {
            id: "filter-by-project" as const,
            label: state.projectFilter.isActive
              ? "Show all projects"
              : `Filter by ${state.projectFilter.label}`,
            icon: "folder-tree",
          },
        ]
      : []),
    // A submenu with the current option checked, not a one-shot action:
    // this is a setting, and it sits with the other per-thread settings
    // rather than the lifecycle verbs above. Disabled keeps long-running
    // threads out of the settled shelf no matter how quiet they get.
    ...(state.supports.autoSettleOptOut
      ? [
          {
            id: "auto-settle" as const,
            label: "Auto-settle behavior",
            icon: "timer",
            children: [
              {
                id: "auto-settle:enabled" as const,
                label: "Enabled",
                checked: state.autoSettleEnabled,
              },
              {
                id: "auto-settle:disabled" as const,
                label: "Disabled",
                checked: !state.autoSettleEnabled,
              },
            ],
          },
        ]
      : []),
    {
      id: "copy",
      label: "Copy",
      icon: "copy",
      separatorBefore: true,
      children: [
        { id: "copy-path", label: "Path", icon: "folder" },
        ...(state.branch
          ? [{ id: "copy-branch" as const, label: "Branch", icon: "git-branch" }]
          : []),
        { id: "copy-thread-id", label: "Thread ID", icon: "hash" },
      ],
    },
    { id: "project-settings", label: "Project settings", icon: "settings" },
    { id: "handoffs-heading", label: "Handoffs", disabled: true, separatorBefore: true },
    ...(state.handoffs?.length
      ? state.handoffs.map(({ entry, label }) => ({
          id: `handoff:${entry.id}` as const,
          label,
          icon: "external-link",
        }))
      : [{ id: "handoffs-empty" as const, label: "No handoffs yet", disabled: true }]),
    ...(state.handoffsOverflow
      ? [{ id: "handoff-show-all" as const, label: "Show all…", icon: "list" }]
      : []),
    // Archive removes the thread from the sidebar while keeping its
    // conversation under Settings > Archived threads — distinct from Settle
    // (stays visible in the Settled shelf) and Delete (clears history for
    // good), so it sits beside Delete without borrowing its destructive
    // styling. Eligibility is checked after the handler reads the owned family.
    {
      id: "archive",
      label: state.isPersistent ? "Archive thread (disable persistence first)" : "Archive thread",
      icon: "archive",
      disabled: state.isPersistent,
      separatorBefore: true,
    },
    {
      id: "delete",
      label: state.isPersistent ? "Delete (disable persistence first)" : "Delete",
      destructive: true,
      icon: "trash",
      disabled: state.isPersistent,
    },
  ];
  return withThreadActionMenuDividers(
    state.canOperate
      ? items
      : items.map((item) =>
          threadActionRequiresOperate(item.id)
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
