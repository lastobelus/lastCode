import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { isTemporaryProject } from "@t3tools/client-runtime/state/temporary-projects";
import { useGT } from "gt-react";
import { useState } from "react";
import { reportProjectFailure } from "../../hooks/useProjectGroupUpdate";
import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentScope } from "../../state/session";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { Button } from "../ui/button";
import { SettingsRow } from "./settingsLayout";

function KeepTemporaryProjectRow({ member }: { readonly member: SidebarProjectGroupMember }) {
  const gt = useGT();
  const canEdit = useEnvironmentScope(member.environmentId, AuthOrchestrationOperateScope);
  const updateProject = useOrchestrationCommand(projectEnvironment.update, {
    reportFailure: false,
  });
  const [keeping, setKeeping] = useState(false);
  const keep = () => {
    setKeeping(true);
    void updateProject({
      environmentId: member.environmentId,
      input: { projectId: member.id, keepTemporary: true },
    })
      .then((result) => reportProjectFailure(gt("Could not keep project"), result))
      .finally(() => setKeeping(false));
  };
  return (
    <SettingsRow
      title={gt("Temporary project")}
      description={[member.environmentLabel, member.workspaceRoot].filter(Boolean).join(" · ")}
      control={
        <Button size="sm" variant="outline" disabled={!canEdit || keeping} onClick={keep}>
          {gt("Keep project")}
        </Button>
      }
    />
  );
}

export function KeepTemporaryProjectRows({
  members,
}: {
  readonly members: readonly SidebarProjectGroupMember[];
}) {
  return members
    .filter(isTemporaryProject)
    .map((member) => <KeepTemporaryProjectRow key={member.physicalProjectKey} member={member} />);
}
