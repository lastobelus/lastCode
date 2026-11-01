import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import type { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

export function focusSidebarSearchResultDetails(event: KeyboardEvent<HTMLInputElement>) {
  if (event.key !== "Tab" || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey)
    return false;
  const resultId = event.currentTarget.getAttribute("aria-activedescendant");
  const result = resultId ? event.currentTarget.ownerDocument.getElementById(resultId) : null;
  if (!result) return false;
  event.preventDefault();
  event.stopPropagation();
  result.focus();
  return true;
}

export function SidebarThreadHover({
  content,
  disabled,
  id,
  nativeButton = false,
  ...props
}: Omit<ComponentProps<typeof PopoverTrigger>, "content" | "disabled" | "ref"> & {
  content: ReactNode;
  disabled?: boolean | undefined;
}) {
  const generatedId = useId();
  const triggerId = id ?? generatedId;
  const triggerRef = useRef<HTMLElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const actionsRef = useRef<PopoverPrimitive.Root.Actions | null>(null);
  const [open, setOpen] = useState(false);
  if (disabled && open) setOpen(false);
  const visible = open && !disabled;
  const hasKeyboardFocus = () => {
    const focused = triggerRef.current?.ownerDocument.activeElement;
    return (
      focused !== popupRef.current &&
      focused?.matches(":focus-visible") &&
      (triggerRef.current?.contains(focused) || popupRef.current?.contains(focused))
    );
  };
  const handleMouseLeave = (event: MouseEvent) => {
    const next = event.relatedTarget;
    if (
      next instanceof Node &&
      (triggerRef.current?.contains(next) || popupRef.current?.contains(next))
    )
      return;
    if (!hasKeyboardFocus()) setOpen(false);
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- removing the popup immediately bypasses Base UI's close completion; clear its mounted focus guards too
  useLayoutEffect(() => {
    if (!visible) actionsRef.current?.unmount();
  }, [visible]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolling an ancestor can move a hovered row without a pointer-leave event
  useEffect(() => {
    const trigger = triggerRef.current;
    if (!visible || !trigger) return;
    const dismissOnScroll = (event: Event) => {
      if (!hasKeyboardFocus() && event.target instanceof Node && event.target.contains(trigger))
        setOpen(false);
    };
    trigger.ownerDocument.addEventListener("scroll", dismissOnScroll, true);
    return () => trigger.ownerDocument.removeEventListener("scroll", dismissOnScroll, true);
  }, [visible, hasKeyboardFocus]);
  return (
    <Popover
      actionsRef={actionsRef}
      open={visible}
      triggerId={triggerId}
      onOpenChange={(nextOpen, details) => {
        if (details.reason === "trigger-press") {
          details.cancel();
          return;
        }
        if (details.reason === "escape-key") {
          (returnFocusRef.current ?? triggerRef.current)?.focus();
        }
        setOpen(nextOpen);
      }}
    >
      <PopoverTrigger
        {...props}
        ref={(element) => {
          triggerRef.current = element;
        }}
        id={triggerId}
        nativeButton={nativeButton}
        aria-haspopup={undefined}
        aria-expanded={undefined}
        aria-controls={undefined}
        onMouseEnter={(event) => {
          props.onMouseEnter?.(event);
          if (!disabled) setOpen(true);
        }}
        onMouseLeave={(event) => {
          props.onMouseLeave?.(event);
          handleMouseLeave(event);
        }}
        onFocusCapture={(event) => {
          props.onFocusCapture?.(event);
          if (
            disabled ||
            event.target !== event.currentTarget ||
            !event.target.matches(":focus-visible")
          )
            return;
          const previous = event.relatedTarget;
          if (
            previous instanceof HTMLElement &&
            previous.getAttribute("aria-activedescendant") === triggerId
          )
            returnFocusRef.current = previous;
          else if (!open) returnFocusRef.current = null;
          setOpen(true);
        }}
        onKeyDown={(event) => {
          props.onKeyDown?.(event);
          if (event.key === "Enter" || event.key === " ") event.preventBaseUIHandler();
        }}
        onKeyUp={(event) => {
          props.onKeyUp?.(event);
          if (event.key === "Enter" || event.key === " ") event.preventBaseUIHandler();
        }}
      />
      {visible ? (
        <PopoverPopup
          ref={popupRef}
          side="right"
          align="start"
          sideOffset={0}
          animated={false}
          initialFocus={false}
          finalFocus={false}
          tooltipStyle
          padding="none"
          elevated
          className="max-w-80 select-text text-left whitespace-normal before:hidden"
          onMouseLeave={handleMouseLeave}
        >
          <div className="flex min-h-0 max-h-(--available-height) flex-col text-left">
            {content}
          </div>
        </PopoverPopup>
      ) : null}
    </Popover>
  );
}
