import { msg, T, useGT, useMessages, Var } from "gt-react";
import { useState } from "react";
import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  PROJECT_GROUPING_MODE_LABELS,
  type SidebarProjectGroupMember,
} from "../../sidebarProjectGrouping";
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
  derivePhysicalProjectKey as deriveProjectGroupingOverrideKey,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
type DialogProps = { target: SidebarProjectGroupMember | null; onClose: () => void };
function targetKey(target: SidebarProjectGroupMember | null) {
  return target ? scopedProjectKey(scopeProjectRef(target.environmentId, target.id)) : "closed";
}

const PROJECT_GROUPING_MODE_DESCRIPTIONS: Record<SidebarProjectGroupingMode, string> = {
  repository: msg("Projects from the same repository share one sidebar row."),
  repository_path: msg(
    "Projects group only when both the repository and repo-relative path match.",
  ),
  separate: msg("Every project path gets its own sidebar row."),
};

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
  const gt = useGT();
  const messages = useMessages();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const globalGroupingMode = projectGroupingSettings.sidebarProjectGroupingMode;
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
        <DialogTitle>
          <T>Project grouping</T>
        </DialogTitle>
        <DialogDescription>
          {projectGroupingTarget ? (
            <T>
              Choose how <Var>{projectGroupingTarget.workspaceRoot}</Var> should be grouped in the
              sidebar.
            </T>
          ) : (
            <T>Choose how this project should be grouped in the sidebar.</T>
          )}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="grid gap-1.5">
          <span className="text-xs font-medium text-foreground">
            <T>Grouping rule</T>
          </span>
          <Select
            value={projectGroupingSelection}
            onValueChange={(value) => {
              if (isGroupingSelection(value)) {
                setProjectGroupingSelection(value);
              }
            }}
          >
            <SelectTrigger className="w-full" aria-label={gt("Project grouping rule")}>
              <SelectValue>
                {projectGroupingSelection === "inherit"
                  ? gt("Use global default ({mode})", {
                      mode: messages(PROJECT_GROUPING_MODE_LABELS[globalGroupingMode]),
                    })
                  : messages(PROJECT_GROUPING_MODE_LABELS[projectGroupingSelection])}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem hideIndicator value="inherit">
                <T>Use global default</T>
              </SelectItem>
              <SelectItem hideIndicator value="repository">
                {messages(PROJECT_GROUPING_MODE_LABELS.repository)}
              </SelectItem>
              <SelectItem hideIndicator value="repository_path">
                {messages(PROJECT_GROUPING_MODE_LABELS.repository_path)}
              </SelectItem>
              <SelectItem hideIndicator value="separate">
                {messages(PROJECT_GROUPING_MODE_LABELS.separate)}
              </SelectItem>
            </SelectPopup>
          </Select>
        </div>
        <p className="text-xs text-muted-foreground">
          {messages(
            PROJECT_GROUPING_MODE_DESCRIPTIONS[
              projectGroupingSelection === "inherit" ? globalGroupingMode : projectGroupingSelection
            ],
          )}
        </p>
      </DialogPanel>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          <T>Cancel</T>
        </Button>
        <Button onClick={saveProjectGroupingPreference}>
          <T>Save</T>
        </Button>
      </DialogFooter>
    </>
  );
}
export function LastCodeProjectGroupingDialog({ target, onClose }: DialogProps) {
  const currentTargetKey = targetKey(target);
  const [formIdentity, setFormIdentity] = useState({ targetKey: currentTargetKey, generation: 0 });
  // Closing popups retain their form; reopening the same target must create a fresh draft.
  if (formIdentity.targetKey !== currentTargetKey) {
    setFormIdentity({ targetKey: currentTargetKey, generation: formIdentity.generation + 1 });
  }
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <ProjectGroupingForm key={formIdentity.generation} target={target} onClose={onClose} />
      </DialogPopup>
    </Dialog>
  );
}
