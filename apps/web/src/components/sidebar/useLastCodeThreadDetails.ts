import {
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentProps,
  type FocusEvent,
  type MouseEvent,
} from "react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { PopoverCreateHandle as createAnnotationPopoverHandle, type Popover } from "../ui/popover";
import type { LastCodeThreadEditingCapabilities } from "./useLastCodeThreadEditing";

function hasKeyboardFocus(anchor: HTMLElement | null, popup: HTMLElement | null) {
  const focused = anchor?.ownerDocument.activeElement;
  return (
    // Paging gestures can mark the pointer-focused popup container as focus-visible.
    focused !== popup &&
    focused?.matches(":focus-visible") &&
    (anchor?.closest("[data-thread-item]")?.contains(focused) || popup?.contains(focused))
  );
}

export function useLastCodeThreadDetails(
  threadRef: ScopedThreadRef,
  editing: LastCodeThreadEditingCapabilities,
  annotated: boolean,
) {
  const [activity, setActivity] = useState({ annotated, active: false });
  // Changing annotation mode ends the ordinary hover instead of reviving it later.
  if (activity.annotated !== annotated) setActivity({ annotated, active: false });
  const threadRowActive = activity.annotated === annotated && activity.active;
  const setThreadRowActive = (active: boolean) => {
    setActivity((current) =>
      current.annotated === annotated && current.active !== active
        ? { annotated, active }
        : current,
    );
  };
  const [annotationPopoverHandle] = useState(createAnnotationPopoverHandle);
  const [threadDetailsPopoverHandle] = useState(createAnnotationPopoverHandle);
  const threadNavigationRef = useRef<HTMLDivElement | null>(null);
  const threadDetailsRef = useRef<HTMLDivElement | null>(null);
  const threadDetailsTooltipId = useId();
  const annotationTriggerId = useId();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- observes document scrolling while row details are active because moving the DOM row need not emit mouseleave
  useEffect(() => {
    const anchor = threadNavigationRef.current;
    if (!threadRowActive || !anchor) return;
    const dismissOnScroll = (event: Event) => {
      if (hasKeyboardFocus(anchor, threadDetailsRef.current)) return;
      if (event.target instanceof Node && event.target.contains(anchor)) {
        setThreadRowActive(false);
      }
    };
    // Scroll does not bubble, and moving the row need not produce a mouse-leave event.
    const document = anchor.ownerDocument;
    document.addEventListener("scroll", dismissOnScroll, true);
    return () => document.removeEventListener("scroll", dismissOnScroll, true);
  }, [threadRowActive, setThreadRowActive]);
  const clearConfirmingArchive = () => {
    editing.cancelArchiveConfirmation(threadRef);
  };
  const handleMouseLeave = (event: MouseEvent) => {
    clearConfirmingArchive();
    const next = event.relatedTarget;
    if (
      next instanceof Node &&
      (threadNavigationRef.current?.closest("[data-thread-item]")?.contains(next) ||
        threadDetailsRef.current?.contains(next))
    )
      return;
    if (hasKeyboardFocus(threadNavigationRef.current, threadDetailsRef.current)) return;
    setThreadRowActive(false);
  };
  const handleThreadDetailsTooltipOpenChange: NonNullable<
    ComponentProps<typeof Popover>["onOpenChange"]
  > = (open, eventDetails) => {
    if (eventDetails.reason === "trigger-press") {
      eventDetails.cancel();
      return;
    }
    const target = eventDetails.event.target;
    if (
      !open &&
      eventDetails.reason === "outside-press" &&
      target instanceof Node &&
      threadNavigationRef.current?.closest("[data-thread-item]")?.contains(target)
    ) {
      eventDetails.cancel();
      return;
    }
    setThreadRowActive(open);
  };
  const handleBlurCapture = (event: FocusEvent<HTMLLIElement>) => {
    const currentTarget = event.currentTarget;
    requestAnimationFrame(() => {
      if (
        currentTarget.contains(document.activeElement) ||
        threadDetailsRef.current?.contains(document.activeElement)
      ) {
        return;
      }
      clearConfirmingArchive();
      setThreadRowActive(false);
    });
  };
  return {
    threadRowActive,
    setThreadRowActive,
    annotationPopoverHandle,
    threadDetailsPopoverHandle,
    annotationTriggerId,
    threadNavigationRef,
    threadDetailsRef,
    threadDetailsTooltipId,
    handleMouseLeave,
    handleBlurCapture,
    handleThreadDetailsTooltipOpenChange,
  };
}
