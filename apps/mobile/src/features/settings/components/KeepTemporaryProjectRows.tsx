import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { isTemporaryProject } from "@t3tools/client-runtime/state/temporary-projects";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { useGT, useMessages } from "gt-react-native";
import { useState } from "react";
import * as Dialog from "../../../components/ui/Dialog";
import { ListActionRow } from "../../../components/ui/ListActionRow";
import { projectEnvironment } from "../../../state/projects";
import { useEnvironmentScope } from "../../../state/session";
import { useAtomCommand } from "../../../state/use-atom-command";
import { scopedProjectKey } from "../../../lib/scopedEntities";
import type { SettingsTarget } from "../settings-environment-filter";
import { SettingsSection } from "./SettingsSection";

function KeepTemporaryProjectRow({
  project,
  environmentLabel,
}: {
  readonly project: EnvironmentProject;
  readonly environmentLabel: string | undefined;
}) {
  const gt = useGT();
  const m = useMessages();
  const canEdit = useEnvironmentScope(project.environmentId, AuthOrchestrationOperateScope);
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const [keeping, setKeeping] = useState(false);
  const keep = async () => {
    setKeeping(true);
    const result = await updateProject({
      environmentId: project.environmentId,
      input: { projectId: project.id, keepTemporary: true },
    }).finally(() => setKeeping(false));
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      Dialog.alert(
        gt("Could not keep project"),
        error instanceof Error
          ? (errorDisplayMessage(error, m) ?? error.message)
          : gt("An error occurred."),
      );
    }
  };
  return (
    <ListActionRow
      label={gt("Keep project")}
      description={[environmentLabel, project.workspaceRoot].filter(Boolean).join(" · ")}
      disabled={!canEdit}
      loading={keeping}
      onPress={() => void keep()}
    />
  );
}

export function KeepTemporaryProjectRows({
  projects,
  environments,
}: {
  readonly projects: readonly EnvironmentProject[];
  readonly environments: readonly SettingsTarget[];
}) {
  const gt = useGT();
  const temporaryProjects = projects.filter(isTemporaryProject);
  if (temporaryProjects.length === 0) return null;
  return (
    <SettingsSection title={gt("Temporary projects")}>
      {temporaryProjects.map((project) => (
        <KeepTemporaryProjectRow
          key={scopedProjectKey(project.environmentId, project.id)}
          project={project}
          environmentLabel={
            environments.find((target) => target.environmentId === project.environmentId)?.label
          }
        />
      ))}
    </SettingsSection>
  );
}
