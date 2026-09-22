import {
  THREAD_LIST_V2_MONO_FONT as MONO_FONT,
  THREAD_LIST_V2_ROW_CONTENT_CLASS_NAME,
  THREAD_LIST_V2_ROW_DIVIDERS,
  selectedThreadRowColors,
  getThreadListV2NewBranchMenuTitle,
  getThreadListV2RowAppearance,
} from "./thread-list-v2-row-appearance";
import { RowPressable } from "../../components/RowPressable";
import { CustomSnoozeSheet } from "./CustomSnoozeSheet";
import { appAtomRegistry } from "../../state/atom-registry";
import { threadArrangementOpenAtom } from "../../state/thread-order";
import type { ThreadMoveDestination } from "./threadOrder";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { EnvironmentThreadSearchMatch } from "@t3tools/client-runtime/state/thread-search";
import type { EnvironmentMachineKind } from "@t3tools/contracts";
import { canSnooze, resolveSnoozePresets } from "@t3tools/client-runtime/state/thread-settled";
import type { MenuAction } from "@react-native-menu/menu";
import { actionRunningPresentation } from "@t3tools/shared/actionResume";
import * as Cause from "effect/Cause";
import { memo, useCallback, useEffect, useMemo, useState, type ComponentProps } from "react";
import { Alert, Pressable, useWindowDimensions, View } from "react-native";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { ProviderInstanceIcon } from "../../components/ProviderIcon";
import type { ThreadRowProviderInstance } from "./thread-provider-instance";
import { cn } from "../../lib/cn";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import { terminalEnvironment } from "../../state/terminal";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useThreadPr } from "../../state/use-thread-pr";
import { ThreadSwipeable } from "../home/thread-swipe-actions";
import { buildThreadTitleRegenerationMenuItems } from "./thread-title-regeneration-menu";
import {
  THREAD_LIST_V2_SETTLED_PAGE_COUNT,
  resolveThreadListV2SnoozeMenuSelection,
  resolveThreadListV2CleanupActions,
  resolveThreadListV2SnoozeGateExpiryMs,
  resolveThreadListV2Status,
  resolveThreadListV2SwipeActions,
  type ThreadListV2Status,
} from "./threadListV2";
import { QueuedMessageIcon } from "./queued-message-icon";
import { PersistentThreadIcon } from "./PersistentThreadIcon";
import {
  buildThreadPersistenceMenuItems,
  persistenceIntentForMenuEvent,
} from "./thread-persistence-menu";
import { resolveWorktreeCleanupStatus, shouldShowActionWaitingIndicator } from "./thread-status";
import { ThreadSearchMatchExcerpt } from "./thread-search-match";

/**
 * Thread List v2 renders one flat native list: rich edge-to-edge rows for
 * active work and a receded settled tail, all with native swipe and
 * long-press actions. State reads through colored status labels and text
 * hierarchy rather than card fills.
 */

// Status hues follow the system-wide convention set by sidebar v1 and the
// Live Activity/widgets (amber approval, indigo input, sky working) so a
// thread reads the same color everywhere it surfaces.
const STATUS_LABEL_BY_STATUS: Partial<
  Record<ThreadListV2Status, { label: string; className: string }>
> = {
  approval: { label: "Approval", className: "text-warning-foreground" },
  input: { label: "Input", className: "text-adaptive-indigo-600-300" },
  question: { label: "? Question", className: "text-adaptive-violet-700-300" },
  working: { label: "Working", className: "text-adaptive-sky-600-400" },
  waiting: { label: "Waiting", className: "text-adaptive-amber-700-300" },
  failed: { label: "Failed", className: "text-adaptive-red-700-300" },
};

