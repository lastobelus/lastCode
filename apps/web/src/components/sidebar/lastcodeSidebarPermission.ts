import { AuthOrchestrationOperateScope, type EnvironmentId } from "@t3tools/contracts";
import { readEnvironmentScope } from "../../state/session";
import { ORCHESTRATION_OPERATE_DENIED_MESSAGE } from "../../state/use-orchestration-command";
import { stackedThreadToast, toastManager } from "../ui/toast";
export function checkTaskPermission(environmentId: EnvironmentId): boolean {
  if (readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return true;
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: "Action unavailable",
      description: ORCHESTRATION_OPERATE_DENIED_MESSAGE,
    }),
  );
  return false;
}
