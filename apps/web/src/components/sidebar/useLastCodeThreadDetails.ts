import { useEffect, useId, useRef, useState, type ComponentProps, type FocusEvent } from "react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { PopoverCreateHandle as createAnnotationPopoverHandle } from "../ui/popover";
import type { Tooltip } from "../ui/tooltip";
import type { LastCodeThreadEditingCapabilities } from "./useLastCodeThreadEditing";
export function useLastCodeThreadDetails(
  threadRef: ScopedThreadRef,
  editing: LastCodeThreadEditingCapabilities,
) {
  const [threadRowActive, setThreadRowActive] = useState(false);
  const [annotationPopoverHandle] = useState(createAnnotationPopoverHandle);
  const threadNavigationRef = useRef<HTMLDivElement | null>(null);
  const threadDetailsTooltipId = useId();
  const annotationTriggerId = useId();
  useEffect(() => {
    const anchor = threadNavigationRef.current;
    if (!threadRowActive || !anchor) return;
    const dismissOnScroll = (event: Event) => {
      const focused = anchor.ownerDocument.activeElement;
      if (focused?.matches(":focus-visible") && anchor.contains(focused)) return;
      if (event.target instanceof Node && event.target.contains(anchor)) {
        setThreadRowActive(false);
      }
    };
    // Scroll does not bubble, and moving the row need not produce a mouse-leave event.
    const document = anchor.ownerDocument;
    document.addEventListener("scroll", dismissOnScroll, true);
    return () => document.removeEventListener("scroll", dismissOnScroll, true);
  }, [threadRowActive]);
  const clearConfirmingArchive = () => {
    editing.cancelArchiveConfirmation(threadRef);
  };
  const handleMouseLeave = () => {
    clearConfirmingArchive();
    setThreadRowActive(false);
  };
  const handleThreadDetailsTooltipOpenChange: NonNullable<
    ComponentProps<typeof Tooltip>["onOpenChange"]
  > = (open, eventDetails) => {
    if (open) return;
    const target = eventDetails.event.target;
    if (
      eventDetails.reason === "outside-press" &&
      target instanceof Node &&
      threadNavigationRef.current?.closest("[data-thread-item]")?.contains(target)
    ) {
      return;
    }
    setThreadRowActive(false);
  };
  const handleBlurCapture = (event: FocusEvent<HTMLLIElement>) => {
    const currentTarget = event.currentTarget;
    requestAnimationFrame(() => {
      if (currentTarget.contains(document.activeElement)) {
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
    annotationTriggerId,
    threadNavigationRef,
    threadDetailsTooltipId,
    handleMouseLeave,
    handleBlurCapture,
    handleThreadDetailsTooltipOpenChange,
  };
}
