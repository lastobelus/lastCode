import { childActionResumeContext } from "@t3tools/client-runtime/state/action-resume";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { actionResumeStatus, actionWaitPresentation } from "@t3tools/shared/actionResume";

import { useActionEnvironmentPause } from "../../state/actionResume";
import { useThreadShell } from "../../state/entities";

export function ChildActionWait({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const shell = useThreadShell(threadRef);
  const context = shell ? childActionResumeContext(shell.source) : null;
  const { paused } = useActionEnvironmentPause(threadRef.environmentId);
  if (context === null) return null;
  const status =
    paused === null ? null : actionResumeStatus({ ...context, environmentPaused: paused });
  const presentation = actionWaitPresentation(context.action, status);
  if (presentation === null) return null;
  return (
    <span role="status" className="block truncate text-xs font-medium text-foreground">
      {context.action.actionName} · {presentation.label}
    </span>
  );
}
