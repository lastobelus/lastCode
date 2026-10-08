import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDownIcon } from "lucide-react";
import type { resolveIncomingMessagePreview } from "@t3tools/client-runtime/user-message";
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
  renderOriginal,
  renderActions,
}: {
  preview: IncomingPreview;
  surface: "neutral" | "outline";
  fillColor: string | null;
  attachments: ReactNode;
  renderOriginal: () => ReactNode;
  renderActions: (input: { expanded: boolean; toggle: () => void }) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [clipped, setClipped] = useState(false);
  const [collapsedWidth, setCollapsedWidth] = useState<number | undefined>();
  const placeholderLine = useRef<HTMLSpanElement>(null);
  const placeholderUnit = useRef<HTMLDivElement>(null);
  const visibleSummary = useRef<HTMLButtonElement>(null);
  const originalBubble = useRef<HTMLDivElement>(null);
  const previousExpanded = useRef(expanded);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const canExpand = preview.canExpand || clipped;
  const collapsed = !expanded;
  const lifted = collapsed && clipped && !preview.pending && (hovered || focused);
  const toggle = () => setExpanded((value) => !value);

  useLayoutEffect(() => {
    if (previousExpanded.current === expanded) return;
    previousExpanded.current = expanded;
    if (focused) {
      (expanded ? originalBubble.current : visibleSummary.current)?.focus({ preventScroll: true });
    }
  }, [expanded, focused]);

  useLayoutEffect(() => {
    const line = placeholderLine.current;
    if (!line || !collapsed || line.textContent !== preview.previewText) return;
    const measure = () => {
      setClipped(line.scrollWidth > line.clientWidth + 1);
      setCollapsedWidth(placeholderUnit.current?.getBoundingClientRect().width);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(line);
    return () => observer.disconnect();
  }, [collapsed, preview.previewText]);

  useLayoutEffect(
    () => () => {
      if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
    },
    [],
  );

  const bubbleClass = cn(
    "relative min-w-0 w-full rounded-2xl text-foreground",
    surface === "neutral" ? "bg-muted px-3" : "border border-border px-2.75",
    collapsed ? (surface === "neutral" ? "py-1.75" : "py-1.5") : "p-3",
    lifted && surface === "outline" && "border-transparent",
  );
  const fillStyle = surface === "neutral" && fillColor ? { backgroundColor: fillColor } : undefined;
  const summary = (placeholder: boolean) => {
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
            lifted && !placeholder ? "whitespace-normal wrap-anywhere" : "truncate",
          )}
        >
          {preview.previewText}
        </span>
        {canExpand ? (
          <ChevronDownIcon className="mt-1 size-3.5 shrink-0 text-muted-foreground" />
        ) : null}
      </>
    );
    return canExpand ? (
      <button
        type="button"
        className="flex w-full min-w-0 cursor-pointer items-start gap-1.5 rounded-md text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        aria-expanded={false}
        aria-label={`${preview.isSummary ? "Summary by Luna: " : ""}${preview.previewText}. Show full message`}
        data-incoming-message-summary
        data-scroll-anchor-ignore
        onClick={toggle}
        ref={placeholder ? undefined : visibleSummary}
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
  const collapsedUnit = (placeholder: boolean) => (
    <>
      <div className={bubbleClass} style={fillStyle}>
        {attachments}
        {summary(placeholder)}
      </div>
      <div
        className="w-full"
        style={!placeholder && clipped && !preview.pending && !lifted ? { opacity: 0 } : undefined}
      >
        {renderActions({ expanded: false, toggle })}
      </div>
    </>
  );

  return (
    <div
      className="group/incoming relative flex w-full min-w-0 flex-col items-end"
      data-incoming-message
      data-incoming-message-lifted={lifted ? "true" : "false"}
      data-incoming-message-expanded={expanded ? "true" : "false"}
      onMouseEnter={() => {
        hoverTimer.current = setTimeout(() => {
          setHovered(true);
          hoverTimer.current = null;
        }, 90);
      }}
      onMouseLeave={() => {
        if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
        hoverTimer.current = null;
        setHovered(false);
      }}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
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
              lifted &&
                "-top-1.25 -right-1.25 z-30 max-w-[calc(80%+10px)] border border-border p-1",
            )}
            style={{
              borderRadius: 20,
              width: collapsedWidth === undefined ? undefined : collapsedWidth + (lifted ? 10 : 0),
              ...(lifted
                ? {
                    background: "color-mix(in srgb, var(--background) 94%, transparent)",
                    boxShadow: "0 2px 10px color-mix(in srgb, var(--foreground) 8%, transparent)",
                  }
                : {}),
            }}
          >
            {collapsedUnit(false)}
          </div>
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
  );
}
