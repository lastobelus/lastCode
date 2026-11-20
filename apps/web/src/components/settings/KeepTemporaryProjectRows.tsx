import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { isTemporaryProject } from "@t3tools/client-runtime/state/temporary-projects";
import { useGT } from "gt-react";
import { useState } from "react";
import { useProjectGroupUpdate } from "../../hooks/useProjectGroupUpdate";
import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import { useEnvironmentScope } from "../../state/session";
import { Button } from "../ui/button";
import { SettingsRow } from "./settingsLayout";

function KeepTemporaryProjectRow({ member }: { readonly member: SidebarProjectGroupMember }) {
  const gt = useGT();
  const canEdit = useEnvironmentScope(member.environmentId, AuthOrchestrationOperateScope);
  const { updateProjectGroup } = useProjectGroupUpdate();
  const [keeping, setKeeping] = useState(false);
  const keep = () => {
    setKeeping(true);
    void updateProjectGroup(
      [member],
      { keepTemporary: true },
      gt("Could not keep project"),
    ).finally(() => setKeeping(false));
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
