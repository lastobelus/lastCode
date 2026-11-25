import type { ThreadRightPanelState } from "~/rightPanelStore";

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
    lastcodeSelectedBrowserTabIds: [tabId, ...previous.filter((id) => id !== tabId)],
  };
}

export function reconcileBrowserTabSelection(
  panel: ThreadRightPanelState,
  tabIds: readonly string[],
  suppressedTabIds: ReadonlySet<string> | undefined,
): ThreadRightPanelState {
  // An optimistic close removes its surface before the browser confirms the close.
  const previous = panel.lastcodeSelectedBrowserTabIds;
  if (!previous?.length) return panel;
  const liveTabIds = new Set(tabIds);
  const retained = previous.filter((id) => liveTabIds.has(id) || suppressedTabIds?.has(id));
  if (retained.length === previous.length) return panel;
  const { lastcodeSelectedBrowserTabIds: _previous, ...rest } = panel;
  return retained.length === 0 ? rest : { ...rest, lastcodeSelectedBrowserTabIds: retained };
}

export function readBrowserTabSelectionOrder(panel: ThreadRightPanelState | undefined) {
  const selected = panel?.lastcodeSelectedBrowserTabIds ?? [];
  return new Map(selected.map((tabId, index) => [tabId, selected.length - index]));
}
