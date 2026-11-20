import { T, useGT, useMessages } from "gt-react";
import { ArrowUpRightIcon, BotIcon, ChevronRightIcon, TriangleAlertIcon } from "lucide-react";
import { parseScopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { Link } from "@tanstack/react-router";
import { buildThreadRouteParams } from "../../threadRoutes";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { cn } from "../../lib/utils";
import { useClientSetting } from "~/hooks/useSettings";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SidebarMenuSubItem } from "../ui/sidebar";
import { LastCodeThreadStatusLabel } from "./LastCodeThreadStatusLabel";
import { useLastCodeSidebarFamiliesStore } from "../lastcodeSidebarFamilies.store";
import {
  lastcodeSidebarFamilySummary,
  type LastCodeSidebarFamilyRow,
  type LastCodeSidebarFamilyItem,
  type LastCodeSidebarOwnerGroup,
} from "../lastcodeSidebarFamilies.logic";
import type { LastCodeThreadFamilyPresentation } from "./useLastCodeThreadFamily";
type Navigate = (ref: ScopedThreadRef) => Promise<void>;
function useFamilyToggle(
  item: Exclude<LastCodeSidebarFamilyItem, LastCodeSidebarOwnerGroup>,
  navigate: Navigate,
) {
  const setCollapsed = useLastCodeSidebarFamiliesStore((state) => state.setCollapsed);
  return () => {
    const family = item.type === "thread" ? item.row : item;
    setCollapsed(family.key, family.expanded);
    if (!family.expanded || !family.collapseNavigatesToParent) return;
    const target =
      item.type === "thread"
        ? scopeThreadRef(item.row.thread.environmentId, item.row.thread.id)
        : parseScopedThreadKey(item.parentKey);
    if (target) void navigate(target);
  };
}
// Each descendant supplies the segment below its ancestor disclosure slot.
// Keeping rails outside the row background preserves them through selection;
// the next sibling starts a new segment only for ancestors it actually shares.
export function LastCodeSidebarFamilyGuides({ depth }: { depth: number }) {
  return Array.from({ length: Math.min(depth, 6) }, (_, level) => (
    <span
      key={level}
      aria-hidden
      className="pointer-events-none absolute -top-1 bottom-0 border-l border-sidebar-border"
      style={{ left: 20 + level * 12 }}
    />
  ));
}

export function LastCodeThreadGroupHeading({
  family,
}: {
  family: Pick<LastCodeSidebarFamilyRow, "depth" | "groupHeading">;
}) {
  if (!family.groupHeading) return null;
  return (
    <SidebarMenuSubItem className="w-full" data-thread-selection-safe>
      <LastCodeSidebarFamilyGuides depth={family.depth} />
      <div
        style={{ paddingLeft: Math.min(family.depth, 6) * 12 + 32 }}
        className="py-1 text-3xs text-sidebar-muted-foreground uppercase"
      >
        {family.groupHeading}
      </div>
    </SidebarMenuSubItem>
  );
}

