import type { ScopedThreadRef, ThreadAnnotation } from "@t3tools/contracts";
import { threadAnnotationEntries, threadAnnotationId } from "@t3tools/shared/threadAnnotation";
import {
  ThreadAnnotationBody,
  ThreadAnnotationActions,
  useThreadAnnotationBodyPending,
} from "../thread-annotation/ThreadAnnotation";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Spinner } from "../ui/spinner";
import {
  resolveTimelineMinimapPreview,
  timelineMinimapPreviewUsesFullText,
  type TimelineMinimapItem,
} from "./timelineMinimapItems";
import { useRef, useState, type MouseEvent } from "react";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { Button } from "../ui/button";
import {
  resolveTimelineMinimapHeightStyle,
  resolveTimelineMinimapIndexFromPointer,
  resolveTimelineMinimapInteractiveWidth,
  resolveTimelineMinimapNavigationInteractive,
  resolveTimelineMinimapTopPercent,
  TIMELINE_MINIMAP_MIN_ITEMS,
} from "./MessagesTimeline.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { observeResize } from "../../lib/observeResize";

function timelineMinimapEventTargetsPreview(target: EventTarget): boolean {
  return target instanceof Element && target.closest("[data-minimap-preview]") !== null;
}

// A release outside the window can skip `mouseup`, so the next button-free
// `mousemove` also counts.
function onMouseButtonsReleased(onRelease: () => void): () => void {
  const check = (event: globalThis.MouseEvent) => {
    if (event.buttons !== 0) return;
    stop();
    onRelease();
  };
  const stop = () => {
    window.removeEventListener("mouseup", check);
    window.removeEventListener("mousemove", check);
  };
  window.addEventListener("mouseup", check);
  window.addEventListener("mousemove", check);
  return stop;
}

