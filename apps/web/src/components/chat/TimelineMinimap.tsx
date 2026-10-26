import type { ScopedThreadRef, ThreadAnnotation } from "@t3tools/contracts";
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
import { useEffect, useRef, useState, type MouseEvent } from "react";
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
  threadRef: ScopedThreadRef;
  triggerClassName: string;
  onActivate?: () => void;
  onAnnotationBodyChange: ((body: string) => Promise<boolean>) | undefined;
  onAnnotationEdit: () => void;
  onAnnotationResolve: () => void;
  onAnnotationReopen: () => void;
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
          <div className="mt-2">
            <ThreadAnnotationActions
              annotation={annotation}
              onEdit={onAnnotationEdit}
              onReopen={onAnnotationReopen}
              onResolve={onAnnotationResolve}
              pending={annotationBodyPending}
            />
          </div>
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
  onAnnotationEdit: () => void;
  onAnnotationBodyChange: ((body: string) => Promise<boolean>) | undefined;
  onAnnotationResolve: () => void;
  onAnnotationReopen: () => void;
  onSelect: (item: TimelineMinimapItem) => void;
}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const wheelTargetRef = (node: HTMLDivElement | null) => {
    if (!node) return;
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  };

  const pressedOnStripRef = useRef(false);
  const [passThrough, setPassThrough] = useState(false);

  useEffect(() => {
    if (!passThrough) return;
    return onMouseButtonsReleased(() => setPassThrough(false));
  }, [passThrough]);
  const [annotationPopoverOpen, setAnnotationPopoverOpen] = useState(false);

  const resolvedActiveIndex =
    activeIndex !== null && activeIndex < items.length ? activeIndex : null;
  const activeItem = resolveTimelineMinimapPreview(
    resolvedActiveIndex === null ? null : (items[resolvedActiveIndex] ?? null),
  );
  const navigationInteractive =
    resolveTimelineMinimapNavigationInteractive(hitStripWidth) && !passThrough;
  const annotationItemIndex = annotation
    ? items.findIndex((item) => item.messageId === annotation.anchorMessageId)
    : -1;
  const annotationIsEarlier = annotation !== null && annotationItemIndex === -1;
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
        "group/minimap pointer-events-none absolute inset-y-0 left-0 z-40 hidden w-18 [@media(pointer:fine)]:block",
        annotation !== null &&
          "[@media(pointer:coarse)]:block [@media(pointer:coarse)]:opacity-100",
        hasPersistentGutter
          ? "opacity-100"
          : "opacity-0 transition-opacity duration-150 hover:opacity-100 focus-within:opacity-100",
      )}
      data-testid="timeline-minimap"
      data-persistent-gutter={hasPersistentGutter ? "true" : "false"}
      ref={wheelTargetRef}
    >
      <div className="relative h-full w-full select-none">
        <div
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
            if (event.buttons !== 0 && !pressedOnStripRef.current) setPassThrough(true);
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
                    "group/strip pointer-events-none absolute left-0 h-0.5 w-6 origin-left -translate-y-1/2 rounded-full transition-transform duration-150",
                    activeDistance === 0
                      ? "bg-muted-foreground/75"
                      : item.isIncoming
                        ? "bg-muted-foreground/14"
                        : "bg-muted-foreground/35",
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
                >
                  <span
                    className={cn(
                      "absolute inset-0 rounded-full bg-foreground/90 opacity-0 transition-opacity duration-150",
                      item.isIncoming && activeDistance !== 0
                        ? "group-data-[in-view=true]/strip:opacity-28"
                        : "group-data-[in-view=true]/strip:opacity-100",
                    )}
                  />
                </span>
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
          {annotationItemIndex >= 0 && annotation && threadRef ? (
            <span
              className="pointer-events-none absolute left-0 h-0.5 w-2 -translate-y-1/2"
              style={{
                top: `${resolveTimelineMinimapTopPercent(annotationItemIndex, items.length)}%`,
              }}
            >
              <TimelineAnnotationPopover
                annotation={annotation}
                ariaLabel="Thread annotation"
                earlier={false}
                markdownCwd={markdownCwd}
                open={annotationPopoverOpen}
                threadRef={threadRef}
                triggerClassName="pointer-events-auto absolute left-full top-1/2 ml-1 size-1.5 -translate-y-1/2 rounded-full bg-warning ring-1 ring-background/70"
                onActivate={() => setActiveIndex(annotationItemIndex)}
                onAnnotationBodyChange={onAnnotationBodyChange}
                onAnnotationEdit={onAnnotationEdit}
                onAnnotationReopen={onAnnotationReopen}
                onAnnotationResolve={onAnnotationResolve}
                onOpenChange={setAnnotationPopoverOpen}
              />
            </span>
          ) : null}
          <TimelineMinimapNavigationButton
            direction="next"
            disabled={nextItem === null}
            interactive={navigationInteractive}
            onClick={() => {
              if (nextItem) onSelect(nextItem);
            }}
          />
        </div>
        {annotationIsEarlier && annotation && threadRef ? (
          <div
            className="pointer-events-auto absolute left-3"
            data-thread-annotation-overflow
            style={{
              top: "50%",
              transform: `translateY(calc(-50% - ${resolveTimelineMinimapHeightStyle(items.length)} / 2))`,
            }}
          >
            <TimelineAnnotationPopover
              annotation={annotation}
              ariaLabel="Annotation attached to an earlier message"
              earlier
              markdownCwd={markdownCwd}
              open={annotationPopoverOpen}
              threadRef={threadRef}
              triggerClassName="size-1.5 rounded-full bg-warning ring-1 ring-background/70"
              onAnnotationBodyChange={onAnnotationBodyChange}
              onAnnotationEdit={onAnnotationEdit}
              onAnnotationReopen={onAnnotationReopen}
              onAnnotationResolve={onAnnotationResolve}
              onOpenChange={setAnnotationPopoverOpen}
            />
          </div>
        ) : null}
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
