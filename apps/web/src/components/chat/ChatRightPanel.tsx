import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useEffect } from "react";
import { usePreviewPanelInlineSize } from "../../hooks/usePreviewPanelInlineSize";
import { hostRightPanel } from "../../rightPanelStore";
import { RightPanelSheet } from "../RightPanelSheet";
import { RightPanelTabs, type RightPanelTabsProps } from "../RightPanelTabs";

type ChatRightPanelProps = Omit<RightPanelTabsProps, "mode" | "inlineSize" | "maximized"> & {
  readonly sheet: boolean;
  readonly maximized: boolean;
  readonly workspaceLayoutElement: HTMLElement | null;
  readonly widthStorageKey: string;
  readonly sheetAnimationDurationMs: number;
  readonly onCloseSheet: () => void;
};

/**
 * The right panel, inline beside the chat column or as a sheet on narrow
 * layouts. Its width follows a resize drag every frame, so the width state
 * lives here rather than in ChatView.
 */
export function ChatRightPanel(props: ChatRightPanelProps) {
  const {
    sheet,
    workspaceLayoutElement,
    widthStorageKey,
    sheetAnimationDurationMs,
    onCloseSheet,
    maximized,
    layoutControls,
    ...tabs
  } = props;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the visible parent as host when displaying a preview unmounts its side chat pane
  useEffect(() => {
    const hostRef = tabs.threadRef;
    if (!hostRef) return;
    const cleanups = tabs.surfaces.flatMap((surface) => {
      const sourceRef =
        surface.kind === "side-chat"
          ? scopeThreadRef(hostRef.environmentId, surface.threadId)
          : surface.kind === "preview"
            ? surface.sourceThreadRef
            : undefined;
      return sourceRef ? [hostRightPanel(sourceRef, hostRef)] : [];
    });
    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }, [tabs.threadRef, tabs.surfaces]);
  const inlineSize = usePreviewPanelInlineSize({
    container: workspaceLayoutElement,
    widthStorageKey,
  });
  if (!sheet) {
    return <RightPanelTabs {...tabs} mode="inline" maximized={maximized} inlineSize={inlineSize} />;
  }
  return (
    <RightPanelSheet
      animationDurationMs={sheetAnimationDurationMs}
      open={tabs.open === true}
      onClose={onCloseSheet}
    >
      <RightPanelTabs
        {...tabs}
        mode="sheet"
        inlineSize={inlineSize}
        layoutControls={layoutControls}
      />
    </RightPanelSheet>
  );
}
