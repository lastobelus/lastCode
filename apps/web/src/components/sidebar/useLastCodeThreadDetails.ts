import {
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type FocusEvent,
} from "react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { PopoverCreateHandle as createAnnotationPopoverHandle } from "../ui/popover";
import type { Tooltip } from "../ui/tooltip";
import type { LastCodeThreadEditingCapabilities } from "./useLastCodeThreadEditing";
export function useLastCodeThreadDetails(
  threadRef: ScopedThreadRef,
  editing: LastCodeThreadEditingCapabilities,
) {
  const [threadRowActive, setThreadRowActive] = useState(false);
  const annotationPopoverHandle = useMemo(() => createAnnotationPopoverHandle(), []);
  const threadNavigationRef = useRef<HTMLDivElement | null>(null);
  const threadDetailsTooltipId = useId();
  const annotationTriggerId = useId();
  const clearConfirmingArchive = useCallback(() => {
    editing.cancelArchiveConfirmation(threadRef);
  }, [editing, threadRef]);
  const handleMouseLeave = useCallback(() => {
    clearConfirmingArchive();
    setThreadRowActive(false);
  }, [clearConfirmingArchive]);
  const handleThreadDetailsTooltipOpenChange = useCallback<
    NonNullable<ComponentProps<typeof Tooltip>["onOpenChange"]>
  >((open, eventDetails) => {
    if (!open && eventDetails.reason === "escape-key") setThreadRowActive(false);
  }, []);
  const handleBlurCapture = useCallback(
    (event: FocusEvent<HTMLLIElement>) => {
      const currentTarget = event.currentTarget;
      requestAnimationFrame(() => {
        if (currentTarget.contains(document.activeElement)) {
          return;
        }
        clearConfirmingArchive();
        setThreadRowActive(false);
      });
    },
    [clearConfirmingArchive],
  );
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