// Menus keep lifecycle and title regeneration together. Archive keeps its
// own surface (thread screen / settings) rather than crowding v2 rows.
const CARD_MENU_ACTIONS: MenuAction[] = [
  { id: "settle", title: "Settle", image: "checkmark" },
  { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
];

const SLIM_MENU_ACTIONS: MenuAction[] = [
  { id: "unsettle", title: "Un-settle", image: "arrow.uturn.backward" },
  { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
];

const SNOOZED_MENU_ACTIONS: MenuAction[] = [
  { id: "unsnooze", title: "Wake thread", image: "clock" },
  { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
];

// Pre-settlement servers: no lifecycle items, archive fills the gap.
const LEGACY_MENU_ACTIONS: MenuAction[] = [
  { id: "archive", title: "Archive", image: "archivebox" },
  { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
];

const FAILED_CLEANUP_MENU_ACTIONS: MenuAction[] = [
  { id: "retry-worktree-cleanup", title: "Retry", image: "arrow.clockwise" },
  { id: "keep-worktree", title: "Keep worktree", image: "externaldrive" },
];

/** Rounded-row radius shared with the v1 sidebar rows. */
const SIDEBAR_V2_ROW_RADIUS = 12;

function ThreadListV2Section(props: {
  readonly label: string;
  readonly pane?: "screen" | "sidebar";
  readonly tone?: "default" | "snoozed";
  readonly disclosure?: {
    readonly expanded: boolean;
    readonly disabled?: boolean;
    readonly onToggle: () => void;
    readonly accessibilityLabel: string;
    readonly accessibilityHint: string;
  };
}) {
  const snoozed = props.tone === "snoozed";
  const sidebarPane = props.pane === "sidebar";
  const className = cn(
    "mb-1.5 mt-4 flex-row items-center gap-2.5",
    props.pane === "sidebar" ? "px-3" : "px-5",
  );
  const content = (
    <>
      <Text
        className={cn(
          "text-xs font-t3-medium",
          sidebarPane
            ? "text-drawer-foreground-muted"
            : snoozed
              ? "text-foreground-secondary"
              : "text-foreground-tertiary",
        )}
      >
        {props.label}
      </Text>
      <View
        className={cn(
          "h-px flex-1",
          snoozed ? "bg-primary/20" : sidebarPane ? "bg-drawer-border" : "bg-border",
        )}
      />
      {props.disclosure ? (
        <SymbolView
          name="chevron.down"
          size={10}
          tintColorClassName={
            sidebarPane
              ? "accent-drawer-foreground-muted"
              : snoozed
                ? "accent-icon-muted"
                : "accent-foreground-muted"
          }
          type="monochrome"
          style={{ transform: [{ rotate: props.disclosure.expanded ? "180deg" : "0deg" }] }}
        />
      ) : null}
    </>
  );

  return props.disclosure ? (
    <Pressable
      accessibilityHint={props.disclosure.accessibilityHint}
      accessibilityLabel={props.disclosure.accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{
        disabled: props.disclosure.disabled,
        expanded: props.disclosure.expanded,
      }}
      className={className}
      disabled={props.disclosure.disabled}
      onPress={props.disclosure.onToggle}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      {content}
    </Pressable>
  ) : (
    <View className={className}>{content}</View>
  );
}

/** Section label + rule: the only structure in an otherwise flat list. */
export const ThreadListV2SectionDivider = memo(function ThreadListV2SectionDivider(props: {
  readonly label: string;
  readonly pane?: "screen" | "sidebar";
}) {
  return <ThreadListV2Section {...props} />;
});

type ThreadListV2ShelfHeaderProps = {
  readonly count: number;
  readonly disabled?: boolean;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly pane?: "screen" | "sidebar";
};

function ThreadListV2ShelfHeader(
  props: ThreadListV2ShelfHeaderProps & { readonly kind: "snoozed" | "settled" },
) {
  const label = props.kind === "snoozed" ? "Snoozed" : "Settled";
  return (
    <ThreadListV2Section
      label={props.expanded ? label : `${label} (${props.count})`}
      pane={props.pane}
      tone={props.kind === "snoozed" ? "snoozed" : "default"}
      disclosure={{
        expanded: props.expanded,
        disabled: props.disabled,
        onToggle: props.onToggle,
        accessibilityLabel: `${props.count} ${props.kind} ${props.count === 1 ? "thread" : "threads"}`,
        accessibilityHint: `${props.expanded ? "Collapses" : "Expands"} the ${props.kind} threads.`,
      }}
    />
  );
}

export const ThreadListV2SnoozedShelfHeader = memo(function ThreadListV2SnoozedShelfHeader(
  props: ThreadListV2ShelfHeaderProps,
) {
  return <ThreadListV2ShelfHeader {...props} kind="snoozed" />;
});

export const ThreadListV2SettledShelfHeader = memo(function ThreadListV2SettledShelfHeader(
  props: ThreadListV2ShelfHeaderProps,
) {
  return <ThreadListV2ShelfHeader {...props} kind="settled" />;
});

export const ThreadListV2ShowMoreRow = memo(function ThreadListV2ShowMoreRow(props: {
  readonly pane?: "screen" | "sidebar";
  readonly hiddenCount: number;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Show ${Math.min(props.hiddenCount, THREAD_LIST_V2_SETTLED_PAGE_COUNT)} more settled threads`}
      onPress={props.onPress}
      className="mx-4 mt-2 items-center rounded-lg border border-dashed border-border py-2.5"
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <Text
        className={
          props.pane === "sidebar"
            ? "text-xs font-t3-medium text-drawer-foreground-muted"
            : "text-xs font-t3-medium text-foreground-muted"
        }
      >
        Show more ({props.hiddenCount} settled hidden)
      </Text>
    </Pressable>
  );
});

const PENDING_TASK_MENU_ACTIONS: MenuAction[] = [
  { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
];

const DRAFT_TASK_MENU_ACTIONS: MenuAction[] = [
  { id: "delete", title: "Discard", image: "trash", attributes: { destructive: true } },
];

/**
 * Unsent work, in the same idiom as an active v2 row: it is work the user
 * wrote, so it reads like the thread it will become. The status slot says
 * what happens next, not where the item sits: "Sends on reconnect" stays
 * uncolored because nothing is asked of the user; "Draft" takes the amber the
 * web sidebar uses for drafts, because this one waits on the user.
 */
export const ThreadListV2PendingRow = memo(function ThreadListV2PendingRow(props: {
  readonly pendingTask: PendingNewTask;
  readonly project: EnvironmentProject | null;
  readonly projectTitle?: string;
  readonly environmentLabel: string | null;
  /** Drawn beside the label; ignored while the label is null. */
  readonly environmentMachine?: EnvironmentMachineKind;
  readonly pane?: "screen" | "sidebar";
  /** Draws the "Unsent" divider above the first draft or queued row. */
  readonly showPendingDivider: boolean;
  /** Keeps row hairlines inside a section; section headers draw their own rule. */
  readonly showTrailingDivider?: boolean;
  readonly onSelectPendingTask: (pendingTask: PendingNewTask) => void;
  readonly onDeletePendingTask: (pendingTask: PendingNewTask) => void;
}) {
  const { pendingTask, onSelectPendingTask, onDeletePendingTask } = props;
  const sidebarPane = props.pane === "sidebar";
  const isDraft = pendingTask.kind === "draft";
  const projectTitle = props.projectTitle ?? props.project?.title ?? pendingTask.projectTitle ?? "";
  const branch = pendingTask.branch;

  const handleMenuAction = useCallback(
    ({ nativeEvent }: { readonly nativeEvent: { readonly event: string } }) => {
      if (nativeEvent.event === "delete") onDeletePendingTask(pendingTask);
    },
    [onDeletePendingTask, pendingTask],
  );

  const rowContent = (
    <>
      <View className="flex-row items-center gap-1.5">
        {props.project ? (
          <ProjectFavicon
            environmentId={pendingTask.environmentId}
            faviconPath={props.project.faviconPath}
            size={15}
            projectTitle={projectTitle}
            workspaceRoot={props.project.workspaceRoot}
          />
        ) : null}
        <Text
          className={cn(
            "flex-1 text-sm font-t3-medium text-foreground-muted",
            sidebarPane && "text-drawer-foreground-muted",
          )}
          numberOfLines={1}
        >
          {projectTitle}
        </Text>
        {isDraft ? (
          <View className="flex-row items-center gap-1">
            <SymbolView
              name="square.and.pencil"
              size={10}
              tintColorClassName="accent-adaptive-amber-700-300"
              type="monochrome"
            />
            <Text className="text-xs text-adaptive-amber-700-300">Draft</Text>
          </View>
        ) : (
          <Text
            className={cn(
              "text-xs text-foreground-tertiary",
              sidebarPane && "text-drawer-foreground-muted",
            )}
          >
            Sends on reconnect
          </Text>
        )}
      </View>
      {/* One line, unlike the two an active row allows: a queued title is
          derived from the whole prompt rather than written as a title, so the
          second line is usually a stray word or emoji rather than meaning. */}
      <Text
        className={cn(
          "mt-1 text-base font-t3-medium text-foreground",
          sidebarPane && "text-drawer-foreground",
        )}
        numberOfLines={1}
      >
        {pendingTask.title}
      </Text>
      {branch || props.environmentLabel ? (
        <View className="mt-1 flex-row items-center gap-1">
          <Text
            className={cn(
              "shrink text-xs text-foreground-muted",
              sidebarPane && "text-drawer-foreground-muted",
            )}
            numberOfLines={1}
          >
            {branch ? (
              <Text
                className={cn(
                  "text-xs text-foreground-muted",
                  sidebarPane && "text-drawer-foreground-muted",
                )}
                style={{ fontFamily: MONO_FONT }}
              >
                {branch}
              </Text>
            ) : null}
            {branch && props.environmentLabel ? "  ·  " : null}
            {props.environmentLabel ? (
              <Text
                className={cn(
                  "text-xs text-foreground-tertiary",
                  sidebarPane && "text-drawer-foreground-muted",
                )}
              >
                {props.environmentLabel}
              </Text>
            ) : null}
          </Text>
          {props.environmentLabel && props.environmentMachine ? (
            <EnvironmentMachineSymbol
              kind={props.environmentMachine}
              size={11}
              tintColorClassName={
                sidebarPane ? "accent-drawer-foreground-muted" : "accent-foreground-tertiary"
              }
            />
          ) : null}
        </View>
      ) : null}
    </>
  );

  return (
    <>
      {props.showPendingDivider ? (
        <ThreadListV2SectionDivider label="Unsent" pane={props.pane} />
      ) : null}
      <ControlPillMenu
        actions={isDraft ? DRAFT_TASK_MENU_ACTIONS : PENDING_TASK_MENU_ACTIONS}
        onPressAction={handleMenuAction}
        shouldOpenOnLongPress
      >
        <RowPressable
          accessibilityHint={
            isDraft
              ? "Opens the draft in the new task composer"
              : "Sends when the environment reconnects. Opens the task for editing"
          }
          accessibilityLabel={pendingTask.title}
          accessibilityRole="button"
          key={pendingTask.key}
          className={sidebarPane ? "bg-drawer" : "bg-screen"}
          interactionClassName={sidebarPane ? "bg-thread-hover" : "bg-row-hover"}
          onPress={() => onSelectPendingTask(pendingTask)}
          style={
            sidebarPane
              ? {
                  borderRadius: SIDEBAR_V2_ROW_RADIUS,
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                }
              : undefined
          }
        >
          {sidebarPane ? (
            rowContent
          ) : (
            <View>
              <View className="px-5 py-2.5">{rowContent}</View>
              {props.showTrailingDivider !== false ? (
                <View className="ml-5 h-px bg-border-subtle" />
              ) : null}
            </View>
          )}
        </RowPressable>
      </ControlPillMenu>
    </>
  );
});

export const ThreadListV2Row = memo(function ThreadListV2Row(props: {
  readonly thread: EnvironmentThreadShell;
  readonly variant: "card" | "slim";
  /** A message for this thread is waiting in the outbox. */
  readonly hasQueuedMessages?: boolean;
  /** Snoozed-shelf row: shows its wake time and offers Wake. */
  readonly snoozed?: boolean;
  /** Pinned-block row: shows the pin glyph and offers Unpin. */
  readonly pinned?: boolean;
  /** Preformatted against the parent minute tick so this memoized row's
      countdown keeps moving. */
  readonly snoozeWakeLabelText?: string;
  /** Preformatted against the parent clock (row order timestamp: settle stamp
      on settled rows, latest activity otherwise). Blank while a status label
      or the wake countdown owns that slot. Precomputed per row — not via the
      list's extraData — so the minute tick re-renders only rows whose
      displayed text moved. */
  readonly timeLabel: string;
  /** Parent minute tick carried on the row's list item, present only when the
      row's menu offers snooze presets, so those menus refresh while mounted
      without invalidating every other row. */
  readonly snoozePresetMinute: string;
  readonly project: EnvironmentProject | null;
  readonly projectTitle?: string;
  readonly providerInstance: ThreadRowProviderInstance | null;
  /** Which machine hosts the thread. Null when only one environment is
      connected — repeating the same label on every row is noise. Mirrors
      the web sidebar's remote-environment cloud icon, but as text since
      phones have no hover tooltips. */
  readonly environmentLabel: string | null;
  /** Drawn after the label so the machine reads at a glance; ignored while
      the label is null. */
  readonly environmentMachine?: EnvironmentMachineKind;
  /** Hosting surface. "screen" (default) renders the compact Home idiom:
      flat edge-to-edge rows on the screen background with inset hairlines.
      "sidebar" renders the iPad split-view idiom: rounded rows blending
      into the drawer surface, selection filled with the accent color —
      matching the v1 sidebar rows. */
  readonly pane?: "screen" | "sidebar";
  /** Keeps row hairlines inside a section; section headers draw their own rule. */
  readonly showTrailingDivider?: boolean;
  /** Highlights the thread open in the detail pane (iPad split view). The
      compact Home list never sets it — phones navigate away on select. */
  readonly selected?: boolean;
  /** Override for narrow panes (iPad sidebar); defaults to window width. */
  readonly fullSwipeWidth?: number;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
  readonly onDeleteThread: (thread: EnvironmentThreadShell) => void;
  readonly onNewThreadOnBranch: (thread: EnvironmentThreadShell) => void;
  readonly onRenameThread: (thread: EnvironmentThreadShell) => void;
  readonly onRegenerateThreadTitle: (thread: EnvironmentThreadShell) => void;
  readonly onSettleThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly onSnoozeThread: (thread: EnvironmentThreadShell, snoozedUntil: string) => void;
  readonly onUnsnoozeThread: (thread: EnvironmentThreadShell) => void;
  readonly onUnsettleThread: (thread: EnvironmentThreadShell) => void;
  readonly onArchiveThread: (thread: EnvironmentThreadShell) => void;
  readonly onPinThread: (thread: EnvironmentThreadShell) => void;
  readonly onUnpinThread: (thread: EnvironmentThreadShell) => void;
  readonly onSetThreadAutoSettle: (thread: EnvironmentThreadShell, enabled: boolean) => void;
  /** False on environments whose server predates thread.settle/unsettle:
      swipe + menu fall back to Archive instead of failing on use. */
  readonly settlementSupported: boolean;
  /** False on servers that predate thread.snooze/unsnooze. */
  readonly snoozeSupported: boolean;
  /** False on servers that predate thread.pin/unpin. */
  readonly pinningSupported: boolean;
  /** False on servers that predate thread.auto-settle.set. */
  readonly autoSettleOptOutSupported: boolean;
  /** False on servers that predate thread title regeneration. */
  readonly titleRegenerationSupported: boolean;
  /** False on servers that predate thread.persistence.set. */
  readonly persistenceSupported: boolean;
  /** Server supports reordering this card's section. */
  readonly reorderSupported?: boolean;
  readonly onMoveThread?: (
    thread: EnvironmentThreadShell,
    direction: ThreadMoveDestination,
  ) => void;
  /** Position flags for the card's section so the menu disables the move that
      would fall off the end of the list. */
  readonly canMoveUp?: boolean;
  readonly canMoveDown?: boolean;
  readonly onSwipeableWillOpen: (methods: SwipeableMethods) => void;
  readonly onSwipeableClose: (methods: SwipeableMethods) => void;
  readonly searchMatch?: EnvironmentThreadSearchMatch;
  readonly searchQuery?: string;
  readonly simultaneousSwipeGesture?: ComponentProps<
    typeof ThreadSwipeable
  >["simultaneousWithExternalGesture"];
}) {
  const { width: windowWidth } = useWindowDimensions();
  const {
    thread,
    variant,
    onSelectThread,
    onDeleteThread,
    onRenameThread,
    onRegenerateThreadTitle,
    onNewThreadOnBranch,
    onSettleThread,
    onSnoozeThread,
    onUnsnoozeThread,
    onUnsettleThread,
    onArchiveThread,
    onPinThread,
    onUnpinThread,
    onSetThreadAutoSettle,
    onMoveThread,
  } = props;
  const snoozedRow = props.snoozed === true;
  const pinnedRow = props.pinned === true;
  const cleanupFailed = resolveThreadListV2CleanupActions(thread.worktreeCleanup).length > 0;
  const cleanupPending = thread.worktreeCleanup != null && !cleanupFailed;
  const runningAction = thread.actionResume?.outcome === "running" ? thread.actionResume : null;
  const closeTerminal = useAtomCommand(terminalEnvironment.close, { reportFailure: false });
  const retryWorktreeCleanup = useAtomCommand(threadEnvironment.retryWorktreeCleanup, {
    reportFailure: false,
  });
  const abandonWorktreeCleanup = useAtomCommand(threadEnvironment.abandonWorktreeCleanup, {
    reportFailure: false,
  });
  const setThreadPersistence = useAtomCommand(threadEnvironment.setPersistence, {
    reportFailure: false,
  });

  const pr = useThreadPr(thread);

  const theme = useUniwindTheme();
  const sidebarPane = props.pane === "sidebar";
  const selected = props.selected === true;
  const rowAppearance = getThreadListV2RowAppearance(theme, sidebarPane, selected);
  const selectedForegroundColor = theme["--color-thread-selected-foreground"];
  const foregroundColor = theme[sidebarPane ? "--color-drawer-foreground" : "--color-foreground"];
  const mutedForegroundColor =
    theme[sidebarPane ? "--color-drawer-foreground-muted" : "--color-foreground-muted"];

  const status = resolveThreadListV2Status(thread);
  const showActionWaitingIndicator = shouldShowActionWaitingIndicator(thread, status);
  const cleanupStatus = resolveWorktreeCleanupStatus(thread);
  const statusLabel = cleanupStatus
    ? { label: cleanupStatus.label, className: cleanupStatus.textClassName }
    : STATUS_LABEL_BY_STATUS[status];
  // The timestamp is precomputed per item so minute ticks only re-render changed rows.
  const timeLabel = props.timeLabel;
  const threadAccessibilityLabel = [
    thread.title,
    showActionWaitingIndicator && runningAction
      ? `Waiting for ${runningAction.actionName}. ${actionRunningPresentation(runningAction).summary}`
      : null,
    props.hasQueuedMessages ? "messages queued to send" : null,
  ]
    .filter(Boolean)
    .join(", ");

  const handleDelete = useCallback(() => onDeleteThread(thread), [onDeleteThread, thread]);
  const handleRename = useCallback(() => onRenameThread(thread), [onRenameThread, thread]);
  const handleRegenerateTitle = useCallback(
    () => onRegenerateThreadTitle(thread),
    [onRegenerateThreadTitle, thread],
  );
  const handleSettle = useCallback(() => onSettleThread(thread), [onSettleThread, thread]);
  const [customSnoozeOpen, setCustomSnoozeOpen] = useState(false);
  // A recycled cell reassigns this mounted row to a different thread without
  // remounting it, and the render closure stops running while list equality
  // says the item is unchanged — so any row-local UI state must be dismissed
  // when the identity under it changes. Without this, a custom snooze sheet
  // opened for one thread survives the thread's removal/reorder and its
  // submit snoozes whichever thread the cell was reassigned to. (ThreadSwipeable
  // enforces the same contract on the swipe layer with its resetKey.)
  const rowIdentity = `${thread.environmentId}:${thread.id}`;
  const [boundIdentity, setBoundIdentity] = useState(rowIdentity);
  if (boundIdentity !== rowIdentity) {
    setBoundIdentity(rowIdentity);
    setCustomSnoozeOpen(false);
  }
  const handleSnooze = useCallback(
    (snoozedUntil: string) => onSnoozeThread(thread, snoozedUntil),
    [onSnoozeThread, thread],
  );
  const handleUnsnooze = useCallback(() => onUnsnoozeThread(thread), [onUnsnoozeThread, thread]);
  const handleUnsettle = useCallback(() => onUnsettleThread(thread), [onUnsettleThread, thread]);
  const handlePin = useCallback(() => onPinThread(thread), [onPinThread, thread]);
  const handleUnpin = useCallback(() => onUnpinThread(thread), [onUnpinThread, thread]);
  const handleSetAutoSettle = useCallback(
    (enabled: boolean) => onSetThreadAutoSettle(thread, enabled),
    [onSetThreadAutoSettle, thread],
  );
  const handleMoveUp = useCallback(() => onMoveThread?.(thread, "up"), [onMoveThread, thread]);
  const handleMoveDown = useCallback(() => onMoveThread?.(thread, "down"), [onMoveThread, thread]);
  const handleArchive = useCallback(() => onArchiveThread(thread), [onArchiveThread, thread]);
  const handlePersistence = useCallback(
    async (persistent: boolean) => {
      const result = await setThreadPersistence({
        environmentId: thread.environmentId,
        input: { threadId: thread.id, persistent },
      });
      if (result._tag === "Failure") {
        const error = Cause.squash(result.cause);
        Alert.alert(
          "Could not update persistent thread",
          error instanceof Error ? error.message : "The persistent thread could not be updated.",
        );
      }
    },
    [setThreadPersistence, thread.environmentId, thread.id],
  );
  const handleCancelAction = useCallback(async () => {
    if (runningAction === null) return;
    const result = await closeTerminal({
      environmentId: thread.environmentId,
      input: { threadId: thread.id, terminalId: runningAction.terminalId },
    });
    if (result._tag === "Failure") {
      const error = Cause.squash(result.cause);
      Alert.alert(
        "Could not cancel Action",
        error instanceof Error ? error.message : "The Project Action could not be cancelled.",
      );
    }
  }, [closeTerminal, runningAction, thread.environmentId, thread.id]);
  const handleRetryWorktreeCleanup = useCallback(async () => {
    const result = await retryWorktreeCleanup({
      environmentId: thread.environmentId,
      input: { threadId: thread.id },
    });
    if (result._tag === "Failure") {
      const error = Cause.squash(result.cause);
      Alert.alert(
        "Could not retry worktree cleanup",
        error instanceof Error ? error.message : "The worktree cleanup could not be retried.",
      );
    }
  }, [retryWorktreeCleanup, thread.environmentId, thread.id]);
  const handleKeepWorktree = useCallback(() => {
    Alert.alert(
      "Keep worktree?",
      "LastCode will stop trying to remove this worktree. You can remove it manually later.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Keep worktree",
          style: "destructive",
          onPress: () => {
            void abandonWorktreeCleanup({
              environmentId: thread.environmentId,
              input: { threadId: thread.id },
            }).then((result) => {
              if (result._tag === "Failure") {
                const error = Cause.squash(result.cause);
                Alert.alert(
                  "Could not keep worktree",
                  error instanceof Error
                    ? error.message
                    : "The worktree cleanup could not be dismissed.",
                );
              }
            });
          },
        },
      ],
    );
  }, [abandonWorktreeCleanup, thread.environmentId, thread.id]);

  // Swipe: the v2 primary action is the lifecycle transition. Un-settling a
  // settled row keeps it active until new activity clears the user override.
  const canUnsettle = variant === "slim";
  const [snoozeGateTick, bumpSnoozeGateTick] = useState(0);
  const snoozeGateExpiryMs = props.snoozeSupported
    ? resolveThreadListV2SnoozeGateExpiryMs(thread, { now: new Date().toISOString() })
    : null;
  useEffect(() => {
    if (snoozeGateExpiryMs === null) return;
    const delayMs = Math.min(Math.max(0, snoozeGateExpiryMs - Date.now()) + 50, 2_147_483_647);
    const id = setTimeout(() => bumpSnoozeGateTick((tick) => tick + 1), delayMs);
    return () => clearTimeout(id);
  }, [snoozeGateExpiryMs, snoozeGateTick]);
  const swipeActions = resolveThreadListV2SwipeActions({
    variant,
    settlementSupported: props.settlementSupported,
    snoozeSupported: props.snoozeSupported,
    snoozable: canSnooze(thread, { now: new Date().toISOString() }),
    snoozed: snoozedRow,
  });
  const snoozePresets = useMemo(
    () => (swipeActions.secondary === "snooze" ? resolveSnoozePresets(new Date()) : ([] as const)),
    [props.snoozePresetMinute, swipeActions.secondary],
  );
  const snoozePresetActions = useMemo<MenuAction[]>(
    () => [
      ...snoozePresets.map((preset) => ({
        id: `snooze:${preset.id}`,
        title: preset.label,
        subtitle: preset.whenLabel,
      })),
      { id: "snooze:custom", title: "Custom…" },
    ],
    [snoozePresets],
  );
  // Pinned cards keep the full lifecycle menu; only the pin item flips to
  // Unpin. (Settling a pinned thread clears the pin server-side; snoozing
  // hides the card until wake with the pin intact.)
  const arrangementMenuItems = useMemo<MenuAction[]>(
    () => [
      ...(props.reorderSupported === true
        ? [
            { id: "arrange", title: "Arrange threads…", image: "line.3.horizontal" },
            {
              id: "move-up",
              title: "Move up",
              image: "arrow.up",
              attributes: { disabled: props.canMoveUp !== true },
            } satisfies MenuAction,
            {
              id: "move-down",
              title: "Move down",
              image: "arrow.down",
              attributes: { disabled: props.canMoveDown !== true },
            } satisfies MenuAction,
          ]
        : []),
      ...(props.pinningSupported
        ? [
            thread.pinnedAt != null
              ? { id: "unpin", title: "Unpin", image: "pin.slash" }
              : { id: "pin", title: "Pin", image: "pin" },
          ]
        : []),
    ],
    [
      props.canMoveDown,
      props.canMoveUp,
      props.reorderSupported,
      props.pinningSupported,
      thread.pinnedAt,
      variant,
    ],
  );
  // A submenu with the current option checked, matching web. This is a
  // per-thread setting, not a lifecycle verb.
  const autoSettleMenuItems = useMemo<MenuAction[]>(
    () =>
      props.autoSettleOptOutSupported
        ? [
            {
              id: "auto-settle",
              title: "Auto-settle behavior",
              image: "timer",
              subactions: [
                {
                  id: "auto-settle:enabled",
                  title: "Enabled",
                  state: thread.autoSettleDisabledAt == null ? "on" : "off",
                },
                {
                  id: "auto-settle:disabled",
                  title: "Disabled",
                  state: thread.autoSettleDisabledAt == null ? "off" : "on",
                },
              ],
            } satisfies MenuAction,
          ]
        : [],
    [props.autoSettleOptOutSupported, thread.autoSettleDisabledAt],
  );
  const titleMenuItems = useMemo<MenuAction[]>(
    () => [
      { id: "rename", title: "Rename", image: "square.and.pencil" },
      ...buildThreadTitleRegenerationMenuItems({
        supported: props.titleRegenerationSupported,
        isRegenerating: thread.titleRegeneration != null,
      }),
    ],
    [props.titleRegenerationSupported, thread.titleRegeneration],
  );
  const actionMenuItems = useMemo<MenuAction[]>(
    () =>
      runningAction === null
        ? []
        : [
            {
              id: "cancel-action",
              title: `Cancel ${runningAction.actionName}`,
              image: "stop.fill",
              attributes: { destructive: true },
            },
          ],
    [runningAction],
  );
  const withPersistence = useCallback(
    (actions: ReadonlyArray<MenuAction>) =>
      buildThreadPersistenceMenuItems({
        actions,
        persistent: thread.persistent === true,
        supported: props.persistenceSupported,
      }),
    [props.persistenceSupported, thread.persistent],
  );
  const snoozableCardMenuActions = useMemo<MenuAction[]>(
    () =>
      withPersistence([
        { id: "settle", title: "Settle", image: "checkmark" },
        {
          id: "snooze",
          title: "Snooze",
          image: "clock",
          subactions: snoozePresetActions,
        },
        ...arrangementMenuItems,
        ...titleMenuItems,
        ...autoSettleMenuItems,
        ...actionMenuItems,
        { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
      ]),
    [
      autoSettleMenuItems,
      actionMenuItems,
      arrangementMenuItems,
      snoozePresetActions,
      titleMenuItems,
      withPersistence,
    ],
  );
  const cardMenuActions = useMemo<MenuAction[]>(
    () =>
      withPersistence([
        CARD_MENU_ACTIONS[0]!,
        ...arrangementMenuItems,
        ...titleMenuItems,
        ...autoSettleMenuItems,
        ...actionMenuItems,
        ...CARD_MENU_ACTIONS.slice(1),
      ]),
    [autoSettleMenuItems, actionMenuItems, arrangementMenuItems, titleMenuItems, withPersistence],
  );
  // Settled and snoozed rows keep the setting too, matching web where every
  // row shares one menu builder.
  const slimMenuActions = useMemo<MenuAction[]>(
    () =>
      withPersistence([
        SLIM_MENU_ACTIONS[0]!,
        ...arrangementMenuItems.filter(
          (action) => action.id !== "move-up" && action.id !== "move-down",
        ),
        ...titleMenuItems,
        ...autoSettleMenuItems,
        ...actionMenuItems,
        SLIM_MENU_ACTIONS[1]!,
      ]),
    [autoSettleMenuItems, actionMenuItems, arrangementMenuItems, titleMenuItems, withPersistence],
  );
  const snoozedMenuActions = useMemo<MenuAction[]>(
    () =>
      withPersistence([
        SNOOZED_MENU_ACTIONS[0]!,
        ...titleMenuItems,
        ...autoSettleMenuItems,
        ...actionMenuItems,
        SNOOZED_MENU_ACTIONS[1]!,
      ]),
    [autoSettleMenuItems, actionMenuItems, titleMenuItems, withPersistence],
  );
  const legacyMenuActions = useMemo<MenuAction[]>(
    () =>
      withPersistence([
        LEGACY_MENU_ACTIONS[0]!,
        ...arrangementMenuItems,
        ...titleMenuItems,
        ...actionMenuItems,
        LEGACY_MENU_ACTIONS[1]!,
      ]),
    [actionMenuItems, arrangementMenuItems, titleMenuItems, withPersistence],
  );
  const handleMenuAction = useCallback(
    ({ nativeEvent }: { readonly nativeEvent: { readonly event: string } }) => {
      if (nativeEvent.event === "new-thread-on-branch") onNewThreadOnBranch(thread);
      if (nativeEvent.event === "settle") handleSettle();
      if (nativeEvent.event === "unsettle") handleUnsettle();
      if (nativeEvent.event === "unsnooze") handleUnsnooze();
      if (nativeEvent.event === "pin") handlePin();
      if (nativeEvent.event === "unpin") handleUnpin();
      if (nativeEvent.event === "auto-settle:enabled") handleSetAutoSettle(true);
      if (nativeEvent.event === "auto-settle:disabled") handleSetAutoSettle(false);
      if (nativeEvent.event === "arrange") appAtomRegistry.set(threadArrangementOpenAtom, true);
      if (nativeEvent.event === "move-up") handleMoveUp();
      if (nativeEvent.event === "move-down") handleMoveDown();
      if (nativeEvent.event === "archive") handleArchive();
      if (nativeEvent.event === "rename") handleRename();
      if (nativeEvent.event === "regenerate-title") handleRegenerateTitle();
      if (nativeEvent.event === "copy-thread-id") {
        copyTextWithHaptic(thread.id, { target: "thread-id" });
      }
      if (nativeEvent.event === "cancel-action") void handleCancelAction();
      if (nativeEvent.event === "retry-worktree-cleanup") void handleRetryWorktreeCleanup();
      if (nativeEvent.event === "keep-worktree") handleKeepWorktree();
      if (nativeEvent.event === "delete") handleDelete();
      if (nativeEvent.event === "snooze:custom") {
        setCustomSnoozeOpen(true);
        return;
      }
      const persistenceIntent = persistenceIntentForMenuEvent(nativeEvent.event);
      if (persistenceIntent !== null) void handlePersistence(persistenceIntent);
      const snoozeSelection = resolveThreadListV2SnoozeMenuSelection({
        event: nativeEvent.event,
        displayedPresets: snoozePresets,
        now: new Date(),
      });
      if (snoozeSelection._tag === "selected") {
        handleSnooze(snoozeSelection.preset.snoozedUntil);
      } else if (snoozeSelection._tag === "expired") {
        Alert.alert("Could not snooze thread", "That snooze time has passed. Choose another time.");
      }
    },
    [
      onNewThreadOnBranch,
      thread,
      handleArchive,
      handleCancelAction,
      handleDelete,
      handleKeepWorktree,
      handlePersistence,
      handleRetryWorktreeCleanup,
      handleRegenerateTitle,
      handleRename,
      handleMoveDown,
      handleMoveUp,
      handlePin,
      handleSettle,
      handleSnooze,
      handleSetAutoSettle,
      handleUnpin,
      handleUnsettle,
      handleUnsnooze,
      setCustomSnoozeOpen,
      snoozePresets,
    ],
  );
  const primaryAction = useMemo(() => {
    // Pre-settlement server: archive is the swipe action, as in v1. (Slim
    // rows cannot occur here — unsupported environments never classify as
    // settled.)
    if (swipeActions.primary === "archive") {
      return {
        accessibilityLabel: `Archive ${thread.title}`,
        icon: "archivebox" as const,
        label: "Archive",
        onPress: handleArchive,
      };
    }
    if (swipeActions.primary === "unsnooze") {
      return {
        accessibilityLabel: `Wake ${thread.title} now`,
        icon: "clock" as const,
        label: "Wake",
        onPress: handleUnsnooze,
      };
    }
    return swipeActions.primary === "unsettle"
      ? {
          accessibilityLabel: `Un-settle ${thread.title}`,
          icon: "arrow.uturn.backward" as const,
          label: "Un-settle",
          onPress: handleUnsettle,
        }
      : {
          accessibilityLabel: `Settle ${thread.title}`,
          icon: "checkmark" as const,
          label: "Settle",
          onPress: handleSettle,
        };
  }, [
    handleArchive,
    handleSettle,
    handleUnsettle,
    handleUnsnooze,
    swipeActions.primary,
    thread.title,
  ]);
  const secondaryAction = useMemo(
    () =>
      swipeActions.secondary === "snooze"
        ? {
            accessibilityLabel: `Choose when to snooze ${thread.title}`,
            icon: "clock" as const,
            label: "Snooze",
            menu: {
              actions: snoozePresetActions,
              onPressAction: handleMenuAction,
              title: "Snooze until",
            },
            onPress: () => undefined,
          }
        : null,
    [handleMenuAction, snoozePresetActions, swipeActions.secondary, thread.title],
  );
  const swipeAccessibilityHint =
    secondaryAction === null
      ? `Opens the thread. Swipe left to ${primaryAction.label.toLowerCase()}.`
      : `Opens the thread. Swipe left for ${primaryAction.label.toLowerCase()} and snooze actions.`;
  // Sidebar rows use navigation foregrounds on their active and idle surfaces.
  const cardContent = (
    <>
      <View className="flex-row items-center gap-1.5">
        {props.project ? (
          <ProjectFavicon
            environmentId={thread.environmentId}
            faviconPath={props.project.faviconPath}
            size={15}
            projectTitle={props.projectTitle ?? props.project.title}
            workspaceRoot={props.project.workspaceRoot}
          />
        ) : null}
        <Text
          className={cn(
            "flex-1 text-sm font-t3-medium",
            selected
              ? selectedThreadRowColors.mutedForegroundClassName
              : rowAppearance.mutedForegroundClassName,
          )}
          numberOfLines={1}
        >
          {props.projectTitle ?? props.project?.title ?? ""}
        </Text>
        {props.hasQueuedMessages ? <QueuedMessageIcon selected={selected} /> : null}
        {pinnedRow ? (
          <SymbolView
            name="pin"
            size={11}
            tintColorClassName={rowAppearance.mutedIconTintClassName}
            type="monochrome"
          />
        ) : null}
        <View className="flex-row items-center gap-1">
          {showActionWaitingIndicator && runningAction ? (
            <SymbolView
              accessibilityLabel={`Waiting for ${runningAction.actionName}. ${actionRunningPresentation(runningAction).summary}`}
              name="clock.arrow.circlepath"
              size={12}
              tintColor={selected ? String(selectedForegroundColor) : "#eab308"}
              type="monochrome"
            />
          ) : null}
          <Text
            className={cn(
              "text-xs tabular-nums",
              statusLabel?.className ??
                (selected
                  ? selectedThreadRowColors.foregroundClassName
                  : rowAppearance.tertiaryForegroundClassName),
            )}
          >
            {statusLabel?.label ?? timeLabel}
          </Text>
        </View>
      </View>
      <View className="mt-1 flex-row items-start gap-1.5">
        {thread.persistent === true ? (
          <View className="pt-1">
            <PersistentThreadIcon
              color={String(selected ? selectedForegroundColor : foregroundColor)}
            />
          </View>
        ) : null}
        <Text
          className={cn(
            "flex-1 text-base font-t3-medium",
            selected
              ? selectedThreadRowColors.foregroundClassName
              : rowAppearance.foregroundClassName,
            thread.persistent === true && "italic",
          )}
          numberOfLines={2}
        >
          {thread.title}
        </Text>
      </View>
      {props.searchMatch ? (
        <View className="mt-1">
          <ThreadSearchMatchExcerpt
            sidebar={sidebarPane}
            match={props.searchMatch}
            query={props.searchQuery ?? ""}
            selected={selected}
          />
        </View>
      ) : null}
      <View className="mt-1 flex-row items-center gap-2">
        {status === "failed" && thread.session?.lastError ? (
          <Text
            className={cn(
              "flex-1 text-xs",
              selected
                ? selectedThreadRowColors.mutedForegroundClassName
                : "text-danger-foreground",
            )}
            numberOfLines={1}
          >
            {thread.session.lastError}
          </Text>
        ) : thread.branch || props.environmentLabel ? (
          /* "branch · machine" share one truncating line. The machine sits
             last so a tight fit cuts the repetitive label, not the branch —
             and machine-only fills the row for non-git projects. The glyph
             hugs the label (it cannot live inside the Text without breaking
             truncation), and the wrapper takes the slack so the trailers
             stay pinned right. */
          <View className="min-w-0 flex-1 flex-row items-center gap-1">
            <Text
              className={cn(
                "shrink text-xs",
                selected
                  ? selectedThreadRowColors.mutedForegroundClassName
                  : rowAppearance.mutedForegroundClassName,
              )}
              numberOfLines={1}
            >
              {thread.branch ? (
                <Text
                  className={cn(
                    "text-xs",
                    selected
                      ? selectedThreadRowColors.mutedForegroundClassName
                      : rowAppearance.mutedForegroundClassName,
                  )}
                  style={{ fontFamily: MONO_FONT }}
                >
                  {thread.branch}
                </Text>
              ) : null}
              {thread.branch && props.environmentLabel ? "  ·  " : null}
              {props.environmentLabel ? (
                <Text
                  className={cn(
                    "text-xs",
                    selected
                      ? selectedThreadRowColors.mutedForegroundClassName
                      : rowAppearance.tertiaryForegroundClassName,
                  )}
                >
                  {props.environmentLabel}
                </Text>
              ) : null}
            </Text>
            {props.environmentLabel && props.environmentMachine ? (
              <EnvironmentMachineSymbol
                kind={props.environmentMachine}
                size={11}
                tintColorClassName={
                  selected
                    ? selectedThreadRowColors.mutedIconTintClassName
                    : rowAppearance.tertiaryIconTintClassName
                }
              />
            ) : null}
          </View>
        ) : (
          <View className="flex-1" />
        )}
        {pr ? (
          <View className="flex-row items-center gap-1" accessibilityLabel={pr.accessibilityLabel}>
            {pr.kind === "stack" || pr.others > 0 ? (
              <SymbolView
                name={pr.kind === "stack" ? "square.3.layers.3d" : "arrow.triangle.pull"}
                size={12}
                tintColorClassName={
                  pr.state === null || pr.isDraft
                    ? rowAppearance.mutedIconTintClassName
                    : pr.state === "open"
                      ? "accent-adaptive-emerald-600-400"
                      : pr.state === "closed"
                        ? "accent-adaptive-rose-600-400"
                        : "accent-adaptive-violet-600-400"
                }
              />
            ) : null}
            <Text
              accessibilityLabel={pr.accessibilityLabel}
              className={cn("text-xs", pr.textClassName)}
              style={{ fontFamily: MONO_FONT }}
            >
              {pr.kind === "stack" || pr.others > 0 ? pr.label : `#${pr.label}`}
            </Text>
          </View>
        ) : null}
        {props.providerInstance ? (
          <ProviderInstanceIcon
            provider={props.providerInstance.driverKind}
            size={14}
            displayName={props.providerInstance.displayName}
            accentColor={props.providerInstance.accentColor}
            showBadge={props.providerInstance.showBadge}
            surfaceColor={rowAppearance.providerIconSurfaceColor}
          />
        ) : null}
      </View>
    </>
  );

  const rowContent = (close: () => void) =>
    variant === "card" ? (
      <RowPressable
        key={`${thread.environmentId}:${thread.id}`}
        interactionClassName={rowAppearance.interactionClassName}
        interactionOpacity={rowAppearance.interactionOpacity}
        className={rowAppearance.className}
        accessibilityHint={
          cleanupFailed
            ? "Thread unavailable. Long-press for worktree recovery actions"
            : thread.persistent === true
              ? "Persistent thread. Long-press to disable persistence"
              : swipeAccessibilityHint
        }
        accessibilityLabel={threadAccessibilityLabel}
        accessibilityRole="button"
        accessibilityState={{ disabled: cleanupPending, selected }}
        disabled={cleanupPending}
        onPress={() => {
          if (cleanupFailed) return;
          close();
          onSelectThread(thread);
        }}
        style={rowAppearance.cardStyle}
      >
        {sidebarPane ? (
          cardContent
        ) : (
          /* Flat native list rows: no tonal containers — colored status
             labels and text hierarchy carry state, an inset hairline
             separates rows. The opaque screen background stays so swipe
             actions reveal behind the row. */
          <View>
            <View className={THREAD_LIST_V2_ROW_CONTENT_CLASS_NAME}>{cardContent}</View>
            {THREAD_LIST_V2_ROW_DIVIDERS && props.showTrailingDivider !== false ? (
              <View className="ml-5 h-px bg-border-subtle" />
            ) : null}
          </View>
        )}
      </RowPressable>
    ) : (
      <RowPressable
        key={`${thread.environmentId}:${thread.id}`}
        interactionClassName={rowAppearance.interactionClassName}
        interactionOpacity={rowAppearance.interactionOpacity}
        accessibilityHint={
          cleanupFailed
            ? "Thread unavailable. Long-press for worktree recovery actions"
            : swipeAccessibilityHint
        }
        accessibilityLabel={threadAccessibilityLabel}
        accessibilityRole="button"
        accessibilityState={{ disabled: cleanupPending, selected }}
        disabled={cleanupPending}
        className={rowAppearance.className}
        onPress={() => {
          if (cleanupFailed) return;
          close();
          onSelectThread(thread);
        }}
        style={rowAppearance.style}
      >
        {/* Settled history recedes: dimmed favicon + muted title. */}
        <View
          className={cn(
            "min-h-[44px] flex-row items-center gap-2.5 py-2",
            sidebarPane ? "px-3" : "px-5",
          )}
        >
          {props.project ? (
            <View className="opacity-40">
              <ProjectFavicon
                environmentId={thread.environmentId}
                faviconPath={props.project.faviconPath}
                size={15}
                projectTitle={props.projectTitle ?? props.project.title}
                workspaceRoot={props.project.workspaceRoot}
              />
            </View>
          ) : null}
          <View className="min-w-0 flex-1">
            <View className="flex-row items-center gap-1.5">
              {thread.persistent === true ? (
                <PersistentThreadIcon
                  color={String(selected ? selectedForegroundColor : mutedForegroundColor)}
                />
              ) : null}
              <Text
                className={cn(
                  "flex-1 text-base",
                  selected
                    ? selectedThreadRowColors.foregroundClassName
                    : rowAppearance.mutedForegroundClassName,
                  thread.persistent === true && "italic",
                )}
                numberOfLines={1}
              >
                {thread.title}
              </Text>
            </View>
            {props.searchMatch ? (
              <ThreadSearchMatchExcerpt
                sidebar={sidebarPane}
                match={props.searchMatch}
                query={props.searchQuery ?? ""}
                selected={selected}
              />
            ) : null}
          </View>
          {props.hasQueuedMessages ? <QueuedMessageIcon selected={selected} /> : null}
          <Text
            className={cn(
              "text-sm tabular-nums",
              selected
                ? selectedThreadRowColors.mutedForegroundClassName
                : snoozedRow
                  ? rowAppearance.mutedForegroundClassName
                  : rowAppearance.tertiaryForegroundClassName,
            )}
            style={{ fontFamily: MONO_FONT }}
          >
            {snoozedRow && props.snoozeWakeLabelText !== undefined
              ? props.snoozeWakeLabelText
              : timeLabel}
          </Text>
        </View>
      </RowPressable>
    );

  return (
    <View collapsable={false}>
      {customSnoozeOpen && (
        <CustomSnoozeSheet onClose={() => setCustomSnoozeOpen(false)} onSnooze={handleSnooze} />
      )}
      <ThreadSwipeable
        threadKey={`${thread.environmentId}:${thread.id}`}
        backgroundColor={rowAppearance.swipeBackgroundColor}
        compactActions={variant === "slim"}
        enabled={
          !cleanupPending &&
          !cleanupFailed &&
          !(thread.persistent === true && swipeActions.primary === "archive")
        }
        containerStyle={rowAppearance.swipeContainerStyle}
        enableTrackpadSwipe
        // Full swipe commits the advertised lifecycle action (Settle /
        // Un-settle), never the secondary snooze action.
        fullSwipeAction="primary"
        fullSwipeWidth={props.fullSwipeWidth ?? windowWidth - 32}
        onDelete={handleDelete}
        onSwipeableClose={props.onSwipeableClose}
        onSwipeableWillOpen={props.onSwipeableWillOpen}
        primaryAction={primaryAction}
        secondaryAction={secondaryAction}
        resetKey={`${thread.environmentId}:${thread.id}:${variant}:${snoozedRow}:${thread.settledAt}:${thread.unsettledAt}:${thread.snoozedUntil}`}
        simultaneousWithExternalGesture={props.simultaneousSwipeGesture}
        threadTitle={thread.title}
      >
        {(close) => (
          <ControlPillMenu
            actions={
              cleanupFailed
                ? FAILED_CLEANUP_MENU_ACTIONS
                : cleanupPending
                  ? []
                  : [
                      ...(thread.branch
                        ? [
                            {
                              id: "new-thread-on-branch",
                              title: getThreadListV2NewBranchMenuTitle(thread.branch),
                              image: "square.and.pencil",
                            },
                          ]
                        : []),
                      { id: "copy-thread-id", title: "Copy thread ID", image: "doc.on.doc" },
                      ...(snoozedRow
                        ? snoozedMenuActions
                        : !props.settlementSupported
                          ? legacyMenuActions
                          : canUnsettle
                            ? slimMenuActions
                            : swipeActions.secondary === "snooze"
                              ? snoozableCardMenuActions
                              : cardMenuActions),
                    ]
            }
            onPressAction={handleMenuAction}
            shouldOpenOnLongPress={cleanupFailed || !cleanupPending}
          >
            {rowContent(close)}
          </ControlPillMenu>
        )}
      </ThreadSwipeable>
    </View>
  );
});
