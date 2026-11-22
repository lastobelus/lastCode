import { msg, T, useGT, Var } from "gt-react";
import { m } from "~/i18n/messages";
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
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import { useEnvironmentScope } from "../../state/session";
import { projectEnvironment } from "../../state/projects";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { Input } from "../ui/input";
import { stackedThreadToast, toastManager } from "../ui/toast";
type DialogProps = { target: SidebarProjectGroupMember | null; onClose: () => void };
function targetKey(target: SidebarProjectGroupMember | null) {
  return target ? scopedProjectKey(scopeProjectRef(target.environmentId, target.id)) : "closed";
}

type RenameProjectCommand = (value: {
  environmentId: EnvironmentId;
  input: { projectId: ProjectId; title: string };
}) => Promise<AtomCommandResult<unknown, unknown>>;
async function saveProjectRename(
  projectRenameTarget: SidebarProjectGroupMember | null,
  projectRenameTitle: string,
  updateProject: RenameProjectCommand,
  onClose: () => void,
) {
  if (!projectRenameTarget) {
    return;
  }

  const trimmed = projectRenameTitle.trim();
  if (trimmed.length === 0) {
    toastManager.add({
      type: "warning",
      title: m(msg("Project title cannot be empty")),
    });
    return;
  }

  if (trimmed === projectRenameTarget.title) {
    onClose();
    return;
  }

  const result = await updateProject({
    environmentId: projectRenameTarget.environmentId,
    input: {
      projectId: projectRenameTarget.id,
      title: trimmed,
    },
  });
  if (result._tag === "Success") {
    onClose();
  } else if (!isAtomCommandInterrupted(result)) {
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: m(msg("Failed to rename project")),
        description: error instanceof Error ? error.message : m(msg("An error occurred.")),
      }),
    );
  }
}
function ProjectRenameForm({ target: projectRenameTarget, onClose }: DialogProps) {
  const gt = useGT();
  const [projectRenameTitle, setProjectRenameTitle] = useState(projectRenameTarget?.title ?? "");
  const canRenameProject = useEnvironmentScope(
    projectRenameTarget?.environmentId ?? null,
    AuthOrchestrationOperateScope,
  );
  const updateProject = useOrchestrationCommand(projectEnvironment.update, {
    reportFailure: false,
  });
  const submitProjectRename = () =>
    saveProjectRename(projectRenameTarget, projectRenameTitle, updateProject, onClose);

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          <T>Rename project</T>
        </DialogTitle>
        <DialogDescription>
          {projectRenameTarget ? (
            <T>
              Update the title for <Var>{projectRenameTarget.workspaceRoot}</Var>.
            </T>
          ) : (
            <T>Update the project title.</T>
          )}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="grid gap-1.5">
          <span className="text-xs font-medium text-foreground">
            <T>Project title</T>
          </span>
          <Input
            aria-label={gt("Project title")}
            disabled={!canRenameProject}
            value={projectRenameTitle}
            onChange={(event) => setProjectRenameTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void submitProjectRename();
              }
            }}
          />
        </div>
        {projectRenameTarget?.environmentLabel ? (
          <p className="text-xs text-muted-foreground">
            <T>
              Environment: <Var>{projectRenameTarget.environmentLabel}</Var>
            </T>
          </p>
        ) : null}
        {!canRenameProject ? (
          <p className="text-xs text-muted-foreground">
            <T>This connection cannot change projects.</T>
          </p>
        ) : null}
      </DialogPanel>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          <T>Cancel</T>
        </Button>
        <Button disabled={!canRenameProject} onClick={() => void submitProjectRename()}>
          <T>Save</T>
        </Button>
      </DialogFooter>
    </>
  );
}
export function LastCodeProjectRenameDialog({ target, onClose }: DialogProps) {
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
        <ProjectRenameForm key={formIdentity.generation} target={target} onClose={onClose} />
      </DialogPopup>
    </Dialog>
  );
}
