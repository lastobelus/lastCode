import type { CSSProperties, ReactNode } from "react";
import type { EnvironmentIconColor } from "@t3tools/contracts/settings";
import type { SidebarThreadSummary } from "../../types";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { useClientSetting } from "../../hooks/useSettings";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PopoverCreateHandle, PopoverTrigger } from "../ui/popover";
import { ThreadWorktreeIndicator } from "../ThreadStatusIndicators";
import {
  ConnectedSidebarEnvironmentIcon,
  type SidebarProviderBadgePreferences,
} from "./SidebarEnvironmentIcon";

type AnnotationHandle = ReturnType<typeof PopoverCreateHandle>;
export function LastCodeThreadMetadataEnvironment({
  thread,
  visible,
  label,
  color,
  confirming,
  providerEntry,
  preferences,
}: {
  thread: SidebarThreadSummary;
  visible: boolean;
  label: string | null;
  color: EnvironmentIconColor | undefined;
  confirming: boolean;
  providerEntry: ProviderInstanceEntry | null;
  preferences: SidebarProviderBadgePreferences;
}) {
  return (
    <span
      className="inline-flex h-3 w-full items-center justify-center"
      data-thread-metadata-column="environment"
    >
      {visible ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                aria-label={[
                  label ?? "Remote",
                  preferences.enabled ? providerEntry?.displayName : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
                className={`inline-flex shrink-0 items-center justify-center ${
                  confirming ? "invisible" : ""
                }`}
                data-lastcode-sidebar-unscaled-content
              />
            }
          >
            <ConnectedSidebarEnvironmentIcon
              environmentId={thread.environmentId}
              context="legacy-row"
              color={color}
              className="size-3"
              provider={preferences.enabled ? providerEntry : null}
              badgeSize={preferences.size}
              badgeTransparency={preferences.transparency}
            />
          </TooltipTrigger>
          <TooltipPopup side="top">
            {label}
            {preferences.enabled && providerEntry ? ` · ${providerEntry.displayName}` : null}
          </TooltipPopup>
        </Tooltip>
      ) : null}
    </span>
  );
}
function TimestampContent({
  thread,
  jumpLabel,
  highlighted,
  annotated,
}: {
  thread: SidebarThreadSummary;
  jumpLabel: string | null;
  highlighted: boolean;
  annotated: boolean;
}) {
  if (jumpLabel)
    return (
      <span className="inline-flex h-5 items-center rounded-full border border-dotted border-warning bg-warning/10 px-1.5 font-mono text-3xs font-medium tracking-tight text-warning-foreground shadow-sm">
        {jumpLabel}
      </span>
    );
  return (
    <span
      className={`${annotated ? "border-b border-dotted border-warning " : ""}text-3xs tabular-nums ${highlighted ? "text-foreground" : "text-secondary-label"}`}
      data-lastcode-sidebar-unscaled-content
    >
      {formatRelativeTimeLabel(thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt)}
    </span>
  );
}
function Timestamp({
  thread,
  jumpLabel,
  highlighted,
  annotationHandle,
}: {
  thread: SidebarThreadSummary;
  jumpLabel: string | null;
  highlighted: boolean;
  annotationHandle: AnnotationHandle;
}) {
  const annotated = thread.annotation?.resolvedAt === null;
  if (annotated)
    return (
      <PopoverTrigger
        aria-label={
          jumpLabel
            ? `${jumpLabel}; show annotation for ${thread.title}`
            : `Show annotation for ${thread.title}`
        }
        handle={annotationHandle}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") event.stopPropagation();
        }}
      >
        <TimestampContent
          thread={thread}
          jumpLabel={jumpLabel}
          highlighted={highlighted}
          annotated
        />
      </PopoverTrigger>
    );
  if (jumpLabel)
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              aria-label={jumpLabel}
              className="inline-flex h-5 items-center rounded-full border border-border/80 bg-background/90 px-1.5 font-mono text-3xs font-medium tracking-tight text-foreground shadow-sm"
            />
          }
        >
          {jumpLabel}
        </TooltipTrigger>
        <TooltipPopup side="top">{jumpLabel}</TooltipPopup>
      </Tooltip>
    );
  return (
    <TimestampContent
      thread={thread}
      jumpLabel={null}
      highlighted={highlighted}
      annotated={false}
    />
  );
}
export function LastCodeThreadMetadata({
  thread,
  jumpLabel,
  highlighted,
  confirming,
  canArchive,
  annotationHandle,
  environmentIcon,
  children,
}: {
  thread: SidebarThreadSummary;
  jumpLabel: string | null;
  highlighted: boolean;
  confirming: boolean;
  canArchive: boolean;
  annotationHandle: AnnotationHandle;
  environmentIcon: ReactNode;
  children: ReactNode;
}) {
  const showWorktreeIndicators = useClientSetting("showThreadWorktreeIndicators");
  const visibility = confirming
    ? "opacity-0"
    : canArchive
      ? "transition-opacity duration-150 group-hover/menu-sub-item:opacity-0 group-focus-within/menu-sub-item:opacity-0"
      : "";
  const metadataClassName = `pointer-events-none inline-flex w-full justify-end ${jumpLabel ? "col-start-1 row-start-1 z-10" : ""} ${visibility}`;
  const gridClassName = jumpLabel
    ? "grid shrink-0 grid-cols-[max-content] items-center max-sm:grid-cols-[max-content_calc(1.5rem*var(--lastcode-sidebar-content-zoom))]"
    : "grid shrink-0 grid-cols-[repeat(2,calc(0.75rem*var(--lastcode-sidebar-content-zoom)))_calc(3rem*var(--lastcode-sidebar-content-zoom))] items-center gap-x-(--thread-metadata-gap) max-sm:grid-cols-[repeat(2,calc(0.75rem*var(--lastcode-sidebar-content-zoom)))_calc(3rem*var(--lastcode-sidebar-content-zoom))_calc(1.5rem*var(--lastcode-sidebar-content-zoom))]";
  // Fixed tracks keep timestamps from shifting icons. Anchor archive controls to
  // this line, not the whole row: metadata can wrap below a deeply indented title.
  return (
    <div
      className={`relative min-h-6 ${gridClassName}`}
      style={
        {
          "--thread-metadata-gap": "calc(var(--spacing) * var(--lastcode-sidebar-content-zoom))",
        } as CSSProperties
      }
      data-testid={`thread-metadata-grid-${thread.id}`}
    >
      {jumpLabel === null ? (
        <>
          <span
            className="inline-flex h-3 w-full items-center justify-center"
            data-thread-metadata-column="worktree"
          >
            {showWorktreeIndicators ? <ThreadWorktreeIndicator thread={thread} /> : null}
          </span>
          {environmentIcon}
        </>
      ) : null}
      {children}
      <span
        className={metadataClassName}
        data-thread-metadata-column="timestamp"
        data-thread-metadata-mode={jumpLabel ? "jump" : "timestamp"}
      >
        <span className="inline-flex items-center gap-1">
          <Timestamp
            thread={thread}
            jumpLabel={jumpLabel}
            highlighted={highlighted}
            annotationHandle={annotationHandle}
          />
        </span>
      </span>
    </div>
  );
}
