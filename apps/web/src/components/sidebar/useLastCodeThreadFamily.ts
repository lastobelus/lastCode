import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useThreadShell } from "../../state/entities";
import type { ThreadStatusPill } from "../Sidebar.logic";
import {
  lastcodeSidebarCreatorDetails,
  lastcodeSidebarIsAgentCreated,
  lastcodeSidebarSubagentStatusLabel,
  type LastCodeSidebarFamilyRow,
} from "../lastcodeSidebarFamilies.logic";

export function useLastCodeThreadFamily(
  family: LastCodeSidebarFamilyRow,
  status: ThreadStatusPill | null,
) {
  const thread = family.thread;
  const isAgentCreated = lastcodeSidebarIsAgentCreated(thread);
  const creatorRef =
    isAgentCreated && thread.creatorThreadId
      ? scopeThreadRef(thread.environmentId, thread.creatorThreadId)
      : null;
  const creator = useThreadShell(creatorRef);
  const creatorDetails = lastcodeSidebarCreatorDetails(thread, creator);
  const creatorDescription = creatorDetails.description;
  const subagentLabel =
    thread.lineage.relationshipToParent === "subagent" && thread.lineage.independent !== true
      ? `Subagent · ${lastcodeSidebarSubagentStatusLabel(thread, status)}${family.unavailableParentLabel ? ` · ${family.unavailableParentLabel}` : ""}`
      : null;
  const relationshipDescription = creatorDescription
    ? `Agent-created · ${creatorDescription}`
    : subagentLabel;
  const relationshipLabel = subagentLabel ?? (isAgentCreated ? "Agent-created" : null);
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
