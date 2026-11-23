import { useGT, useMessages } from "gt-react";
import { useThreadShell } from "../../state/entities";
import type { ThreadStatusPill } from "../Sidebar.logic";
import {
  lastcodeSidebarCreatorDetails,
  lastcodeSidebarCreatorRef,
  lastcodeSidebarIsAgentCreated,
  lastcodeSidebarSubagentStatusLabel,
  type LastCodeSidebarFamilyRow,
} from "../lastcodeSidebarFamilies.logic";

export function useLastCodeThreadFamily(
  family: LastCodeSidebarFamilyRow,
  status: ThreadStatusPill | null,
) {
  const gt = useGT();
  const messages = useMessages();
  const thread = family.thread;
  const creatorRef = lastcodeSidebarCreatorRef(thread);
  const isAgentCreated = lastcodeSidebarIsAgentCreated(thread);
  const creator = useThreadShell(creatorRef);
  const creatorDetails = lastcodeSidebarCreatorDetails(thread, creator, messages);
  const creatorDescription = creatorDetails.description;
  const isSubagent =
    thread.lineage.relationshipToParent === "subagent" && thread.lineage.independent !== true;
  const statusLabel = isSubagent
    ? messages(lastcodeSidebarSubagentStatusLabel(thread, status))
    : "";
  const subagentLabel = isSubagent
    ? family.unavailableParentLabel
      ? gt("Subagent · {status} · {unavailableParent}", {
          status: statusLabel,
          unavailableParent: family.unavailableParentLabel,
        })
      : gt("Subagent · {status}", { status: statusLabel })
    : null;
  const relationshipDescription = creatorDescription ?? subagentLabel;
  const relationshipLabel = subagentLabel ?? (isAgentCreated ? gt("Agent-created") : null);
  const relationshipUnavailableLabel =
    family.unavailableParentLabel ??
    family.creatorGroupingWarning ??
    creatorDetails.unavailableLabel;
  return {
    isAgentCreated,
    creatorDescription,
    subagentLabel,
    relationshipDescription,
    relationshipLabel,
    relationshipUnavailableLabel,
  };
}
export type LastCodeThreadFamilyPresentation = ReturnType<typeof useLastCodeThreadFamily>;
