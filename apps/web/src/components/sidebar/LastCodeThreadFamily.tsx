import { BotIcon, ChevronRightIcon, SparklesIcon, TriangleAlertIcon } from "lucide-react";
import { parseScopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
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
} from "../lastcodeSidebarFamilies.logic";
import type { LastCodeThreadFamilyPresentation } from "./useLastCodeThreadFamily";
type Navigate = (ref: ScopedThreadRef) => Promise<void>;
function useFamilyToggle(item: LastCodeSidebarFamilyItem, navigate: Navigate) {
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
                    ? `Collapse children and return to ${thread.title}`
                    : `${family.expanded ? "Collapse" : "Expand"} children of ${thread.title}`
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
                ? "Collapse children and return to this thread"
                : "Collapse children; keep the selected conversation visible"
              : lastcodeSidebarFamilySummary(family)}
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
  const compactStatusIndicators = useClientSetting("compactLegacySidebarStatuses");
  const toggle = useFamilyToggle(item, navigateToThread);
  return (
    <SidebarMenuSubItem className="w-full" data-thread-selection-safe>
      <LastCodeSidebarFamilyGuides depth={item.depth} />
      <button
        type="button"
        aria-label={
          item.expanded && item.collapseNavigatesToParent
            ? `Collapse subagents and return to ${item.parentTitle}`
            : `${item.expanded ? "Collapse" : "Expand"} subagents of ${item.parentTitle}${!item.expanded && item.status ? ` · ${item.status.label}` : ""}`
        }
        aria-expanded={item.expanded}
        className="flex h-8 w-full items-center gap-1 rounded-md pr-2 text-3xs text-sidebar-muted-foreground uppercase hover:bg-sidebar-row-hover focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
        style={{ paddingLeft: 12 + Math.min(item.depth, 6) * 12 }}
        onClick={() => {
          toggle();
        }}
      >
        <ChevronRightIcon aria-hidden className={cn("size-3", item.expanded && "rotate-90")} />
        <BotIcon aria-hidden className="size-3" />
        <span>Subagents</span>
        <span className="text-secondary-label">{item.count}</span>
        {!item.expanded && item.status ? (
          <LastCodeThreadStatusLabel status={item.status} compact={compactStatusIndicators} />
        ) : null}
      </button>
    </SidebarMenuSubItem>
  );
}
export function LastCodeThreadRelationshipBadge({
  presentation,
}: {
  presentation: LastCodeThreadFamilyPresentation;
}) {
  const {
    isAgentCreated,
    relationshipDescription,
    relationshipLabel,
    relationshipUnavailableLabel,
  } = presentation;
  const typedGroups = useClientSetting("legacySidebarThreadGroupingStyle") === "typed-groups";
  const compactStatusIndicators = useClientSetting("compactLegacySidebarStatuses");
  return (
    <>
      {isAgentCreated || relationshipUnavailableLabel ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                aria-label={relationshipDescription ?? relationshipLabel ?? undefined}
                className={cn(
                  "inline-flex shrink-0 items-center gap-0.5 text-3xs",
                  typedGroups ? "rounded border px-1 py-0.5" : "text-sidebar-muted-foreground",
                  typedGroups && isAgentCreated && "border-dashed",
                )}
              />
            }
          >
            {isAgentCreated ? <SparklesIcon aria-hidden className="size-3" /> : null}
            {isAgentCreated && !compactStatusIndicators ? (
              <span className="hidden @sm/lastcode-sidebar:inline">Agent-created</span>
            ) : null}
            {relationshipUnavailableLabel ? (
              <TriangleAlertIcon aria-hidden className="size-3 text-warning-foreground" />
            ) : null}
          </TooltipTrigger>
          <TooltipPopup side="top">
            {relationshipDescription}
            {relationshipUnavailableLabel ? <div>{relationshipUnavailableLabel}</div> : null}
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
        <span className="truncate">{lastcodeSidebarFamilySummary(family)}</span>
      </span>
    );
  return (
    <>
      {family.descendantsStatus ? (
        <>
          <span className="inline-flex shrink-0 @sm/lastcode-sidebar:hidden">
            <LastCodeThreadStatusLabel status={family.descendantsStatus} compact />
          </span>
          <span className="hidden min-w-0 overflow-hidden @sm/lastcode-sidebar:inline-flex">
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
        <TooltipPopup side="top">{lastcodeSidebarFamilySummary(family)}</TooltipPopup>
      </Tooltip>
    </>
  );
}
