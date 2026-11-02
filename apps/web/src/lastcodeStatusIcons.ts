import type { ClientSettings } from "@t3tools/contracts/settings";
import { configurableThreadStatuses } from "./components/Sidebar.logic";
import { DEFAULT_STATUS_ICON } from "./components/ThreadStatusGlyph";

export function lastCodeStatusIcon(
  label: string,
  overrides: ClientSettings["lastcodeStatusIcons"],
) {
  return configurableThreadStatuses.some((status) => status.label === label)
    ? (overrides[label] ?? DEFAULT_STATUS_ICON)
    : DEFAULT_STATUS_ICON;
}
