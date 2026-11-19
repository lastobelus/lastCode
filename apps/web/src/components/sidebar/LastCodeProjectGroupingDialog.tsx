import { useState } from "react";
import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Button } from "../ui/button";
import type { SidebarProjectGroupingMode } from "@t3tools/contracts";
import { useClientSettings, updateClientSettings } from "~/hooks/useSettings";
import {
  deriveProjectGroupingOverrideKey,
  selectProjectGroupingSettings,
} from "../../logicalProject";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
type DialogProps = { target: SidebarProjectGroupMember | null; onClose: () => void };
function targetKey(target: SidebarProjectGroupMember | null) {
  return target ? scopedProjectKey(scopeProjectRef(target.environmentId, target.id)) : "closed";
}

const PROJECT_GROUPING_MODE_LABELS: Record<SidebarProjectGroupingMode, string> = {
  repository: "Group by repository",
  repository_path: "Group by repository path",
  separate: "Keep separate",
};
function projectGroupingModeDescription(mode: SidebarProjectGroupingMode): string {
  switch (mode) {
    case "repository":
      return "Projects from the same repository share one sidebar row.";
    case "repository_path":
      return "Projects group only when both the repository and repo-relative path match.";
    case "separate":
      return "Every project path gets its own sidebar row.";
  }
}

type GroupingSelection = SidebarProjectGroupingMode | "inherit";
function isGroupingSelection(value: unknown): value is GroupingSelection {
  return (
    value === "inherit" ||
    value === "repository" ||
    value === "repository_path" ||
    value === "separate"
  );
}
function ProjectGroupingForm({ target: projectGroupingTarget, onClose }: DialogProps) {
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const [projectGroupingSelection, setProjectGroupingSelection] = useState<
    SidebarProjectGroupingMode | "inherit"
  >(() =>
    projectGroupingTarget
      ? (projectGroupingSettings.sidebarProjectGroupingOverrides?.[
          deriveProjectGroupingOverrideKey(projectGroupingTarget)
        ] ?? "inherit")
      : "inherit",
  );
  const saveProjectGroupingPreference = () => {
    if (!projectGroupingTarget) {
      return;
    }

    const overrideKey = deriveProjectGroupingOverrideKey(projectGroupingTarget);
    const nextOverrides = {
      ...projectGroupingSettings.sidebarProjectGroupingOverrides,
    };
    if (projectGroupingSelection === "inherit") {
      delete nextOverrides[overrideKey];
    } else {
      nextOverrides[overrideKey] = projectGroupingSelection;
    }
    updateClientSettings({
      sidebarProjectGroupingOverrides: nextOverrides,
    });
    onClose();
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Project grouping</DialogTitle>
        <DialogDescription>
          {projectGroupingTarget
            ? `Choose how ${projectGroupingTarget.workspaceRoot} should be grouped in the sidebar.`
            : "Choose how this project should be grouped in the sidebar."}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="grid gap-1.5">
          <span className="text-xs font-medium text-foreground">Grouping rule</span>
          <Select
            value={projectGroupingSelection}
            onValueChange={(value) => {
              if (isGroupingSelection(value)) {
                setProjectGroupingSelection(value);
              }
            }}
          >
            <SelectTrigger className="w-full" aria-label="Project grouping rule">
              <SelectValue>
                {projectGroupingSelection === "inherit"
                  ? `Use global default (${PROJECT_GROUPING_MODE_LABELS[projectGroupingSettings.sidebarProjectGroupingMode]})`
                  : PROJECT_GROUPING_MODE_LABELS[projectGroupingSelection]}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem hideIndicator value="inherit">
                Use global default
              </SelectItem>
              <SelectItem hideIndicator value="repository">
                {PROJECT_GROUPING_MODE_LABELS.repository}
              </SelectItem>
              <SelectItem hideIndicator value="repository_path">
                {PROJECT_GROUPING_MODE_LABELS.repository_path}
              </SelectItem>
              <SelectItem hideIndicator value="separate">
                {PROJECT_GROUPING_MODE_LABELS.separate}
              </SelectItem>
            </SelectPopup>
          </Select>
        </div>
        <p className="text-xs text-muted-foreground">
          {projectGroupingSelection === "inherit"
            ? projectGroupingModeDescription(projectGroupingSettings.sidebarProjectGroupingMode)
            : projectGroupingModeDescription(projectGroupingSelection)}
        </p>
      </DialogPanel>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={saveProjectGroupingPreference}>Save</Button>
      </DialogFooter>
    </>
  );
}
export function LastCodeProjectGroupingDialog({ target, onClose }: DialogProps) {
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <ProjectGroupingForm key={targetKey(target)} target={target} onClose={onClose} />
      </DialogPopup>
    </Dialog>
  );
}
