import { useLastCodeSidebarListAnimation } from "./useLastCodeSidebarListAnimation";
import { Fragment, memo, useMemo, type ReactNode } from "react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type { LegacySidebarScale } from "@t3tools/contracts/settings";
import type { LastCodeSidebarFamilyRow } from "../lastcodeSidebarFamilies.logic";
import type { useLastCodeProjectThreads } from "./useLastCodeProjectThreads";
import { lastcodeSidebarScaleStyle } from "../../lastcodeSidebarScale";
import { SidebarMenuSubItem, SidebarMenuSubButton } from "../ui/sidebar";
import { ThreadStatusLabel } from "../ThreadStatusIndicators";
import { LastCodeSubagentGroup, LastCodeThreadGroupHeading } from "./LastCodeThreadFamily";

interface Props {
  scale: LegacySidebarScale;
  projection: Pick<
    ReturnType<typeof useLastCodeProjectThreads>,
    "familyProjection" | "hiddenThreadStatus"
  >;
  projectExpanded: boolean;
  listExpanded: boolean;
  onListExpandedChange: (expanded: boolean) => void;
  navigateToThread: (ref: ScopedThreadRef) => Promise<void>;
  renderRow: (family: LastCodeSidebarFamilyRow) => ReactNode;
}
function ThreadListExpansion({
  expanded,
  status,
  onChange,
}: {
  expanded: boolean;
  status: Props["projection"]["hiddenThreadStatus"];
  onChange: Props["onListExpandedChange"];
}) {
  const showMoreButtonRender = useMemo(() => <button type="button" />, []);
  const showLessButtonRender = useMemo(() => <button type="button" />, []);
  return (
    <>
      {!expanded && (
        <SidebarMenuSubItem className="ml-6">
          <SidebarMenuSubButton
            render={showMoreButtonRender}
            data-thread-selection-safe
            size="sm"
            onClick={() => onChange(true)}
          >
            <span className="flex min-w-0 flex-1 items-center gap-2">
              {status && <ThreadStatusLabel status={status} compact />}
              <span>Show more</span>
            </span>
          </SidebarMenuSubButton>
        </SidebarMenuSubItem>
      )}
      {expanded && (
        <SidebarMenuSubItem className="ml-6">
          <SidebarMenuSubButton
            render={showLessButtonRender}
            data-thread-selection-safe
            size="sm"
            onClick={() => onChange(false)}
          >
            <span>Show less</span>
          </SidebarMenuSubButton>
        </SidebarMenuSubItem>
      )}
    </>
  );
}
/** Project projection rendered with one collection-owned expansion state and stable row capabilities. */
export const LastCodeThreadList = memo(function LastCodeThreadList({
  scale,
  projection,
  projectExpanded,
  listExpanded,
  onListExpandedChange,
  navigateToThread,
  renderRow,
}: Props) {
  const attachAnimation = useLastCodeSidebarListAnimation();
  const scaleStyle = useMemo(() => lastcodeSidebarScaleStyle(scale), [scale]);
  const { hiddenThreadStatus, familyProjection } = projection;
  const { hasOverflowingThreads, renderedItems, showEmptyThreadState, shouldShowThreadPanel } =
    familyProjection;
  return (
    <ul
      ref={attachAnimation}
      className="@container/lastcode-sidebar relative flex min-w-0 flex-col before:pointer-events-none before:absolute before:inset-y-0 before:left-2 before:border-l before:border-sidebar-border group-data-[collapsible=icon]:hidden"
      data-sidebar="menu-sub"
      data-slot="sidebar-menu-sub"
      data-lastcode-sidebar-scale={scale}
      style={{
        ...scaleStyle,
        marginLeft: "calc(8px * var(--lastcode-sidebar-content-zoom) - 8px)",
      }}
    >
      {shouldShowThreadPanel && showEmptyThreadState ? (
        <SidebarMenuSubItem className="w-full" data-thread-selection-safe>
          <div
            data-thread-selection-safe
            className="flex h-8 w-full items-center pl-8 pr-2 text-left text-xs text-sidebar-muted-foreground/75"
          >
            <span>No threads yet</span>
          </div>
        </SidebarMenuSubItem>
      ) : null}
      {shouldShowThreadPanel &&
        renderedItems.map((item) =>
          item.type === "subagents" ? (
            <LastCodeSubagentGroup key={item.key} item={item} navigateToThread={navigateToThread} />
          ) : (
            <Fragment key={item.row.key}>
              <LastCodeThreadGroupHeading family={item.row} />
              {renderRow(item.row)}
            </Fragment>
          ),
        )}
      {projectExpanded && hasOverflowingThreads && (
        <ThreadListExpansion
          expanded={listExpanded}
          status={hiddenThreadStatus}
          onChange={onListExpandedChange}
        />
      )}
    </ul>
  );
});
