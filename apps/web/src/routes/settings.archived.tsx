import { createFileRoute } from "@tanstack/react-router";

import { ArchivedThreadsPanel } from "../components/settings/SettingsPanels";

export interface ArchivedThreadsSearch {
  readonly project?: string;
}

export const Route = createFileRoute("/settings/archived")({
  validateSearch: (raw: Record<string, unknown>): ArchivedThreadsSearch =>
    typeof raw.project === "string" && raw.project ? { project: raw.project.slice(0, 500) } : {},
  component: ArchivedThreadsRouteView,
});

function ArchivedThreadsRouteView() {
  const search = Route.useSearch();
  return <ArchivedThreadsPanel projectKey={search.project ?? null} />;
}
