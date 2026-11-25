import type { ThreadRightPanelState } from "~/rightPanelStore";

const BROWSER_SELECTION_HISTORY_LIMIT = 32;

export function recordBrowserTabSelection(
  panel: ThreadRightPanelState,
  surfaceId: string | undefined,
): ThreadRightPanelState {
  if (!surfaceId?.startsWith("browser:")) return panel;
  const selected = panel.surfaces.find((surface) => surface.id === surfaceId);
  if (selected?.kind !== "preview" || selected.resourceId === null) return panel;

  const tabId = selected.resourceId;
  const previous = panel.lastcodeSelectedBrowserTabIds ?? [];
  if (previous[0] === tabId) return panel;
  return {
    ...panel,
    lastcodeSelectedBrowserTabIds: [tabId, ...previous.filter((id) => id !== tabId)].slice(
      0,
      BROWSER_SELECTION_HISTORY_LIMIT,
    ),
  };
}
