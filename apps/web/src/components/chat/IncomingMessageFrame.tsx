import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDownIcon, PaperclipIcon } from "lucide-react";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import type { resolveIncomingMessagePreview } from "@t3tools/client-runtime/user-message";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";

type IncomingPreview = ReturnType<typeof resolveIncomingMessagePreview>;

/** Keep the collapsed row in the flow while its summary and actions lift together. */
export function IncomingMessageFrame({
  preview,
  surface,
  fillColor,
  attachments,
  attachmentCount = 0,
  renderOriginal,
  renderActions,
}: {
  preview: IncomingPreview;
  surface: "neutral" | "outline";
  fillColor: string | null;
  attachments: ReactNode;
  attachmentCount?: number;
  renderOriginal: () => ReactNode;
  renderActions: (input: { expanded: boolean; toggle: () => void }) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [clipped, setClipped] = useState(false);
  const [collapsedWidth, setCollapsedWidth] = useState<number | undefined>();
  const placeholderLine = useRef<HTMLSpanElement>(null);
  const placeholderUnit = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const liftedUnit = useRef<HTMLDivElement>(null);
  const visibleSummary = useRef<HTMLButtonElement>(null);
  const liftedSummary = useRef<HTMLButtonElement>(null);
  const originalBubble = useRef<HTMLDivElement>(null);
  const previousExpanded = useRef(expanded);
  const previousLifted = useRef(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const canExpand = preview.canExpand || clipped || attachmentCount > 0;
  const collapsed = !expanded;
  const attachmentLabel = `${attachmentCount} ${attachmentCount === 1 ? "attachment" : "attachments"}`;
  const wholePreview = preview.isSummary || !preview.canExpand;
  const liftEligible =
    collapsed && clipped && preview.previewText.length > 0 && !preview.pending && wholePreview;
  const lifted = liftEligible && !dismissed && (hovered || focused);
  const toggle = () => setExpanded((value) => !value);

  useLayoutEffect(() => {
    if (previousExpanded.current === expanded) return;
    previousExpanded.current = expanded;
    if (focused) {
      (expanded
        ? originalBubble.current
        : lifted
          ? liftedSummary.current
          : visibleSummary.current
      )?.focus({ preventScroll: true });
    }
  }, [expanded, focused, lifted]);

  useLayoutEffect(() => {
    if (previousLifted.current && !lifted && collapsed && focused) {
      visibleSummary.current?.focus({ preventScroll: true });
    }
    previousLifted.current = lifted;
  }, [collapsed, focused, lifted]);

  useLayoutEffect(() => {
    const line = placeholderLine.current;
    if (!line || !collapsed || line.textContent !== preview.previewText) return;
    const measure = () => {
      setClipped(line.scrollWidth > line.clientWidth + 1);
      setCollapsedWidth(placeholderUnit.current?.getBoundingClientRect().width);
    };
    measure();
    return observeResize(line, measure);
  }, [collapsed, preview.previewText]);

  useLayoutEffect(
    () => () => {
      if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
      if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    },
    [],
  );

  const bubbleClass = cn(
    "relative min-w-0 w-full rounded-2xl text-foreground",
    surface === "neutral" ? "bg-muted px-3" : "border border-border px-2.75",
    collapsed ? (surface === "neutral" ? "py-1.75" : "py-1.5") : "p-3",
  );
  const fillStyle = surface === "neutral" && fillColor ? { backgroundColor: fillColor } : undefined;
  const summary = (placeholder: boolean, inLift = false) => {
    const content = (
      <>
        {preview.pending ? (
          <span className="mt-1 shrink-0">
            {placeholder ? (
              <span className="block size-3" />
            ) : (
              <Spinner size="xs" tone="muted" aria-label="Preparing summary" />
            )}
          </span>
        ) : null}
        <span
          ref={placeholder ? placeholderLine : undefined}
          className={cn(
            "min-w-0 flex-1 leading-5.25",
            inLift ? "whitespace-normal wrap-anywhere" : "truncate",
          )}
        >
          {preview.previewText}
        </span>
        {attachmentCount > 0 ? (
          <span
            className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
            aria-label={attachmentLabel}
          >
            <PaperclipIcon aria-hidden className="size-3" />
            {attachmentCount}
          </span>
        ) : null}
        {canExpand ? (
          <ChevronDownIcon className="mt-1 size-3.5 shrink-0 text-muted-foreground" />
        ) : null}
      </>
    );
    return canExpand ? (
      <button
        type="button"
        className="flex w-full min-w-0 cursor-pointer items-start gap-1.5 rounded-md text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
        aria-expanded={false}
        aria-label={`${preview.isSummary ? "Summary by Luna: " : ""}${preview.previewText || attachmentLabel}. Show full message`}
        data-incoming-message-summary
        data-scroll-anchor-ignore
        onClick={toggle}
        ref={placeholder ? undefined : inLift ? liftedSummary : visibleSummary}
        tabIndex={placeholder ? -1 : undefined}
      >
        {content}
      </button>
    ) : (
      <div className="flex w-full min-w-0 items-start gap-1.5" data-incoming-message-summary>
        {content}
      </div>
    );
  };
  const collapsedUnit = (placeholder: boolean, inLift = false) => (
    <>
      <div
        className={cn(bubbleClass, inLift && surface === "outline" && "border-transparent")}
        style={fillStyle}
      >
        {summary(placeholder, inLift)}
      </div>
      <div
        className="w-full"
        style={!placeholder && liftEligible && !inLift && !dismissed ? { opacity: 0 } : undefined}
      >
        {renderActions({ expanded: false, toggle })}
      </div>
    </>
  );

  const includesTarget = (target: EventTarget | null) =>
    target instanceof Node &&
    (frame.current?.contains(target) || liftedUnit.current?.contains(target));
  const cancelClose = () => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const leave = (target: EventTarget | null) => {
    if (includesTarget(target)) return;
    if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
    cancelClose();
    closeTimer.current = setTimeout(() => {
      setHovered(false);
      closeTimer.current = null;
    }, 60);
  };

  return (
    <PopoverPrimitive.Root
      open={lifted}
      modal={false}
      onOpenChange={(open, details) => {
        if (!open) {
          if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
          hoverTimer.current = null;
          cancelClose();
          setHovered(false);
          if (details.reason === "escape-key") {
            // Returning focus to the resting line must not immediately lift it again.
            setDismissed(true);
          } else {
            setFocused(false);
          }
        }
      }}
    >
      <div
        ref={frame}
        className="group/incoming relative flex w-full min-w-0 flex-col items-end text-sm"
        data-incoming-message
        data-incoming-message-lifted={lifted ? "true" : "false"}
        data-incoming-message-expanded={expanded ? "true" : "false"}
        onMouseEnter={() => {
          if (!focused) setDismissed(false);
          cancelClose();
          if (dismissed && focused) return;
          if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
          hoverTimer.current = setTimeout(() => {
            setHovered(true);
            hoverTimer.current = null;
          }, 90);
        }}
        onMouseLeave={(event) => leave(event.relatedTarget)}
        onFocusCapture={() => setFocused(true)}
        onBlurCapture={(event) => {
          if (!includesTarget(event.relatedTarget)) {
            setFocused(false);
            setDismissed(false);
          }
        }}
      >
        {collapsed ? (
          <>
            <div
              className="pointer-events-none invisible flex w-fit max-w-[80%] min-w-0 flex-col items-end gap-1"
              ref={placeholderUnit}
              aria-hidden
              inert
              data-incoming-message-placeholder
            >
              {collapsedUnit(true)}
            </div>
            <div
              className={cn(
                "absolute top-0 right-0 flex w-fit max-w-[80%] min-w-0 flex-col items-end gap-1",
                lifted && "invisible pointer-events-none",
              )}
              aria-hidden={lifted || undefined}
              inert={lifted || undefined}
              style={{ width: collapsedWidth }}
            >
              {collapsedUnit(false)}
            </div>
            {lifted ? (
              <PopoverPrimitive.Portal>
                <PopoverPrimitive.Positioner
                  anchor={placeholderUnit}
                  positionMethod="fixed"
                  side="bottom"
                  align="start"
                  sideOffset={({ anchor }) => -anchor.height - 5}
                  alignOffset={-5}
                  collisionAvoidance={{ side: "none", align: "none", fallbackAxisSide: "none" }}
                  className="z-[130] w-[calc(var(--anchor-width)+10px)] data-[anchor-hidden]:invisible"
                >
                  <PopoverPrimitive.Popup
                    ref={liftedUnit}
                    initialFocus={focused ? liftedSummary : false}
                    finalFocus={false}
                    className="group/incoming flex w-full min-w-0 flex-col items-end gap-1 border border-border p-1 text-sm outline-none"
                    data-incoming-message-lifted="true"
                    data-incoming-message-lift
                    aria-label={
                      preview.isSummary ? "Incoming message summary by Luna" : "Incoming message"
                    }
                    style={{
                      borderRadius: 20,
                      background: "color-mix(in srgb, var(--background) 94%, transparent)",
                      boxShadow: "0 2px 10px color-mix(in srgb, var(--foreground) 8%, transparent)",
                    }}
                    onMouseEnter={() => {
                      cancelClose();
                      setHovered(true);
                    }}
                    onMouseLeave={(event) => leave(event.relatedTarget)}
                  >
                    {collapsedUnit(false, true)}
                  </PopoverPrimitive.Popup>
                </PopoverPrimitive.Positioner>
              </PopoverPrimitive.Portal>
            ) : null}
          </>
        ) : (
          <div className="flex w-fit max-w-[80%] min-w-0 flex-col items-end gap-1">
            <div
              className={bubbleClass}
              style={fillStyle}
              ref={originalBubble}
              tabIndex={canExpand ? -1 : undefined}
            >
              {attachments}
              {renderOriginal()}
              {canExpand ? (
                <div className="mt-1.5" data-user-message-footer>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost-muted"
                    aria-expanded
                    data-scroll-anchor-ignore
                    onClick={toggle}
                  >
                    Show less
                  </Button>
                </div>
              ) : null}
            </div>
            {renderActions({ expanded, toggle })}
          </div>
        )}
      </div>
    </PopoverPrimitive.Root>
  );
}