function TimelineAnnotationPopover({
  annotation,
  ariaLabel,
  earlier,
  markdownCwd,
  open,
  reopenBlocked,
  threadRef,
  triggerClassName,
  onActivate,
  onAnnotationBodyChange,
  onAnnotationEdit,
  onAnnotationResolve,
  onAnnotationReopen,
  onOpenChange,
}: {
  annotation: ThreadAnnotation;
  ariaLabel: string;
  earlier: boolean;
  markdownCwd: string | undefined;
  open: boolean;
  reopenBlocked: boolean;
  threadRef: ScopedThreadRef;
  triggerClassName: string;
  onActivate?: () => void;
  onAnnotationBodyChange: ((body: string) => Promise<boolean>) | undefined;
  onAnnotationEdit: (() => void) | undefined;
  onAnnotationResolve: (() => void) | undefined;
  onAnnotationReopen: (() => void) | undefined;
  onOpenChange: (open: boolean) => void;
}) {
  const annotationBodyPending = useThreadAnnotationBodyPending(threadRef);

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        closeDelay={120}
        delay={0}
        openOnHover
        render={
          <button
            aria-label={ariaLabel}
            className={triggerClassName}
            data-thread-annotation-marker={earlier ? undefined : ""}
            data-annotation-id={threadAnnotationId(annotation)}
            type="button"
          />
        }
        onClick={(event) => {
          event.stopPropagation();
          onActivate?.();
        }}
        onFocus={onActivate}
      />
      <PopoverPopup
        align="center"
        width="md"
        data-minimap-preview
        elevated
        finalFocus={false}
        initialFocus={false}
        side="right"
        tooltipStyle
        padding="none"
      >
        <div className="w-80 max-w-80 bg-warning/10 p-3 text-left text-warning-foreground">
          {earlier ? (
            <div className="mb-2 text-2xs font-medium">Attached to an earlier message</div>
          ) : null}
          <ThreadAnnotationBody
            annotation={annotation}
            className="max-h-52 overflow-y-auto"
            compact
            cwd={markdownCwd}
            onBodyChange={onAnnotationBodyChange}
            threadRef={threadRef}
          />
          {onAnnotationEdit && onAnnotationResolve && onAnnotationReopen ? (
            <div className="mt-2">
              <ThreadAnnotationActions
                annotation={annotation}
                onEdit={onAnnotationEdit}
                onReopen={onAnnotationReopen}
                onResolve={onAnnotationResolve}
                pending={annotationBodyPending}
                reopenBlocked={reopenBlocked}
              />
            </div>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

export function TimelineMinimap({
  annotation,
  hasPersistentGutter,
  hitStripWidth,
  currentIndex,
  items,
  markdownCwd,
  stripMap,
  onWheel,
  threadRef,
  onAnnotationEdit,
  onAnnotationBodyChange,
  onAnnotationResolve,
  onAnnotationReopen,
  onSelect,
}: {
  annotation: ThreadAnnotation | null;
  hasPersistentGutter: boolean;
  hitStripWidth: number;
  currentIndex: number | null;
  items: ReadonlyArray<TimelineMinimapItem>;
  markdownCwd: string | undefined;
  stripMap: Map<string, HTMLSpanElement>;
  onWheel: (event: WheelEvent) => void;
  threadRef: ScopedThreadRef | null;
  onAnnotationEdit: ((annotationId?: string) => void) | undefined;
  onAnnotationBodyChange: ((body: string, annotationId?: string) => Promise<boolean>) | undefined;
  onAnnotationResolve: ((annotationId?: string) => void) | undefined;
  onAnnotationReopen: ((annotationId?: string) => void) | undefined;
  onSelect: (item: TimelineMinimapItem) => void;
}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const wheelTargetRef = (node: HTMLDivElement | null) => {
    if (!node) return;
    const forwardWheel = (event: WheelEvent) => {
      const row =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>("[data-thread-annotation-row]")
          : null;
      if (row && row.scrollWidth > row.clientWidth && (event.deltaX !== 0 || event.shiftKey))
        return;
      onWheel(event);
    };
    node.addEventListener("wheel", forwardWheel, { passive: false });
    return () => node.removeEventListener("wheel", forwardWheel);
  };

  const pressedOnStripRef = useRef(false);
  const [passThrough, setPassThrough] = useState(false);

  const [openAnnotationId, setOpenAnnotationId] = useState<string | null>(null);
  const [railHeight, setRailHeight] = useState(0);
  const observeRail = (node: HTMLDivElement | null) => {
    if (!node) return;
    const measure = () => setRailHeight(node.getBoundingClientRect().height);
    measure();
    return observeResize(node, measure);
  };

  const resolvedActiveIndex =
    activeIndex !== null && activeIndex < items.length ? activeIndex : null;
  const activeItem = resolveTimelineMinimapPreview(
    resolvedActiveIndex === null ? null : (items[resolvedActiveIndex] ?? null),
  );
  const navigationInteractive =
    resolveTimelineMinimapNavigationInteractive(hitStripWidth) && !passThrough;
  const itemIndices = new Map(items.map((item, index) => [item.messageId, index]));
  const annotationMarkers = threadAnnotationEntries(annotation).map((entry, index) => ({
    annotation: entry,
    id: threadAnnotationId(entry),
    itemIndex: itemIndices.get(entry.anchorMessageId) ?? -1,
    index,
  }));
  const markerRows = new Map<number, typeof annotationMarkers>();
  for (const marker of annotationMarkers) {
    // Share nearby six-pixel dots in a bounded, scrollable row so crowded
    // history stays within the map. Earlier notes get their own row above it.
    const position =
      marker.itemIndex < 0
        ? -24
        : Math.round(
            (resolveTimelineMinimapTopPercent(marker.itemIndex, items.length) * railHeight) /
              100 /
              12,
          ) * 12;
    const row = markerRows.get(position) ?? [];
    row.push(marker);
    markerRows.set(position, row);
  }
  const annotationPopoverOpen = annotationMarkers.some((marker) => marker.id === openAnnotationId);
  const hasActiveAnnotation = annotationMarkers.some((marker) => !marker.annotation.resolvedAt);
  const renderAnnotationPopover = (marker: (typeof annotationMarkers)[number]) => {
    if (!threadRef) return null;
    const earlier = marker.itemIndex === -1;
    return (
      <TimelineAnnotationPopover
        annotation={marker.annotation}
        ariaLabel={`${earlier ? "Earlier annotation" : "Thread annotation"} ${marker.index + 1}`}
        earlier={earlier}
        markdownCwd={markdownCwd}
        open={openAnnotationId === marker.id}
        reopenBlocked={hasActiveAnnotation}
        threadRef={threadRef}
        triggerClassName={cn(
          "pointer-events-auto size-1.5 rounded-full ring-1 ring-background/70",
          "shrink-0",
          marker.annotation.resolvedAt ? "bg-warning/40" : "bg-warning",
        )}
        onActivate={() => {
          if (!earlier) setActiveIndex(marker.itemIndex);
        }}
        onAnnotationBodyChange={
          onAnnotationBodyChange ? (body) => onAnnotationBodyChange(body, marker.id) : undefined
        }
        onAnnotationEdit={onAnnotationEdit ? () => onAnnotationEdit(marker.id) : undefined}
        onAnnotationReopen={onAnnotationReopen ? () => onAnnotationReopen(marker.id) : undefined}
        onAnnotationResolve={onAnnotationResolve ? () => onAnnotationResolve(marker.id) : undefined}
        onOpenChange={(open) => {
          setOpenAnnotationId((current) =>
            open ? marker.id : current === marker.id ? null : current,
          );
        }}
      />
    );
  };
  const activeTopPercent =
    resolvedActiveIndex === null
      ? 0
      : resolveTimelineMinimapTopPercent(resolvedActiveIndex, items.length);
  const activeTooltipTranslate =
    resolvedActiveIndex === null
      ? "-50%"
      : resolvedActiveIndex === 0
        ? "0%"
        : resolvedActiveIndex === items.length - 1
          ? "-100%"
          : "-50%";
  const resolvedCurrentIndex =
    currentIndex !== null && currentIndex >= 0 && currentIndex < items.length ? currentIndex : null;
  const previousItem =
    resolvedCurrentIndex === null ? null : (items[resolvedCurrentIndex - 1] ?? null);
  const nextItem = resolvedCurrentIndex === null ? null : (items[resolvedCurrentIndex + 1] ?? null);

  const resolveActiveIndexFromPointer = (event: MouseEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return resolveTimelineMinimapIndexFromPointer({
      itemCount: items.length,
      railTop: rect.top,
      railHeight: rect.height,
      pointerY: event.clientY,
    });
  };

  const updateActiveIndexFromPointer = (event: MouseEvent<HTMLElement>) => {
    const nextIndex = resolveActiveIndexFromPointer(event);
    setActiveIndex(nextIndex);
  };

  const moveActiveIndex = (delta: number) => {
    setActiveIndex((current) => {
      const base = current ?? 0;
      return Math.max(0, Math.min(items.length - 1, base + delta));
    });
  };

  if (items.length < TIMELINE_MINIMAP_MIN_ITEMS && annotation === null) {
    return null;
  }

  return (
    <div
      className={cn(
        "group/minimap pointer-events-none absolute inset-y-0 left-0 z-40 w-18",
        annotation !== null &&
          "[@media(pointer:coarse)]:block [@media(pointer:coarse)]:opacity-100",
        hasPersistentGutter
          ? "opacity-100"
          : "hidden opacity-0 transition-opacity duration-150 hover:opacity-100 focus-within:opacity-100 [@media(pointer:fine)]:block",
      )}
      data-testid="timeline-minimap"
      data-persistent-gutter={hasPersistentGutter ? "true" : "false"}
      ref={wheelTargetRef}
    >
      <div className="relative h-full w-full select-none">
        <div
          ref={observeRail}
          className={cn(
            "absolute top-1/2 left-3 -translate-y-1/2",
            (hitStripWidth > 0 || annotation !== null) && !passThrough
              ? "pointer-events-auto"
              : "pointer-events-none",
          )}
          onMouseDown={() => {
            if (pressedOnStripRef.current) return;
            pressedOnStripRef.current = true;
            onMouseButtonsReleased(() => {
              pressedOnStripRef.current = false;
            });
          }}
          onMouseMove={(event) => {
            if (event.buttons === 0 || pressedOnStripRef.current || passThrough) return;
            setPassThrough(true);
            onMouseButtonsReleased(() => setPassThrough(false));
          }}
          style={{
            height: resolveTimelineMinimapHeightStyle(items.length),
            width: resolveTimelineMinimapInteractiveWidth(
              Math.max(hitStripWidth, annotation === null ? 0 : 14),
              activeItem !== null,
            ),
          }}
        >
          <TimelineMinimapNavigationButton
            direction="previous"
            disabled={previousItem === null}
            interactive={navigationInteractive}
            onClick={() => {
              if (previousItem) onSelect(previousItem);
            }}
          />
          <button
            aria-label={`Jump to message: ${activeItem?.userText ?? "User message"}`}
            className="absolute inset-y-0 left-0 w-full cursor-pointer bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
            onBlur={() => setActiveIndex(null)}
            onClick={(event) => {
              if (timelineMinimapEventTargetsPreview(event.target)) {
                return;
              }
              const nextIndex = resolveActiveIndexFromPointer(event);
              const selectedItem = nextIndex === null ? null : (items[nextIndex] ?? null);
              if (selectedItem) {
                onSelect(selectedItem);
              }
              event.currentTarget.blur();
            }}
            onFocus={() => setActiveIndex((current) => current ?? resolvedCurrentIndex ?? 0)}
            onKeyDown={(event) => {
              if (timelineMinimapEventTargetsPreview(event.target)) {
                return;
              }
              if (event.key === "ArrowDown") {
                event.preventDefault();
                moveActiveIndex(1);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                moveActiveIndex(-1);
              } else if (event.key === "Home") {
                event.preventDefault();
                setActiveIndex(0);
              } else if (event.key === "End") {
                event.preventDefault();
                setActiveIndex(items.length - 1);
              } else if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                if (activeItem) {
                  onSelect(activeItem);
                }
              }
            }}
            onMouseLeave={() => setActiveIndex(null)}
            onMouseMove={(event) => {
              if (event.buttons !== 0 && !pressedOnStripRef.current) return;
              updateActiveIndexFromPointer(event);
            }}
            onMouseDown={(event) => {
              if (timelineMinimapEventTargetsPreview(event.target)) {
                return;
              }
              event.preventDefault();
            }}
            type="button"
          >
            <div className="absolute top-0 left-3 h-full w-px bg-border/15" />
            {items.map((item, index) => {
              const top = `${resolveTimelineMinimapTopPercent(index, items.length)}%`;
              const activeDistance =
                resolvedActiveIndex === null ? null : Math.abs(index - resolvedActiveIndex);
              return (
                // Compositor-friendly on purpose: in-view state and the hover
                // fisheye animate constantly (every scroll tick and streaming
                // update flips a band of strips), so the strip animates only
                // transform and opacity.
                <span
                  aria-hidden="true"
                  className={cn(
                    "pointer-events-none absolute left-0 h-0.5 w-6 origin-left -translate-y-1/2 rounded-full transition-transform duration-150 after:absolute after:inset-0 after:rounded-full after:bg-foreground/55 after:opacity-0 after:transition-opacity after:duration-150",
                    activeDistance === 0
                      ? "bg-muted-foreground/60"
                      : item.isIncoming
                        ? "bg-muted-foreground/14"
                        : "bg-muted-foreground/25",
                    item.isIncoming && activeDistance !== 0
                      ? "data-[in-view=true]:after:opacity-28"
                      : "data-[in-view=true]:after:opacity-100",
                    activeDistance === 0
                      ? "scale-x-100"
                      : activeDistance === 1
                        ? "scale-x-[0.667]"
                        : activeDistance === 2
                          ? "scale-x-[0.417]"
                          : "scale-x-[0.333]",
                  )}
                  data-in-view="false"
                  data-minimap-incoming={item.isIncoming ? "true" : "false"}
                  data-minimap-strip
                  key={item.id}
                  ref={(node) => {
                    if (node) {
                      stripMap.set(item.id, node);
                    } else {
                      stripMap.delete(item.id);
                    }
                  }}
                  style={{ top }}
                />
              );
            })}
            {activeItem && !annotationPopoverOpen ? (
              <span
                className="pointer-events-auto absolute left-8 w-80 cursor-text select-text"
                data-minimap-preview
                onMouseMove={(event) => event.stopPropagation()}
                style={{
                  top: `${activeTopPercent}%`,
                  transform: `translateY(${activeTooltipTranslate})`,
                }}
              >
                <span className="dropdown-glass block rounded-xl p-3 text-left text-popover-foreground shadow-xl shadow-black/25">
                  <span
                    className={cn(
                      "block max-w-full text-sm font-medium leading-5",
                      activeItem.summaryPending && "flex items-center gap-1.5",
                      timelineMinimapPreviewUsesFullText(activeItem)
                        ? "whitespace-normal wrap-anywhere"
                        : "overflow-hidden text-ellipsis whitespace-nowrap",
                    )}
                  >
                    {activeItem.summaryPending ? (
                      <Spinner size="xs" tone="muted" aria-label="Preparing summary" />
                    ) : null}
                    <span className={cn("min-w-0", activeItem.summaryPending && "truncate")}>
                      {activeItem.userText ?? "User message"}
                    </span>
                  </span>
                  {activeItem.assistantText ? (
                    <span
                      className="mt-1 max-h-[3.75rem] overflow-hidden text-muted-foreground text-sm leading-5"
                      style={{
                        display: "-webkit-box",
                        WebkitBoxOrient: "vertical",
                        WebkitLineClamp: 3,
                      }}
                    >
                      {activeItem.assistantText}
                    </span>
                  ) : null}
                </span>
              </span>
            ) : null}
          </button>
          {[...markerRows].map(([position, markers]) => (
            <div
              className="pointer-events-auto absolute left-3 flex h-3 max-w-12 gap-1 overflow-x-auto overflow-y-hidden [scrollbar-width:thin] [&::-webkit-scrollbar]:h-1"
              key={position}
              data-thread-annotation-overflow={position < 0 ? "" : undefined}
              data-thread-annotation-row
              style={{ top: position - 3 }}
              role="group"
              aria-label={markers.length > 5 ? "Scroll for more annotations" : "Annotation markers"}
            >
              {markers.map((marker) => (
                <span className="contents" key={marker.id}>
                  {renderAnnotationPopover(marker)}
                </span>
              ))}
            </div>
          ))}
          <TimelineMinimapNavigationButton
            direction="next"
            disabled={nextItem === null}
            interactive={navigationInteractive}
            onClick={() => {
              if (nextItem) onSelect(nextItem);
            }}
          />
        </div>
      </div>
    </div>
  );
}

function TimelineMinimapNavigationButton({
  direction,
  disabled,
  interactive,
  onClick,
}: {
  direction: "previous" | "next";
  disabled: boolean;
  interactive: boolean;
  onClick: () => void;
}) {
  const previous = direction === "previous";
  const label = previous ? "Previous turn" : "Next turn";
  const Icon = previous ? ChevronUpIcon : ChevronDownIcon;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              "absolute left-1 z-10 inline-flex -translate-x-1/2 opacity-0 transition-opacity duration-150 hover:opacity-100 focus-within:opacity-100",
              interactive ? "pointer-events-auto" : "pointer-events-none",
              previous ? "bottom-[calc(100%+2px)]" : "top-[calc(100%+2px)]",
            )}
          />
        }
      >
        <Button
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
          size="icon-micro"
          type="button"
          variant="ghost-muted"
        >
          <Icon className="size-4 text-foreground/90" />
        </Button>
      </TooltipTrigger>
      <TooltipPopup side={previous ? "top" : "bottom"}>{label}</TooltipPopup>
    </Tooltip>
  );
}
