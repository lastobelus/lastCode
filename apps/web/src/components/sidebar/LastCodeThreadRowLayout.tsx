import type { ComponentProps, ReactNode } from "react";
import { SidebarMenuSubItem } from "../ui/sidebar";
import { LastCodeSidebarFamilyGuides } from "./LastCodeThreadFamily";
import type { useLastCodeThreadDetails } from "./useLastCodeThreadDetails";
import type { useLastCodeThreadFileDrop } from "./lastcodeThreadRowInteractions";

/** Keep the lease on the original li and all row controls inside its focus/hover boundary. */
export function LastCodeThreadRowLayout({
  depth,
  rowRef,
  fileDropHandlers,
  annotated,
  lifetime,
  children,
}: {
  depth: number;
  rowRef: ComponentProps<typeof SidebarMenuSubItem>["ref"];
  fileDropHandlers: ReturnType<typeof useLastCodeThreadFileDrop>["fileDropHandlers"];
  annotated: boolean;
  lifetime: Pick<
    ReturnType<typeof useLastCodeThreadDetails>,
    "setThreadRowActive" | "handleMouseLeave" | "handleBlurCapture"
  >;
  children: ReactNode;
}) {
  return (
    <SidebarMenuSubItem
      ref={rowRef}
      className="w-full mb-1"
      style={{ paddingLeft: 12 + Math.min(depth, 6) * 12 }}
      data-thread-item
      {...fileDropHandlers}
      onFocusCapture={() => {
        if (!annotated) lifetime.setThreadRowActive(true);
      }}
      onMouseEnter={() => {
        if (!annotated) lifetime.setThreadRowActive(true);
      }}
      onMouseLeave={lifetime.handleMouseLeave}
      onBlurCapture={lifetime.handleBlurCapture}
    >
      <LastCodeSidebarFamilyGuides depth={depth} />
      {children}
    </SidebarMenuSubItem>
  );
}
