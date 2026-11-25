import type { ThreadRightPanelState } from "~/rightPanelStore";

export function recordBrowserTabSelection(
  panel: ThreadRightPanelState,
  surfaceId: string | undefined,
): ThreadRightPanelState {
  if (!surfaceId?.startsWith("browser:")) return panel;
  const selected = panel.surfaces.find((surface) => surface.id === surfaceId);
  if (selected?.kind !== "preview" || selected.resourceId === null) return panel;

  let latest = 0;
  for (const surface of panel.surfaces) {
    if (surface.kind === "preview" && surface.resourceId !== null) {
      latest = Math.max(latest, surface.lastcodeSelectionOrder ?? 0);
    }
  }
  if (selected.lastcodeSelectionOrder === latest) return panel;
  return {
    ...panel,
    surfaces: panel.surfaces.map((surface) =>
      surface === selected ? { ...selected, lastcodeSelectionOrder: latest + 1 } : surface,
    ),
  };
}

export function readBrowserTabSelectionOrder(panel: ThreadRightPanelState | undefined) {
  const order = new Map<string, number>();
  for (const surface of panel?.surfaces ?? []) {
    if (
      surface.kind === "preview" &&
      surface.resourceId !== null &&
      surface.lastcodeSelectionOrder !== undefined
    ) {
      order.set(surface.resourceId, surface.lastcodeSelectionOrder);
    }
  }
  return order;
}