export function LastCodeThreadFamilyDisclosure({
  family,
  renameTarget,
  navigateToThread,
}: {
  family: LastCodeSidebarFamilyRow;
  renameTarget: boolean;
  navigateToThread: Navigate;
}) {
  const gt = useGT();
  const messages = useMessages();
  const typedGroups = useClientSetting("legacySidebarThreadGroupingStyle") === "typed-groups";
  const showSubheaders = useClientSetting("lastcodeSidebarFamilyStatusSubheaders");
  const toggle = useFamilyToggle({ type: "thread", row: family }, navigateToThread);
  const thread = family.thread;
  return (
    <>
      {family.descendantCount > 0 && family.projectExpanded ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                data-thread-selection-safe
                aria-label={
                  family.expanded && family.collapseNavigatesToParent
                    ? gt("Collapse children and return to {title}", { title: thread.title })
                    : family.expanded
                      ? gt("Collapse children of {title}", { title: thread.title })
                      : gt("Expand children of {title}", { title: thread.title })
                }
                aria-expanded={family.expanded}
                className={cn(
                  "relative z-30 inline-flex size-4 shrink-0 items-center justify-center rounded-sm outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
                  typedGroups &&
                    showSubheaders &&
                    !family.expanded &&
                    !renameTarget &&
                    "-translate-y-1.5",
                )}
                onPointerDown={(event) => event.stopPropagation()}
                onDoubleClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  toggle();
                }}
              />
            }
          >
            <ChevronRightIcon
              aria-hidden
              className={cn("size-3", family.expanded && "rotate-90")}
            />
          </TooltipTrigger>
          <TooltipPopup side="top">
            {family.expanded && family.selectedDescendant
              ? family.collapseNavigatesToParent
                ? gt("Collapse children and return to this thread")
                : gt("Collapse children; keep the selected conversation visible")
              : lastcodeSidebarFamilySummary(family, messages)}
          </TooltipPopup>
        </Tooltip>
      ) : (
        <span className="inline-flex size-4 shrink-0 items-center justify-center" aria-hidden>
          {family.descendantCount === 0 ? (
            <span className="size-[2px] rounded-full bg-sidebar-muted-foreground/45" />
          ) : null}
        </span>
      )}
    </>
  );
}
export function LastCodeSubagentGroup({
  item,
  navigateToThread,
}: {
  item: Extract<LastCodeSidebarFamilyItem, { type: "subagents" }>;
  navigateToThread: Navigate;
}) {
  const gt = useGT();
  const messages = useMessages();
  const compactStatusIndicators = useClientSetting("compactLegacySidebarStatuses");
  const toggle = useFamilyToggle(item, navigateToThread);
  const title = item.parentTitle;
  const disclosureLabel = item.expanded
    ? item.collapseNavigatesToParent
      ? gt("Collapse subagents and return to {title}", { title })
      : gt("Collapse subagents of {title}", { title })
    : item.status
      ? gt("Expand subagents of {title} · {status}", { title, status: messages(item.status.label) })
      : gt("Expand subagents of {title}", { title });
  return (
    <SidebarMenuSubItem className="w-full" data-thread-selection-safe>
      <LastCodeSidebarFamilyGuides depth={item.depth} />
      <button
        type="button"
        aria-label={disclosureLabel}
        aria-expanded={item.expanded}
        className="flex h-8 w-full items-center gap-1 rounded-md pr-2 text-3xs text-sidebar-muted-foreground uppercase hover:bg-sidebar-row-hover focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
        style={{ paddingLeft: 12 + Math.min(item.depth, 6) * 12 }}
        onClick={() => {
          toggle();
        }}
      >
        <ChevronRightIcon aria-hidden className={cn("size-3", item.expanded && "rotate-90")} />
        <BotIcon aria-hidden className="size-3" />
        <span>
          <T>Subagents</T>
        </span>
        <span className="text-secondary-label">{item.count}</span>
        {!item.expanded && item.status ? (
          <LastCodeThreadStatusLabel status={item.status} compact={compactStatusIndicators} />
        ) : null}
      </button>
    </SidebarMenuSubItem>
  );
}
export function LastCodeOwnerGroup({
  item,
  navigateToThread,
}: {
  item: LastCodeSidebarOwnerGroup;
  navigateToThread: Navigate;
}) {
  const gt = useGT();
  const setCollapsed = useLastCodeSidebarFamiliesStore((state) => state.setCollapsed);
  const compact = useClientSetting("compactLegacySidebarStatuses");
  const { title, ownerRef } = item;
  return (
    <SidebarMenuSubItem className="w-full" data-thread-selection-safe>
      <div className="flex items-center gap-1 pr-2">
        <button
          type="button"
          aria-label={
            item.expanded
              ? gt("Collapse children of {title}", { title })
              : gt("Expand children of {title}", { title })
          }
          aria-expanded={item.expanded}
          className="flex h-8 min-w-0 flex-1 items-center gap-1 rounded-md pl-3 pr-1 text-xs text-sidebar-muted-foreground hover:bg-sidebar-row-hover focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
          onClick={() => setCollapsed(item.key, item.expanded)}
        >
          <ChevronRightIcon
            aria-hidden
            className={cn("size-3 shrink-0", item.expanded && "rotate-90")}
          />
          <BotIcon aria-hidden className="size-3 shrink-0" />
          <span className="truncate italic">{title}</span>
          <span className="text-secondary-label">{item.count}</span>
          {!item.expanded && item.status && (
            <LastCodeThreadStatusLabel status={item.status} compact={compact} />
          )}
        </button>
        {ownerRef && (
          <Link
            to="/$environmentId/$threadId"
            params={buildThreadRouteParams(ownerRef)}
            aria-label={gt("Open creator thread")}
            onClick={(event) => {
              if (
                event.defaultPrevented ||
                event.button !== 0 ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
              )
                return;
              event.preventDefault();
              void navigateToThread(ownerRef);
            }}
            className="shrink-0 rounded-md p-1 text-sidebar-muted-foreground hover:bg-sidebar-row-hover focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
          >
            <ArrowUpRightIcon aria-hidden className="size-3" />
          </Link>
        )}
      </div>
    </SidebarMenuSubItem>
  );
}
export function LastCodeThreadRelationshipBadge({
  presentation,
  part = "all",
}: {
  presentation: LastCodeThreadFamilyPresentation;
  part?: "all" | "agent" | "warning";
}) {
  const {
    isAgentCreated,
    relationshipDescription,
    relationshipLabel,
    relationshipUnavailableLabel,
  } = presentation;
  const typedGroups = useClientSetting("legacySidebarThreadGroupingStyle") === "typed-groups";
  const compactStatusIndicators = useClientSetting("compactLegacySidebarStatuses");
  const showAgent = isAgentCreated && part !== "warning";
  const warning = part === "agent" ? null : relationshipUnavailableLabel;
  return (
    <>
      {showAgent || warning ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                aria-label={
                  (part === "warning" ? warning : (relationshipDescription ?? relationshipLabel)) ??
                  undefined
                }
                className={cn(
                  "inline-flex shrink-0 items-center gap-0.5 text-3xs",
                  typedGroups ? "rounded border px-1 py-0.5" : "text-sidebar-muted-foreground",
                  typedGroups && showAgent && "border-dashed",
                )}
              />
            }
          >
            {showAgent ? <BotIcon aria-hidden className="size-3" /> : null}
            {showAgent && part === "all" && !compactStatusIndicators ? (
              <span className="hidden @sm/lastcode-sidebar:inline">
                <T>Agent-created</T>
              </span>
            ) : null}
            {warning ? (
              <TriangleAlertIcon aria-hidden className="size-3 text-warning-foreground" />
            ) : null}
          </TooltipTrigger>
          <TooltipPopup side="top">
            {part === "warning" ? null : relationshipDescription}
            {warning ? <div>{warning}</div> : null}
          </TooltipPopup>
        </Tooltip>
      ) : null}
    </>
  );
}
export function LastCodeThreadFamilySummary({
  family,
  display,
}: {
  family: LastCodeSidebarFamilyRow;
  display: "inline" | "line";
}) {
  const messages = useMessages();
  const typedGroups = useClientSetting("legacySidebarThreadGroupingStyle") === "typed-groups";
  const compactStatusIndicators = useClientSetting("compactLegacySidebarStatuses");
  const showSubheaders = useClientSetting("lastcodeSidebarFamilyStatusSubheaders");
  const summaryOnLine = typedGroups && showSubheaders;
  if (family.descendantCount === 0) return null;
  if (family.expanded && showSubheaders) return null;
  if ((display === "line") !== summaryOnLine) return null;
  if (display === "line")
    return (
      <span className="flex items-center gap-1 truncate text-3xs leading-3 text-sidebar-muted-foreground">
        {family.descendantsStatus ? (
          <LastCodeThreadStatusLabel status={family.descendantsStatus} compact />
        ) : null}
        <span className="truncate">{lastcodeSidebarFamilySummary(family, messages)}</span>
      </span>
    );
  return (
    <>
      {family.descendantsStatus ? (
        <>
          <span className="inline-flex shrink-0 @sm/lastcode-sidebar:hidden">
            <LastCodeThreadStatusLabel status={family.descendantsStatus} compact />
          </span>
          <span className="hidden min-w-0 @sm/lastcode-sidebar:inline-flex">
            <LastCodeThreadStatusLabel
              status={family.descendantsStatus}
              compact={!showSubheaders || compactStatusIndicators}
            />
          </span>
        </>
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={<span className="shrink-0 text-3xs text-sidebar-muted-foreground" />}
        >
          +{family.descendantCount}
        </TooltipTrigger>
        <TooltipPopup side="top">{lastcodeSidebarFamilySummary(family, messages)}</TooltipPopup>
      </Tooltip>
    </>
  );
}
