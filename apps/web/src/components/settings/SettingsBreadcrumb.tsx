import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect } from "react";

import { resolveArchivedProjectSelection } from "../../archiveProjectFiltering";
import { useArchivedProjectModel } from "../../lib/archivedThreadsState";
import { ProjectScopeBreadcrumb } from "../ProjectScopeBreadcrumb";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { SETTINGS_SECTION_LABELS } from "./settingsSearch";

const SETTINGS_BREADCRUMB_LABELS: Readonly<Record<string, string>> = {
  ...SETTINGS_SECTION_LABELS,
  "/settings/diagnostics": "Diagnostics",
};

function settingsBreadcrumbLabel(pathname: string): string | null {
  const normalizedPathname = pathname.replace(/\/+$/, "") || "/";
  return SETTINGS_BREADCRUMB_LABELS[normalizedPathname] ?? null;
}

export function SettingsBreadcrumb({ pathname }: { pathname: string }) {
  const normalizedPathname = pathname.replace(/\/+$/, "") || "/";
  if (normalizedPathname === "/settings/archived") {
    return <ArchivedThreadsBreadcrumb />;
  }
  const sectionLabel = settingsBreadcrumbLabel(pathname);

  return (
    <WorkspaceBreadcrumb ariaLabel="Settings breadcrumb">
      {sectionLabel ? (
        <>
          <WorkspaceBreadcrumbItem>Settings</WorkspaceBreadcrumbItem>
          <WorkspaceBreadcrumbSeparator />
        </>
      ) : null}
      <WorkspaceBreadcrumbItem current className="truncate">
        {sectionLabel ?? "Settings"}
      </WorkspaceBreadcrumbItem>
    </WorkspaceBreadcrumb>
  );
}

function ArchivedThreadsBreadcrumb() {
  const search = useSearch({ from: "/settings/archived" });
  const navigate = useNavigate({ from: "/settings/archived" });
  const { canValidateProjectKey, isLoading, projectGroups } = useArchivedProjectModel();
  const selection = resolveArchivedProjectSelection({
    canValidateProjectKey,
    projectGroups,
    requestedProjectKey: search.project ?? null,
  });

  useEffect(() => {
    if (!selection.shouldClearRequestedProjectKey) return;
    void navigate({ search: {}, replace: true, hashScrollIntoView: false });
  }, [navigate, selection.shouldClearRequestedProjectKey]);

  return (
    <ProjectScopeBreadcrumb
      allLabel="All"
      ariaLabel="Archive breadcrumb"
      items={projectGroups.map((group) => ({ id: group.projectKey, label: group.displayName }))}
      onSelect={(projectKey) => {
        void navigate({
          search: projectKey === null ? {} : { project: projectKey },
          replace: true,
          hashScrollIntoView: false,
        });
      }}
      rootLabel="Archive"
      selectedKey={selection.selectedProjectKey}
      unavailableLabel={isLoading ? "Loading project" : "Unavailable project"}
    />
  );
}
